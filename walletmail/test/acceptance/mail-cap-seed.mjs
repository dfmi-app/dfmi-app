// Acceptance E — seed the isolated capacity mail bucket (real S3), run on the capacity server with its instance role.
//   node mail-cap-seed.mjs <bucket> <addresses.json>      addresses.json: { w300, w1000, watt } (lower-case 0x addresses)
// Dataset (fixed by the checklist): 4,000 MIME messages in raw/, body ≈ 5.3 KB; 300 to w300, 1,000 to w1000, 2,700 to
// other addresses; plus 10 attachment messages (one 10 MiB attachment each, content = byte i) in incoming/<watt>/att-<i>.
import fs from 'node:fs'; import crypto from 'node:crypto'; import { createRequire } from 'node:module';
const require = createRequire('/opt/wm/'); const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const [BUCKET, ADDR] = process.argv.slice(2); const a = JSON.parse(fs.readFileSync(ADDR, 'utf8')); const D = 'dfmi.me';
const s3 = new S3Client({ region: 'us-east-1' });
const body = (i) => `Capacity message ${i}. ` + 'lorem ipsum dolor sit amet consectetur '.repeat(140).slice(0, 5300 - 24);
const mime = (to, i) => `From: Sender ${i} <sender${i}@example.org>\r\nTo: ${to}\r\nSubject: capacity message ${i}\r\nDate: ${new Date(Date.UTC(2026, 10, 1) + i * 60e3).toUTCString()}\r\nMessage-ID: <cap-${i}@example.org>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body(i)}\r\n`;
const att = (to, i) => { const b64 = Buffer.alloc(10 * 1048576, i).toString('base64').replace(/.{76}/g, '$&\r\n');
  return `From: att@example.org\r\nTo: ${to}\r\nSubject: attachment ${i}\r\nDate: ${new Date(Date.UTC(2026, 10, 2) + i * 60e3).toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nsee attached\r\n--b\r\nContent-Type: application/octet-stream; name=big${i}.bin\r\nContent-Disposition: attachment; filename=big${i}.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n--b--\r\n`; };
const jobs = [];
for (let i = 0; i < 4000; i++) { const to = i < 300 ? a.w300 : i < 1300 ? a.w1000 : `someone${i}`; jobs.push([`raw/cap${String(i).padStart(6, '0')}`, () => mime(`${to}@${D}`, i)]); }
for (let i = 0; i < 10; i++) jobs.push([`incoming/${a.watt}/att-${i}`, () => att(`${a.watt}@${D}`, i)]);
let next = 0, bytes = 0, bodies = 0; const t0 = Date.now();
await Promise.all(Array.from({ length: 24 }, async () => { while (next < jobs.length) { const [k, f] = jobs[next++]; const b = f(); bytes += b.length; if (k.startsWith('raw/')) bodies += 5300;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: k, Body: b, ContentType: 'message/rfc822' })); } }));
const expected = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`att-${i}`, crypto.createHash('sha256').update(Buffer.alloc(10 * 1048576, i)).digest('hex')]));
const out = { at: new Date().toISOString(), bucket: BUCKET, raw_messages: 4000, to_w300: 300, to_w1000: 1000, to_others: 2700, attachments: 10, attachment_bytes: 10 * 1048576, body_bytes_avg: 5300, total_bytes: bytes, seconds: (Date.now() - t0) / 1000, attachment_sha256: expected };
console.log(JSON.stringify(out)); fs.writeFileSync('seed-result.json', JSON.stringify(out, null, 1));
