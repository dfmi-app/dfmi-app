// evm.test.mjs — end-to-end tests on an isolated local EVM (ganache), disposable keys + mock token only.
// Drives the ACTUAL BuyKit signing path against the ACTUAL compiled wallet contracts (v1 SessionKeyWallet and
// v2 IntentSessionWallet). The facilitator is a shim that submits the real pay() to the deployed contract.
// LOCAL-EVM ONLY — this is not production verification (no public chain, no real keys).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeEnv, facilitator, shutdown, PAY_TYPES } from './evmlib.mjs';
import { BuyKit } from '../buykit/src/buykit.mjs';

process.setMaxListeners(0);
after(async () => { await shutdown(); });

const PAYEE = (h) => '0x' + String(h).padStart(40, '0');

// Build pay() args from a captured facilitator payload. NB: the signature is on the payload, not the authorization.
const toArg = (pl) => ({ sessionKey: pl.sessionKey, to: pl.authorization.to, amount: pl.authorization.amount, nonce: pl.authorization.nonce, deadline: pl.authorization.deadline, signature: pl.signature });
const relayTx = (env, a) => env.wallet.connect(env.owner).pay(a.sessionKey, a.to, a.amount, a.nonce, a.deadline, a.signature);
// staticCall (eth_call) surfaces the revert reason reliably on ganache (estimateGas does not) and changes no state.
const relayCall = (env, a) => env.wallet.connect(env.owner).pay.staticCall(a.sessionKey, a.to, a.amount, a.nonce, a.deadline, a.signature);
// Negative-path CONTRACT probe only: sign a Pay that BuyKit would refuse (e.g. over cap), with the same EIP-712 type/domain.
const signAuth = (env, v) => new Wallet(env.sessionKey.privateKey).signTypedData(env.domain, PAY_TYPES, v);

for (const variant of ['v1', 'v2']) {
  test(`[local-EVM ${variant}] #1 grant -> signed payment succeeds; balances, nonce, spent update`, { timeout: 30_000 }, async () => {
    const env = await makeEnv({ variant });
    const sa = env.sessionKey.address;
    const kit = new BuyKit(env.cfg, env.sessionKey.privateKey, { fetch: facilitator(env).fetchImpl });
    const r = await kit.payInvoice({ pay_to: PAYEE('a1'), exact_amount: '0.2' });
    assert.equal(r.paid, true);
    assert.equal((await env.token.balanceOf(PAYEE('a1'))).toString(), '200000', 'payee received 0.2');
    assert.equal((await env.token.balanceOf(env.walletAddr)).toString(), '4800000', 'wallet debited 0.2');
    assert.equal((await env.wallet.sessionNonce(sa)).toString(), '1', 'nonce advanced');
    assert.equal((await env.wallet.sessions(sa)).spent.toString(), '200000', 'spent recorded');
  });

  test(`[local-EVM ${variant}] #2+#3 stale signature reverts after regrant; fresh generation succeeds`, { timeout: 30_000 }, async () => {
    const env = await makeEnv({ variant });
    const sa = env.sessionKey.address;
    // #2: sign (generation 1) but DO NOT submit — capture the real BuyKit-produced authorization
    const cap1 = facilitator(env, { capture: true });
    await new BuyKit(env.cfg, env.sessionKey.privateKey, { fetch: cap1.fetchImpl }).payInvoice({ pay_to: PAYEE('b1'), exact_amount: '0.2' });
    const old = toArg(cap1.calls.at(-1));
    assert.equal(cap1.calls.at(-1).authorization.generation, '1', 'signed under generation 1');
    const balBefore = (await env.token.balanceOf(env.walletAddr)).toString();

    // revoke + regrant the SAME key -> generation 2, nonce reset 0 (nonce/deadline/cap/active all remain valid)
    await (await env.wallet.connect(env.owner).revokeSession(sa)).wait();
    await env.grant();
    assert.equal((await env.wallet.sessionGeneration(sa)).toString(), '2');
    assert.equal((await env.wallet.sessionNonce(sa)).toString(), '0');

    // the OLD (generation-1) authorization now reverts purely due to generation invalidation
    await assert.rejects(relayCall(env, old), /bad session signature/, 'stale-generation signature is rejected');
    assert.equal((await env.token.balanceOf(env.walletAddr)).toString(), balBefore, 'balance unchanged');
    assert.equal((await env.wallet.sessionNonce(sa)).toString(), '0', 'nonce unchanged');
    assert.equal((await env.wallet.sessions(sa)).spent.toString(), '0', 'spent unchanged');

    // #3: a fresh authorization under the new generation succeeds
    const r = await new BuyKit(env.cfg, env.sessionKey.privateKey, { fetch: facilitator(env).fetchImpl }).payInvoice({ pay_to: PAYEE('b2'), exact_amount: '0.3' });
    assert.equal(r.paid, true);
    assert.equal((await env.token.balanceOf(PAYEE('b2'))).toString(), '300000');
    assert.equal((await env.wallet.sessionNonce(sa)).toString(), '1');
    assert.equal((await env.wallet.sessions(sa)).spent.toString(), '300000');
  });

  test(`[local-EVM ${variant}] #4 replay of a consumed authorization reverts (bad nonce)`, { timeout: 30_000 }, async () => {
    const env = await makeEnv({ variant });
    const cap = facilitator(env, { capture: true });
    await new BuyKit(env.cfg, env.sessionKey.privateKey, { fetch: cap.fetchImpl }).payInvoice({ pay_to: PAYEE('c1'), exact_amount: '0.2' });
    const a = toArg(cap.calls.at(-1));
    await (await relayTx(env, a)).wait();                  // first submission consumes nonce 0
    assert.equal((await env.wallet.sessionNonce(env.sessionKey.address)).toString(), '1');
    await assert.rejects(relayCall(env, a), /bad nonce/, 'replay of the same authorization reverts');
  });

  test(`[local-EVM ${variant}] #4 expired session reverts`, { timeout: 30_000 }, async () => {
    const env = await makeEnv({ variant, expirySecs: 2 });
    const cap = facilitator(env, { capture: true });
    await new BuyKit(env.cfg, env.sessionKey.privateKey, { fetch: cap.fetchImpl }).payInvoice({ pay_to: PAYEE('d1'), exact_amount: '0.2' });
    const a = toArg(cap.calls.at(-1));
    await env.provider.send('evm_increaseTime', [10]);     // advance chain time past expiry (deterministic, no sleep)
    await env.provider.send('evm_mine', []);
    await assert.rejects(relayCall(env, a), /session expired/, 'expired session reverts');
  });

  test(`[local-EVM ${variant}] #4 revoked session reverts`, { timeout: 30_000 }, async () => {
    const env = await makeEnv({ variant });
    const cap = facilitator(env, { capture: true });
    await new BuyKit(env.cfg, env.sessionKey.privateKey, { fetch: cap.fetchImpl }).payInvoice({ pay_to: PAYEE('d2'), exact_amount: '0.2' });
    const a = toArg(cap.calls.at(-1));
    await (await env.wallet.connect(env.owner).revokeSession(env.sessionKey.address)).wait();
    await assert.rejects(relayCall(env, a), /revoked or unknown session/, 'revoked session reverts');
  });

  test(`[local-EVM ${variant}] #4 over-cap: BuyKit refuses to sign, and the contract guard reverts`, { timeout: 30_000 }, async () => {
    const env = await makeEnv({ variant, cap: 100000n }); // cap 0.1
    const sh = facilitator(env);
    const refused = await new BuyKit(env.cfg, env.sessionKey.privateKey, { fetch: sh.fetchImpl }).payInvoice({ pay_to: PAYEE('e1'), exact_amount: '0.2' });
    assert.equal(refused.refused, true);
    assert.match(refused.reason, /over session cap/);
    assert.equal(sh.calls.length, 0, 'nothing was signed or sent to the facilitator');
    // contract-guard probe: a directly-signed over-cap authorization still reverts on-chain
    const gen = await env.wallet.sessionGeneration(env.sessionKey.address);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const signature = await signAuth(env, { to: PAYEE('e1'), amount: 200000n, nonce: 0n, generation: gen, deadline });
    await assert.rejects(relayCall(env, { sessionKey: env.sessionKey.address, to: PAYEE('e1'), amount: 200000n, nonce: 0n, deadline, signature }),
      /over session cap/, 'contract rejects an over-cap authorization');
  });
}
