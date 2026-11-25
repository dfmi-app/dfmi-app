#!/usr/bin/env node
// verify-auth.mjs — black-box check of dfmi's server-side sign-in, run by anyone against the public mail API.
// It needs no account and no secret: it makes a throwaway wallet and a software passkey authenticator, then checks
// what the server accepts and refuses. Nothing is paid and no email is sent. At the end it removes the test passkey
// and signs the throwaway address out everywhere.
//
//   npm install && node verify-auth.mjs                 # about 2.5 minutes (includes the 2-minute expiry wait)
//   node verify-auth.mjs --skip-expiry                  # skip the expiry wait
//   node verify-auth.mjs --api https://exchange.dfmi.me --origin https://identity.dfmi.app
//
// Exit code 0 = every check passed.
import crypto from 'node:crypto';
import { Wallet } from 'ethers';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const API = arg('--api', 'https://exchange.dfmi.me').replace(/\/$/, '');
const ORIGIN = arg('--origin', 'https://identity.dfmi.app');           // the page passkeys belong to (its RP ID is its host)
const SKIP_EXPIRY = process.argv.includes('--skip-expiry');
const EXPIRY_WAIT_MS = Number(arg('--expiry-wait-ms', 125_000));       // the server's challenge lifetime is 2 minutes

let pass = 0, fail = 0;
function check(name, ok, detail = '') { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); }
async function call(method, path, body, { token, origin = ORIGIN } = {}) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const challenge = (w) => call('POST', '/api/auth/challenge', { wallet: w.address });
const verify = (challengeId, signature) => call('POST', '/api/auth/verify', { challengeId, signature });
async function signIn(w) { const c = (await challenge(w)).j; return (await verify(c.challengeId, await w.signMessage(c.message))).j.token; }
const sessionStatus = async (token) => (await call('GET', '/api/session', undefined, { token })).status;

// ---- a software passkey authenticator (P-256, "none" attestation), producing standard WebAuthn responses ----
function cbor(v) {   // minimal CBOR: unsigned/negative ints, byte strings, text strings, maps
  const head = (major, n) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported value');
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');
function authenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const credId = crypto.randomBytes(32);
  const a = { id: b64u(credId), counter: 0 };
  const authData = (rpId, flags, attested) => {
    const ctr = Buffer.alloc(4); ctr.writeUInt32BE(a.counter);
    const parts = [sha256(rpId), Buffer.from([flags]), ctr];
    if (attested) { const len = Buffer.alloc(2); len.writeUInt16BE(credId.length); parts.push(Buffer.alloc(16), len, credId, cose); }
    return Buffer.concat(parts);
  };
  a.create = (o, origin = ORIGIN) => ({ id: a.id, rawId: a.id, type: 'public-key', clientExtensionResults: {}, response: {
    clientDataJSON: b64u(JSON.stringify({ type: 'webauthn.create', challenge: o.challenge, origin })),
    attestationObject: b64u(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(o.rp.id, 0x45, true)]]))) } });
  a.get = (o, { origin = ORIGIN, counter, signer = privateKey } = {}) => {
    a.counter = counter ?? a.counter + 1;
    const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: o.challenge, origin }));
    const ad = authData(o.rpId, 0x05, false);
    return { id: a.id, rawId: a.id, type: 'public-key', clientExtensionResults: {}, response: {
      clientDataJSON: b64u(cdj), authenticatorData: b64u(ad), signature: b64u(crypto.sign('sha256', Buffer.concat([ad, sha256(cdj)]), signer)) } };
  };
  return a;
}

console.log(`dfmi sign-in verification · API ${API} · passkey origin ${ORIGIN}\n`);
const W = Wallet.createRandom(), other = Wallet.createRandom();
console.log(`throwaway wallet ${W.address}\n\n-- wallet signature sign-in --`);

// 1. a challenge is issued by the server and accepted once
const c1 = await challenge(W);
check('the server issues a challenge naming this address', c1.status === 200 && c1.j.challengeId && String(c1.j.message).toLowerCase().includes(W.address.toLowerCase()));
const sig1 = await W.signMessage(c1.j.message);
const v1 = await verify(c1.j.challengeId, sig1);
check('a correct signature gets a session', v1.status === 200 && !!v1.j.token, `HTTP ${v1.status}`);
check('the session works', await sessionStatus(v1.j.token) === 200);
const again = await verify(c1.j.challengeId, sig1);
check('the same challenge and signature are refused the second time (single use)', again.status === 401, `HTTP ${again.status} ${again.j.error || ''}`);
const c2 = (await challenge(W)).j;
const wrong = await verify(c2.challengeId, await other.signMessage(c2.message));
check('a signature by another key is refused', wrong.status === 401, `HTTP ${wrong.status} ${wrong.j.error || ''}`);
const c3 = (await challenge(W)).j;
const edited = await verify(c3.challengeId, await W.signMessage(c3.message + '\nedited'));
check('a signature over an edited message is refused', edited.status === 401, `HTTP ${edited.status}`);
check('a made-up token is refused', await sessionStatus(crypto.randomUUID()) === 401);
if (SKIP_EXPIRY) console.log('SKIP  challenge expiry (--skip-expiry)');
else {
  const c4 = (await challenge(W)).j; const s4 = await W.signMessage(c4.message);
  console.log(`      waiting ${Math.round(EXPIRY_WAIT_MS / 1000)} s for the challenge to expire…`);
  await new Promise((r) => setTimeout(r, EXPIRY_WAIT_MS));
  const late = await verify(c4.challengeId, s4);
  check('a challenge signed correctly but used after 2 minutes is refused', late.status === 401, `HTTP ${late.status} ${late.j.error || ''}`);
}

console.log('\n-- sign out --');
const t1 = await signIn(W);
check('sign out answers OK', (await call('POST', '/api/auth/logout', {}, { token: t1 })).status === 200);
check('after sign out the token is refused', await sessionStatus(t1) === 401);
const ta = await signIn(W), tb = await signIn(W), to = await signIn(other);
check('sign out on all devices answers OK', (await call('POST', '/api/auth/logout-all', {}, { token: ta })).status === 200);
check('…the calling session is refused', await sessionStatus(ta) === 401);
check('…another session of the same address is refused', await sessionStatus(tb) === 401);
check('…a session of another address still works', await sessionStatus(to) === 200);
await new Promise((r) => setTimeout(r, 1100));
const tok = await signIn(W);
check('signing in again afterwards works', await sessionStatus(tok) === 200);

console.log('\n-- passkeys (verified by the server) --');
const A = authenticator();
check('adding a passkey without a session is refused', (await call('POST', '/api/auth/passkey/register/options', {})).status === 401);
check('a page that is not configured gets no passkey options', (await call('POST', '/api/auth/passkey/register/options', {}, { token: tok, origin: 'https://example.com' })).status === 400);
const ro = await call('POST', '/api/auth/passkey/register/options', {}, { token: tok });
const rv = ro.status === 200 ? await call('POST', '/api/auth/passkey/register/verify', { challengeId: ro.j.challengeId, response: A.create(ro.j.options) }, { token: tok }) : ro;
check('the wallet session registers a passkey; the server verifies it', rv.status === 200, `HTTP ${rv.status} ${rv.j.error || ''} · RP ID ${ro.j.options?.rp?.id}`);
async function passkeySignIn(body = {}, opts = {}) {
  const o = await call('POST', '/api/auth/passkey/login/options', body);
  if (o.status !== 200) return { status: o.status, j: o.j };
  const response = A.get(o.j.options, opts);
  const v = await call('POST', '/api/auth/passkey/login/verify', { challengeId: o.j.challengeId, response });
  return { ...v, challengeId: o.j.challengeId, response };
}
const L = await passkeySignIn({ address: W.address });
check('passkey sign-in gets a session for the right address', L.status === 200 && L.j.address === W.address.toLowerCase(), `HTTP ${L.status}`);
check('the passkey session works', await sessionStatus(L.j.token) === 200);
const replay = await call('POST', '/api/auth/passkey/login/verify', { challengeId: L.challengeId, response: L.response });
check('replaying that passkey response is refused', replay.status === 401, `HTTP ${replay.status}`);
const forged = await passkeySignIn({}, { signer: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey });
check('a passkey response signed by another key is refused', forged.status === 401, `HTTP ${forged.status}`);
const elsewhere = await passkeySignIn({}, { origin: 'https://example.com' });
check('a passkey response made on another site is refused', elsewhere.status === 401, `HTTP ${elsewhere.status}`);
const cloned = await passkeySignIn({}, { counter: 1 });
check('a passkey whose signature counter goes backwards (a cloned authenticator) is refused', cloned.status === 401, `HTTP ${cloned.status}`);
A.counter = 1000;
const L2 = await passkeySignIn({});
check('a passkey session cannot remove passkeys', L2.status === 200 && (await call('DELETE', `/api/auth/passkeys/${A.id}`, undefined, { token: L2.j.token })).status === 403);

console.log('\n-- clean up --');
check('the wallet session removes the test passkey', (await call('DELETE', `/api/auth/passkeys/${A.id}`, undefined, { token: tok })).status === 200);
check('the removed passkey no longer signs in', (await passkeySignIn({})).status === 401);
await call('POST', '/api/auth/logout-all', {}, { token: tok });
await call('POST', '/api/auth/logout-all', {}, { token: to });
check('all sessions of the throwaway addresses are ended', await sessionStatus(L.j.token) === 401 && await sessionStatus(to) === 401);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
