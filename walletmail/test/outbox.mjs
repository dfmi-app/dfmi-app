// Outbound mail reliability (2026-11-26): outbox + idempotency for /api/messages/send-external.
//   node outbox.mjs ../server.js        (run from the test directory; S3 and SES are replaced by outbox-store.cjs)
// The SES stub counts every message it accepts, so "sent once" is measured at the mail service, not from the API answer.
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
async function start() { proc = spawn(process.execPath, ['-r', path.join(HERE, 'outbox-store.cjs'), path.join(dir, 'server.js')], { cwd: dir, env: { ...process.env, PORT: String(port), DRILL_STORE: store, DRILL_CONTROL: control, DRILL_AUDIT: sesLog,
  AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x', S3_INCOMING_BUCKET: 'outbox-test', EMAIL_DOMAIN: 'example.invalid', DFMI_RPC: 'http://127.0.0.1:9', ENS_REGISTRY: '', ENS_RESOLVER: '', ENS_BOOTSTRAP_NAMES: '' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 50)); } throw Error('no start'); }
async function stop() { if (!proc || proc.exitCode !== null || proc.signalCode) return; const d = once(proc, 'exit'); proc.kill(); await d; }
const call = async (m, u, t, b) => { const r = await fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
async function login(w) { const c = await call('POST', '/api/auth/challenge', null, { wallet: w.address }); return (await call('POST', '/api/auth/verify', null, { challengeId: c.j.challengeId, signature: await w.signMessage(c.j.message) })).j.token; }
const send = (t, id, extra = {}) => call('POST', '/api/messages/send-external', t, { messageId: id, recipientEmail: 'someone@example.org', subject: 'hello ' + id, body: 'body ' + id, ...extra });
const outbox = (t, id) => call('GET', '/api/messages/outbox/' + id, t);
try {
  await start(); const w = ethers.Wallet.createRandom(); let t = await login(w);

  let r = await send(t, 'm1');
  ok('a normal send succeeds and SES accepts it once', r.status === 200 && r.j.sent && sesCount('m1') === 1, JSON.stringify(r));
  ok('…the outbox records it as sent, with the SES message id', (await outbox(t, 'm1')).j.state === 'sent' && (await outbox(t, 'm1')).j.sesMessageId === r.j.sesMessageId);
  r = await send(t, 'm1');
  ok('a retry with the same messageId returns the original result and does not send again', r.status === 200 && r.j.duplicate && sesCount('m1') === 1);
  r = await send(t, 'm1', { body: 'something else' });
  ok('the same messageId with different content is refused and not sent', r.status === 409 && sesCount('m1') === 1);

  fault({ sesDelayMs: 300 });
  const rs = await Promise.all(Array.from({ length: 6 }, () => send(t, 'm2')));
  fault();
  ok('6 concurrent requests with one messageId reach SES exactly once', sesCount('m2') === 1, `${sesCount('m2')} sends; answers ${rs.map((x) => x.status)}`);
  ok('…exactly one of them reports a fresh send; the others are told it is in progress or get the original result', rs.filter((x) => x.status === 200 && !x.j.duplicate).length === 1 && rs.every((x) => x.status === 200 || x.status === 409));

  t = await login(ethers.Wallet.createRandom()); // the server allows 10 sends per wallet per minute
  fault({ ses: 'reject' }); r = await send(t, 'm3'); fault();
  ok('SES rejects it (4xx): the answer says not sent, the outbox says failed', r.status === 502 && r.j.deliveryMayHaveOccurred === false && (await outbox(t, 'm3')).j.state === 'failed' && sesCount('m3') === 0);
  r = await send(t, 'm3');
  ok('…a retry with the same messageId is allowed and sends it once', r.status === 200 && sesCount('m3') === 1 && (await outbox(t, 'm3')).j.state === 'sent');

  t = await login(ethers.Wallet.createRandom()); // the server allows 10 sends per wallet per minute
  fault({ ses: 'lost-response' }); r = await send(t, 'm4'); fault();
  ok('SES accepted it but the answer was lost: the client is told the outcome is unknown', r.status === 502 && r.j.deliveryMayHaveOccurred === true && sesCount('m4') === 1);
  r = await send(t, 'm4');
  ok('…a retry is NOT resent automatically (no duplicate mail); the state is reported', r.status === 409 && r.j.deliveryMayHaveOccurred === true && sesCount('m4') === 1 && (await outbox(t, 'm4')).j.state === 'pending');

  t = await login(ethers.Wallet.createRandom()); // the server allows 10 sends per wallet per minute
  fault({ ses: 'error-not-sent' }); r = await send(t, 'm5'); fault();
  ok('a 5xx from SES is treated as unknown (never assumed not sent): no automatic resend', r.status === 502 && r.j.deliveryMayHaveOccurred === true && (await send(t, 'm5')).status === 409 && sesCount('m5') === 0);

  t = await login(ethers.Wallet.createRandom()); // the server allows 10 sends per wallet per minute
  fault({ s3: { op: 'PutObjectCommand', prefix: 'sent/' } }); r = await send(t, 'm6'); fault();
  ok('SES accepted it but the sent record could not be saved: the answer says delivered and asks for a retry', r.status === 500 && r.j.delivered === true && sesCount('m6') === 1);
  r = await send(t, 'm6');
  const sent = await call('GET', '/api/messages/sent', t);
  ok('…the retry does not send again and repairs the sent record', r.status === 200 && r.j.duplicate && sesCount('m6') === 1 && sent.j.emails?.some((e) => e.id === 'm6'));

  t = await login(ethers.Wallet.createRandom()); // the server allows 10 sends per wallet per minute
  fault({ s3: { op: 'PutObjectCommand', prefix: 'outbox/' } }); r = await send(t, 'm7'); fault();
  ok('the outbox cannot be written: nothing is sent', r.status >= 500 && sesCount('m7') === 0 && r.j.deliveryMayHaveOccurred === false);

  await stop(); await start(); const t2 = await login(w);
  r = await send(t2, 'm1');
  ok('after a restart the outbox still prevents a resend', r.status === 200 && r.j.duplicate && sesCount('m1') === 1);
  ok('another wallet cannot read this wallet\'s outbox', (await outbox(await login(ethers.Wallet.createRandom()), 'm1')).status === 404);
  ok('an invalid messageId is refused before anything happens', (await send(t2, '../x')).status === 400);
  ok('a send without messageId still works (server-generated id)', (await call('POST', '/api/messages/send-external', t2, { recipientEmail: 'a@example.org', subject: 's', body: 'b' })).status === 200);
} catch (e) { console.log('ERROR', e.stack); fail++; }
finally { try { await stop(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
