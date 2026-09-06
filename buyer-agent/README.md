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

## A full agent-to-agent purchase

1. Seller agent (`../seller-agent`) creates an invoice: id, exact amount, pay_to, chain.
2. Owner (or another agent) hands that invoice to the buyer agent.
3. Buyer agent: `check_budget` → `pay_invoice` (buykit pre-checks, signs with the session key, facilitator settles, no gas).
4. Seller agent: `check_payment` sees the exact amount → `deliver_goods`.

Two agents, two bounded tools, one public ledger between them. A human is present at grant and at revoke, and nowhere else.

## License

MIT. Copyright (c) 2026 dfmi Labs contributors.
