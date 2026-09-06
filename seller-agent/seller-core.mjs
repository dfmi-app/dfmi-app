/**
 * seller-core.mjs — everything the seller agent knows, independent of which model runs it.
 *
 *   SYSTEM        the rules (one copy, shared by every runner)
 *   TOOLS         the five tools as JSON Schema (OpenAI/Ollama tool-calling format)
 *   execTool()    runs a tool by name: paykit for the four invoice tools, and the delivery gate
 *   deliverGoods  the gate itself: re-checks the chain and refuses unless the invoice is paid
 *
 * Runners: seller.mjs (Claude Agent SDK), seller-ollama.mjs (any OpenAI-compatible endpoint, e.g. Ollama Cloud),
 * goods-server.mjs (deliver_goods as a stdio MCP server, for Codex CLI or any MCP client).
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../paykit/src/config.mjs';
import { PayKit } from '../paykit/src/paykit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PAYKIT_SERVER = resolve(HERE, '..', 'paykit', 'src', 'server.mjs');
export const PAYKIT_CONFIG = resolve(HERE, '..', 'paykit', 'paykit.config.json');
export const SELLER = process.env.SELLER_ADDRESS ?? '0x5050A4F4b3f9338C3472dcC01A87C76A144b3c9c';

export const cfg = loadConfig(process.env.PAYKIT_CONFIG ?? PAYKIT_CONFIG);   // PAYKIT_CONFIG env overrides (tests, alternate stores)
export const kit = new PayKit(cfg);

// ---------------------------------------------------------------- the goods
// market-report: live prices (TradingView, CoinGecko fallback) via market.mjs, plus an analyst note when an LLM key is set.
import { snapshot } from './market.mjs';
const LLM_URL = process.env.LLM_API_URL ?? 'https://ollama.com/v1/chat/completions';
const LLM_KEY = process.env.LLM_API_KEY ?? '';
const LLM_MODEL = process.env.LLM_MODEL ?? 'glm-5.3:cloud';
const REPORT_SCOPE = process.env.REPORT_SCOPE ?? 'BTC ETH SOL total market cap BTC dominance S&P 500 Nasdaq VIX US 10Y DXY gold oil';

async function analystNote(data) {
  if (!LLM_KEY) return null;
  try {
    const r = await fetch(LLM_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify({ model: LLM_MODEL, max_tokens: 1200, stream: false, messages: [
        { role: 'system', content: 'You are a market analyst writing a short note for a paying client. Use only the numbers in the data block, verbatim. Format: **Headline** one line. **Now** two lines. **Why** two or three bullets. **Watch** two bullets. **Risk** one line. Under 160 words. No preamble.' },
        { role: 'user', content: `Live market data (source ${data.source}, as of ${data.asOf} UTC):\n${data.text}` } ] }), signal: AbortSignal.timeout(60_000) });
    const d = await r.json(); const t = (d.choices?.[0]?.message?.content ?? '').trim();
    return t || null;
  } catch { return null; }
}

export async function marketReport() {
  const data = await snapshot(REPORT_SCOPE).catch(() => null);
  const asOf = data?.asOf ?? new Date().toISOString();
  const head = `dfmi market report · ${asOf.replace('T', ' ').slice(0, 16)} UTC`;
  if (!data?.instruments?.length) return `${head}\n\nLive prices unavailable at delivery time (${(data?.errors ?? ['no data']).join('; ')}). This report is issued without figures; ask the seller for a re-delivery.`;
  const groups = {};
  for (const i of data.instruments) (groups[i.kind === 'crypto' || i.kind === 'cap' || i.kind === 'pct' ? 'Crypto' : i.kind === 'index' ? 'Equities' : i.kind === 'yield' ? 'Rates' : i.kind === 'fx' ? 'FX' : 'Commodities'] ??= []).push(i);
  const fmtRow = (i) => {
    const unit = i.kind === 'yield' || i.kind === 'pct' ? '%' : '';
    const px = i.kind === 'cap' ? '$' + (i.price >= 1e12 ? (i.price / 1e12).toFixed(2) + 'T' : (i.price / 1e9).toFixed(0) + 'B') : (i.price >= 1000 ? Math.round(i.price).toLocaleString('en-US') : i.price >= 1 ? i.price.toFixed(2) : i.price.toPrecision(3)) + unit;
    const chg = i.changePct == null ? '' : ` (${i.changePct >= 0 ? '+' : ''}${i.changePct.toFixed(2)}%)`;
    return `  ${i.name}: ${px}${chg}`;
  };
  const body = Object.entries(groups).map(([g, rows]) => `${g}\n${rows.map(fmtRow).join('\n')}`).join('\n\n');
  const note = await analystNote(data);
  return `${head}\n\n${body}\n\n${note ? `Analyst note\n${note}\n\n` : ''}Source: ${data.source} · chain ${cfg.chain} · paid in ${cfg.symbol} · verified on-chain before delivery`;
}

export const CATALOG = { 'market-report': marketReport };

// ---------------------------------------------------------------- the delivery gate: enforced in code, whatever the model believes
export async function deliverGoods({ invoice_id, product = 'market-report' }) {
  const st = await kit.checkPayment({ invoice_id });
  if (st.status !== 'paid') throw new Error(`Refused: invoice ${invoice_id} is "${st.status}", not "paid". Nothing delivered.`);
  if (!CATALOG[product]) throw new Error(`Unknown product "${product}"`);
  return { delivered: true, invoice_id, tx_hash: st.settlement.tx_hash, payer: st.settlement.payer_address, goods: await CATALOG[product]() };
}

// ---------------------------------------------------------------- rules
export const SYSTEM = `You are a selling agent on the dfmi network (chain ${cfg.chain}, unit ${cfg.symbol}).
You sell one product: "market-report". Your payee address is ${SELLER}. Always use it as payee_address; it is never the buyer.

Rules:
- To sell, create an invoice with create_invoice (payee_address = ${SELLER}, payer_hint = the buyer's address if given) and give the buyer the invoice_id, exact_amount, pay_to and chain. Never quote a rounded amount; the exact suffix is how payment is matched.
- Before delivering anything, call check_payment. Only call deliver_goods when check_payment says "paid". deliver_goods verifies the chain itself and will refuse otherwise; do not argue with it.
- If check_payment says "unknown", say the chain could not be read and do not deliver. "unknown" is not "unpaid".
- If an invoice is open or overdue and the user asks you to follow up, use send_reminder to draft text and show the draft. You do not send messages yourself.
- Be brief. Report invoice ids, exact amounts and transaction hashes verbatim.`;

// ---------------------------------------------------------------- tools as JSON Schema (OpenAI / Ollama function-calling shape)
const str = (description) => ({ type: 'string', description });
export const TOOLS = [
  { type: 'function', function: { name: 'create_invoice',
    description: `Create a payment request on ${cfg.chain} in ${cfg.symbol}. Returns an exact amount (unique fractional suffix) the payer must send to pay_to; matching is by amount.`,
    parameters: { type: 'object', required: ['payee_address', 'amount'], properties: {
      payee_address: str('Seller address that will receive the payment'),
      amount: str(`Amount in ${cfg.symbol}, e.g. "2.00"`),
      due_date: str('ISO 8601 due date'),
      memo: str('What the invoice is for'),
      payer_hint: str('Expected payer (buyer) address, if known') } } } },
  { type: 'function', function: { name: 'check_payment',
    description: `Verify on the ${cfg.chain} chain whether an invoice has been settled. Read-only. Returns status open | paid | partial | overdue | unknown. "unknown" means the chain could not be read; it never means "unpaid".`,
    parameters: { type: 'object', required: ['invoice_id'], properties: {
      invoice_id: str('Invoice id from create_invoice'),
      tx_hash: str('Optional settlement tx hash to verify directly') } } } },
  { type: 'function', function: { name: 'send_reminder',
    description: 'Draft a reminder for an unpaid invoice. Returns subject and body text only; nothing is sent.',
    parameters: { type: 'object', required: ['invoice_id'], properties: {
      invoice_id: str('Invoice id'),
      tone: { type: 'string', enum: ['polite', 'firm', 'final'] },
      channel_hint: { type: 'string', enum: ['email', 'chat'] } } } } },
  { type: 'function', function: { name: 'list_invoices',
    description: 'List invoices in the local store, optionally filtered by status or payee.',
    parameters: { type: 'object', properties: {
      status: { type: 'string', enum: ['open', 'paid', 'partial', 'overdue', 'unknown'] },
      payee: str('Payee address') } } } },
  { type: 'function', function: { name: 'deliver_goods',
    description: 'Release the goods for a settled invoice. Verifies on-chain settlement before releasing; refuses otherwise.',
    parameters: { type: 'object', required: ['invoice_id'], properties: {
      invoice_id: str('Invoice id'),
      product: { type: 'string', enum: Object.keys(CATALOG), description: 'defaults to market-report' } } } } },
];

// ---------------------------------------------------------------- one dispatcher for every runner
export async function execTool(name, args = {}) {
  switch (name) {
    case 'create_invoice': return kit.createInvoice(args);
    case 'check_payment':  return kit.checkPayment(args);
    case 'send_reminder':  return kit.draftReminder(args);
    case 'list_invoices':  return kit.store.list(args).map(i => ({ invoice_id: i.id, status: i.status, exact_amount: i.exact_amount, symbol: i.symbol, due_date: i.due_date, memo: i.memo }));
    case 'deliver_goods':  return deliverGoods(args);
    default: throw new Error(`unknown tool ${name}`);
  }
}
