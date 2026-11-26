// identity.dfmi.app passkeys end to end (2026-11-25): the real page (jsdom) + the real mail server (S3 stubbed) + a
// software authenticator behind navigator.credentials. Key sign-in → server session → register a passkey (server
// verifies) → sign out → sign in with the passkey (server verifies, issues the session). Then a forged assertion.
//   curl -so identity.html https://identity.dfmi.app/ && curl -so keylogin.js https://identity.dfmi.app/keylogin.js
//   node identity-e2e.mjs ../server.js identity.html keylogin.js
import { spawn } from 'node:child_process'; import { rmSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module'; import crypto from 'node:crypto'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, '..');
const req = createRequire(join(REPO, 'package.json')); const { JSDOM } = req('jsdom'); const { Wallet } = req('ethers');
const local = createRequire(join(process.cwd(), 'package.json')); const { isoCBOR } = local('@simplewebauthn/server/helpers');
const SERVER = process.argv[2] || '../server.js', PAGE = process.argv[3] || join(HERE, 'identity.html'), KEYLOGIN_FILE = process.argv[4] || join(HERE, 'keylogin.js');
const PORT = 43104, BASE = `http://127.0.0.1:${PORT}`, ORIGIN = 'https://identity.dfmi.app', STORE = './s3store-id.json';
const ETHERS = readFileSync(join(REPO, 'node_modules/ethers/dist/ethers.umd.min.js'), 'utf8');
const KEYLOGIN = readFileSync(KEYLOGIN_FILE, 'utf8').replace(/<\/script/gi, '<\\/script');
rmSync(STORE, { force: true });
const srv = spawn(process.execPath, ['-r', './s3stub.cjs', SERVER], { env: { ...process.env, PORT: String(PORT), S3_STUB_FILE: STORE, AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x', DFMI_RPC: 'http://127.0.0.1:9' }, stdio: 'ignore' });
for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

// software authenticator, exposing the browser's PublicKeyCredential shape
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const ab = (b) => { const u = new Uint8Array(b); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); };
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' }); const credId = crypto.randomBytes(32); let counter = 0; let forge = false;
const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
const ad = (rpId, flags, withCred) => { const c = Buffer.alloc(4); c.writeUInt32BE(counter); const p = [sha(rpId), Buffer.from([flags]), c]; if (withCred) { const l = Buffer.alloc(2); l.writeUInt16BE(credId.length); p.push(Buffer.alloc(16), l, credId, Buffer.from(cose)); } return Buffer.concat(p); };
const credentials = {
  async create({ publicKey: o }) {
    const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: Buffer.from(o.challenge).toString('base64url'), origin: ORIGIN }));
    const att = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad(o.rp.id, 0x45, true)]]));
    return { id: credId.toString('base64url'), rawId: ab(credId), type: 'public-key', getClientExtensionResults: () => ({}), response: { clientDataJSON: ab(cdj), attestationObject: ab(att), getTransports: () => ['internal'] } };
  },
  async get({ publicKey: o }) {
    counter++;
    const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(o.challenge).toString('base64url'), origin: ORIGIN }));
    const a = ad(o.rpId, 0x05, false); let sig = crypto.sign('sha256', Buffer.concat([a, sha(cdj)]), privateKey);
    if (forge) sig = crypto.sign('sha256', Buffer.concat([a, sha(cdj)]), crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);
    return { id: credId.toString('base64url'), rawId: ab(credId), type: 'public-key', getClientExtensionResults: () => ({}), response: { clientDataJSON: ab(cdj), authenticatorData: ab(a), signature: ab(sig), userHandle: null } };
  },
};

let html = readFileSync(PAGE, 'utf8')
  .replace(/<script src="https:\/\/cdnjs[^"]*ethers[^"]*"[^>]*><\/script>/, () => `<script>${ETHERS}</script>`)
  .replace(/<script src="\/keylogin\.js"><\/script>/, () => `<script>${KEYLOGIN}</script>`);
const dom = new JSDOM(html, { url: ORIGIN + '/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  Object.defineProperty(w, 'isSecureContext', { value: true });
  w.PublicKeyCredential = function () {}; Object.defineProperty(w.navigator, 'credentials', { value: credentials });
  if (!w.crypto.subtle) Object.defineProperty(w.crypto, 'subtle', { value: crypto.webcrypto.subtle });
  // the browser would send Origin: https://identity.dfmi.app on these cross-origin calls
  w.fetch = (u, o = {}) => (String(u).startsWith(BASE) ? fetch(u, { ...o, headers: { ...(o.headers || {}), origin: ORIGIN } }) : Promise.reject(new Error('offline')));
} });
const w = dom.window, $ = (id) => w.document.getElementById(id);
const wait = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };
let fail = 0; const ok = (m, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c ? '' : '  ' + x)); if (!c) fail++; };
try {
  await new Promise((r) => setTimeout(r, 300));
  $('apiBase').value = BASE;
  const W = Wallet.createRandom();
  w.__W = W;
  w.eval(`key = { kind:'keystore', address: __W.address, label:'test', sign: (m) => __W.signMessage(m) };
          auth = { address: __W.address, method: 'signature', message: 'x', signature: '0x' };`);
  await w.eval('passkeyRegister()');
  ok('register: the page got a server session and the server verified + stored the passkey', /server/.test($('m-pk').textContent) && $('m-pk').className.includes('good'), $('m-pk').textContent);
  const stored = Object.keys(JSON.parse(readFileSync(STORE, 'utf8'))).filter((k) => k.startsWith('passkeys'));
  ok('the passkey record and index are on the server', stored.length === 2, stored.join(','));
  ok('nothing about the passkey is kept in browser storage', !Object.keys(w.localStorage).some((k) => /passkey/i.test(k)));
  ok('the page lists the passkey from the server', await wait(() => $('pkList').style.display === 'grid'));
  const keyTok = w.eval('exch && exch.token');
  ok('the key sign-in got a server session', !!keyTok && (await fetch(BASE + '/api/session', { headers: { authorization: 'Bearer ' + keyTok } })).status === 200);
  w.eval('signOut()');
  ok('sign out ends that session on the server', await wait(async () => (await fetch(BASE + '/api/session', { headers: { authorization: 'Bearer ' + keyTok } })).status === 401));
  ok('sign out leaves no session token in localStorage', !Object.keys(w.localStorage).some((k) => k.startsWith('wm_session_')), Object.keys(w.localStorage).join(','));
  ok('sign out forgets the key (nothing in the page can sign)', w.eval('key === null && auth === null') && $('btnSign').disabled);
  await w.eval('passkeyLogin()');
  ok('passkey sign-in: verified by the server, session issued', $('m-pk').className.includes('good') && w.eval('auth && auth.method') === 'passkey' && w.eval('auth.address') === W.address, $('m-pk').textContent);
  const tok = w.eval('exch && exch.token');
  ok('the session token works on the server', tok && (await fetch(BASE + '/api/session', { headers: { authorization: 'Bearer ' + tok } })).status === 200);
  ok('the check list includes the server verdict', /server verified/.test($('pkChecks').textContent));
  w.eval('signOut()'); forge = true;
  await w.eval('passkeyLogin()');
  ok('a forged assertion (wrong key) is refused by the server; no session', $('m-pk').className.includes('err') && !w.eval('auth'), $('m-pk').textContent);
} catch (e) { console.log('ERROR', e.stack); fail++; }
srv.kill(); w.close();
console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
