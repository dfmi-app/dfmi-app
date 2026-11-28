import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, AbiCoder, getAddress } from 'ethers';
import { PayKit } from '../src/paykit.mjs';

const cfg = { chain: 'eip155:112172', chainId: 112172, rpc: 'http://unused', token: '0x03E25a5DC7aC15f32462652a4bF4986F378d5fcf',
              symbol: 'dUSD', decimals: 6, confirmations: 1, store: join(mkdtempSync(join(tmpdir(), 'paykit-')), 'invoices.json') };
const ERC20 = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const PAYEE = '0x5050A4F4b3f9338C3472dcC01A87C76A144b3c9c';
const PAYER = '0x86CF69D403B1F419eEc5d66ACd661DD0EEc22DeB';

/** A fake provider: a list of Transfer logs and a head block. */
let _txSeq = 0; // suite shares one store; give each unlabelled transfer a globally-unique tx hash so the consume-once guard isn't tripped by fixture reuse
function fakeProvider(transfers, head = 100) {
  const logs = transfers.map((t, i) => ({
    address: cfg.token, blockNumber: t.block, transactionHash: t.tx ?? `0x${String(++_txSeq).padStart(64, '0')}`, index: i,
    topics: [ERC20.getEvent('Transfer').topicHash, AbiCoder.defaultAbiCoder().encode(['address'], [t.from]), AbiCoder.defaultAbiCoder().encode(['address'], [t.to])],
    data: AbiCoder.defaultAbiCoder().encode(['uint256'], [t.value]),
  }));
  return {
    async getBlockNumber() { return head; },
    async getLogs(f) { return logs.filter(l => l.topics[2] === f.topics[2] && l.blockNumber >= f.fromBlock); },
    async getTransactionReceipt(h) { const ls = logs.filter(l => l.transactionHash === h); return ls.length ? { status: 1, blockNumber: ls[0].blockNumber, logs: ls } : null; },
    fail() { this.getLogs = async () => { throw new Error('RPC down'); }; this.getBlockNumber = async () => { throw new Error('RPC down'); }; },
  };
}

test('create_invoice yields a unique exact amount and a valid payment URI', async () => {
  const kit = new PayKit(cfg, { provider: fakeProvider([]) });
  const a = await kit.createInvoice({ payee_address: PAYEE, amount: '2.00', memo: 'report' });
  const b = await kit.createInvoice({ payee_address: PAYEE, amount: '2.00', memo: 'report' });
  assert.equal(a.status, 'open');
  assert.notEqual(a.amount_units, b.amount_units, 'two open invoices to the same payee never share an amount');
  assert.ok(BigInt(a.amount_units) > 2_000_000n && BigInt(a.amount_units) < 2_001_000n);
  assert.match(a.payment_uri, /^ethereum:0x03E25a5DC7aC15f32462652a4bF4986F378d5fcf@112172\/transfer\?address=/);
});

test('check_payment: exact-amount transfer settles the invoice', async () => {
  const prov = fakeProvider([]);
  const kit = new PayKit(cfg, { provider: prov });
  const inv = await kit.createInvoice({ payee_address: PAYEE, amount: '2.00' });
  Object.assign(prov, fakeProvider([{ from: PAYER, to: PAYEE, value: BigInt(inv.amount_units), block: 101 }], 105));
  const r = await kit.checkPayment({ invoice_id: inv.invoice_id });
  assert.equal(r.status, 'paid');
  assert.equal(getAddress(r.settlement.payer_address), getAddress(PAYER));
  assert.equal(r.settlement.confirmations, 5);
});

test('check_payment: wrong amount does not settle; smaller amount from hinted payer is partial', async () => {
  const prov = fakeProvider([]);
  const kit = new PayKit(cfg, { provider: prov });
  const inv = await kit.createInvoice({ payee_address: PAYEE, amount: '2.00', payer_hint: PAYER });
  Object.assign(prov, fakeProvider([{ from: PAYER, to: PAYEE, value: 1_000_000n, block: 101 }], 105));
  const r = await kit.checkPayment({ invoice_id: inv.invoice_id });
  assert.equal(r.status, 'partial');
  assert.equal(r.last_check.paid, '1000000');
});

test('check_payment: unreadable chain reports unknown, never unpaid', async () => {
  const prov = fakeProvider([]);
  const kit = new PayKit(cfg, { provider: prov });
  const inv = await kit.createInvoice({ payee_address: PAYEE, amount: '2.00' });
  prov.fail();
  const r = await kit.checkPayment({ invoice_id: inv.invoice_id });
  assert.equal(r.status, 'unknown');
  assert.match(r.last_check.error, /RPC down/);
});

test('check_payment: past due with no transfer is overdue', async () => {
  const kit = new PayKit(cfg, { provider: fakeProvider([]) });
  const inv = await kit.createInvoice({ payee_address: PAYEE, amount: '2.00', due_date: '2020-01-01T00:00:00Z' });
  const r = await kit.checkPayment({ invoice_id: inv.invoice_id });
  assert.equal(r.status, 'overdue');
});

test('check_payment with tx_hash verifies an x402-style settlement receipt', async () => {
  const prov = fakeProvider([]);
  const kit = new PayKit(cfg, { provider: prov });
  const inv = await kit.createInvoice({ payee_address: PAYEE, amount: '0.02' });
  const tx = '0x' + 'ab'.repeat(32);
  Object.assign(prov, fakeProvider([{ from: PAYER, to: PAYEE, value: BigInt(inv.amount_units), block: 101, tx }], 103));
  const r = await kit.checkPayment({ invoice_id: inv.invoice_id, tx_hash: tx });
  assert.equal(r.status, 'paid');
  assert.equal(r.settlement.tx_hash, tx);
});

test('send_reminder drafts text, escalates, and refuses on paid invoices', async () => {
  const prov = fakeProvider([]);
  const kit = new PayKit(cfg, { provider: prov });
  const inv = await kit.createInvoice({ payee_address: PAYEE, amount: '2.00', memo: 'UI design' });
  const d1 = kit.draftReminder({ invoice_id: inv.invoice_id });
  assert.equal(d1.escalation_step, '1 of 3');
  assert.match(d1.body, new RegExp(inv.exact_amount));
  const d2 = kit.draftReminder({ invoice_id: inv.invoice_id, tone: 'firm', channel_hint: 'chat' });
  assert.equal(d2.escalation_step, '2 of 3');
  assert.ok(!d2.body.includes('\n\n'), 'chat formatting collapses paragraphs');
  Object.assign(prov, fakeProvider([{ from: PAYER, to: PAYEE, value: BigInt(inv.amount_units), block: 101 }], 105));
  await kit.checkPayment({ invoice_id: inv.invoice_id });
  assert.equal(kit.draftReminder({ invoice_id: inv.invoice_id }).skip, true);
});

test('check_payment: one payment cannot settle two invoices (consume-once)', async () => {
  const prov = fakeProvider([]);
  const kit = new PayKit(cfg, { provider: prov });
  const tx = '0x' + 'cd'.repeat(32);
  const a = await kit.createInvoice({ payee_address: PAYEE, amount: '3.00' }); // created_block = 100
  Object.assign(prov, fakeProvider([{ from: PAYER, to: PAYEE, value: BigInt(a.amount_units), block: 101, tx }], 105));
  assert.equal((await kit.checkPayment({ invoice_id: a.invoice_id, tx_hash: tx })).status, 'paid');
  // A second invoice, even for the same amount, cannot be settled by the same on-chain transaction.
  const b = await kit.createInvoice({ payee_address: PAYEE, amount: '3.00' }); // created_block = 105
  Object.assign(prov, fakeProvider([{ from: PAYER, to: PAYEE, value: BigInt(b.amount_units), block: 106, tx }], 107));
  const rb = await kit.checkPayment({ invoice_id: b.invoice_id, tx_hash: tx });
  assert.notEqual(rb.status, 'paid');
  assert.match(rb.last_check.reason, /already settled/);
});

// ---- finding #3: invoice attribution / creation boundary ----

test('#3 a transfer before the invoice was created is not attributed (scan path)', async () => {
  const prov = fakeProvider([]);                                  // head 100 at creation
  const kit = new PayKit(cfg, { provider: prov });
  const inv = await kit.createInvoice({ payee_address: PAYEE, amount: '2.00' }); // created_block = 100
  // a matching-amount transfer that happened at block 99, i.e. before this invoice existed
  Object.assign(prov, fakeProvider([{ from: PAYER, to: PAYEE, value: BigInt(inv.amount_units), block: 99 }], 105));
  const r = await kit.checkPayment({ invoice_id: inv.invoice_id });
  assert.notEqual(r.status, 'paid', 'a pre-invoice payment must not settle it');
});

test('#3 a transfer in the invoice creation block settles (same-block allowed)', async () => {
  const prov = fakeProvider([]);
  const kit = new PayKit(cfg, { provider: prov });
  const inv = await kit.createInvoice({ payee_address: PAYEE, amount: '2.00' }); // created_block = 100
  Object.assign(prov, fakeProvider([{ from: PAYER, to: PAYEE, value: BigInt(inv.amount_units), block: 100 }], 105));
  const r = await kit.checkPayment({ invoice_id: inv.invoice_id });
  assert.equal(r.status, 'paid');
});

test('#3 a direct tx_hash that predates the invoice is rejected (Path A)', async () => {
  const prov = fakeProvider([]);
  const kit = new PayKit(cfg, { provider: prov });
  const inv = await kit.createInvoice({ payee_address: PAYEE, amount: '2.00' }); // created_block = 100
  const tx = '0x' + '3c'.repeat(32);
  Object.assign(prov, fakeProvider([{ from: PAYER, to: PAYEE, value: BigInt(inv.amount_units), block: 90, tx }], 105));
  const r = await kit.checkPayment({ invoice_id: inv.invoice_id, tx_hash: tx });
  assert.notEqual(r.status, 'paid');
  assert.match(r.last_check.reason, /predates/);
});

test('#3 unknown creation block fails closed; reconcile settles explicitly', async () => {
  const prov = fakeProvider([]);
  const kit = new PayKit(cfg, { provider: prov });
  const inv = await kit.createInvoice({ payee_address: PAYEE, amount: '2.00' });
  const stored = kit.store.get(inv.invoice_id); stored.created_block = null; kit.store.put(stored); // chain was unreachable at creation
  Object.assign(prov, fakeProvider([{ from: PAYER, to: PAYEE, value: BigInt(inv.amount_units), block: 50 }], 105));
  const closed = await kit.checkPayment({ invoice_id: inv.invoice_id });
  assert.notEqual(closed.status, 'paid');
  assert.match(closed.last_check.reason, /reconciliation/);
  const open = await kit.checkPayment({ invoice_id: inv.invoice_id, reconcile: true });
  assert.equal(open.status, 'paid');
});

test('two concurrent checks: the one still waiting on the chain cannot un-pay an invoice the other settled', async () => {
  // A starts a check and waits in getLogs; B checks and settles; A then returns with a stale "not paid" view.
  // Before the fix A wrote that view back (paid -> open) and the invoice stayed open forever (its own tx is consumed).
  let calls = 0, release; const gate = new Promise((r) => { release = r; });
  const prov = fakeProvider([], 105);
  const kit = new PayKit(cfg, { provider: prov });
  const inv = await kit.createInvoice({ payee_address: PAYEE, amount: '2.00', payer_hint: PAYER });
  const base = fakeProvider([{ from: PAYER, to: PAYEE, value: BigInt(inv.amount_units), block: 106 }], 110);
  Object.assign(prov, base, { async getLogs(f) { if (++calls === 1) await gate; return base.getLogs(f); } });
  const a = kit.checkPayment({ invoice_id: inv.invoice_id });
  await new Promise((r) => setImmediate(r));
  const b = await kit.checkPayment({ invoice_id: inv.invoice_id });
  assert.equal(b.status, 'paid');
  release();
  assert.equal((await a).status, 'paid', 'the stale check reports the settled state');
  assert.equal(kit.store.get(inv.invoice_id).status, 'paid', 'stored state stays paid');
  assert.equal((await kit.checkPayment({ invoice_id: inv.invoice_id })).status, 'paid', 'a later /deliver check still sees paid');
});
