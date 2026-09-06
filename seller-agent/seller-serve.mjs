#!/usr/bin/env node
/**
 * seller-serve.mjs — the seller as a service another agent can talk to. No model in the loop.
 *
 * Everything a buyer needs is deterministic, so it is code, not a prompt:
 *   GET  /offer                → what is for sale, price, payee, chain
 *   POST /order    {product, buyer}      → creates an invoice with paykit; returns invoice_id, exact_amount, pay_to, chain
 *   GET  /invoice/:id          → current status (open | paid | …) from the chain
 *   POST /deliver  {invoice_id}          → the gate (seller-core.deliverGoods): goods if paid on-chain, 402 otherwise
 *
 * The seller *agent* (seller.mjs and friends) is still there for the human-facing parts: reminders, questions, exceptions.
 *
 *   SELLER_ADDRESS=0x… node seller-serve.mjs [--port 4444]
 *   Optional: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID → posts a line on each order and delivery (notify.mjs).
 */
import { createServer } from 'node:http';
import { cfg, kit, SELLER, CATALOG, deliverGoods } from './seller-core.mjs';
import { notify, enabled as tgEnabled } from './notify.mjs';

const PORT = Number(process.argv[process.argv.indexOf('--port') + 1] || process.env.SELLER_PORT || 4444);
const PRICES = { 'market-report': process.env.PRICE_MARKET_REPORT ?? '0.02' };
const DUE_DAYS = 7;

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj, null, 2)); };
const body = (req) => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) no(new Error('body too large')); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } }); });
const log = (...a) => console.error(`[seller-serve:${PORT}]`, ...a);

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && u.pathname === '/offer') {
      return json(res, 200, { seller: SELLER, chain: cfg.chain, symbol: cfg.symbol,
        products: Object.keys(CATALOG).map(id => ({ id, price: PRICES[id] ?? null, description: `dfmi ${id}` })),
        how: 'POST /order {product, buyer} → invoice; pay exact_amount to pay_to on chain; POST /deliver {invoice_id} → goods' });
    }
    if (req.method === 'POST' && u.pathname === '/order') {
      const { product = 'market-report', buyer } = await body(req);
      if (!CATALOG[product]) return json(res, 400, { error: `unknown product ${product}` });
      const inv = await kit.createInvoice({ payee_address: SELLER, amount: PRICES[product], memo: product, payer_hint: buyer,
        due_date: new Date(Date.now() + DUE_DAYS * 86400e3).toISOString() });
      log(`order ${inv.invoice_id} ${product} ${inv.exact_amount} ${cfg.symbol} for ${buyer ?? '?'}`);
      notify(`🧾 seller: invoice ${inv.invoice_id} for ${product}, ${inv.exact_amount} ${cfg.symbol}, buyer ${buyer ?? '?'}`);
      return json(res, 201, { invoice_id: inv.invoice_id, product, exact_amount: inv.exact_amount, pay_to: inv.pay_to, chain: inv.chain, symbol: inv.symbol, due_date: inv.due_date });
    }
    if (req.method === 'GET' && u.pathname.startsWith('/invoice/')) {
      const st = await kit.checkPayment({ invoice_id: u.pathname.slice(9) });
      return json(res, 200, { invoice_id: st.invoice_id, status: st.status, exact_amount: st.exact_amount, pay_to: st.pay_to, chain: st.chain, settlement: st.settlement ?? null });
    }
    if (req.method === 'POST' && u.pathname === '/deliver') {
      const { invoice_id, product } = await body(req);
      if (!invoice_id) return json(res, 400, { error: 'invoice_id required' });
      try { const g = await deliverGoods({ invoice_id, product }); log(`delivered ${invoice_id} (tx ${g.tx_hash})`);
        notify(`📦 seller: delivered ${invoice_id} to ${g.payer}. Settled on-chain, tx ${g.tx_hash}`); return json(res, 200, g); }
      catch (e) { log(`refused ${invoice_id}: ${e.message}`); notify(`⛔ seller: refused delivery of ${invoice_id}: ${e.message}`); return json(res, 402, { delivered: false, error: e.message }); }
    }
    return json(res, 404, { error: 'not found', routes: ['GET /offer', 'POST /order', 'GET /invoice/:id', 'POST /deliver'] });
  } catch (e) { log('error', e.message); return json(res, 500, { error: e.message }); }
}).listen(PORT, () => log(`selling ${Object.keys(CATALOG).join(', ')} as ${SELLER} on ${cfg.chain} | http://0.0.0.0:${PORT}/offer | telegram ${tgEnabled ? 'on' : 'off'}`));
