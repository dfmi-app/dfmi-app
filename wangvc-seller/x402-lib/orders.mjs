// orders.mjs — persistent x402 orders + receipts for sellers (node:sqlite, zero deps).
//
// Every paid request becomes an order row BEFORE the facilitator is asked to settle, keyed by the payment
// itself (one authorization = one order). That gives the buyer a way back to what they paid for:
//
//   • retry the SAME X-PAYMENT        → the original order: stored goods (re-delivery), never a second charge
//   • GET /orders/<order_id>          → status + receipt (tx, amount, payer, timestamps)
//   • delivery keeps failing          → status 'refund_due' (compensation queue for the operator; see scripts/orders-admin.mjs)
//
// States: settling → paid → delivered          (normal)
//         settling → failed                     (facilitator refused: buyer NOT charged)
//         paid     → refund_due                 (charged, goods could not be produced after MAX_ATTEMPTS / MAX_AGE)
// A crash at any point leaves the row in 'settling' or 'paid'; the next retry (or the sweeper) resumes it.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { decodePaymentHeader, HttpError } from './limits.mjs';

// reasons an already-settled payment reports on re-verification; such a payment may be ours → ask /settle (idempotent)
export const CONSUMED_HINT = /already used|replay|bad nonce|revoked|expired|deadline|stale generation/i;
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',')}}`
  : JSON.stringify(typeof v === 'string' ? v.toLowerCase() : v);

/** One authorization can only ever settle once: exact = (asset, from, nonce); session = (wallet, key, generation, nonce). */
export function paymentKey(pp, requirements) {
  const p = pp.payload || {}, a = p.authorization || {};
  if (pp.scheme === 'dfmi-session') return ['session', p.wallet, p.sessionKey, a.generation ?? 'legacy', a.nonce].map((x) => String(x).toLowerCase()).join(':');
  return ['exact', requirements.asset, a.from, a.nonce].map((x) => String(x).toLowerCase()).join(':');
}
export const payloadHash = (pp) => createHash('sha256').update(stable({ scheme: pp.scheme, network: pp.network, payload: pp.payload })).digest('hex');
export const orderIdFor = (pp) => 'ord_' + payloadHash(pp).slice(0, 32);

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
  return { order_id: o.id, status: o.status, resource: o.resource, amount_atomic: o.amount, payer: o.payer, scheme: o.scheme,
    transaction: o.tx, block: o.block, attempts: o.attempts, last_error: o.status === 'delivered' ? null : o.last_error,
    created_at: o.created_at, paid_at: o.paid_at, delivered_at: o.delivered_at,
    ...(o.status === 'refund_due' ? { compensation: 'This order was paid but could not be delivered. It is in the refund queue; the operator refunds it to the payer.' } : {}),
    ...(o.status === 'paid' || o.status === 'settling' ? { retry: 'Send the same X-PAYMENT again (or GET this URL) to resume delivery. You will not be charged again.' } : {}) };
}

/**
 * makeGate({ orders, fac, log }) → { handle(req, res, opts), status(res, id), sweep(resolver) }
 *   opts: { requirements, inputs, produce(ctx) → goods, produceFirst=false, send(code, obj, headers) }
 *   produce(ctx): ctx = { order, aux, saveAux(obj) } — saveAux persists state a resumed attempt must reuse
 *                 (the storefront stores its upstream X-PAYMENT there so a retry re-uses the same upstream payment).
 *   fac(path, body) → facilitator JSON (throw = transient, e.g. network)
 */
export function makeGate({ orders, fac, log = () => {}, statusBase = '/orders/' }) {
  const locks = new Map(); // order id → promise (one resume at a time per order in this process)
  const withLock = async (id, fn) => {
    while (locks.has(id)) { try { await locks.get(id); } catch {} }
    const p = (async () => fn())(); locks.set(id, p);
    try { return await p; } finally { if (locks.get(id) === p) locks.delete(id); }
  };
  const settleHeader = (o) => Buffer.from(JSON.stringify({ success: true, network: JSON.parse(o.settle || '{}').network, payer: o.payer, transaction: o.tx, blockNumber: o.block, orderId: o.id })).toString('base64');
  const hdrs = (o) => ({ 'X-ORDER-ID': o.id, 'X-ORDER-STATUS-URL': statusBase + o.id });

  async function settleOrder(o, body) {
    let s;
    try { s = await fac('/settle', body); }
    catch (e) { return { o: orders.update(o.id, { last_error: `facilitator unreachable: ${e.message}` }), transient: true }; }
    if (s && s.success) {
      return { o: orders.update(o.id, { status: 'paid', tx: s.transaction, block: s.blockNumber ?? null, payer: s.payer ?? o.payer, settle: JSON.stringify(s), paid_at: new Date().toISOString(), last_error: null }) };
    }
    if (s && s.pending) return { o: orders.update(o.id, { last_error: 'settlement pending on chain' }), transient: true };
    // definitive refusal from the facilitator → the buyer was not charged; free the payment key for nothing else
    return { o: orders.update(o.id, { status: 'failed', last_error: String(s?.error || 'settlement failed') }), refused: String(s?.error || 'settlement failed') };
  }

  async function produceOrder(o, produce) {
    const aux = o.aux ? JSON.parse(o.aux) : {};
    const ctx = { order: o, aux, saveAux: (x) => { Object.assign(aux, x); orders.update(o.id, { aux: JSON.stringify(aux) }); } };
    try {
      const goods = await produce(ctx);
      return orders.update(o.id, { status: 'delivered', goods: JSON.stringify(goods), delivered_at: new Date().toISOString(), attempts: o.attempts + 1, last_error: null });
    } catch (e) {
      const attempts = o.attempts + 1;
      const old = Date.now() - Date.parse(o.paid_at || o.created_at) > orders.maxAgeMs;
      const status = attempts >= orders.maxAttempts || old ? 'refund_due' : 'paid';
      log(`order ${o.id}: delivery attempt ${attempts} failed: ${e.message}${status === 'refund_due' ? ' → refund_due' : ''}`);
      return orders.update(o.id, { status, attempts, last_error: String(e.message).slice(0, 300) });
    }
  }

  function respond(o, send, extra = {}) {
    if (o.status === 'delivered') return send(200, JSON.parse(o.goods), { 'X-PAYMENT-RESPONSE': settleHeader(o), ...hdrs(o), ...extra });
    if (o.status === 'refund_due') return send(409, { error: 'paid but not deliverable; queued for refund', order: receipt(o) }, hdrs(o));
    if (o.status === 'failed') return send(402, { x402Version: 1, error: `settlement failed: ${o.last_error}`, order: receipt(o) }, hdrs(o));
    // settling / paid: charged or maybe charged, goods not yet produced → retryable, never ask to pay again
    return send(503, { error: 'payment recorded, delivery not finished yet — retry with the same X-PAYMENT', order: receipt(o) }, { 'retry-after': '5', ...hdrs(o) });
  }

  async function advance(o, body, produce, produceFirst) {
    if (o.status === 'settling') {
      const r = await settleOrder(o, body);
      o = r.o;
      if (r.refused || r.transient) return o;
      if (produceFirst && o.goods) return orders.update(o.id, { status: 'delivered', delivered_at: new Date().toISOString() });
    }
    if (o.status === 'paid') o = await produceOrder(o, produce);
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
        // the facilitator refused: no money moved. Drop the row so a later retry is evaluated fresh
        // (e.g. after a top-up) and the payment key is never squatted by a refused attempt.
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

    /** Background resume for orders a crashed/abandoned request left behind (settling/paid). */
    async sweep({ produceFor, olderThanMs = 30_000 }) {
      for (const st of ['settling', 'paid']) {
        for (const row of orders.list(st, 50)) {
          if (Date.now() - Date.parse(row.updated_at) < olderThanMs) continue;
          const produce = produceFor(row);
          if (!produce || !row.payment) continue;
          await withLock(row.id, async () => {
            const o = orders.get(row.id);
            if (o.status === 'settling' || o.status === 'paid') await advance(o, JSON.parse(o.payment), produce, !!o.goods);
          });
        }
      }
    },
    respond, receipt,
  };
}

export const newReceiptToken = () => randomBytes(16).toString('hex');
export { HttpError };
