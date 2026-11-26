# Verify dfmi yourself

These scripts check dfmi from the outside. They need no account, no key and no access to our servers, so you don't
have to take our word for anything in `LAUNCH-READINESS.md`.

| Script | Runs against | What it checks |
|---|---|---|
| `verify-auth.mjs` | production | server-side sign-in, sessions, passkeys |
| `verify-payments.mjs` | production | catalog, monitor status, rate limits; with `--buy` one purchase and its retry; with `--load` the paid path under concurrency |
| `verify-browser.mjs` | production, in a real browser | what the wallet pages keep in browser storage; passkeys through the browser's own WebAuthn |
| `drills/payment-faults.mjs` | your machine only | payment failures we cannot cause on the live system: crashes, a facilitator that lost its records, refunds interrupted half way, restores of an old database |

Requirements: Node.js 22 or newer (the drills use `node:sqlite` through the seller library).

```bash
cd verify
npm install
npx playwright install chromium     # only for verify-browser.mjs
```

## Sign-in: `verify-auth.mjs`

```bash
node verify-auth.mjs                # about 2.5 minutes (it waits out the 2-minute challenge lifetime)
node verify-auth.mjs --skip-expiry  # about 10 seconds
```

The script makes a throwaway wallet and a software passkey authenticator. Then it checks, against the mail API:

| Area | What must happen |
|---|---|
| Wallet signature | The server issues the challenge. A correct signature gets a session. The same challenge used twice is refused. A signature by another key, or over an edited message, is refused. A challenge used after 2 minutes is refused. A made-up token is refused. |
| Sign out | After sign out the token is refused. After "sign out on all devices", every session of that address is refused, while another address keeps working. |
| Passkeys | The server registers the passkey and verifies every sign-in. It refuses a replayed response, a response signed by another key, a response made on another site, and a signature counter that goes backwards (a cloned authenticator). A passkey session cannot remove passkeys. |

Nothing is paid and no email is sent. At the end the script removes its passkey and signs its throwaway
addresses out everywhere. Exit code 0 means every check passed.

## Payments and operations: `verify-payments.mjs`

```bash
node verify-payments.mjs            # read-only, spends nothing
node verify-payments.mjs --buy      # also one purchase; see below
node verify-payments.mjs --load     # also the concurrency checks; see below
```

**Read-only checks:**
- The facilitator's catalog lists only resources that answer an unpaid request with `402` and complete payment requirements.
- The public status of our health monitor (<https://dfmi.app/status.json>) is fresh, and all of its checks pass:
  - the services, paid endpoints and pages are up;
  - no orders are stuck and no refunds are overdue;
  - the hourly backup is fresh, and the weekly restore drill passed.
- A burst of 30 unpaid requests from your machine is rate limited with `429` and `Retry-After`. For a second or two afterwards, your IP gets `429` from that seller.

**`--buy` checks.** Run this only if you choose to. The script:
1. makes a throwaway wallet and claims the faucet's free 10 dUSD;
2. buys one market report (0.02 dUSD);
3. sends the **same payment again**, as a client would after losing the first response.

It then checks that:
- the retry returns the same order and the same settlement transaction;
- on chain, the wallet was charged exactly once: its balance fell by exactly the price, and exactly one dUSD transfer left it, to the seller;
- the order's status URL reports it delivered.

dUSD is a points unit with no monetary value. The faucet gives each address one free claim.

**`--load` checks.** Run this only if you choose to. It claims the faucet once and spends about 0.7 dUSD of it:
1. the **same payment sent 6 times at once** (`--same N`): every request ends with the report, all with one order and
   one settlement transaction;
2. **6 different purchases at once** (`--many M`): each delivered, 6 distinct orders and transactions;
3. a **sustained run** (`--soak 60`, one purchase every 3 s, `--soak-every-ms`): every purchase delivered, no timeouts
   (limit 90 s), each one retried and answered with the same order; latency p50/p95/p99 is printed;
4. on chain, for the whole run: the wallet was charged exactly once per purchase, one transfer each, all to the seller.

**Overload contract.** Overload is answered in one of two ways, both carrying `Retry-After`:
- `429`: this client is over its limits, per IP address: 60 requests a minute (burst 20), or more than 2 requests in flight to one seller;
- `503`: the seller is at its global limit of 8 requests in flight, or the paid order is recorded but its delivery is not finished yet.

Both mean the same to a client: the request was not done, so send the **same** request again after `Retry-After`. A
retried payment is never charged twice. The script does exactly that. It fails on any other error, any `5xx` without
`Retry-After`, or a hang. (Until 25 November this README said "429 only, never a 5xx". That was wrong: a 503 under
global overload has always been part of the seller library.)

From one machine you measure one client's share; the printed latencies are what a client sees at that share.

## Browser wallets: `verify-browser.mjs`

```bash
node verify-browser.mjs             # about 30 seconds, headless
node verify-browser.mjs --headed    # watch it
```

It drives the live pages in Chromium with a throwaway key and a virtual passkey authenticator (Chrome's WebAuthn test
interface), then reads everything the page can persist: localStorage, sessionStorage, IndexedDB, Cache Storage and
cookies. It looks for the private key itself, any 32-byte hex value that is the key of a wallet the page knows, and any
12-word recovery phrase.

| Page | What must happen |
|---|---|
| wallet.dfmi.app | A key imported with a password is stored only as an encrypted keystore (scrypt). No key or phrase in any storage. After a reload the key is locked; a wrong password does not unlock it; the right one does, and still nothing is written. |
| identity.dfmi.app | Sign in with a keystore file. The browser creates a passkey, and the server verifies and stores it; the private part stays in the authenticator. No key in any storage. After **Sign out**, every token-like value left in storage is tried on the server and must be refused, and the page holds no key. Passkey sign-in works in the browser. After a reload no key is in the page. |

It pays nothing. At the end it removes the test passkey and signs the throwaway address out everywhere.

**On real devices (manual, about 5 minutes).** A script cannot press a fingerprint sensor. On a phone (iOS Safari or
Android Chrome) and on a laptop with Touch ID or Windows Hello:
1. open identity.dfmi.app, choose **Sign in with a key → Ephemeral key**, then **Sign message**;
2. **Register passkey for this address**: the system prompt names identity.dfmi.app; confirm. The page says the server verified it;
3. **Sign out**, then **Sign in with passkey**: the prompt appears again; the page says the server verified it;
4. cancel the prompt once: the page says "Cancelled." and no session is created;
5. remove the passkey in the page's list; signing in with it is then refused.

## Payment failures: `drills/payment-faults.mjs`

```bash
node drills/payment-faults.mjs      # about a minute, entirely local
```

Failures like "charged, then the seller crashed" cannot be caused on the live system from outside, and we do not cause
them there. This drill runs them on your machine with the same seller library the live sellers run
(`../wangvc-seller/x402-lib`): a local chain with the dUSD token as deployed, a seller, and a small facilitator written
in the drill so that it can fail on purpose. Faults are injected from outside the seller process. After every drill the
money side is checked on the chain, not from the seller's records.

| # | Fault | What must happen |
|---|---|---|
| 1 | Charged, then the seller crashes before recording it | After a restart the same `X-PAYMENT` delivers, with the original transaction. Charged once. |
| 2 | Same, the buyer never retries, the facilitator is down | The seller finds the payment on chain by itself and delivers. |
| 3 | The facilitator settled but answers "authorization already used" (lost its records) | The seller checks the chain, finds the original transaction, delivers. Charged once. |
| 4 | Settlement never happened, then the authorization expires | Kept while it could still settle; then void, "not charged"; a retry cannot charge. |
| 5 | Charged, but the goods can never be made | Refunded automatically, verified on chain; the buyer is made whole; a retry neither delivers nor charges. |
| 6 | The seller crashes after signing a refund, before broadcasting it | After a restart the **same** signed refund is broadcast. Exactly one refund. |
| 7 | The seller crashes right after broadcasting a refund | After a restart it finds the refund on chain. Exactly one refund, never two. |
| 8 | No refund wallet | The debt is never dropped: `refund_due`, the status URL says who is owed how much, an overdue alert, and it survives a restart. |
| 9 | A database backup is restored in which an order still owes a refund, but that refund was paid after the backup | The seller finds the refund on chain (the calldata of every automatic refund carries a tag naming its order) and pays nothing. Exactly one refund. |
| 10 | Same, but the refund on chain has no tag (paid before tagging existed, or by hand) | It is taken as the refund, nothing is paid, and the seller raises an alert to check it. |
| 11 | A backup from before four purchases is restored; the facilitator is down, and no buyer comes back | The seller rebuilds the four orders from the chain by itself. Their status URLs say delivered, with the original transactions. A later retry returns the same order. Nobody is charged twice. |
| 12 | Same, for a product that needs the buyer's inputs | The rebuilt order waits for its buyer. A buyer who comes back is delivered. A buyer who doesn't is refunded automatically after the grace period, once. |
| 13 | The same payment sent 8 times at once, all admitted | One order, one charge, and the seller's `onDelivered` callback runs once. |

**Recovering orders missing after a restore (drills 11 and 12).** A seller enables this by declaring its offers:
`makeSellerKit({ …, recover: [{ requirements, mode: 'deliver' | 'refund' }] })`. The sweeper then scans the chain for
payments to the offer's `payTo` that no order records, from the recovery cursor stored in the same database. A restored
database brings back an older cursor, so the gap is rescanned.
- `transferWithAuthorization` and session-wallet `pay()` calls are rebuilt into the payment the buyer sent. A session
  payment's `generation` is not in the calldata, so the order can be found under each id a client may have computed.
- Payments younger than `ORDER_RECOVER_MIN_AGE_MS` (default 2 minutes) are left to the request that is settling them.
- Each `payTo` must be used by that seller only.

To see that the drill catches real bugs, point it at an older seller library: `X402_LIB_DIR=/path/to/lib node
drills/payment-faults.mjs`. With the first version (before on-chain reconciliation and automatic refunds) 11 checks fail. With the version tested in
the second independent acceptance on 25 November, 11 checks fail as well, in drills 9–13: the restored refund is paid a
second time, the missing orders stay unknown, and `onDelivered` runs 8 times.

## Options

Both scripts take their endpoints as options:
- `verify-auth.mjs`: `--api`, `--origin`.
- `verify-payments.mjs`: `--facilitator`, `--resource`, `--rpc`, `--faucet`, `--status`; `--key` (an already funded throwaway key instead of the faucet).
- `verify-browser.mjs`: `--wallet`, `--identity`, `--api`.

They default to the production endpoints.
