#!/usr/bin/env node
/**
 * dfmi-market-mcp — stdio MCP server that lets any MCP client (Claude, Cursor, Codex, …) shop on the dfmi x402 market.
 *
 * Tools: dfmi_list_services · dfmi_quote · dfmi_wallet · dfmi_create_wallet · dfmi_claim_faucet · dfmi_buy
 *
 * Safety, enforced in code (not in the model's prompt):
 *   - per-call cap   DFMI_MAX_PRICE        (default 0.10) — the model can lower it per call, never raise it
 *   - session budget DFMI_SESSION_BUDGET   (default 1.00) — total spend for the life of this server process
 *   - mainnet        DFMI_ALLOW_MAINNET=1  required; testnets (dfmi dUSD, Base Sepolia) only by default
 *
 * Wallet: DFMI_BUYER_PRIVATE_KEY, else ~/.dfmi/buyer-wallet.json (created by dfmi_create_wallet, mode 0600).
 * Use a throwaway buyer wallet only. The key never leaves this process; only signatures are sent.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Wallet } from 'ethers';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { quote, buy } from './x402.mjs';

console.log = (...a) => console.error(...a); // stdout is the MCP channel

const env = process.env;
const FAUCET = env.DFMI_FAUCET_URL ?? 'https://faucet.dfmi.app';
const BAZAAR = env.DFMI_BAZAAR_URL ?? 'https://bazaar.dfmi.app/index.json';
const MAX_PRICE = Number(env.DFMI_MAX_PRICE ?? 0.10);
const BUDGET = Number(env.DFMI_SESSION_BUDGET ?? 1.00);
const ALLOW_MAINNET = env.DFMI_ALLOW_MAINNET === '1';
const HOME = env.DFMI_HOME ?? join(homedir(), '.dfmi');
const WALLET_FILE = join(HOME, 'buyer-wallet.json');
const LOG_FILE = join(HOME, 'purchases.jsonl');
const BODY_LIMIT = 20_000;

let spent = 0;

function loadWallet() {
  if (env.DFMI_BUYER_PRIVATE_KEY) return new Wallet(env.DFMI_BUYER_PRIVATE_KEY);
  if (existsSync(WALLET_FILE)) return new Wallet(JSON.parse(readFileSync(WALLET_FILE, 'utf8')).privateKey);
  return null;
}
const needWallet = () => {
  const w = loadWallet();
  if (!w) throw new Error('No buyer wallet. Call dfmi_create_wallet first (or set DFMI_BUYER_PRIVATE_KEY).');
  return w;
};
async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: { raw: text.slice(0, 500) } }; }
}

const ok = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const tool = fn => async (args) => { try { return ok(await fn(args ?? {})); } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; } };

const server = new McpServer({ name: 'dfmi-market', version: '0.1.0' });

server.registerTool('dfmi_list_services', {
  title: 'List dfmi services',
  description: 'List pay-per-request services on the dfmi x402 market, ranked by the independent bazaar (liveness, activity, buyer diversity). Returns resource URL, price, score and number of unique buyers. Free, no wallet needed.',
  inputSchema: { query: z.string().optional().describe('Optional keyword filter, e.g. "report" or "summarize"') },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, tool(async ({ query }) => {
  const { json } = await getJson(BAZAAR);
  let list = (json.resources ?? []).map(s => ({
    rank: s.rank, name: s.name, resource: s.resource, description: s.description,
    price: s.priceDusd, coin: 'dUSD', score: s.score, uniqueBuyers: s.uniqueBuyers, live: s.live, flags: s.flags,
  }));
  if (query) { const q = query.toLowerCase(); list = list.filter(s => `${s.name} ${s.description} ${s.resource}`.toLowerCase().includes(q)); }
  return { generatedAt: json.generatedAt, count: list.length, services: list, next: 'Use dfmi_quote(url) to see the live price, then dfmi_buy(url).' };
}));

server.registerTool('dfmi_quote', {
  title: 'Get an x402 price quote',
  description: 'Ask any x402 endpoint what it costs, without paying or signing anything. Works for dfmi services and other x402 endpoints.',
  inputSchema: { url: z.string().url(), method: z.enum(['GET', 'POST']).optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, tool(({ url, method }) => quote(url, { method, allowMainnet: ALLOW_MAINNET })));

server.registerTool('dfmi_wallet', {
  title: 'Buyer wallet status',
  description: 'Show the buyer wallet address, its dUSD balance on dfmi, and the spend limits left in this session.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, tool(async () => {
  const w = loadWallet();
  const limits = { maxPricePerCall: MAX_PRICE, sessionBudget: BUDGET, spentThisSession: +spent.toFixed(6), remaining: +(BUDGET - spent).toFixed(6), mainnetAllowed: ALLOW_MAINNET };
  if (!w) return { wallet: null, hint: 'Call dfmi_create_wallet, then dfmi_claim_faucet.', limits };
  const { json } = await getJson(`${FAUCET}/balance?address=${w.address}`);
  return { address: w.address, balance: json, limits };
}));

server.registerTool('dfmi_create_wallet', {
  title: 'Create a throwaway buyer wallet',
  description: `Create a new local buyer wallet (stored at ${WALLET_FILE}, readable only by you). Does nothing if one already exists. Returns the address only, never the key.`,
  inputSchema: {},
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
}, tool(async () => {
  const existing = loadWallet();
  if (existing) return { address: existing.address, created: false };
  const w = Wallet.createRandom();
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(WALLET_FILE, JSON.stringify({ address: w.address, privateKey: w.privateKey, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return { address: w.address, created: true, next: 'Call dfmi_claim_faucet to get 10 free dUSD.' };
}));

server.registerTool('dfmi_claim_faucet', {
  title: 'Claim free test dUSD',
  description: 'Claim 10 dUSD (test unit, no monetary value) from the dfmi faucet to the buyer wallet. Once per address, ever.',
  inputSchema: {},
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
}, tool(async () => {
  const w = needWallet();
  const { status, json } = await getJson(`${FAUCET}/claim?address=${w.address}`);
  return { address: w.address, status, result: json };
}));

server.registerTool('dfmi_buy', {
  title: 'Buy from an x402 endpoint',
  description: `Pay for and fetch an x402 resource (exact scheme, EIP-3009; no gas needed). Refuses if the price is above max_price (hard cap ${MAX_PRICE}) or above the remaining session budget (${BUDGET} total). Testnet only unless the operator enabled mainnet. Returns the goods and the on-chain settlement receipt.`,
  inputSchema: {
    url: z.string().url().describe('Resource URL, e.g. from dfmi_list_services'),
    max_price: z.number().positive().optional().describe(`Most you will pay for this call, in the quoted coin. Capped at ${MAX_PRICE}.`),
    method: z.enum(['GET', 'POST']).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, tool(async ({ url, max_price, method }) => {
  const w = needWallet();
  const cap = Math.min(max_price ?? MAX_PRICE, MAX_PRICE);
  let reserved = 0;
  const reserve = price => {
    if (spent + price > BUDGET + 1e-9) throw new Error(`Session budget exhausted: spent ${spent.toFixed(4)} of ${BUDGET}; this costs ${price}.`);
    spent += price; reserved = price;
  };
  // If the paid request throws after signing, the reservation stays: the authorization may still settle.
  const r = await buy(url, w, { method, maxPrice: cap, allowMainnet: ALLOW_MAINNET, reserve });
  if (reserved && !r.paid) spent -= reserved; // seller answered without settling → nothing was spent

  const record = { time: new Date().toISOString(), resource: url, network: r.network, price: r.price, coin: r.coin, payTo: r.payTo, buyer: r.buyer,
    status: r.status, paid: r.paid, delivered: r.delivered, tx: r.settlement?.transaction ?? null };
  try { mkdirSync(HOME, { recursive: true, mode: 0o700 }); appendFileSync(LOG_FILE, JSON.stringify(record) + '\n'); } catch {}

  const body = r.body ?? r.preview ?? '';
  return { ...record, latencyMs: r.latencyMs, settlement: r.settlement ?? null, note: r.note,
    spentThisSession: +spent.toFixed(6), remainingBudget: +(BUDGET - spent).toFixed(6),
    goods: body.length > BODY_LIMIT ? body.slice(0, BODY_LIMIT) + `\n…[truncated, ${body.length} bytes total]` : body };
}));

await server.connect(new StdioServerTransport());
console.error(`[dfmi-market-mcp] ready · cap ${MAX_PRICE}/call · budget ${BUDGET} · mainnet ${ALLOW_MAINNET ? 'ON' : 'off'} · wallet ${loadWallet()?.address ?? 'none'}`);
