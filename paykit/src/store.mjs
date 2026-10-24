/**
 * store.mjs — a local JSON file of invoices. One file, one seller, no server.
 *
 * Invoice shape:
 *   { id, payee, payer_hint, amount, exact_amount, amount_units, chain, asset, symbol, decimals,
 *     due_date, memo, created_at, created_block, status, settlement, reminders: [] }
 *
 * status: "open" | "paid" | "partial" | "overdue" | "unknown"
 *
 * Safety (finding #4):
 *   - Single-writer across processes: every operation takes an exclusive lock (atomic mkdir, with stale recovery),
 *     reloads the file fresh, applies its change, and writes atomically (tmp + rename). No cached `this.data`, so
 *     two processes sharing the file never overwrite each other with stale state.
 *   - Consume-once + settlement are ONE write (settle()): there is no window where a transfer is claimed but the
 *     invoice is not yet marked paid, or vice versa.
 *   - A corrupt store is preserved and surfaced, never silently discarded as empty.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, rmdirSync, statSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const LOCK_STALE_MS = 10_000; // a lock older than this is assumed abandoned by a dead process
const LOCK_WAIT_MS = 5_000;   // give up acquiring after this

function sleep(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* fallback: busy */ const u = Date.now() + ms; while (Date.now() < u); } }

export class InvoiceStore {
  constructor(path) {
    this.path = path;
    this.lockDir = path + '.lock';
    // One-time backfill of the consumed index from invoices settled before this guard existed — under the lock,
    // so two processes starting at once do not both write.
    this.#withLock(() => {
      const d = this.#readOrThrow();
      let dirty = false;
      for (const inv of Object.values(d.invoices)) {
        const h = inv.settlement?.tx_hash;
        if (inv.status === 'paid' && h && !this.#consumedBy(d, h)) { d.consumed[String(h).toLowerCase()] = inv.id; dirty = true; }
      }
      if (dirty) this.#write(d);
    });
  }

  // ---------------------------------------------------------------- disk I/O
  #readOrThrow() {
    if (!existsSync(this.path)) return { invoices: {}, consumed: {} };
    let raw;
    try { raw = readFileSync(this.path, 'utf8'); } catch (e) { throw new Error(`cannot read store ${this.path}: ${e.message}`); }
    if (raw.trim() === '') return { invoices: {}, consumed: {} };
    let d;
    try { d = JSON.parse(raw); }
    catch (e) {
      // Never silently discard payment history: preserve the corrupt file and refuse rather than start empty.
      const bak = `${this.path}.corrupt-${Date.now()}`;
      try { copyFileSync(this.path, bak); } catch { /* best effort */ }
      throw new Error(`store ${this.path} is corrupt (backed up to ${bak}); refusing to start empty: ${e.message}`);
    }
    d.invoices ??= {};
    d.consumed ??= {};
    return d;
  }
  #write(d) {
    const tmp = `${this.path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(d, null, 2));
    renameSync(tmp, this.path); // atomic replace on the same filesystem
  }

  // ---------------------------------------------------------------- cross-process lock
  #acquire() {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try { mkdirSync(this.lockDir); return; } // atomic: fails if another process holds it
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - statSync(this.lockDir).mtimeMs > LOCK_STALE_MS) { rmdirSync(this.lockDir); continue; } } catch { /* vanished: retry */ }
        if (Date.now() > deadline) throw new Error(`timed out acquiring store lock ${this.lockDir}`);
        sleep(15);
      }
    }
  }
  #release() { try { rmdirSync(this.lockDir); } catch { /* already gone */ } }
  #withLock(fn) { this.#acquire(); try { return fn(); } finally { this.#release(); } }

  // ---------------------------------------------------------------- helpers over a snapshot
  #consumedBy(d, txHash) {
    const h = String(txHash).toLowerCase();
    for (const [key, invId] of Object.entries(d.consumed)) if (key === h || key.startsWith(h + ':')) return invId;
    return null;
  }

  newId() { return 'inv_' + randomBytes(6).toString('hex'); }

  // ---------------------------------------------------------------- reads (fresh each call)
  get(id) { return this.#withLock(() => this.#readOrThrow().invoices[id] ?? null); }
  list(filter = {}) {
    return this.#withLock(() => Object.values(this.#readOrThrow().invoices).filter(i =>
      (!filter.status || i.status === filter.status) && (!filter.payee || i.payee.toLowerCase() === filter.payee.toLowerCase())));
  }
  /** exact_amount uniqueness is per payee: two open invoices to the same address must not share an amount. */
  hasOpenExactAmount(payee, amountUnits) {
    return this.#withLock(() => Object.values(this.#readOrThrow().invoices).some(i =>
      i.payee.toLowerCase() === payee.toLowerCase() && i.status !== 'paid' && i.amount_units === String(amountUnits)));
  }
  /** Which invoice (if any) has already settled from this transaction. */
  txConsumedBy(txHash) { return this.#withLock(() => this.#consumedBy(this.#readOrThrow(), txHash)); }

  // ---------------------------------------------------------------- writes
  put(inv) { return this.#withLock(() => { const d = this.#readOrThrow(); d.invoices[inv.id] = inv; this.#write(d); return inv; }); }

  /**
   * Atomically settle an invoice from one payment event: claim the transfer (consume-once) AND mark the invoice
   * paid in a single locked read-modify-write. Returns { ok, invoice, reason, already }.
   * No half-state: either both the claim and the settlement are persisted, or neither is.
   */
  settle(invoiceId, { txHash, logIndex = null }, settlement) {
    return this.#withLock(() => {
      const d = this.#readOrThrow();
      const inv = d.invoices[invoiceId];
      if (!inv) return { ok: false, reason: 'unknown invoice' };
      if (inv.status === 'paid') return { ok: true, invoice: inv, already: true };
      const owner = this.#consumedBy(d, txHash);
      if (owner && owner !== invoiceId) return { ok: false, reason: 'transaction already settled another invoice' };
      const key = logIndex == null ? String(txHash).toLowerCase() : `${String(txHash).toLowerCase()}:${logIndex}`;
      d.consumed[key] = invoiceId;
      inv.status = 'paid';
      inv.settlement = settlement;
      inv.last_check = null;
      this.#write(d); // single write: claim + settlement land together
      return { ok: true, invoice: inv };
    });
  }

  /** Mark a non-settling status (open/partial/overdue/unknown) with a last_check detail. */
  mark(invoiceId, status, detail) {
    return this.#withLock(() => {
      const d = this.#readOrThrow();
      const inv = d.invoices[invoiceId];
      if (!inv) return null;
      inv.status = status;
      inv.last_check = { at: new Date().toISOString(), ...detail };
      this.#write(d);
      return inv;
    });
  }
}
