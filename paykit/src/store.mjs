/**
 * store.mjs — a local JSON file of invoices. One file, one seller, no server.
 *
 * Invoice shape:
 *   { id, payee, payer_hint, amount, exact_amount, amount_units, chain, asset, symbol, decimals,
 *     due_date, memo, created_at, created_block, status, settlement, reminders: [] }
 *
 * status: "open" | "paid" | "partial" | "overdue" | "unknown"
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export class InvoiceStore {
  constructor(path) { this.path = path; this.data = this.#read(); }

  #read() {
    if (!existsSync(this.path)) return { invoices: {} };
    try { return JSON.parse(readFileSync(this.path, 'utf8')); } catch { return { invoices: {} }; }
  }
  #write() {
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  newId() { return 'inv_' + randomBytes(6).toString('hex'); }

  /** exact_amount uniqueness is per payee: two open invoices to the same address must not share an amount. */
  hasOpenExactAmount(payee, amountUnits) {
    return Object.values(this.data.invoices).some(i =>
      i.payee.toLowerCase() === payee.toLowerCase() && i.status !== 'paid' && i.amount_units === String(amountUnits));
  }

  put(inv) { this.data.invoices[inv.id] = inv; this.#write(); return inv; }
  get(id) { return this.data.invoices[id] ?? null; }
  list(filter = {}) {
    return Object.values(this.data.invoices).filter(i =>
      (!filter.status || i.status === filter.status) &&
      (!filter.payee || i.payee.toLowerCase() === filter.payee.toLowerCase()));
  }
}
