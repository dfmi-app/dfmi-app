// store.test.mjs — finding #4: atomic claim+settle, cross-process safety, no silent discard of history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { InvoiceStore, ownerState } from '../src/store.mjs';

const LOCKWORKER = new URL('./lockworker.mjs', import.meta.url).pathname;

const PAYEE = '0x5050A4F4b3f9338C3472dcC01A87C76A144b3c9c';
const freshStore = () => join(mkdtempSync(join(tmpdir(), 'paykit4-')), 'invoices.json');
const STORE_MJS = new URL('../src/store.mjs', import.meta.url).pathname;

test('#4 a corrupt store is preserved and surfaced, never silently discarded', () => {
  const p = freshStore();
  writeFileSync(p, '{ this is not valid json');
  assert.throws(() => new InvoiceStore(p), /corrupt/, 'must refuse rather than start empty');
  const backups = readdirSync(dirname(p)).filter(f => f.includes('.corrupt-'));
  assert.equal(backups.length, 1, 'the corrupt file is backed up');
  assert.equal(readFileSync(p, 'utf8'), '{ this is not valid json', 'the original is left intact, not overwritten');
});

test('#4 settle claims the tx and marks paid in one write; survives restart; rejects a second invoice', () => {
  const p = freshStore();
  const s = new InvoiceStore(p);
  s.put({ id: 'inv_a', payee: PAYEE, status: 'open', amount_units: '100' });
  s.put({ id: 'inv_b', payee: PAYEE, status: 'open', amount_units: '100' });

  const r1 = s.settle('inv_a', { txHash: '0xTX' }, { tx_hash: '0xTX', block: 10 });
  assert.equal(r1.ok, true);

  // one write: the persisted file has BOTH the consume record and the paid status (no half-state)
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(raw.consumed['0xtx'], 'inv_a');
  assert.equal(raw.invoices.inv_a.status, 'paid');

  // restart: a fresh store instance reads the committed settlement and claim
  const s2 = new InvoiceStore(p);
  assert.equal(s2.get('inv_a').status, 'paid');
  assert.equal(s2.txConsumedBy('0xTX'), 'inv_a');

  // the same tx cannot settle a different invoice
  const r2 = s2.settle('inv_b', { txHash: '0xTX' }, { tx_hash: '0xTX', block: 11 });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /already settled/);
  assert.equal(s2.get('inv_b').status, 'open', 'the loser is untouched');

  // re-settling the same invoice from the same tx is idempotent
  const r3 = s2.settle('inv_a', { txHash: '0xTX' }, { tx_hash: '0xTX', block: 10 });
  assert.equal(r3.ok, true);
  assert.equal(r3.already, true);
});

// a worker process that writes one invoice through the locked store
function putWorker(p, id) {
  const code = `import { InvoiceStore } from ${JSON.stringify(STORE_MJS)};` +
    `new InvoiceStore(process.env.WP).put({ id: process.env.WID, payee: ${JSON.stringify(PAYEE)}, status: 'open', amount_units: '1' });`;
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, WP: p, WID: id }, stdio: 'inherit' });
    c.on('exit', (code) => code === 0 ? res() : rej(new Error(`worker ${id} exited ${code}`)));
    c.on('error', rej);
  });
}

test('#4 concurrent writers in separate processes do not lose updates', async () => {
  const p = freshStore();
  const N = 8;
  await Promise.all(Array.from({ length: N }, (_, i) => putWorker(p, `inv_w${i}`)));
  const ids = new InvoiceStore(p).list().map(i => i.id).sort();
  assert.equal(ids.length, N, 'every concurrent write survived (no last-writer-wins clobber)');
  for (let i = 0; i < N; i++) assert.ok(ids.includes(`inv_w${i}`), `inv_w${i} present`);
});

// two worker processes race to settle their own invoice from the SAME transaction
function settleWorker(p, id, tx) {
  const code = `import { InvoiceStore } from ${JSON.stringify(STORE_MJS)};` +
    `const s = new InvoiceStore(process.env.WP);` +
    `const r = s.settle(process.env.WID, { txHash: process.env.WTX }, { tx_hash: process.env.WTX, block: 1 });` +
    `process.exit(r.ok && !r.already ? 0 : 3);`; // 0 = this process won the claim
  return new Promise((res) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, WP: p, WID: id, WTX: tx }, stdio: 'inherit' });
    c.on('exit', (code) => res(code === 0));
  });
}

test('#4 ownerState: a live owner is never reclaimable (no matter the age); only a confirmed-dead one is', async () => {
  assert.equal(ownerState(`${process.pid}:tok`), 'live', 'this process is alive');
  assert.equal(ownerState(''), 'unknown', 'incomplete content -> unknown (never stolen)');
  assert.equal(ownerState('notapid:tok'), 'unknown');
  const deadPid = await new Promise(res => { const c = spawn(process.execPath, ['-e', '0']); c.on('exit', () => res(c.pid)); });
  assert.equal(ownerState(`${deadPid}:tok`), 'dead', 'an exited process is confirmed dead');
});

// Hold the lock from another process that has paused for a long "age" (ancient mtime), then crash it.
const holderCode =
  `import { writeFileSync, utimesSync } from 'node:fs';` +
  `const lf = process.env.LF; writeFileSync(lf, process.pid + ':held');` +
  `const old = (Date.now() - 600000) / 1000; try { utimesSync(lf, old, old); } catch {}` + // mtime 10 min ago
  `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;

test('#4 a paused holder (ancient mtime, still alive) is NOT stolen; a crashed holder needs manual cleanup', { timeout: 30_000 }, async () => {
  const p = freshStore();
  const lockFile = p + '.lock';
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderCode], { env: { ...process.env, LF: lockFile }, stdio: 'inherit' });
  try {
    for (let i = 0; i < 200 && !existsSync(lockFile); i++) await new Promise(r => setTimeout(r, 25));
    assert.ok(existsSync(lockFile), 'holder took the lock');
    const before = readFileSync(lockFile, 'utf8');
    // a contender must NOT steal a live holder's lock, however old the mtime: it waits, then errors
    assert.throws(() => new InvoiceStore(p).put({ id: 'inv_steal', payee: PAYEE, status: 'open', amount_units: '1' }),
      /timed out acquiring store lock/, 'a live (paused) holder is never stolen from');
    assert.equal(readFileSync(lockFile, 'utf8'), before, 'the contender did not move or rewrite the holder\'s lock');
  } finally {
    holder.kill('SIGKILL'); // crash the holder WITHOUT releasing the lock
    await new Promise(res => holder.on('exit', res));
  }
  // Interim policy: a crashed owner's lock is NOT auto-reclaimed. Acquisition fails and asks for manual cleanup.
  assert.throws(() => new InvoiceStore(p).get('x'), /remove the lock file manually/, 'a stale lock requires manual cleanup — no auto-steal');
  // operator stops all writers, verifies quiescence, removes the lock -> normal operation resumes
  unlinkSync(lockFile);
  const s = new InvoiceStore(p);
  s.put({ id: 'inv_after', payee: PAYEE, status: 'open', amount_units: '1' });
  assert.equal(new InvoiceStore(p).get('inv_after').id, 'inv_after', 'resumes after manual cleanup');
});

test('#4 [deterministic] a live holder is never displaced; a contender fails cleanly without touching the lock', { timeout: 30_000 }, async () => {
  const p = freshStore();
  const lockFile = p + '.lock';
  const A = spawn(process.execPath, [LOCKWORKER], { env: { ...process.env, LWP: p }, stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    // barrier: wait until A is IN the critical section. Reject (never hang) on a spawn error or an exit before ACQUIRED.
    await new Promise((res, rej) => {
      let s = '';
      A.once('error', rej);
      A.once('exit', (code, sig) => rej(new Error(`worker exited before ACQUIRED (code ${code}, signal ${sig})`)));
      A.stdout.on('data', d => { s += String(d); if (s.includes('ACQUIRED')) res(); });
    });
    const held = readFileSync(lockFile, 'utf8');
    assert.match(held, /^\d+:[0-9a-f]+$/, 'A owns the lock');
    // contender B, while A is in the critical section: fails with a bounded timeout and does NOT move/delete the lock
    assert.throws(() => new InvoiceStore(p).put({ id: 'inv_B', payee: PAYEE, status: 'open', amount_units: '1' }), /timed out acquiring store lock/);
    assert.equal(existsSync(lockFile), true, 'lock still present after B failed');
    assert.equal(readFileSync(lockFile, 'utf8'), held, 'B did not move, rewrite, or delete A\'s lock');
    const exited = new Promise(res => A.once('exit', res));
    A.stdin.write('x'); // barrier 2: release A
    await exited;
    assert.equal(existsSync(lockFile), false, 'A released its own lock on exit');
    // only after A left could a new writer enter -> at most one process was ever in the critical section
    const s = new InvoiceStore(p); s.put({ id: 'inv_C', payee: PAYEE, status: 'open', amount_units: '1' });
    assert.equal(new InvoiceStore(p).get('inv_B'), null, 'the contender never entered the critical section');
    assert.equal(new InvoiceStore(p).get('inv_C').id, 'inv_C');
  } finally {
    // guarantee the worker is never left blocked, even if an assertion above threw
    if (A.exitCode === null && A.signalCode === null) { try { A.kill('SIGKILL'); } catch { } }
  }
});

test('#4 withLock is synchronous-only: an async/Promise-returning callback is rejected and the lock is released', () => {
  const p = freshStore();
  const s = new InvoiceStore(p);
  assert.throws(() => s.withLock(async () => { await Promise.resolve(); }), /synchronous-only/, 'a thenable-returning callback is rejected loudly');
  // the lock was released despite the throw (a leaked lock would make the next op time out)
  s.put({ id: 'inv_sync', payee: PAYEE, status: 'open', amount_units: '1' });
  assert.equal(new InvoiceStore(p).get('inv_sync').id, 'inv_sync', 'lock was freed; normal ops continue');
});

test('#4 recovers from a claim-without-settlement orphan: the invoice completes, others stay blocked', () => {
  const p = freshStore();
  // simulate a pre-atomic crash state: tx claimed for inv_a, but inv_a was never marked paid
  writeFileSync(p, JSON.stringify({
    invoices: { inv_a: { id: 'inv_a', payee: PAYEE, status: 'open', amount_units: '100' }, inv_b: { id: 'inv_b', payee: PAYEE, status: 'open', amount_units: '100' } },
    consumed: { '0xorphan': 'inv_a' },
  }));
  const s = new InvoiceStore(p);
  const bad = s.settle('inv_b', { txHash: '0xorphan' }, { tx_hash: '0xorphan', block: 5 });
  assert.equal(bad.ok, false, 'another invoice cannot take the orphaned tx');
  const good = s.settle('inv_a', { txHash: '0xorphan' }, { tx_hash: '0xorphan', block: 5 });
  assert.equal(good.ok, true, 'the rightful invoice completes its settlement');
  assert.equal(new InvoiceStore(p).get('inv_a').status, 'paid');
});

test('#4 concurrent claims of one tx from two processes: exactly one wins', async () => {
  const p = freshStore();
  const s = new InvoiceStore(p);
  s.put({ id: 'inv_x', payee: PAYEE, status: 'open', amount_units: '100' });
  s.put({ id: 'inv_y', payee: PAYEE, status: 'open', amount_units: '100' });
  const wins = await Promise.all([settleWorker(p, 'inv_x', '0xRACE'), settleWorker(p, 'inv_y', '0xRACE')]);
  assert.equal(wins.filter(Boolean).length, 1, 'exactly one process claimed the tx');
  const s2 = new InvoiceStore(p);
  assert.equal(s2.txConsumedBy('0xRACE') !== null, true, 'the tx is consumed by the winner');
  const paid = ['inv_x', 'inv_y'].filter(id => s2.get(id).status === 'paid');
  assert.equal(paid.length, 1, 'only the winning invoice is paid');
});
