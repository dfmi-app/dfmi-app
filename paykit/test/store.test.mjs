// store.test.mjs — finding #4: atomic claim+settle, cross-process safety, no silent discard of history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { InvoiceStore } from '../src/store.mjs';

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
