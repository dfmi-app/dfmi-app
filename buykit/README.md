# dfmi-buykit

The buyer side of an agent transaction, as an MCP server.

`dfmi-paykit` lets a selling agent invoice and verify. buykit gives the **buying** agent the other half: know what it may still spend, pay an invoice inside that bound, and keep a log. Three tools. The agent holds a *session key*, never the owner's key.

| Tool | What it does | What it cannot do |
|---|---|---|
| `check_budget` | Reads cap, spent, remaining, expiry and wallet balance from the wallet contract | Change any of them |
| `pay_invoice` | Pays an exact amount to a payee through the facilitator (no gas), after refusing anything over cap, over the caller's limit, outside intent, underfunded, or already paid | Exceed what the owner granted; pay twice |
| `list_purchases` | The local purchase log | — |

## The one idea

The buyer agent's key is bounded on-chain. The owner deploys a `SessionKeyWallet` (or `IntentSessionWallet`), funds it, and grants a session key with a cap, an expiry, and optionally an intent mask. The wallet contract enforces those at `pay()` time, and the owner can revoke the key in one transaction. buykit signs with that key. So whatever the model decides, the most it can lose is the remaining cap, and the owner can stop it at any moment without touching the agent.

buykit pre-checks the same bounds before signing so the agent gets a clear refusal instead of a revert, and it adds two things the contract cannot know: it will not pay the same exact amount to the same payee twice (it scans the chain first), and it treats a facilitator 5xx as "unclear" and asks the chain before reporting anything. Both came from a real duplicate payment on 2026-09-06.

## Install

```bash
cd buykit
npm install
npm test          # 7 tests against a fake wallet and facilitator; no network
```

`buykit.config.json` points at the dfmi chain and facilitator; nothing in it is secret. Two things come from the environment on the buyer's machine:

```bash
export SESSION_WALLET=0x…    # the wallet contract the owner funded (an address, not secret)
export SESSION_KEY=0x…       # the granted session key's private key (secret; bounded by the wallet)
```

## Owner setup (once, on the owner's machine)

```bash
node src/grant.mjs new                                            # prints a fresh session keypair; nothing on-chain
OWNER_KEY=0x… node src/grant.mjs fund   <wallet> 1.00             # move 1 dUSD into the wallet
OWNER_KEY=0x… node src/grant.mjs grant  <wallet> <sessionAddr> 0.50 --days 7 [--mask 2]
OWNER_KEY=0x… node src/grant.mjs status <wallet> <sessionAddr>
OWNER_KEY=0x… node src/grant.mjs revoke <wallet> <sessionAddr>    # the kill switch
```

`--mask` is the IntentSessionWallet intent mask (bit N = category N; `2` = category 1 only; `0` = unrestricted). The owner pays gas for these; the agent never needs any.

## Use it from an agent (MCP)

```json
{
  "mcpServers": {
    "dfmi-buykit": {
      "command": "node",
      "args": ["/absolute/path/to/dfmi-app/buykit/src/server.mjs"],
      "env": { "SESSION_WALLET": "0x…", "SESSION_KEY": "0x…" }
    }
  }
}
```

Then the agent can say things like:

> What is my budget?
> Pay invoice inv_8325d678b792: 0.020287 dUSD to 0x35EE…0eBe on eip155:112172, but not more than 0.05.

## Use it from a shell

```bash
node src/cli.mjs budget
node src/cli.mjs pay 0x35EED7539a6e19B7427007f727e87A0527450eBe 0.020287 --invoice inv_8325d678b792 --max 0.05
node src/cli.mjs list
```

## How a payment goes through

```
buyer agent ── pay_invoice ──▶ buykit: pre-check bounds, scan chain for a prior payment, sign Pay(to, amount, nonce, deadline)
                                  │
                                  ▼
                            facilitator /settle (scheme dfmi-session): verifies the signature against the wallet,
                            calls wallet.pay(...) as relayer, pays gas
                                  │
                                  ▼
                            wallet contract: active? not expired? nonce? spent + amount ≤ cap? intent? → token.transfer(to, amount)
                                  │
                                  ▼
                            seller agent ── paykit.check_payment ──▶ sees the exact amount, delivers
```

## Limits, stated up front

- One chain, one token: the dfmi chain and dUSD.
- Idempotency is by exact amount per (wallet, payee) within `lookbackBlocks`. Two legitimately identical purchases from the same wallet to the same seller within that window would need distinct invoice amounts, which paykit already guarantees.
- The session key is a private key on the buyer's machine. It is bounded, not harmless: treat it like a prepaid card, not like a password you can leak.
- The dfmi chain is an experimental network operated on a best-effort basis.

## License

MIT. Copyright (c) 2026 dfmi Labs contributors.
