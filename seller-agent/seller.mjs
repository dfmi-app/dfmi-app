#!/usr/bin/env node
/**
 * seller.mjs — a selling agent for the dfmi chain, built on the Claude Agent SDK.
 *
 * Rules, tools and the delivery gate come from seller-core.mjs (shared with seller-ollama.mjs and goods-server.mjs).
 * Two tool sets, both served in-process (no stdio subprocess to go wrong):
 *   dfmi-paykit   — create_invoice, check_payment, send_reminder, list_invoices (the paykit library, wrapped as MCP tools)
 *   seller-goods  — deliver_goods(invoice_id): releases the goods ONLY if the invoice is settled on-chain.
 *                   The check is in the tool's code, not in the prompt, so the model cannot be talked into delivering early.
 *
 * Set PAYKIT_MCP=stdio to use paykit's standalone MCP server (paykit/src/server.mjs) as a subprocess instead —
 * that is how a third-party agent would mount it.
 *
 * Usage:
 *   node seller.mjs "Sell the market report to 0x<buyer> for 0.02 dUSD, due in 7 days."
 *   node seller.mjs "Has inv_2a45e5acb8e5 been paid? If so, deliver it. If not, draft a polite reminder."
 *   node seller.mjs --repl            # interactive
 *
 * Auth: CLAUDE_CODE_OAUTH_TOKEN (Claude subscription) or ANTHROPIC_API_KEY (API key) — set one, not both.
 * Requires Node 18+ and `npm install` in ../paykit and here.
 */
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createInterface } from 'node:readline';
import { cfg, kit, CATALOG, SYSTEM, deliverGoods, PAYKIT_SERVER, PAYKIT_CONFIG } from './seller-core.mjs';

const json = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] });

// ---------------------------------------------------------------- paykit as in-process MCP tools (same four tools as paykit/src/server.mjs)
const paykit = createSdkMcpServer({
  name: 'dfmi-paykit',
  version: '0.1.0',
  tools: [
    tool('create_invoice',
      `Create a payment request on ${cfg.chain} in ${cfg.symbol}. Returns an exact amount (unique fractional suffix) the payer must send to pay_to; matching is by amount.`,
      {
        payee_address: z.string().describe('Seller address that will receive the payment'),
        amount: z.union([z.string(), z.number()]).describe(`Amount in ${cfg.symbol}, e.g. "2.00"`),
        due_date: z.string().optional().describe('ISO 8601 due date'),
        memo: z.string().optional().describe('What the invoice is for'),
        payer_hint: z.string().optional().describe('Expected payer (buyer) address, if known'),
      },
      async (a) => { try { return json(await kit.createInvoice(a)); } catch (e) { return fail(e); } }),
    tool('check_payment',
      `Verify on the ${cfg.chain} chain whether an invoice has been settled. Read-only. Returns status open | paid | partial | overdue | unknown. "unknown" means the chain could not be read; it never means "unpaid".`,
      { invoice_id: z.string(), tx_hash: z.string().optional().describe('Optional settlement tx hash to verify directly') },
      async (a) => { try { return json(await kit.checkPayment(a)); } catch (e) { return fail(e); } }),
    tool('send_reminder',
      'Draft a reminder for an unpaid invoice. Returns subject and body text only; nothing is sent.',
      { invoice_id: z.string(), tone: z.enum(['polite', 'firm', 'final']).optional(), channel_hint: z.enum(['email', 'chat']).optional() },
      async (a) => { try { return json(kit.draftReminder(a)); } catch (e) { return fail(e); } }),
    tool('list_invoices',
      'List invoices in the local store, optionally filtered by status or payee.',
      { status: z.enum(['open', 'paid', 'partial', 'overdue', 'unknown']).optional(), payee: z.string().optional() },
      async (a) => { try { return json(kit.store.list(a).map(i => ({ invoice_id: i.id, status: i.status, exact_amount: i.exact_amount, symbol: i.symbol, due_date: i.due_date, memo: i.memo }))); } catch (e) { return fail(e); } }),
  ],
});

// ---------------------------------------------------------------- delivery gate: enforced in code
const goods = createSdkMcpServer({
  name: 'seller-goods',
  version: '0.1.0',
  tools: [
    tool('deliver_goods', 'Release the goods for a settled invoice. Verifies on-chain settlement before releasing; refuses otherwise.',
      { invoice_id: z.string(), product: z.enum(Object.keys(CATALOG)).optional().describe('defaults to market-report') },
      // The gate lives in seller-core.deliverGoods: it re-checks the chain right now; the model's belief is irrelevant.
      async (a) => { try { return json(await deliverGoods(a)); } catch (e) { return fail(e); } }),
  ],
});

// ---------------------------------------------------------------- the agent (rules: seller-core.SYSTEM)
const mcpServers = process.env.PAYKIT_MCP === 'stdio'
  ? { 'dfmi-paykit': { type: 'stdio', command: 'node', args: [PAYKIT_SERVER, PAYKIT_CONFIG] }, 'seller-goods': goods }
  : { 'dfmi-paykit': paykit, 'seller-goods': goods };

async function run(prompt) {
  const q = query({
    prompt,
    options: {
      systemPrompt: SYSTEM,
      mcpServers,
      allowedTools: [
        'mcp__dfmi-paykit__create_invoice', 'mcp__dfmi-paykit__check_payment',
        'mcp__dfmi-paykit__send_reminder', 'mcp__dfmi-paykit__list_invoices',
        'mcp__seller-goods__deliver_goods',
      ],
      disallowedTools: ['Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'WebSearch'],
      permissionMode: 'dontAsk',
      maxTurns: 12,
      stderr: (d) => { if (process.env.SELLER_DEBUG) process.stderr.write('[cli] ' + d); },
    },
  });

  for await (const m of q) {
    if (m.type === 'assistant') {
      for (const b of m.message.content ?? []) {
        if (b.type === 'text' && b.text.trim()) console.log(b.text.trim());
        if (b.type === 'tool_use') console.error(`  ↳ ${b.name}(${JSON.stringify(b.input)})`);
      }
    } else if (m.type === 'user' && process.env.SELLER_DEBUG) {
      for (const b of m.message.content ?? []) if (b.type === 'tool_result') console.error(`  ← ${JSON.stringify(b.content).slice(0, 300)}`);
    } else if (m.type === 'result') {
      console.error(`— done (${m.subtype}${m.total_cost_usd != null ? `, $${m.total_cost_usd.toFixed(4)}` : ''})`);
    }
  }
}

const argv = process.argv.slice(2);
if (argv[0] === '--repl') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => rl.question('seller> ', async (line) => { if (!line.trim()) return ask(); await run(line); ask(); });
  ask();
} else if (argv.length) {
  await run(argv.join(' '));
} else {
  console.error('usage: node seller.mjs "<instruction>"   |   node seller.mjs --repl');
  process.exit(2);
}
