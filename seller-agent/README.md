# dfmi seller agent

A selling agent on the dfmi chain. It invoices with `dfmi-paykit`, verifies settlement on-chain, and releases goods through a tool whose payment check lives in code, not in the prompt.

```
you ──▶ seller agent (a model) ──▶ paykit tools ──▶ dfmi chain (read-only RPC)
                    │
                    └──▶ deliver_goods: re-checks the chain, refuses unless paid
```

The model decides *when* to invoice and *whether* to follow up. It cannot decide to deliver: `deliver_goods` calls `check_payment` itself and returns an error unless the invoice is `paid` on-chain. That is the seller-side version of the dfmi rule — the decision lives in the code path, not in the review.

## One seller, three backends

The rules, the tool definitions and the delivery gate live in `seller-core.mjs`. Three runners share them, so a model outage is a command-line change, not a rewrite:

| Backend | Auth | Run |
|---|---|---|
| Claude (Agent SDK) | `CLAUDE_CODE_OAUTH_TOKEN` (subscription) or `ANTHROPIC_API_KEY` | `node seller.mjs "…"` |
| Ollama Cloud, OpenAI API, local Ollama | `LLM_API_URL` + `LLM_API_KEY` + `LLM_MODEL` | `node seller-ollama.mjs "…"` |
| ChatGPT subscription (Codex CLI) | `codex login` | `bash codex-setup.sh`, then `codex exec --approve-for-me "…"` |

`seller-ollama.mjs` is a plain tool-calling loop over `/v1/chat/completions`; it defaults to `https://ollama.com/v1/chat/completions` with `glm-5.3:cloud`. `goods-server.mjs` exposes `deliver_goods` as a stdio MCP server so Codex (or Claude Desktop, Cursor, any MCP client) can mount it next to `paykit/src/server.mjs`; `codex-setup.sh` writes both into `~/.codex/config.toml` and generates `AGENTS.md` from the shared rules.

## Setup

```bash
cd seller-agent
npm install
```

Auth: set `CLAUDE_CODE_OAUTH_TOKEN` (Claude subscription token) or `ANTHROPIC_API_KEY` (API key), not both. `../paykit` must be installed (`cd ../paykit && npm install`). Set `SELLER_ADDRESS` to your payee address (a public address; the seller never needs a key).

## Run

```bash
# Claude
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…        # or ANTHROPIC_API_KEY; not both
export SELLER_ADDRESS=0x…                            # public address that receives payment
node seller.mjs "Sell the market report to 0x<buyer> for 0.02 dUSD, due in 7 days."
node seller.mjs "Has inv_8325d678b792 been paid? If so, deliver it. If not, draft a polite reminder."
node seller.mjs --repl

# Ollama Cloud (same prompts, same tools, same gate)
export LLM_API_KEY=…  LLM_MODEL=glm-5.3:cloud
node seller-ollama.mjs "Has inv_8325d678b792 been paid? If so, deliver it."

# Codex CLI on a ChatGPT subscription
bash codex-setup.sh && codex login          # headless: codex login --device-auth
codex exec --approve-for-me "Has inv_8325d678b792 been paid? If so, deliver it."   # exec defaults to approval=never, which blocks MCP calls
```

`SELLER_DEBUG=1` prints every tool result.

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

Creates an invoice against a dead RPC and asserts that the delivery condition (`status === "paid"`) is false when the status is `unknown`. All three backends ran the same invoice on 2026-09-06 (Claude via Agent SDK, glm-5.3:cloud via seller-ollama.mjs, gpt-6-astra via Codex CLI): each called check_payment, saw `paid`, called deliver_goods, and delivered the same tx. The same gate was also exercised with a scripted model that called `deliver_goods` on an unpaid invoice: the tool returned `Refused: invoice … is "unknown", not "paid"` and nothing was delivered.

## What it is for

This is the reference seller for the dfmi network: the first agent that can be paid on dfmi without trusting the facilitator's word for it. Pair it with `buyers/buy.mjs` (or a `SessionKeyWallet` buyer) and you have a complete agent-to-agent transaction — bounded on the buying side, verified on the selling side, with a human present only at grant and revoke.

## License

MIT. Copyright (c) 2026 dfmi Labs contributors.
