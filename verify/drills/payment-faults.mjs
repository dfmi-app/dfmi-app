#!/usr/bin/env node
// payment-faults.mjs — failure drills for the paid path, run entirely on your machine. Nothing touches dfmi's servers.
//
// What runs: a local chain (ganache) with the dUSD token as deployed, the PUBLISHED seller library (x402-lib, the code
// the live sellers run) behind a small seller, and a small facilitator written here so that it can fail on purpose.
// Faults are injected from outside the seller: the facilitator misbehaves, the seller process is SIGKILLed at the worst
// moment, or the RPC proxy in front of the seller kills it while a refund is being broadcast. After every drill the
// money side is checked on chain, not from the seller's own records.
//
//   1  charged, then the seller crashes before it records the payment → after a restart the same X-PAYMENT delivers,
//      with the original transaction; charged once
//   2  same, and the buyer never comes back, and the facilitator is down → the seller's sweeper finds the payment on
//      chain by itself and delivers; the order status says delivered
//   3  the facilitator settled but answers "authorization already used" (it lost its records) → the seller checks the
//      chain, finds the original transaction, delivers; charged once
//   4  settlement never happened (facilitator unreachable) → the order is kept while the authorization could still
//      settle; once it has expired on chain it becomes void: not charged, and a retry cannot charge
//   5  charged but the goods can never be made → refund_due → refunded automatically, verified on chain; the buyer is
//      made whole; a retry neither delivers nor charges
//   6  the seller crashes after signing a refund but BEFORE broadcasting it → after a restart the SAME signed refund is
//      broadcast; exactly one refund on chain
//   7  the seller crashes right AFTER broadcasting a refund, before recording it → after a restart it finds that
//      refund on chain; exactly one refund
//   8  no refund wallet → the debt is never dropped: the order stays refund_due, the status URL says it is owed, and
//      the seller logs REFUND OVERDUE
//
//   npm install && node drills/payment-faults.mjs        # about a minute
// Exit code 0 = every check passed.
import ganache from 'ganache';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JsonRpcProvider, Wallet, ContractFactory, Contract, Signature, verifyTypedData, parseEther } from 'ethers';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_LIB = [process.env.X402_LIB_DIR, join(HERE, '../../wangvc-seller/x402-lib'), join(HERE, '../../lib')].find((d) => d && existsSync(join(d, 'orders.mjs')));
if (!SRC_LIB) throw new Error('x402-lib not found: set X402_LIB_DIR');
// run a copy inside verify/, so that the library resolves its dependencies from verify/node_modules
const LIB = join(HERE, '.x402-lib'); rmSync(LIB, { recursive: true, force: true }); cpSync(SRC_LIB, LIB, { recursive: true, filter: (f) => !/node_modules|\.test\.mjs$/.test(f) });
const { orderIdFor } = await import(pathToFileURL(join(LIB, 'orders.mjs')).href);   // the order id the seller will use
const CHAIN_ID = 112172, PRICE = 20000n;   // 0.02 dUSD (6 decimals)
const EIP3009 = { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let pass = 0, fail = 0;
function check(name, ok, detail = '') { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); }
async function until(f, ms, what) { const t = Date.now(); while (Date.now() - t < ms) { const v = await f(); if (v) return v; await sleep(150); } throw new Error(`timed out waiting for ${what}`); }

// ---------------- chain ----------------
const keys = Array.from({ length: 4 }, () => '0x' + crypto.randomBytes(32).toString('hex'));
const chainSrv = ganache.server({ chain: { chainId: CHAIN_ID, hardfork: 'petersburg' }, logging: { quiet: true }, miner: { instamine: 'eager' },
  wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: '0x' + (10n ** 21n).toString(16) })) } });
await chainSrv.listen(0);
const CHAIN_URL = `http://127.0.0.1:${chainSrv.address().port}`;
const provider = new JsonRpcProvider(CHAIN_URL, undefined, { staticNetwork: true, cacheTimeout: -1 }); provider.pollingInterval = 50;
const [deployer, relayer] = keys.map((k) => new Wallet(k, provider));
const ART = JSON.parse(readFileSync(join(HERE, 'dusd-token.json'), 'utf8'));
const token = await new ContractFactory(ART.abi, ART.bytecode, deployer).deploy('DFMI Dollar', 'dUSD', '1', CHAIN_ID); await token.waitForDeployment();
const TOKEN = await token.getAddress();
const mint = async (to, amt) => (await token.connect(deployer).faucet(to, amt)).wait();
const balance = (a) => token.balanceOf(a);
const chainNow = async () => Number((await provider.getBlock('latest')).timestamp);
async function transfers(from, to, fromBlock) {
  const logs = await token.queryFilter(token.filters.Transfer(from, to), fromBlock, 'latest');
  return logs.map((l) => ({ tx: l.transactionHash, from: l.args[0], to: l.args[1], value: l.args[2] }));
}

// ---------------- facilitator (fault-injectable) ----------------
// pass | kill-after-settle (settle on chain, then kill the seller before it reads the answer) | unvouch (settle on
// chain, then answer "authorization already used") | settle-down (/settle unreachable) | down (all unreachable)
const F = { mode: 'pass', settled: new Map(), lastTx: null };
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const facSrv = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  if (F.mode === 'down' || (F.mode === 'settle-down' && req.url === '/settle')) return req.socket.destroy();
  try {
    const { paymentPayload: pp, paymentRequirements: rq } = JSON.parse(body); const a = pp.payload.authorization;
    const used = await token.authorizationState(a.from, a.nonce);
    const domain = { name: 'DFMI Dollar', version: '1', chainId: CHAIN_ID, verifyingContract: TOKEN };
    if (req.url === '/verify') {
      if (verifyTypedData(domain, EIP3009, a, pp.payload.signature).toLowerCase() !== a.from.toLowerCase()) return json(res, 200, { isValid: false, invalidReason: 'bad signature' });
      if (a.to.toLowerCase() !== rq.payTo.toLowerCase() || BigInt(a.value) < BigInt(rq.maxAmountRequired)) return json(res, 200, { isValid: false, invalidReason: 'wrong payee or amount' });
      if (used) return json(res, 200, { isValid: false, invalidReason: 'authorization already used', payer: a.from });
      if (Number(a.validBefore) <= await chainNow()) return json(res, 200, { isValid: false, invalidReason: 'authorization expired' });
      if (await balance(a.from) < BigInt(a.value)) return json(res, 200, { isValid: false, invalidReason: 'insufficient balance' });
      return json(res, 200, { isValid: true, payer: a.from });
    }
    if (req.url === '/settle') {
      const k = `${a.from}:${a.nonce}`.toLowerCase();
      let out = F.settled.get(k);
      if (!out) {
        if (used) return json(res, 200, { success: false, error: 'authorization already used' });
        const s = Signature.from(pp.payload.signature);
        const tx = await token.connect(relayer).transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, s.v, s.r, s.s);
        const rc = await tx.wait();
        out = { success: true, transaction: rc.hash, network: pp.network, payer: a.from, blockNumber: rc.blockNumber };
        F.settled.set(k, out);
      }
      F.lastTx = out.transaction;
      if (F.mode === 'kill-after-settle') { await seller.kill(); return req.socket.destroy(); }
      if (F.mode === 'unvouch') return json(res, 200, { success: false, error: 'authorization already used' });
      return json(res, 200, out);
    }
    json(res, 404, {});
  } catch (e) { json(res, 500, { error: e.message }); }
});
await new Promise((r) => facSrv.listen(0, '127.0.0.1', r));
const FAC_URL = `http://127.0.0.1:${facSrv.address().port}`;

// ---------------- RPC proxy in front of the seller (kills it around a refund broadcast) ----------------
// pass | crash-before-broadcast (the signed refund never reaches the chain) | crash-after-broadcast (it does)
const R = { mode: 'pass', crashes: 0 };
const rpcSrv = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const msgs = [].concat(JSON.parse(body));
  const isBroadcast = msgs.some((m) => m.method === 'eth_sendRawTransaction');
  if (isBroadcast && R.mode === 'crash-before-broadcast') { R.mode = 'pass'; R.crashes++; await seller.kill(); return req.socket.destroy(); }
  const r = await fetch(CHAIN_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const text = await r.text();
  if (isBroadcast && R.mode === 'crash-after-broadcast') { R.mode = 'pass'; R.crashes++; await seller.kill(); return req.socket.destroy(); }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(text);
});
await new Promise((r) => rpcSrv.listen(0, '127.0.0.1', r));
const RPC_URL = `http://127.0.0.1:${rpcSrv.address().port}`;

// ---------------- the seller process ----------------
const DIR = mkdtempSync(join(tmpdir(), 'dfmi-drill-'));
const PAY_TO = Wallet.createRandom().address;
const PORT = await freePort();
const URL_ = `http://127.0.0.1:${PORT}/report`;
const seller = {
  child: null, out: '', env: {},
  async start(env = {}) {
    this.env = env;
    this.child = spawn(process.execPath, ['--no-warnings', join(HERE, 'seller.mjs')], { env: { ...process.env, X402_LIB_DIR: LIB, PORT: String(PORT), ORDERS_DB: join(DIR, 'orders.db'), FAC_URL, RPC_URL,
      TOKEN, CHAIN_ID: String(CHAIN_ID), PAY_TO, PRICE: String(PRICE), ORDER_SWEEP_MS: '300', ORDER_SWEEP_OLDER_MS: '100', ORDER_RECON_AFTER_MS: '800',
      ORDER_MAX_ATTEMPTS: '2', REFUND_ALERT_MS: '300', SELLER_RATE_PER_MIN: '100000', SELLER_BURST: '100000', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d) => (this.out += d)); this.child.stderr.on('data', (d) => (this.out += d));
    await until(async () => { try { return (await fetch(URL_)).status === 402; } catch { return false; } }, 15_000, 'the seller to start');
  },
  async kill() { const c = this.child; if (c && c.exitCode === null) { c.kill('SIGKILL'); await new Promise((r) => c.once('exit', r)); } },
  async restart(env = this.env) { await this.kill(); await this.start(env); },
};

// ---------------- buyer helpers ----------------
async function buyer(validForSecs = 600) {
  const w = Wallet.createRandom(); await mint(w.address, 1_000000n);
  const now = await chainNow();
  const a = { from: w.address, to: PAY_TO, value: String(PRICE), validAfter: String(now - 600), validBefore: String(now + validForSecs), nonce: '0x' + crypto.randomBytes(32).toString('hex') };
  const signature = await w.signTypedData({ name: 'DFMI Dollar', version: '1', chainId: CHAIN_ID, verifyingContract: TOKEN }, EIP3009, a);
  const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: `eip155:${CHAIN_ID}`, payload: { signature, authorization: a } })).toString('base64');
  const orderId = orderIdFor({ x402Version: 1, scheme: 'exact', network: `eip155:${CHAIN_ID}`, payload: { signature, authorization: a } });
  return { w, address: w.address, header, orderId, start: await balance(w.address), block0: await provider.getBlockNumber() };
}
async function pay(b) {
  try { const r = await fetch(URL_, { headers: { 'X-PAYMENT': b.header }, signal: AbortSignal.timeout(30_000) }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
    let s = null; try { s = JSON.parse(Buffer.from(r.headers.get('x-payment-response') || '', 'base64').toString()); } catch {}
    return { status: r.status, j, order: r.headers.get('x-order-id'), tx: s?.transaction };
  } catch (e) { return { status: 0, error: e.message }; }
}
const orderStatus = async (id) => { try { return await (await fetch(`http://127.0.0.1:${PORT}/orders/${id}`)).json(); } catch { return {}; } };
async function oneCharge(b, tx) {
  const t = await transfers(b.address, PAY_TO, b.block0);
  return { ok: t.length === 1 && (!tx || t[0].tx === tx) && t[0].value === PRICE, n: t.length, tx: t[0]?.tx };
}

// ================================ drills ================================
let refundW = null;
try {
  await seller.start();
  console.log(`payment failure drills · local chain ${CHAIN_URL} · seller library ${SRC_LIB}\n`);

  console.log('-- 1. charged, then the seller crashes before recording it --');
  {
    const b = await buyer(); F.mode = 'kill-after-settle';
    const r1 = await pay(b);
    const settledTx = F.lastTx; F.mode = 'pass';
    check('the facilitator settled on chain and the seller died: the buyer got no answer', r1.status === 0 && /^0x[0-9a-f]{64}$/.test(settledTx || ''));
    check('…the buyer was charged once', (await oneCharge(b, settledTx)).ok);
    await seller.start();
    const r2 = await pay(b);
    check('after a restart, the same X-PAYMENT delivers the goods', r2.status === 200, `HTTP ${r2.status}`);
    check('…with the original transaction, not a new one', r2.tx === settledTx);
    check('…and the buyer is still charged exactly once', (await oneCharge(b, settledTx)).ok, `${(await oneCharge(b)).n} transfer(s)`);
  }

  console.log('\n-- 2. same, the buyer never retries, and the facilitator is down --');
  {
    const b = await buyer(); F.mode = 'kill-after-settle';
    await pay(b); const settledTx = F.lastTx;
    F.mode = 'down'; await seller.start();
    const st = await until(async () => { const s = await orderStatus(b.orderId); return s.status === 'delivered' && s; }, 20_000, 'the sweeper to deliver').catch(() => ({}));
    check('the seller finds the payment on chain by itself and delivers (status URL: delivered)', st.status === 'delivered', st.status);
    check('…recording the original transaction', st.transaction === settledTx);
    check('…charged once', (await oneCharge(b, settledTx)).ok);
    F.mode = 'pass';
  }

  console.log('\n-- 3. the facilitator settled but says "authorization already used" --');
  {
    const b = await buyer(); F.mode = 'unvouch';
    const r = await pay(b); const settledTx = F.lastTx;
    let out = r;
    if (r.status !== 200) out = await until(async () => { const x = await pay(b); return x.status === 200 && x; }, 20_000, 'delivery after the chain check').catch(() => r);
    F.mode = 'pass';
    check('the seller checks the chain, finds the payment and delivers', out.status === 200, `HTTP ${out.status}`);
    check('…with the transaction that is actually on chain', out.tx === settledTx);
    check('…charged once', (await oneCharge(b, settledTx)).ok);
  }

  console.log('\n-- 4. settlement never happened, then the authorization expires --');
  {
    const b = await buyer(120); F.mode = 'settle-down';
    const r = await pay(b);
    check('the buyer is told the payment is recorded and to retry (no goods, no charge yet)', r.status === 503 || r.status === 202, `HTTP ${r.status}`);
    await sleep(2500);
    check('while the authorization could still settle, the order is kept (not dropped, not voided)', (await orderStatus(b.orderId)).status === 'settling', (await orderStatus(b.orderId)).status);
    await provider.send('evm_increaseTime', [400]); await provider.send('evm_mine', []);
    const st = await until(async () => { const s = await orderStatus(b.orderId); return s.status === 'void' && s; }, 20_000, 'void').catch(() => ({}));
    check('once it has expired on chain, the order is void and says "not charged"', st.status === 'void' && st.charged === false, st.status);
    F.mode = 'pass';
    const again = await pay(b);
    check('a retry of the expired payment cannot charge', again.status === 402 && await balance(b.address) === b.start, `HTTP ${again.status}`);
    check('…the buyer was never charged', (await transfers(b.address, PAY_TO, b.block0)).length === 0);
  }

  // a hot wallet for automatic refunds
  refundW = Wallet.createRandom().connect(provider);
  await (await deployer.sendTransaction({ to: refundW.address, value: parseEther('1') })).wait(); await mint(refundW.address, 1_000000n);
  const REFUND_ENV = { REFUND_PRIVATE_KEY: refundW.privateKey, DRILL_PRODUCE: 'fail' };
  const refundsTo = async (b) => transfers(refundW.address, b.address, b.block0);
  async function chargedUndeliverable() {
    const b = await buyer(); let r;
    for (let i = 0; i < 3; i++) { r = await pay(b); if (r.status === 0) break; }
    return { b, r };
  }

  console.log('\n-- 5. charged, but the goods can never be made → automatic refund --');
  {
    await seller.restart(REFUND_ENV);
    const { b } = await chargedUndeliverable();
    const st = await until(async () => { const s = await orderStatus(b.orderId); return s.status === 'refunded' && s; }, 30_000, 'refunded').catch(async () => orderStatus(b.orderId));
    check('the order goes refund_due → refunded, verified on chain', st.status === 'refunded' && /^0x[0-9a-f]{64}$/.test(st.compensation?.refund_tx || ''), st.status);
    const ins = await refundsTo(b);
    check('…exactly one refund, to the payer, for the full amount', ins.length === 1 && ins[0].value === PRICE && ins[0].tx === st.compensation?.refund_tx, `${ins.length} refund(s)`);
    check('…the buyer is made whole', await balance(b.address) === b.start);
    const again = await pay(b);
    check('a retry after the refund neither delivers nor charges', again.status !== 200 && await balance(b.address) === b.start, `HTTP ${again.status}`);
  }

  console.log('\n-- 6. the seller crashes after signing a refund, before broadcasting it --');
  {
    R.mode = 'crash-before-broadcast'; const c0 = R.crashes;
    const { b } = await chargedUndeliverable();
    await until(async () => R.crashes > c0, 30_000, 'the crash at broadcast');
    check('the seller died with the refund signed and recorded but not on chain', (await refundsTo(b)).length === 0 && (await transfers(b.address, PAY_TO, b.block0)).length === 1);
    await seller.start(REFUND_ENV);
    const st = await until(async () => { const s = await orderStatus(b.orderId); return s.status === 'refunded' && s; }, 30_000, 'refunded').catch(async () => orderStatus(b.orderId));
    const ins = await refundsTo(b);
    check('after a restart the refund completes', st.status === 'refunded', st.status);
    check('…exactly one refund on chain (the same signed transaction, never a second one)', ins.length === 1 && ins[0].tx === st.compensation?.refund_tx, `${ins.length} refund(s)`);
    check('…the buyer is made whole', await balance(b.address) === b.start);
  }

  console.log('\n-- 7. the seller crashes right after broadcasting a refund, before recording it --');
  {
    R.mode = 'crash-after-broadcast'; const c0 = R.crashes;
    const { b } = await chargedUndeliverable();
    await until(async () => R.crashes > c0, 30_000, 'the crash after broadcast');
    check('the refund reached the chain but the seller died before recording it', (await refundsTo(b)).length === 1);
    await seller.start(REFUND_ENV);
    const st = await until(async () => { const s = await orderStatus(b.orderId); return s.status === 'refunded' && s; }, 30_000, 'refunded').catch(async () => orderStatus(b.orderId));
    await sleep(2000);   // a few more sweeps: a second refund would show up now
    const ins = await refundsTo(b);
    check('after a restart the seller finds that refund on chain and records it', st.status === 'refunded' && st.compensation?.refund_tx === ins[0]?.tx, st.status);
    check('…exactly one refund on chain', ins.length === 1, `${ins.length} refund(s)`);
    check('…the buyer is made whole, not paid twice', await balance(b.address) === b.start);
  }

  console.log('\n-- 8. no refund wallet: the debt is never dropped --');
  {
    await seller.restart({ DRILL_PRODUCE: 'fail' });
    const { b } = await chargedUndeliverable();
    const st = await until(async () => { const s = await orderStatus(b.orderId); return s.status === 'refund_due' && s; }, 20_000, 'refund_due').catch(async () => orderStatus(b.orderId));
    check('the order is refund_due and its status URL says the refund is owed, to whom and how much', st.status === 'refund_due' && st.compensation?.owed_to?.toLowerCase() === b.address.toLowerCase() && st.compensation?.amount_atomic === String(PRICE), st.status);
    check('the seller raises an overdue alert in its log', await until(async () => /REFUND OVERDUE/.test(seller.out), 10_000, 'the alert').catch(() => false));
    await seller.restart({ DRILL_PRODUCE: 'fail' }); await sleep(1000);
    check('…and the debt survives a restart', (await orderStatus(b.orderId)).status === 'refund_due');
  }
} catch (e) { check('the drills ran to the end', false, e.message); console.log(seller.out.slice(-2000)); }
finally {
  await seller.kill(); facSrv.close(); rpcSrv.close(); await chainSrv.close().catch(() => {});
  try { rmSync(DIR, { recursive: true, force: true }); rmSync(LIB, { recursive: true, force: true }); } catch {}
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
