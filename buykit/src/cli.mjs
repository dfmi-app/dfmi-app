#!/usr/bin/env node
/**
 * cli.mjs — the same operations from a shell, for testing without an MCP client.
 *
 *   SESSION_WALLET=0x… SESSION_KEY=0x…  node src/cli.mjs budget
 *   SESSION_WALLET=0x… SESSION_KEY=0x…  node src/cli.mjs pay <pay_to> <exact_amount> [--invoice inv_…] [--max 0.05] [--memo "…"]
 *   SESSION_WALLET=0x… SESSION_KEY=0x…  node src/cli.mjs list [--status paid]
 */
import { loadConfig, loadSessionKey } from './config.mjs';
import { BuyKit } from './buykit.mjs';

const [, , cmd, ...rest] = process.argv;
const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const out = (o) => console.log(JSON.stringify(o, null, 2));

try {
  const kit = new BuyKit(loadConfig(process.env.BUYKIT_CONFIG), loadSessionKey());
  if (cmd === 'budget') out(await kit.checkBudget());
  else if (cmd === 'pay') out(await kit.payInvoice({ pay_to: rest[0], exact_amount: rest[1], invoice_id: flag('--invoice'), max_amount: flag('--max'), memo: flag('--memo') ?? '' }));
  else if (cmd === 'list') out(kit.listPurchases({ status: flag('--status'), pay_to: flag('--to') }));
  else { console.error('usage: cli.mjs budget | pay <pay_to> <exact_amount> [--invoice id] [--max n] | list [--status s]'); process.exit(2); }
} catch (e) { console.error('error:', e.message ?? e); process.exit(1); }
