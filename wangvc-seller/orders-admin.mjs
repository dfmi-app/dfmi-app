#!/usr/bin/env node
// orders-admin.mjs — operator view of a seller's orders.db and its compensation queue. Never moves money itself.
//   node orders-admin.mjs list    --db <orders.db> [--status <status>] [--limit 50]
//   node orders-admin.mjs show    --db <orders.db> <order_id>
//   node orders-admin.mjs refunds --db <orders.db>                       every order owed / being / already refunded, with age
//   node orders-admin.mjs retry   --db <orders.db> <order_id>            refund_due → paid (delivery is retried; only before any refund was sent)
//   node orders-admin.mjs refund-record --db <orders.db> --cfg <dfmi.json> <order_id> <refund_tx>
//        record a refund paid by hand. Accepted only if the chain shows a dUSD transfer of at least the order amount
//        to the payer (mined → refunded; still pending → refund_sent, the seller's sweeper confirms it later).
// Exit code of `refunds`: 1 while any refund is owed for longer than --max-age-h (default 24), so cron/monitoring can page.
import { readFileSync } from 'node:fs';
import { openOrders, makeGate, refundTarget } from './x402-lib/orders.mjs';
import { makeChain } from './x402-lib/chain-recon.mjs';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i > -1 ? args.splice(i, 2)[1] : d; };
const dbFile = opt('--db'); const status = opt('--status', null); const limit = Number(opt('--limit', 50));
const cfgFile = opt('--cfg', null); const maxAgeH = Number(opt('--max-age-h', 24));
const [cmd, id, extra] = args;
if (!dbFile || !cmd) { console.error('usage: orders-admin.mjs list|show|refunds|retry|refund-record --db <orders.db> …'); process.exit(2); }
const orders = openOrders(dbFile);
const db = orders.db;
const pub = (o) => ({ id: o.id, status: o.status, resource: o.resource, payer: o.payer, amount: o.amount, tx: o.tx, attempts: o.attempts, last_error: o.last_error,
  created_at: o.created_at, paid_at: o.paid_at, delivered_at: o.delivered_at, inputs: o.inputs,
  ...(o.refund_to || o.refund_tx ? { refund: { to: o.refund_to, tx: o.refund_tx, block: o.refund_block, sent_at: o.refund_at, refunded_at: o.refunded_at, by: o.refund_by } } : {}) });

if (cmd === 'list') {
  const rows = status ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at LIMIT ?').all(status, limit) : db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit);
  for (const o of rows) console.log(JSON.stringify(pub(o)));
  const c = db.prepare('SELECT status, COUNT(*) n FROM orders GROUP BY status').all();
  console.error('counts:', c.map((r) => `${r.status}=${r.n}`).join(' ') || 'none');
} else if (cmd === 'show') {
  const o = orders.get(id); console.log(o ? JSON.stringify(pub(o), null, 1) : 'not found');
} else if (cmd === 'refunds') {
  const rows = db.prepare(`SELECT * FROM orders WHERE status IN ('refund_due','refund_sent','refunded') ORDER BY status, updated_at`).all();
  let overdue = 0;
  for (const o of rows) {
    const ageH = (Date.now() - Date.parse(o.status === 'refunded' ? o.refunded_at || o.updated_at : o.updated_at)) / 3600_000;
    if (o.status !== 'refunded' && ageH > maxAgeH) overdue++;
    console.log(`${o.status.padEnd(11)} ${o.id}  owes ${o.amount} → ${o.refund_to || refundTarget(o)}  ${o.refund_tx ? 'tx ' + o.refund_tx : 'no refund tx yet'}  ${o.status === 'refunded' ? 'done ' + o.refunded_at : `open ${ageH.toFixed(1)} h`}`);
  }
  const c = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) n FROM orders WHERE status IN ('refund_due','refund_sent','refunded') GROUP BY status`).all().map((r) => [r.status, r.n]));
  console.error(`refund_due=${c.refund_due || 0} refund_sent=${c.refund_sent || 0} refunded=${c.refunded || 0} overdue(>${maxAgeH}h)=${overdue}`);
  process.exitCode = overdue ? 1 : 0;
} else if (cmd === 'retry') {
  const r = db.prepare(`UPDATE orders SET status='paid', attempts=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'refund_due' AND refund_tx IS NULL`).run(id);
  console.log(r.changes ? 'requeued for delivery' : 'not in refund_due (or a refund was already sent)');
} else if (cmd === 'refund-record') {
  if (!cfgFile) { console.error('refund-record needs --cfg <dfmi.json> (rpc + token) to verify the refund on chain'); process.exit(2); }
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  const gate = makeGate({ orders, fac: null, chain: makeChain({ rpc: cfg.rpc, token: cfg.token, insecure: !!cfg.insecure }) });
  try {
    const o = await gate.recordRefund(id, extra, 'operator');
    console.log(`${o.status}: order ${o.id} refund tx ${o.refund_tx}${o.refund_block ? ' (block ' + o.refund_block + ')' : ' (pending; the seller confirms it once mined)'}`);
  } catch (e) { console.error(`rejected: ${e.message}`); process.exitCode = 1; }
} else { console.error('unknown command'); process.exit(2); }
orders.close();
