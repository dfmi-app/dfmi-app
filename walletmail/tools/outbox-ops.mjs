#!/usr/bin/env node
// Operator tool for outbox entries whose outcome is unknown (2026-11-26). Run on the mail host from the service
// directory, with the service's .env (the authority to run it is access to that host and file):
//   node tools/outbox-ops.mjs list                                   pending / failed / abandoned entries, with evidence
//   node tools/outbox-ops.mjs show <wallet> <messageId>
//   node tools/outbox-ops.mjs resolve <wallet> <messageId> --as sent|not-sent|undeterminable --operator <name> --reason "<text>"
//   node tools/outbox-ops.mjs canary                                 send one probe to the SES mailbox simulator (hourly cron)
//   node tools/outbox-ops.mjs guard on|off|status --operator <name> --reason "<text>"   durable legacy-restore guard (recorded)
//   node tools/outbox-ops.mjs backfill --source-bucket <pre-rollback bucket> | --ids <legacy-ID list> --operator <name> --reason "<text>"
//                                                                    journal legacy records (or close listed ids), recorded with source + unverified list
//   node tools/outbox-ops.mjs inventory [--source-bucket <bucket>]  legacy outbox/ and sent/ counts, how many already journaled
//   node tools/outbox-ops.mjs anomalies                              open bounces / complaints / delivery delays
//   node tools/outbox-ops.mjs ack <wallet> <messageId> --operator <name> --reason "<text>"   close them (recorded, nothing deleted)
// `guard off` is refused unless the latest backfill from a pre-rollback source (another bucket, an ID list, or this bucket
// before the latest `guard on`) completed with an empty unverified list.
// Rules (never sends the user's message, never generates a new messageId):
//   sent            only if SES recorded an acceptance event (Send/Delivery/Bounce/...) for this messageId.
//   not-sent        refused: missing asynchronous events cannot prove nonacceptance.
//   undeterminable  when neither can be shown: the state becomes 'abandoned'; the system never sends it again and the
//                   user is told to check with the recipient.
// Every resolution is written once to resolutions/<wallet>/<obid>/<time>.json in the EVENTS bucket (the authoritative
// copy: that bucket is not restored with the mail bucket, so a rollback cannot erase it) and to outbox-resolutions/ in
// the mail bucket; then the outbox entry is updated with a conditional write (it fails if the entry changed meanwhile).
import { createRequire } from 'node:module'; import path from 'node:path'; import crypto from 'node:crypto'; import fs from 'node:fs';
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
} else if (cmd === 'guard') {
  // node tools/outbox-ops.mjs guard on|off|status --operator <name> --reason "<text>"
  // The durable legacy-restore guard for this mail bucket (journal/_restore-guard/<S3_INCOMING_BUCKET>.json in the events bucket): while on, every instance refuses
  // a messageId that has neither a journal entry nor a surviving outbox record, regardless of its environment.
  const mode = a._[0], operator = a.operator, reason = a.reason;
  const cur = await getJson(EV, `journal/_restore-guard/${MAIL}.json`);
  if (mode === 'status' || !mode) { console.log(JSON.stringify(cur ? cur.rec : { active: false }, null, 1)); process.exit(0); }
  if (!['on', 'off'].includes(mode) || !operator || !reason) { console.error('usage: guard on|off|status --operator <name> --reason "<text>"'); process.exit(2); }
  if (mode === 'off') {
    const recs = async (p) => { const out = []; for (const o of await list(EV, p)) { const r = await getJson(EV, o.Key); if (r) out.push(r.rec); } return out; };
    const lastOn = (await recs(`resolutions/_restore-guard/${MAIL}/`)).filter(r => r.active === true).map(r => r.at).sort().pop() || '';
    // A backfill only counts if its source predates the rollback: another bucket (the live copy before the restore) or an
    // explicit legacy-ID list, or this same bucket inventoried BEFORE the latest guard on. Every record such a backfill
    // listed as unverified must have been closed since. A reason alone is never enough.
    const qualifying = (await recs('resolutions/_backfill/')).filter(r => r.complete === true && r.source &&
      (r.source.type === 'ids' || (r.source.type === 'bucket' && (r.source.bucket !== MAIL || (lastOn && r.at < lastOn))))).sort((x, y) => x.at.localeCompare(y.at));
    const latest = qualifying.pop();
    if (!latest) { console.error(`refused: no completed backfill from a pre-rollback source for ${MAIL} (another bucket, an ID list, or ${MAIL} itself before the guard went on at ${lastOn || 'never'}); run: backfill --source-bucket <live bucket> | --ids <file> --operator <name> --reason "<text>"`); process.exit(1); }
    // every record any qualifying backfill reported as unverified must since have become authoritative (closed by an ID list)
    const outstanding = [];
    for (const r of [...qualifying, latest]) for (const u of r.unverified || []) if (!u.wallet || !u.messageId || !(await getJson(EV, jkey(u.wallet, u.messageId)))) outstanding.push(u);
    if (outstanding.length) { console.error(`refused: ${outstanding.length} unverified legacy record(s) are still open (${JSON.stringify(outstanding.slice(0, 3))}); close them with backfill --ids <file>`); process.exit(1); }
  }
  const at = new Date().toISOString(); const rec = { active: mode === 'on', operator, reason, at, previous: cur ? cur.rec : null };
  await s3.send(new PutObjectCommand({ Bucket: EV, Key: `resolutions/_restore-guard/${MAIL}/${at.replace(/[^0-9TZ]/g, '')}.json`, Body: JSON.stringify(rec), ContentType: 'application/json', IfNoneMatch: '*' }));
  await s3.send(new PutObjectCommand({ Bucket: EV, Key: `journal/_restore-guard/${MAIL}.json`, Body: JSON.stringify(rec), ContentType: 'application/json', ...(cur ? { IfMatch: cur.etag } : { IfNoneMatch: '*' }) }));
  console.log(JSON.stringify(rec, null, 1));
} else if (cmd === 'backfill' || cmd === 'inventory') {
  // Legacy disposition (2026-11-26, acceptance C). A message sent before the journal existed has no authoritative claim.
  //   backfill --source-bucket <bucket> [--ids <file>] --operator <name> --reason "<text>"
  //     source = the COMPLETE pre-rollback records (the live bucket before any restore). Every outbox/ and external sent/
  //     record there without a journal entry is journaled (conditional write, never overwrites), not retryable, with the
  //     server's fingerprint. A record that cannot be read or fingerprinted is NOT migrated; it is listed as unverified.
  //   backfill --ids <file> ...   an explicit legacy-ID list (JSON array or lines "wallet messageId"): each listed id
  //     without a journal entry (and not found in --source-bucket, if given) is CLOSED: journal state abandoned + an
  //     undeterminable resolution; it is never sent again.
  //   inventory [--source-bucket <bucket>]   counts only (no writes)
  const src = a['source-bucket'] || (cmd === 'inventory' ? MAIL : null), idsFile = a.ids, operator = a.operator, reason = a.reason;
  if (cmd === 'backfill' && ((!src && !idsFile) || !operator || !reason)) { console.error('usage: backfill --source-bucket <bucket> | --ids <file> --operator <name> --reason "<text>"'); process.exit(2); }
  const started = new Date().toISOString();
  const journaled = async (w, id) => !!(await getJson(EV, jkey(w, id)));
  const cand = [], unverified = [], inv = { outbox: {}, sentExternal: 0, sentInternalOrOther: 0, alreadyJournaled: 0, notJournaled: 0, unverifiable: 0 };
  const seen = new Set();
  if (src) {
    for (const o of await list(src, 'outbox/')) {
      const m = /^outbox\/(0x[0-9a-f]{40})\/(.+)\.json$/.exec(o.Key); let cur = null; try { cur = m && await getJson(src, o.Key); } catch {}
      if (!m || !cur || !cur.rec.messageId || !cur.rec.fp) { unverified.push({ key: o.Key, wallet: m?.[1], messageId: m?.[2], why: !cur ? 'unreadable' : 'no fingerprint' }); if (m) seen.add(`${m[1]}/${m[2]}`); continue; }
      inv.outbox[cur.rec.state] = (inv.outbox[cur.rec.state] || 0) + 1; seen.add(`${m[1]}/${cur.rec.messageId}`);
      cand.push({ ...cur.rec, wallet: m[1], retryable: false, backfilledAt: started, backfilledFrom: `outbox (${src})` });
    }
    for (const o of await list(src, 'sent/')) {
      const m = /^sent\/(0x[0-9a-f]{40})\/(.+)\.json$/.exec(o.Key); if (!m) continue;
      let cur = null; try { cur = await getJson(src, o.Key); } catch {}
      const e = cur?.rec; const to = e && (e.toEmail || e.to);
      if (e && (e.internal === true || typeof to !== 'string' || !to.includes('@'))) { inv.sentInternalOrOther++; continue; }
      if (seen.has(`${m[1]}/${m[2]}`)) continue;
      inv.sentExternal++;
      if (!e || !e.fromEmail || typeof e.subject !== 'string' || typeof e.body !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(m[2])) { unverified.push({ key: o.Key, wallet: m[1], messageId: m[2], why: !e ? 'unreadable' : 'cannot fingerprint' }); continue; }
      // the same fingerprint server.js computes: sha256(JSON.stringify([recipientEmail, subject, body, fromEmail]))
      const fp = crypto.createHash('sha256').update(JSON.stringify([e.to || e.toEmail, e.subject, e.body, e.fromEmail])).digest('hex');
      cand.push({ state: 'sent', fp, to, from: e.fromEmail, wallet: m[1], messageId: m[2], sesMessageId: e.sesMessageId || null,
        sentAt: new Date(e.timestamp || Date.parse(o.LastModified) || Date.now()).toISOString(), retryable: false, backfilledAt: started, backfilledFrom: `sent (${src})` });
    }
  }
  let ids = [];
  if (idsFile) {
    const raw = fs.readFileSync(idsFile, 'utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch {}
    ids = (parsed || raw.split('\n').filter(l => l.trim()).map(l => { const [wallet, messageId] = l.trim().split(/\s+/); return { wallet, messageId }; }))
      .map(x => ({ wallet: String(x.wallet || '').toLowerCase(), messageId: String(x.messageId || '') }));
    const bad = ids.filter(x => !/^0x[0-9a-f]{40}$/.test(x.wallet) || !/^[A-Za-z0-9._:-]{1,128}$/.test(x.messageId));
    if (bad.length) { console.error('refused: malformed entries in the ID list: ' + JSON.stringify(bad.slice(0, 5))); process.exit(2); }
  }
  for (const r of cand) { if (await journaled(r.wallet, r.messageId)) { inv.alreadyJournaled++; r._skip = true; } else inv.notJournaled++; }
  for (let i = unverified.length - 1; i >= 0; i--) { const u = unverified[i]; if (u.wallet && u.messageId && await journaled(u.wallet, u.messageId)) { unverified.splice(i, 1); inv.alreadyJournaled++; } }   // already authoritative
  inv.unverifiable = unverified.length;
  if (cmd === 'inventory') { console.log(JSON.stringify({ at: started, bucket: src, ...inv, unverified }, null, 1)); process.exit(0); }
  const migrated = [], existing = [], closed = [];
  const put = async (rec) => { try { await s3.send(new PutObjectCommand({ Bucket: EV, Key: jkey(rec.wallet, rec.messageId), Body: JSON.stringify(rec), ContentType: 'application/json', IfNoneMatch: '*' })); return true; }
    catch (e) { if (e.name === 'PreconditionFailed' || e.$metadata?.httpStatusCode === 412 || e.$metadata?.httpStatusCode === 409) return false; throw e; } };
  for (const r of cand) { if (r._skip || !(await put(r))) { existing.push({ wallet: r.wallet, messageId: r.messageId }); continue; } migrated.push({ wallet: r.wallet, messageId: r.messageId, state: r.state, from: r.backfilledFrom }); }
  const unv = unverified.filter(u => !ids.some(x => x.wallet === u.wallet && x.messageId === u.messageId));   // a listed id is closed below
  for (const x of ids) {
    if (migrated.concat(existing).some(m => m.wallet === x.wallet && m.messageId === x.messageId)) continue;
    const at = new Date().toISOString();
    const rec = { wallet: x.wallet, messageId: x.messageId, state: 'abandoned', fp: null, retryable: false, closedAt: at, closedBy: 'backfill --ids', resolution: { state: 'abandoned', decision: 'undeterminable', at, operator, reason } };
    if (!(await put(rec))) { existing.push({ wallet: x.wallet, messageId: x.messageId }); continue; }
    await s3.send(new PutObjectCommand({ Bucket: EV, Key: `resolutions/${x.wallet}/${b64u(x.messageId)}/${at.replace(/[^0-9TZ]/g, '')}.json`, ContentType: 'application/json', IfNoneMatch: '*',
      Body: JSON.stringify({ wallet: x.wallet, messageId: x.messageId, decision: 'undeterminable', newState: 'abandoned', previousState: 'legacy (listed, no record)', operator, reason, at, by: 'backfill --ids' }) }));
    closed.push(x);
  }
  const at = new Date().toISOString();
  const source = src ? { type: 'bucket', bucket: src, ...(idsFile ? { ids: idsFile, idsSha256: crypto.createHash('sha256').update(fs.readFileSync(idsFile)).digest('hex') } : {}) }
    : { type: 'ids', ids: idsFile, idsSha256: crypto.createHash('sha256').update(fs.readFileSync(idsFile)).digest('hex') };
  const rec = { source, servedBucket: MAIL, operator, reason, startedAt: started, at, complete: true,
    counts: { migrated: migrated.length, alreadyJournaled: existing.length, closed: closed.length, unverified: unv.length }, inventory: src ? inv : undefined, migrated, alreadyJournaled: existing, closed, unverified: unv };
  await s3.send(new PutObjectCommand({ Bucket: EV, Key: `resolutions/_backfill/${(src || 'ids').replace(/[^A-Za-z0-9._-]/g, '_')}/${at.replace(/[^0-9TZ]/g, '')}.json`, Body: JSON.stringify(rec), ContentType: 'application/json', IfNoneMatch: '*' }));
  console.log(JSON.stringify(rec, null, 1));
} else if (cmd === 'anomalies') {
  const acked = new Set((await list(EV, 'anomalies/ack/')).map(o => o.Key.slice('anomalies/ack/'.length)));
  const open = [];
  for (const o of await list(EV, 'anomalies/open/')) { const rel = o.Key.slice('anomalies/open/'.length); if (acked.has(rel)) continue; const r = await getJson(EV, o.Key); if (r) open.push({ eventType: r.rec.eventType, wallet: r.rec.wallet, messageId: r.rec.messageId, timestamp: r.rec.timestamp, destination: r.rec.destination, detail: r.rec.detail }); }
  console.log(JSON.stringify({ at: new Date().toISOString(), open }, null, 1));
} else if (cmd === 'ack') {
  const [w0, id] = a._; const w = (w0 || '').toLowerCase(); const operator = a.operator, reason = a.reason;
  if (!/^0x[0-9a-f]{40}$/.test(w) || !id || !operator || !reason) { console.error('usage: ack <wallet> <messageId> --operator <name> --reason "<text>"'); process.exit(2); }
  const acked = new Set((await list(EV, 'anomalies/ack/')).map(o => o.Key.slice('anomalies/ack/'.length)));
  const done = [];
  for (const o of await list(EV, 'anomalies/open/')) {
    const rel = o.Key.slice('anomalies/open/'.length); const parts = rel.split('/');
    if (parts[1] !== w || parts[2] !== b64u(id) || acked.has(rel)) continue;
    const at = new Date().toISOString();
    await s3.send(new PutObjectCommand({ Bucket: EV, Key: `anomalies/ack/${rel}`, Body: JSON.stringify({ by: 'operator', operator, reason, at }), ContentType: 'application/json', IfNoneMatch: '*' }));
    done.push({ eventType: parts[0], file: parts[3], at });
  }
  if (!done.length) { console.error('nothing open for this messageId'); process.exit(1); }
  console.log(JSON.stringify({ wallet: w, messageId: id, operator, reason, acked: done }, null, 1));
} else if (cmd === 'canary') {
  const id = 'canary-' + new Date().toISOString().replace(/[^0-9TZ]/g, '');
  const r = await ses.send(new SendEmailCommand({ FromEmailAddress: `outbox-canary@${DOMAIN}`, Destination: { ToAddresses: ['success@simulator.amazonses.com'] }, ConfigurationSetName: CS,
    Content: { Simple: { Subject: { Data: 'outbox canary ' + id }, Body: { Text: { Data: 'Event pipeline probe. No reply.' } } } },
    EmailTags: [{ Name: 'obw', Value: CANARY_WALLET }, { Name: 'obid', Value: b64u(id) }, { Name: 'messageId', Value: id }] }));
  console.log(JSON.stringify({ at: new Date().toISOString(), canary: id, sesMessageId: r.MessageId }));
} else { console.error('usage: list | show <wallet> <id> | resolve ... | guard ... | backfill ... | anomalies | ack ... | canary'); process.exit(2); }
