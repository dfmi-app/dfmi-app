// test helper: hold the store lock inside the critical section across a stdin barrier, so a test can force a
// deterministic interleaving (announce "ACQUIRED", block until the parent sends one byte, then release+exit).
// Uses synchronous writeSync(1,…) so the barrier flushes BEFORE the blocking readSync (an async stdout write
// would stay buffered while the thread blocks, deadlocking the parent).
import { readSync, writeSync } from 'node:fs';
import { InvoiceStore } from '../src/store.mjs';

// Guard: this is a worker, not a test. `node --test` (no args) auto-discovers everything under test/, so do
// nothing unless actually invoked as a worker (LWP set) — otherwise it would block and look like a failed test.
if (process.env.LWP) {
  const store = new InvoiceStore(process.env.LWP);
  store.withLock(() => {
    writeSync(1, 'ACQUIRED\n');                                 // barrier 1: we are IN the critical section
    try { readSync(0, Buffer.alloc(1), 0, 1, null); } catch { } // block until the parent writes a byte (barrier 2)
  });
  writeSync(1, 'RELEASED\n');
}
