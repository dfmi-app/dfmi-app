/**
 * buykit.mjs — the buyer's three operations, as a library.
 *
 *   checkBudget()      what this session key may still spend, read from the wallet contract
 *   payInvoice()       pay an exact amount to a payee, inside the session's bounds, through the facilitator (no gas)
 *   listPurchases()    the local purchase log
 *
 * What is enforced where:
 *   - cap / expiry / revocation / intent  → the wallet contract, on-chain, at pay() time (buykit only pre-checks them to fail early)
 *   - "do not pay the same invoice twice" → buykit, by scanning the chain for a prior exact-amount transfer to the payee
 *   - "a 5xx from the facilitator is not a failure" → buykit, by asking the chain before reporting anything
 *
 * buykit signs with a session key. It never holds the owner's key and cannot exceed what the owner granted.
 */
import { Wallet, getAddress } from 'ethers';
import { ChainReader } from './chain.mjs';
import { PurchaseStore } from './store.mjs';

const PAY_TYPES = { Pay: [
  { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] };

export class BuyKit {
  /**
   * @param {object} cfg        from loadConfig()
   * @param {string} sessionKey private key of the granted session key
   * @param {object} [deps]     { provider, fetch } for tests
   */
  constructor(cfg, sessionKey, deps = {}) {
    if (!cfg.wallet) throw new Error('session wallet address missing: set SESSION_WALLET (or "wallet" in buykit.config.json)');
    this.cfg = cfg;
    this.wallet = getAddress(cfg.wallet);
    this.chain = new ChainReader(cfg, deps.provider);
    this.signer = new Wallet(sessionKey);
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.store = new PurchaseStore(cfg.store);
  }

  get sessionAddress() { return this.signer.address; }

  // ---------------------------------------------------------------- check_budget
  async checkBudget() {
    const s = await this.chain.session(this.wallet, this.sessionAddress);
    const d = (u) => this.chain.decimal(u);
    return {
      wallet: this.wallet, session_key: this.sessionAddress, chain: this.cfg.chain, symbol: this.cfg.symbol,
      active: s.active, expired: s.expired, expires_at: s.expiry ? new Date(s.expiry * 1000).toISOString() : null,
      cap: d(s.cap), spent: d(s.spent), remaining: d(s.remaining),
      wallet_balance: d(s.walletBalance),
      spendable_now: d(s.remaining < s.walletBalance ? s.remaining : s.walletBalance),
      can_pay: s.active && !s.expired && s.tokenMatches && s.remaining > 0n && s.walletBalance > 0n,
      note: !s.active ? 'session revoked or unknown' : s.expired ? 'session expired' : !s.tokenMatches ? 'wallet token differs from config' : 'ok',
    };
  }

  // ---------------------------------------------------------------- pay_invoice
  /**
   * @param {object} a { pay_to, exact_amount, chain?, invoice_id?, memo?, max_amount? }
   * Refuses, before signing, when: chain mismatch, over max_amount, over remaining cap, wallet underfunded,
   * outside intent (v2 wallets), or the same exact amount was already paid to this payee by this wallet.
   */
  async payInvoice({ pay_to, exact_amount, chain, invoice_id = null, memo = '', max_amount = null }) {
    const payTo = getAddress(pay_to);
    const units = this.chain.units(exact_amount);
    const amount = this.chain.decimal(units);
    const refuse = (reason, extra = {}) => ({ paid: false, refused: true, reason, pay_to: payTo, amount, symbol: this.cfg.symbol, ...extra });

    if (units <= 0n) return refuse('amount must be positive');
    if (chain && chain !== this.cfg.chain) return refuse(`invoice is on ${chain}; this wallet is on ${this.cfg.chain}`);
    if (max_amount != null && units > this.chain.units(max_amount)) return refuse(`amount ${amount} exceeds the caller's limit ${max_amount}`);

    // local log first: same invoice id already paid?
    if (invoice_id) { const prior = this.store.byInvoice(invoice_id); if (prior) return { ...prior, paid: true, already_paid: true, note: 'invoice already paid (local log)' }; }

    // the wallet's view of this session (pre-check; the contract re-checks at pay time)
    const s = await this.chain.session(this.wallet, this.sessionAddress);
    if (!s.active) return refuse('session revoked or unknown');
    if (s.expired) return refuse('session expired');
    if (!s.tokenMatches) return refuse('wallet token differs from config');
    if (units > s.remaining) return refuse(`over session cap: remaining ${this.chain.decimal(s.remaining)} ${this.cfg.symbol}`, { remaining: this.chain.decimal(s.remaining) });
    if (units > s.walletBalance) return refuse(`wallet balance insufficient: ${this.chain.decimal(s.walletBalance)} ${this.cfg.symbol}`);
    const intent = await this.chain.allowed(this.wallet, this.sessionAddress, payTo);
    if (intent && !intent.ok) return refuse(intent.category === 0 ? 'payee is not a registered service (outside this session\'s intent)' : `payee category ${intent.category} is outside this session's intent`);

    // idempotency against the chain: an exact-amount transfer wallet → payee in the recent past means it is already paid
    const head = await this.chain.blockNumber();
    const priorTx = await this.#findPaid(payTo, units, head);
    if (priorTx) return this.#record({ invoice_id, payTo, units, amount, memo, tx: priorTx, status: 'already_paid' });

    // sign the Pay intent with the session key
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 300;
    const domain = { name: 'dfmi SessionKeyWallet', version: '1', chainId: this.cfg.chainId, verifyingContract: this.wallet };
    const signature = await this.signer.signTypedData(domain, PAY_TYPES, { to: payTo, amount: units, nonce: s.nonce, deadline: BigInt(deadline) });
    const paymentPayload = { x402Version: 1, scheme: 'dfmi-session', network: this.cfg.chain,
      payload: { wallet: this.wallet, sessionKey: this.sessionAddress, signature, authorization: { to: payTo, amount: units.toString(), nonce: s.nonce.toString(), deadline: String(deadline) } } };
    const paymentRequirements = { scheme: 'dfmi-session', network: this.cfg.chain, asset: this.cfg.token, payTo, maxAmountRequired: units.toString(),
      resource: 'paykit://invoice', description: invoice_id ? `invoice ${invoice_id}` : 'buykit payment', maxTimeoutSeconds: 300 };

    // hand it to the facilitator; it verifies against the wallet, broadcasts, pays gas
    let out, status = 0;
    try {
      const r = await this.fetch(`${this.cfg.facilitator}/settle`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paymentPayload, paymentRequirements }), signal: AbortSignal.timeout(90_000) });
      status = r.status;
      out = await r.json().catch(() => ({ success: false, error: `facilitator HTTP ${r.status}`, unclear: true }));
    } catch (e) { out = { success: false, error: `facilitator unreachable: ${e.message}`, unclear: true }; }

    if (out.success) return this.#record({ invoice_id, payTo, units, amount, memo, tx: { txHash: out.transaction, block: out.blockNumber }, status: 'paid' });

    if (out.unclear || status >= 500) {
      // the transfer may have gone through and only the reply was lost: ask the chain, not the facilitator
      for (let i = 0; i < 6; i++) {
        await new Promise(res => setTimeout(res, 5000));
        const t = await this.#findPaid(payTo, units, await this.chain.blockNumber().catch(() => head)).catch(() => null);
        if (t) return this.#record({ invoice_id, payTo, units, amount, memo, tx: t, status: 'paid', note: 'confirmed on-chain after an unclear facilitator reply' });
      }
      return { paid: false, unclear: true, reason: `facilitator reply unclear (${out.error}) and no transfer found on-chain yet; check again before retrying`, pay_to: payTo, amount, symbol: this.cfg.symbol };
    }
    return refuse(`facilitator rejected: ${out.error ?? JSON.stringify(out)}`);
  }

  async #findPaid(payTo, units, head) {
    const xfers = await this.chain.transfersFromTo(this.wallet, payTo, Math.max(0, head - this.cfg.lookbackBlocks), head);
    return xfers.find(t => t.value === units) ?? null;
  }

  #record({ invoice_id, payTo, units, amount, memo, tx, status, note }) {
    const p = this.store.put({
      id: this.store.newId(), invoice_id, pay_to: payTo, amount, amount_units: units.toString(), symbol: this.cfg.symbol, chain: this.cfg.chain,
      tx_hash: tx.txHash, block: tx.block ?? null, payer_wallet: this.wallet, session_key: this.sessionAddress, memo,
      created_at: new Date().toISOString(), status,
    });
    return { ...p, paid: true, already_paid: status === 'already_paid', ...(note ? { note } : {}) };
  }

  // ---------------------------------------------------------------- list_purchases
  listPurchases(filter) { return this.store.list(filter); }
}
