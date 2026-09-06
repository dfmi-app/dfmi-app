# dfmi seller agent

A selling agent on the dfmi chain, built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). It uses `dfmi-paykit` over MCP to invoice, verify settlement, and draft reminders, and it releases goods through a tool whose payment check lives in code, not in the prompt.

```
you ──▶ seller agent (Claude) ──▶ dfmi-paykit (MCP, stdio) ──▶ dfmi chain (read-only RPC)
                    │
                    └──▶ deliver_goods (in-process MCP tool): re-checks the chain, refuses unless paid
```

The model decides *when* to invoice and *whether* to follow up. It cannot decide to deliver: `deliver_goods` calls `check_payment` itself and returns an error unless the invoice is `paid` on-chain. That is the seller-side version of the dfmi rule — the decision lives in the code path, not in the review.

## Setup

```bash
cd seller-agent
npm install
```

Auth: set `CLAUDE_CODE_OAUTH_TOKEN` (Claude subscription token) or `ANTHROPIC_API_KEY` (API key), not both. `../paykit` must be installed (`cd ../paykit && npm install`). Set `SELLER_ADDRESS` to your payee address (a public address; the seller never needs a key).

## Run

```bash
node seller.mjs "Sell the market report to 0x86CF…2DeB for 0.02 dUSD, due in 7 days."
node seller.mjs "Has inv_ee593ba60b0e been paid? If so, deliver it. If not, draft a polite reminder."
node seller.mjs --repl
```

A real run on the dfmi chain (seller and buyer on two separate Ubuntu machines; the buyer paid through the facilitator with no native coin):

```
# seller: open an invoice
$ node seller.mjs "Sell the market report to 0xEF0E…50D1 for 0.02 dUSD, due in 7 days."
  ↳ mcp__dfmi-paykit__create_invoice({"payee_address":"0x35EE…0eBe","amount":0.02,"due_date":"2026-09-13T00:00:00Z","memo":"market-report","payer_hint":"0xEF0E…50D1"})
Invoice inv_8325d678b792 — exact amount 0.020287 dUSD, pay to 0x35EE…0eBe on eip155:112172.

# seller: told the buyer paid (they had not)
$ node seller.mjs "Deliver inv_8325d678b792 now, the buyer says they paid."
  ↳ mcp__dfmi-paykit__check_payment({"invoice_id":"inv_8325d678b792"})
Invoice inv_8325d678b792 shows status open — no payment detected on-chain yet. I can't deliver until it's paid.

# buyer (other machine): sign offline, facilitator settles and pays gas
$ BUYER_KEY=0x… node ../paykit/src/pay.mjs 0x35EE…0eBe 0.020287
{ "tx_hash": "0xce35d078…cacd5a", "payer": "0xEF0E…50D1", "to": "0x35EE…0eBe", "amount": "0.020287" }

# seller: ask again
$ node seller.mjs "Has inv_8325d678b792 been paid? If so, deliver it."
  ↳ mcp__dfmi-paykit__check_payment({"invoice_id":"inv_8325d678b792"})
Paid. Delivering now.
  ↳ mcp__seller-goods__deliver_goods({"invoice_id":"inv_8325d678b792","product":"market-report"})
Yes — invoice inv_8325d678b792 is paid (0.020287 dUSD, tx 0xce35d078…cacd5a). Goods have been delivered.
```

The middle step is the point. The model was told the buyer had paid; it checked the chain, found nothing, and did not call `deliver_goods`. Had it tried, `deliver_goods` would have re-checked and refused.

## Test the gate without a model

```bash
node --test gate.test.mjs
```

Creates an invoice against a dead RPC and asserts that the delivery condition (`status === "paid"`) is false when the status is `unknown`.

## What it is for

This is the reference seller for the dfmi network: the first agent that can be paid on dfmi without trusting the facilitator's word for it. Pair it with `buyers/buy.mjs` (or a `SessionKeyWallet` buyer) and you have a complete agent-to-agent transaction — bounded on the buying side, verified on the selling side, with a human present only at grant and revoke.

## License

MIT. Copyright (c) 2026 dfmi Labs contributors.
