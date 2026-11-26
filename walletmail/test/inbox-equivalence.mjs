// The inbox cache + parallel reads (2026-11-26) must not change what anyone sees. Same store, old and new server:
// every user's inbox must be byte-identical; then (new server only) cached answers must equal fresh ones, an
// overwritten message must show its new content, and a tiny cache (forced eviction) must give the same answers.
//   node inbox-equivalence.mjs <old-server.js> <new-server.js>
import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net'; import { spawn } from 'node:child_process'; import { once } from 'node:events';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const { ethers } = createRequire(import.meta.url)('ethers');
const [OLD, NEW] = process.argv.slice(2).map((p) => path.resolve(p)); const D = 'dfmi.test';
let fail = 0; const ok = (m, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c ? '' : '  ' + x)); if (!c) fail++; };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const users = Array.from({ length: 4 }, () => ethers.Wallet.createRandom()); const A = users.map((u) => `${u.address.toLowerCase()}@${D}`);
const m = (h, body = 'hello') => Buffer.from(Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\nContent-Type: text/plain\r\n\r\n' + body + '\r\n').toString('base64');
const att = (to) => Buffer.from(`From: x@example.org\r\nTo: ${to}\r\nSubject: with file\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=q\r\n\r\n--q\r\nContent-Type: text/plain\r\n\r\nbody\r\n--q\r\nContent-Type: application/pdf; name=a.pdf\r\nContent-Disposition: attachment; filename=a.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('%PDF-1.4 test').toString('base64')}\r\n--q--\r\n`).toString('base64');
const seed = {};
for (let i = 0; i < 260; i++) {           // > 2 listing pages of raw/
  const to = A[i % 5] || `other${i}@${D}`; const d = new Date(Date.UTC(2026, 10, 1) + i * 3600e3).toUTCString();
  seed[`raw/r${String(i).padStart(4, '0')}`] = i % 37 === 0 ? Buffer.from('not a mail at all \x00\x01').toString('base64')
    : m({ From: `s${i}@example.org`, To: to, ...(i % 7 === 0 ? { Cc: A[(i + 1) % 4] } : {}), Subject: `msg ${i}`, Date: d, ...(i % 11 === 0 ? { 'X-WalletMail-Id': `wm-${i % 3}` } : {}) }, `body ${i}`);
}
seed['raw/spoof'] = m({ From: A[0], To: A[0], Subject: 'from myself' });                       // sent by the owner: not in Inbox
seed['raw/AMAZON_SES_SETUP_NOTIFICATION'] = m({ From: 'aws@example.org', To: A[0], Subject: 'setup' });
seed['raw/att'] = att(A[1]);
seed[`incoming/${users[2].address.toLowerCase()}/in1`] = m({ From: 'z@example.org', To: A[2], Subject: 'incoming' });
seed[`state/${users[1].address.toLowerCase()}/deleted/r0005`] = Buffer.from('1').toString('base64');
seed[`state/${users[1].address.toLowerCase()}/read/r0009`] = Buffer.from('1').toString('base64');
for (let i = 0; i < 120; i++) seed[`content/c${i}.json`] = Buffer.from(JSON.stringify({ messageId: `c${i}`, subject: `internal ${i}`, body: 'b', recipientValue: i % 3 === 0 ? users[3].address.toLowerCase() : `x${i}`, sender: users[i % 2].address.toLowerCase(), storedAt: 1764000000000 + i })).toString('base64');

async function server(file, extra = {}) {
  const dir = fs.mkdtempSync(path.join(HERE, 'equiv-')); fs.copyFileSync(file, path.join(dir, 'server.js')); fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}'); fs.writeFileSync(path.join(dir, 'seed.json'), JSON.stringify(seed));
  const port = await freePort(), sport = await freePort();
  const p = spawn(process.execPath, ['-r', path.join(HERE, 'capacity-store.cjs'), path.join(dir, 'server.js')], { cwd: dir, stdio: 'ignore', env: { ...process.env, PORT: String(port), CAP_SEED: path.join(dir, 'seed.json'), CAP_SEED_AT: String(Date.UTC(2026, 10, 25)), CAP_STATS_PORT: String(sport),
    AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x', S3_INCOMING_BUCKET: 'eq', EMAIL_DOMAIN: D, DFMI_RPC: 'http://127.0.0.1:9', ENS_REGISTRY: '', ENS_RESOLVER: '', ENS_BOOTSTRAP_NAMES: '', ...extra } });
  const B = `http://127.0.0.1:${port}`; for (let i = 0; i < 200; i++) { try { if ((await fetch(B + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 50)); }
  const j = async (mth, u, t, b) => (await fetch(B + u, { method: mth, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) })).json();
  const toks = []; for (const w of users) { const c = await j('POST', '/api/auth/challenge', null, { wallet: w.address }); toks.push((await j('POST', '/api/auth/verify', null, { challengeId: c.challengeId, signature: await w.signMessage(c.message) })).token); }
  return { inbox: async (i) => JSON.stringify(await j('GET', '/api/messages/inbox', toks[i])), put: (k, b64) => fetch(`http://127.0.0.1:${sport}/${encodeURIComponent(k)}`, { method: 'PUT', body: Buffer.from(b64, 'base64') }),
    stop: async () => { const d = once(p, 'exit'); p.kill(); await d; fs.rmSync(dir, { recursive: true, force: true }); } };
}
const o = await server(OLD), n = await server(NEW), tiny = await server(NEW, { MAIL_CACHE_BYTES: '6000' });
try {
  for (let i = 0; i < 4; i++) {
    const a = await o.inbox(i), b = await n.inbox(i), c = await n.inbox(i), t1 = await tiny.inbox(i), t2 = await tiny.inbox(i);
    ok(`user ${i}: new server's inbox is identical to the old server's (${JSON.parse(a).count} messages, ${a.length} bytes)`, a === b, `${a.length} vs ${b.length}`);
    ok(`user ${i}: the cached second answer is identical`, b === c);
    ok(`user ${i}: with a tiny cache (constant eviction) the answers are identical`, a === t1 && a === t2);
  }
  const k = 'raw/r0004', changed = m({ From: 's4@example.org', To: A[4 % 5] || A[0], Subject: 'msg 4 CHANGED', Date: new Date(Date.UTC(2026, 10, 1)).toUTCString() }, 'body 4 changed and longer');
  for (const s of [o, n]) await s.put(k, changed);
  const norm = (x) => x.replace(/"receivedAt":\d+/g, '"receivedAt":0').replace(/"timestamp":\d+(?=,"sentAt":null)/g, '"timestamp":0'); // the overwrite time differs by milliseconds between the two stores
  const a = norm(await o.inbox(0)), b = norm(await n.inbox(0));
  ok('an overwritten object: the new server shows the new content, same as the old server', a === b && b.includes('msg 4 CHANGED'), `same=${a === b} oldHas=${a.includes('CHANGED')} newHas=${b.includes('CHANGED')}`);
  await n.put('raw/r0010', m({ From: 'q@example.org', To: A[3], Subject: 'moved to user 3' }));   // was addressed to user 0
  const u0 = JSON.parse(await n.inbox(0)), u3 = JSON.parse(await n.inbox(3));
  ok('a message re-addressed by an overwrite leaves the old recipient and reaches the new one', !u0.emails.some((e) => e.id === 'r0010') && u3.emails.some((e) => e.id === 'r0010'));
} finally { await o.stop(); await n.stop(); await tiny.stop(); }
console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
