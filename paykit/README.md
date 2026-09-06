# dfmi-paykit

The seller side of an agent transaction, as an MCP server.

A buying agent on dfmi pays under a bounded, revocable credential (`SessionKeyWallet`). paykit gives the **selling** agent the other half: create a payment request, verify on the dfmi chain that it was settled, and draft a reminder if it wasn't. Four tools, read-only, no keys.

| Tool | What it does | What it never does |
|---|---|---|
| `create_invoice` | Creates a payment request with a unique exact amount (`2.00` becomes e.g. `2.000487 dUSD`) | Derive an address, hold a key |
| `check_payment` | Reads the chain and answers `open` / `paid` / `partial` / `overdue` / `unknown` | Trust anyone's word that a payment happened |
| `send_reminder` | Drafts subject and body for an unpaid invoice, escalating polite → firm → final | Send anything |
| `list_invoices` | Lists the local invoice store | — |

Matching is by exact amount, so no per-invoice address and no derived key are needed. `unknown` means the chain could not be read; it is never reported as "unpaid". paykit runs on the seller's machine, keeps its invoices in a local JSON file, and talks to nothing but an RPC endpoint.

## Install

```bash
cd paykit
npm install
npm test          # 7 tests against a fake chain; no network needed
```

`paykit.config.json` points at the dfmi chain by default:

```json
{
  "chain": "eip155:112172",
  "rpc": "https://ethereum.dfmi.app:8541",
  "token": "0x03E25a5DC7aC15f32462652a4bF4986F378d5fcf",
  "symbol": "dUSD",
  "decimals": 6,
  "confirmations": 1,
  "store": "./invoices.json"
}
```

Nothing in it is secret. Point `store` somewhere else if you want the invoice file outside the repo.

## Use it from an agent (MCP)

Claude Desktop / Claude Code / any MCP client. Add to the client's MCP config:

```json
{
  "mcpServers": {
    "dfmi-paykit": {
      "command": "node",
      "args": ["/absolute/path/to/dfmi-app/paykit/src/server.mjs"]
    }
  }
}
```

Then the agent can say things like:

> Create an invoice for 2 dUSD to 0x5050…3c9c for "market report, September", due in 15 days.
> Has invoice inv_2a45e5acb8e5 been paid?
> Draft a firm reminder for it.

## Use it from a shell (no MCP client)

```bash
node src/cli.mjs create 0x5050A4F4b3f9338C3472dcC01A87C76A144b3c9c 2.00 --memo "market report" --due 2026-09-30
node src/cli.mjs check  inv_2a45e5acb8e5
node src/cli.mjs check  inv_2a45e5acb8e5 --tx 0xabc…   # verify a specific settlement tx (e.g. from an x402 PAYMENT-RESPONSE receipt)
node src/cli.mjs remind inv_2a45e5acb8e5 --tone firm
node src/cli.mjs list   --status open
```

To test the whole loop from one machine, pay an invoice from a buyer wallet (this is the buyer's key, not the seller's; the seller never holds one):

```bash
BUYER_KEY=0x… node src/pay.mjs --invoice inv_2a45e5acb8e5     # plain dUSD transfer of the exact amount
node src/cli.mjs check inv_2a45e5acb8e5                          # → "paid", with the tx hash and payer
```

## How settlement is verified

`check_payment` has two paths and uses whichever it can:

1. **Receipt path.** If the caller has a transaction hash (an x402 settlement receipt carries one), paykit fetches that receipt and checks that it moved at least the invoice amount of the token to the payee, and that it has enough confirmations.
2. **Scan path.** Otherwise it scans `Transfer` events into the payee since the invoice was created and looks for the exact amount (optionally from the hinted payer). A smaller transfer from the hinted payer is reported as `partial`.

Both paths are `eth_getLogs` / `eth_getTransactionReceipt` reads. paykit never signs, never submits, never holds funds.

## Where this sits in dfmi

```
buyer agent ── SessionKeyWallet.pay() ──▶ facilitator ──▶ dfmi chain ──▶ seller address
   (cap, expiry, intent: the credential decides whether it may send)          │
                                                                              ▼
                                                            seller agent ── paykit.check_payment()
                                                               (the chain decides whether it arrived)
```

On the buying side, the authorization path decides whether an agent may send. On the selling side, paykit lets an agent confirm the money arrived before it delivers, without trusting the facilitator's word for it. Together they close the loop: a transaction between two agents, bounded on one end, verified on the other, with a human present only at grant and revoke.

## Limits, stated up front

- One chain, one token: the dfmi chain and dUSD. The reader is chain-agnostic in shape, but v0 is scoped to what dfmi runs today.
- Exact-amount matching is per payee. Two open invoices to the same address never share an amount; concurrent invoice volume above a few hundred per payee would need a wider suffix.
- A payer who sends the base amount without the suffix will not match automatically. Use `check_payment` with the `tx_hash` to settle such a payment explicitly.
- The dfmi chain is an experimental network operated on a best-effort basis. If the RPC is unreachable, paykit says `unknown` and you should not deliver.

## License

MIT. Copyright (c) 2026 dfmi Labs contributors.
