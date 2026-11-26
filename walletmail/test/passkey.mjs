// Passkeys on the mail API are verified by the server (2026-11-25). A software authenticator (P-256, "none"
// attestation) produces real WebAuthn responses; the server must accept only correct ones and issue a session.
//   node passkey.mjs ./server.js      (server.js next to its node_modules; S3 replaced by s3stub.cjs)
import { spawn } from 'node:child_process'; import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module'; import crypto from 'node:crypto';
const require = createRequire(import.meta.url); const { ethers } = require('ethers'); const { isoCBOR } = require('@simplewebauthn/server/helpers');
const SERVER = process.argv[2] || './server.js'; const PORT = 43103; const BASE = `http://127.0.0.1:${PORT}`; const STORE = './s3store-pk.json';
const RP = 'identity.dfmi.app', ORIGIN = 'https://identity.dfmi.app';
rmSync(STORE, { force: true });
let proc; let logs = '';
async function start() {
  proc = spawn(process.execPath, ['-r', './s3stub.cjs', SERVER], { env: { ...process.env, PORT: String(PORT), S3_STUB_FILE: STORE, AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x', DFMI_RPC: 'http://127.0.0.1:9' }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => (logs += d)); proc.stderr.on('data', (d) => (logs += d));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error('no start\n' + logs);
}
async function stop() { proc.kill(); await new Promise((r) => proc.on('exit', r)); }
const call = async (method, path, body, { token, origin = ORIGIN } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', origin, ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
async function walletLogin(w) {
  const c = (await call('POST', '/api/auth/challenge', { wallet: w.address })).j;
  return (await call('POST', '/api/auth/verify', { challengeId: c.challengeId, signature: await w.signMessage(c.message) })).j.token;
}

// ---- software authenticator ----
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (b) => crypto.createHash('sha256').update(b).digest();
function authenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const credId = crypto.randomBytes(32);
  const a = { counter: 0, id: b64u(credId) };
  const authData = (rpId, flags, withCred) => {
    const ctr = Buffer.alloc(4); ctr.writeUInt32BE(a.counter);
    const parts = [sha(rpId), Buffer.from([flags]), ctr];
    if (withCred) { const len = Buffer.alloc(2); len.writeUInt16BE(credId.length); parts.push(Buffer.alloc(16), len, credId, Buffer.from(cose)); }
    return Buffer.concat(parts);
  };
  a.create = (options, { origin = ORIGIN, rpId = options.rp.id } = {}) => {
    const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }));
    const att = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(rpId, 0x45, true)]]));
    return { id: a.id, rawId: a.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(cdj), attestationObject: b64u(att), transports: ['internal'] } };
  };
  a.get = (options, { origin = ORIGIN, rpId = options.rpId, counter, tamper = false } = {}) => {
    a.counter = counter ?? a.counter + 1;
    const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
    const ad = authData(rpId, 0x05, false);
    let sig = crypto.sign('sha256', Buffer.concat([ad, sha(cdj)]), privateKey);
    if (tamper) sig = Buffer.from(sig.map((x, i) => (i === sig.length - 1 ? x ^ 1 : x)));
    return { id: a.id, rawId: a.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(cdj), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: b64u(Buffer.from('x')) } };
  };
  return a;
}

let fail = 0; const ok = (m, c, extra = '') => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c ? '' : '  ' + extra)); if (!c) fail++; };
const W = ethers.Wallet.createRandom(), W2 = ethers.Wallet.createRandom();
const A = authenticator();
async function register(token, auth = A, o = {}) {
  const opt = await call('POST', '/api/auth/passkey/register/options', {}, { token });
  if (opt.status !== 200) return opt;
  return call('POST', '/api/auth/passkey/register/verify', { challengeId: opt.j.challengeId, response: auth.create(opt.j.options, o) }, { token });
}
async function login(body = {}, auth = A, o = {}) {
  const opt = await call('POST', '/api/auth/passkey/login/options', body);
  if (opt.status !== 200) return { opt, v: opt };
  const response = auth.get(opt.j.options, o);
  const v = await call('POST', '/api/auth/passkey/login/verify', { challengeId: opt.j.challengeId, response });
  return { opt, v, response, challengeId: opt.j.challengeId };
}
try {
  await start();
  const tok = await walletLogin(W);
  ok('registering a passkey needs a signed-in session', (await call('POST', '/api/auth/passkey/register/options', {})).status === 401);
  ok('an origin that is not configured gets no passkey options', (await call('POST', '/api/auth/passkey/register/options', {}, { token: tok, origin: 'https://evil.example' })).status === 400);
  const r1 = await register(tok); ok('wallet session registers a passkey (server-verified attestation)', r1.status === 200 && r1.j.ok, JSON.stringify(r1));
  const lst = await call('GET', '/api/auth/passkeys', undefined, { token: tok }); ok('the address lists its passkey', lst.j.passkeys?.length === 1 && lst.j.passkeys[0].id === A.id);
  ok('the same passkey cannot be registered twice', (await register(tok)).status !== 200);
  const B = authenticator(); ok('registration answered for another origin is rejected', (await register(tok, B, { origin: 'https://evil.example' })).status === 401);

  const L = await login({ address: W.address });
  ok('passkey sign-in with the address issues a session', L.v.status === 200 && L.v.j.address === W.address.toLowerCase() && L.v.j.method === 'passkey', JSON.stringify(L.v));
  ok('that session works', (await call('GET', '/api/session', undefined, { token: L.v.j.token })).status === 200);
  const D = await login({}); ok('discoverable sign-in (no address given) works', D.v.status === 200 && D.v.j.address === W.address.toLowerCase());
  ok('replaying a verified response is refused (challenge single use)', (await call('POST', '/api/auth/passkey/login/verify', { challengeId: L.challengeId, response: L.response })).status === 401);
  ok('a response for another challenge is refused', (await (async () => { const o = await call('POST', '/api/auth/passkey/login/options', {}); return call('POST', '/api/auth/passkey/login/verify', { challengeId: o.j.challengeId, response: L.response }); })()).status === 401);
  ok('a tampered signature is refused', (await login({}, A, { tamper: true })).v.status === 401);
  ok('an assertion made for another origin is refused', (await login({}, A, { origin: 'https://evil.example' })).v.status === 401);
  ok('an assertion for another RP ID is refused', (await login({}, A, { rpId: 'evil.example' })).v.status === 401);
  ok('a signature counter that goes backwards (cloned authenticator) is refused', (await login({}, A, { counter: 1 })).v.status === 401);
  A.counter = 100;   // the real authenticator carries on from its own, higher counter
  ok('an unregistered passkey is refused', (await login({}, authenticator())).v.status === 401);
  ok('asking for an address with no passkey is a clear 404', (await call('POST', '/api/auth/passkey/login/options', { address: W2.address })).status === 404);
  const pkTok = (await login({})).v.j.token;
  ok('a passkey session cannot add passkeys', (await register(pkTok, authenticator())).status === 403);
  ok('a passkey session cannot remove passkeys', (await call('DELETE', '/api/auth/passkeys/' + A.id, undefined, { token: pkTok })).status === 403);
  const tok2 = await walletLogin(W2);
  ok('another address cannot remove it', (await call('DELETE', '/api/auth/passkeys/' + A.id, undefined, { token: tok2 })).status === 404);

  await stop(); await start();
  const R = await login({ address: W.address }); ok('after a restart the passkey still signs in (stored server-side)', R.v.status === 200);
  ok('sign out on all devices also ends passkey sessions', (await call('POST', '/api/auth/logout-all', {}, { token: await walletLogin(W) })).status === 200 && (await call('GET', '/api/session', undefined, { token: R.v.j.token })).status === 401);
  const tok3 = await walletLogin(W);
  ok('the owner removes the passkey', (await call('DELETE', '/api/auth/passkeys/' + A.id, undefined, { token: tok3 })).status === 200);
  ok('a removed passkey no longer signs in', (await login({})).v.status === 401);
  ok('wallet sign-in still works as before', !!(await walletLogin(W2)));
  await stop();
} catch (e) { console.log('ERROR', e.stack); fail++; try { await stop(); } catch {} }
console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
