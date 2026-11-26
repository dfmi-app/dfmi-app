// Journal cloud drill client (2026-11-26). Talks to an isolated drill instance (loopback, via SSH tunnel) that runs on a
// temporary mail bucket with the real SES (simulator recipients only) and the real events bucket / journal.
// Faults are set through DRILL_SET_FAULT ("... echo %s | base64 -d | sudo tee <ctl>", %s = base64 JSON).
//   node journal-drill.mjs <phase> <state.json> <base> [out.json]
//   phases: legacy-before | legacy-after | journal-after | verify-restored | verify-after-guard-off
import fs from 'node:fs'; import { execSync } from 'node:child_process'; import { createRequire } from 'node:module';
const { ethers } = createRequire(import.meta.url)('ethers');
const [phase, stateFile, BASE, outFile] = process.argv.slice(2);
const load = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {});
const store = (s) => { fs.writeFileSync(stateFile, JSON.stringify(s, null, 1)); fs.chmodSync(stateFile, 0o600); };
const fault = (f) => execSync(process.env.DRILL_SET_FAULT.replace('%s', Buffer.from(JSON.stringify(f)).toString('base64')), { stdio: 'ignore' });
const j = async (m, u, t, b) => { const r = await fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}), signal: AbortSignal.timeout(30000) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
async function login(key) { const w = new ethers.Wallet(key); const c = await j('POST', '/api/auth/challenge', null, { wallet: w.address }); return (await j('POST', '/api/auth/verify', null, { challengeId: c.j.challengeId, signature: await w.signMessage(c.j.message) })).j.token; }
const msg = (s, id, body) => ({ messageId: `${s.nonce}-${id}`, recipientEmail: 'success@simulator.amazonses.com', subject: `journal drill ${s.nonce} ${id}`, body: body || `Journal drill ${id}.` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let s = load(); const checks = [];
const check = (name, pass, ev) => { checks.push({ at: new Date().toISOString(), phase, name, passed: !!pass, evidence: ev }); console.log(`${pass ? 'PASS' : 'FAIL'} [${phase}] ${name} ${JSON.stringify(ev).slice(0, 200)}`); };
async function step(t, id, f, body, note) {
  if (f) fault(f); const r = await j('POST', '/api/messages/send-external', t, msg(s, id, body)); if (f) fault({});
  const o = await j('GET', '/api/messages/outbox/' + `${s.nonce}-${id}`, t);
  s.steps = s.steps || []; s.steps.push({ phase, id, fault: f || null, note, body_modified: !!body, at: new Date().toISOString(), status: r.status, answer: r.j, outbox_state: o.j.state || null });
  console.log(new Date().toISOString(), phase, id, f ? JSON.stringify(f) : '-', r.status, JSON.stringify(r.j).slice(0, 150), 'outbox', o.j.state); return r;
}
if (phase === 'legacy-before') {
  const w = ethers.Wallet.createRandom(); s = { nonce: 'jd' + Date.now().toString(36), key: w.privateKey, address: w.address.toLowerCase() }; const t = await login(s.key);
  check('L1 legacy normal send', (await step(t, 'L1', null, null, 'pre-journal server, normal')).status === 200, {});
  check('L2 legacy: SES accepted, answer lost → pending', (await step(t, 'L2', { ses: 'lost-response' }, null, 'pre-journal server')).status === 502, {});
  check('L4 legacy: SES never called → pending', (await step(t, 'L4', { ses: 'error-not-sent' }, null, 'pre-journal server; later "not-sent" by the OLD operator rule')).status === 502, {});
} else if (phase === 'legacy-after') {
  const t = await login(s.key);
  check('L3 legacy after the backup: accepted with NO SES event (lost record + no event + no journal)', (await step(t, 'L3', { ses: 'no-events' }, null, 'pre-journal server, after backup')).status === 200, {});
} else if (phase === 'journal-after') {
  const t = await login(s.key);
  check('J1 journal normal send', (await step(t, 'J1', null, null, 'journal server')).status === 200, {});
  for (const n of [2, 3]) { const r = await step(t, 'J1', null, null, `identical retry ${n}`); check(`J1 identical retry ${n}: same result, no resubmission`, r.status === 200 && r.j.duplicate === true, { status: r.status }); }
  const m = await step(t, 'J1', null, 'MODIFIED BODY', 'same id, modified body'); check('J1 with a modified body is refused', m.status === 409, { status: m.status });
  check('J2 SES accepted, answer lost → pending', (await step(t, 'J2', { ses: 'lost-response' }, null, 'journal server')).status === 502, {});
  const r3 = await step(t, 'J3', { s3: 'journal-sent-commit-then-fail' }, null, 'journal "sent" committed, its answer lost');
  check('J3 journal outcome committed but answer lost → 503 unknown (not ordinary success)', r3.status === 503 && r3.j.persistenceUnknown === true, { status: r3.status });
  check('J4 SES never called → pending', (await step(t, 'J4', { ses: 'error-not-sent' }, null, 'journal server; later closed undeterminable')).status === 502, {});
  check('J5 accepted with NO SES event (event missing)', (await step(t, 'J5', { ses: 'no-events' }, null, 'journal server')).status === 200, {});
  for (let i = 0; i < 18; i++) { const o = await j('GET', '/api/messages/outbox/' + `${s.nonce}-J2`, t); if (o.j.events?.some((e) => e.eventType === 'Send')) break; await sleep(5000); }
  const r2 = await step(t, 'J2', null, null, 'retry after its Send event'); check('J2 retry after the Send event: duplicate, not resent', r2.status === 200 && r2.j.duplicate === true, { status: r2.status });
} else if (phase === 'retry-j5') {
  const t = await login(s.key);
  check('J5 accepted with NO SES event (event missing) — retry after a definite AccessDenied rejection', (await step(t, 'J5', { ses: 'no-events' }, null, 'journal server; same id retried after the earlier definite rejection')).status === 200, {});
} else if (phase === 'verify-restored') {
  const t = await login(s.key); const before = {};
  for (const id of ['L1', 'L2', 'L3', 'L4', 'J1', 'J2', 'J3', 'J4', 'J5']) { const o = await j('GET', '/api/messages/outbox/' + `${s.nonce}-${id}`, t); before[id] = o.status === 404 ? null : o.j.state; }
  s.restored_visible_state = before; console.log('restored visible state', JSON.stringify(before));
  const exp = { L1: [200, true], L2: [200, true], L3: [503], L4: [409], J1: [200, true], J2: [200, true], J3: [200, true], J4: [409], J5: [200, true] };
  for (const [id, [st, dup]] of Object.entries(exp)) { const r = await step(t, id, null, null, 'retry on restored data'); check(`${id}: retry on restored data → ${st}${dup ? ' duplicate' : ''}, no SES submission`, r.status === st && (!dup || r.j.duplicate === true), { status: r.status, duplicate: r.j.duplicate, error: r.j.error }); }
  for (const n of [1, 2]) { const r = await step(t, 'J1', null, null, `restored identical retry ${n}`); check(`J1 restored identical retry ${n}`, r.status === 200 && r.j.duplicate === true, { status: r.status }); }
  const m = await step(t, 'J1', null, 'MODIFIED AFTER RESTORE', 'modified body after restore'); check('J1 modified body after restore is refused', m.status === 409, { status: m.status });
  const n1 = await step(t, 'N1', null, null, 'new id while the guard is on'); check('N1 a new id is blocked while the durable guard is on (no env setting)', n1.status === 503, { status: n1.status, error: n1.j.error });
  const n3 = await step(t, 'L3x', null, null, 'L3 content under a NEW id'); check('L3 content under a new id is blocked too (changing the id does not help)', n3.status === 503, { status: n3.status });
  const sent = (await j('GET', '/api/messages/sent', t)).j.emails || [];
  check('Sent history rebuilt for the accepted messages that have a trusted fingerprint (L1 L2 J1 J2 J3 J5)', ['L1', 'L2', 'J1', 'J2', 'J3', 'J5'].every((id) => sent.some((e) => e.id === `${s.nonce}-${id}`)), { ids: sent.map((e) => e.id) });
} else if (phase === 'verify-restored-2') {
  // the same four checks as the end of verify-restored, rerun after the per-wallet rate limit (10/min) window: that run hit 429
  const t = await login(s.key);
  const r = await step(t, 'J1', null, null, 'restored identical retry 2 (rerun)'); check('J1 restored identical retry 2', r.status === 200 && r.j.duplicate === true, { status: r.status });
  const m = await step(t, 'J1', null, 'MODIFIED AFTER RESTORE', 'modified body after restore (rerun)'); check('J1 modified body after restore is refused', m.status === 409, { status: m.status });
  const n1 = await step(t, 'N1', null, null, 'new id while the guard is on (rerun)'); check('N1 a new id is blocked while the durable guard is on (no env setting)', n1.status === 503, { status: n1.status, error: n1.j.error });
  const n3 = await step(t, 'L3x', null, null, 'L3 content under a NEW id (rerun)'); check('L3 content under a new id is blocked too (changing the id does not help)', n3.status === 503, { status: n3.status });
} else if (phase === 'verify-after-guard-off') {
  const t = await login(s.key);
  const n2 = await step(t, 'N2', null, null, 'new id after the recorded guard-off'); check('N2 after a recorded guard-off a new id sends once', n2.status === 200 && !n2.j.duplicate, { status: n2.status });
  for (const id of ['J1', 'J4', 'L4']) { const r = await step(t, id, null, null, 'retry after guard-off'); check(`${id} still not resent after guard-off`, (r.status === 200 && r.j.duplicate === true) || r.status === 409, { status: r.status }); }
}
store(s);
if (outFile) { const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { runs: [] }; out.runs.push({ phase, at: new Date().toISOString(), passed: checks.filter((c) => c.passed).length, failed: checks.filter((c) => !c.passed).length, checks }); fs.writeFileSync(outFile, JSON.stringify(out, null, 1)); }
console.log(`SUMMARY ${phase} passed=${checks.filter((c) => c.passed).length} failed=${checks.filter((c) => !c.passed).length}`);
