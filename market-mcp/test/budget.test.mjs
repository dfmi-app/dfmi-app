// budget.test.mjs — finding #2: a disclosed authorization must not be released on an untrusted seller response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { createBudget } from '../src/budget.mjs';
import { purchase } from '../src/purchase.mjs';
import { buy } from '../src/x402.mjs';

const TOKEN = '0x03E25a5DC7aC15f32462652a4bF4986F378d5fcf';
const PAYEE = '0x5050A4F4b3f9338C3472dcC01A87C76A144b3c9c';

// ---- createBudget unit rules ----
test('#2 budget: paid and disclosed both stay committed; only an undisclosed reservation is released', () => {
  const b = createBudget(1.0);
  const r1 = b.reserve(0.3); b.resolve(r1, { disclosed: true, paid: true });   // settled
  const r2 = b.reserve(0.3); b.resolve(r2, { disclosed: true, paid: false });  // disclosed, no receipt -> pending
  const r3 = b.reserve(0.3); b.resolve(r3, { disclosed: false, paid: false }); // never disclosed -> released
  assert.equal(+b.spent.toFixed(4), 0.6);
  assert.equal(+b.remaining().toFixed(4), 0.4);
});

test('#2 budget: reserve refuses once the committed total would exceed the limit', () => {
  const b = createBudget(1.0);
  b.reserve(0.6);
  assert.throws(() => b.reserve(0.5), /budget exhausted/i);
  assert.equal(+b.spent.toFixed(4), 0.6);
});

// ---- purchase() orchestration with a seller that takes the signature but returns no receipt ----
const noReceiptBuy = (price) => async (url, wallet, { reserve }) => { reserve(price); return { disclosed: true, paid: false, price, network: 'eip155:112172' }; };

test('#2 repeated no-receipt purchases cannot authorize more than the session budget', async () => {
  const b = createBudget(1.0);
  const w = Wallet.createRandom();
  const once = () => purchase({ url: 'http://seller', wallet: w, budget: b, maxPrice: 0.4, buyImpl: noReceiptBuy(0.4) });
  const a = await once(); assert.equal(a.pending, true);
  const c = await once(); assert.equal(c.pending, true);
  // two 0.4 authorizations are already out there (0.8); a third would exceed 1.0 and must be refused
  await assert.rejects(once(), /budget exhausted/i);
  assert.equal(+b.spent.toFixed(4), 0.8, 'disclosed amounts stay committed; nothing was released on the missing receipt');
});

test('#2 an exception after signature disclosure keeps the amount reserved', async () => {
  const b = createBudget(1.0);
  const w = Wallet.createRandom();
  const throwAfterDisclose = async (url, wallet, { reserve }) => { reserve(0.3); throw new Error('network blip after X-PAYMENT'); };
  await assert.rejects(purchase({ url: 'http://seller', wallet: w, budget: b, maxPrice: 0.4, buyImpl: throwAfterDisclose }), /network blip/);
  assert.equal(+b.spent.toFixed(4), 0.3, 'reservation stays committed when the call throws at/after disclosure');
});

test('#2 a reservation that was never disclosed is released', async () => {
  const b = createBudget(1.0);
  const w = Wallet.createRandom();
  const undisclosed = async (url, wallet, { reserve }) => { reserve(0.3); return { disclosed: false, paid: false, price: 0.3 }; };
  const r = await purchase({ url: 'http://seller', wallet: w, budget: b, maxPrice: 0.4, buyImpl: undisclosed });
  assert.equal(r.pending, false);
  assert.equal(+b.spent.toFixed(4), 0);
});

// ---- x402.buy() reports disclosure accurately ----
const resp = (status, text, headers = {}) => {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, async text() { return text; }, headers: { get: (k) => h.get(k.toLowerCase()) ?? null } };
};
const quote402 = JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'eip155:112172', maxAmountRequired: '20000', payTo: PAYEE, asset: TOKEN, maxTimeoutSeconds: 300, extra: { name: 'DFMI Dollar', version: '1' } }] });
const hasPayment = (init) => !!(init?.headers && (init.headers['X-PAYMENT'] || init.headers['x-payment']));

test('#2 buy() marks the signature disclosed even when the seller returns no success receipt', async () => {
  const w = Wallet.createRandom();
  const fetchImpl = async (url, init) => hasPayment(init) ? resp(200, 'the goods') : resp(402, quote402);
  const r = await buy('http://seller', w, { fetchImpl, reserve: () => {} });
  assert.equal(r.disclosed, true, 'signature was sent to the seller');
  assert.equal(r.paid, false, 'no settlement receipt');
});

test('#2 buy() does not mark disclosed when the endpoint never returns 402 (nothing signed)', async () => {
  const w = Wallet.createRandom();
  let reserved = false;
  const fetchImpl = async () => resp(200, 'not an x402 endpoint');
  const r = await buy('http://seller', w, { fetchImpl, reserve: () => { reserved = true; } });
  assert.equal(r.disclosed, false);
  assert.equal(reserved, false, 'nothing reserved because nothing was signed');
});

test('#2 buy() throwing after disclosure still leaves the reservation committed via purchase()', async () => {
  const b = createBudget(1.0);
  const w = Wallet.createRandom();
  const fetchImpl = async (url, init) => { if (hasPayment(init)) throw new Error('timeout after X-PAYMENT'); return resp(402, quote402); };
  await assert.rejects(purchase({ url: 'http://seller', wallet: w, budget: b, maxPrice: 0.4, buyImpl: (u, wl, o) => buy(u, wl, { ...o, fetchImpl }) }), /timeout after X-PAYMENT/);
  assert.equal(+b.spent.toFixed(4), 0.02, 'the 0.02 authorization stays reserved after a post-disclosure timeout');
});
