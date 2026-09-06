/**
 * store.mjs — a local JSON file of purchases made by this buyer. One file, one buyer, no server.
 *
 * Purchase shape:
 *   { id, invoice_id, pay_to, amount, amount_units, symbol, chain, tx_hash, block, payer_wallet, session_key,
 *     memo, created_at, status }          status: "paid" | "already_paid" | "failed"
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export class PurchaseStore {
  constructor(path) { this.path = path; this.data = this.#read(); }
  #read() { if (!existsSync(this.path)) return { purchases: {} }; try { return JSON.parse(readFileSync(this.path, 'utf8')); } catch { return { purchases: {} }; } }
  #write() { const tmp = this.path + '.tmp'; writeFileSync(tmp, JSON.stringify(this.data, null, 2)); renameSync(tmp, this.path); }
  newId() { return 'pur_' + randomBytes(6).toString('hex'); }
  put(p) { this.data.purchases[p.id] = p; this.#write(); return p; }
  get(id) { return this.data.purchases[id] ?? null; }
  byInvoice(invoice_id) { return Object.values(this.data.purchases).find(p => p.invoice_id === invoice_id && p.status !== 'failed') ?? null; }
  list(filter = {}) {
    return Object.values(this.data.purchases).filter(p =>
      (!filter.status || p.status === filter.status) && (!filter.pay_to || p.pay_to.toLowerCase() === filter.pay_to.toLowerCase()));
  }
}
