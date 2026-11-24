// seller-kit.mjs — the common x402 seller shell: limits + persistent orders + facilitator client.
//
//   const kit = makeSellerKit({ name, dbFile, facilitator, facAuth, env, limits });
//   createServer(SERVER_OPTS, kit.serve(async (req, res, { send, url }) => { ... kit.sell(req, res, {...}) ... }))
//
// kit.serve() wraps every request in the rate/concurrency limiter, answers CORS preflight, serves
// GET /orders/<id> (receipt + status), and turns HttpError into a JSON response.
// kit.sell() is the paid path: 402 offer without X-PAYMENT, otherwise the order gate (lib/orders.mjs).
import { SERVER_OPTS, hardenServer, limiterFromEnv, limited, HttpError } from './limits.mjs';
import { openOrders, makeGate } from './orders.mjs';
import { makeChain, makeRefunder } from './chain-recon.mjs';

export const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-PAYMENT-RESPONSE, PAYMENT-RESPONSE, X-ORDER-ID, X-ORDER-STATUS-URL, X-REDELIVERY' };
export const PREFLIGHT = { ...CORS, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'X-PAYMENT, PAYMENT-SIGNATURE, Content-Type', 'access-control-max-age': '86400' };

// chain: the seller's dfmi.json / paykit config ({ rpc, token, chainId, gasPriceGwei, insecure }). With it the seller can
// settle "outcome unknown" orders against the chain itself and verify refunds; without it such orders are kept, never dropped.
// Env: ORDER_SWEEP_MS (60000), ORDER_SWEEP_OLDER_MS (30000), ORDER_RECON_AFTER_MS (120000), REFUND_ALERT_MS (3600000),
//      REFUND_PRIVATE_KEY (optional hot wallet holding dUSD: refunds are then paid automatically and verified on chain).
export function makeSellerKit({ name, dbFile, facilitator, facAuth = '', env = {}, limits = {}, chain: chainCfg = null, sweepMs = 60_000, log = (...a) => console.log(`[${name}]`, ...a) }) {
  const E = (k, d) => env[k] ?? process.env[k] ?? d;
  sweepMs = Number(E('ORDER_SWEEP_MS', sweepMs));
  const orders = openOrders(dbFile, { maxAttempts: Number(env.ORDER_MAX_ATTEMPTS ?? process.env.ORDER_MAX_ATTEMPTS ?? 5), maxAgeMs: Number(env.ORDER_MAX_AGE_MS ?? process.env.ORDER_MAX_AGE_MS ?? 24 * 3600_000) });
  const fac = async (p, body) => {
    const r = await fetch(facilitator.replace(/\/$/, '') + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(facAuth ? { authorization: `Bearer ${facAuth}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    if (r.status >= 500 || r.status === 429) throw new Error(`facilitator HTTP ${r.status}`); // transient
    return r.json();
  };
  const chain = chainCfg?.rpc && chainCfg?.token ? makeChain({ rpc: chainCfg.rpc, token: chainCfg.token, insecure: !!chainCfg.insecure }) : null;
  if (!chain) log('note: no chain config — orders with an unknown settlement outcome are kept but cannot be reconciled on chain');
  const gate = makeGate({ orders, fac, log, chain, reconAfterMs: Number(E('ORDER_RECON_AFTER_MS', 120_000)), refundAlertMs: Number(E('REFUND_ALERT_MS', 3600_000)) });
  const refundKey = E('REFUND_PRIVATE_KEY', '');
  const refunderReady = refundKey && chain
    ? makeRefunder({ chain, privateKey: refundKey, token: chainCfg.token, chainId: Number(chainCfg.chainId), gasPriceGwei: chainCfg.gasPriceGwei ?? 1 })
        .then((r) => { gate.setRefunder(r); log(`refunds: automatic from ${r.address}`); }).catch((e) => log(`refunds: automatic refunder unavailable (${e.message}); refund_due orders are alerted until recorded`))
    : Promise.resolve();
  const limiter = limiterFromEnv('SELLER', env, { ratePerMin: 60, burst: 20, maxConcurrent: 8, maxConcurrentPerIp: 2, ...limits });
  const sender = (res) => (code, obj, h = {}) => { if (res.headersSent) return; res.writeHead(code, { 'content-type': 'application/json', ...CORS, ...h }); res.end(JSON.stringify(obj)); };

  function serve(handler) {
    return (req, res) => {
      const send = sender(res);
      if (req.method === 'OPTIONS') { res.writeHead(204, PREFLIGHT); return res.end(); }
      return limited(limiter, req, res, async () => {
        try {
          const url = new URL(req.url, 'http://x');
          const m = url.pathname.match(/^\/orders\/([^/]+)$/);
          if (m && req.method === 'GET') return gate.status(m[1], send);
          return await handler(req, res, { send, url });
        } catch (e) {
          if (e instanceof HttpError) return send(e.status, { error: e.message });
          log('error', e.message); return send(500, { error: 'internal error' });
        }
      }, { cors: CORS });
    };
  }

  /** Paid path. produce(ctx) builds the goods; produceFirst = build before settling (no charge if it fails). */
  function sell(req, res, { requirements, inputs = null, produce, produceFirst = false, onDelivered = null }) {
    const send = sender(res);
    if (!req.headers['x-payment']) return send(402, { x402Version: 1, error: 'X-PAYMENT header is required', accepts: [requirements] });
    return gate.handle(req, res, { requirements, inputs, produce, produceFirst, send, onDelivered });
  }

  let timer = null;
  function startSweeper(produceFor) {
    if (!sweepMs) return;
    const olderThanMs = Number(E('ORDER_SWEEP_OLDER_MS', 30_000));
    let busy = false;
    const tick = async () => { if (busy) return; busy = true; try { await refunderReady; await gate.sweep({ produceFor, olderThanMs }); } catch (e) { log('sweep error', e.message); } finally { busy = false; } };
    timer = setInterval(tick, sweepMs);
    timer.unref();
  }
  return { orders, gate, fac, chain, serve, sell, startSweeper, limiter, send: sender, close: () => { clearInterval(timer); orders.close(); } };
}

export function listen(server, port, host, cb) { hardenServer(server); return server.listen(port, host || '0.0.0.0', cb); }
export { SERVER_OPTS };
