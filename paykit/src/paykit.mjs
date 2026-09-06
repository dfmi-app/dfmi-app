/**
 * paykit.mjs — the three operations, independent of MCP so they can be tested and used from a CLI.
 *
 *   createInvoice(args)  → an open invoice with a unique exact_amount
 *   checkPayment(args)   → status from the chain, never from memory
 *   draftReminder(args)  → text only; the caller decides whether to send it
 */
import { randomInt } from 'node:crypto';
import { getAddress, formatUnits } from 'ethers';
import { InvoiceStore } from './store.mjs';
import { ChainReader } from './chain.mjs';

export class PayKit {
  constructor(cfg, { provider, store } = {}) {
    this.cfg = cfg;
    this.chain = new ChainReader(cfg, provider);
    this.store = store ?? new InvoiceStore(cfg.store);
  }

  // ---------------------------------------------------------------- create_invoice
  async createInvoice({ payee_address, amount, due_date, memo = '', payer_hint = null }) {
    const payee = getAddress(payee_address);
    const base = this.chain.units(amount);
    if (base <= 0n) throw new Error('amount must be positive');
    if (due_date && Number.isNaN(Date.parse(due_date))) throw new Error('due_date must be ISO 8601');

    // Unique exact amount: base + 1..999 smallest units. No per-invoice address, no derived key.
    let exact; let tries = 0;
    do {
      exact = base + BigInt(randomInt(1, 1000));
      if (++tries > 50) throw new Error('could not find a unique exact amount for this payee; settle older invoices first');
    } while (this.store.hasOpenExactAmount(payee, exact));

    let created_block = null;
    try { created_block = await this.chain.blockNumberWithin(5000); } catch { /* chain unreachable at creation: scan from 0 later */ }

    const inv = {
      id: this.store.newId(),
      payee, payer_hint: payer_hint ? getAddress(payer_hint) : null,
      amount: String(amount),
      exact_amount: formatUnits(exact, this.cfg.decimals),
      amount_units: exact.toString(),
      chain: this.cfg.chain, asset: this.cfg.token, symbol: this.cfg.symbol, decimals: this.cfg.decimals,
      due_date: due_date ?? null, memo,
      created_at: new Date().toISOString(), created_block,
      status: 'open', settlement: null, reminders: [],
    };
    this.store.put(inv);
    return this.#present(inv);
  }

  // ---------------------------------------------------------------- check_payment
  async checkPayment({ invoice_id, tx_hash = null }) {
    const inv = this.store.get(invoice_id);
    if (!inv) throw new Error(`unknown invoice ${invoice_id}`);
    if (inv.status === 'paid') return this.#present(inv);

    try {
      // Path A: a settlement receipt (x402 PAYMENT-RESPONSE) names the transaction.
      if (tx_hash) {
        const v = await this.chain.verifyTx(tx_hash, inv.payee, inv.amount_units);
        if (v.found && v.success && v.confirmations >= this.cfg.confirmations) {
          return this.#present(this.#settle(inv, { txHash: tx_hash, from: v.from, block: v.block, value: BigInt(v.paid_units) }, v.confirmations));
        }
        if (v.found && !v.success) return this.#present(this.#mark(inv, 'partial', { tx_hash, paid: v.paid_units, reason: v.reason ?? 'insufficient amount' }));
      }

      // Path B: scan transfers into the payee since the invoice was created and match the exact amount.
      const head = await this.chain.blockNumber();
      const from = inv.created_block ?? 0;
      const transfers = await this.chain.transfersTo(inv.payee, Math.max(0, from - 5), head);
      const want = BigInt(inv.amount_units);
      // The exact amount is the matching key; payer_hint only breaks ties (it is a hint, not a filter).
      const exact = transfers.filter(t => t.value === want);
      const hit = (inv.payer_hint && exact.find(t => t.from.toLowerCase() === inv.payer_hint.toLowerCase())) || exact[0];
      if (hit) {
        const conf = head - hit.block + 1;
        if (conf >= this.cfg.confirmations) return this.#present(this.#settle(inv, hit, conf));
        return this.#present(this.#mark(inv, 'open', { pending_tx: hit.txHash, confirmations: conf, needs: this.cfg.confirmations }));
      }
      // A smaller transfer from the hinted payer counts as partial (informational; the invoice stays unsettled).
      const partial = inv.payer_hint && transfers.find(t => t.from.toLowerCase() === inv.payer_hint.toLowerCase() && t.value < want);
      if (partial) return this.#present(this.#mark(inv, 'partial', { tx_hash: partial.txHash, paid: partial.value.toString() }));

      const overdue = inv.due_date && Date.now() > Date.parse(inv.due_date);
      return this.#present(this.#mark(inv, overdue ? 'overdue' : 'open', { scanned_to_block: head }));
    } catch (err) {
      // Honest failure: the chain could not be read. This is NOT "unpaid".
      return this.#present(this.#mark(inv, 'unknown', { error: String(err?.message ?? err) }));
    }
  }

  // ---------------------------------------------------------------- send_reminder (draft only)
  draftReminder({ invoice_id, tone = 'polite', channel_hint = 'email' }) {
    const inv = this.store.get(invoice_id);
    if (!inv) throw new Error(`unknown invoice ${invoice_id}`);
    if (inv.status === 'paid') return { invoice_id, skip: true, reason: 'invoice already settled' };

    const step = inv.reminders.length + 1;
    const due = inv.due_date ? new Date(inv.due_date).toISOString().slice(0, 10) : null;
    const amt = `${inv.exact_amount} ${inv.symbol}`;
    const pay = `${inv.payee} on ${inv.chain} (${inv.symbol})`;
    const memo = inv.memo ? ` for "${inv.memo}"` : '';

    const T = {
      polite: {
        subject: `Reminder: invoice ${inv.id}${memo}`,
        body: `Hello,\n\nA quick reminder that invoice ${inv.id}${memo} for ${amt}${due ? ` was due on ${due}` : ' is open'}. ` +
              `You can settle it by sending exactly ${amt} to ${pay}. The exact amount lets us match your payment automatically.\n\n` +
              `If you have already paid, thank you, and please ignore this note.\n\nBest regards`,
        send_after_days: 0,
      },
      firm: {
        subject: `Overdue: invoice ${inv.id}${memo} (${amt})`,
        body: `Hello,\n\nInvoice ${inv.id}${memo} for ${amt}${due ? ` was due on ${due} and` : ''} remains unpaid. ` +
              `Please settle it by sending exactly ${amt} to ${pay}.\n\n` +
              `If there is an issue with the invoice, reply and we will sort it out. Otherwise we expect payment within 3 days.\n\nRegards`,
        send_after_days: 3,
      },
      final: {
        subject: `Final notice: invoice ${inv.id}${memo} (${amt})`,
        body: `Hello,\n\nThis is the final notice for invoice ${inv.id}${memo}, ${amt}${due ? `, due ${due}` : ''}. ` +
              `Send exactly ${amt} to ${pay} within 48 hours to keep the account in good standing. ` +
              `After that, service is paused until the balance is settled.\n\nRegards`,
        send_after_days: 7,
      },
    };
    const t = T[tone] ?? T.polite;
    const draft = {
      invoice_id, tone, channel_hint, escalation_step: `${step} of 3`,
      subject: t.subject, body: channel_hint === 'chat' ? t.body.replace(/\n\n/g, '\n') : t.body,
      suggested_send_after: new Date(Date.now() + t.send_after_days * 86400e3).toISOString(),
      note: 'paykit drafted this text and did not send it. Sending is the caller\'s decision.',
    };
    inv.reminders.push({ at: new Date().toISOString(), tone, step });
    this.store.put(inv);
    return draft;
  }

  // ---------------------------------------------------------------- helpers
  #settle(inv, t, confirmations) {
    inv.status = 'paid';
    inv.settlement = { tx_hash: t.txHash, payer_address: t.from, block: t.block, confirmations, paid_units: t.value.toString(),
                       paid_amount: formatUnits(t.value, this.cfg.decimals), settled_at: new Date().toISOString() };
    inv.last_check = null;
    return this.store.put(inv);
  }
  #mark(inv, status, detail) { inv.status = status; inv.last_check = { at: new Date().toISOString(), ...detail }; return this.store.put(inv); }
  #present(inv) {
    return {
      invoice_id: inv.id, status: inv.status,
      pay_to: inv.payee, exact_amount: inv.exact_amount, amount_units: inv.amount_units,
      chain: inv.chain, asset: inv.asset, symbol: inv.symbol, decimals: inv.decimals,
      due_date: inv.due_date, memo: inv.memo, payer_hint: inv.payer_hint,
      payment_uri: `ethereum:${inv.asset}@${this.cfg.chainId}/transfer?address=${inv.payee}&uint256=${inv.amount_units}`,
      settlement: inv.settlement, last_check: inv.last_check ?? null, created_at: inv.created_at,
    };
  }
}
