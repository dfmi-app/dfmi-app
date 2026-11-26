#!/usr/bin/env node
// Operator tool for outbox entries whose outcome is unknown (2026-11-26). Run on the mail host from the service
// directory, with the service's .env (the authority to run it is access to that host and file):
//   node tools/outbox-ops.mjs list                                   pending / failed / abandoned entries, with evidence
//   node tools/outbox-ops.mjs show <wallet> <messageId>
//   node tools/outbox-ops.mjs resolve <wallet> <messageId> --as sent|not-sent|undeterminable --operator <name> --reason "<text>"
//   node tools/outbox-ops.mjs canary                                 send one probe to the SES mailbox simulator (hourly cron)
// Rules (never sends the user's message, never generates a new messageId):
//   sent            only if SES recorded an acceptance event (Send/Delivery/Bounce/...) for this messageId.
//   not-sent        refused: missing asynchronous events cannot prove nonacceptance.
//   undeterminable  when neither can be shown: the state becomes 'abandoned'; the system never sends it again and the
//                   user is told to check with the recipient.
// Every resolution is written once to resolutions/<wallet>/<obid>/<time>.json in the EVENTS bucket (the authoritative
// copy: that bucket is not restored with the mail bucket, so a rollback cannot erase it) and to outbox-resolutions/ in
// the mail bucket; then the outbox entry is updated with a conditional write (it fails if the entry changed meanwhile).
import { createRequire } from 'node:module'; import path from 'node:path';
const require = createRequire(path.join(process.cwd(), 'server.js'));
require('dotenv').config({ quiet: true });
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const REGION = process.env.AWS_REGION || 'us-east-1', MAIL = process.env.S3_INCOMING_BUCKET, EV = process.env.SES_EVENTS_BUCKET, CS = process.env.SES_CONFIGURATION_SET;
const DOMAIN = process.env.EMAIL_DOMAIN || 'dfmi.me';
const WINDOW_MS = Number(process.env.OUTBOX_EVIDENCE_WINDOW_MS) || 15 * 60000, CANARY_GAP_MS = Number(process.env.OUTBOX_CANARY_MAX_GAP_MS) || 60 * 60000;
const CANARY_WALLET = '0x' + '0'.repeat(40);
const ACCEPTED = new Set(['Send', 'Delivery', 'Bounce', 'Complaint', 'Reject', 'DeliveryDelay']);
if (!MAIL || !EV || !CS || MAIL === EV) { console.error('S3_INCOMING_BUCKET, SES_EVENTS_BUCKET and SES_CONFIGURATION_SET must be set'); process.exit(2); }
const s3 = new S3Client({ region: REGION }), ses = new SESv2Client({ region: REGION, maxAttempts: 1 });
const b64u = (v) => Buffer.from(String(v)).toString('base64url');
const text = async (b) => { const c = []; for await (const x of b) c.push(Buffer.from(x)); return Buffer.concat(c).toString('utf8'); };
async function getJson(Bucket, Key) { try { const d = await s3.send(new GetObjectCommand({ Bucket, Key })); return { rec: JSON.parse(await text(d.Body)), etag: d.ETag }; } catch (e) { if (e.name === 'NoSuchKey' || e.name === 'NotFound') return null; throw e; } }
async function list(Bucket, Prefix) { const out = []; let t; do { const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ...(t ? { ContinuationToken: t } : {}) })); out.push(...(r.Contents || [])); t = r.IsTruncated ? r.NextContinuationToken : null; } while (t); return out; }
async function events(wallet, id) { const out = []; for (const o of await list(EV, `index/${wallet}/${b64u(id)}/`)) { const e = await getJson(EV, o.Key); if (e) out.push(e.rec); } return out.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))); }
async function canaries() { const out = []; for (const o of await list(EV, `index/${CANARY_WALLET}/`)) { const e = await getJson(EV, o.Key); if (e && e.rec.eventType === 'Send') out.push(Date.parse(e.rec.timestamp)); } return out.filter(Number.isFinite).sort((a, b) => a - b); }
const okey = (w, id) => `outbox/${w}/${id}.json`;
const jkey = (w, id) => `journal/${w}/${b64u(id)}.json`;
function args(a) { const o = { _: [] }; for (let i = 0; i < a.length; i++) { if (a[i].startsWith('--')) o[a[i].slice(2)] = a[++i]; else o._.push(a[i]); } return o; }
async function evidence(wallet, id, rec) {
  const evs = await events(wallet, id); const claimed = Date.parse(rec.claimedAt || 0); const cs = await canaries();
  const before = cs.filter(t => t <= claimed && claimed - t <= CANARY_GAP_MS).pop() ?? null, after = cs.find(t => t >= claimed && t - claimed <= CANARY_GAP_MS) ?? null;
  return { events: evs.map(e => ({ eventType: e.eventType, timestamp: e.timestamp, sesMessageId: e.sesMessageId })), accepted: evs.some(e => ACCEPTED.has(e.eventType)),
    ageMinutes: Math.round((Date.now() - claimed) / 60000), canaryBefore: before && new Date(before).toISOString(), canaryAfter: after && new Date(after).toISOString(),
    pipelineCoversClaim: !!(before && after) };
}
const [cmd, ...rest] = process.argv.slice(2); const a = args(rest);
if (cmd === 'list') {
  const entries = new Map();
  for (const o of await list(EV, 'journal/')) {
    const j = await getJson(EV, o.Key); if (j) entries.set(`${j.rec.wallet}/${j.rec.messageId}`, j.rec);
  }
  for (const o of await list(MAIL, 'outbox/')) {
    const m = await getJson(MAIL, o.Key); if (m && !entries.has(`${m.rec.wallet}/${m.rec.messageId}`)) entries.set(`${m.rec.wallet}/${m.rec.messageId}`, m.rec);
  }
  const rows = [];
  for (const r of entries.values()) {
    if (r.state === 'sent') continue;
    rows.push({ wallet: r.wallet, messageId: r.messageId, state: r.state, claimedAt: r.claimedAt, ...(r.state === 'pending' ? await evidence(r.wallet, r.messageId, r) : {}) });
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), entries: rows }, null, 1));
} else if (cmd === 'show') {
  const [w, id] = a._; const cur = await getJson(EV, jkey(w.toLowerCase(), id)) || await getJson(MAIL, okey(w.toLowerCase(), id)); if (!cur) { console.log('not found'); process.exit(1); }
  const res = []; for (const o of await list(EV, `resolutions/${w.toLowerCase()}/${b64u(id)}/`)) res.push((await getJson(EV, o.Key)).rec);   // authoritative (survives a mail-bucket rollback)
  console.log(JSON.stringify({ entry: { ...cur.rec, fp: undefined }, evidence: await evidence(w.toLowerCase(), id, cur.rec), resolutions: res }, null, 1));
} else if (cmd === 'resolve') {
  const [w0, id] = a._; const w = (w0 || '').toLowerCase(); const as = a.as, operator = a.operator, reason = a.reason;
  if (!/^0x[0-9a-f]{40}$/.test(w) || !id || !['sent', 'not-sent', 'undeterminable'].includes(as) || !operator || !reason) { console.error('usage: resolve <wallet> <messageId> --as sent|not-sent|undeterminable --operator <name> --reason "<text>"'); process.exit(2); }
  const authoritative = await getJson(EV, jkey(w, id));
  const cur = authoritative || await getJson(MAIL, okey(w, id)); if (!cur) { console.error('no outbox entry'); process.exit(1); }
  if (cur.rec.state !== 'pending') { console.error(`refused: state is ${cur.rec.state}, only pending entries are resolved`); process.exit(1); }
  const ev = await evidence(w, id, cur.rec);
  let state;
  if (as === 'sent') { if (!ev.accepted) { console.error('refused: SES recorded no acceptance event for this messageId'); process.exit(1); } state = 'sent'; }
  else if (as === 'not-sent') {
    console.error('refused: absence of events proves nothing, even with healthy probes; use undeterminable. Only a persisted definite SES rejection permits retry.'); process.exit(1);
  } else state = 'abandoned';
  const at = new Date().toISOString();
  const record = { wallet: w, messageId: id, decision: as, newState: state, previousState: 'pending', operator, reason, at, evidence: ev };
  const rk = `${w}/${b64u(id)}/${at.replace(/[^0-9TZ]/g, '')}.json`;
  await s3.send(new PutObjectCommand({ Bucket: EV, Key: `resolutions/${rk}`, Body: JSON.stringify(record), ContentType: 'application/json', IfNoneMatch: '*' }));
  await s3.send(new PutObjectCommand({ Bucket: MAIL, Key: `outbox-resolutions/${rk}`, Body: JSON.stringify(record), ContentType: 'application/json', IfNoneMatch: '*' }));
  const acc = ev.events.find(e => ACCEPTED.has(e.eventType));
  const next = { ...cur.rec, state, resolution: { state, decision: as, at, operator, reason },
    ...(state === 'sent' ? { sesMessageId: acc.sesMessageId, sentAt: acc.timestamp } : state === 'failed' ? { error: 'operator: not sent (no SES event, pipeline proven)', failedAt: at } : {}) };
  try {
    await s3.send(new PutObjectCommand({ Bucket: EV, Key: jkey(w, id), Body: JSON.stringify(next), ContentType: 'application/json', ...(authoritative ? { IfMatch: authoritative.etag } : { IfNoneMatch: '*' }) }));
    const mirror = await getJson(MAIL, okey(w, id));
    await s3.send(new PutObjectCommand({ Bucket: MAIL, Key: okey(w, id), Body: JSON.stringify(next), ContentType: 'application/json', ...(mirror ? { IfMatch: mirror.etag } : { IfNoneMatch: '*' }) }));
  }
  catch (e) { console.error('refused: the entry changed while resolving (' + e.name + '); the resolution record was written, run show and resolve again'); process.exit(1); }
  console.log(JSON.stringify(record, null, 1));
} else if (cmd === 'canary') {
  const id = 'canary-' + new Date().toISOString().replace(/[^0-9TZ]/g, '');
  const r = await ses.send(new SendEmailCommand({ FromEmailAddress: `outbox-canary@${DOMAIN}`, Destination: { ToAddresses: ['success@simulator.amazonses.com'] }, ConfigurationSetName: CS,
    Content: { Simple: { Subject: { Data: 'outbox canary ' + id }, Body: { Text: { Data: 'Event pipeline probe. No reply.' } } } },
    EmailTags: [{ Name: 'obw', Value: CANARY_WALLET }, { Name: 'obid', Value: b64u(id) }, { Name: 'messageId', Value: id }] }));
  console.log(JSON.stringify({ at: new Date().toISOString(), canary: id, sesMessageId: r.MessageId }));
} else { console.error('usage: list | show <wallet> <id> | resolve ... | canary'); process.exit(2); }
