// Inbox recipient pre-filter (2026-11-27): the new server first reads only the first 64 KiB of each raw/ incoming/ object
// (ranged GET) and fully parses a message only when its To/Cc text may contain one of the caller's addresses (or the
// header is "unsafe": encoded words, punycode, quotes, comments, backslashes, or no complete header block in 64 KiB).
// It must never change what anyone sees. Same store, old server (full parse of everything) vs new server, for hostile
// and unusual addressing: Cc only, folded To (CRLF and LF), mixed case, encoded-word display names, punycode, quoted
// local part, quoted display name with a comma, comments, groups, no space after the colon, headers larger than 64 KiB
// (To before and after the padding), raw 8-bit names, duplicate To, empty object, header-only object, Bcc / Resent-To
// only, substring look-alikes, sent-by-owner, and non-matching mail. Every user's inbox must be byte-identical.
// Run twice for the new server: with the stub honouring Range like S3, and with Range ignored (whole object returned).
//   node inbox-prefilter.mjs <old-server.js> <new-server.js>
import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net'; import { spawn } from 'node:child_process'; import { once } from 'node:events';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const { ethers } = createRequire(import.meta.url)('ethers');
const [OLD, NEW] = process.argv.slice(2).map((p) => path.resolve(p)); const D = 'dfmi.test';
let fail = 0; const ok = (m, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + m + (c ? '' : '  ' + x)); if (!c) fail++; };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const users = Array.from({ length: 4 }, () => ethers.Wallet.createRandom());
const W = users.map((u) => u.address.toLowerCase()), A = W.map((w) => `${w}@${D}`);
const CK = users.map((u) => `${u.address}@${D.toUpperCase()}`);          // checksummed (mixed-case) hex, upper-case domain
const date = 'Tue, 25 Nov 2026 10:00:00 +0000';
const mail = (headers, body = 'hello', eol = '\r\n') => Buffer.from(headers.join(eol) + eol + 'Content-Type: text/plain' + eol + eol + body + eol, 'latin1');
const std = (i, ...h) => [`From: sender${i}@example.org`, ...h, `Subject: case ${i}`, `Date: ${date}`];
const pad = (n) => 'X-Pad: ' + Array.from({ length: Math.ceil(n / 70) }, () => 'p'.repeat(68)).join('\r\n\t');   // folded, n bytes
const cases = {   // key → raw message bytes. Most are for user 0; a few for users 1–3 and for nobody.
  cc: mail(std(1, 'To: someone@example.org', `Cc: ${A[0]}`)),
  'cc-list': mail(std(2, 'To: a@example.org', `Cc: b@example.org, ${A[0]}, c@example.org`)),
  fold: mail(std(3, `To: someone@example.org,\r\n\t${A[0]}`)),
  'fold-lf': mail(std(4, `To: someone@example.org,\n ${A[0]}`), 'lf body', '\n'),
  'fold-mid': mail(std(5, `To: "Owner"\r\n <${A[0]}>`)),
  case: mail(std(6, `To: ${CK[0]}`)),
  'case-name': mail(std(7, `TO: Owner <${CK[0]}>`)),
  'enc-name': mail(std(8, `To: =?UTF-8?B?${Buffer.from('Владелец').toString('base64')}?= <${A[0]}>`)),
  'enc-name-q': mail(std(9, `To: =?ISO-8859-1?Q?J=F6rg?= <${A[0]}>, other@example.org`)),
  'enc-addr': mail(std(10, `To: =?UTF-8?Q?${A[0].replace('@', '=40')}?=`)),
  puny: mail(std(11, `To: friend@xn--bcher-kva.example, ${A[0]}`)),
  'puny-only': mail(std(12, 'To: friend@xn--bcher-kva.example')),
  'quoted-local': mail(std(13, `To: "${W[0]}"@${D}`)),
  'quoted-name': mail(std(14, `To: "Doe, John" <${A[0]}>`)),
  'quoted-escape': mail(std(15, `To: "a \\"b\\" c" <${A[0]}>`)),
  comment: mail(std(16, `To: ${A[0]} (wallet owner)`)),
  'comment-in': mail(std(17, `To: (hi) ${W[0]}@(there)${D}`)),
  group: mail(std(18, `To: team: ${A[0]}, x@example.org;`)),
  'group-empty': mail(std(19, 'To: undisclosed-recipients:;')),
  nospace: mail(std(20, `To:${A[0]}`)),
  'space-colon': mail(std(21, `To : ${A[0]}`)),
  'big-before': mail([pad(70000), ...std(22, `To: ${A[0]}`)]),
  'big-after': mail([...std(23, `To: ${A[0]}`), pad(70000)]),
  'big-other': mail([pad(70000), ...std(24, 'To: nobody@example.org')]),
  'big-cc-late': mail([...std(25, 'To: nobody@example.org'), pad(66000), `Cc: ${A[0]}`]),
  '8bit-name': mail(std(26, `To: Jörg Müller <${A[0]}>`)),
  'dup-to': mail(std(27, 'To: first@example.org', `To: ${A[0]}`)),
  empty: Buffer.alloc(0),
  'header-only': Buffer.from(`From: h@example.org\r\nTo: ${A[0]}\r\nSubject: header only`),
  'no-blank-line': Buffer.from(`To: ${A[0]}\r\nSubject: x\r\nbody without a blank line`),
  bcc: mail(std(28, 'To: nobody@example.org', `Bcc: ${A[0]}`)),
  resent: mail(std(29, 'To: nobody@example.org', `Resent-To: ${A[0]}`)),
  'delivered-to': mail(std(30, `Delivered-To: ${A[0]}`, 'To: nobody@example.org')),
  'substr-before': mail(std(31, `To: z${A[0]}`)),
  'substr-after': mail(std(32, `To: ${A[0]}.evil.example`)),
  'bare-wallet': mail(std(33, `To: ${W[0]}`)),
  'self-sent': mail([`From: ${A[0]}`, `To: ${A[0]}`, 'Subject: from myself', `Date: ${date}`]),
  nonmatch: mail(std(34, 'To: nobody@example.org')),
  'not-mime': Buffer.from('not a mail at all \x00\x01'),
  'user1-fold-cc': mail(std(35, 'To: x@example.org', `Cc: y@example.org,\r\n  ${CK[1]}`)),
  'user2-enc': mail(std(36, `To: =?UTF-8?B?${Buffer.from('Ünïcode').toString('base64')}?= <${A[2]}>`)),
  'user3-two': mail(std(37, `To: ${A[3]}`, `Cc: ${A[0]}`)),
  'crlf-lf-mix': Buffer.from(`From: m@example.org\nTo: nobody@example.org\r\n\r\nX: y\nCc: ${A[0]}\n\nbody\n`),
  'lf-then-crlf': Buffer.from(`From: m@example.org\nCc: ${A[0]}\n\nTo: nobody@example.org\r\n\r\nbody\r\n`),
};
const seed = {};
for (const [k, b] of Object.entries(cases)) seed[`raw/p-${k}`] = b.toString('base64');
seed[`incoming/${W[1]}/in-fold`] = mail(std(40, `To: other@example.org,\r\n ${CK[1]}`)).toString('base64');
seed[`incoming/${W[1]}/in-big`] = mail([pad(70000), ...std(41, `To: ${A[1]}`)]).toString('base64');
seed[`incoming/${W[1]}/in-other`] = mail(std(42, 'To: nobody@example.org')).toString('base64');
for (let i = 0; i < 40; i++) seed[`raw/filler-${i}`] = mail(std(100 + i, `To: filler${i}@${D}`)).toString('base64');   // not for anyone here

async function server(file, extra = {}) {
  const dir = fs.mkdtempSync(path.join(HERE, 'prefilter-')); fs.copyFileSync(file, path.join(dir, 'server.js')); fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}'); fs.writeFileSync(path.join(dir, 'seed.json'), JSON.stringify(seed));
  const port = await freePort(), sport = await freePort();
  const p = spawn(process.execPath, ['-r', path.join(HERE, 'capacity-store.cjs'), path.join(dir, 'server.js')], { cwd: dir, stdio: 'ignore', env: { ...process.env, PORT: String(port), CAP_SEED: path.join(dir, 'seed.json'), CAP_SEED_AT: String(Date.UTC(2026, 10, 25)), CAP_STATS_PORT: String(sport),
    AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x', S3_INCOMING_BUCKET: 'pf', EMAIL_DOMAIN: D, DFMI_RPC: 'http://127.0.0.1:9', ENS_REGISTRY: '', ENS_RESOLVER: '', ENS_BOOTSTRAP_NAMES: '', ...extra } });
  const B = `http://127.0.0.1:${port}`; for (let i = 0; i < 200; i++) { try { if ((await fetch(B + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 50)); }
  const j = async (mth, u, t, b) => (await fetch(B + u, { method: mth, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) })).json();
  const toks = []; for (const w of users) { const c = await j('POST', '/api/auth/challenge', null, { wallet: w.address }); toks.push((await j('POST', '/api/auth/verify', null, { challengeId: c.challengeId, signature: await w.signMessage(c.message) })).token); }
  const stats = async (reset) => JSON.parse(await (await fetch(`http://127.0.0.1:${sport}/${reset ? 'reset' : 'stats'}`)).text());
  return { inbox: async (i) => JSON.stringify(await j('GET', '/api/messages/inbox', toks[i])), stats,
    stop: async () => { const d = once(p, 'exit'); p.kill(); await d; fs.rmSync(dir, { recursive: true, force: true }); } };
}
const o = await server(OLD), n = await server(NEW), nf = await server(NEW, { CAP_RANGE: '0' });
try {
  const counts = [];
  for (let i = 0; i < 4; i++) {
    await n.stats(true);
    const a = await o.inbox(i), b = await n.inbox(i), c = await nf.inbox(i), b2 = await n.inbox(i);
    const ids = JSON.parse(a).emails.map((e) => e.id).sort(); counts.push(ids.length);
    ok(`user ${i}: new server (ranged pre-filter) gives the old server's inbox exactly (${ids.length} messages: ${ids.join(' ')})`, a === b, `${a.length} vs ${b.length}: old ${ids.join(',')} new ${JSON.parse(b).emails.map((e) => e.id).sort().join(',')}`);
    ok(`user ${i}: new server with Range ignored by the store gives the same inbox`, a === c, `${a.length} vs ${c.length}`);
    ok(`user ${i}: a second (cached) answer is identical`, a === b2);
  }
  // the test must exercise the pre-filter: ranged reads happen, and fewer messages are fully read than exist
  await n.stats(true); await n.inbox(3).catch(() => {}); await nf.stats(true);
  const fresh = await server(NEW); await fresh.stats(true); await fresh.inbox(0); const st = await fresh.stats(false); await fresh.stop();
  const total = Object.keys(seed).filter((k) => k.startsWith('raw/')).length;
  ok(`the pre-filter ran: ${st.RangeGet || 0} ranged reads, ${st.FullGet || 0} full reads for ${total} raw/ objects (user 0, cold)`, (st.RangeGet || 0) >= total && (st.FullGet || 0) < total, JSON.stringify(st));
  const visible0 = JSON.parse(await o.inbox(0)).emails.map((e) => e.id);
  // reference only (what a full parse decides; equivalence above is the pass criterion)
  console.log('INFO user 0, full-parse reference: visible = ' + Object.keys(cases).filter((k) => visible0.includes(`p-${k}`)).join(' '));
  console.log('INFO user 0, full-parse reference: not visible = ' + Object.keys(cases).filter((k) => !visible0.includes(`p-${k}`)).join(' '));
  ok('the hostile cases include messages user 0 must see and must not see', visible0.length >= 10 && Object.keys(cases).length - visible0.length >= 8, `${visible0.length} visible`);
} finally { await o.stop(); await n.stop(); await nf.stop(); }
console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
