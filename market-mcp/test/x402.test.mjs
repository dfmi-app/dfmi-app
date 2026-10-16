import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRequirements, pickable } from '../src/x402.mjs';

const DFMI = { scheme: 'exact', network: 'eip155:112172', maxAmountRequired: '20000', asset: '0x03E25a5DC7aC15f32462652a4bF4986F378d5fcf', payTo: '0x5050A4F4b3f9338C3472dcC01A87C76A144b3c9c', extra: { name: 'DFMI Dollar', version: '1' } };
const SEPOLIA = { ...DFMI, network: 'base-sepolia', maxAmountRequired: '10000', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', extra: { name: 'USDC', version: '2' } };
const MAINNET = { ...SEPOLIA, network: 'base', maxAmountRequired: '5000' };
const noHeaders = new Headers();

test('parses v1 402 body', () => {
  const r = extractRequirements(noHeaders, JSON.stringify({ x402Version: 1, accepts: [DFMI] }));
  assert.equal(r.version, 1);
  assert.equal(r.accepts.length, 1);
});

test('parses v2 PAYMENT-REQUIRED header', () => {
  const h = new Headers({ 'payment-required': Buffer.from(JSON.stringify({ x402Version: 2, accepts: [DFMI] })).toString('base64') });
  const r = extractRequirements(h, '');
  assert.equal(r.version, 2);
  assert.equal(r.accepts[0].network, 'eip155:112172');
});

test('prices dUSD with 6 decimals and names the coin', () => {
  const [p] = pickable([DFMI]);
  assert.equal(p.price, 0.02);
  assert.equal(p.coin, 'dUSD');
});

test('mainnet is excluded unless allowed; cheapest testnet first', () => {
  assert.deepEqual(pickable([MAINNET, DFMI, SEPOLIA]).map(p => p.n.network), ['base-sepolia', 'eip155:112172']);
  assert.equal(pickable([MAINNET], { allowMainnet: true })[0].n.network, 'base');
});

test('unknown networks and schemes are ignored', () => {
  assert.equal(pickable([{ ...DFMI, network: 'solana' }, { ...DFMI, scheme: 'upto' }]).length, 0);
});
