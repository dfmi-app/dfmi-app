# Launch-readiness review: response (2026-11-24)

On 2026-11-24 an external reviewer read the public pages of dfmi.app read-only and listed five issues to fix before a production launch. Their conclusion was to keep dfmi.app in a small experimental trial. We agree with that conclusion: dfmi is a research demo and stays one.

This page records what changed for each issue, how it was tested, and what was checked on the live site afterwards. All of it is live on dfmi.app and its subdomains. Times are US Pacific. Last updated the same evening, after a follow-up review at 7:08 PM; see [Follow-up review](#follow-up-review-708-pm). At 7:58 PM the mail server also started verifying TLS certificates again (item 3). At 9:29 PM automatic refunds went live for the market-report seller (item 5), and a nonce bug in the wallet app's Send page was fixed (item 4). On 25 November at 8:05 AM passkeys became server-verified (item 3), and at 8:41 AM a public monitor status and a verification kit were added, so that these claims can be checked independently ([Verify it yourself](#verify-it-yourself)). On 25 November between 10:19 and 10:22 AM the reviewer ran the kit against production: 51 of 51 checks passed ([Independent acceptance](#independent-acceptance-25-november)).

| # | Issue | Status |
|---|---|---|
| 1 | Placeholders in the Terms of Service (governing law, courts or arbitration) | **Fixed** |
| 2 | The privacy policy does not match what the pages store | **Fixed** |
| 3 | Server-side sign-in: replay, expiry and invalidation | **Fixed** (session invalidation added; passkeys verified on the server since 25 November) |
| 4 | Private keys in the browser wallet | **Fixed** (decrypted keys are no longer written to storage) |
| 5 | Payment failures, monitoring, rate limits, backup restore, load testing | **Evidence below** |

## Verify it yourself

The rest of this page states what we changed and tested, but a reader can't see our servers. To check the claims independently, the [`verify/`](verify/) directory has two scripts. They call only public endpoints and need no account, key or access to our servers.

| Script | What it checks | Cost |
|---|---|---|
| `verify-auth.mjs` (28 checks, about 2.5 min) | Wallet sign-in: challenges are single use and expire after 2 minutes; wrong signatures are refused. Sign out and "sign out on all devices" revoke sessions. Passkeys are verified by the server: replays, forged signatures, other sites and cloned authenticators are refused. The script cleans up after itself. | none |
| `verify-payments.mjs` | Every catalog resource answers `402` with complete payment requirements. The public monitor status is fresh and all checks pass, including backup freshness and the weekly restore drill. Rate limiting answers `429`. | none |
| `verify-payments.mjs --buy` | One purchase, then the **same payment sent again**: the same order and transaction come back, and the chain shows exactly one charge. The order is reported delivered. | 0.02 dUSD from the free faucet claim |

**Monitor status.** The status of our health monitor is published at <https://dfmi.app/status.json>.
- It is rewritten after every 5-minute run, so a stale `generatedAt` means the monitor stopped.
- It shows each check group's pass/fail and the times of the newest backup and the last restore drill.

**Our own runs, 25 November:**
- `verify-auth.mjs` against production at 8:41 AM: 28 of 28 passed.
- `verify-payments.mjs` (read-only) against production at 8:44 AM: 13 of 13 passed.
- `--buy` was run on a local test chain, not against production: all 9 purchase checks passed. Against the seller code from before the fixes, the script fails: a retried payment answers `402`, so the buyer paid and got nothing. So the script does catch the bug it checks for.

See [`verify/README.md`](verify/README.md) for details.

## Independent acceptance, 25 November

The reviewer ran the kit at commit `6e7b830` against production, from their own machine, between 10:19 and 10:22 AM. Result: **51 of 51 checks passed, 0 failed** (sign-in 28 of 28, payments 23 of 23, including `--buy`).

| Area | Observed |
|---|---|
| Wallet signature sign-in | A correct signature signs in; a wrong signature, an edited message and a replay are refused |
| Challenge expiry | After a real 125-second wait the expired challenge is refused |
| Session revocation | After sign out and "sign out on all devices" the tokens are refused |
| Server-verified passkeys | A normal sign-in works; forged, replayed, wrong-origin and counter-rollback responses are refused |
| Payment retry | The same payment authorization sent again returns the same order and transaction |
| On-chain charge | Balance 10 → 9.98 dUSD; exactly one 0.02 dUSD transfer |
| Rate limiting | 11 of 30 requests answered `429` with `Retry-After` |

The test passkey was removed and all test sessions were revoked. No operator account, wallet or asset was used.

**Accepted independently:** sign-in (item 3) and a single payment retried (item 5).

**Still to be shown before a full production release** (the reviewer found no failures; these are scenarios the kit does not cover yet):
1. **Payment failures and refunds.** Charged but not delivered, settlement interrupted, a crash in the middle of a refund: recovery and refund are not yet independently verified.
2. **Concurrency on the paid path.** The kit retries in sequence. Still needed: the same authorization submitted concurrently, many buyers at once, and a sustained run, with capacity and timeout behaviour stated.
3. **A full restore drill.** The monitor reports backup and restore checks passing; still needed is an independent check that after a restore, reconciliation and delivery continue and revoked sessions stay revoked.
4. **Browser wallets.** The scripts do not check private-key storage in a real browser or passkey prompts on real devices.

Until these are covered, dfmi stays in the small experimental trial the reviewer recommended.

## Follow-up review, 7:08 PM

The reviewer re-checked the live pages at 7:08 PM. Our response to each point:

| Point | Response |
|---|---|
| Terms and Privacy still have placeholders | The corrected pages went live at 7:01 PM; the re-check most likely read a cached copy (cause and fix below). |
| Privacy Policy does not cover encrypted keys, passkey bindings or session tokens | Section 3 has listed all three since 4:43 PM: wallets saved encrypted with the user's password, passkey public keys and their address bindings, and the mail session token. |
| Identity page says a production deployment should verify on the server | The sentence was replaced (7:24 PM), and since 25 November, 8:05 AM, passkeys are verified on the server. See item 3. |
| Faucet buy page asks for a one-time wallet's private key | Changed (7:25 PM): buyers choose a wallet instead. See item 4. |
| Console keeps an encrypted private key in the browser | That is the design. See item 4. |
| Duplicate charges, failed delivery, backup restore, load | These cannot be seen on the public pages. The evidence is in item 5, and the checks marked "you can run" there work from anywhere. |

**Why the old pages were seen.** HTML was sent without a `Cache-Control` header, so browsers and fetching tools chose their own cache lifetime from the `Last-Modified` date. The previous Terms dated from October, so a cache could keep serving that copy for days after an update.

**Change (7:24 PM).** Every HTML page on dfmi.app and its static subdomains is now sent with `Cache-Control: no-cache`. A client revalidates on every load, and gets a `304` when nothing changed. Scripts, images and JSON are unchanged. Also, `/terms`, `/privacy` and `/legal` now serve those pages; before, they served the home page.

You can check it yourself: `curl -sI https://dfmi.app/terms.html` shows `Cache-Control: no-cache`. A reload that bypasses the cache shows section 15 with no placeholders.

## 1. Terms of Service placeholders: fixed

The bracketed placeholders are gone from both documents, in English and Chinese:
- **Terms, section 15** (<https://dfmi.app/terms.html>): the Terms are governed by the laws of the State of California, United States. Disputes are resolved exclusively in the state or federal courts located in San Francisco County, California. The class-action waiver is unchanged.
- **Privacy Policy, section 10** (<https://dfmi.app/privacy.html>): the Service is operated and hosted in the United States.

No other page on the site has a placeholder; every public docroot was searched for them.

## 2. Privacy policy matches what the pages do

**Change.** The policy is at <https://dfmi.app/privacy.html> and was last updated on 24 November 2026. Its section 3 used to say that only `sessionStorage` is used, for language and navigation. We listed every key that each live page writes, and the section now describes all of them:
- preferences;
- wallets saved encrypted with the user's password (`localStorage`);
- records of the console and the wallet app;
- passkey public keys and their address bindings;
- the mail session token;
- the marketplace session (Amazon Cognito).

**Other sections now also say:**
- Card purchases go through Stripe's form, so dfmi never sees card numbers.
- Marketplace accounts are managed by Amazon Cognito, which stores the passwords.
- Stripe and Cognito are listed as service providers, and card purchase records have a stated retention.

**Test.** The page was rendered with jsdom: all 56 text blocks have a Chinese translation, and the language switch works.

## 3. Sign-in sessions can be revoked

The mail service signs users in with a wallet signature. It already did the following on the server:
- The server issues the challenge, which can be used once and expires after 2 minutes.
- The server verifies the signature.
- Sessions expire after 12 hours and are persisted, so a restart does not sign everyone out.

What was missing was invalidation.

**Change.**
- `POST /api/auth/logout` revokes the current session immediately. The **Sign out** button now calls it. Before, the button only cleared the browser's copy, and the token kept working on the server.
- `POST /api/auth/logout-all` revokes every session that address was issued up to now, for a lost or shared device. It is in Settings as **Sign out on all devices**.
  - The cut-off time is persisted, so the revocation survives a restart.
  - It also applies to sessions created before this change.
  - If the revocation record cannot be read, the request is refused rather than allowed.

**Tests.**

| Test | Before | After |
|---|---|---|
| Server, 14 cases (the real server, with object storage replaced by an in-memory stub) | 7 fail | all pass |
| Page, 6 cases (jsdom: both buttons call the right endpoint and sign out locally) | — | all pass |

The 14 server cases cover:
- a logged-out token is rejected;
- after sign out on all devices, both of an address's sessions are rejected and other addresses are unaffected;
- revocation still applies after a restart;
- signing in again works;
- an object-storage outage fails closed.

**Live check, 5:04 PM.** A throwaway key ran the whole flow against the public API, and all 7 steps passed: sign in, sign out (token rejected), two sessions, sign out on all devices (both rejected), and signing in again. No payment was involved.

**TLS certificate verification (7:58 PM).** The mail server had turned off TLS certificate verification for all of its outgoing connections. Those connections go to the dfmi chain node, which resolves `.dfmi` names to wallet addresses, and to the cloud email and storage services. With verification off, anyone able to intercept that traffic could have impersonated the node, for example to map a name to the wrong wallet.

**Change.** Verification is on, with the system's default certificate authorities. Before the change, each endpoint the server uses was checked from the server host and passed with verification on.

**Tests.** A stand-in chain node presented a self-signed certificate. The old server sent it 12 requests at startup; the new server sent none, and still worked once that certificate was trusted. The 14 session tests above still pass.

**Live check.** After the restart:
- the server resolved `.dfmi` names through the node, with no certificate errors in its log;
- a throwaway key signed in, looked up a `.dfmi` name, signed out, and its token was then rejected.

No email was sent.

**Passkeys are verified on the server (25 November, 8:05 AM).** Passkeys on identity.dfmi.app used to be checked only by the page itself, so they could not be trusted for a real sign-in. The mail server now registers and verifies them, and the identity page uses it.
- Every registration and sign-in uses a challenge the server generated: single use, valid for 2 minutes.
- Before it issues a session, the server verifies the authenticator's response: the origin, the RP ID, the challenge, user presence, the signature against the public key stored at registration, and the signature counter. A counter that goes backwards, as from a cloned authenticator, is refused.
- The server stores only the passkey's public key, credential ID, bound address and counter. The browser keeps no passkey data.
- A passkey can be added or removed only by a session proved by a wallet signature. A passkey session cannot add passkeys or remove the owner's.
- "Sign out on all devices" also ends passkey sessions. Sending mail still requires a wallet signature.
- Verification uses a standard WebAuthn library. The Privacy Policy (section 2) describes what is stored.

**Tests.** A software authenticator produced real WebAuthn responses for these tests.

| Test | Result |
|---|---|
| Server, 25 checks: registration, sign-in with and without an address, replay, a response for another challenge, a tampered signature, another origin, another RP ID, a counter going backwards, an unknown passkey, permissions, removal, restart, sign out on all devices | all pass. The previous server fails 20 of them, because it had no such endpoints. |
| The real identity page with the real server, 8 checks, including a forged assertion | all pass |
| The earlier session tests (14) and the TLS test (3) | still pass |

**Live check (8:07 AM).** Against the public API, a throwaway wallet and the software authenticator:
- registered a passkey and signed in with it; the session worked;
- a forged signature, a replayed response, a request from another site, and a passkey session removing a passkey were all refused.

The test passkey was then removed, and all of that address's sessions were ended.

The identity page's notice describes this. Key sign-ins on that page on their own remain a demonstration.

## 4. Private keys stay in memory

**Finding.** After unlocking, the console, the wallet app and the shared sign-in component (used by the identity, points and mail pages) wrote the **decrypted** private key to `sessionStorage`, so that a reload kept the user signed in. Any script running in that tab could then read it. The identity page also stated "keys are decrypted in memory and discarded", which was not true.

**Change.**
- A decrypted key is now held only in the page's memory and is never written to storage. The tab remembers only which wallet was used, so after a reload the user enters their password again. Browser-extension wallets (MetaMask and similar) are unaffected.
- A key left in a tab by an older version is deleted as soon as the page loads, and is never used.
- The identity page's notice now describes this correctly. It also lists the page's network calls accurately: before, it claimed the only calls were read-only RPC.
- The identity page now loads ethers with a Subresource Integrity hash, which the other pages already had.

**Wallet app Send (9:29 PM).** The Send page of wallet.dfmi.app took the transaction nonce when the preview opened, and counted only confirmed transactions. A second transfer previewed while the first was unconfirmed reused its nonce and was rejected by the node; no funds were lost. The nonce is now taken when the user confirms, and counts pending transactions. A jsdom test replays that sequence: the old page fails and the new one passes.

**Faucet buy flow (7:25 PM).** The buy step on faucet.dfmi.app used to ask the user to paste a one-time wallet's private key. Now it has a **Choose a wallet** button, which opens the same picker the other dfmi pages use:
- a browser wallet (MetaMask and similar), which the page switches to the dfmi chain before signing;
- a dfmi wallet saved encrypted in that browser;
- a keystore file.

The wallet generated in step 1 is selected automatically, and its key is held in the page's memory only. Pasting a throwaway key is kept only as a collapsed advanced option, for keys generated offline with the command-line tool; the field is cleared as soon as the key is read. Only the payment signature is ever sent.

**Why the console keeps an encrypted key.** The owner console is where a user creates or imports the owner key of their on-chain wallet. It saves that key in the browser in the standard Ethereum keystore format, encrypted with the user's password. It is decrypted only in the page's memory after the password is entered, and is never sent to a server. A user who clears site data loses that copy, so the console asks them to keep the recovery phrase or a backup file. Privacy Policy section 3 describes this storage.

Unchanged and already in place:
- Wallets saved in the browser use the standard Ethereum keystore format, encrypted with the user's password.
- Pages load ethers with Subresource Integrity, and the site sends an enforcing Content-Security-Policy.
- The faucet's buy flow signs in the browser and sends only addresses and payment signatures, never the key.

**Tests.** jsdom loaded the real pages with a plaintext key left in storage, as an older version would have left it. Two checks fail on the old pages, and all checks pass on the new ones:

| Test | Old pages | New pages |
|---|---|---|
| Identity, console and wallet app, 12 checks | 9 fail | all pass |
| Points page | — | loads without errors, and the old key is deleted |
| Faucet buy flow, 6 checks (each way to pay, no key left in any field or in storage, nothing paid without a wallet) | 6 fail | all pass |

The 12 checks are: the old key is deleted, it is not used to sign in, password unlock still works, and no key is in storage after unlocking.

The new files went live at 4:56 PM. Each one was checked to be byte-identical to the tested version, and all 6 pages return 200.

## 5. Payment failures and operations

### Payment failures

The regression suite covers these. They are described in this branch's earlier commits and in `wangvc-seller/x402-lib/review.test.mjs`. Each case is shown failing on the old code and passing on the fixed code:
- a retried payment request is charged once;
- an order that was charged but not delivered is kept and recovered from the chain;
- refunds are tracked to completion, and are never sent twice;
- revoked or deactivated agents are refused at settlement;
- the services recover after a crash.

### Automatic refunds (9:29 PM)

A refund is owed when an order was charged but could still not be delivered after retrying for about 24 hours. Until now an owed refund was recorded and alerted, and an operator paid it by hand.

**Change.** The market-report seller, which takes almost all of the paid traffic, now pays owed refunds by itself:
- the money comes from a dedicated refund wallet, used by that one seller process only;
- refunds are paid one at a time, and each signed transaction is stored before it is broadcast, so a crash can only re-send the same transaction, never a second refund;
- an order is marked refunded only once the transfer is confirmed on chain.

The other sellers keep the manual process, with an alert after 1 hour.

**Tests.** The refund path is exercised end to end on a local chain: an undeliverable order is refunded automatically and verified on chain, the buyer is made whole, and a retry never delivers or charges again. The 6 order-recovery tests pass.

**Live check.** After the restart:
- the seller's log confirms the automatic refunder is active;
- unpaid requests still get `402`.

No refund was triggered on purpose, and none was owed: since order tracking started, every order of every seller was delivered.

**Monitoring.** A new check alerts when the refund wallet runs low on dUSD, or on the native coin that pays the fees. The monitor now passes 38 of 38 checks.

### Monitoring and alerting

A read-only health check runs every 5 minutes. It never pays, refunds or restarts anything. Alerts go to the operator by Telegram.

The checks are:
- every service process is up and not crash-looping;
- every paid resource answers an unpaid request with `402` within 5 s, through the public TLS endpoint;
- the payment catalog is up, and every resource it lists answers `402`;
- the public pages and the mail API are up;
- the chain head is less than 2 minutes old;
- the demo buyer agent has bought on chain within the last 75 minutes;
- no order has been stuck settling for more than 30 minutes, and no refund has been owed for more than 1 hour;
- the hourly backup is fresh, and the weekly restore drill passed;
- the disk has space, and TLS certificates are more than 14 days from expiry.

Alerting rules:
- A check must fail twice in a row before it alerts.
- While it keeps failing, it alerts again every 6 hours.
- When it passes again, a recovery message is sent.
- A daily heartbeat means that silence would show the monitor itself had stopped.

The alert path was drilled end to end: a simulated failure produced an alert, then a recovery message. The first real run passed 37 of 37 checks. It also found one stale catalog entry: a resource that was re-registered under a new id in August, which now answers `404`. That led to the catalog fix below.

### Catalog: resources that no longer exist are hidden

The payment catalog is built from settlement history, and payment records are never deleted, so a resource that was retired stayed listed. Buyers and agents read the catalog to find sellers.

**Change.** The facilitator now probes every listed resource with an unpaid request every 10 minutes.
- A resource is hidden from `/catalog` only after it answers `404` or `410` twice in a row.
- A timeout or a `5xx` error never hides an entry, and never brings a hidden one back. An outage is not a removal.
- A hidden resource is listed again as soon as it answers `402` again, or a payment to it settles.
- The settlement history is not modified. `/catalog?all=1` returns every entry, with the hidden ones marked `inactive`, and when and why they were hidden.
- The hidden state is kept across restarts. The format of `/catalog` is unchanged, so the pages and agents that read it need no change.
- Only the service's own domain is probed.

**Tests.** Six cases against local stand-in sellers that answer `402`, `404`, `410` and `503`, never answer, or come back after being hidden. The facilitator that was live before the change fails 4 of them; the new one passes all 6. The existing facilitator regression suite (10 cases) and the wallet end-to-end tests (3) still pass.

**Live check.** Deployed at 7:02 PM. The first probe, at 7:03 PM, recorded one `404` for the retired resource. The second, at 7:12 PM, hid it:
- `/catalog` went from 8 entries to 7;
- `/catalog?all=1` still returns all 8, with that one marked `inactive` (`404`);
- the settlement history file is unchanged.

The monitor's exception for that entry was removed, and the monitor passes 37 of 37 checks.

You can run: `curl -s https://facilitator.dfmi.app/catalog` and `curl -s 'https://facilitator.dfmi.app/catalog?all=1'`.

### Rate limiting, verified on the live site

Every seller limits each client IP to 60 requests per minute, with a burst of 20 and at most 2 requests in flight, plus a cap on requests in flight across all clients. The client IP is taken from the reverse proxy, and only when the connection comes from that proxy.

| Live test (one outside IP, through the public endpoint) | Result |
|---|---|
| 30 unpaid requests to the market-report seller | 21 × `402`, then 9 × `429` with `Retry-After: 1` |
| 30 unpaid requests to the wangvc-seller `/signals` | 21 × `402`, then 9 × `429` with `Retry-After: 1` |

You can run the same check: send about 30 quick unpaid requests to `https://producer.dfmi.app/market-report`. The first ones answer `402`, and once the burst is used up they answer `429`.

### Load tests

All load tests sent **unpaid** requests only, so no charges were made.

**Live, through the reverse proxy and TLS, from a source exempt from the rate limit:**

| Target | Concurrency | Requests | req/s | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|---|---|
| seller, unpaid → `402` | 1 | 50 | 167 | 3.7 ms | 8.4 ms | 102 ms | 0 |
| seller, unpaid → `402` | 8 | 400 | 426 | 12.9 ms | 32 ms | 129 ms | 0 |
| facilitator `/catalog` | 8 | 200 | 307 | 14.9 ms | 87 ms | 155 ms | 0 |

The host's load average afterwards was 0.10.

**Local capacity of the deployed seller code (one Node process):**

| Phase | c=1 | c=8 | c=32 | c=128 | Result |
|---|---|---|---|---|---|
| Limits lifted | 1.5k req/s | 6.9k req/s | 12.2k req/s | 17.5k req/s | All `402`; p99 under 71 ms |
| Production limiter, one abusive IP | — | — | — | — | 19 × `402`, then every request `429` |

Throughput is the same in both phases, so the limiter adds no measurable cost.

**Not load-tested:** the paid path, which settles on chain. A load test of it would make real charges on the production chain. It needs a separate test chain with a funded test buyer. Concurrency and retries of settlement are exercised by the integration suite on a local EVM.

### Backup and restore

The payment databases and the settlement ledger are snapshotted hourly, with an integrity check on each copy, and kept for 14 days. The server volume also gets a daily snapshot, kept for 7 days.

A weekly drill restores the newest snapshot into a private temporary directory, then:
- runs SQLite `integrity_check` on each database;
- compares its tables with the live database;
- checks that every row in the backup still exists live;
- checks that the settlement ledger in the backup is a subset of the live one.

The monitor alerts if the last drill failed or is more than 8 days old.

The first drill, at 5:09 PM, passed. It restored 6 databases and a ledger of 1,526 settlements, with nothing missing live. The backup was one order behind live, because that purchase was made after the snapshot was taken.
