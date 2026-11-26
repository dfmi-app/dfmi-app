// Capacity-test preload: an in-memory S3 (seeded from CAP_SEED, a JSON {key: base64}) with injected per-call latency,
// and an SES stub that accepts everything. Latency: CAP_LAT_GET / CAP_LAT_LIST / CAP_LAT_PUT in ms, ±30% jitter.
// Counts every S3 call so the test can report calls per request (GET /__cap/stats, served by a tiny side listener).
const fs = require('node:fs'); const crypto = require('node:crypto'); const http = require('node:http'); const { Readable } = require('node:stream');
const o = new Map(Object.entries(JSON.parse(fs.readFileSync(process.env.CAP_SEED, 'utf8'))).map(([k, v]) => [k, { body: Buffer.from(v, 'base64'), at: new Date(+process.env.CAP_SEED_AT || Date.now() - 86400e3) }]));
const L = { GetObjectCommand: +process.env.CAP_LAT_GET || 0, ListObjectsV2Command: +process.env.CAP_LAT_LIST || 0, PutObjectCommand: +process.env.CAP_LAT_PUT || 0, DeleteObjectCommand: +process.env.CAP_LAT_PUT || 0 };
const stats = {}; const sleep = (ms) => ms > 0 ? new Promise((r) => setTimeout(r, ms * (0.7 + Math.random() * 0.6))) : null;
const err = (name, code) => { const e = new Error(name); e.name = name; e.$metadata = { httpStatusCode: code }; return e; };
const s3 = require('@aws-sdk/client-s3');
s3.S3Client.prototype.send = async function (cmd) {
  const n = cmd.constructor.name, i = cmd.input; stats[n] = (stats[n] || 0) + 1; await sleep(L[n]);
  if (n === 'PutObjectCommand') { if (i.IfNoneMatch === '*' && o.has(i.Key)) throw err('PreconditionFailed', 412); const b = Buffer.from(i.Body); o.set(i.Key, { body: b, at: new Date() }); return { ETag: '"' + crypto.createHash('md5').update(b).digest('hex') + '"' }; }
  if (n === 'GetObjectCommand') { const v = o.get(i.Key); if (!v) throw err('NoSuchKey', 404); return { Body: Readable.from([v.body]), ETag: '"x"' }; }
  if (n === 'DeleteObjectCommand') { o.delete(i.Key); return {}; }
  if (n === 'ListObjectsV2Command') {
    const all = [...o.keys()].filter((k) => k.startsWith(i.Prefix || '')).sort(); const start = i.ContinuationToken ? +i.ContinuationToken : 0; const max = i.MaxKeys || 1000;
    const page = all.slice(start, start + max); const more = start + max < all.length;
    return { Contents: page.map((k) => ({ Key: k, LastModified: o.get(k).at, Size: o.get(k).body.length })), IsTruncated: more, ...(more ? { NextContinuationToken: String(start + max) } : {}) };
  }
  throw new Error('unimplemented ' + n);
};
require('@aws-sdk/client-sesv2').SESv2Client.prototype.send = async function () { stats.SES = (stats.SES || 0) + 1; await sleep(L.PutObjectCommand); return { MessageId: 'ses-' + crypto.randomUUID() }; };
http.createServer(async (q, r) => {
  if (q.method === 'PUT') { const c = []; for await (const x of q) c.push(x); o.set(decodeURIComponent(q.url.slice(1)), { body: Buffer.concat(c), at: new Date() }); return r.end('{}'); } // test hook: overwrite an object
  if (q.url === '/reset') for (const k in stats) delete stats[k]; r.end(JSON.stringify({ ...stats, rss: process.memoryUsage().rss, objects: o.size })); }).listen(+process.env.CAP_STATS_PORT, '127.0.0.1');
