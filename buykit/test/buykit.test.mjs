// buykit.test.mjs — the buyer's guards, against a fake wallet contract and a fake facilitator. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { Interface, AbiCoder, Wallet, verifyTypedData, getAddress } from 'ethers';
import { BuyKit } from '../src/buykit.mjs';

const TOKEN = '0x03E25a5DC7aC15f32462652a4bF4986F378d5fcf';
const WALLET = '0x1111111111111111111111111111111111111111';
const PAYEE = '0x5050A4F4b3f9338C3472dcC01A87C76A144b3c9c';
const session = Wallet.createRandom();
const cfg = () => ({ chain: 'eip155:112172', chainId: 112172, rpc: 'http://unused', token: TOKEN, symbol: 'dUSD', decimals: 6,
  facilitator: 'http://fac', confirmations: 1, lookbackBlocks: 1000, wallet: WALLET, store: join(mkdtempSync(join(tmpdir(), 'buykit-')), 'purchases.json') });

const ERC20 = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const WALLET_IFACE = new Interface([
  'function token() view returns (address)', 'function sessions(address) view returns (bool,uint64,uint256,uint256)',
  'function sessionNonce(address) view returns (uint256)', 'function allowed(address,address) view returns (bool,uint8)']);
const TOKEN_IFACE = new Interface(['function balanceOf(address) view returns (uint256)']);

/** a provider that answers eth_call for the wallet + token and eth_getLogs with `transfers` */
function fakeProvider(state) {
  const enc = AbiCoder.defaultAbiCoder();
  return {
    async getBlockNumber() { return 1000; },
    async call(tx) {
      const to = getAddress(tx.to); const data = tx.data;
      if (to === getAddress(WALLET)) {
        const fn = WALLET_IFACE.getFunction(data.slice(0, 10));
        if (fn.name === 'token') return enc.encode(['address'], [TOKEN]);
        if (fn.name === 'sessions') return enc.encode(['bool', 'uint64', 'uint256', 'uint256'], [state.active, state.expiry, state.cap, state.spent]);
        if (fn.name === 'sessionNonce') return enc.encode(['uint256'], [state.nonce]);
        if (fn.name === 'allowed') { if (state.allowed == null) throw new Error('execution reverted'); return enc.encode(['bool', 'uint8'], [state.allowed, 1]); }
      }
      if (to === getAddress(TOKEN)) return enc.encode(['uint256'], [state.balance]);
      throw new Error('unexpected call ' + to);
    },
    async getLogs() {
      return state.transfers.map((t, i) => ({ address: TOKEN, topics: [ERC20.getEvent('Transfer').topicHash, enc.encode(['address'], [WALLET]), enc.encode(['address'], [PAYEE])],
        data: enc.encode(['uint256'], [t.value]), transactionHash: t.tx, blockNumber: 900 + i, index: 0 }));
    },
    // ethers Contract needs these
    async getNetwork() { return { chainId: 112172n }; }, async resolveName(n) { return n; }, _isProvider: true, provider: null,
  };
}
const base = () => ({ active: true, expiry: 0, cap: 500_000n, spent: 100_000n, nonce: 3n, balance: 1_000_000n, allowed: null, transfers: [] });
const fakeFetch = (reply) => async (url, init) => { fakeFetch.last = { url, body: JSON.parse(init.body) }; return { status: 200, json: async () => reply }; };

test('check_budget reads cap / spent / remaining from the wallet', async () => {
  const kit = new BuyKit(cfg(), session.privateKey, { provider: fakeProvider(base()) });
  const b = await kit.checkBudget();
  assert.equal(b.cap, '0.5'); assert.equal(b.spent, '0.1'); assert.equal(b.remaining, '0.4'); assert.equal(b.can_pay, true);
});

test('pay_invoice signs a valid Pay intent and sends the dfmi-session payload to /settle', async () => {
  const f = fakeFetch({ success: true, transaction: '0xabc', blockNumber: 1001, payer: WALLET });
  const kit = new BuyKit(cfg(), session.privateKey, { provider: fakeProvider(base()), fetch: f });
  const r = await kit.payInvoice({ pay_to: PAYEE, exact_amount: '0.020287', invoice_id: 'inv_1', chain: 'eip155:112172' });
  assert.equal(r.paid, true); assert.equal(r.tx_hash, '0xabc'); assert.equal(r.status, 'paid');
  const { paymentPayload: pp, paymentRequirements: rq } = fakeFetch.last.body;
  assert.equal(pp.scheme, 'dfmi-session'); assert.equal(rq.maxAmountRequired, '20287'); assert.equal(rq.payTo, PAYEE);
  const a = pp.payload.authorization;
  assert.equal(a.nonce, '3');
  const signer = verifyTypedData({ name: 'dfmi SessionKeyWallet', version: '1', chainId: 112172, verifyingContract: WALLET },
    { Pay: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    { to: a.to, amount: BigInt(a.amount), nonce: BigInt(a.nonce), deadline: BigInt(a.deadline) }, pp.payload.signature);
  assert.equal(signer, session.address);
  // second call with the same invoice id: local log, no second settle
  const before = fakeFetch.last; const r2 = await kit.payInvoice({ pay_to: PAYEE, exact_amount: '0.020287', invoice_id: 'inv_1' });
  assert.equal(r2.already_paid, true); assert.equal(fakeFetch.last, before);
});

test('refuses over the session cap without signing', async () => {
  fakeFetch.last = undefined; const f = fakeFetch({ success: true }); const kit = new BuyKit(cfg(), session.privateKey, { provider: fakeProvider(base()), fetch: f });
  const r = await kit.payInvoice({ pay_to: PAYEE, exact_amount: '0.5' });
  assert.equal(r.refused, true); assert.match(r.reason, /over session cap/); assert.equal(fakeFetch.last, undefined);
});

test('refuses a revoked session, a chain mismatch, and a caller max_amount', async () => {
  const kit1 = new BuyKit(cfg(), session.privateKey, { provider: fakeProvider({ ...base(), active: false }) });
  assert.match((await kit1.payInvoice({ pay_to: PAYEE, exact_amount: '0.01' })).reason, /revoked/);
  const kit2 = new BuyKit(cfg(), session.privateKey, { provider: fakeProvider(base()) });
  assert.match((await kit2.payInvoice({ pay_to: PAYEE, exact_amount: '0.01', chain: 'eip155:8453' })).reason, /eip155:8453/);
  assert.match((await kit2.payInvoice({ pay_to: PAYEE, exact_amount: '0.06', max_amount: '0.05' })).reason, /exceeds the caller's limit/);
});

test('refuses a payee outside the session intent (v2 wallet)', async () => {
  const kit = new BuyKit(cfg(), session.privateKey, { provider: fakeProvider({ ...base(), allowed: false }) });
  assert.match((await kit.payInvoice({ pay_to: PAYEE, exact_amount: '0.01' })).reason, /intent/);
});

test('does not pay twice: an exact-amount transfer already on-chain is reported, not repeated', async () => {
  fakeFetch.last = undefined;
  const f = fakeFetch({ success: true });
  const kit = new BuyKit(cfg(), session.privateKey, { provider: fakeProvider({ ...base(), transfers: [{ value: 20287n, tx: '0xprior' }] }), fetch: f });
  const r = await kit.payInvoice({ pay_to: PAYEE, exact_amount: '0.020287', invoice_id: 'inv_2' });
  assert.equal(r.already_paid, true); assert.equal(r.tx_hash, '0xprior'); assert.equal(fakeFetch.last, undefined);
});

test('an unclear facilitator reply is resolved from the chain, not reported as failure', async () => {
  const state = { ...base(), transfers: [] };
  const f = async (url, init) => { state.transfers.push({ value: 20287n, tx: '0xlate' }); return { status: 502, json: async () => { throw new Error('html'); } }; };
  const kit = new BuyKit(cfg(), session.privateKey, { provider: fakeProvider(state), fetch: f });
  const t0 = Date.now();
  const r = await kit.payInvoice({ pay_to: PAYEE, exact_amount: '0.020287', invoice_id: 'inv_3' });
  assert.equal(r.paid, true); assert.equal(r.tx_hash, '0xlate'); assert.match(r.note, /unclear/);
  assert.ok(Date.now() - t0 >= 5000, 'waited for the chain');
});
