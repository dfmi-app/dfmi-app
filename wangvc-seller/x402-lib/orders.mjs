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
//   settling → failed                                 the facilitator refused AND the chain shows no settlement: not charged
//   settling → void                                   never settled and the authorization has expired: not charged, ever
//   paid     → refund_due → refund_sent → refunded    charged but undeliverable; refunded = a dUSD transfer to the payer,
//                                                     verified on chain (never just an operator's word)
//
// When the outcome of a settlement is UNKNOWN (facilitator unreachable, crashed mid-request, or it answers with a
// refusal that also fits "already settled" such as "authorization already used"), the order stays 'settling'. The
// sweeper asks the facilitator again (/settle is idempotent) and, if that does not settle it, reconciles against the
// chain itself (lib/chain-recon.mjs): found → 'paid' with the ORIGINAL tx, then delivery resumes; expired and not
// found → 'void'. A paid order is therefore never dropped because one party lost its memory.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { decodePaymentHeader, HttpError } from './limits.mjs';

// reasons an already-settled payment reports on re-verification; such a payment may be ours → ask /settle (idempotent)
export const CONSUMED_HINT = /already used|replay|bad nonce|revoked|expired|deadline|stale generation/i;
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',')}}`
  : JSON.stringify(typeof v === 'string' ? v.toLowerCase() : v);
const now = () => new Date().toISOString();

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

const REFUND_COLS = ['refund_to TEXT', 'refund_tx TEXT', 'refund_raw TEXT', 'refund_nonce INTEGER', 'refund_block INTEGER', 'refund_at TEXT', 'refunded_at TEXT', 'refund_by TEXT', 'recon TEXT'];

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
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS orders_refund_tx ON orders(refund_tx) WHERE refund_tx IS NOT NULL`); // one refund tx pays one order
  const q = {
    byId: db.prepare('SELECT * FROM orders WHERE id = ?'),
    byKey: db.prepare('SELECT * FROM orders WHERE payment_key = ?'),
    insert: db.prepare(`INSERT OR IGNORE INTO orders (id, payment_key, payload_hash, resource, inputs, payer, amount, scheme, status, goods, payment)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'settling', ?, ?)`),
    set: (cols) => db.prepare(`UPDATE orders SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`),
    byStatus: db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at LIMIT ?'),
  };
  const setCache = new Map();
  const update = (id, fields) => { const cols = Object.keys(fields); const k = cols.join(','); if (!setCache.has(k)) setCache.set(k, q.set(cols)); setCache.get(k).run(...cols.map((c) => fields[c]), id); return q.byId.get(id); };
  return {
    db, maxAttempts, maxAgeMs,
    get: (id) => q.byId.get(id), byKey: (k) => q.byKey.get(k),
    create: (o) => { q.insert.run(o.id, o.payment_key, o.payload_hash, o.resource, o.inputs ?? null, o.payer ?? null, o.amount ?? null, o.scheme ?? null, o.goods ?? null, o.payment ?? null); return q.byKey.get(o.payment_key); },
    update, list: (status, limit = 100) => q.byStatus.all(status, limit),
    close: () => db.close(),
  };
}

/** Public receipt (never includes goods). */
export function receipt(o) {
  if (!o) return null;
  const refund = ['refund_due', 'refund_sent', 'refunded'].includes(o.status)
    ? { compensation: { status: o.status, owed_to: o.refund_to || refundTarget(o), amount_atomic: o.amount, refund_tx: o.refund_tx || null, refund_block: o.refund_block ?? null, refunded_at: o.refunded_at || null,
        note: o.status === 'refunded' ? 'Refunded: the transfer above is on chain.' : o.status === 'refund_sent' ? 'Refund transaction sent; waiting for it to be mined.' : 'Paid but could not be delivered: a refund to the payer is owed and tracked until it is on chain.' } }
    : {};
  return { order_id: o.id, status: o.status, resource: o.resource, amount_atomic: o.amount, payer: o.payer, scheme: o.scheme,
    transaction: o.tx, block: o.block, attempts: o.attempts, last_error: o.status === 'delivered' ? null : o.last_error,
    created_at: o.created_at, paid_at: o.paid_at, delivered_at: o.delivered_at, ...refund,
    ...(o.status === 'void' ? { charged: false, note: 'This payment was never settled and its authorization has expired: you were not charged.' } : {}),
    ...(o.status === 'paid' || o.status === 'settling' ? { retry: 'Send the same X-PAYMENT again (or GET this URL) to resume delivery. You will not be charged again.' } : {}) };
}

/**
 * makeGate({ orders, fac, log, chain, refunder }) → { handle(req, res, opts), status(id, send), sweep({produceFor}), recordRefund(id, tx) }
 *   opts: { requirements, inputs, produce(ctx) → goods, produceFirst=false, send(code, obj, headers) }
 *   produce(ctx): ctx = { order, aux, saveAux(obj) } — saveAux persists state a resumed attempt must reuse
 *                 (the storefront stores its upstream X-PAYMENT there so a retry re-uses the same upstream payment).
 *   fac(path, body) → facilitator JSON (throw = transient, e.g. network)
 *   chain (optional, lib/chain-recon.mjs makeChain): the seller's own settlement check — without it an ambiguous
 *         refusal still keeps the order, but nothing can prove "settled" or "never settled" except the facilitator.
 *   refunder (optional, makeRefunder): pays refund_due orders automatically; without it they are alerted until an
 *         operator records a refund that verifies on chain (recordRefund / scripts/orders-admin.mjs refund-record).
 */
export function makeGate({ orders, fac, log = () => {}, statusBase = '/orders/', chain = null, refunder: refunder0 = null,
  reconAfterMs = 120_000, refundAlertMs = 3600_000, alert = (m) => log(`ALERT ${m}`) }) {
  let refunder = refunder0;
  const locks = new Map(); // order id → promise (one resume at a time per order in this process)
  const withLock = async (id, fn) => {
    while (locks.has(id)) { try { await locks.get(id); } catch {} }
    const p = (async () => fn())(); locks.set(id, p);
    try { return await p; } finally { if (locks.get(id) === p) locks.delete(id); }
  };
  const settleHeader = (o) => Buffer.from(JSON.stringify({ success: true, network: JSON.parse(o.settle || '{}').network, payer: o.payer, transaction: o.tx, blockNumber: o.block, orderId: o.id })).toString('base64');
  const hdrs = (o) => ({ 'X-ORDER-ID': o.id, 'X-ORDER-STATUS-URL': statusBase + o.id });
  const lastAlert = new Map();

  function paidFromChain(o, r, why) {
    const req = JSON.parse(o.payment).paymentRequirements || {};
    log(`order ${o.id}: settlement found on chain (tx ${r.tx}, block ${r.block}) after: ${why}`);
    return orders.update(o.id, { status: 'paid', tx: r.tx, block: r.block, paid_at: now(), last_error: null,
      settle: JSON.stringify({ success: true, transaction: r.tx, blockNumber: r.block, network: req.network, payer: o.payer, recovered: 'chain' }),
      recon: JSON.stringify({ at: now(), why, result: 'settled', tx: r.tx }) });
  }

  /** the facilitator could not give a clean answer: ask the chain. Never drops an order whose outcome is unknown. */
  async function reconcileOrder(o, why) {
    if (!chain) return { o: orders.update(o.id, { last_error: `settlement outcome unknown: ${why} (order kept)` }), transient: true };
    let r;
    try { r = await chain.reconcile(o); }
    catch (e) { return { o: orders.update(o.id, { last_error: `settlement outcome unknown: ${why}; chain check failed: ${e.message} (order kept)` }), transient: true }; }
    if (r.state === 'settled') return { o: paidFromChain(o, r, why) };
    if (r.final) {
      log(`order ${o.id}: void — ${why}; ${r.reason}`);
      return { o: orders.update(o.id, { status: 'void', last_error: `${why}; ${r.reason} — not charged`, recon: JSON.stringify({ at: now(), why, result: 'void' }) }), voided: true };
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
      return { o: orders.update(o.id, { status: 'paid', tx: s.transaction, block: s.blockNumber ?? null, payer: s.payer ?? o.payer, settle: JSON.stringify(s), paid_at: now(), last_error: null }) };
    }
    if (s && s.pending) {
      if (sweep && age > reconAfterMs) return reconcileOrder(o, 'settlement pending at the facilitator');
      return { o: orders.update(o.id, { last_error: 'settlement pending on chain' }), transient: true };
    }
    const reason = String(s?.error || 'settlement failed');
    if (chain) {
      const r = await reconcileOrder(o, `facilitator refused: ${reason}`);
      if (!r.unsettled) return r;                      // settled (recovered), void, or unknown (kept)
      // the chain confirms: no money moved and none has → a genuine refusal
      return { o: orders.update(o.id, { status: 'failed', last_error: reason }), refused: reason };
    }
    // no chain to ask: a refusal that also fits "already settled" is ambiguous → keep the order, never drop it
    if (CONSUMED_HINT.test(reason)) return { o: orders.update(o.id, { last_error: `settlement outcome unknown: ${reason} (order kept; configure the chain check to resolve it)` }), transient: true };
    return { o: orders.update(o.id, { status: 'failed', last_error: reason }), refused: reason };
  }

  async function produceOrder(o, produce) {
    const aux = o.aux ? JSON.parse(o.aux) : {};
    const ctx = { order: o, aux, saveAux: (x) => { Object.assign(aux, x); orders.update(o.id, { aux: JSON.stringify(aux) }); } };
    try {
      const goods = await produce(ctx);
      return orders.update(o.id, { status: 'delivered', goods: JSON.stringify(goods), delivered_at: now(), attempts: o.attempts + 1, last_error: null });
    } catch (e) {
      const attempts = o.attempts + 1;
      const old = Date.now() - Date.parse(o.paid_at || o.created_at) > orders.maxAgeMs;
      const giveUp = attempts >= orders.maxAttempts || old;
      log(`order ${o.id}: delivery attempt ${attempts} failed: ${e.message}${giveUp ? ' → refund_due' : ''}`);
      return orders.update(o.id, { status: giveUp ? 'refund_due' : 'paid', attempts, last_error: String(e.message).slice(0, 300), ...(giveUp ? { refund_to: refundTarget(o) } : {}) });
    }
  }

  function respond(o, send, extra = {}) {
    if (o.status === 'delivered') return send(200, JSON.parse(o.goods), { 'X-PAYMENT-RESPONSE': settleHeader(o), ...hdrs(o), ...extra });
    if (['refund_due', 'refund_sent', 'refunded'].includes(o.status)) return send(409, { error: `paid but not deliverable; refund ${o.status === 'refunded' ? 'completed' : 'in progress'}`, order: receipt(o) }, hdrs(o));
    if (o.status === 'void') return send(402, { x402Version: 1, error: 'this payment was never settled and has expired; you were not charged', order: receipt(o) }, hdrs(o));
    if (o.status === 'failed') return send(402, { x402Version: 1, error: `settlement failed: ${o.last_error}`, order: receipt(o) }, hdrs(o));
    // settling / paid: charged or maybe charged, goods not yet produced → retryable, never ask to pay again
    return send(503, { error: 'payment recorded, delivery not finished yet — retry with the same X-PAYMENT', order: receipt(o) }, { 'retry-after': '5', ...hdrs(o) });
  }

  async function advance(o, body, produce, produceFirst, opts = {}) {
    if (o.status === 'settling') {
      const r = await settleOrder(o, body, opts);
      o = r.o;
      if (r.refused || r.transient || r.voided) return o;
      if (produceFirst && o.goods) return orders.update(o.id, { status: 'delivered', delivered_at: now() });
    }
    if (o.status === 'paid') o = await produceOrder(o, produce);
    return o;
  }

  // ---------- compensation: refund_due → refund_sent → refunded (verified on chain) ----------
  async function refundStep(o) {
    const to = o.refund_to || refundTarget(o);
    if (o.status === 'refund_due') {
      if (refunder) {
        const p = await refunder.prepare(to, o.amount);
        o = orders.update(o.id, { status: 'refund_sent', refund_to: to, refund_tx: p.tx, refund_raw: p.raw, refund_nonce: p.nonce, refund_at: now(), refund_by: `auto:${refunder.address}`, last_error: null });
        log(`order ${o.id}: refund ${o.amount} → ${to} sent (tx ${p.tx})`);
        await refunder.broadcast(p.raw).catch((e) => log(`order ${o.id}: refund broadcast failed, will retry: ${e.message}`));
        return o;
      }
      const since = Date.parse(o.updated_at);
      if (Date.now() - since > refundAlertMs && Date.now() - (lastAlert.get(o.id) || 0) > refundAlertMs) {
        lastAlert.set(o.id, Date.now());
        alert(`REFUND OVERDUE order ${o.id}: owes ${o.amount} (atomic) to ${to} since ${o.updated_at}; pay it and record it with: orders-admin refund-record ${o.id} <tx>`);
      }
      return o;
    }
    if (o.status === 'refund_sent' && chain) {
      let v = await chain.verifyRefund({ tx: o.refund_tx, to, minAmount: o.amount });
      if (v.ok) { log(`order ${o.id}: refunded (tx ${o.refund_tx}, block ${v.block})`); return orders.update(o.id, { status: 'refunded', refund_block: v.block, refunded_at: now(), refund_raw: null, last_error: null }); }
      if (v.pending && o.refund_raw && refunder) {
        if (await chain.accountNonce(refunder.address) > Number(o.refund_nonce)) {
          v = await chain.verifyRefund({ tx: o.refund_tx, to, minAmount: o.amount }); // mined in between?
          if (v.ok) return orders.update(o.id, { status: 'refunded', refund_block: v.block, refunded_at: now(), refund_raw: null, last_error: null });
          // our nonce was consumed by another transaction and ours never mined: it can never land → prepare a new one
          return orders.update(o.id, { status: 'refund_due', refund_tx: null, refund_raw: null, refund_nonce: null, last_error: `refund tx ${o.refund_tx} was dropped` });
        }
        await refunder.broadcast(o.refund_raw).catch(() => {});
        return o;
      }
      if (!v.ok && !v.pending) return orders.update(o.id, { status: 'refund_due', refund_tx: null, refund_raw: null, refund_nonce: null, last_error: `refund tx ${o.refund_tx} rejected: ${v.reason}` });
      if (Date.now() - Date.parse(o.refund_at || o.updated_at) > refundAlertMs && Date.now() - (lastAlert.get(o.id) || 0) > refundAlertMs) {
        lastAlert.set(o.id, Date.now()); alert(`REFUND NOT MINED order ${o.id}: tx ${o.refund_tx} still pending`);
      }
    }
    return o;
  }

  return {
    async handle(req, res, { requirements, inputs = null, produce, produceFirst = false, send, onDelivered = null }) {
      let pp;
      try { pp = decodePaymentHeader(req.headers['x-payment']); }
      catch (e) { return send(e.status || 400, { x402Version: 1, error: e.message, accepts: [requirements] }); }
      const key = paymentKey(pp, requirements), hash = payloadHash(pp), id = orderIdFor(pp);
      const body = { paymentPayload: pp, paymentRequirements: requirements };

      let o = orders.byKey(key);
      if (o && o.payload_hash !== hash) return send(409, { x402Version: 1, error: 'this authorization (nonce) already belongs to a different payment', accepts: [requirements] });
      if (o && o.resource !== requirements.resource) return send(409, { error: 'this payment was made for a different resource', order: receipt(o) }, hdrs(o));

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
      const redelivery = o.status === 'delivered';
      o = await withLock(o.id, async () => advance(orders.get(o.id), body, produce, produceFirst));
      if (o.status === 'failed') {
        // refused, and (when a chain check is configured) confirmed unsettled on chain: no money moved. Drop the row so a
        // later retry is evaluated fresh (e.g. after a top-up) and the payment key is never squatted by a refused attempt.
        orders.db.prepare('DELETE FROM orders WHERE id = ? AND status = ?').run(o.id, 'failed');
        return send(402, { x402Version: 1, error: `payment invalid: ${o.last_error}`, accepts: [requirements] });
      }
      if (o.status === 'delivered') { log(`order ${o.id} ${redelivery ? 're-delivered' : 'delivered'} (tx ${o.tx})`); if (!redelivery && onDelivered) { try { onDelivered(o); } catch (e) { log(`onDelivered: ${e.message}`); } } }
      return respond(o, send, redelivery ? { 'X-REDELIVERY': 'true' } : {});
    },

    /** GET /orders/<id>: receipt + status; resumes nothing (cheap, safe to poll). */
    status(id, send) {
      if (!/^ord_[0-9a-f]{32}$/.test(String(id))) return send(404, { error: 'unknown order' });
      const o = orders.get(id);
      if (!o) return send(404, { error: 'unknown order' });
      return send(200, receipt(o));
    },

    /** Background work: resume orders a crashed/abandoned request left behind, reconcile unknown outcomes, drive refunds. */
    async sweep({ produceFor, olderThanMs = 30_000 }) {
      for (const st of ['settling', 'paid']) {
        for (const row of orders.list(st, 50)) {
          if (Date.now() - Date.parse(row.updated_at) < olderThanMs) continue;
          if (!row.payment) continue;
          const produce = produceFor(row);
          if (!produce && st === 'paid') continue;
          await withLock(row.id, async () => {
            const o = orders.get(row.id);
            if (o.status === 'settling' && !produce) return settleOrder(o, JSON.parse(o.payment), { sweep: true }); // settle/reconcile only
            if (o.status === 'settling' || o.status === 'paid') await advance(o, JSON.parse(o.payment), produce, !!o.goods, { sweep: true });
          });
        }
      }
      for (const st of ['refund_due', 'refund_sent']) {
        for (const row of orders.list(st, 50)) {
          try { await withLock(row.id, async () => refundStep(orders.get(row.id))); }
          catch (e) { log(`order ${row.id}: refund step failed: ${e.message}`); }
        }
      }
    },

    /** An operator paid a refund by hand: accept it only if the chain shows the transfer to the payer. */
    async recordRefund(id, tx, by = 'operator') {
      if (!chain) throw new Error('no chain configured: a refund can only be recorded once it is verified on chain');
      return withLock(id, async () => {
        const o = orders.get(id);
        if (!o) throw new Error('unknown order');
        if (o.status !== 'refund_due') throw new Error(`order is ${o.status}, not refund_due`);
        const to = o.refund_to || refundTarget(o);
        const v = await chain.verifyRefund({ tx, to, minAmount: o.amount });
        if (!v.ok && !v.pending) throw new Error(`refund not accepted: ${v.reason}`);
        try {
          return v.ok
            ? orders.update(id, { status: 'refunded', refund_to: to, refund_tx: tx, refund_block: v.block, refund_at: now(), refunded_at: now(), refund_by: by, last_error: null })
            : orders.update(id, { status: 'refund_sent', refund_to: to, refund_tx: tx, refund_at: now(), refund_by: by, last_error: null });
        } catch (e) { if (/UNIQUE/.test(e.message)) throw new Error('that transaction is already recorded as the refund of another order'); throw e; }
      });
    },
    setRefunder(r) { refunder = r; },
    respond, receipt,
  };
}

export const newReceiptToken = () => randomBytes(16).toString('hex');
export { HttpError };
