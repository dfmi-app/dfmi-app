// Acceptance E — wallet-mail capacity, client side (runs on the separate capacity client host, through nginx + TLS).
//   node mail-capacity.mjs <phase> <state.json> <base-url> <out.json>
//   phases: setup | session | send-sustained | send-burst | warm | cold-round | attachment
// Latency is measured from request start to the complete response body (client side). Raw samples are kept.
// Production rate limits stay on (10 sends / min / wallet): the sustained run rotates 100 wallets (3 sends / min each).
import fs from 'node:fs'; import crypto from 'node:crypto'; import { createRequire } from 'node:module';
const require = createRequire('/opt/wm/'); const { ethers } = require('ethers');
const [PHASE, STATE, BASE, OUT] = process.argv.slice(2);
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => { fs.writeFileSync(STATE, JSON.stringify(st)); fs.chmodSync(STATE, 0o600); };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(m, u, tok, body, timeout = 120e3) {
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ms: performance.now() - t0, buf, retryAfter: r.headers.get('retry-after'), t: new Date().toISOString() };
  } catch (e) { return { status: 0, ms: performance.now() - t0, err: String(e.name || e.message), buf: Buffer.alloc(0), t: new Date().toISOString() }; }
}
const json = (x) => { try { return JSON.parse(x.buf.toString()); } catch { return {}; } };
async function login(key) { const w = new ethers.Wallet(key); const c = json(await call('POST', '/api/auth/challenge', null, { wallet: w.address }));
  const v = json(await call('POST', '/api/auth/verify', null, { challengeId: c.challengeId, signature: await w.signMessage(c.message) })); if (!v.token) throw new Error('login failed ' + JSON.stringify(v)); return v.token; }
const summary = (lat, extra = {}) => ({ n: lat.length, p50_ms: pct(lat, 50), p95_ms: pct(lat, 95), p99_ms: pct(lat, 99), max_ms: lat.length ? Math.round(Math.max(...lat)) : null, ...extra });
const record = (res) => { const o = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { runs: [] }; o.runs.push(res); fs.writeFileSync(OUT, JSON.stringify(o, null, 1)); console.log(JSON.stringify({ ...res, samples: undefined })); };
const res = { phase: PHASE, started_utc: new Date().toISOString(), base: BASE };

if (PHASE === 'setup') {
  const mk = () => ethers.Wallet.createRandom();
  const w = { w300: mk(), w1000: mk(), watt: mk(), senders: Array.from({ length: 100 }, mk) };
  st.nonce = 'cap' + Date.now().toString(36);
  st.keys = { w300: w.w300.privateKey, w1000: w.w1000.privateKey, watt: w.watt.privateKey, senders: w.senders.map((x) => x.privateKey) };
  st.addresses = { w300: w.w300.address.toLowerCase(), w1000: w.w1000.address.toLowerCase(), watt: w.watt.address.toLowerCase() };
  fs.writeFileSync('addresses.json', JSON.stringify(st.addresses)); save(); res.addresses = st.addresses;
} else if (PHASE === 'login') {
  st.tok = { w300: await login(st.keys.w300), w1000: await login(st.keys.w1000), watt: await login(st.keys.watt), senders: [] };
  for (const k of st.keys.senders) st.tok.senders.push(await login(k)); save(); res.logged_in = 3 + st.tok.senders.length;
} else if (PHASE === 'session') {
  // up to 50 requests in flight for DURATION_S (default 300 s)
  const D = (+process.env.DURATION_S || 300) * 1000; const lat = []; const codes = {}; const end = performance.now() + D;
  await Promise.all(Array.from({ length: 50 }, async (_, i) => { while (performance.now() < end) { const x = await call('GET', '/api/session', st.tok.senders[i % 100]); lat.push(x.ms); codes[x.status] = (codes[x.status] || 0) + 1; } }));
  res.result = summary(lat, { duration_s: D / 1000, rps: Math.round(lat.length / (D / 1000)), status_counts: codes, unexpected_5xx: Object.entries(codes).filter(([c]) => c >= 500 || c === '0').reduce((a, [, n]) => a + n, 0) });
  res.targets = { p95_ms: 250, p99_ms: 500, unexpected_5xx: 0 };
  res.pass = res.result.p95_ms <= 250 && res.result.p99_ms <= 500 && res.result.unexpected_5xx === 0;
} else if (PHASE === 'send-sustained') {
  // open loop: one send every 200 ms (5 / s) for DURATION_S (default 300 s = 1,500 sends), wallets rotate over 100
  const D = (+process.env.DURATION_S || 300); const total = D * 5; const tasks = []; const t0 = performance.now(); const rows = [];
  for (let n = 0; n < total; n++) {
    const due = t0 + n * 200; const wait = due - performance.now(); if (wait > 0) await sleep(wait);
    const id = `${st.nonce}-s-${n}`; const tok = st.tok.senders[n % 100];
    tasks.push((async () => { let x = await call('POST', '/api/messages/send-external', tok, { messageId: id, recipientEmail: 'success@simulator.amazonses.com', subject: `capacity ${id}`, body: `Capacity sustained send ${n}.` }); const first = x; let tries = 1;
      // a rate-limited or retryable answer is not a success: retry the SAME request, honouring Retry-After, until done
      const tStart = performance.now() - x.ms; while ((x.status === 429 || (x.status === 503 && json(x).retryable)) && tries < 20) { await sleep(1000 * (+x.retryAfter || 5)); x = await call('POST', '/api/messages/send-external', tok, { messageId: id, recipientEmail: 'success@simulator.amazonses.com', subject: `capacity ${id}`, body: `Capacity sustained send ${n}.` }); tries++; }
      rows.push({ id, n, first_status: first.status, first_ms: Math.round(first.ms), final_status: x.status, final_done_ms: Math.round(performance.now() - tStart), tries, sesMessageId: json(x).sesMessageId || null, duplicate: json(x).duplicate === true, t: first.t }); })());
  }
  await Promise.all(tasks); rows.sort((a, b) => a.n - b.n);
  const lat = rows.map((r) => r.first_ms); const codes = {}; for (const r of rows) codes[r.first_status] = (codes[r.first_status] || 0) + 1;
  res.result = summary(lat, { sends: rows.length, completed_200: rows.filter((r) => r.final_status === 200).length, first_status_counts: codes, rate_limited_429: rows.filter((r) => r.first_status === 429).length,
    unexpected_5xx: rows.filter((r) => r.first_status >= 500 || r.first_status === 0).length, final_done_p95_ms: pct(rows.map((r) => r.final_done_ms), 95), wall_s: Math.round((performance.now() - t0) / 1000), distinct_ses_ids: new Set(rows.map((r) => r.sesMessageId).filter(Boolean)).size });
  res.ids = rows.map((r) => ({ id: r.id, b64: Buffer.from(r.id).toString('base64url'), sesMessageId: r.sesMessageId }));
  res.samples = rows; res.targets = { p95_ms: 1000, p99_ms: 3000, all_complete: true, one_submission_per_id: 'checked against the server SES log (verify phase)' };
  res.pass_client_side = res.result.p95_ms <= 1000 && res.result.p99_ms <= 3000 && res.result.completed_200 === total && res.result.unexpected_5xx === 0;
} else if (PHASE === 'send-burst') {
  const t0 = performance.now(); const rows = await Promise.all(st.tok.senders.map(async (tok, i) => { const id = `${st.nonce}-b-${i}`; const b = { messageId: id, recipientEmail: 'success@simulator.amazonses.com', subject: `burst ${id}`, body: `Capacity burst ${i}.` };
    let x = await call('POST', '/api/messages/send-external', tok, b); const first = x.status; let tries = 1;
    while ((x.status === 429 || (x.status === 503 && json(x).retryable)) && tries < 20 && performance.now() - t0 < 60e3) { await sleep(1000 * (+x.retryAfter || 5)); x = await call('POST', '/api/messages/send-external', tok, b); tries++; }
    return { id, first_status: first, final_status: x.status, done_ms: Math.round(performance.now() - t0), tries, sesMessageId: json(x).sesMessageId || null, duplicate: json(x).duplicate === true }; }));
  res.result = { sends: rows.length, completed_200: rows.filter((r) => r.final_status === 200).length, all_done_ms: Math.max(...rows.map((r) => r.done_ms)), p95_ms: pct(rows.map((r) => r.done_ms), 95), first_status_counts: rows.reduce((a, r) => ((a[r.first_status] = (a[r.first_status] || 0) + 1), a), {}) };
  res.ids = rows.map((r) => ({ id: r.id, b64: Buffer.from(r.id).toString('base64url'), sesMessageId: r.sesMessageId })); res.samples = rows;
  res.targets = { all_complete_within_ms: 60000, duplicates: 0 }; res.pass_client_side = res.result.completed_200 === 100 && res.result.all_done_ms <= 60000;
} else if (PHASE === 'warm' || PHASE === 'cold-round') {
  // warm: per wallet one untimed warm-up load, then >= 200 timed loads at 10 concurrent; cold-round: the server was just
  // restarted (application cache empty) by the orchestrator; 10 concurrent loads per wallet, timed
  const out = {};
  // ONLY=w300|w1000 limits the round to one wallet (the cold run restarts the server before each wallet's round)
  for (const [name, expect] of [['w300', 300], ['w1000', 1000]].filter(([n]) => !process.env.ONLY || process.env.ONLY === n)) {
    if (PHASE === 'warm') await call('GET', '/api/messages/inbox', st.tok[name], null, 300e3);
    const N = PHASE === 'warm' ? 200 : 10; let next = 0; const rows = [];
    await Promise.all(Array.from({ length: 10 }, async () => { while (next < N) { next++; const x = await call('GET', '/api/messages/inbox', st.tok[name], null, 300e3); rows.push({ status: x.status, ms: Math.round(x.ms), count: json(x).count ?? null, t: x.t }); } }));
    out[name] = summary(rows.map((r) => r.ms), { expected_messages: expect, ok: rows.filter((r) => r.status === 200 && r.count === expect).length, wrong: rows.filter((r) => !(r.status === 200 && r.count === expect)).map((r) => [r.status, r.count]), samples: rows });
  }
  res.result = out; res.targets = PHASE === 'warm' ? { w300_p95_ms: 3000, w1000_p95_ms: 6000 } : { w300_p95_ms: 10000, w1000_p95_ms: 20000, note: 'p95 over all 20 rounds is computed by the orchestrator' };
} else if (PHASE === 'attachment') {
  // 10 different 10 MiB attachments at once; a 503 must carry a valid Retry-After and the same download is retried
  const exp = JSON.parse(fs.readFileSync(process.env.SEED_RESULT || 'seed-result.json', 'utf8')).attachment_sha256; const t0 = performance.now();
  const rows = await Promise.all(Array.from({ length: 10 }, async (_, i) => { const u = `/api/messages/att-${i}/attachments/0`; const tries = [];
    let x = await call('GET', u, st.tok.watt, null, 120e3); tries.push({ status: x.status, ms: Math.round(x.ms), retryAfter: x.retryAfter });
    while (x.status === 503 && performance.now() - t0 < 60e3) { if (!/^[1-9][0-9]*$/.test(String(x.retryAfter))) break; await sleep(1000 * +x.retryAfter); x = await call('GET', u, st.tok.watt, null, 120e3); tries.push({ status: x.status, ms: Math.round(x.ms), retryAfter: x.retryAfter }); }
    const h = x.status === 200 ? crypto.createHash('sha256').update(x.buf).digest('hex') : null;
    return { i, final_status: x.status, bytes: x.buf.length, sha256_ok: h === exp[`att-${i}`], done_ms: Math.round(performance.now() - t0), tries }; }));
  res.result = { ok: rows.filter((r) => r.final_status === 200 && r.sha256_ok).length, first_try_503: rows.filter((r) => r.tries[0].status === 503).length, retry_after_values: [...new Set(rows.flatMap((r) => r.tries.map((t) => t.retryAfter)).filter(Boolean))], all_done_ms: Math.max(...rows.map((r) => r.done_ms)), rows };
  res.targets = { all_ok_within_ms: 60000, hashes_match: true, all_rejected_is_fail: true }; res.pass = res.result.ok === 10 && res.result.all_done_ms <= 60000;
}
res.ended_utc = new Date().toISOString(); record(res);
