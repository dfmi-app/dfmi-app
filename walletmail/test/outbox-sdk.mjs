// Real SDK retry regression: fake HTTP transport, local S3, disposable wallets.
// node outbox-sdk.mjs ../server.js
import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net'; import { spawn } from 'node:child_process'; import { once } from 'node:events';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const { ethers } = createRequire(import.meta.url)('ethers');
const SERVER = path.resolve(process.argv[2] || '../server.js');
const dir = fs.mkdtempSync(path.join(HERE, 'outbox-')); const store = path.join(dir, 'objects.json'), control = path.join(dir, 'fault.json'), sesLog = path.join(dir, 'ses.jsonl');
fs.copyFileSync(SERVER, path.join(dir, 'server.js')); fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
fs.writeFileSync(store, '{}'); fs.writeFileSync(control, '{}'); fs.writeFileSync(sesLog, '');
let fail = 0; const ok = (m, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c ? '' : '  ' + x)); if (!c) fail++; };
const fault = (f = {}) => fs.writeFileSync(control, JSON.stringify(f));
const sesCount = (tag) => fs.readFileSync(sesLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((x) => !tag || x.tag === tag).length;
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const BASE = `http://127.0.0.1:${port}`; let proc;
async function start() { proc = spawn(process.execPath, ['-r', path.join(HERE, 'ses-transport.cjs'), path.join(dir, 'server.js')], { cwd: dir, env: { ...process.env, PORT: String(port), DRILL_STORE: store, DRILL_CONTROL: control, DRILL_AUDIT: sesLog,
  AWS_MAX_ATTEMPTS: '5', AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x', S3_INCOMING_BUCKET: 'outbox-test', EMAIL_DOMAIN: 'example.invalid', DFMI_RPC: 'http://127.0.0.1:9', ENS_REGISTRY: '', ENS_RESOLVER: '', ENS_BOOTSTRAP_NAMES: '' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 50)); } throw Error('no start'); }
async function stop() { if (!proc || proc.exitCode !== null || proc.signalCode) return; const d = once(proc, 'exit'); proc.kill(); await d; }
const call = async (m, u, t, b) => { const r = await fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
async function login(w) { const c = await call('POST', '/api/auth/challenge', null, { wallet: w.address }); return (await call('POST', '/api/auth/verify', null, { challengeId: c.j.challengeId, signature: await w.signMessage(c.j.message) })).j.token; }
const send = (t, id, extra = {}) => call('POST', '/api/messages/send-external', t, { messageId: id, recipientEmail: 'someone@example.org', subject: 'hello ' + id, body: 'body ' + id, ...extra });
const outbox = (t, id) => call('GET', '/api/messages/outbox/' + id, t);
const attempts = tag => fs.readFileSync(sesLog + '.transport', 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x => x.tag === tag).length;
try {
  await start(); const t = await login(ethers.Wallet.createRandom());
  let r = await send(t, 'sdk-normal');
  ok('real SDK: normal send succeeds with exactly one transport call', r.status === 200 && attempts('sdk-normal') === 1 && sesCount('sdk-normal') === 1);
  fault({ses: 'lost-response'}); r = await send(t, 'sdk-lost'); fault();
  ok('real SDK: response loss returns an ambiguous error', r.status === 502 && r.j.deliveryMayHaveOccurred === true);
  ok('real SDK: response loss is never retried inside SDK, even with AWS_MAX_ATTEMPTS=5', attempts('sdk-lost') === 1 && sesCount('sdk-lost') === 1, String(attempts('sdk-lost')));
  r = await send(t, 'sdk-lost');
  ok('real SDK: client retry stays pending without another transport call', r.status === 409 && (await outbox(t, 'sdk-lost')).j.state === 'pending' && attempts('sdk-lost') === 1);
  fault({ses: 'error-not-sent'}); r = await send(t, 'sdk-500'); fault();
  ok('real SDK: 5xx is ambiguous and has exactly one transport attempt', r.status === 502 && r.j.deliveryMayHaveOccurred === true && attempts('sdk-500') === 1 && sesCount('sdk-500') === 0);
  r = await send(t, 'sdk-500');
  ok('real SDK: retry after 5xx does not submit again', r.status === 409 && attempts('sdk-500') === 1);
  await stop(); await start();
  r = await send(t, 'sdk-lost');
  ok('real SDK: restart does not resend the pending accepted message', r.status === 409 && attempts('sdk-lost') === 1);
  r = await send(t, 'sdk-normal');
  ok('real SDK: restart replays a successful result without another submission', r.status === 200 && r.j.duplicate && attempts('sdk-normal') === 1);
} catch (e) { console.log('ERROR', e.stack); fail++; }
finally { try { await stop(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
