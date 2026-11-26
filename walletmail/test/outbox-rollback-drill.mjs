// Outbox rollback drill client (2026-11-26). Talks to an isolated drill instance (loopback, through an SSH tunnel)
// that runs the deployed server on a drill bucket with the real SES (simulator recipients only) and the real event
// pipeline. Faults are set by writing the control file on the host (the caller passes a command to do that).
//   node outbox-rollback-drill.mjs before  <state.json> <base>      messages A1..A4 before the backup
//   node outbox-rollback-drill.mjs after   <state.json> <base>      B1 and changes to A2/A4 after the backup
//   node outbox-rollback-drill.mjs verify  <state.json> <base> <out.json> <label>   on the RESTORED bucket
// The control file is set with DRILL_SET_FAULT="ssh ... 'echo %s | base64 -d | sudo tee <ctl>'" (%s = base64 of the JSON).
import fs from 'node:fs'; import { execSync } from 'node:child_process'; import { createRequire } from 'node:module';
const { ethers } = createRequire(import.meta.url)('ethers');
const [cmd, stateFile, BASE, outFile, label] = process.argv.slice(2);
const load = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {});
const store = (s) => { fs.writeFileSync(stateFile, JSON.stringify(s, null, 1)); fs.chmodSync(stateFile, 0o600); };
// the fault JSON travels base64-encoded (no shell quoting); the command must decode it, e.g. "echo %s | base64 -d | sudo tee <ctl>"
const fault = (f) => { execSync(process.env.DRILL_SET_FAULT.replace('%s', Buffer.from(JSON.stringify(f)).toString('base64')), { stdio: 'ignore' }); };
const j = async (m, u, t, b) => { const r = await fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}), signal: AbortSignal.timeout(30000) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
async function login(key) { const w = new ethers.Wallet(key); const c = await j('POST', '/api/auth/challenge', null, { wallet: w.address }); return (await j('POST', '/api/auth/verify', null, { challengeId: c.j.challengeId, signature: await w.signMessage(c.j.message) })).j.token; }
const msg = (s, id) => ({ messageId: `${s.nonce}-${id}`, recipientEmail: 'success@simulator.amazonses.com', subject: `outbox drill ${s.nonce} ${id}`, body: `Outbox rollback drill ${id}.` });
const send = (s, t, id) => j('POST', '/api/messages/send-external', t, msg(s, id));
const ob = (s, t, id) => j('GET', '/api/messages/outbox/' + `${s.nonce}-${id}`, t);
const log = (...a) => console.log(new Date().toISOString(), ...a);
if (cmd === 'before') {
  const w = ethers.Wallet.createRandom(); const s = { nonce: 'od' + Date.now().toString(36), key: w.privateKey, address: w.address.toLowerCase(), steps: [] }; const t = await login(s.key);
  const step = async (id, f, note) => { if (f) fault(f); const r = await send(s, t, id); fault({}); const o = await ob(s, t, id); s.steps.push({ phase: 'before', id, fault: f || null, note, at: new Date().toISOString(), status: r.status, answer: r.j, outbox: o.j.state }); log(id, r.status, JSON.stringify(r.j).slice(0, 160), 'outbox', o.j.state); };
  await step('A1', null, 'normal send');
  await step('A2', { ses: 'lost-response' }, 'SES accepted, answer lost → pending');
  await step('A3', { s3: 'sent-commit-then-fail' }, 'outbox "sent" written but its answer lost → 503 unknown, no Sent record');
  await step('A4', { ses: 'error-not-sent' }, 'SES never called → pending, truly not sent');
  s.before_done = new Date().toISOString(); store(s);
} else if (cmd === 'after') {
  const s = load(); const t = await login(s.key);
  const r1 = await send(s, t, 'B1'); s.steps.push({ phase: 'after', id: 'B1', at: new Date().toISOString(), status: r1.status, answer: r1.j, note: 'sent after the backup' }); log('B1', r1.status, r1.j.sesMessageId);
  // A2: events show SES accepted it → the retry is answered without a new submission
  let o; for (let i = 0; i < 30; i++) { o = await ob(s, t, 'A2'); if (o.j.events?.some((e) => e.eventType === 'Send')) break; await new Promise((r) => setTimeout(r, 5000)); }
  const r2 = await send(s, t, 'A2'); s.steps.push({ phase: 'after', id: 'A2', at: new Date().toISOString(), status: r2.status, answer: r2.j, note: 'retry after the Send event arrived' }); log('A2', r2.status, JSON.stringify(r2.j).slice(0, 160));
  s.after_sent = new Date().toISOString(); store(s);
} else if (cmd === 'after-a4') {
  const s = load(); const t = await login(s.key);
  const r = await send(s, t, 'A4'); s.steps.push({ phase: 'after', id: 'A4', at: new Date().toISOString(), status: r.status, answer: r.j, note: 'retry after the operator resolved it not-sent' }); log('A4', r.status, r.j.sesMessageId);
  s.after_done = new Date().toISOString(); store(s);
} else if (cmd === 'verify') {
  const s = load(); const t = await login(s.key); const checks = [];
  const check = (name, pass, ev) => { checks.push({ at: new Date().toISOString(), name, passed: !!pass, evidence: ev }); console.log(`${pass ? 'PASS' : 'FAIL'} [${label}] ${name} ${JSON.stringify(ev).slice(0, 220)}`); };
  const pre = {}; for (const id of ['A1', 'A2', 'A3', 'A4', 'B1']) pre[id] = (await ob(s, t, id)).j;
  check('restored data: B1 (sent after the backup) has no outbox entry', !pre.B1.state, { state: pre.B1.state || null });
  for (const id of ['A1', 'A2', 'A3', 'A4', 'B1']) {
    const r = await send(s, t, id); const o = (await ob(s, t, id)).j;
    check(`${id}: retry on the restored data is not submitted again`, r.status === 200 && r.j.duplicate === true, { status: r.status, duplicate: r.j.duplicate, reconciled: r.j.reconciled || false, sesMessageId: r.j.sesMessageId, outbox: o.state, reconciledBy: o.reconciledBy || null });
  }
  const sent = (await j('GET', '/api/messages/sent', t)).j.emails || [];
  check('Sent history holds all five after the retries', ['A1', 'A2', 'A3', 'A4', 'B1'].every((id) => sent.some((e) => e.id === `${s.nonce}-${id}`)), { ids: sent.map((e) => e.id) });
  const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { runs: [] };
  out.runs.push({ label, at: new Date().toISOString(), base: BASE, restored_state_before_retry: Object.fromEntries(Object.entries(pre).map(([k, v]) => [k, v.state || null])), passed: checks.filter((c) => c.passed).length, failed: checks.filter((c) => !c.passed).length, checks });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  console.log(`SUMMARY ${label} passed=${checks.filter((c) => c.passed).length} failed=${checks.filter((c) => !c.passed).length}`);
}
