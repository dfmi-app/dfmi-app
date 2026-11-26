// Test preload for outbox.mjs: an S3 object store in a JSON file that honours conditional writes (IfNoneMatch '*',
// IfMatch <etag>) like S3, and an SES stub that counts every message it accepts and can inject faults.
// DRILL_STORE: objects file, DRILL_CONTROL: fault file, DRILL_AUDIT: ses log (one JSON line per accepted message).
const fs = require('node:fs'); const crypto = require('node:crypto'); const { Readable } = require('node:stream');
const file = process.env.DRILL_STORE, control = process.env.DRILL_CONTROL, sesLog = process.env.DRILL_AUDIT;
const load = () => JSON.parse(fs.readFileSync(file, 'utf8')); const save = (o) => fs.writeFileSync(file, JSON.stringify(o));
const fault = () => { try { return JSON.parse(fs.readFileSync(control, 'utf8')); } catch { return {}; } };
const err = (name, code) => { const e = new Error(name); e.name = name; e.$metadata = { httpStatusCode: code }; return e; };
const s3 = require('@aws-sdk/client-s3');
s3.S3Client.prototype.send = async function (cmd) {
  const n = cmd.constructor.name, i = cmd.input, f = fault();
  const failing = f.s3 && n === f.s3.op && (i.Key || '').startsWith(f.s3.prefix || '') &&
      (!f.s3.state || JSON.parse(String(i.Body)).state === f.s3.state) && f.s3.remaining !== 0;
  if (failing) {
    if (f.s3.remaining > 0) { f.s3.remaining--; fs.writeFileSync(control, JSON.stringify(f)); }
    if (!f.s3.commitThenFail) throw err('ServiceUnavailable', 503);
  }
  const o = load(), k = i.Key;
  if (n === 'PutObjectCommand') {
    const cur = o[k];
    if (i.IfNoneMatch === '*' && cur) throw err('PreconditionFailed', 412);
    if (i.IfMatch && (!cur || cur.etag !== i.IfMatch)) throw err('PreconditionFailed', 412);
    const body = Buffer.from(i.Body); o[k] = { body: body.toString('base64'), etag: '"' + crypto.createHash('md5').update(body).digest('hex') + '"' }; save(o);
    if (failing) throw err('ServiceUnavailable', 503); // write committed, response lost
    return { ETag: o[k].etag };
  }
  if (n === 'GetObjectCommand') { if (!o[k]) throw err('NoSuchKey', 404); return { Body: Readable.from([Buffer.from(o[k].body, 'base64')]), ETag: o[k].etag }; }
  if (n === 'DeleteObjectCommand') { delete o[k]; save(o); return {}; }
  if (n === 'ListObjectsV2Command') { const keys = Object.keys(o).filter((x) => x.startsWith(i.Prefix || '')).sort(); return { Contents: keys.map((x) => ({ Key: x, LastModified: new Date(), Size: 1 })), IsTruncated: false }; }
  throw new Error('unimplemented ' + n);
};
const ses = require('@aws-sdk/client-sesv2');
ses.SESv2Client.prototype.send = async function (cmd) {
  const f = fault(); const i = cmd.input;
  // reject: SES refuses before accepting (4xx) -> not sent
  if (f.ses === 'reject') throw err('MessageRejected', 400);
  // throttle-then-unknown: a 5xx/network error with no acceptance -> not sent, but the caller cannot know
  if (f.ses === 'error-not-sent') throw err('InternalFailure', 500);
  const id = 'ses-' + crypto.randomUUID();
  fs.appendFileSync(sesLog, JSON.stringify({ id, to: i.Destination?.ToAddresses, subject: i.Content?.Simple?.Subject?.Data, tag: i.EmailTags?.find((t) => t.Name === 'messageId')?.Value }) + '\n');
  // lost-response: SES accepted and sent it, but the response never reached us
  if (f.ses === 'lost-response') { const e = new Error('socket hang up'); e.name = 'TimeoutError'; throw e; }
  if (f.sesDelayMs) await new Promise((r) => setTimeout(r, f.sesDelayMs));
  return { MessageId: id };
};
