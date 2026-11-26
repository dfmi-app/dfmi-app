// Session revocation across a restore (2026-11-25). Sessions, "sign out on all devices" markers and passkeys live only
// in the object store (S3), never on the server's disk. Two kinds of restore:
//   A  the server itself is rebuilt (new process, new disk, same object store): revocations must hold;
//   B  the object store is rolled back to a backup taken before some sign-outs: the signed-out sessions come back with
//      it. The restore procedure sets SESSIONS_NOT_BEFORE to the restore time; then every older session is refused.
//   node restore.mjs ./server.js
import { spawn } from 'node:child_process'; import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const { ethers } = require('ethers');
const SERVER = process.argv[2] || './server.js'; const PORT = 43105; const BASE = `http://127.0.0.1:${PORT}`; const STORE = './s3store-restore.json';
rmSync(STORE, { force: true });
let proc; const env = (x = {}) => ({ ...process.env, PORT: String(PORT), S3_STUB_FILE: STORE, AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x', ...x });
async function start(x) { proc = spawn(process.execPath, ['-r', './s3stub.cjs', SERVER], { env: env(x), stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error('no start'); }
async function stop() { proc.kill(); await new Promise((r) => proc.on('exit', r)); }
const post = (p, b, t) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(b || {}) });
const sess = async (t) => (await fetch(BASE + '/api/session', { headers: { authorization: 'Bearer ' + t } })).status;
const W = ethers.Wallet.createRandom(), V = ethers.Wallet.createRandom();
async function login(w) { const c = await (await post('/api/auth/challenge', { wallet: w.address })).json();
  const v = await (await post('/api/auth/verify', { challengeId: c.challengeId, signature: await w.signMessage(c.message) })).json(); return v.token; }
let fail = 0; const ok = (m, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c ? '' : '  ' + x)); if (!c) fail++; };
try {
  await start();
  const a = await login(W), b = await login(W), c = await login(V);
  const backup = readFileSync(STORE, 'utf8');                      // the object store as a backup would have it
  await post('/api/auth/logout', {}, a);                           // after the backup: a is signed out,
  await post('/api/auth/logout-all', {}, c);                       // and V signs out on all devices
  ok('before any restore: the signed-out session and the revoked address are refused, the other session works', await sess(a) === 401 && await sess(c) === 401 && await sess(b) === 200);

  // A: the server is rebuilt from scratch; the object store is the same
  await stop(); await start();
  ok('A (server rebuilt, same store): the signed-out session stays refused', await sess(a) === 401);
  ok('A: "sign out on all devices" still holds', await sess(c) === 401);
  ok('A: the session that was never signed out still works', await sess(b) === 200);

  // B: the object store is rolled back to the backup
  await stop(); writeFileSync(STORE, backup); await start();
  const resurrected = (await sess(a)) === 200 || (await sess(c)) === 200;
  ok('B without the restore step: a rollback brings signed-out sessions back (this is why the step exists)', resurrected);
  await stop(); writeFileSync(STORE, backup);
  const restoredAt = new Date().toISOString();
  await start({ SESSIONS_NOT_BEFORE: restoredAt });
  ok('B with SESSIONS_NOT_BEFORE = restore time: the signed-out session is refused', await sess(a) === 401);
  ok('B: the address that signed out everywhere is refused', await sess(c) === 401);
  ok('B: every session from before the restore is refused (users sign in again)', await sess(b) === 401);
  const fresh = await login(W);
  ok('B: signing in after the restore works', await sess(fresh) === 200);
  await stop(); await start({ SESSIONS_NOT_BEFORE: restoredAt });
  ok('B: and it keeps working across restarts, while the old ones stay refused', await sess(fresh) === 200 && await sess(a) === 401 && await sess(b) === 401);
  await stop(); await start({ SESSIONS_NOT_BEFORE: 'not-a-time' }).then(() => ok('a malformed SESSIONS_NOT_BEFORE stops the server', false), () => ok('a malformed SESSIONS_NOT_BEFORE stops the server (fails closed)', true));
} catch (e) { console.log('ERROR', e.stack); fail++; }
try { proc.kill(); } catch {}
rmSync(STORE, { force: true });
console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
