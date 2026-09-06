/**
 * buyer-core.mjs — everything the buyer agent knows, independent of which model runs it.
 *
 *   SYSTEM        the rules (one copy, shared by every runner)
 *   TOOLS         the three buykit tools as JSON Schema (OpenAI/Ollama tool-calling format)
 *   execTool()    runs a tool by name against buykit
 *
 * Runners: buyer.mjs (Claude Agent SDK), buyer-ollama.mjs (any OpenAI-compatible endpoint), and for Codex CLI
 * buykit/src/server.mjs mounted directly (codex-setup.sh).
 *
 * The owner's spending limit for a single purchase comes in as BUYER_MAX (default 0.05 dUSD) and is passed to
 * pay_invoice as max_amount, so it is enforced in buykit's code, not by the model remembering it.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadSessionKey } from '../buykit/src/config.mjs';
import { BuyKit } from '../buykit/src/buykit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BUYKIT_SERVER = resolve(HERE, '..', 'buykit', 'src', 'server.mjs');
export const BUYKIT_CONFIG = resolve(HERE, '..', 'buykit', 'buykit.config.json');
export const BUYER_MAX = process.env.BUYER_MAX ?? '0.05';

export const cfg = loadConfig(process.env.BUYKIT_CONFIG ?? BUYKIT_CONFIG);
export const kit = new BuyKit(cfg, loadSessionKey());

export const SYSTEM = `You are a buying agent on the dfmi network (chain ${cfg.chain}, unit ${cfg.symbol}).
You pay for goods your owner asked you to buy. You spend from a session wallet (${cfg.wallet}) with a key your owner granted; the wallet enforces a cap and expiry on-chain, and your owner can revoke it at any time.

Rules:
- Before paying anything, call check_budget and make sure the amount fits. Your owner's limit for a single purchase is ${BUYER_MAX} ${cfg.symbol}; always pass it as max_amount to pay_invoice.
- Pay exactly what the seller's invoice says: exact_amount verbatim (the fractional suffix is how the seller matches it), pay_to verbatim, chain verbatim. Never round, never pay a different address than the invoice states, never pay an invoice on another chain.
- Pay an invoice once. If pay_invoice reports already_paid, tell the owner and do not try again.
- If pay_invoice refuses (over cap, outside intent, chain mismatch, over max_amount), report the reason to the owner and stop. Do not look for another way to pay.
- If pay_invoice says the result is unclear, say so and do not retry; the owner should check the chain first.
- Be brief. Report transaction hashes, amounts and addresses verbatim.`;

const str = (description) => ({ type: 'string', description });
export const TOOLS = [
  { type: 'function', function: { name: 'check_budget',
    description: `What this session key may still spend on ${cfg.chain}: cap, spent, remaining, expiry, wallet balance.`,
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'pay_invoice',
    description: `Pay an exact amount of ${cfg.symbol} to a payee from the session wallet, within the session's bounds, via the facilitator. Refuses over cap / over max_amount / outside intent / underfunded / already paid.`,
    parameters: { type: 'object', required: ['pay_to', 'exact_amount'], properties: {
      pay_to: str("Seller's payee address from the invoice"),
      exact_amount: str('Exact amount from the invoice, e.g. "0.020287"'),
      chain: str('Chain from the invoice, e.g. eip155:112172'),
      invoice_id: str("Seller's invoice id"),
      memo: str('What this is for'),
      max_amount: str(`Ceiling for this payment; always ${BUYER_MAX}`) } } } },
  { type: 'function', function: { name: 'list_purchases',
    description: 'List payments made by this buyer.',
    parameters: { type: 'object', properties: { status: { type: 'string', enum: ['paid', 'already_paid', 'failed'] }, pay_to: str('Payee address') } } } },
];

export async function execTool(name, args = {}) {
  switch (name) {
    case 'check_budget':   return kit.checkBudget();
    case 'pay_invoice':    return kit.payInvoice({ ...args, max_amount: args.max_amount ?? BUYER_MAX });
    case 'list_purchases': return kit.listPurchases(args);
    default: throw new Error(`unknown tool ${name}`);
  }
}
