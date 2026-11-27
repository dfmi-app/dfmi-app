// Pending reconciliation (2026-11-26): SES events → index → outbox, the pre-send check after a rollback, stale-pending
// alerts, and the operator tool's rules. S3/SES are local fixtures (events-store.cjs); nothing leaves the machine.
//   node outbox-reconcile.mjs ../server.js ../tools/outbox-ops.mjs
import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net'; import { spawn, execFileSync } from 'node:child_process'; import { once } from 'node:events';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const { ethers } = createRequire(import.meta.url)('ethers');
const SERVER = path.resolve(process.argv[2] || '../server.js'), OPS = path.resolve(process.argv[3] || '../tools/outbox-ops.mjs');
const dir = fs.mkdtempSync(path.join(HERE, 'reconcile-')); fs.copyFileSync(SERVER, path.join(dir, 'server.js')); fs.mkdirSync(path.join(dir, 'tools')); fs.copyFileSync(OPS, path.join(dir, 'tools', 'outbox-ops.mjs'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
const store = path.join(dir, 'objects.json'), control = path.join(dir, 'fault.json'), sesLog = path.join(dir, 'ses.jsonl');
fs.writeFileSync(store, '{}'); fs.writeFileSync(control, '{}'); fs.writeFileSync(sesLog, '');
let fail = 0; const ok = (m, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c ? '' : '  ' + x)); if (!c) fail++; };
const fault = (f = {}) => fs.writeFileSync(control, JSON.stringify(f));
const sesCount = (tag) => fs.readFileSync(sesLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((x) => x.tag === tag).length;
const objects = () => JSON.parse(fs.readFileSync(store, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const BASE = `http://127.0.0.1:${port}`; let proc;
const ENV = { ...process.env, DRILL_STORE: store, DRILL_CONTROL: control, DRILL_AUDIT: sesLog, AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x',
  S3_INCOMING_BUCKET: 'mail', SES_EVENTS_BUCKET: 'events', SES_CONFIGURATION_SET: 'walletmail-events', EMAIL_DOMAIN: 'example.invalid', DFMI_RPC: 'http://127.0.0.1:9', ENS_REGISTRY: '', ENS_RESOLVER: '', ENS_BOOTSTRAP_NAMES: '',
  OUTBOX_RECONCILE_MS: '300', OUTBOX_PENDING_ALERT_MS: '1500', OUTBOX_EVIDENCE_WINDOW_MS: '1000', OUTBOX_CANARY_MAX_GAP_MS: String(3600e3), OUTBOX_DELAY_ALERT_MS: '2500' };
async function start(extra = {}) { proc = spawn(process.execPath, ['-r', path.join(HERE, 'events-store.cjs'), path.join(dir, 'server.js')], { cwd: dir, env: { ...ENV, PORT: String(port), ...extra }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {} await sleep(50); } throw Error('no start'); }
async function stop() { if (!proc || proc.exitCode !== null || proc.signalCode) return; const d = once(proc, 'exit'); proc.kill(); await d; }
const call = async (m, u, t, b) => { const r = await fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
async function login(w) { const c = await call('POST', '/api/auth/challenge', null, { wallet: w.address }); return (await call('POST', '/api/auth/verify', null, { challengeId: c.j.challengeId, signature: await w.signMessage(c.j.message) })).j.token; }
const send = (t, id, extra = {}) => call('POST', '/api/messages/send-external', t, { messageId: id, recipientEmail: 'someone@example.org', subject: 'hello ' + id, body: 'body ' + id, ...extra });
const outbox = (t, id) => call('GET', '/api/messages/outbox/' + id, t);
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };
function ops(...a) { try { return { code: 0, out: execFileSync(process.execPath, ['-r', path.join(HERE, 'events-store.cjs'), path.join(dir, 'tools', 'outbox-ops.mjs'), ...a], { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; } }
const user = async () => { const w = ethers.Wallet.createRandom(); return { w, addr: w.address.toLowerCase(), t: await login(w) }; };
try {
  await start();
  // 1. normal send carries the configuration set and tags; events are indexed and visible to the owner
  let u = await user(); let r = await send(u.t, 'n1');
  const line = fs.readFileSync(sesLog, 'utf8').trim().split('\n').map(JSON.parse).find((x) => x.tag === 'n1');
  ok('a send uses the SES configuration set (so SES publishes its events)', r.status === 200 && line?.configurationSet === 'walletmail-events');
  ok('its Send and Delivery events are indexed and shown in the outbox state', await until(async () => { const o = await outbox(u.t, 'n1'); return o.j.events?.some((e) => e.eventType === 'Send') && o.j.events?.some((e) => e.eventType === 'Delivery'); }));
  r = await send(u.t, 'b1', { recipientEmail: 'bounce@simulator.amazonses.com' });
  ok('a bounce is recorded with its type', await until(async () => (await outbox(u.t, 'b1')).j.events?.some((e) => e.eventType === 'Bounce' && e.detail?.bounceType === 'Permanent')));
  ok('another wallet cannot see those events', (await outbox((await user()).t, 'n1')).status === 404);
  const tagged = 'a.b:c-1';  // characters SES tags do not allow
  r = await send(u.t, tagged);
  ok('a messageId with "." and ":" is still tagged exactly (base64url) and its events found', r.status === 200 && await until(async () => (await outbox(u.t, tagged)).j.events?.some((e) => e.eventType === 'Send')));

  // 2. SES accepted, response lost → pending → the reconciler promotes it from the Send event, never resending
  u = await user(); fault({ ses: 'lost-response' }); r = await send(u.t, 'p1'); fault();
  ok('lost response: the client is told the outcome is unknown', r.status === 502 && r.j.deliveryMayHaveOccurred === true);
  ok('the reconciler turns the pending entry into sent from SES\'s Send event', await until(async () => { const o = await outbox(u.t, 'p1'); return o.j.state === 'sent' && o.j.reconciledBy === 'reconciler' && !!o.j.sesMessageId; }));
  r = await send(u.t, 'p1');
  ok('a retry then returns the original result and repairs Sent, with exactly one SES submission', r.status === 200 && r.j.duplicate && sesCount('p1') === 1 && (await call('GET', '/api/messages/sent', u.t)).j.emails?.some((e) => e.id === 'p1'));

  // 3. SES 5xx (not accepted) → pending, no events → alert → operator: not-sent only with canary proof
  u = await user(); ops('canary'); await sleep(50);
  fault({ ses: 'error-not-sent' }); r = await send(u.t, 'q1'); fault();
  ok('5xx: pending, outcome unknown', r.status === 502 && (await outbox(u.t, 'q1')).j.state === 'pending');
  let rr = ops('resolve', u.addr, 'q1', '--as', 'not-sent', '--operator', 'test-op', '--reason', 'drill');
  ok('operator: not-sent is refused while it is too recent or no canary after the claim', rr.code !== 0 && /refused/.test(rr.out), rr.out);
  ok('after the alert window the stale pending entry is reported in health and as an alert record', await until(async () => { const h = (await call('GET', '/api/health')).j.outbox; return h.pendingStale >= 1 && Object.keys(objects()).some((k) => k.startsWith(`mail/outbox-alerts/${u.addr}/`)); }, 8000));
  rr = ops('resolve', u.addr, 'q1', '--as', 'sent', '--operator', 'test-op', '--reason', 'drill');
  ok('operator: sent is refused without an SES acceptance event', rr.code !== 0 && /no acceptance event/.test(rr.out));
  ops('canary'); await sleep(500);
  ok('the canary\'s own events are indexed', await until(async () => Object.keys(objects()).some((k) => k.startsWith('events/index/0x' + '0'.repeat(40) + '/'))));
  rr = ops('resolve', u.addr, 'q1', '--as', 'not-sent', '--operator', 'test-op', '--reason', 'no SES event; canary before and after');
  ok('operator: healthy probes still cannot prove nonacceptance', rr.code !== 0 && /refused/.test(rr.out));
  rr = ops('resolve', u.addr, 'q1', '--as', 'undeterminable', '--operator', 'test-op', '--reason', 'unknown outcome; probes are not proof');
  ok('unknown outcome is closed as abandoned with audit in both buckets', rr.code === 0 && JSON.parse(rr.out).newState === 'abandoned' && Object.keys(objects()).some(k => k.startsWith(`events/resolutions/${u.addr}/`)));
  ok('show reads the authoritative disposition', /"decision": "undeterminable"/.test(ops('show', u.addr, 'q1').out));
  r = await send(u.t, 'q1');
  ok('the same messageId cannot be retried after an unknown outcome was closed', r.status === 409 && sesCount('q1') === 0);
  rr = ops('resolve', u.addr, 'q1', '--as', 'not-sent', '--operator', 'x', '--reason', 'y');
  ok('operator: a resolved/sent entry cannot be resolved again', rr.code !== 0 && /only pending/.test(rr.out));

  // 4. pipeline broken + SES accepted: no events → the operator cannot claim not-sent → undeterminable → abandoned
  u = await user(); fault({ ses: 'lost-response', events: 'off' }); r = await send(u.t, 'x1'); fault();
  await sleep(1200);
  const st = JSON.parse(fs.readFileSync(store, 'utf8')); for (const k of Object.keys(st)) if (k.startsWith('events/index/0x0000')) delete st[k]; fs.writeFileSync(store, JSON.stringify(st)); // no canary evidence around this claim
  rr = ops('resolve', u.addr, 'x1', '--as', 'not-sent', '--operator', 'test-op', '--reason', 'drill');
  ok('pipeline unproven: not-sent is refused (absence of events proves nothing)', rr.code !== 0 && /proves nothing/.test(rr.out), rr.out);
  rr = ops('resolve', u.addr, 'x1', '--as', 'undeterminable', '--operator', 'test-op', '--reason', 'pipeline unproven');
  ok('operator: undeterminable → abandoned', rr.code === 0 && JSON.parse(rr.out).newState === 'abandoned');
  r = await send(u.t, 'x1');
  ok('an abandoned messageId is never sent again (409, user told to check with the recipient)', r.status === 409 && r.j.state === 'abandoned' && sesCount('x1') === 1);
  ok('list shows open entries with their evidence', /"state": "abandoned"/.test(ops('list').out));

  // 5. rollback: outbox and Sent lost (restore of an older backup), events bucket intact → retry does not resend
  u = await user(); r = await send(u.t, 'r1'); await until(async () => (await outbox(u.t, 'r1')).j.events?.length > 0);
  const st2 = JSON.parse(fs.readFileSync(store, 'utf8')); for (const k of Object.keys(st2)) if (k === `mail/outbox/${u.addr}/r1.json` || k === `mail/sent/${u.addr}/r1.json`) delete st2[k]; fs.writeFileSync(store, JSON.stringify(st2));
  await stop(); await start(); u.t = await login(u.w);
  r = await send(u.t, 'r1');
  ok('after a rollback that lost the outbox entry, a retry is answered from SES\'s events and NOT resent', r.status === 200 && r.j.duplicate && r.j.reconciled && sesCount('r1') === 1);
  ok('…the outbox entry and Sent are rebuilt', (await outbox(u.t, 'r1')).j.state === 'sent' && (await call('GET', '/api/messages/sent', u.t)).j.emails?.some((e) => e.id === 'r1'));
  const st3 = JSON.parse(fs.readFileSync(store, 'utf8')); delete st3[`mail/outbox/${u.addr}/r1.json`]; fs.writeFileSync(store, JSON.stringify(st3));
  r = await send(u.t, 'r1', { subject: 'something else' });
  ok('after a rollback, the same messageId with a different subject is refused, not sent', r.status === 409 && sesCount('r1') === 1);
  // a pending entry restored from the backup whose message SES accepted after the backup
  u = await user(); fault({ ses: 'lost-response' }); await send(u.t, 'r2'); fault();
  await until(async () => (await outbox(u.t, 'r2')).j.state === 'sent');
  const st4 = JSON.parse(fs.readFileSync(store, 'utf8')); const ek = `mail/outbox/${u.addr}/r2.json`; const rec = JSON.parse(Buffer.from(st4[ek].body, 'base64')); rec.state = 'pending'; delete rec.sesMessageId; st4[ek].body = Buffer.from(JSON.stringify(rec)).toString('base64'); st4[ek].etag = '"rolled-back"'; fs.writeFileSync(store, JSON.stringify(st4));
  r = await send(u.t, 'r2');
  ok('a rolled-back pending entry whose message SES accepted is repaired on retry, not resent', r.status === 200 && r.j.duplicate && sesCount('r2') === 1);
  // events index unreadable → nothing is sent
  u = await user(); fault({ s3: { op: 'ListObjectsV2Command', bucket: 'events', prefix: 'index/' } }); r = await send(u.t, 'e1'); fault();
  ok('if the delivery records cannot be read, nothing is sent (503, deliveryMayHaveOccurred false)', r.status === 503 && r.j.deliveryMayHaveOccurred === false && sesCount('e1') === 0);
  // 6. delivery anomalies (acceptance D): success / bounce / complaint / delay are recorded, reported for alerting, and closed by a recorded ack
  u = await user();
  await send(u.t, 'd-ok'); await send(u.t, 'd-bounce', { recipientEmail: 'bounce@simulator.amazonses.com' }); await send(u.t, 'd-complaint', { recipientEmail: 'complaint@simulator.amazonses.com' }); await send(u.t, 'd-delay', { recipientEmail: 'delay@example.org' });
  const dstate = async (id) => (await outbox(u.t, id)).j.delivery;
  ok('outbox status: delivered / bounced / complained / delayed', await until(async () => (await dstate('d-ok')) === 'delivered' && (await dstate('d-bounce')) === 'bounced' && (await dstate('d-complaint')) === 'complained' && (await dstate('d-delay')) === 'delayed', 8000),
    JSON.stringify([await dstate('d-ok'), await dstate('d-bounce'), await dstate('d-complaint'), await dstate('d-delay')]));
  const openKeys = () => Object.keys(objects()).filter((k) => k.startsWith('events/anomalies/open/') && k.includes(`/${u.addr}/`));
  ok('each bounce, complaint and delay is recorded once as an open anomaly (a delivery is not)', await until(async () => openKeys().length === 3) && ['Bounce', 'Complaint', 'DeliveryDelay'].every((t) => openKeys().some((k) => k.startsWith(`events/anomalies/open/${t}/`))), JSON.stringify(openKeys()));
  let an = null;
  ok('health reports the open bounce, complaint and delay (what the monitor alerts on)', await until(async () => { an = (await call('GET', '/api/health')).j.outbox.anomalies; return an?.bounce >= 1 && an?.complaint >= 1 && an?.delayOpen >= 1; }, 8000), JSON.stringify(an));
  ok('a delay still open after OUTBOX_DELAY_ALERT_MS is reported as overdue', await until(async () => { an = (await call('GET', '/api/health')).j.outbox.anomalies; return an?.delayOverdue >= 1; }, 10000), JSON.stringify(an));
  let la = ops('anomalies');
  ok('operator: anomalies lists them with their detail', la.code === 0 && ['d-bounce', 'd-complaint', 'd-delay'].every((id) => la.out.includes(`"messageId": "${id}"`)) && /"bounceType": "Permanent"/.test(la.out));
  rr = ops('ack', u.addr, 'd-bounce', '--operator', 'test-op');
  ok('operator: ack needs an operator and a reason', rr.code !== 0);
  for (const o of JSON.parse(la.out).open.filter((x) => x.eventType !== 'DeliveryDelay')) ops('ack', o.wallet, o.messageId, '--operator', 'test-op', '--reason', 'address checked; suppressed by SES');
  ok('after the recorded acks health shows no open bounce/complaint; the open records are kept (nothing deleted)', await until(async () => { an = (await call('GET', '/api/health')).j.outbox.anomalies; return an?.bounce === 0 && an?.complaint === 0; }, 8000)
    && openKeys().length === 3 && Object.keys(objects()).some((k) => k.startsWith('events/anomalies/ack/Bounce/') && k.includes(`/${u.addr}/`)), JSON.stringify(an));
  { const ob = (await outbox(u.t, 'd-bounce')).j;
    ok('an acknowledged bounce stays "bounced" (delivery comes only from SES events) and shows the ack', ob.delivery === 'bounced' && ob.anomalies?.length === 1 && ob.anomalies[0].acknowledged === true && ob.anomalies[0].ackBy === 'test-op' && ob.anomalies[0].ackKind === 'operator', JSON.stringify({ d: ob.delivery, a: ob.anomalies })); }
  await send(u.t, 'd-sendonly', { recipientEmail: 'sendonly@example.org' });
  ok('a bare Send event is reported as "sent", never "delivered"', await until(async () => (await outbox(u.t, 'd-sendonly')).j.events?.some((e) => e.eventType === 'Send')) && (await dstate('d-sendonly')) === 'sent');
  ok('ack of a messageId with nothing open is refused', ops('ack', u.addr, 'd-ok', '--operator', 'x', '--reason', 'y').code !== 0);
  { // the delayed message is delivered later: Firehose writes the Delivery event; the reconciler closes the delay itself
    const sid = (await outbox(u.t, 'd-delay')).j.sesMessageId; const d = new Date(); const p2 = (x) => String(x).padStart(2, '0');
    const key = `events/raw/${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${p2(d.getUTCHours())}/late-delivery-${Date.now()}`;
    const ev = { eventType: 'Delivery', mail: { timestamp: d.toISOString(), messageId: sid, destination: ['delay@example.org'], tags: { obw: [u.addr], obid: [Buffer.from('d-delay').toString('base64url')] } }, delivery: { recipients: ['delay@example.org'], smtpResponse: '250 OK', timestamp: new Date().toISOString() } };
    const st5 = objects(); st5[key] = { body: Buffer.from(JSON.stringify(ev)).toString('base64'), etag: '"late"', at: Date.now() }; fs.writeFileSync(store, JSON.stringify(st5));
    ok('a delay followed by its Delivery is closed by the reconciler (recorded) and the status becomes delivered', await until(async () => { an = (await call('GET', '/api/health')).j.outbox.anomalies; return an?.delayOpen === 0 && an?.delayOverdue === 0 && (await dstate('d-delay')) === 'delivered'; }, 10000)
      && Object.keys(objects()).some((k) => k.startsWith('events/anomalies/ack/DeliveryDelay/') && k.includes(`/${u.addr}/`) && JSON.parse(Buffer.from(objects()[k].body, 'base64')).by === 'reconciler'), JSON.stringify(an));
  }
  const hh = (await call('GET', '/api/health')).j.outbox;
  ok('health reports the reconciler as running and the last canary time', !!hh.lastOkAt && !!hh.lastCanaryAt, JSON.stringify(hh));
} catch (e) { console.log('ERROR', e.stack); fail++; }
finally { try { await stop(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
