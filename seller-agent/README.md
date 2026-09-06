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

Needs `ANTHROPIC_API_KEY` in the environment (or a logged-in Claude Code), and `../paykit` installed (`cd ../paykit && npm install`). Set `SELLER_ADDRESS` to your payee address; it defaults to a demo address.

## Run

```bash
node seller.mjs "Sell the market report to 0x86CF…2DeB for 0.02 dUSD, due in 7 days."
node seller.mjs "Has inv_ee593ba60b0e been paid? If so, deliver it. If not, draft a polite reminder."
node seller.mjs --repl
```

What a run looks like (the RPC was unreachable from the machine this was recorded on, so the check came back `unknown`):

```
  ↳ mcp__dfmi-paykit__create_invoice({"payee_address":"0x5050…3c9c","amount":0.02,"due_date":"2026-09-12T00:00:00Z","memo":"market-report","payer_hint":"0x86CF…2DeB"})
Invoice created: inv_ee593ba60b0e, exact amount 0.020516 dUSD, pay to 0x5050…3c9c on eip155:112172
  ↳ mcp__dfmi-paykit__check_payment({"invoice_id":"inv_ee593ba60b0e"})
Payment status is unknown — the chain could not be read, not "unpaid". Not delivering.
```

## Test the gate without a model

```bash
node --test gate.test.mjs
```

Creates an invoice against a dead RPC and asserts that the delivery condition (`status === "paid"`) is false when the status is `unknown`.

## What it is for

This is the reference seller for the dfmi network: the first agent that can be paid on dfmi without trusting the facilitator's word for it. Pair it with `buyers/buy.mjs` (or a `SessionKeyWallet` buyer) and you have a complete agent-to-agent transaction — bounded on the buying side, verified on the selling side, with a human present only at grant and revoke.

## License

MIT. Copyright (c) 2026 dfmi Labs contributors.
