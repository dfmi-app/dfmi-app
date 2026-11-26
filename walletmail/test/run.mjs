import { spawn } from 'node:child_process'; import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const { ethers } = require('ethers');
const SERVER = process.argv[2] || './server.js'; const PORT = 43101; const BASE = `http://127.0.0.1:${PORT}`; const STORE = './s3store.json';
rmSync(STORE, { force: true });
let proc; const env = (x = {}) => ({ ...process.env, PORT: String(PORT), S3_STUB_FILE: STORE, AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x', ...x });
async function start(x) { proc = spawn(process.execPath, ['-r', './s3stub.cjs', SERVER], { env: env(x), stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error('no start'); }
async function stop() { proc.kill(); await new Promise((r) => proc.on('exit', r)); }
const post = (p, b, t) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(b || {}) });
const sess = async (t) => (await fetch(BASE + '/api/session', { headers: { authorization: 'Bearer ' + t } })).status;
const W = ethers.Wallet.createRandom(), W2 = ethers.Wallet.createRandom();
async function login(w) { const c = await (await post('/api/auth/challenge', { wallet: w.address })).json();
  const v = await (await post('/api/auth/verify', { challengeId: c.challengeId, signature: await w.signMessage(c.message) })).json(); return v.token; }
let fail = 0; const ok = (m, c) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
try {
  await start();
  const a = await login(W); ok('sign-in issues a working session', await sess(a) === 200);
  const lo = await post('/api/auth/logout', {}, a); ok('logout endpoint exists', lo.status === 200);
  ok('after logout the token is rejected', await sess(a) === 401);
  const b1 = await login(W), b2 = await login(W), other = await login(W2);
  const la = await post('/api/auth/logout-all', {}, b1); ok('logout-all endpoint exists', la.status === 200);
  ok('logout-all: calling session rejected', await sess(b1) === 401);
  ok('logout-all: the other session of the same address rejected', await sess(b2) === 401);
  ok('logout-all: another address unaffected', await sess(other) === 200);
  await new Promise((r) => setTimeout(r, 5));
  const c1 = await login(W); ok('sign-in after logout-all works', await sess(c1) === 200);
  // legacy session (no issuedAt) created before the revocation, planted in S3
  const st = JSON.parse(readFileSync(STORE, 'utf8')); const legacyTok = 'legacy-tok';
  st[`sessions/${legacyTok}.json`] = JSON.stringify({ address: W.address.toLowerCase(), expiresAt: Date.now() - 3600_000 + 12 * 3600_000 });
  writeFileSync(STORE, JSON.stringify(st));
  const ctrl = 'legacy-ok'; st[`sessions/${ctrl}.json`] = JSON.stringify({ address: W2.address.toLowerCase(), expiresAt: Date.now() - 3600_000 + 12 * 3600_000 }); writeFileSync(STORE, JSON.stringify(st));
  await stop(); await start();
  ok('after restart: legacy session of a non-revoked address still works (control)', await sess(ctrl) === 200);
  ok('after restart: revoked session still rejected', await sess(b2) === 401);
  ok('after restart: revoked legacy session (no issuedAt) rejected', await sess(legacyTok) === 401);
  ok('after restart: post-revocation session still works', await sess(c1) === 200);
  ok('after restart: other address still works', await sess(other) === 200);
  await stop(); await start({ S3_STUB_FAIL: '1' });
  ok('S3 outage on first check fails closed (not 200)', await sess(c1) !== 200);
  await stop();
} catch (e) { console.log('ERROR', e.message); fail++; try { await stop(); } catch {} }
console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
