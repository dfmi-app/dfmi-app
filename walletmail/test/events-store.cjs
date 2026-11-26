// Test preload for outbox-reconcile.mjs: S3 with several buckets in one JSON file (conditional writes like S3), and an
// SES stub that, when it accepts a message, writes SES events the way Amazon Data Firehose does (concatenated JSON in
// raw/YYYY/MM/DD/HH/ of the events bucket). DRILL_STORE: objects file, DRILL_CONTROL: fault file, DRILL_AUDIT: SES log.
// Faults: {ses:'reject'|'error-not-sent'|'lost-response'}, {events:'off'} (pipeline broken: SES accepts, no events).
const fs = require('node:fs'); const crypto = require('node:crypto'); const { Readable } = require('node:stream');
const file = process.env.DRILL_STORE, control = process.env.DRILL_CONTROL, sesLog = process.env.DRILL_AUDIT, EV = process.env.SES_EVENTS_BUCKET || 'events';
const load = () => JSON.parse(fs.readFileSync(file, 'utf8')); const save = (o) => fs.writeFileSync(file, JSON.stringify(o));
const fault = () => { try { return JSON.parse(fs.readFileSync(control, 'utf8')); } catch { return {}; } };
const err = (name, code) => { const e = new Error(name); e.name = name; e.$metadata = { httpStatusCode: code }; return e; };
const s3 = require('@aws-sdk/client-s3');
s3.S3Client.prototype.send = async function (cmd) {
  const n = cmd.constructor.name, i = cmd.input, f = fault(); const k = `${i.Bucket}/${i.Key || ''}`;
  if (f.s3 && n === f.s3.op && (i.Bucket === (f.s3.bucket || i.Bucket)) && (i.Key || i.Prefix || '').startsWith(f.s3.prefix || '') && (!f.s3.state || JSON.parse(String(i.Body)).state === f.s3.state)) throw err('ServiceUnavailable', 503);
  const o = load();
  if (n === 'PutObjectCommand') {
    const cur = o[k];
    if (i.IfNoneMatch === '*' && cur) throw err('PreconditionFailed', 412);
    if (i.IfMatch && (!cur || cur.etag !== i.IfMatch)) throw err('PreconditionFailed', 412);
    const body = Buffer.from(i.Body); o[k] = { body: body.toString('base64'), etag: '"' + crypto.createHash('md5').update(body + Date.now()).digest('hex') + '"', at: Date.now() }; save(o); return { ETag: o[k].etag };
  }
  if (n === 'GetObjectCommand') { if (!o[k]) throw err('NoSuchKey', 404); return { Body: Readable.from([Buffer.from(o[k].body, 'base64')]), ETag: o[k].etag }; }
  if (n === 'DeleteObjectCommand') { delete o[k]; save(o); return {}; }
  if (n === 'ListObjectsV2Command') {
    const pre = `${i.Bucket}/${i.Prefix || ''}`; let keys = Object.keys(o).filter((x) => x.startsWith(pre)).sort();
    if (i.StartAfter) keys = keys.filter((x) => x > `${i.Bucket}/${i.StartAfter}`);
    return { Contents: keys.map((x) => ({ Key: x.slice(i.Bucket.length + 1), LastModified: new Date(o[x].at || 0), Size: 1 })), IsTruncated: false };
  }
  throw new Error('unimplemented ' + n);
};
function firehose(events) {
  const o = load(); const d = new Date(); const p = (x) => String(x).padStart(2, '0');
  const key = `${EV}/raw/${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${p(d.getUTCHours())}/walletmail-ses-events-1-${d.toISOString().replace(/[^0-9]/g, '')}-${crypto.randomUUID()}`;
  o[key] = { body: Buffer.from(events.map((e) => JSON.stringify(e)).join('')).toString('base64'), etag: '"x"', at: Date.now() }; save(o);
}
const ses = require('@aws-sdk/client-sesv2');
ses.SESv2Client.prototype.send = async function (cmd) {
  const f = fault(); const i = cmd.input;
  if (f.ses === 'reject') throw err('MessageRejected', 400);
  if (f.ses === 'error-not-sent') throw err('InternalFailure', 500);
  const id = 'ses-' + crypto.randomUUID(); const tags = Object.fromEntries((i.EmailTags || []).map((t) => [t.Name, [t.Value]]));
  const to = i.Destination?.ToAddresses || []; const subject = i.Content?.Simple?.Subject?.Data;
  fs.appendFileSync(sesLog, JSON.stringify({ id, to, subject, tag: tags.messageId?.[0], configurationSet: i.ConfigurationSetName || null }) + '\n');
  if (i.ConfigurationSetName && f.events !== 'off') {
    const mail = { timestamp: new Date().toISOString(), messageId: id, destination: to, tags, commonHeaders: { subject } };
    const evs = [{ eventType: 'Send', mail, send: {} }];
    if (to.some((x) => x.startsWith('bounce@'))) evs.push({ eventType: 'Bounce', mail, bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: to[0] }], timestamp: new Date().toISOString() } });
    else if (to.some((x) => x.startsWith('complaint@'))) evs.push({ eventType: 'Delivery', mail, delivery: { recipients: to, smtpResponse: '250 OK', timestamp: new Date().toISOString() } }, { eventType: 'Complaint', mail, complaint: { complainedRecipients: [{ emailAddress: to[0] }], complaintFeedbackType: 'abuse', timestamp: new Date().toISOString() } });
    else evs.push({ eventType: 'Delivery', mail, delivery: { recipients: to, smtpResponse: '250 2.6.0 Message received', processingTimeMillis: 500, timestamp: new Date().toISOString() } });
    firehose(evs);
  }
  if (f.ses === 'lost-response') { const e = new Error('socket hang up'); e.name = 'TimeoutError'; throw e; }
  return { MessageId: id };
};
