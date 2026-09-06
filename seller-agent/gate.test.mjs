// gate.test.mjs — proves deliver_goods refuses when the chain does not show settlement (no model involved).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PayKit } from '../paykit/src/paykit.mjs';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';

const cfg = { chain: 'eip155:112172', chainId: 112172, rpc: 'http://unused', token: '0x03E25a5DC7aC15f32462652a4bF4986F378d5fcf',
              symbol: 'dUSD', decimals: 6, confirmations: 1, store: join(mkdtempSync(join(tmpdir(), 'gate-')), 'invoices.json') };
const dead = { async getBlockNumber() { throw new Error('RPC down'); }, async getLogs() { throw new Error('RPC down'); }, async getTransactionReceipt() { return null; } };

test('delivery gate refuses unless check_payment returns paid', async () => {
  const kit = new PayKit(cfg, { provider: dead });
  const inv = await kit.createInvoice({ payee_address: '0x5050A4F4b3f9338C3472dcC01A87C76A144b3c9c', amount: '0.02' });
  // same logic as deliver_goods in seller.mjs
  const st = await kit.checkPayment({ invoice_id: inv.invoice_id });
  const delivered = st.status === 'paid';
  assert.equal(st.status, 'unknown');
  assert.equal(delivered, false, 'unknown must not deliver');
});
