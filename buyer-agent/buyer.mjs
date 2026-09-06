#!/usr/bin/env node
/**
 * buyer.mjs — a buying agent for the dfmi chain, built on the Claude Agent SDK.
 *
 * Tools are served in-process from buyer-core (buykit wrapped as MCP tools). The owner's per-purchase limit
 * (BUYER_MAX) is passed into buykit as max_amount, so the model cannot forget it.
 *
 *   node buyer.mjs "Pay invoice inv_8325d678b792: 0.020287 dUSD to 0x35EE…0eBe on eip155:112172."
 *   node buyer.mjs "What is my budget?"
 *   node buyer.mjs --repl
 *
 * Env: SESSION_WALLET, SESSION_KEY (buykit), BUYER_MAX (default 0.05),
 *      CLAUDE_CODE_OAUTH_TOKEN (Claude subscription) or ANTHROPIC_API_KEY — set one, not both.
 */
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createInterface } from 'node:readline';
import { SYSTEM, execTool, BUYER_MAX } from './buyer-core.mjs';

const json = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] });
const wrap = (name) => async (a) => { try { return json(await execTool(name, a)); } catch (e) { return fail(e); } };

const buykit = createSdkMcpServer({
  name: 'dfmi-buykit', version: '0.1.0',
  tools: [
    tool('check_budget', 'What this session key may still spend: cap, spent, remaining, expiry, wallet balance.', {}, wrap('check_budget')),
    tool('pay_invoice', `Pay an exact amount to a payee from the session wallet, within its bounds, via the facilitator. Refuses over cap / over max_amount (${BUYER_MAX}) / outside intent / underfunded / already paid.`,
      { pay_to: z.string(), exact_amount: z.union([z.string(), z.number()]), chain: z.string().optional(), invoice_id: z.string().optional(), memo: z.string().optional(), max_amount: z.union([z.string(), z.number()]).optional() },
      wrap('pay_invoice')),
    tool('list_purchases', 'List payments made by this buyer.', { status: z.enum(['paid', 'already_paid', 'failed']).optional(), pay_to: z.string().optional() }, wrap('list_purchases')),
  ],
});

async function run(prompt) {
  const q = query({ prompt, options: {
    systemPrompt: SYSTEM, mcpServers: { 'dfmi-buykit': buykit },
    allowedTools: ['mcp__dfmi-buykit__check_budget', 'mcp__dfmi-buykit__pay_invoice', 'mcp__dfmi-buykit__list_purchases'],
    disallowedTools: ['Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'WebSearch'],
    permissionMode: 'dontAsk', maxTurns: 10,
    stderr: (d) => { if (process.env.BUYER_DEBUG) process.stderr.write('[cli] ' + d); },
  } });
  for await (const m of q) {
    if (m.type === 'assistant') for (const b of m.message.content ?? []) {
      if (b.type === 'text' && b.text.trim()) console.log(b.text.trim());
      if (b.type === 'tool_use') console.error(`  ↳ ${b.name}(${JSON.stringify(b.input)})`);
    } else if (m.type === 'user' && process.env.BUYER_DEBUG) {
      for (const b of m.message.content ?? []) if (b.type === 'tool_result') console.error(`  ← ${JSON.stringify(b.content).slice(0, 300)}`);
    } else if (m.type === 'result') console.error(`— done (${m.subtype}${m.total_cost_usd != null ? `, $${m.total_cost_usd.toFixed(4)}` : ''})`);
  }
}

const argv = process.argv.slice(2);
if (argv[0] === '--repl') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => rl.question('buyer> ', async (line) => { if (!line.trim()) return ask(); await run(line); ask(); });
  ask();
} else if (argv.length) await run(argv.join(' '));
else { console.error('usage: node buyer.mjs "<instruction>"   |   node buyer.mjs --repl'); process.exit(2); }
