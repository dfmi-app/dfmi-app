# dfmi-market-mcp

MCP server for the [dfmi](https://dfmi.app) x402 agent market. Plug it into Claude, Cursor, Codex or any MCP client and the agent can browse services, get quotes, get free test funds and buy — with hard spend limits enforced in code.

| Tool | What it does | Pays? |
|---|---|---|
| `dfmi_list_services` | Ranked catalog from bazaar.dfmi.app (price, score, unique buyers) | no |
| `dfmi_quote` | Ask any x402 endpoint for its price, without signing | no |
| `dfmi_wallet` | Buyer address, dUSD balance, limits left | no |
| `dfmi_create_wallet` | Create a throwaway buyer wallet in `~/.dfmi/` (0600) | no |
| `dfmi_claim_faucet` | 10 free dUSD, once per address | no |
| `dfmi_buy` | 402 → EIP-3009 signature → paid retry → goods + settlement receipt | yes |

## Install

Claude Code:

```bash
claude mcp add dfmi -- npx -y dfmi-market-mcp
```

Claude Desktop / Cursor (`mcpServers`):

```json
{ "dfmi": { "command": "npx", "args": ["-y", "dfmi-market-mcp"] } }
```

Then ask: *"Find a market report on dfmi, check the price, and buy it."*

## Limits (code, not prompt)

| Env | Default | Meaning |
|---|---|---|
| `DFMI_MAX_PRICE` | `0.10` | Max per purchase. The model may lower it per call, never raise it. |
| `DFMI_SESSION_BUDGET` | `1.00` | Total spend for one server run. |
| `DFMI_ALLOW_MAINNET` | off | Testnets only (dfmi dUSD, Base Sepolia USDC) unless set to `1`. |
| `DFMI_BUYER_PRIVATE_KEY` | — | Use your own throwaway key instead of `~/.dfmi/buyer-wallet.json`. |

dUSD is a test unit with no monetary value. Use a throwaway wallet only.

## Develop

```bash
npm install
npm test
```

## Publish (operator)

1. Move this folder into `dfmi-app/dfmi-app` as `market-mcp/` (matches `server.json` → `repository.subfolder`).
2. `npm publish` (package name `dfmi-market-mcp` was free on 2026-10-15; `mcpName` in package.json must match `server.json` `name`).
3. Publish to the official MCP Registry: `mcp-publisher login github` (as the `dfmi-app` org), then `mcp-publisher publish`.
