// orders.mjs — persistent x402 orders + receipts for sellers (node:sqlite, zero deps).
//
// Every paid request becomes an order row BEFORE the facilitator is asked to settle, keyed by the payment
// itself (one authorization = one order). That gives the buyer a way back to what they paid for:
//
//   • retry the SAME X-PAYMENT        → the original order: stored goods (re-delivery), never a second charge
//   • GET /orders/<order_id>          → status + receipt (tx, amount, payer, timestamps, compensation)
//
// States
//   settling → paid → delivered                       normal
//   settling → refused                                the facilitator refused and the chain proves it has NOT executed (yet);
//                                                     kept: the background only watches the chain (read-only, never re-submits)
//                                                     until it executes (→ paid) or can never execute (→ void). A retry by the
//                                                     buyer re-evaluates it.
//   settling/refused → void                           never executed and can never execute: not charged, ever
//   paid → refund_due → refund_sent → refunded        charged but undeliverable; 'refunded' only when the transfer is
//                     ↘ refund_manual → refund_sent   verified on chain. refund_manual = claimed by an operator (the
//                                                     automatic refunder never touches it), recorded with refund-record.
//
// When the outcome of a settlement cannot be PROVEN (facilitator unreachable, crashed mid-request, an ambiguous
// refusal, RPC errors, or chain data that does not prove either way), the order stays 'settling' — it is never dropped.
// Every status change that matters for money is a conditional update (WHERE status = expected), so a second writer
// (another process, the admin CLI) cannot apply the same transition twice. Deploy one seller process per orders.db.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { decodePaymentHeader, HttpError } from './limits.mjs';
import { refundTag } from './chain-recon.mjs';

// reasons an already-settled payment reports on re-verification; such a payment may be ours → ask /settle (idempotent)
export const CONSUMED_HINT = /already used|replay|bad nonce|revoked|expired|deadline|stale generation/i;
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',')}}`
  : JSON.stringify(typeof v === 'string' ? v.toLowerCase() : v);
const now = () => new Date().toISOString();
const REFUND_STATES = ['refund_due', 'refund_manual', 'refund_sent', 'refunded'];

/** One authorization can only ever settle once: exact = (asset, from, nonce); session = (wallet, key, generation, nonce). */
export function paymentKey(pp, requirements) {
  const p = pp.payload || {}, a = p.authorization || {};
  if (pp.scheme === 'dfmi-session') return ['session', p.wallet, p.sessionKey, a.generation ?? 'legacy', a.nonce].map((x) => String(x).toLowerCase()).join(':');
  return ['exact', requirements.asset, a.from, a.nonce].map((x) => String(x).toLowerCase()).join(':');
}
export const payloadHash = (pp) => createHash('sha256').update(stable({ scheme: pp.scheme, network: pp.network, payload: pp.payload })).digest('hex');
export const orderIdFor = (pp) => 'ord_' + payloadHash(pp).slice(0, 32);
/** where a refund for this order goes: the buyer's session wallet, or the EOA that signed the exact authorization */
export function refundTarget(o) {
  const pp = JSON.parse(o.payment || '{}').paymentPayload || {};
  return pp.scheme === 'dfmi-session' ? pp.payload?.wallet : pp.payload?.authorization?.from;
}

const REFUND_COLS = ['refund_to TEXT', 'refund_tx TEXT', 'refund_raw TEXT', 'refund_nonce INTEGER', 'refund_block INTEGER', 'refund_at TEXT', 'refunded_at TEXT', 'refund_by TEXT', 'recon TEXT',
  'refund_due_at TEXT', 'refund_from TEXT', 'refund_history TEXT'];

export function openOrders(file, { maxAttempts = 5, maxAgeMs = 24 * 3600_000 } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, payment_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
      resource TEXT NOT NULL, inputs TEXT, payer TEXT, amount TEXT, scheme TEXT,
      status TEXT NOT NULL, tx TEXT, block INTEGER, settle TEXT, goods TEXT, aux TEXT, payment TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      paid_at TEXT, delivered_at TEXT);
    CREATE INDEX IF NOT EXISTS orders_status ON orders(status);`);
  // in-place upgrade of order databases created before the refund lifecycle existed
  const have = new Set(db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name));
  for (const c of REFUND_COLS) if (!have.has(c.split(' ')[0])) db.exec(`ALTER TABLE orders ADD COLUMN ${c}`);
  // one refund transaction pays one order — compared case-insensitively (0xAB… and 0xab… are the same tx)
  db.exec(`DROP INDEX IF EXISTS orders_refund_tx;
    UPDATE orders SET refund_tx = lower(refund_tx) WHERE refund_tx IS NOT NULL AND refund_tx <> lower(refund_tx);
    CREATE UNIQUE INDEX IF NOT EXISTS orders_refund_tx_lc ON orders(lower(refund_tx)) WHERE refund_tx IS NOT NULL;`);
  // order ids by which a recovered order can also be found (a buyer's client may have encoded the same payment slightly
  // differently from the rebuilt one), and small persistent state such as the chain-recovery cursor. Both live in the
  // same database, so a restored backup brings back the matching cursor and the recovery rescans what the backup lacks.
  db.exec(`CREATE TABLE IF NOT EXISTS order_alias (alias TEXT PRIMARY KEY, id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE INDEX IF NOT EXISTS orders_tx_lc ON orders(lower(tx)) WHERE tx IS NOT NULL;`);
  const q = {
    byId: db.prepare('SELECT * FROM orders WHERE id = ?'),
    byTx: db.prepare('SELECT * FROM orders WHERE lower(tx) = lower(?)'),
    byRefundTx: db.prepare('SELECT id FROM orders WHERE lower(refund_tx) = lower(?)'),
    byAlias: db.prepare('SELECT o.* FROM order_alias a JOIN orders o ON o.id = a.id WHERE a.alias = ?'),
    addAlias: db.prepare('INSERT OR IGNORE INTO order_alias (alias, id) VALUES (?, ?)'),
    kvGet: db.prepare('SELECT v FROM kv WHERE k = ?'), kvSet: db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    maxBlock: db.prepare('SELECT max(block) AS b FROM orders WHERE block IS NOT NULL'),
    byKey: db.prepare('SELECT * FROM orders WHERE payment_key = ?'),
    insert: db.prepare(`INSERT OR IGNORE INTO orders (id, payment_key, payload_hash, resource, inputs, payer, amount, scheme, status, goods, payment)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'settling', ?, ?)`),
    set: (cols, cond) => db.prepare(`UPDATE orders SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?${cond ? ' AND status = ?' : ''}`),
    byStatus: db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at LIMIT ?'),
  };
  const setCache = new Map();
  const stmt = (cols, cond) => { const k = cols.join(',') + (cond ? '|c' : ''); if (!setCache.has(k)) setCache.set(k, q.set(cols, cond)); return setCache.get(k); };
  const update = (id, fields) => { const cols = Object.keys(fields); stmt(cols, false).run(...cols.map((c) => fields[c]), id); return q.byId.get(id); };
  /** conditional update: applied only while the row is still in status `from`; returns the new row, or null if someone else moved it */
  const transition = (id, from, fields) => { const cols = Object.keys(fields); const r = stmt(cols, true).run(...cols.map((c) => fields[c]), id, from); return r.changes ? q.byId.get(id) : null; };
  return {
    db, maxAttempts, maxAgeMs,
    get: (id) => q.byId.get(id) || q.byAlias.get(id), byKey: (k) => q.byKey.get(k), byTx: (tx) => q.byTx.get(tx),
    isRefundTx: (tx) => !!q.byRefundTx.get(tx), addAlias: (alias, id) => q.addAlias.run(alias, id),
    kv: (k, v) => { if (v === undefined) return q.kvGet.get(k)?.v ?? null; q.kvSet.run(k, String(v)); return v; },
    maxBlock: () => q.maxBlock.get()?.b ?? null,
    create: (o) => { q.insert.run(o.id, o.payment_key, o.payload_hash, o.resource, o.inputs ?? null, o.payer ?? null, o.amount ?? null, o.scheme ?? null, o.goods ?? null, o.payment ?? null); return q.byKey.get(o.payment_key); },
    update, transition, list: (status, limit = 100) => q.byStatus.all(status, limit),
    close: () => db.close(),
  };
}

/** Public receipt (never includes goods). */
export function receipt(o) {
  if (!o) return null;
  const notes = { refunded: 'Refunded: the transfer above is on chain.', refund_sent: 'Refund transaction sent; waiting for it to be confirmed on chain.',
    refund_manual: 'Paid but could not be delivered: an operator is refunding it; tracked until the transfer is on chain.',
    refund_due: 'Paid but could not be delivered: a refund to the payer is owed and tracked until it is on chain.' };
  const refund = REFUND_STATES.includes(o.status)
    ? { compensation: { status: o.status, owed_to: o.refund_to || refundTarget(o), amount_atomic: o.amount, refund_tx: o.refund_tx || null, refund_block: o.refund_block ?? null, refunded_at: o.refunded_at || null, note: notes[o.status] } }
    : {};
  return { order_id: o.id, status: o.status, resource: o.resource, amount_atomic: o.amount, payer: o.payer, scheme: o.scheme,
    transaction: o.tx, block: o.block, attempts: o.attempts, last_error: o.status === 'delivered' ? null : o.last_error,
    created_at: o.created_at, paid_at: o.paid_at, delivered_at: o.delivered_at, ...refund,
    ...(o.status === 'void' ? { charged: false, note: 'This payment was never settled and can no longer be: you were not charged.' } : {}),
    ...(o.status === 'refused' ? { charged: false, note: 'The facilitator refused this payment and it has not executed on chain. Send it again to retry.' } : {}),
    ...(o.status === 'paid' || o.status === 'settling' ? { retry: 'Send the same X-PAYMENT again (or GET this URL) to resume delivery. You will not be charged again.' } : {}) };
}

/**
 * makeGate({ orders, fac, log, chain, refunder }) → { handle, status, sweep, claimRefund, recordRefund, setRefunder }
 *   handle opts: { requirements, inputs, produce(ctx) → goods, produceFirst=false, send(code, obj, headers) }
 *   produce(ctx): ctx = { order, aux, saveAux(obj) } — saveAux persists state a resumed attempt must reuse
 *   fac(path, body) → facilitator JSON (throw = transient, e.g. network)
 *   chain (lib/chain-recon.mjs makeChain): the seller's own settlement check; without it nothing is ever judged
 *         "not charged" or "settled" except by the facilitator, and ambiguous orders simply stay kept.
 *   refunder (makeRefunder): pays refund_due orders automatically, one at a time; without it they are alerted until an
 *         operator claims and records a refund (orders-admin refund-claim / refund-record).
 *   refundSources: allowed senders of a manual refund (empty = any sender, still one matching transfer after the obligation).
 */
export function makeGate({ orders, fac, log = () => {}, statusBase = '/orders/', chain = null, refunder: refunder0 = null,
  reconAfterMs = 120_000, refundAlertMs = 3600_000, refundSources = [], alert = (m) => log(`ALERT ${m}`),
  recoverOffers = [], recoverGraceMs = 24 * 3600_000, recoverMinAgeMs = 120_000, recoverMaxBlocks = 50_000 }) {
  let refunder = refunder0;
  const isRecovered = (o) => !!(o.aux && JSON.parse(o.aux).recovered);
  function adoptPayment(o, pp, requirements, inputs, hash) {
    log(`order ${o.id}: recovered from chain; the buyer's X-PAYMENT replaces the rebuilt copy`);
    return orders.update(o.id, { payload_hash: hash, payment_key: paymentKey(pp, requirements), payment: JSON.stringify({ paymentPayload: pp, paymentRequirements: requirements }),
      ...(o.goods ? {} : { resource: requirements.resource }), ...(inputs && !o.inputs ? { inputs: JSON.stringify(inputs) } : {}) });
  }

  /**
   * Orders the database does not have (e.g. made after the backup it was restored from), rebuilt from the chain: every
   * payment to an offer's payTo since the recovery cursor that no order records becomes a 'paid' order with the original
   * transaction, findable under each id the buyer's client may have computed. Offers with mode 'deliver' (the product
   * needs no buyer inputs) are then produced by the sweep as usual; mode 'refund' waits recoverGraceMs for the buyer to
   * send the same X-PAYMENT again (which supplies the inputs and delivers), then it is refunded. Each payTo must belong
   * to this seller only. Payments younger than recoverMinAgeMs are left to the request that is settling them.
   */
  async function recoverFromChain() {
    if (!chain || !recoverOffers.length) return;
    const { n: head, ts: headTs } = await chain.head();
    const byPayTo = new Map();
    for (const off of recoverOffers) { const k = String(off.requirements.payTo).toLowerCase(); if (!byPayTo.has(k)) byPayTo.set(k, []); byPayTo.get(k).push(off); }
    for (const [payTo, offers] of byPayTo) {
      const ck = `recover_block:${payTo}`;
      let from = Number(orders.kv(ck) ?? (orders.maxBlock() ?? head));
      const to = Math.min(head, from + recoverMaxBlocks);
      if (to < from) continue;
      const found = await chain.scanPayments({ payTo, network: offers[0].requirements.network, fromBlock: Math.max(0, from - 20), toBlock: to });
      let safeTo = to;
      for (const p of found) {
        if (orders.byTx(p.tx)) continue;
        const reqs = offers.map((x) => x.requirements);
        if (p.candidates.some((pp) => orders.byKey(paymentKey(pp, reqs[0])) || orders.get(orderIdFor(pp)))) continue;    // a live request owns it
        const ts = await blockTsOf(p.block);
        if (headTs - ts < recoverMinAgeMs / 1000) { safeTo = Math.min(safeTo, p.block - 1); continue; }                    // look again next sweep
        const matches = offers.filter((x) => BigInt(x.requirements.maxAmountRequired) === BigInt(p.amount));
        const off = matches.length === 1 ? matches[0] : null;
        const req = off ? off.requirements : { ...reqs[0], resource: 'unknown (recovered from chain: no single offer has this price)' };
        const pp = p.candidates[0];
        const id = orderIdFor(pp);
        const o0 = orders.create({ id, payment_key: paymentKey(pp, req), payload_hash: payloadHash(pp), resource: req.resource, inputs: null, payer: p.payer, amount: p.amount, scheme: pp.scheme,
          payment: JSON.stringify({ paymentPayload: pp, paymentRequirements: req }) });
        if (!o0 || o0.id !== id) continue;
        for (const c of p.candidates) orders.addAlias(orderIdFor(c), id);
        const mode = off ? (off.mode || 'deliver') : 'refund';
        const o = orders.transition(id, 'settling', { status: 'paid', tx: p.tx, block: p.block, paid_at: new Date(ts * 1000).toISOString(),
          settle: JSON.stringify({ success: true, transaction: p.tx, blockNumber: p.block, network: req.network, payer: p.payer, recovered: 'chain' }),
          aux: JSON.stringify({ recovered: { at: now(), mode, tx: p.tx } }), recon: JSON.stringify({ at: now(), why: 'no order for a payment on chain', result: 'recovered', tx: p.tx }) });
        log(`order ${id}: recovered from chain (tx ${p.tx}, block ${p.block}, ${mode})`);
        if (o && mode === 'refund') alertOnce(id, `RECOVERED ORDER ${id}: paid on chain (tx ${p.tx}) but not in the database; delivered if the buyer retries within ${Math.round(recoverGraceMs / 3600_000)} h, refunded otherwise`);
      }
      orders.kv(ck, safeTo);
    }
  }
  const tsCache = new Map();
  async function blockTsOf(n) { if (!tsCache.has(n)) { const b = await chain.call('eth_getBlockByNumber', ['0x' + n.toString(16), false]); tsCache.set(n, Number(BigInt(b.timestamp))); } return tsCache.get(n); }

  const locks = new Map(); // order id → promise (one resume at a time per order in this process)
  const withLock = async (id, fn) => {
    while (locks.has(id)) { try { await locks.get(id); } catch {} }
    const p = (async () => fn())(); locks.set(id, p);
    try { return await p; } finally { if (locks.get(id) === p) locks.delete(id); }
  };
  const settleHeader = (o) => Buffer.from(JSON.stringify({ success: true, network: JSON.parse(o.settle || '{}').network, payer: o.payer, transaction: o.tx, blockNumber: o.block, orderId: o.id })).toString('base64');
  const hdrs = (o) => ({ 'X-ORDER-ID': o.id, 'X-ORDER-STATUS-URL': statusBase + o.id });
  const lastAlert = new Map();
  const alertOnce = (id, msg) => { if (Date.now() - (lastAlert.get(id) || 0) > refundAlertMs) { lastAlert.set(id, Date.now()); alert(msg); } };
  const history = (o, entry) => JSON.stringify([...(o.refund_history ? JSON.parse(o.refund_history) : []), { at: now(), ...entry }]);
  const sec = (iso) => Math.floor(Date.parse(iso) / 1000) || 0;

  function paidFromChain(o, r, why) {
    const req = JSON.parse(o.payment).paymentRequirements || {};
    log(`order ${o.id}: settlement found on chain (tx ${r.tx}, block ${r.block}) after: ${why}`);
    return orders.transition(o.id, o.status, { status: 'paid', tx: r.tx, block: r.block, paid_at: now(), last_error: null,
      settle: JSON.stringify({ success: true, transaction: r.tx, blockNumber: r.block, network: req.network, payer: o.payer, recovered: 'chain' }),
      recon: JSON.stringify({ at: now(), why, result: 'settled', tx: r.tx }) }) || orders.get(o.id);
  }

  /** ask the chain. Never drops an order whose outcome is not proven. */
  async function reconcileOrder(o, why) {
    if (!chain) return { o: orders.update(o.id, { last_error: `settlement outcome unknown: ${why} (order kept)` }), transient: true };
    let r;
    try { r = await chain.reconcile(o); }
    catch (e) { return { o: orders.update(o.id, { last_error: `settlement outcome unknown: ${why}; chain: ${e.message} (order kept)` }), transient: true }; }
    if (r.state === 'settled') return { o: paidFromChain(o, r, why) };
    if (r.final) {
      log(`order ${o.id}: void — ${why}; ${r.reason}`);
      return { o: orders.transition(o.id, o.status, { status: 'void', last_error: `${why}; ${r.reason} — not charged`, recon: JSON.stringify({ at: now(), why, result: 'void' }) }) || orders.get(o.id), voided: true };
    }
    return { o: orders.update(o.id, { last_error: `${why}; ${r.reason} (order kept)` }), transient: true, unsettled: true };
  }

  async function settleOrder(o, body, { sweep = false } = {}) {
    const age = Date.now() - Date.parse(o.created_at);
    let s;
    try { s = await fac('/settle', body); }
    catch (e) {
      const why = `facilitator unreachable: ${e.message}`;
      if (sweep && age > reconAfterMs) return reconcileOrder(o, why);
      return { o: orders.update(o.id, { last_error: why }), transient: true };
    }
    if (s && s.success) {
      return { o: orders.transition(o.id, 'settling', { status: 'paid', tx: s.transaction, block: s.blockNumber ?? null, payer: s.payer ?? o.payer, settle: JSON.stringify(s), paid_at: now(), last_error: null }) || orders.get(o.id) };
    }
    if (s && s.pending) {
      if (sweep && age > reconAfterMs) return reconcileOrder(o, 'settlement pending at the facilitator');
      return { o: orders.update(o.id, { last_error: 'settlement pending on chain' }), transient: true };
    }
    const reason = String(s?.error || 'settlement failed');
    if (chain) {
      const r = await reconcileOrder(o, `facilitator refused: ${reason}`);
      if (!r.unsettled) return r;                      // settled (recovered), void, or unknown (kept as settling)
      // proven not executed, but it still COULD execute (deadline not passed): keep it, watch the chain, never re-submit
      return { o: orders.transition(o.id, 'settling', { status: 'refused', last_error: reason }) || orders.get(o.id), refused: reason };
    }
    // no chain to ask: a refusal that also fits "already settled" is ambiguous → keep the order as settling
    if (CONSUMED_HINT.test(reason)) return { o: orders.update(o.id, { last_error: `settlement outcome unknown: ${reason} (order kept; configure the chain check to resolve it)` }), transient: true };
    return { o: orders.transition(o.id, 'settling', { status: 'refused', last_error: reason }) || orders.get(o.id), refused: reason };
  }

  // Only the writer that commits paid -> delivered owns this best-effort callback.
  // Returning an already delivered row (including a concurrent winner's row) must not repeat it.
  function completeDelivery(o, fields, onDelivered) {
    const delivered = orders.transition(o.id, 'paid', { status: 'delivered', ...fields });
    if (delivered && onDelivered) { try { onDelivered(delivered); } catch (e) { log(`onDelivered: ${e.message}`); } }
    return delivered || orders.get(o.id);
  }

  async function produceOrder(o, produce, onDelivered) {
    const aux = o.aux ? JSON.parse(o.aux) : {};
    const ctx = { order: o, aux, saveAux: (x) => { Object.assign(aux, x); orders.update(o.id, { aux: JSON.stringify(aux) }); } };
    try {
      const goods = await produce(ctx);
      if (goods === undefined || goods === null) throw new Error('producer returned no goods');
      if (typeof goods === 'object' && Object.prototype.hasOwnProperty.call(goods, 'error')) throw new Error(`producer returned an error instead of goods: ${String(goods.error).slice(0, 200)}`); // never store an error as delivered
      return completeDelivery(o, { goods: JSON.stringify(goods), delivered_at: now(), attempts: o.attempts + 1, last_error: null }, onDelivered);
    } catch (e) {
      const attempts = o.attempts + 1;
      const old = Date.now() - Date.parse(o.paid_at || o.created_at) > orders.maxAgeMs;
      const giveUp = attempts >= orders.maxAttempts || old;
      log(`order ${o.id}: delivery attempt ${attempts} failed: ${e.message}${giveUp ? ' → refund_due' : ''}`);
      return orders.transition(o.id, 'paid', { status: giveUp ? 'refund_due' : 'paid', attempts, last_error: String(e.message).slice(0, 300), ...(giveUp ? { refund_to: refundTarget(o), refund_due_at: now() } : {}) }) || orders.get(o.id);
    }
  }

  function respond(o, send, extra = {}) {
    if (o.status === 'delivered') return send(200, JSON.parse(o.goods), { 'X-PAYMENT-RESPONSE': settleHeader(o), ...hdrs(o), ...extra });
    if (REFUND_STATES.includes(o.status)) return send(409, { error: `paid but not deliverable; refund ${o.status === 'refunded' ? 'completed' : 'in progress'}`, order: receipt(o) }, hdrs(o));
    if (o.status === 'void') return send(402, { x402Version: 1, error: 'this payment was never settled and can no longer be; you were not charged', order: receipt(o) }, hdrs(o));
    if (o.status === 'refused' || o.status === 'failed') return send(402, { x402Version: 1, error: `payment invalid: ${o.last_error}`, order: receipt(o) }, hdrs(o));
    // settling / paid: charged or maybe charged, goods not yet produced → retryable, never ask to pay again
    return send(503, { error: 'payment recorded, delivery not finished yet — retry with the same X-PAYMENT', order: receipt(o) }, { 'retry-after': '5', ...hdrs(o) });
  }

  async function advance(o, body, produce, produceFirst, opts = {}) {
    if (o.status === 'settling') {
      const r = await settleOrder(o, body, opts);
      o = r.o;
      if (r.refused || r.transient || r.voided) return o;
      if (produceFirst && o.goods && o.status === 'paid') return completeDelivery(o, { delivered_at: now() }, opts.onDelivered);
    }
    if (o.status === 'paid') o = await produceOrder(o, produce, opts.onDelivered);
    return o;
  }

  // ---------- compensation ----------
  async function refundStep(o) {
    const to = o.refund_to || refundTarget(o);
    const notBefore = sec(o.refund_due_at || o.paid_at || o.created_at);
    if (o.status === 'refund_due') {
      if (refunder && chain) {
        // one automatic refund in flight at a time: the hot wallet's nonces are never raced
        if (orders.list('refund_sent', 500).some((x) => x.refund_raw)) return o;
        // a restored or stale row may owe a refund that was in fact paid after the backup: ask the chain first
        const tag = refundTag(o.id);
        const prior = await chain.findRefund({ froms: [refunder.address, ...refundSources], to, minAmount: o.amount, sinceTs: notBefore, tag, isKnownRefund: (tx) => orders.isRefundTx(tx) });
        const found = prior.tagged || prior.untagged[0];
        if (found) {
          const how = prior.tagged ? 'found-on-chain' : 'found-untagged-on-chain';
          if (!prior.tagged) alertOnce(o.id, `REFUND ASSUMED PAID order ${o.id}: an untagged transfer ${found.tx} of at least ${o.amount} to ${to} after the obligation is taken as its refund (nothing paid); check it`);
          log(`order ${o.id}: refund already on chain (tx ${found.tx}, block ${found.block}, ${how}) — not paying again`);
          return orders.transition(o.id, 'refund_due', { status: 'refunded', refund_to: to, refund_tx: found.tx, refund_block: found.block, refund_from: found.from, refund_at: now(), refunded_at: now(), refund_by: `chain:${how}`, last_error: null,
            refund_history: history(o, { event: how, tx: found.tx, block: found.block }) }) || orders.get(o.id);
        }
        const p = await refunder.prepare(to, o.amount, 0, tag);
        const n = orders.transition(o.id, 'refund_due', { status: 'refund_sent', refund_to: to, refund_tx: p.tx, refund_raw: p.raw, refund_nonce: p.nonce, refund_at: now(), refund_by: `auto:${refunder.address}`, last_error: null,
          refund_history: history(o, { event: 'prepared', tx: p.tx, nonce: p.nonce }) });
        if (!n) return orders.get(o.id);                // someone else (an operator claim) moved it first
        log(`order ${o.id}: refund ${o.amount} → ${to} sent (tx ${p.tx}, nonce ${p.nonce})`);
        await refunder.broadcast(p.raw).catch((e) => log(`order ${o.id}: refund broadcast failed, will retry the same tx: ${e.message}`));
        return n;
      }
      if (Date.now() - sec(o.refund_due_at || o.updated_at) * 1000 > refundAlertMs) alertOnce(o.id, `REFUND OVERDUE order ${o.id}: owes ${o.amount} (atomic) to ${to} since ${o.refund_due_at || o.updated_at}; claim it (orders-admin refund-claim ${o.id}), pay it, then orders-admin refund-record ${o.id} <tx>`);
      return o;
    }
    if (o.status === 'refund_manual') {
      if (Date.now() - sec(o.updated_at) * 1000 > refundAlertMs) alertOnce(o.id, `REFUND CLAIMED BUT NOT RECORDED order ${o.id}: owes ${o.amount} to ${to}; record the transfer with orders-admin refund-record ${o.id} <tx>`);
      return o;
    }
    if (o.status !== 'refund_sent' || !chain) return o;
    const v = await chain.verifyRefund({ tx: o.refund_tx, to, minAmount: o.amount, notBefore, allowedFrom: o.refund_raw ? null : (refundSources.length ? refundSources : null) });
    if (v.ok) {
      log(`order ${o.id}: refunded (tx ${o.refund_tx}, block ${v.block})`);
      return orders.transition(o.id, 'refund_sent', { status: 'refunded', refund_block: v.block, refund_from: v.from, refunded_at: now(), refund_raw: null, last_error: null, refund_history: history(o, { event: 'confirmed', tx: o.refund_tx, block: v.block }) }) || orders.get(o.id);
    }
    if (!o.refund_raw) {
      // operator-recorded refund: never reset automatically (that could lead to paying twice) — alert until it resolves
      if (v.reverted || (!v.pending && !v.unknown)) alertOnce(o.id, `REFUND TX NOT VALID order ${o.id}: ${o.refund_tx}: ${v.reason}; fix with orders-admin`);
      else if (Date.now() - sec(o.refund_at || o.updated_at) * 1000 > refundAlertMs) alertOnce(o.id, `REFUND NOT CONFIRMED order ${o.id}: ${o.refund_tx} ${v.reason}`);
      return o;
    }
    // our own signed refund that is not confirmed (yet)
    if (v.reverted) return redoRefund(o, `refund tx ${o.refund_tx} reverted`);       // a mined, failed tx paid nothing
    if (v.ok === false && !v.pending && !v.unknown) return redoRefund(o, `refund tx ${o.refund_tx} does not pay the order: ${v.reason}`);
    const acct = refunder ? await chain.accountNonce(refunder.address, 'latest') : 0;
    if (refunder && acct > Number(o.refund_nonce)) {
      // our nonce is consumed. By our tx (receipt not visible yet) or by another one? Never guess: look for the transfer itself.
      const again = await chain.verifyRefund({ tx: o.refund_tx, to, minAmount: o.amount, notBefore });
      if (again.ok) return orders.transition(o.id, 'refund_sent', { status: 'refunded', refund_block: again.block, refund_from: again.from, refunded_at: now(), refund_raw: null, last_error: null, refund_history: history(o, { event: 'confirmed', tx: o.refund_tx, block: again.block }) }) || orders.get(o.id);
      const t = await chain.findTransfer({ from: refunder.address, to, minAmount: o.amount, sinceTs: sec(o.refund_at || o.updated_at) });
      if (t) return orders.transition(o.id, 'refund_sent', { status: 'refunded', refund_tx: t.tx, refund_block: t.block, refund_from: refunder.address, refunded_at: now(), refund_raw: null, last_error: null,
        refund_history: history(o, { event: 'confirmed-by-transfer', tx: t.tx, block: t.block, replaced: o.refund_tx }) }) || orders.get(o.id);
      return redoRefund(o, `refund tx ${o.refund_tx} was never mined and its nonce ${o.refund_nonce} is used by another transaction`);
    }
    // still possible to land: re-broadcast the SAME signed bytes, never a new refund
    if (refunder) await refunder.broadcast(o.refund_raw).catch(() => {});
    if (Date.now() - sec(o.refund_at || o.updated_at) * 1000 > refundAlertMs) alertOnce(o.id, `REFUND NOT MINED order ${o.id}: tx ${o.refund_tx} (${v.reason})`);
    return o;
  }
  function redoRefund(o, why) {
    log(`order ${o.id}: ${why} — a new refund will be prepared`);
    return orders.transition(o.id, 'refund_sent', { status: 'refund_due', refund_tx: null, refund_raw: null, refund_nonce: null, last_error: why, refund_history: history(o, { event: 'abandoned', tx: o.refund_tx, why }) }) || orders.get(o.id);
  }

  return {
    async handle(req, res, { requirements, inputs = null, produce, produceFirst = false, send, onDelivered = null }) {
      let pp;
      try { pp = decodePaymentHeader(req.headers['x-payment']); }
      catch (e) { return send(e.status || 400, { x402Version: 1, error: e.message, accepts: [requirements] }); }
      const key = paymentKey(pp, requirements), hash = payloadHash(pp), id = orderIdFor(pp);
      const body = { paymentPayload: pp, paymentRequirements: requirements };

      let o = orders.byKey(key) || orders.get(id);
      // an order rebuilt from the chain after a restore: the buyer's own X-PAYMENT is the authoritative copy of it
      if (o && o.payload_hash !== hash && isRecovered(o) && (o.payment_key === key || orders.get(id)?.id === o.id)) o = adoptPayment(o, pp, requirements, inputs, hash);
      // a refused (never executed) attempt does not own its nonce: a corrected payment with the same nonce replaces it
      if (o && (o.status === 'refused' || o.status === 'failed') && o.payload_hash !== hash) { orders.db.prepare('DELETE FROM orders WHERE id = ? AND status = ?').run(o.id, o.status); o = null; }
      if (o && o.payload_hash !== hash) return send(409, { x402Version: 1, error: 'this authorization (nonce) already belongs to a different payment', accepts: [requirements] });
      if (o && isRecovered(o) && o.resource !== requirements.resource && !o.goods) o = orders.update(o.id, { resource: requirements.resource });
      if (o && isRecovered(o) && !o.inputs && inputs) o = orders.update(o.id, { inputs: JSON.stringify(inputs) });
      if (o && o.resource !== requirements.resource) return send(409, { error: 'this payment was made for a different resource', order: receipt(o) }, hdrs(o));
      // the buyer sends a refused payment again (e.g. after a top-up): evaluate it once more
      if (o && (o.status === 'refused' || o.status === 'failed')) o = orders.transition(o.id, o.status, { status: 'settling' }) || orders.get(o.id);

      if (!o) {
        let v;
        try { v = await fac('/verify', body); } catch (e) { return send(503, { error: `facilitator unreachable: ${e.message}` }, { 'retry-after': '5' }); }
        const usedButMaybeOurs = !v.isValid && CONSUMED_HINT.test(String(v.invalidReason || ''));
        if (!v.isValid && !usedButMaybeOurs) return send(402, { x402Version: 1, error: `payment invalid: ${v.invalidReason}`, accepts: [requirements] });
        let goods = null;
        if (produceFirst && !usedButMaybeOurs) {
          try { goods = JSON.stringify(await produce({ order: null, aux: {}, saveAux: () => {} })); }
          catch (e) { return send(502, { x402Version: 1, error: `could not produce the goods (${e.message}) — you were not charged`, accepts: [requirements] }); }
        }
        o = orders.create({ id, payment_key: key, payload_hash: hash, resource: requirements.resource, inputs: inputs ? JSON.stringify(inputs) : null,
          payer: v.payer ?? pp.payload?.authorization?.from ?? pp.payload?.wallet ?? null,
          amount: String(pp.payload?.authorization?.value ?? pp.payload?.authorization?.amount ?? ''), scheme: pp.scheme, goods, payment: JSON.stringify(body) });
        if (o.payload_hash !== hash) return send(409, { x402Version: 1, error: 'this authorization (nonce) already belongs to a different payment', accepts: [requirements] });
        if (usedButMaybeOurs) log(`order ${o.id}: verify says "${v.invalidReason}" — asking the facilitator whether it settled this exact payment`);
      }
      let redelivery = false;
      o = await withLock(o.id, async () => {
        const current = orders.get(o.id);
        redelivery = current.status === 'delivered';
        return advance(current, body, produce, produceFirst, { onDelivered });
      });
      if (o.status === 'delivered') log(`order ${o.id} ${redelivery ? 're-delivered' : 'delivered'} (tx ${o.tx})`);
      return respond(o, send, redelivery ? { 'X-REDELIVERY': 'true' } : {});
    },

    /** GET /orders/<id>: receipt + status; resumes nothing (cheap, safe to poll). */
    status(id, send) {
      if (!/^ord_[0-9a-f]{32}$/.test(String(id))) return send(404, { error: 'unknown order' });
      const o = orders.get(id);
      if (!o) return send(404, { error: 'unknown order' });
      return send(200, receipt(o));
    },

    /** Background work: resume abandoned orders, reconcile unproven outcomes, watch refused ones, drive refunds. */
    async sweep({ produceFor, olderThanMs = 30_000 }) {
      try { await recoverFromChain(); } catch (e) { log(`recovery from chain: ${e.message} (will retry)`); }
      for (const st of ['settling', 'paid']) {
        for (const row of orders.list(st, 50)) {
          if (!row.payment) continue;
          const rec = row.aux ? JSON.parse(row.aux).recovered : null;
          if (st === 'paid' && rec && rec.mode === 'refund' && !row.inputs) {
            if (Date.now() - Date.parse(rec.at) > recoverGraceMs) await withLock(row.id, async () => {
              log(`order ${row.id}: recovered from chain, the buyer did not come back within the grace period → refund_due`);
              orders.transition(row.id, 'paid', { status: 'refund_due', refund_to: refundTarget(row), refund_due_at: now(), last_error: 'recovered from chain; what was bought is unknown' });
            });
            continue;
          }
          if (!rec && Date.now() - Date.parse(row.updated_at) < olderThanMs) continue;
          const produce = produceFor(row);
          if (!produce && st === 'paid') continue;
          await withLock(row.id, async () => {
            const o = orders.get(row.id);
            if (o.status === 'settling' && !produce) return settleOrder(o, JSON.parse(o.payment), { sweep: true }); // settle/reconcile only
            if (o.status === 'settling' || o.status === 'paid') await advance(o, JSON.parse(o.payment), produce, !!o.goods, { sweep: true });
          });
        }
      }
      // refused: read-only chain watch — executed after all (someone else relayed it) → paid → delivered; can never execute → void
      if (chain) for (const row of orders.list('refused', 50)) {
        if (Date.now() - Date.parse(row.updated_at) < olderThanMs) continue;
        await withLock(row.id, async () => {
          const o = orders.get(row.id); if (o.status !== 'refused') return;
          const r = await reconcileOrder(o, `refused by the facilitator (${o.last_error})`);
          if (r.o.status === 'paid') { const produce = produceFor(r.o); if (produce) await produceOrder(r.o, produce); }
          else if (r.o.status === 'refused') orders.update(o.id, { last_error: o.last_error }); // bump updated_at: next check later
        });
      }
      for (const st of ['refund_due', 'refund_manual', 'refund_sent']) {
        for (const row of orders.list(st, 50)) {
          try { await withLock(row.id, async () => refundStep(orders.get(row.id))); }
          catch (e) { log(`order ${row.id}: refund step failed: ${e.message}`); }
        }
      }
    },

    /** An operator takes over a refund: the automatic refunder will not touch it. */
    async claimRefund(id, by = 'operator') {
      return withLock(id, async () => {
        const o = orders.get(id); if (!o) throw new Error('unknown order');
        const n = orders.transition(id, 'refund_due', { status: 'refund_manual', refund_by: by, last_error: null, refund_history: history(o, { event: 'claimed', by }) });
        if (!n) throw new Error(`order is ${o.status}, not refund_due`);
        return n;
      });
    },
    /** The operator paid: accept it only if the chain shows ONE transfer to the payer, after the obligation, from an allowed sender. */
    async recordRefund(id, tx, by = 'operator') {
      if (!chain) throw new Error('no chain configured: a refund can only be recorded once it is verified on chain');
      tx = String(tx).toLowerCase();
      return withLock(id, async () => {
        const o = orders.get(id);
        if (!o) throw new Error('unknown order');
        if (o.status !== 'refund_manual') throw new Error(`order is ${o.status}; claim it first (refund-claim), so the automatic refunder cannot pay it too`);
        const to = o.refund_to || refundTarget(o);
        const v = await chain.verifyRefund({ tx, to, minAmount: o.amount, notBefore: sec(o.refund_due_at || o.paid_at || o.created_at), allowedFrom: refundSources.length ? refundSources : null });
        if (!v.ok && !v.pending) throw new Error(`refund not accepted: ${v.reason}`);
        try {
          const n = v.ok
            ? orders.transition(id, 'refund_manual', { status: 'refunded', refund_to: to, refund_tx: tx, refund_block: v.block, refund_from: v.from, refund_at: now(), refunded_at: now(), refund_by: by, last_error: null, refund_history: history(o, { event: 'recorded', tx, block: v.block, from: v.from }) })
            : orders.transition(id, 'refund_manual', { status: 'refund_sent', refund_to: to, refund_tx: tx, refund_at: now(), refund_by: by, last_error: null, refund_history: history(o, { event: 'recorded-pending', tx }) });
          if (!n) throw new Error('order changed while recording; try again');
          return n;
        } catch (e) { if (/UNIQUE/.test(e.message)) throw new Error('that transaction is already recorded as the refund of another order'); throw e; }
      });
    },
    setRefunder(r) { refunder = r; },
    respond, receipt,
  };
}

export const newReceiptToken = () => randomBytes(16).toString('hex');
export { HttpError };
