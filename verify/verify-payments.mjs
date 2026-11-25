#!/usr/bin/env node
// verify-payments.mjs — black-box checks of dfmi's x402 payments, run by anyone against the public endpoints.
//
// Default (read-only, spends nothing):
//   - the facilitator answers, and its catalog lists only resources that answer an unpaid request with 402
//     and complete payment requirements;
//   - the public status of the operator's health monitor is fresh (https://dfmi.app/status.json);
//   - a burst of unpaid requests from one client is rate limited with 429 and Retry-After.
//
// --buy (spends free faucet points; YOUR choice to run it): makes a throwaway wallet, claims the free 10 dUSD
// from the public faucet, buys one market report (0.02 dUSD), then retries the SAME payment as if the first
// response had been lost, and checks on chain that it was charged exactly once:
//   - the retry returns the same order and the same settlement transaction;
//   - the wallet's dUSD balance fell by exactly the price;
//   - exactly one dUSD transfer left the wallet, to the seller;
//   - the order's status URL reports it delivered.
// dUSD is a points unit with no monetary value.
//
//   npm install && node verify-payments.mjs           # read-only
//   node verify-payments.mjs --buy                    # also the purchase checks
//   node verify-payments.mjs --skip-rate              # skip the rate-limit burst
// Exit code 0 = every check passed.
import crypto from 'node:crypto';
import { Wallet, Interface, getAddress } from 'ethers';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const FAC = arg('--facilitator', 'https://facilitator.dfmi.app').replace(/\/$/, '');
const RESOURCE = arg('--resource', 'https://producer.dfmi.app/market-report');
const RPC = arg('--rpc', 'https://ethereum.dfmi.app:8541');
const FAUCET = arg('--faucet', 'https://faucet.dfmi.app').replace(/\/$/, '');
const STATUS = arg('--status', 'https://dfmi.app/status.json');
const BUY = process.argv.includes('--buy'), SKIP_RATE = process.argv.includes('--skip-rate');
const KEY = arg('--key', process.env.VERIFY_BUYER_KEY || '');   // optional: an already funded throwaway key instead of the faucet

let pass = 0, fail = 0;
function check(name, ok, detail = '') { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); }
const get = (url, headers = {}) => fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(60_000) });
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
}
const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)', 'event Transfer(address indexed from, address indexed to, uint256 value)']);
const balanceOf = async (token, who) => BigInt(await rpc('eth_call', [{ to: token, data: ERC20.encodeFunctionData('balanceOf', [who]) }, 'latest']));
const TRANSFER = ERC20.getEvent('Transfer').topicHash;
const topicAddr = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const EIP3009 = { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
function requirementsOk(req) {
  return req && req.scheme === 'exact' && /^eip155:\d+$/.test(req.network) && /^0x[0-9a-fA-F]{40}$/.test(req.asset) && /^0x[0-9a-fA-F]{40}$/.test(req.payTo)
    && /^\d+$/.test(String(req.maxAmountRequired)) && BigInt(req.maxAmountRequired) > 0n;
}

console.log(`dfmi payment verification · facilitator ${FAC} · resource ${RESOURCE}\n\n-- catalog and payment requirements (read-only) --`);
const sup = await get(`${FAC}/supported`);
check('the facilitator answers /supported', sup.status === 200);
const catRes = await get(`${FAC}/catalog`); const catalog = catRes.status === 200 ? await catRes.json() : {};
const listed = Object.keys(catalog).filter((u) => /^https:\/\//.test(u));
check('the facilitator publishes its catalog', catRes.status === 200 && listed.length > 0, `${listed.length} paid resources`);
for (const u of listed) {
  const r = await get(u); const j = await r.json().catch(() => ({}));
  check(`unpaid request → 402 with complete payment requirements: ${u}`, r.status === 402 && requirementsOk(j.accepts?.[0]), `HTTP ${r.status}`);
}

console.log('\n-- the operator\'s health monitor (read-only) --');
try {
  const s = await (await get(STATUS)).json();
  const ageMin = (Date.now() - Date.parse(s.generatedAt)) / 60_000;
  check('the public status is fresh (monitor running)', ageMin < 15, `generated ${ageMin.toFixed(1)} min ago`);
  check('all monitored checks pass', s.summary && s.summary.failing === 0, s.summary ? `${s.summary.passing}/${s.summary.checks}` : 'no summary');
  for (const g of s.groups || []) console.log(`      ${g.ok ? 'ok  ' : 'FAIL'} ${g.name} (${g.checks - g.failing}/${g.checks})`);
  if (s.restoreDrill) check('the last backup restore drill passed, within the last 8 days', s.restoreDrill.result === 'OK' && Date.now() - Date.parse(s.restoreDrill.lastRunAt) < 8 * 864e5, `${s.restoreDrill.result} at ${s.restoreDrill.lastRunAt}`);
  if (s.backup) check('the newest backup is less than 2 hours old', Date.now() - Date.parse(s.backup.lastSnapshotAt) < 2 * 36e5, s.backup.lastSnapshotAt);
} catch (e) { check('the public status is readable', false, e.message); }

if (BUY) {
  console.log('\n-- one purchase and a retry of the same payment (spends free faucet points) --');
  const buyer = KEY ? new Wallet(KEY) : Wallet.createRandom();
  console.log(`      throwaway buyer ${buyer.address}`);
  const offer = (await (await get(RESOURCE)).json()).accepts?.[0];
  check('the resource asks for payment', requirementsOk(offer), offer ? `${offer.maxAmountRequired} atomic units of ${offer.asset}` : 'no requirements');
  const price = BigInt(offer.maxAmountRequired), token = getAddress(offer.asset), payTo = getAddress(offer.payTo);
  if (!KEY) {
    const c = await get(`${FAUCET}/claim?address=${buyer.address}`); const cj = await c.json().catch(() => ({}));
    check('the faucet gives the throwaway wallet free dUSD', c.status === 200 && cj.success, `HTTP ${c.status} ${cj.error || ''}`);
  }
  let start = 0n;
  for (let i = 0; i < 30 && start < price; i++) { start = await balanceOf(token, buyer.address); if (start < price) await new Promise((r) => setTimeout(r, 2000)); }
  check('the wallet can pay', start >= price, `balance ${start}`);
  const fromBlock = '0x' + (Number(await rpc('eth_blockNumber', [])) - 5).toString(16);
  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: buyer.address, to: payTo, value: String(price), validAfter: String(now - 60), validBefore: String(now + (Number(offer.maxTimeoutSeconds) || 300)), nonce: '0x' + crypto.randomBytes(32).toString('hex') };
  const chainId = Number(String(offer.network).split(':')[1]);
  const signature = await buyer.signTypedData({ name: offer.extra?.name || 'DFMI Dollar', version: offer.extra?.version || '1', chainId, verifyingContract: token }, EIP3009, authorization);
  const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: offer.network, payload: { signature, authorization } })).toString('base64');
  const settle = (r) => { try { return JSON.parse(Buffer.from(r.headers.get('x-payment-response') || '', 'base64').toString()); } catch { return null; } };
  const first = await get(RESOURCE, { 'X-PAYMENT': header }); const goods1 = await first.text(); const s1 = settle(first);
  check('the paid request delivers the report', first.status === 200 && goods1.length > 0, `HTTP ${first.status}`);
  check('the response carries the settlement transaction and an order id', !!(s1 && /^0x[0-9a-f]{64}$/i.test(s1.transaction) && first.headers.get('x-order-id')), s1 ? s1.transaction : 'none');
  const retry = await get(RESOURCE, { 'X-PAYMENT': header }); const s2 = settle(retry);
  check('retrying the same payment returns the report again', retry.status === 200, `HTTP ${retry.status}`);
  check('…with the same order and the same transaction (no second settlement)', s2 && s1 && s2.transaction === s1.transaction && retry.headers.get('x-order-id') === first.headers.get('x-order-id'),
    `${s2?.transaction?.slice(0, 12)}… vs ${s1?.transaction?.slice(0, 12)}…${retry.headers.get('x-redelivery') ? ', marked as redelivery' : ''}`);
  const end = await balanceOf(token, buyer.address);
  check('the wallet was charged exactly once', start - end === price, `before ${start}, after ${end}, price ${price}`);
  const logs = await rpc('eth_getLogs', [{ address: token, fromBlock, toBlock: 'latest', topics: [TRANSFER, topicAddr(buyer.address)] }]);
  check('exactly one dUSD transfer left the wallet, to the seller, for the price', logs.length === 1 && getAddress('0x' + logs[0].topics[2].slice(26)) === payTo && BigInt(logs[0].data) === price && logs[0].transactionHash === s1.transaction,
    `${logs.length} transfer(s)`);
  const statusUrl = new URL(first.headers.get('x-order-status-url') || '', RESOURCE).toString();
  const os = await (await get(statusUrl)).json().catch(() => ({}));
  check('the order status URL reports it delivered, with the same transaction', os.status === 'delivered' && os.transaction === s1.transaction, `${os.status}`);
}

if (!SKIP_RATE) {
  console.log('\n-- rate limiting (read-only: 30 quick unpaid requests from this machine) --');
  const codes = []; let retryAfter = null; let i = 0;
  await Promise.all([0, 1].map(async () => { while (i < 30) { i++; const r = await get(RESOURCE); codes.push(r.status); retryAfter ||= r.headers.get('retry-after'); await r.arrayBuffer(); } }));
  const n402 = codes.filter((c) => c === 402).length, n429 = codes.filter((c) => c === 429).length;
  check('a burst from one client is limited with 429 and Retry-After', n429 > 0 && !!retryAfter, `${n402} × 402, ${n429} × 429, Retry-After ${retryAfter}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
