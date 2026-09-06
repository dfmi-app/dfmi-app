#!/usr/bin/env node
/**
 * cli.mjs — the same three operations from a shell, for testing without an MCP client.
 *
 *   node src/cli.mjs create <payee> <amount> [--due 2026-09-30] [--memo "..."] [--payer 0x...]
 *   node src/cli.mjs check  <invoice_id> [--tx 0x...]
 *   node src/cli.mjs remind <invoice_id> [--tone polite|firm|final] [--chat]
 *   node src/cli.mjs list   [--status open|paid|partial|overdue|unknown]
 */
import { loadConfig } from './config.mjs';
import { PayKit } from './paykit.mjs';

const [, , cmd, ...rest] = process.argv;
const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const has = (n) => rest.includes(n);
const out = (o) => console.log(JSON.stringify(o, null, 2));

const kit = new PayKit(loadConfig(process.env.PAYKIT_CONFIG));

try {
  if (cmd === 'create') out(await kit.createInvoice({ payee_address: rest[0], amount: rest[1], due_date: flag('--due'), memo: flag('--memo') ?? '', payer_hint: flag('--payer') }));
  else if (cmd === 'check') out(await kit.checkPayment({ invoice_id: rest[0], tx_hash: flag('--tx') }));
  else if (cmd === 'remind') out(kit.draftReminder({ invoice_id: rest[0], tone: flag('--tone') ?? 'polite', channel_hint: has('--chat') ? 'chat' : 'email' }));
  else if (cmd === 'list') out(kit.store.list({ status: flag('--status') }));
  else { console.error('usage: cli.mjs create|check|remind|list ...'); process.exit(2); }
} catch (e) { console.error('error:', e.message ?? e); process.exit(1); }
