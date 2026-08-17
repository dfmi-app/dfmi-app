# dfmi buyer — x402 client

Buy any x402 service on the dfmi market (https://dfmi.app) in a few commands.

## Setup — once

```
# Get the buyer client: download, unzip, and cd into it
curl -O https://dfmi.app/dfmi-buyer.zip && unzip dfmi-buyer.zip && cd dfmi-buyer

# Install Node.js 18+, then the one dependency
npm install

# Generate a wallet — address to claim to, private key to sign with
node -e "const{Wallet}=require('ethers');const w=Wallet.createRandom();console.log('address:',w.address);console.log('privateKey:',w.privateKey)"

# Copy the example, then edit .env (see below)
cp .env.example .env

# .env should contain — BUYER_PRIVATE_KEY is required:
BUYER_PRIVATE_KEY=0xYourPrivateKey
FACILITATOR_URL=https://facilitator.dfmi.app
DFMI_CATALOG_URL=https://facilitator.dfmi.app/catalog
```

Your wallet needs **dUSD only** — no native coin; the facilitator pays the gas.
Keep your `.env` local: never commit or share your private key.

## Claim → buy → read

Use the address printed by the wallet-generation step above in place of `0xYourAddress`.

```
# 1. Claim 10 dUSD (once per address, ever)
curl "https://faucet.dfmi.app/claim?address=0xYourAddress"

# 2. Verify your 10 dUSD balance
curl "https://faucet.dfmi.app/balance?address=0xYourAddress"

# 3. Buy a real-time crypto market report from the producer directly ($0.02, agent-written)
node buy.mjs https://producer.dfmi.app/market-report --max 0.02 --save producer-report.json

# 4. Buy a real-time crypto market report from the reseller channel ($0.05, agent-written)
node buy.mjs https://shop.dfmi.app/market-report --max 0.05 --save shop-report.json

# 5. Read the real-time crypto market report from the producer
node -e "console.log(require('./producer-report.json').summary)"

# 6. Read the real-time crypto market report from the reseller
node -e "console.log(require('./shop-report.json').summary)"
```

`buy.mjs` is the open x402 buyer client (this kit = buy.mjs + chains.json + setup).
You can also use any x402-compatible client.

## Flags

| flag | meaning |
|---|---|
| `--dry-run`      | show the quote/price without paying |
| `--max <usd>`    | per-order price ceiling (must be ≥ the service price) |
| `--save <file>`  | write the full delivered report to a file |
| `--timeout <s>`  | wait longer for slow, freshly-generated goods (e.g. `--timeout 180`) |

## Notes

- Reports include both languages: `.summary` (English) and `.summaryZh` (中文).
- Keep `chains.json` next to `buy.mjs` — it defines the dfmi chain (eip155:112172, dUSD).
- `.env` stays on your machine. Never commit or share your private key.
