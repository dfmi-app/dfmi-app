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
  "facilitator": "https://facilitator.dfmi.app",
  "tokenDomain": { "name": "DFMI Dollar", "version": "1" },
  "confirmations": 1,
  "store": "./invoices.json"
}
```

Nothing in it is secret. `facilitator` and `tokenDomain` are used only by the buyer-side `pay.mjs`; the seller tools need just the RPC. Point `store` somewhere else if you want the invoice file outside the repo.

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

To pay an invoice from the buyer side, sign offline and let the facilitator settle it (the buyer needs dUSD only, no native coin; this is the buyer's key, and the seller never holds one):

```bash
BUYER_KEY=0x…   node src/pay.mjs 0x<pay_to> 0.020516                    # EIP-3009 authorization → facilitator /settle
BUYER_KEY=0x…   node src/pay.mjs --invoice inv_2a45e5acb8e5             # same, reading pay_to + exact_amount from the local store
SESSION_KEY=0x… node src/pay.mjs --session 0x<wallet> 0x<pay_to> 0.020516   # pay from a SessionKeyWallet within its cap
node src/cli.mjs check inv_2a45e5acb8e5 --tx 0x…                        # seller side → "paid", with the tx hash and payer
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

## The invoice store and its lock file

The store (`invoices.json` by default, see `store` in the config) has one writer at a time. Every operation takes an exclusive lock file next to it, `invoices.json.lock`, which holds `pid:token`. The operation reloads the file, applies its change, writes a temporary file, and renames it over the store, then removes the lock. Each write is atomic: the visible store is either the old version or the new one, never half of each.

paykit never removes a lock it did not create. Removing another process's lock safely cannot be done with plain files, so a lock left by a process that died mid-operation (a `kill -9`, an out-of-memory kill, a power loss) stays until an operator clears it. The symptom is this error after a 5-second wait, and a service that uses paykit failing to start or restarting in a loop:

```
timed out acquiring store lock …/invoices.json.lock held by pid 12345 (dead). Stop all writers, verify none is running, then remove the lock file manually.
```

The state in brackets is a hint: `dead` means that PID no longer exists, and `live` means some process with that PID exists. It may be a different process that reused the PID. `unknown` means the file is empty or unreadable.

To recover, on the host that holds the store:

1. **Stop every writer.** That includes the service that uses paykit (e.g. `pm2 stop <service>`) and any `cli.mjs` or `pay.mjs` still running.
2. **Confirm none is left.** Read the PID with `cat invoices.json.lock`. Check that `ps -p <pid>` shows nothing, or something that is not paykit. Check that `pgrep -af 'paykit|serve.mjs'` lists no writer.
3. **Check the store is intact.**

   ```bash
   node -e "JSON.parse(require('fs').readFileSync('invoices.json','utf8')); console.log('ok')"
   ```

   An `invoices.json.tmp.<pid>` file is an unfinished write that never replaced the store. Move it aside; do not copy it over the store.
4. **Back up, then remove the lock.**

   ```bash
   cp -p invoices.json invoices.json.bak-$(date +%Y%m%d%H%M)
   mv invoices.json.lock invoices.json.lock.stale-$(date +%Y%m%d%H%M)
   ```

5. **Start the service again** and run one read, e.g. `node src/cli.mjs list`, to confirm the store opens.

Never remove the lock while a writer may still be running: two writers would overwrite each other's invoices. The lock is only meaningful on one host. Do not share a store over NFS or between machines.

If the store is not valid JSON, paykit refuses to start rather than begin with an empty store. It copies the file to `invoices.json.corrupt-<timestamp>` and stops. Restore from your latest backup, or repair the file by hand, before starting again.

## Limits, stated up front

- One chain, one token: the dfmi chain and dUSD. The reader is chain-agnostic in shape, but v0 is scoped to what dfmi runs today.
- Exact-amount matching is per payee. Two open invoices to the same address never share an amount; concurrent invoice volume above a few hundred per payee would need a wider suffix.
- A payer who sends the base amount without the suffix will not match automatically. Use `check_payment` with the `tx_hash` to settle such a payment explicitly.
- The dfmi chain is an experimental network operated on a best-effort basis. If the RPC is unreachable, paykit says `unknown` and you should not deliver.

## License

MIT. Copyright (c) 2026 dfmi Labs contributors.
