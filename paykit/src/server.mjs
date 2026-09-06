#!/usr/bin/env node
/**
 * server.mjs — dfmi-paykit as an MCP server (stdio).
 *
 * Three tools a seller agent can call:
 *   create_invoice  — create a payment request with a unique exact amount
 *   check_payment   — verify settlement on the dfmi chain (read-only)
 *   send_reminder   — draft a reminder; returns text, sends nothing
 *
 * Boundaries, by design: no private keys, no custody, no outbound email or messages, no writes to the chain.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.mjs';
import { PayKit } from './paykit.mjs';

// stdout belongs to the MCP transport. Anything a library logs must go to stderr.
console.log = (...a) => console.error(...a);

const cfg = loadConfig(process.argv[2]);
const kit = new PayKit(cfg);
const server = new McpServer({ name: 'dfmi-paykit', version: '0.1.0' });

const json = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] });

server.registerTool('create_invoice', {
  title: 'Create invoice',
  description: `Create a payment request on ${cfg.chain} in ${cfg.symbol}. Returns an exact amount (with a unique fractional suffix) the payer must send to pay_to; matching is by amount, so no per-invoice address or key is needed.`,
  inputSchema: {
    payee_address: z.string().describe('Seller address that will receive the payment'),
    amount: z.union([z.string(), z.number()]).describe(`Amount in ${cfg.symbol}, e.g. "2.00"`),
    due_date: z.string().optional().describe('ISO 8601 due date, e.g. 2026-09-30T00:00:00Z'),
    memo: z.string().optional().describe('What the invoice is for'),
    payer_hint: z.string().optional().describe('Expected payer address, if known (tightens matching)'),
  },
}, async (a) => { try { return json(await kit.createInvoice(a)); } catch (e) { return fail(e); } });

server.registerTool('check_payment', {
  title: 'Check payment',
  description: `Verify on the ${cfg.chain} chain whether an invoice has been settled. Read-only. Returns status open | paid | partial | overdue | unknown. "unknown" means the chain could not be read; it never means "unpaid".`,
  inputSchema: {
    invoice_id: z.string().describe('Invoice id from create_invoice'),
    tx_hash: z.string().optional().describe('Optional settlement transaction hash (e.g. from an x402 PAYMENT-RESPONSE receipt) to verify directly'),
  },
}, async (a) => { try { return json(await kit.checkPayment(a)); } catch (e) { return fail(e); } });

server.registerTool('send_reminder', {
  title: 'Draft payment reminder',
  description: 'Draft a reminder for an unpaid invoice. Returns subject and body text only; paykit never sends anything. The calling agent decides whether and how to deliver it.',
  inputSchema: {
    invoice_id: z.string(),
    tone: z.enum(['polite', 'firm', 'final']).optional().describe('Escalation tone; default polite'),
    channel_hint: z.enum(['email', 'chat']).optional().describe('Formats the body for the channel; default email'),
  },
}, async (a) => { try { return json(kit.draftReminder(a)); } catch (e) { return fail(e); } });

server.registerTool('list_invoices', {
  title: 'List invoices',
  description: 'List invoices in the local store, optionally filtered by status or payee.',
  inputSchema: {
    status: z.enum(['open', 'paid', 'partial', 'overdue', 'unknown']).optional(),
    payee: z.string().optional(),
  },
}, async (a) => { try { return json(kit.store.list(a).map(i => ({ invoice_id: i.id, status: i.status, exact_amount: i.exact_amount, symbol: i.symbol, due_date: i.due_date, memo: i.memo }))); } catch (e) { return fail(e); } });

await server.connect(new StdioServerTransport());
