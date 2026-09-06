#!/usr/bin/env node
/**
 * server.mjs — dfmi-buykit as an MCP server (stdio).
 *
 * Three tools a buying agent can call:
 *   check_budget     — what this session key may still spend (cap, spent, remaining, expiry, wallet balance)
 *   pay_invoice      — pay an exact amount to a payee, within the session's bounds, via the facilitator (no gas)
 *   list_purchases   — the local purchase log
 *
 * Env: SESSION_WALLET (address, not secret), SESSION_KEY (the granted session key's private key; never the owner's).
 * The wallet contract enforces cap / expiry / revocation / intent on-chain; buykit pre-checks them and refuses early.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, loadSessionKey } from './config.mjs';
import { BuyKit } from './buykit.mjs';

console.log = (...a) => console.error(...a); // stdout is the MCP channel

const cfg = loadConfig(process.argv[2]);
const kit = new BuyKit(cfg, loadSessionKey());
const server = new McpServer({ name: 'dfmi-buykit', version: '0.1.0' });
const json = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] });

server.registerTool('check_budget', {
  title: 'Check budget',
  description: `What this session key may still spend on ${cfg.chain}: cap, spent, remaining, expiry, wallet balance. Read from the wallet contract; always call before quoting what you can afford.`,
  inputSchema: {},
}, async () => { try { return json(await kit.checkBudget()); } catch (e) { return fail(e); } });

server.registerTool('pay_invoice', {
  title: 'Pay invoice',
  description: `Pay an exact amount of ${cfg.symbol} to a payee on ${cfg.chain} from the session wallet. Refuses before signing if the amount is over the session cap, over max_amount, outside the session's intent, the wallet is underfunded, or the same exact amount was already paid to this payee. Settles through the facilitator; the buyer needs no gas. Returns tx_hash on success.`,
  inputSchema: {
    pay_to: z.string().describe("Seller's payee address from the invoice"),
    exact_amount: z.union([z.string(), z.number()]).describe(`Exact amount from the invoice, e.g. "0.020287" (the fractional suffix matters)`),
    chain: z.string().optional().describe('Chain from the invoice, e.g. eip155:112172; refused if it differs from this wallet\'s chain'),
    invoice_id: z.string().optional().describe('Seller\'s invoice id, for the purchase log and idempotency'),
    memo: z.string().optional(),
    max_amount: z.union([z.string(), z.number()]).optional().describe('Caller-side ceiling for this payment (e.g. what the owner authorised for this purchase)'),
  },
}, async (a) => { try { return json(await kit.payInvoice(a)); } catch (e) { return fail(e); } });

server.registerTool('list_purchases', {
  title: 'List purchases',
  description: 'List payments made by this buyer, optionally filtered by status (paid | already_paid | failed) or payee.',
  inputSchema: { status: z.enum(['paid', 'already_paid', 'failed']).optional(), pay_to: z.string().optional() },
}, async (a) => { try { return json(kit.listPurchases(a)); } catch (e) { return fail(e); } });

await server.connect(new StdioServerTransport());
