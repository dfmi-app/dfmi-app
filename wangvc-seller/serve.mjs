#!/usr/bin/env node
/**
 * serve.mjs — the wangvc seller as a service another agent can talk to. No model in the loop.
 *
 *   GET  /offer                           → products, prices, payee, chain
 *   POST /order   {product, buyer, question?}  → paykit invoice (unique exact amount)
 *   GET  /invoice/:id                     → status from the chain (open | paid | …)
 *   POST /deliver {invoice_id}            → the gate: goods if paid on-chain, 402 otherwise
 *
 * Mirrors seller-agent/seller-serve.mjs. The only wangvc-specific parts: the CATALOG comes
 * from goods.mjs, and for `wangvc-ask` the buyer's question is captured at /order and
 * replayed at delivery (kept in the invoice memo + an in-process map).
 *
 *   SELLER_ADDRESS=0x… node serve.mjs [--port 4450]
 *   Prices (dUSD): PRICE_WANGVC_BRIEF (0.05), PRICE_WANGVC_ASK (0.02)
 */
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../paykit/src/config.mjs';
import { PayKit } from '../paykit/src/paykit.mjs';
import { CATALOG, BOARDS } from './goods.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(process.env.PAYKIT_CONFIG ?? resolve(HERE, '..', 'paykit', 'paykit.config.json'));
const kit = new PayKit(cfg);

const SELLER = process.env.SELLER_ADDRESS ?? '0x35EED7539a6e19B7427007f727e87A0527450eBe';
const portArg = process.argv.indexOf('--port');
const PORT = Number((portArg > -1 && process.argv[portArg + 1]) || process.env.SELLER_PORT || 4450);
const PRICES = {
  'wangvc-brief': process.env.PRICE_WANGVC_BRIEF ?? '0.05',
  'wangvc-ask': process.env.PRICE_WANGVC_ASK ?? '0.02',
};
const DUE_DAYS = 7;
const SEP = '¶'; // memo separator: "<product>¶<question>"
const pending = new Map(); // invoice_id -> { product, question }

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj, null, 2)); };
const body = (req) => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) no(new Error('body too large')); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } }); });
const log = (...a) => console.error(`[wangvc-seller:${PORT}]`, ...a);

// ---------- x402 resource mode (so bazaar can rate it; same protocol as producer) ----------
// GET /signals  → wangvc-brief ;  GET /ask?q=…  → wangvc-ask.
// No X-PAYMENT → 402 with the offer; with X-PAYMENT → facilitator verify+settle → goods.
const FACILITATOR = process.env.FACILITATOR_URL || cfg.facilitator || 'http://localhost:4040';
const FAC_AUTH = process.env.FACILITATOR_AUTH || '';
const PUBLIC_BASE = process.env.PUBLIC_BASE || 'https://wangvc.dfmi.app';
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-PAYMENT-RESPONSE, PAYMENT-RESPONSE' };
const fac = (p, b) => fetch(FACILITATOR + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(FAC_AUTH ? { authorization: `Bearer ${FAC_AUTH}` } : {}) }, body: JSON.stringify(b), signal: AbortSignal.timeout(90000) }).then((r) => r.json());
const requirements = (price, path, desc, inputs) => ({
  scheme: 'exact', network: cfg.chain, maxAmountRequired: String(Math.round(price * 10 ** cfg.decimals)),
  asset: cfg.token, payTo: SELLER, resource: PUBLIC_BASE + path, description: desc,
  mimeType: 'text/plain', maxTimeoutSeconds: 300,
  ...(inputs ? { inputs } : {}),
  extra: { name: cfg.tokenDomain.name, version: cfg.tokenDomain.version },
});
async function x402(req, res, { product, price, path, desc, goodsArgs, inputs }) {
  const REQ = requirements(price, path, desc, inputs);
  const send = (code, obj, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...CORS, ...h }); res.end(JSON.stringify(obj)); };
  const header = req.headers['x-payment'];
  if (!header) return send(402, { x402Version: 1, error: 'X-PAYMENT header is required', accepts: [REQ] });
  try {
    const paymentPayload = JSON.parse(Buffer.from(header, 'base64').toString());
    const b = { paymentPayload, paymentRequirements: REQ };
    const v = await fac('/verify', b);
    if (!v.isValid) return send(402, { x402Version: 1, error: `payment invalid: ${v.invalidReason}`, accepts: [REQ] });
    const s = await fac('/settle', b);
    if (!s.success) return send(402, { x402Version: 1, error: `settlement failed: ${s.error}`, accepts: [REQ] });
    const report = await CATALOG[product](goodsArgs || {});
    const rcpt = Buffer.from(JSON.stringify({ success: true, network: s.network, payer: s.payer, transaction: s.transaction, blockNumber: s.blockNumber })).toString('base64');
    log(`x402 delivered ${product} (tx ${s.transaction})`);
    return send(200, report, { 'X-PAYMENT-RESPONSE': rcpt });
  } catch (e) { log('x402 error', e.message); return send(500, { error: e.message }); }
}

// the delivery gate — enforced here in code, re-checks the chain every time
async function deliverGoods({ invoice_id }) {
  const st = await kit.checkPayment({ invoice_id });
  if (st.status !== 'paid') throw new Error(`Refused: invoice ${invoice_id} is "${st.status}", not "paid". Nothing delivered.`);
  let { product, question } = pending.get(invoice_id) || {};
  if (!product) { const memo = st.memo || st.settlement?.memo || ''; const [p, q] = String(memo).split(SEP); product = p || 'wangvc-brief'; question = q; }
  if (!CATALOG[product]) throw new Error(`Unknown product "${product}"`);
  const goods = await CATALOG[product]({ question });
  return { delivered: true, invoice_id, product, tx_hash: st.settlement?.tx_hash, payer: st.settlement?.payer_address, goods };
}

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'X-PAYMENT, PAYMENT-SIGNATURE, Content-Type', 'access-control-max-age': '86400' }); return res.end(); }
    if (req.method === 'GET' && u.pathname === '/signals') return x402(req, res, { product: 'wangvc-brief', price: Number(PRICES['wangvc-brief']), path: '/signals', desc: 'wangvc full signal brief — all 12 dashboards' });
    if (req.method === 'GET' && u.pathname === '/ask') return x402(req, res, { product: 'wangvc-ask', price: Number(PRICES['wangvc-ask']), path: '/ask', desc: 'wangvc — one question routed to the right dashboard', goodsArgs: { question: u.searchParams.get('q') || '' }, inputs: [{ name: 'q', label: 'Your Question', labelZh: 'Your Question', placeholder: 'Your Question' }] });
    if (req.method === 'GET' && u.pathname === '/offer') {
      return json(res, 200, {
        seller: SELLER, chain: cfg.chain, symbol: cfg.symbol,
        products: [
          { id: 'wangvc-brief', price: PRICES['wangvc-brief'], description: 'wangvc full signal brief — all 12 dashboards' },
          { id: 'wangvc-ask', price: PRICES['wangvc-ask'], description: 'one question routed to the right dashboard (+ analyst note)' },
        ],
        boards: Object.values(BOARDS),
        x402: { 'wangvc-brief': PUBLIC_BASE + '/signals', 'wangvc-ask': PUBLIC_BASE + '/ask?q=<question>' },
        how: 'invoice: POST /order {product, buyer, question?} → pay → POST /deliver {invoice_id}. x402: GET /signals or /ask?q=… → 402 offer → retry with X-PAYMENT',
      });
    }
    if (req.method === 'POST' && u.pathname === '/order') {
      const { product = 'wangvc-ask', buyer, question = '' } = await body(req);
      if (!CATALOG[product]) return json(res, 400, { error: `unknown product ${product}`, products: Object.keys(CATALOG) });
      const memo = product === 'wangvc-ask' && question ? `${product}${SEP}${question}`.slice(0, 180) : product;
      const inv = await kit.createInvoice({ payee_address: SELLER, amount: PRICES[product], memo, payer_hint: buyer, due_date: new Date(Date.now() + DUE_DAYS * 86400e3).toISOString() });
      pending.set(inv.invoice_id, { product, question });
      log(`order ${inv.invoice_id} ${product} ${inv.exact_amount} ${cfg.symbol}${question ? ` q="${question}"` : ''}`);
      return json(res, 201, { invoice_id: inv.invoice_id, product, exact_amount: inv.exact_amount, pay_to: inv.pay_to, chain: inv.chain, symbol: inv.symbol, due_date: inv.due_date });
    }
    if (req.method === 'GET' && u.pathname.startsWith('/invoice/')) {
      const st = await kit.checkPayment({ invoice_id: u.pathname.slice(9) });
      return json(res, 200, { invoice_id: st.invoice_id, status: st.status, exact_amount: st.exact_amount, pay_to: st.pay_to, chain: st.chain, settlement: st.settlement ?? null });
    }
    if (req.method === 'POST' && u.pathname === '/deliver') {
      const { invoice_id } = await body(req);
      if (!invoice_id) return json(res, 400, { error: 'invoice_id required' });
      try { const g = await deliverGoods({ invoice_id }); log(`delivered ${invoice_id} (${g.product}, tx ${g.tx_hash})`); return json(res, 200, g); }
      catch (e) { log(`refused ${invoice_id}: ${e.message}`); return json(res, 402, { delivered: false, error: e.message }); }
    }
    return json(res, 404, { error: 'not found', routes: ['GET /offer', 'POST /order', 'GET /invoice/:id', 'POST /deliver'] });
  } catch (e) { log('error', e.message); return json(res, 500, { error: e.message }); }
}).listen(PORT, () => log(`selling wangvc-brief, wangvc-ask as ${SELLER} on ${cfg.chain} | http://0.0.0.0:${PORT}/offer`));
