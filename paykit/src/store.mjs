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
 *   - Single-writer across processes: every operation takes an exclusive lockfile (O_EXCL), reloads the file
 *     fresh, applies its change, and writes atomically (fsync tmp + rename). No cached `this.data`, so two
 *     processes never overwrite each other's state. A lock is reclaimed ONLY when its owner process is
 *     confirmed exited — there is no time-based steal — otherwise acquisition waits and then errors.
 *   - Consume-once + settlement are ONE write (settle()): there is no window where a transfer is claimed but the
 *     invoice is not yet marked paid, or vice versa.
 *   - A corrupt store is preserved and surfaced, never silently discarded as empty.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, openSync, writeSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const LOCK_WAIT_MS = 5_000; // wait this long for a lock, then throw — never silently steal a lock we did not create

function sleep(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const u = Date.now() + ms; while (Date.now() < u); } }

/**
 * The state of a lock's owner, parsed from its "pid:token" content: 'live', 'dead' (the PID returns ESRCH), or
 * 'unknown' (incomplete / unparseable). DIAGNOSTIC ONLY — it is used to make the acquire-timeout message more
 * helpful. It does NOT drive automatic reclamation: this store never deletes or moves a lock it did not create
 * (see #acquire), because reclaiming another process's lock cannot be done race-free with plain files. A stale
 * lock left by a crashed writer is cleared MANUALLY by an operator after confirming no writer is running.
 * Exported for test. Same-host only: liveness is not meaningful across NFS, so do not share this store over NFS.
 */
export function ownerState(content) {
  if (!content || !String(content).trim()) return 'unknown';  // created but owner not yet written: do not steal
  const pid = Number(String(content).split(':')[0]);
  if (!(pid > 0)) return 'unknown';
  try { process.kill(pid, 0); return 'live'; }                // signal 0: the process exists
  catch (e) { return e.code === 'ESRCH' ? 'dead' : 'live'; }  // ESRCH = gone; EPERM/other = cannot confirm exit -> treat as live
}

export class InvoiceStore {
  constructor(path) {
    this.path = path;
    this.lockFile = path + '.lock';
    this._lockToken = null;
    // One-time backfill of the consumed index from invoices settled before this guard existed — under the lock,
    // so two processes starting at once do not both write.
    this.withLock(() => {
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
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, JSON.stringify(d, null, 2)); fsyncSync(fd); } finally { closeSync(fd); } // flush before rename
    renameSync(tmp, this.path); // atomic replace of the visible file on the same filesystem
  }

  // ---------------------------------------------------------------- cross-process lock
  // Exclusive lockfile holding "pid:token". Acquire is atomic (O_EXCL). This store NEVER deletes or moves a lock
  // it did not create — reclaiming another process's lock cannot be done race-free with plain files — so a stale
  // lock from a crashed writer is cleared MANUALLY by an operator after confirming no writer runs. Acquisition
  // waits up to LOCK_WAIT_MS, checking the deadline on every retry, then throws (bounded; no auto-steal).
  // Release removes the lockfile only when its token is still ours, so one process never deletes another's lock.
  #acquire() {
    const mine = `${process.pid}:${randomBytes(8).toString('hex')}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try { const fd = openSync(this.lockFile, 'wx'); try { writeSync(fd, mine); fsyncSync(fd); } finally { closeSync(fd); } this._lockToken = mine; return; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;   // a real error (not "already held"): fail now
        if (Date.now() > deadline) {        // bounded wait elapsed — fail, never reclaim automatically
          let who = '';
          try { const c = readFileSync(this.lockFile, 'utf8'); who = ` held by pid ${String(c).split(':')[0]} (${ownerState(c)})`; } catch { /* vanished */ }
          throw new Error(`timed out acquiring store lock ${this.lockFile}${who}. Stop all writers, verify none is running, then remove the lock file manually.`);
        }
        sleep(20);
      }
    }
  }
  #release() {
    try { if (readFileSync(this.lockFile, 'utf8') === this._lockToken) unlinkSync(this.lockFile); } catch { /* already gone */ }
    this._lockToken = null;
  }
  /** Run `fn` with the store exclusively locked. Public so callers (and deterministic tests) can batch or hold. */
  withLock(fn) { this.#acquire(); try { return fn(); } finally { this.#release(); } }

  // ---------------------------------------------------------------- helpers over a snapshot
  #consumedBy(d, txHash) {
    const h = String(txHash).toLowerCase();
    for (const [key, invId] of Object.entries(d.consumed)) if (key === h || key.startsWith(h + ':')) return invId;
    return null;
  }

  newId() { return 'inv_' + randomBytes(6).toString('hex'); }

  // ---------------------------------------------------------------- reads (fresh each call)
  get(id) { return this.withLock(() => this.#readOrThrow().invoices[id] ?? null); }
  list(filter = {}) {
    return this.withLock(() => Object.values(this.#readOrThrow().invoices).filter(i =>
      (!filter.status || i.status === filter.status) && (!filter.payee || i.payee.toLowerCase() === filter.payee.toLowerCase())));
  }
  /** exact_amount uniqueness is per payee: two open invoices to the same address must not share an amount. */
  hasOpenExactAmount(payee, amountUnits) {
    return this.withLock(() => Object.values(this.#readOrThrow().invoices).some(i =>
      i.payee.toLowerCase() === payee.toLowerCase() && i.status !== 'paid' && i.amount_units === String(amountUnits)));
  }
  /** Which invoice (if any) has already settled from this transaction. */
  txConsumedBy(txHash) { return this.withLock(() => this.#consumedBy(this.#readOrThrow(), txHash)); }

  // ---------------------------------------------------------------- writes
  put(inv) { return this.withLock(() => { const d = this.#readOrThrow(); d.invoices[inv.id] = inv; this.#write(d); return inv; }); }

  /**
   * Atomically settle an invoice from one payment event: claim the transfer (consume-once) AND mark the invoice
   * paid in a single locked read-modify-write. Returns { ok, invoice, reason, already }.
   * No half-state: either both the claim and the settlement are persisted, or neither is.
   */
  settle(invoiceId, { txHash, logIndex = null }, settlement) {
    return this.withLock(() => {
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
    return this.withLock(() => {
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
