// Real delivery drill against production (2026-11-26). One-off wallets only. Sends 4 messages through the live API:
// three to the SES mailbox simulator (success / bounce / complaint — no real person receives them, they do not affect
// sending reputation) and one to a one-off @dfmi.me test inbox, received through the real inbound path.
// For each: messageId ↔ SES message id ↔ SES events (Send, Delivery, Bounce, Complaint) ↔ received message.
//   node delivery-drill.mjs <out.json>
import fs from 'node:fs'; import crypto from 'node:crypto'; import { createRequire } from 'node:module';
const { ethers } = createRequire(import.meta.url)('ethers');
const B = 'https://exchange.dfmi.me', H = { 'content-type': 'application/json', origin: 'https://identity.dfmi.app' };
const out = { started_at: new Date().toISOString(), api: B, cases: [] };
const j = async (m, u, t, b) => { const r = await fetch(B + u, { method: m, headers: { ...H, ...(t ? { authorization: 'Bearer ' + t } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}), signal: AbortSignal.timeout(30000) }); return { s: r.status, x: await r.json().catch(() => ({})) }; };
async function login(w) { const c = await j('POST', '/api/auth/challenge', null, { wallet: w.address }); return (await j('POST', '/api/auth/verify', null, { challengeId: c.x.challengeId, signature: await w.signMessage(c.x.message) })).x.token; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = ethers.Wallet.createRandom(), R = ethers.Wallet.createRandom(); const tS = await login(S), tR = await login(R);
const rAddr = `${R.address.toLowerCase()}@dfmi.me`; const nonce = crypto.randomBytes(4).toString('hex');
out.sender = S.address.toLowerCase(); out.recipient_inbox = rAddr;
const cases = [
  { id: `dd-${nonce}-success`, to: 'success@simulator.amazonses.com', want: ['Send', 'Delivery'] },
  { id: `dd-${nonce}-bounce`, to: 'bounce@simulator.amazonses.com', want: ['Send', 'Bounce'] },
  { id: `dd-${nonce}-complaint`, to: 'complaint@simulator.amazonses.com', want: ['Send', 'Delivery', 'Complaint'] },
  { id: `dd-${nonce}-inbox`, to: rAddr, want: ['Send', 'Delivery'], inbox: true },
];
for (const c of cases) {
  c.subject = `delivery drill ${c.id}`; const r = await j('POST', '/api/messages/send-external', tS, { messageId: c.id, recipientEmail: c.to, subject: c.subject, body: `Delivery drill ${c.id}. No reply needed.` });
  c.send = { at: new Date().toISOString(), status: r.s, sesMessageId: r.x.sesMessageId || null, error: r.x.error || null };
  console.log(c.id, '→', c.to, r.s, r.x.sesMessageId || r.x.error);
}
const end = Date.now() + 8 * 60000;
while (Date.now() < end && cases.some((c) => !c.done)) {
  for (const c of cases.filter((c) => !c.done)) {
    const o = await j('GET', '/api/messages/outbox/' + c.id, tS); c.outbox = { state: o.x.state, sesMessageId: o.x.sesMessageId, events: o.x.events };
    const types = new Set((o.x.events || []).map((e) => e.eventType));
    let inboxOk = !c.inbox;
    if (c.inbox) { const ib = await j('GET', '/api/messages/inbox', tR); const m = (ib.x.emails || []).find((e) => e.subject === c.subject); if (m) { c.received = { inboxId: m.id, from: m.from, receivedAt: m.receivedAt, bodyMatches: m.body.includes(c.id) }; inboxOk = true; } }
    if (c.want.every((t) => types.has(t)) && inboxOk) { c.done = new Date().toISOString(); console.log('done', c.id, [...types].join(','), c.received ? 'received ' + c.received.inboxId : ''); }
  }
  if (cases.some((c) => !c.done)) await sleep(10000);
}
for (const c of cases) {
  const ev = c.outbox?.events || []; const ids = new Set(ev.map((e) => e.sesMessageId));
  c.checks = { api_accepted: c.send.status === 200, outbox_sent: c.outbox?.state === 'sent', expected_events: c.want.every((t) => ev.some((e) => e.eventType === t)),
    one_ses_message: ids.size === 1 && ids.has(c.send.sesMessageId) && c.outbox?.sesMessageId === c.send.sesMessageId, ...(c.inbox ? { received_in_test_inbox: !!c.received?.bodyMatches } : {}) };
  c.passed = Object.values(c.checks).every(Boolean); out.cases.push(c);
}
// retry of every case: never a second submission
for (const c of cases) { const r = await j('POST', '/api/messages/send-external', tS, { messageId: c.id, recipientEmail: c.to, subject: c.subject, body: `Delivery drill ${c.id}. No reply needed.` }); c.retry = { status: r.s, duplicate: !!r.x.duplicate, sesMessageId: r.x.sesMessageId || null }; c.checks.retry_not_resent = r.s === 200 && r.x.duplicate === true && r.x.sesMessageId === c.send.sesMessageId; c.passed = c.passed && c.checks.retry_not_resent; }
out.cleanup = { sender_logout_all: (await j('POST', '/api/auth/logout-all', tS, {})).s, recipient_logout_all: (await j('POST', '/api/auth/logout-all', tR, {})).s };
out.finished_at = new Date().toISOString(); out.passed = out.cases.filter((c) => c.passed).length; out.failed = out.cases.length - out.passed;
out.not_covered = 'DeliveryDelay: the SES mailbox simulator has no address that produces a delay notification; the event type is subscribed and indexed (local test), but not exercised live.';
fs.writeFileSync(process.argv[2] || 'delivery.json', JSON.stringify(out, null, 1));
console.log(`SUMMARY passed=${out.passed} failed=${out.failed}`);
for (const c of out.cases) console.log(c.id, JSON.stringify(c.checks));
process.exit(out.failed ? 1 : 0);
