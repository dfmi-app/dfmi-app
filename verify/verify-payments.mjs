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
// --load (spends free faucet points; YOUR choice to run it): the paid path under concurrency, from this machine:
//   - the SAME payment sent N times at once: one order, one settlement, one charge on chain;
//   - M different purchases at once: each delivered exactly once, M charges, no lost or doubled payment;
//   - a sustained run (default 60 s): success rate, latency percentiles, timeouts;
//   - overload is answered with 429 (this client is over its limits) or 503 (the seller is at its global limit, or the
//     delivery is not finished yet), ALWAYS with Retry-After; both mean "not done, send the same request again". The
//     script waits and retries them, as a client should. Any other error, a 5xx without Retry-After, or a hang fails.
// dUSD is a points unit with no monetary value.
//
//   npm install && node verify-payments.mjs           # read-only
//   node verify-payments.mjs --buy                    # also the purchase checks
//   node verify-payments.mjs --load                   # also the concurrency checks (--same N, --many M, --soak SECONDS)
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
const BUY = process.argv.includes('--buy'), LOAD = process.argv.includes('--load'), SKIP_RATE = process.argv.includes('--skip-rate');
const KEY = arg('--key', process.env.VERIFY_BUYER_KEY || '');   // optional: an already funded throwaway key instead of the faucet
const SAME = Number(arg('--same', 6)), MANY = Number(arg('--many', 6)), SOAK_S = Number(arg('--soak', 60)), SOAK_EVERY_MS = Number(arg('--soak-every-ms', 3000));
const REQ_TIMEOUT_MS = 90_000;

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

// ---- purchase helpers (used by --buy and --load) ----
const settleHdr = (r) => { try { return JSON.parse(Buffer.from(r.headers.get('x-payment-response') || '', 'base64').toString()); } catch { return null; } };
async function paymentHeader(buyer, offer, token, payTo) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: buyer.address, to: payTo, value: String(offer.maxAmountRequired), validAfter: String(now - 60), validBefore: String(now + (Number(offer.maxTimeoutSeconds) || 300)), nonce: '0x' + crypto.randomBytes(32).toString('hex') };
  const chainId = Number(String(offer.network).split(':')[1]);
  const signature = await buyer.signTypedData({ name: offer.extra?.name || 'DFMI Dollar', version: offer.extra?.version || '1', chainId, verifyingContract: token }, EIP3009, authorization);
  return { nonce: authorization.nonce, header: Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: offer.network, payload: { signature, authorization } })).toString('base64') };
}
/** one paid request; 429 and 503 with Retry-After are waited out and retried, as a client should. Records every answer. */
async function paidRequest(header, log = []) {
  const t0 = Date.now();
  for (let attempt = 0; attempt < 40; attempt++) {
    let r;
    try { r = await fetch(RESOURCE, { headers: { accept: 'application/json', 'X-PAYMENT': header }, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }); }
    catch (e) { log.push({ status: e.name === 'TimeoutError' ? 'timeout' : 'error', error: e.message }); return { status: 'timeout', ms: Date.now() - t0, attempts: attempt + 1, log }; }
    const text = await r.text();
    log.push({ status: r.status, retryAfter: r.headers.get('retry-after') });
    if ((r.status === 429 || r.status === 503) && r.headers.get('retry-after')) { await new Promise((res) => setTimeout(res, 1000 * Math.min(10, Number(r.headers.get('retry-after')) || 1) + Math.random() * 300)); continue; }
    return { status: r.status, ms: Date.now() - t0, attempts: attempt + 1, body: text, order: r.headers.get('x-order-id'), settle: settleHdr(r), statusUrl: r.headers.get('x-order-status-url'), redelivery: !!r.headers.get('x-redelivery'), log };
  }
  return { status: 'gave-up', ms: Date.now() - t0, attempts: 40, log };
}
const backpressure = (l) => l.status === 200 || ((l.status === 429 || l.status === 503) && !!l.retryAfter);
async function fundedBuyer() {
  const buyer = KEY ? new Wallet(KEY) : Wallet.createRandom();
  console.log(`      throwaway buyer ${buyer.address}`);
  if (!KEY) {
    const c = await get(`${FAUCET}/claim?address=${buyer.address}`); const cj = await c.json().catch(() => ({}));
    check('the faucet gives the throwaway wallet free dUSD', c.status === 200 && cj.success, `HTTP ${c.status} ${cj.error || ''}`);
  }
  return buyer;
}
async function waitBalance(token, who, min) {
  let b = 0n;
  for (let i = 0; i < 30; i++) { b = await balanceOf(token, who); if (b >= min) break; await new Promise((r) => setTimeout(r, 2000)); }
  return b;
}
async function transfersFrom(token, who, fromBlock) {
  const latest = Number(await rpc('eth_blockNumber', [])); const out = [];
  for (let a = Number(fromBlock); a <= latest; a += 9000) {
    const b = Math.min(latest, a + 8999);
    out.push(...await rpc('eth_getLogs', [{ address: token, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16), topics: [TRANSFER, topicAddr(who)] }]));
  }
  return out;
}
const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
async function deliveredStatus(r) {   // the status URL shares the seller's limits: wait out a 429 / 503
  for (let i = 0; i < 20; i++) {
    const res = await get(new URL(r.statusUrl || '', RESOURCE).toString());
    if (res.status === 429 || res.status === 503) { await res.arrayBuffer(); await new Promise((ok) => setTimeout(ok, 1000 * (Number(res.headers.get('retry-after')) || 1))); continue; }
    const os = await res.json().catch(() => ({}));
    return os.status === 'delivered' && os.transaction === r.settle?.transaction;
  }
  return false;
}

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

if (LOAD) {
  console.log(`\n-- the paid path under concurrency (spends free faucet points) --`);
  const offer = (await (await get(RESOURCE)).json()).accepts?.[0];
  check('the resource asks for payment', requirementsOk(offer));
  const price = BigInt(offer.maxAmountRequired), token = getAddress(offer.asset), payTo = getAddress(offer.payTo);
  const buyer = await fundedBuyer();
  const need = price * BigInt(1 + MANY + Math.ceil((SOAK_S * 1000) / SOAK_EVERY_MS) + 2);
  const start = await waitBalance(token, buyer.address, need);
  check('the wallet can pay for the whole run', start >= need, `balance ${start}, needs ${need}`);
  const fromBlock = Number(await rpc('eth_blockNumber', [])) - 5;
  const all = [];   // every purchase made: { nonce, r }
  const answers = (rs) => rs.flatMap((r) => r.log.map((l) => l.status));
  const summary = (rs) => { const c = {}; for (const s of answers(rs)) c[s] = (c[s] || 0) + 1; return Object.entries(c).map(([k, v]) => `${v} × ${k}`).join(', '); };

  // 1. the same payment N times at once
  const same = await paymentHeader(buyer, offer, token, payTo);
  const t1 = Date.now();
  const rs1 = await Promise.all(Array.from({ length: SAME }, () => paidRequest(same.header)));
  all.push({ nonce: same.nonce, r: rs1.find((r) => r.status === 200) || rs1[0] });
  console.log(`      ${SAME} identical requests at once: answers ${summary(rs1)}; done in ${secs(Date.now() - t1)}`);
  check(`the same payment sent ${SAME} times at once: every request ends with the report`, rs1.every((r) => r.status === 200), rs1.map((r) => r.status).join(' '));
  check('…all with one order and one settlement transaction', new Set(rs1.map((r) => r.order)).size === 1 && new Set(rs1.map((r) => r.settle?.transaction)).size === 1,
    `${new Set(rs1.map((r) => r.order)).size} order(s), ${new Set(rs1.map((r) => r.settle?.transaction)).size} transaction(s)`);
  check('…every refusal on the way was 429 or 503 with Retry-After (no other error)', rs1.every((r) => r.log.every(backpressure)), summary(rs1));

  // 2. M different purchases at once
  const hs = await Promise.all(Array.from({ length: MANY }, () => paymentHeader(buyer, offer, token, payTo)));
  const t2 = Date.now();
  const rs2 = await Promise.all(hs.map((h) => paidRequest(h.header)));
  hs.forEach((h, i) => all.push({ nonce: h.nonce, r: rs2[i] }));
  const ms2 = rs2.map((r) => r.ms);
  console.log(`      ${MANY} different purchases at once: answers ${summary(rs2)}; all done in ${secs(Date.now() - t2)}; per purchase p50 ${secs(pct(ms2, 50))}, max ${secs(Math.max(...ms2))}`);
  check(`${MANY} different purchases at once: each delivers its report`, rs2.every((r) => r.status === 200), rs2.map((r) => r.status).join(' '));
  check(`…${MANY} distinct orders and ${MANY} distinct settlement transactions`, new Set(rs2.map((r) => r.order)).size === MANY && new Set(rs2.map((r) => r.settle?.transaction)).size === MANY);
  check('…every refusal on the way was 429 or 503 with Retry-After (no other error)', rs2.every((r) => r.log.every(backpressure)), summary(rs2));

  // 3. sustained: one new purchase every SOAK_EVERY_MS for SOAK_S seconds (each also retried once, as after a lost answer)
  const t3 = Date.now(); const rs3 = []; const running = [];
  while (Date.now() - t3 < SOAK_S * 1000) {
    running.push((async () => {
      const h = await paymentHeader(buyer, offer, token, payTo);
      const r = await paidRequest(h.header); rs3.push(r); all.push({ nonce: h.nonce, r });
      if (r.status === 200) { const again = await paidRequest(h.header); r.retryOk = again.status === 200 && again.order === r.order && again.settle?.transaction === r.settle?.transaction; }
    })());
    await new Promise((res) => setTimeout(res, SOAK_EVERY_MS));
  }
  await Promise.all(running);
  const ok3 = rs3.filter((r) => r.status === 200), ms3 = ok3.map((r) => r.ms);
  const timeouts = rs3.filter((r) => r.status === 'timeout' || r.status === 'gave-up').length;
  console.log(`      sustained ${SOAK_S} s, one purchase every ${secs(SOAK_EVERY_MS)}: ${ok3.length}/${rs3.length} delivered; latency p50 ${secs(pct(ms3, 50))}, p95 ${secs(pct(ms3, 95))}, p99 ${secs(pct(ms3, 99))}, max ${secs(Math.max(0, ...ms3))}; ${timeouts} timeout(s) (limit ${secs(REQ_TIMEOUT_MS)}); answers ${summary(rs3)}`);
  check(`sustained run: every purchase delivered, no timeouts`, rs3.length > 0 && ok3.length === rs3.length && timeouts === 0, `${ok3.length}/${rs3.length}`);
  check('…every refusal on the way was 429 or 503 with Retry-After (no other error)', rs3.every((r) => r.log.every(backpressure)), summary(rs3));
  check('…every purchase, retried, returns the same order and transaction', ok3.every((r) => r.retryOk));

  // money side, on chain, for the whole run
  const delivered = all.filter((x) => x.r.status === 200);
  const statuses = []; for (const x of delivered) statuses.push(await deliveredStatus(x.r));
  check('every order status URL reports delivered, with its transaction', statuses.every(Boolean), `${statuses.filter(Boolean).length}/${statuses.length}`);
  await new Promise((res) => setTimeout(res, 3000));
  const end = await balanceOf(token, buyer.address);
  const logs = await transfersFrom(token, buyer.address, fromBlock);
  const purchases = all.length;
  check(`the wallet was charged exactly once per purchase (${purchases} purchases)`, start - end === price * BigInt(purchases), `spent ${start - end}, expected ${price * BigInt(purchases)}`);
  const txs = new Set(delivered.map((x) => x.r.settle?.transaction));
  check('…exactly one transfer per purchase, each to the seller for the price, each one a settlement we were told about',
    logs.length === purchases && logs.every((l) => getAddress('0x' + l.topics[2].slice(26)) === payTo && BigInt(l.data) === price && txs.has(l.transactionHash)),
    `${logs.length} transfer(s) for ${purchases} purchase(s)`);
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
