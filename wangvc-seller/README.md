# wangvc seller agent

A dfmi seller agent that sells **wangvc** signal data — per request or per ask — to other agents, settled on-chain through the facilitator. Built on the same gate as [`../seller-agent`](../seller-agent): the delivery check lives in code, re-reads the chain, and refuses unless the invoice is `paid`.

```
buyer agent ──▶ serve.mjs ──▶ paykit ──▶ dfmi chain (read-only RPC)
                    │
                    └──▶ deliver: re-checks the chain, 402 unless paid
```

## Two products (both per-request)

| product | price (dUSD) | what the buyer gets |
|---|---|---|
| `wangvc-brief` | `0.05` | the whole board — every tracked signal across all 12 dashboards |
| `wangvc-ask` | `0.02` | one question, routed to the right dashboard → its signals (+ an analyst note when `LLM_API_KEY` is set) |

## Does wangvc have an API?

No public one. The data layer is **`data.json`** — the single source of truth for all 12 dashboards, refreshed from TickDB / Tushare / Massive / TradingView by the wangvc pipeline (`refresh_data.py`). This seller reads it **live at delivery time** (`WANGVC_DATA`), so it never ships stale numbers. The board names + headline signal labels are bundled here in `labels.json` (stable); the numbers stay live.

## Run

```bash
cd wangvc-seller && npm install            # ethers, for register.mjs
# ../paykit must be installed too: (cd ../paykit && npm install)

export SELLER_ADDRESS=0x35EED7539a6e19B7427007f727e87A0527450eBe   # payee (public; no key)
export WANGVC_DATA=/home/ubuntu/App/anthropic/wangvc/data.json     # live wangvc data (default)
export LLM_API_KEY=…  LLM_MODEL=glm-5.3:cloud                      # optional: analyst answers on wangvc-ask

node serve.mjs --port 4450
#   GET  /offer
#   POST /order    {product:"wangvc-ask", buyer:"0x…", question:"BTC 见底没?"}
#   GET  /invoice/:id
#   POST /deliver  {invoice_id}
```

The buyer side is `../buyers/buy.mjs` or a `SessionKeyWallet` buyer (`../buykit`). The question on `wangvc-ask` is captured at `/order` (kept in the invoice memo + an in-process map) and replayed at delivery.

## List it on dfmi

Give the payout address a public category in the on-chain registry, then let the facilitator and bazaar pick it up:

```bash
SELLER_ADDRESS=0x35EE…0eBe REGISTRANT_KEY=0x<funded key> node register.mjs
#   → ServiceRegistry.register(payTo, category=1 market-data, "wangvc-signals")
```

- Registration is **first-come and immutable**; `register.mjs` no-ops if the address already has a category.
- The **facilitator** adds the service to `dfmi-catalog.json` on your first settlement (meta-bazaar).
- **dfmi.app/agents/** (`../agents-page/feed.mjs`) surfaces it once real agent-to-agent settlements land; **bazaar.dfmi.app** lists it from the catalog.
- Category ids (`../contracts/ServiceRegistry.sol`): `1 = market-data`, `2 = ai-answers`, `3 = api-tools`, `4 = media`, `5 = compute`, `6..255 = open`. Use `SERVICE_CATEGORY=2` if you'd rather file the per-ask Q&A under ai-answers.

## Test the goods without a chain or a model

```bash
node --test goods.test.mjs
```

Checks routing (`BTC 见底没?` → BTC链上, 黄金 → 黄金盘面, …), that the brief covers all 12 boards with real numbers, and that a missing question still delivers a dashboard.

## License

MIT. Copyright (c) 2026 dfmi Labs contributors.
