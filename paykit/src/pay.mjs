#!/usr/bin/env node
/**
 * pay.mjs — BUYER-side: pay a paykit invoice without holding any native coin.
 *
 * The buyer signs offline and the dfmi facilitator puts the transfer on-chain and pays the gas.
 * This is the same path dfmi's x402 buyers use; nothing here is seller-side, and paykit itself never holds a key.
 *
 * Two ways to sign:
 *
 *   plain wallet (EIP-3009 transferWithAuthorization on dUSD)
 *     BUYER_KEY=0x…  node src/pay.mjs <pay_to> <exact_amount>
 *     BUYER_KEY=0x…  node src/pay.mjs --invoice inv_xxxxxxxxxxxx      # reads pay_to + exact_amount from the local store
 *
 *   SessionKeyWallet (bounded credential: the key can only spend within the cap the owner set)
 *     SESSION_KEY=0x…  node src/pay.mjs --session <wallet_address> <pay_to> <exact_amount>
 *
 * Idempotent: if this payer already sent this exact amount to this payee recently, it reports that tx and does not pay again
 * (PAY_FORCE=1 overrides). A facilitator 5xx is treated as "unclear" and the chain is checked before reporting failure.
 *
 * Prints JSON with the tx hash. Then on the seller side:  node src/cli.mjs check <invoice_id> --tx <hash>
 */
import { randomBytes } from 'node:crypto';
import { Contract, JsonRpcProvider, Network, Wallet, parseUnits, formatUnits } from 'ethers';
import { loadConfig } from './config.mjs';
import { InvoiceStore } from './store.mjs';
import { ChainReader } from './chain.mjs';

const cfg = loadConfig(process.env.PAYKIT_CONFIG);
if (!cfg.facilitator) { console.error('paykit.config.json needs "facilitator" (e.g. https://facilitator.dfmi.app)'); process.exit(2); }
const DOMAIN = cfg.tokenDomain ?? { name: 'DFMI Dollar', version: '1' };

// ---- args
const args = process.argv.slice(2);
const session = args[0] === '--session';
let wallet, payTo, amount;
if (session) [, wallet, payTo, amount] = args;
else if (args[0] === '--invoice') {
  const inv = new InvoiceStore(cfg.store).get(args[1]);
  if (!inv) { console.error(`invoice ${args[1]} not found in ${cfg.store}`); process.exit(1); }
  payTo = inv.payee_address; amount = inv.exact_amount;
} else [payTo, amount] = args;
if (!payTo || !amount || (session && !wallet)) {
  console.error('usage: pay.mjs <pay_to> <exact_amount> | pay.mjs --invoice <id> | pay.mjs --session <wallet> <pay_to> <exact_amount>');
  process.exit(2);
}
const key = session ? process.env.SESSION_KEY : process.env.BUYER_KEY;
if (!key) { console.error(`set ${session ? 'SESSION_KEY' : 'BUYER_KEY'}=0x… in the environment (never commit it)`); process.exit(2); }

const provider = new JsonRpcProvider(cfg.rpc, Network.from(cfg.chainId), { staticNetwork: true });
const signer = new Wallet(key, provider);
const units = parseUnits(String(amount), cfg.decimals);
const now = Math.floor(Date.now() / 1000);
const erc20 = new Contract(cfg.token, ['function balanceOf(address) view returns (uint256)'], provider);
const reader = new ChainReader(cfg, provider);
const payerAddr = session ? wallet : signer.address;

// ---- idempotency: a 5xx from the facilitator is not proof the payment failed. Before paying, look for an
//      exact-amount transfer from this payer to this payee in the recent past; if it exists, report it and stop.
const LOOKBACK = Number(process.env.PAY_LOOKBACK_BLOCKS ?? 5000);
async function alreadyPaid() {
  const head = await reader.blockNumber();
  const xfers = await reader.transfersTo(payTo, Math.max(0, head - LOOKBACK), head);
  return xfers.find(t => t.value === units && t.from.toLowerCase() === payerAddr.toLowerCase()) ?? null;
}
const done = (t, note) => { console.error(note); console.log(JSON.stringify({ tx_hash: t.txHash, block: t.block, payer: t.from, to: payTo, amount, symbol: cfg.symbol, already_paid: true }, null, 2)); process.exit(0); };
if (!process.env.PAY_FORCE) {
  let prior;
  try { prior = await alreadyPaid(); }
  catch (e) { console.error(`could not verify prior payments on-chain (${e.shortMessage ?? e.message}); not paying. Set PAY_FORCE=1 to pay anyway.`); process.exit(1); }
  if (prior) done(prior, `already paid: ${amount} ${cfg.symbol} from ${payerAddr} → ${payTo} in tx ${prior.txHash} (block ${prior.block}). Not paying twice; set PAY_FORCE=1 to override.`);
}

// ---- what the facilitator checks the payment against (same object shape as an x402 402 quote)
const requirements = {
  scheme: session ? 'dfmi-session' : 'exact',
  network: cfg.chain,
  asset: cfg.token,
  payTo,
  maxAmountRequired: units.toString(),
  resource: 'paykit://invoice',
  description: 'paykit invoice',
  maxTimeoutSeconds: 300,
  extra: { name: DOMAIN.name, version: DOMAIN.version },
};

let paymentPayload;
if (!session) {
  // ---- plain wallet: EIP-3009 authorization signed by the buyer's key
  const from = signer.address;
  const bal = await erc20.balanceOf(from);
  console.error(`buyer ${from} balance ${formatUnits(bal, cfg.decimals)} ${cfg.symbol}`);
  if (bal < units) { console.error(`insufficient balance for ${amount} ${cfg.symbol} (faucet: https://faucet.dfmi.app)`); process.exit(1); }
  const authorization = {
    from, to: payTo, value: units.toString(),
    validAfter: String(now - 60), validBefore: String(now + 300),
    nonce: '0x' + randomBytes(32).toString('hex'),
  };
  const domain = { name: DOMAIN.name, version: DOMAIN.version, chainId: cfg.chainId, verifyingContract: cfg.token };
  const types = { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ] };
  const signature = await signer.signTypedData(domain, types, authorization);
  paymentPayload = { x402Version: 1, scheme: 'exact', network: cfg.chain, payload: { signature, authorization } };
} else {
  // ---- SessionKeyWallet: the session key signs a Pay intent; the wallet contract enforces cap / expiry / revocation on-chain
  const sw = new Contract(wallet, ['function sessionNonce(address) view returns (uint256)'], provider);
  const [nonce, bal] = await Promise.all([sw.sessionNonce(signer.address), erc20.balanceOf(wallet)]);
  console.error(`wallet ${wallet} balance ${formatUnits(bal, cfg.decimals)} ${cfg.symbol} | session key ${signer.address} nonce ${nonce}`);
  const authorization = { to: payTo, amount: units.toString(), nonce: nonce.toString(), deadline: String(now + 300) };
  const domain = { name: 'dfmi SessionKeyWallet', version: '1', chainId: cfg.chainId, verifyingContract: wallet };
  const types = { Pay: [
    { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ] };
  const signature = await signer.signTypedData(domain, types, { to: payTo, amount: units, nonce, deadline: BigInt(authorization.deadline) });
  paymentPayload = { x402Version: 1, scheme: 'dfmi-session', network: cfg.chain, payload: { wallet, sessionKey: signer.address, signature, authorization } };
}

// ---- hand the signed authorization to the facilitator; it verifies, broadcasts, and pays the gas
console.error(`settling ${amount} ${cfg.symbol} → ${payTo} via ${cfg.facilitator} (${requirements.scheme})`);
let r = null, out;
try {
  r = await fetch(`${cfg.facilitator}/settle`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paymentPayload, paymentRequirements: requirements }),
    signal: AbortSignal.timeout(90_000),
  });
  out = await r.json().catch(() => ({ success: false, error: `facilitator HTTP ${r.status}`, unclear: true }));
} catch (e) {
  out = { success: false, error: `facilitator unreachable: ${e.message}`, unclear: true };   // timeout / network: also unclear
}
if (!out.success) {
  if (out.unclear || (r && r.status >= 500)) {
    // The facilitator may have broadcast the transfer and failed only to reply. Ask the chain, not the facilitator.
    console.error(`facilitator reply unclear (${out.error}); checking the chain before giving up…`);
    for (let i = 0; i < 6; i++) {
      await new Promise(res => setTimeout(res, 5000));
      const t = await alreadyPaid().catch(() => null);
      if (t) done(t, `payment found on-chain despite the facilitator error: tx ${t.txHash}`);
    }
  }
  console.error(`settle failed: ${out.error ?? JSON.stringify(out)}`); process.exit(1);
}
console.log(JSON.stringify({ tx_hash: out.transaction, block: out.blockNumber, payer: out.payer, to: payTo, amount, symbol: cfg.symbol, scheme: requirements.scheme }, null, 2));
