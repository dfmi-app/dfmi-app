# dfmi buyer agent

A buying agent on the dfmi chain. It spends from a `SessionKeyWallet` with a key its owner granted, through `dfmi-buykit`. The wallet contract enforces the cap, expiry and intent on-chain; buykit refuses early and never pays twice; the owner's per-purchase limit is passed into buykit as `max_amount`, so it is code, not memory.

```
owner ──grant(cap, expiry, intent)──▶ SessionKeyWallet ◀── facilitator.pay() ◀── buykit.pay_invoice ◀── buyer agent (a model)
  └── revoke() at any time                  │
                                            └──▶ token.transfer(seller, exact_amount) ──▶ seller agent verifies with paykit, delivers
```

## One buyer, three backends

Rules and tools live in `buyer-core.mjs`; three runners share them.

| Backend | Auth | Run |
|---|---|---|
| Claude (Agent SDK) | `CLAUDE_CODE_OAUTH_TOKEN` (subscription) or `ANTHROPIC_API_KEY` | `node buyer.mjs "…"` |
| Ollama Cloud, OpenAI API, local Ollama | `LLM_API_URL` + `LLM_API_KEY` + `LLM_MODEL` | `node buyer-ollama.mjs "…"` |
| ChatGPT subscription (Codex CLI) | `codex login` | `bash codex-setup.sh`, then `codex exec --approve-for-me "…"` |

## Setup

```bash
cd ../buykit && npm install && npm test
cd ../buyer-agent && npm install
export SESSION_WALLET=0x…      # the wallet the owner funded
export SESSION_KEY=0x…         # the session key the owner granted (see buykit/src/grant.mjs)
export BUYER_MAX=0.05          # owner's limit for a single purchase (default 0.05 dUSD)
```

## Run

```bash
node buyer.mjs "What is my budget?"
node buyer.mjs "Pay invoice inv_8325d678b792: 0.020287 dUSD to 0x35EED7539a6e19B7427007f727e87A0527450eBe on eip155:112172."
node buyer.mjs "Pay invoice inv_x: 0.90 dUSD to 0x35EE… on eip155:112172."     # → refused: over max_amount / over cap
```

`BUYER_DEBUG=1` prints every tool result.

## The first one, 2026-09-06

Owner (once): `grant.mjs fund` 1 dUSD into SessionKeyWallet `0x4Be5…B6d6`, `grant.mjs grant` a fresh session key with cap 0.50 dUSD for 7 days (tx `0x1d5c8053…f9b3`).

```
# seller machine
$ node seller.mjs "Sell the market report to 0x4Be5…B6d6 for 0.02 dUSD, due in 7 days."
Invoice inv_4c445f21ea4e — exact amount 0.020457 dUSD, pay to 0x35EE…0eBe, chain eip155:112172.

# buyer machine
$ node buyer.mjs "Pay invoice inv_4c445f21ea4e: 0.020457 dUSD to 0x35EE…0eBe on eip155:112172."
  ↳ mcp__dfmi-buykit__check_budget({})
0.020457 dUSD fits within budget and the 0.05 cap. Proceeding with payment.
  ↳ mcp__dfmi-buykit__pay_invoice({"invoice_id":"inv_4c445f21ea4e","pay_to":"0x35EE…0eBe","exact_amount":0.020457,"max_amount":0.05,"chain":"eip155:112172"})
Paid successfully. Tx hash: 0x80f5cf6e…9b0cbe

# seller machine
$ node seller.mjs "Has inv_4c445f21ea4e been paid? If so, deliver it."
  ↳ mcp__dfmi-paykit__check_payment({"invoice_id":"inv_4c445f21ea4e"})
  ↳ mcp__seller-goods__deliver_goods({"invoice_id":"inv_4c445f21ea4e"})
Yes — inv_4c445f21ea4e is paid. Payer: 0x4Be5…B6d6. Goods delivered.
```

On the first attempt the buyer's pre-payment scan hit the node's `eth_getLogs` range limit. The agent did not pay, did not retry, and asked its owner to check the chain: nothing moved. The scan is chunked now, and buykit refuses outright when it cannot verify prior payments, because paying blind is how duplicates happen.

## A full agent-to-agent purchase

1. Seller agent (`../seller-agent`) creates an invoice: id, exact amount, pay_to, chain.
2. Owner (or another agent) hands that invoice to the buyer agent.
3. Buyer agent: `check_budget` → `pay_invoice` (buykit pre-checks, signs with the session key, facilitator settles, no gas).
4. Seller agent: `check_payment` sees the exact amount → `deliver_goods`.

Two agents, two bounded tools, one public ledger between them. A human is present at grant and at revoke, and nowhere else.

## License

MIT. Copyright (c) 2026 dfmi Labs contributors.
