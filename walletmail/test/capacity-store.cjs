// Capacity-test preload: an S3 stub backed by one file per object on disk (CAP_DIR; file name = encodeURIComponent(key)),
// so the server process holds an object only while a request uses it, as with real S3, and its RSS is measurable.
// Injected per-call latency: CAP_LAT_GET / CAP_LAT_LIST / CAP_LAT_PUT in ms, ±30% jitter. SES is a stub that accepts.
// Counts every S3 call so the test can report calls per request (GET /__cap/stats, served by a tiny side listener).
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto'); const http = require('node:http'); const { Readable } = require('node:stream');
let DIR = process.env.CAP_DIR;
if (!DIR && process.env.CAP_SEED) {   // older callers: a JSON seed {key: base64} is unpacked into a directory once at start
  DIR = path.join(path.dirname(process.env.CAP_SEED), 'objects'); fs.mkdirSync(DIR, { recursive: true });
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(process.env.CAP_SEED, 'utf8')))) fs.writeFileSync(path.join(DIR, encodeURIComponent(k)), Buffer.from(v, 'base64'));
}
const SEED_AT = new Date(+process.env.CAP_SEED_AT || Date.now() - 86400e3);
const file = (k) => path.join(DIR, encodeURIComponent(k));
const L = { GetObjectCommand: +process.env.CAP_LAT_GET || 0, ListObjectsV2Command: +process.env.CAP_LAT_LIST || 0, PutObjectCommand: +process.env.CAP_LAT_PUT || 0, DeleteObjectCommand: +process.env.CAP_LAT_PUT || 0 };
const stats = {}; const sleep = (ms) => ms > 0 ? new Promise((r) => setTimeout(r, ms * (0.7 + Math.random() * 0.6))) : null;
const err = (name, code) => { const e = new Error(name); e.name = name; e.$metadata = { httpStatusCode: code }; return e; };
const written = new Set();   // keys written by the server (LastModified = file mtime); seeded keys report CAP_SEED_AT
const s3 = require('@aws-sdk/client-s3');
s3.S3Client.prototype.send = async function (cmd) {
  const n = cmd.constructor.name, i = cmd.input; stats[n] = (stats[n] || 0) + 1; await sleep(L[n]);
  if (n === 'PutObjectCommand') { const f = file(i.Key); if (i.IfNoneMatch === '*' && fs.existsSync(f)) throw err('PreconditionFailed', 412); const b = Buffer.from(i.Body); fs.writeFileSync(f, b); written.add(i.Key); return { ETag: '"' + crypto.createHash('md5').update(b).digest('hex') + '"' }; }
  if (n === 'GetObjectCommand') { let b; try { b = fs.readFileSync(file(i.Key)); } catch { throw err('NoSuchKey', 404); }
    // Range as S3 does it (single range, bytes=a-b inclusive, clamped to the object; 416 InvalidRange when the start is past
    // the end, which includes every range on an empty object). CAP_RANGE=0 ignores Range (returns the whole object).
    const rg = process.env.CAP_RANGE !== '0' && /^bytes=(\d+)-(\d*)$/.exec(i.Range || '');
    if (rg) { stats.RangeGet = (stats.RangeGet || 0) + 1; const a = +rg[1], z = rg[2] === '' ? b.length - 1 : Math.min(+rg[2], b.length - 1);
      if (a >= b.length) throw err('InvalidRange', 416); b = b.subarray(a, z + 1); }
    else stats.FullGet = (stats.FullGet || 0) + 1;
    return { Body: Readable.from([b]), ETag: '"x"' }; }
  if (n === 'DeleteObjectCommand') { fs.rmSync(file(i.Key), { force: true }); return {}; }
  if (n === 'ListObjectsV2Command') {
    const all = fs.readdirSync(DIR).map(decodeURIComponent).filter((k) => k.startsWith(i.Prefix || '')).sort(); const start = i.ContinuationToken ? +i.ContinuationToken : 0; const max = i.MaxKeys || 1000;
    const page = all.slice(start, start + max); const more = start + max < all.length;
    return { Contents: page.map((k) => { const st = fs.statSync(file(k)); return { Key: k, LastModified: written.has(k) ? st.mtime : SEED_AT, Size: st.size }; }), IsTruncated: more, ...(more ? { NextContinuationToken: String(start + max) } : {}) };
  }
  throw new Error('unimplemented ' + n);
};
require('@aws-sdk/client-sesv2').SESv2Client.prototype.send = async function () { stats.SES = (stats.SES || 0) + 1; await sleep(L.PutObjectCommand); return { MessageId: 'ses-' + crypto.randomUUID() }; };
http.createServer(async (q, r) => {
  if (q.method === 'PUT') { const c = []; for await (const x of q) c.push(x); fs.writeFileSync(file(decodeURIComponent(q.url.slice(1))), Buffer.concat(c)); return r.end('{}'); } // test hook: overwrite an object
  if (q.url === '/reset') for (const k in stats) delete stats[k]; r.end(JSON.stringify({ ...stats, rss: process.memoryUsage().rss })); }).listen(+process.env.CAP_STATS_PORT, '127.0.0.1');
