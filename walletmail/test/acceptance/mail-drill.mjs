// Acceptance B (mail), C, D — isolated cloud drill client (WSL). Talks to the drill instance on 127.0.0.1 (mail-drill-ctl.sh);
// real S3 drill buckets, real SES (simulator recipients only), the drill's own configuration set + Firehose + events bucket.
// Faults go through DRILL_CONTROL (drill-faults.cjs). Every real SES call is logged there; submission counts are taken from
// that log (verify-ses phase), never inferred from HTTP answers.
//   node mail-drill.mjs <phase> <state.json> <base> <out.json>
import fs from 'node:fs'; import crypto from 'node:crypto'; import { createRequire } from 'node:module';
const require = createRequire(process.env.DRILL_DEPS + '/'); const { ethers } = require('ethers');
const [phase, stateFile, BASE, outFile] = process.argv.slice(2);
const s = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const store = () => { fs.writeFileSync(stateFile, JSON.stringify(s, null, 1)); fs.chmodSync(stateFile, 0o600); };
const fault = (f) => fs.writeFileSync(process.env.DRILL_CONTROL, JSON.stringify(f));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, pass, ev) => { checks.push({ at: new Date().toISOString(), phase, name, passed: !!pass, evidence: ev }); console.log(`${pass ? 'PASS' : 'FAIL'} [${phase}] ${name} ${JSON.stringify(ev).slice(0, 240)}`); };
const j = async (m, u, t, b) => { try { const r = await fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}), signal: AbortSignal.timeout(60000) });
  return { status: r.status, j: await r.json().catch(() => ({})), retryAfter: r.headers.get('retry-after') }; } catch (e) { return { status: 0, j: { error: String(e.cause?.code || e.name) } }; } };
async function login() { const w = new ethers.Wallet(s.key); for (let i = 0; i < 5; i++) { const c = await j('POST', '/api/auth/challenge', null, { wallet: w.address });
  const v = await j('POST', '/api/auth/verify', null, { challengeId: c.j.challengeId, signature: await w.signMessage(c.j.message || '') }); if (v.j.token) return v.j.token; await sleep(2000); } throw new Error('login failed'); }
const TO = { ok: 'success@simulator.amazonses.com', bounce: 'bounce@simulator.amazonses.com', complaint: 'complaint@simulator.amazonses.com' };
const msg = (id, body, to = TO.ok) => ({ messageId: `${s.nonce}-${id}`, recipientEmail: to, subject: `final drill ${s.nonce} ${id}`, body: body || `Final acceptance drill ${id}.` });
// the per-wallet limit is 10 sends / min: a 429 is not a success — wait and send the SAME request again (recorded)
async function send(t, id, f, body, note, to) {
  let r; for (let i = 0; i < 6; i++) { if (f) fault(f); r = await j('POST', '/api/messages/send-external', t, msg(id, body, to)); if (f) fault({});
    s.steps = s.steps || []; s.steps.push({ phase, id, fault: f || null, note, body_modified: !!body, to: to || TO.ok, at: new Date().toISOString(), status: r.status, answer: r.j });
    console.log(new Date().toISOString(), phase, id, f ? JSON.stringify(f) : '-', r.status, JSON.stringify(r.j).slice(0, 140));
    if (r.status !== 429) break; await sleep(62000); }
  return r;
}
const outbox = async (t, id) => (await j('GET', '/api/messages/outbox/' + `${s.nonce}-${id}`, t)).j;
async function waitFor(t, id, pred, maxS = 300) { let o; for (let i = 0; i < maxS / 5; i++) { o = await outbox(t, id); if (pred(o)) return o; await sleep(5000); } return o; }

// synthetic SES events for the DeliveryDelay case (SES format, Firehose layout: raw/YYYY/MM/DD/HH/<name>) — labelled synthetic
async function inject(events, label) {
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'); const c = new S3Client({ region: 'us-east-1' }); const d = new Date(); const p = (x) => String(x).padStart(2, '0');
  const key = `raw/${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${p(d.getUTCHours())}/SYNTHETIC-acceptance-${label}-${d.toISOString().replace(/[^0-9]/g, '')}`;
  await c.send(new PutObjectCommand({ Bucket: process.env.DRILL_EVENTS_BUCKET, Key: key, Body: events.map((e) => JSON.stringify(e)).join(''), ContentType: 'application/json' }));
  s.injected = s.injected || []; s.injected.push({ at: new Date().toISOString(), key, label, events }); return key;
}
const sesMail = (id, sesId, ts) => ({ timestamp: ts, source: `${s.address}@dfmi.me`, messageId: sesId, destination: [TO.ok],
  tags: { obw: [s.address], obid: [Buffer.from(`${s.nonce}-${id}`).toString('base64url')], messageId: [`${s.nonce}-${id}`.replace(/[^A-Za-z0-9_-]/g, '_')] }, commonHeaders: { subject: `final drill ${s.nonce} ${id}` } });

if (phase === 'legacy-before') {            // pre-journal server 5a1c33eb, before the backup
  const w = ethers.Wallet.createRandom(); Object.assign(s, { nonce: 'fd' + Date.now().toString(36), key: w.privateKey, address: w.address.toLowerCase() }); const t = await login();
  check('L1 legacy normal send', (await send(t, 'L1', null, null, 'legacy, before backup')).status === 200, {});
  check('L2 legacy: SES accepted, answer lost → unknown (502)', (await send(t, 'L2', { ses: 'lost-response' }, null, 'legacy')).status === 502, {});
  check('L4 legacy: SES never called → unknown (502)', (await send(t, 'L4', { ses: 'error-not-sent' }, null, 'legacy; later "not-sent" by the OLD operator rule')).status === 502, {});
} else if (phase === 'legacy-after') {      // pre-journal server, after the backup: L3 = sent, then missing from the backup, no SES event
  const t = await login();
  check('L3 legacy after the backup: accepted with NO SES event', (await send(t, 'L3', { ses: 'no-events' }, null, 'legacy, after backup')).status === 200, {});
} else if (phase === 'journal') {           // frozen server on the live bucket
  const t = await login();
  check('J1 normal send', (await send(t, 'J1', null, null, 'frozen')).status === 200, {});
  for (const n of [2, 3]) { const r = await send(t, 'J1', null, null, `identical retry ${n}`); check(`J1 identical retry ${n}: duplicate, no resubmission`, r.status === 200 && r.j.duplicate === true, { status: r.status }); }
  const m = await send(t, 'J1', null, 'MODIFIED BODY', 'same id, modified body'); check('J1 modified body is refused (409)', m.status === 409, { status: m.status });
  check('J2 SES accepted, answer lost → unknown (502)', (await send(t, 'J2', { ses: 'lost-response' }, null, 'frozen')).status === 502, {});
  const r3 = await send(t, 'J3', { s3: 'journal-sent-commit-then-fail' }, null, 'journal "sent" committed, its answer lost');
  check('J3 outcome committed, answer lost → 503 persistenceUnknown', r3.status === 503 && r3.j.persistenceUnknown === true, { status: r3.status });
  check('J4 SES never called → unknown (502)', (await send(t, 'J4', { ses: 'error-not-sent' }, null, 'frozen; later closed undeterminable')).status === 502, {});
  check('J5 accepted with NO SES event', (await send(t, 'J5', { ses: 'no-events' }, null, 'frozen')).status === 200, {});
} else if (phase === 'concurrent') {        // B: the same request 20 times at once
  const t = await login(); const b = msg('C20'); s.steps = s.steps || [];
  const rs = await Promise.all(Array.from({ length: 20 }, () => j('POST', '/api/messages/send-external', t, b)));
  for (const r of rs) s.steps.push({ phase, id: 'C20', at: new Date().toISOString(), status: r.status, answer: r.j });
  const codes = rs.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {}); const firsts = rs.filter((r) => r.status === 200 && !r.j.duplicate).length;
  check('C20 20 concurrent identical requests: exactly one fresh acceptance, the rest duplicate/in-progress, no 5xx', firsts === 1 && rs.every((r) => r.status === 200 || r.status === 409 || r.status === 429), { codes, fresh: firsts });
  // the production limit (10 / min / wallet) answers part of the burst with 429: those callers wait for the window and send
  // the SAME request again; every one of them must end as a duplicate of the single acceptance
  const limited = rs.filter((r) => r.status === 429).length; await sleep(62000);
  const retries = []; for (let i = 0; i < limited; i++) retries.push(await send(t, 'C20', null, null, `rate-limited caller ${i + 1} retries the original request`));
  check('C20 every rate-limited caller, retrying the original request, gets the same result (duplicate)', retries.every((r) => r.status === 200 && r.j.duplicate === true), { limited, statuses: retries.map((r) => r.status) });
  const again = await send(t, 'C20', null, null, 'retry after the burst'); check('C20 retry after the burst: duplicate', again.status === 200 && again.j.duplicate === true, { status: again.status });
} else if (phase === 'kill') {              // B: SES accepted, then the process is SIGKILLed before the outcome is recorded
  const t = await login(); const r = await send(t, 'K1', { ses: 'accept-then-kill' }, null, 'SES accepted, process killed before the record');
  check('K1 the request dies with the process (no answer)', r.status === 0, { status: r.status, error: r.j.error });
} else if (phase === 'after-kill') {        // after the restart
  const t = await login(); const r = await send(t, 'K1', null, null, 'retry right after the restart');
  check('K1 retry after restart: not resent (409 unknown, or duplicate once reconciled)', r.status === 409 || (r.status === 200 && r.j.duplicate === true), { status: r.status, state: r.j.state });
  const o = await waitFor(t, 'K1', (x) => x.state === 'sent', 240); check('K1 reconciled to sent from its SES Send event', o.state === 'sent', { state: o.state, reconciledBy: o.reconciledBy });
  const r2 = await send(t, 'K1', null, null, 'retry after reconciliation'); check('K1 retry after reconciliation: duplicate', r2.status === 200 && r2.j.duplicate === true, { status: r2.status });
} else if (phase === 'delivery') {          // D: real SES simulator outcomes
  const t = await login();
  const ds = await send(t, 'DS', null, null, 'success simulator', TO.ok); const db = await send(t, 'DB', null, null, 'bounce simulator', TO.bounce); const dc = await send(t, 'DC', null, null, 'complaint simulator', TO.complaint);
  s.delivery = { DS: ds.j.sesMessageId, DB: db.j.sesMessageId, DC: dc.j.sesMessageId, sentAt: new Date().toISOString() };
  const os = await waitFor(t, 'DS', (x) => x.delivery === 'delivered'); const ev = (os.events || []).find((e) => e.eventType === 'Delivery');
  check('DS Delivery recorded; matches the SES message id; a bare Send was not counted as delivered', os.delivery === 'delivered' && ev?.sesMessageId === ds.j.sesMessageId && (os.events || []).some((e) => e.eventType === 'Send'), { delivery: os.delivery, sesMessageId: ds.j.sesMessageId, deliveryEvent: ev });
  const ob = await waitFor(t, 'DB', (x) => x.delivery === 'bounced'); check('DB Bounce recorded with type and recipient', ob.delivery === 'bounced' && (ob.events || []).some((e) => e.eventType === 'Bounce' && e.detail?.bounceType && (e.detail.recipients || []).includes(TO.bounce)), { delivery: ob.delivery, anomalies: ob.anomalies, bounce: (ob.events || []).find((e) => e.eventType === 'Bounce') });
  const oc = await waitFor(t, 'DC', (x) => x.delivery === 'complained'); check('DC Complaint recorded with recipient', oc.delivery === 'complained' && (oc.events || []).some((e) => e.eventType === 'Complaint' && (e.detail.recipients || []).includes(TO.complaint)), { delivery: oc.delivery, anomalies: oc.anomalies });
  s.delivery.recordedAt = { DS: new Date().toISOString() };
} else if (phase === 'delay-start') {       // D: DeliveryDelay (synthetic: the simulator cannot produce one)
  const t = await login(); const r = await send(t, 'DD', { ses: 'no-events' }, null, 'real send without events; its Send + DeliveryDelay are injected (SYNTHETIC)');
  const sesId = r.j.sesMessageId; const old = new Date(Date.now() - 61 * 60000).toISOString(); s.dd = { sesId, delayTs: old };
  const key = await inject([{ eventType: 'Send', mail: sesMail('DD', sesId, old), send: {} }, { eventType: 'DeliveryDelay', mail: sesMail('DD', sesId, old), deliveryDelay: { timestamp: old, delayType: 'TransientCommunicationFailure', expirationTime: new Date(Date.now() + 23 * 3600e3).toISOString(), delayedRecipients: [{ emailAddress: TO.ok, status: '4.4.7', diagnosticCode: 'synthetic acceptance event' }] } }], 'delay');
  s.dd.injectedAt = new Date().toISOString(); s.dd.key = key;
  const o = await waitFor(t, 'DD', (x) => x.delivery === 'delayed', 180); check('DD synthetic DeliveryDelay (61 min old) recorded as delayed', o.delivery === 'delayed', { delivery: o.delivery, injected: key });
} else if (phase === 'delay-final') {
  const t = await login(); const now = new Date().toISOString();
  const key = await inject([{ eventType: 'Delivery', mail: sesMail('DD', s.dd.sesId, now), delivery: { timestamp: now, recipients: [TO.ok], smtpResponse: '250 synthetic acceptance event', processingTimeMillis: 1 } }], 'delay-final');
  s.dd.finalInjectedAt = now; const o = await waitFor(t, 'DD', (x) => x.delivery === 'delivered', 180);
  check('DD final Delivery after the delay: state updated to delivered', o.delivery === 'delivered', { delivery: o.delivery, injected: key });
} else if (phase === 'acked') {             // after `outbox-ops ack` of DB and DC: the ack is recorded but never turns into "delivered"
  const t = await login();
  for (const [id, want] of [['DB', 'bounced'], ['DC', 'complained']]) { const o = await outbox(t, id);
    check(`${id} after the operator ack: still ${want} (not delivered), ack recorded`, o.delivery === want && (o.anomalies || []).length > 0 && o.anomalies.every((a) => a.acknowledged && a.ackBy), { delivery: o.delivery, anomalies: o.anomalies }); }
} else if (phase.startsWith('verify-')) {   // retries on restored data
  const t = await login(); const ids = ['L1', 'L2', 'L3', 'L4', 'J1', 'J2', 'J3', 'J4', 'J5', 'C20', 'K1', 'DS', 'DB', 'DC', 'DD'];
  const vis = {}; for (const id of ids) { const o = await j('GET', '/api/messages/outbox/' + `${s.nonce}-${id}`, t); vis[id] = o.status === 404 ? null : o.j.state; } (s.visible = s.visible || {})[phase] = vis; console.log('visible', JSON.stringify(vis));
  const exp = { L1: 200, L2: 200, L3: 200, L4: 409, J1: 200, J2: 200, J3: 200, J4: 409, J5: 200, C20: 200, K1: 200, DS: 200, DB: 200, DC: 200, DD: 200 };
  for (const id of ids) { const r = await send(t, id, null, null, `retry on ${phase}`); const dup = exp[id] === 200;
    check(`${id}: retry → ${exp[id]}${dup ? ' duplicate' : ''} (no SES submission)`, r.status === exp[id] && (!dup || r.j.duplicate === true), { status: r.status, duplicate: r.j.duplicate, error: r.j.error }); }
  const nid = { 'verify-restored': 'N1', 'verify-after-guard-off': 'N2', 'verify-restore-2': 'N3' }[phase]; const n = await send(t, nid, null, null, `new id on ${phase}`);
  if (phase === 'verify-restored') check('N1 a new id is blocked while the durable guard is on', n.status === 503, { status: n.status, error: n.j.error });
  else check(`${nid} a new id sends exactly once`, n.status === 200 && !n.j.duplicate, { status: n.status });
}
store();
if (outFile) { const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { runs: [] }; out.runs.push({ phase, at: new Date().toISOString(), passed: checks.filter((c) => c.passed).length, failed: checks.filter((c) => !c.passed).length, checks }); fs.writeFileSync(outFile, JSON.stringify(out, null, 1)); }
console.log(`SUMMARY ${phase} passed=${checks.filter((c) => c.passed).length} failed=${checks.filter((c) => !c.passed).length}`);
