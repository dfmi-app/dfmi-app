// Wallet-mail capacity test (2026-11-26). Isolated: the server runs on 127.0.0.1 against an in-memory object store with
// injected S3 latency (capacity-store.cjs); SES is a stub. Nothing touches production.
//   node capacity.mjs <server.js> <out.json> [N,N,...]       (N = number of raw/ messages in the store; default 35,300,1000,3000)
// Latency defaults (ms): GET 20, LIST 40, PUT 30. Override with CAP_LAT_GET / CAP_LAT_LIST / CAP_LAT_PUT.
import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net'; import { spawn } from 'node:child_process'; import { once } from 'node:events';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const { ethers } = createRequire(import.meta.url)('ethers');
const [SERVER_IN, OUT = 'capacity.json', NS = '35,300,1000,3000'] = process.argv.slice(2);
const LAT = { CAP_LAT_GET: process.env.CAP_LAT_GET || '20', CAP_LAT_LIST: process.env.CAP_LAT_LIST || '40', CAP_LAT_PUT: process.env.CAP_LAT_PUT || '30' };
const DOMAIN = 'dfmi.test';
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]) : null; };
const mime = (to, i, size) => Buffer.from(`From: Sender ${i} <sender${i}@example.org>\r\nTo: ${to}\r\nSubject: capacity message ${i}\r\nDate: ${new Date(Date.now() - i * 60e3).toUTCString()}\r\nMessage-ID: <cap-${i}@example.org>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${'lorem ipsum dolor sit amet '.repeat(Math.ceil(size / 27)).slice(0, size)}\r\n`);
function attachmentMime(to, mb) {
  const b64 = Buffer.alloc(mb * 1024 * 1024, 7).toString('base64').replace(/.{76}/g, '$&\r\n');
  return Buffer.from(`From: a@example.org\r\nTo: ${to}\r\nSubject: big attachment\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nsee attached\r\n--b\r\nContent-Type: application/octet-stream; name=big.bin\r\nContent-Disposition: attachment; filename=big.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n--b--\r\n`);
}

async function scenario(N) {
  const dir = fs.mkdtempSync(path.join(HERE, 'capacity-')); fs.copyFileSync(SERVER_IN, path.join(dir, 'server.js')); fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
  const users = Array.from({ length: 20 }, () => ethers.Wallet.createRandom()); const U = users[0].address.toLowerCase();
  // N raw messages, 5.3 KB each (the production median); 1 in 10 is addressed to user 0, the rest to other addresses
  const seed = {}; for (let i = 0; i < N; i++) seed[`raw/cap${String(i).padStart(6, '0')}`] = mime(i % 10 === 0 ? `${U}@${DOMAIN}` : `someone${i}@${DOMAIN}`, i, 5300).toString('base64');
  seed[`incoming/${U}/big-attachment`] = attachmentMime(`${U}@${DOMAIN}`, 10).toString('base64');
  fs.writeFileSync(path.join(dir, 'seed.json'), JSON.stringify(seed));
  const port = await freePort(), sport = await freePort(); const BASE = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['--max-old-space-size=1024', '-r', path.join(HERE, 'capacity-store.cjs'), path.join(dir, 'server.js')], { cwd: dir, stdio: 'ignore',
    env: { ...process.env, ...LAT, PORT: String(port), CAP_SEED: path.join(dir, 'seed.json'), CAP_STATS_PORT: String(sport), AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x',
      S3_INCOMING_BUCKET: 'cap', EMAIL_DOMAIN: DOMAIN, DFMI_RPC: 'http://127.0.0.1:9', ENS_REGISTRY: '', ENS_RESOLVER: '', ENS_BOOTSTRAP_NAMES: '' } });
  const stats = async (reset) => (await fetch(`http://127.0.0.1:${sport}/${reset ? 'reset' : ''}`)).json();
  for (let i = 0; i < 200; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 50)); }
  const call = async (m, u, t, b) => { const t0 = performance.now(); const r = await fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}), signal: AbortSignal.timeout(600e3) }); const buf = Buffer.from(await r.arrayBuffer()); return { status: r.status, ms: performance.now() - t0, bytes: buf.length, buf }; };
  const login = async (w) => { const c = JSON.parse((await call('POST', '/api/auth/challenge', null, { wallet: w.address })).buf); return JSON.parse((await call('POST', '/api/auth/verify', null, { challengeId: c.challengeId, signature: await w.signMessage(c.message) })).buf).token; };
  const toks = []; for (const w of users) toks.push(await login(w));
  const res = { N, latency_ms: LAT };
  // 1. one inbox load, user 0 (sees N/10 + 1 messages)
  await stats(true); let r = await call('GET', '/api/messages/inbox', toks[0]); let s = await stats();
  res.inbox_single = { status: r.status, ms: Math.round(r.ms), messages_returned: (JSON.parse(r.buf).emails || []).length, response_kb: Math.round(r.bytes / 1024), s3_get: s.GetObjectCommand, s3_list: s.ListObjectsV2Command };
  // 2. 10 users open their inbox at the same moment
  await stats(true); let t0 = performance.now(); const conc = await Promise.all(toks.slice(0, 10).map((t) => call('GET', '/api/messages/inbox', t))); s = await stats();
  res.inbox_10_concurrent = { ok: conc.filter((x) => x.status === 200).length, wall_ms: Math.round(performance.now() - t0), p50_ms: pct(conc.map((x) => x.ms), 50), max_ms: pct(conc.map((x) => x.ms), 100), s3_get: s.GetObjectCommand, rss_mb_after: Math.round(s.rss / 1048576) };
  // 3. authenticated cheap request (session check: 2 S3 GETs), 50 in flight for 5 s
  { const lat = []; let n = 0, bad = 0; const end = performance.now() + 5000; t0 = performance.now();
    await Promise.all(Array.from({ length: 50 }, async (_, i) => { while (performance.now() < end) { const x = await call('GET', '/api/session', toks[i % 20]); lat.push(x.ms); n++; if (x.status !== 200) bad++; } }));
    res.session_check_50_inflight = { requests: n, errors: bad, rps: Math.round(n / ((performance.now() - t0) / 1000)), p50_ms: pct(lat, 50), p99_ms: pct(lat, 99) }; }
  // 4. outbound send: 20 wallets x 5 messages, all at once (100 sends; the server allows 10/min per wallet)
  { await stats(true); t0 = performance.now(); const sends = await Promise.all(toks.flatMap((t, i) => Array.from({ length: 5 }, (_, j) => call('POST', '/api/messages/send-external', t, { messageId: `cap-${i}-${j}`, recipientEmail: 'x@example.org', subject: 's', body: 'b' }))));
    s = await stats(); res.send_100_concurrent = { ok: sends.filter((x) => x.status === 200).length, wall_ms: Math.round(performance.now() - t0), p50_ms: pct(sends.map((x) => x.ms), 50), p99_ms: pct(sends.map((x) => x.ms), 99), ses_calls: s.SES }; }
  // 5. 10 concurrent downloads of a 10 MB attachment
  { const before = (await stats()).rss; t0 = performance.now(); const d = await Promise.all(Array.from({ length: 10 }, () => call('GET', `/api/messages/big-attachment/attachments/0`, toks[0]))); const after = (await stats()).rss;
    res.attachment_10x10MB = { ok: d.filter((x) => x.status === 200 && x.bytes === 10 * 1048576).length, wall_ms: Math.round(performance.now() - t0), rss_mb_before: Math.round(before / 1048576), rss_mb_after: Math.round(after / 1048576) }; }
  res.server_alive = (await fetch(BASE + '/api/health').catch(() => ({ ok: false }))).ok;
  const d = once(proc, 'exit'); proc.kill(); await d; fs.rmSync(dir, { recursive: true, force: true });
  return res;
}
const out = { at: new Date().toISOString(), node: process.version, server_sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(SERVER_IN)).digest('hex'), runs: [] };
for (const N of NS.split(',').map(Number)) { const r = await scenario(N); out.runs.push(r); console.log(JSON.stringify(r)); fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); }
