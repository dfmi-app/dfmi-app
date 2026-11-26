# Launch-readiness review: response (2026-11-24)

> **26 November, 10:04 AM: the reviewer's mail-server fixes are live on email.dfmi.me.** They arrived as a patch on a13d016 and are the commit before this one; see [Mail server fixes deployed](#mail-server-fixes-deployed-26-november). The reviewer's [delivery notes](walletmail/DELIVERY-NOTES.md) list the changes, their evidence and what is still open. The notes were written before the deployment, so where they say "not deployed", that describes the patch as it was handed over.

On 2026-11-24 an external reviewer read the public pages of dfmi.app read-only and listed five issues to fix before a production launch. Their conclusion was to keep dfmi.app in a small experimental trial. We agree with that conclusion: dfmi is a research demo and stays one.

This page records what changed for each issue, how it was tested, and what was checked on the live site afterwards. All of it is live on dfmi.app and its subdomains. Times are US Pacific. Last updated the same evening, after a follow-up review at 7:08 PM; see [Follow-up review](#follow-up-review-708-pm). At 7:58 PM the mail server also started verifying TLS certificates again (item 3). At 9:29 PM automatic refunds went live for the market-report seller (item 5), and a nonce bug in the wallet app's Send page was fixed (item 4). On 25 November at 8:05 AM passkeys became server-verified (item 3), and at 8:41 AM a public monitor status and a verification kit were added, so that these claims can be checked independently ([Verify it yourself](#verify-it-yourself)). On 25 November between 10:19 and 10:22 AM the reviewer ran the kit against production: 51 of 51 checks passed ([Independent acceptance](#independent-acceptance-25-november)). That afternoon we added tools for the four remaining scenarios, found and fixed two problems, and deployed the fixes at 1:05 PM ([The four scenarios](#the-four-scenarios-25-november-afternoon)). At 4:39 PM the reviewer's second, isolated acceptance run found four more problems, including a refund paid twice after restoring an old backup. They are fixed in the seller library and drilled, and the fixed library has been live on every seller since 5:55 PM ([Deployment](#deployment-25-november-540555-pm)). One earlier claim of ours was overstated and is corrected below ([Second independent acceptance](#second-independent-acceptance-25-november-evening)). The reviewer's third check closed the four tested scenarios. It does not make the whole site production-ready ([Where this leaves us](#where-this-leaves-us)).

| # | Issue | Status |
|---|---|---|
| 1 | Placeholders in the Terms of Service (governing law, courts or arbitration) | **Fixed** |
| 2 | The privacy policy does not match what the pages store | **Fixed** |
| 3 | Server-side sign-in: replay, expiry and invalidation | **Fixed** (session invalidation added; passkeys verified on the server since 25 November) |
| 4 | Private keys in the browser wallet | **Fixed** (decrypted keys are no longer written to storage) |
| 5 | Payment failures, monitoring, rate limits, backup restore, load testing | **Evidence below** |

## Verify it yourself

The rest of this page states what we changed and tested, but a reader can't see our servers. To check the claims independently, the [`verify/`](verify/) directory has scripts that call only public endpoints, plus a drill that runs on a local test chain. None needs an account, key or access to our servers.

| Script | What it checks | Cost |
|---|---|---|
| `verify-auth.mjs` (28 checks, about 2.5 min) | Wallet sign-in: challenges are single use and expire after 2 minutes; wrong signatures are refused. Sign out and "sign out on all devices" revoke sessions. Passkeys are verified by the server: replays, forged signatures, other sites and cloned authenticators are refused. The script cleans up after itself. | none |
| `verify-payments.mjs` | Every catalog resource answers `402` with complete payment requirements. The public monitor status is fresh and all checks pass, including backup freshness and the weekly restore drill. Rate limiting answers `429`. | none |
| `verify-payments.mjs --buy` | One purchase, then the **same payment sent again**: the same order and transaction come back, and the chain shows exactly one charge. The order is reported delivered. | 0.02 dUSD from the free faucet claim |
| `verify-payments.mjs --load` | The same payment sent concurrently, many buyers at once, and a sustained run: one order and one charge per purchase, `429` instead of errors when over the limit, no timeouts | test dUSD from the faucet, about 0.02 per purchase |
| `verify-browser.mjs` (22 checks) | In a real browser: private keys are stored only encrypted, never in plain form in any browser storage; sign out leaves nothing that still works; passkeys are created and verified for real | none |
| `walletmail/test/*.mjs` (65 checks) | The mail and sign-in server, run locally: session revocation across a restore (`SESSIONS_NOT_BEFORE`), sign out everywhere, server-verified passkeys, TLS to the chain RPC, the live identity page end to end | none (local) |
| `drills/payment-faults.mjs` (49 checks) | On a local chain: crashes, outages, refunds and restores of an old database in the payment path; every order is delivered or refunded exactly once | none (local) |

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

## The four scenarios, 25 November afternoon

We added a tool for each scenario. The first three ship in [`verify/`](verify/) and can be run independently; the restore drill needs our servers and backups, so only our result is reported here. **These are our own runs. They have not been independently accepted yet.**

| # | Scenario | Tool | Our result |
|---|---|---|---|
| 1 | Payment failures and refunds | `verify/drills/payment-faults.mjs`: a local chain and the published seller library, with faults injected. Eight scenarios: the seller crashes after the charge and before delivery; the facilitator loses its record; settlement fails or the facilitator is down; the authorization expires; the product can never be made (automatic refund); the refund crashes just before, or just after, it is broadcast | **31 of 31** passed. Each charged order is either delivered or refunded **exactly once**; no buyer is charged twice or refunded twice. Against the seller library from before the fixes, **11 checks fail**, so the drill catches these bugs |
| 2 | Concurrency on the paid path | `verify-payments.mjs --load`: the same authorization sent 6 times at once, 6 buyers buying at once, then a 60-second sustained run (one purchase every 3 seconds) | Run on a local chain: every request ends `200`; concurrent copies of one payment give one order and **one** on-chain transfer; each purchase is charged exactly once; no timeouts. Over-limit requests get `429` with `Retry-After`. (We also wrote "never a `5xx`". That was wrong: under global overload the seller answers `503` with `Retry-After`; see the second acceptance below.) Limits are per IP (60 per minute, 2 in flight) and 8 in flight per seller, so one machine measures one client's share. Running `--load` against production costs real test dUSD from the faucet, so we leave that run to the reviewer |
| 3 | Full restore drill | Not public (it needs server access). The production services are rebuilt on a separate machine from a backup about 6 hours old, with the code that runs in production and a relayer key that holds no funds | **21 of 21** passed in 84 seconds. The backup restores and passes integrity checks. Its 22 orders and the ledger's 1,538 settlements are all found on chain. The 8 real orders made after the backup were delivered by the restored system, with their original order ids and transactions, **when the drill sent each buyer's original payment again**, as a buyer's client does on retry. (We first wrote that they were "recovered from the chain", which suggested the system found them by itself. It did not; see the second acceptance below.) Nothing was charged twice, and the relayer sent no transaction |
| 3 | Revoked sessions after a restore | Mail server tests | See problem 2 below. The fix is live; the restore procedure now includes the step |
| 4 | Browser wallets | `verify/verify-browser.mjs`: real Chromium with a virtual WebAuthn authenticator, against the live wallet and identity pages. It imports a throwaway key through the page, then searches every browser store (localStorage, sessionStorage, IndexedDB, Cache Storage, cookies) for the key or the recovery phrase | First run: 20 of 22 (problem 1 below). After the fix, at 1:06 PM: **22 of 22** against production. Passkey prompts on real phones and laptops can't be scripted; [`verify/README.md`](verify/README.md) has a manual checklist for them |

**Problems found and fixed** (both live at 1:05 PM):
1. **Sign out on identity.dfmi.app did not fully sign out.** The page hid the signed-in state, but the mail session stayed valid on the server, its token stayed in `localStorage`, and the unlocked key stayed in memory. Sign out now ends the session on the server, deletes the token and forgets the key. The browser check tries every token-like value left in storage against the server after sign out; none is accepted.
2. **Restoring session storage from a backup could bring back sessions that had been signed out.** The mail server now takes a `SESSIONS_NOT_BEFORE` setting: after a restore it is set to the restore time, every session issued earlier is refused, and users sign in again. A malformed value stops the server rather than being ignored. Tested both ways: a rebuilt server keeps revocations, and a rolled-back store with the setting refuses every older session. Without the setting the rollback test fails, which is why it is now a step in the restore procedure.

**Still open:** independent acceptance of these four results, and a real-device passkey check using the manual checklist.

## Second independent acceptance, 25 November evening

The reviewer tested commit `c9b60b7` in an isolated environment. It had no connection to production, and no operator account or asset was used. Their verdict: **not yet ready for a full release.**

| Area | Result |
|---|---|
| Our payment failure drills | 31 of 31 passed |
| Their concurrency and capacity checks | 10 of 12 passed |
| Their backup restore checks | 11 of 13 passed |

**Capacity, measured locally.** 16 independent wallets took part. A 60-second sustained ramp completed 537 purchases with 0 timeouts. Together with the earlier phases there were 554 orders, and each was charged exactly once. Throughput was about 8.8 purchases per second, and p95 time to first delivery was 612 ms. This used a local chain, a test settlement service and a simulated report, so **it is not a production capacity commitment.**

They found four problems. All four are now fixed in the seller library ([`wangvc-seller/x402-lib`](wangvc-seller/x402-lib/)) and covered by drills 9–13 in [`verify/drills/payment-faults.mjs`](verify/drills/payment-faults.mjs). The fixes are live on every seller; see [Deployment](#deployment-25-november-540555-pm).

| # | Problem found | Cause | Fix |
|---|---|---|---|
| 1 | **High priority. A refund paid twice after a restore.** The backup held an order in `refund_due`. Its refund was then paid. When the old backup was restored and automatic refunds were enabled, it was paid again: the test buyer ended with 10.02 dUSD and two refunds of 0.02 on chain. | Before paying, the automatic refunder trusted the database alone. | The calldata of every automatic refund now carries a tag naming its order (the token ignores the extra bytes; checked against the deployed dUSD contract). Before paying, the refunder asks the chain. If it finds a refund for that order, or an untagged transfer to the buyer after the obligation that no other order has recorded, it pays nothing, marks the order refunded and raises an alert to check. If the chain can't be read, it doesn't pay. |
| 2 | **Orders made after the backup were not recovered by themselves.** With the published code, all 8 post-backup orders answered `404`. A buyer who resent the original payment got it back with no second charge. Our own restore drill had recovered such orders the same way, by resending the buyer's payment, and our wording overstated this (corrected above). | The seller only knew orders from its database or from a buyer's request. | A seller can now declare its offers (`recover`). Its sweeper scans the chain for payments to its own `payTo` that no order records, starting from a cursor stored in the same database, so a restore rescans exactly the gap. It rebuilds each order with the original transaction. A product that needs no buyer input is delivered. One that does waits for the buyer, then is refunded automatically. |
| 3 | **The overload contract didn't match.** With 16 buyers at once, 8 succeeded and 8 got `503 server busy` with `Retry-After`. We had written "only `429`, never a `5xx`", and `--load` did not retry a `503`. | Our description was wrong. The global limit has always answered `503`. | The contract is now stated and checked. Overload is `429` (this client is over its limits) or `503` (the seller is full, or delivery is not finished), always with `Retry-After`, and both mean "send the same request again". `--load` retries both and fails on any other error. |
| 4 | **The delivery callback ran too often.** 554 orders gave 555 `onDelivered` calls; this was found in the previous round, but the fix was not released. | Whether an order was newly delivered was decided outside the per-order lock. | We applied the reviewer's patch unchanged: the callback runs only for the call that moves the order to delivered. |

**Re-checks on our side.**
- Drills 9–13 pass. Against the library at `c9b60b7` they fail 11 checks:
  - the restored refund is paid twice, and the buyer ends at 1,020,000 instead of 1,000,000;
  - the four missing orders stay unknown;
  - `onDelivered` runs 8 times for one payment.
- The reviewer's own restore and capacity scripts, run unchanged against the new library:
  - restore: **13 of 13**. The 8 post-backup orders are delivered without any buyer retry, and there is one refund;
  - capacity: **11 of 12**. `onDelivered` ran 590 times for 590 orders. The one failure is their check of the old "429 only" wording, which no longer matches the documented contract.
  - Their seller worker needed one added line, declaring its offer to the seller kit with `recover`.

**Still not independently verified.**
- Production mail and session recovery (`SESSIONS_NOT_BEFORE`).
- Passkey prompts on real devices.
- Our own production restore program, which needs server access.

Until those are covered and the deployed fixes are independently accepted, dfmi stays in the small trial.

### Where this leaves us

The reviewer re-tested commit `98ec530` in isolation: no change to the live environment, and no operator account or asset used. **They closed the four tested scenarios.** These are payment failures and refunds, concurrency on the paid path, the restore of the payment services, and the browser wallet. They also stated what that does **not** cover. We agree, and record it here:

1. **Test maintenance (done).** Three older regression tests in [`wangvc-seller/x402-lib/review.test.mjs`](wangvc-seller/x402-lib/review.test.mjs) used mock chains without the new refund lookup (`findRefund`).
   - The library treats a missing lookup as "cannot tell", and so pays nothing. That is correct, but it made those tests fail.
   - The mocks now include `findRefund`, and a new test, P11, pins down that rule: if the lookup fails or is missing, no refund is prepared and the debt is kept. P11 fails against the library at `c9b60b7`.
   - 16 of 16 pass.
2. **Scope of the guarantees.** That production runs these fixes is **our report**, not something the reviewer observed. And the guarantees reach only as far as the configuration:

   | Guarantee | Applies to | Not to |
   |---|---|---|
   | A restored database never pays a refund twice | the market report seller, the only one with automatic refunds | the others: they pay no refunds at all, and an owed refund there is alerted and paid by hand |
   | Orders missing after a restore are rebuilt from the chain | the market report seller (`recover` is on) | the storefront, the wrapper, the summarizer and wangvc.dfmi.app: recovery is off there. An order lost by a restore comes back only when the buyer resends the same payment (no second charge) |
   | One delivery callback per order; 429/503 + `Retry-After` | every seller | — |

3. **Still not independently accepted.**
   - Recovery of mail and sessions (`SESSIONS_NOT_BEFORE`). Since this update, the mail server's code and its tests are public in [`walletmail/`](walletmail/), so this can now be checked; see [Mail and session recovery](#mail-and-session-recovery-now-public).
   - Passkey prompts on real phones and laptops. **We ran the checklist on two real devices on 26 November: all steps passed** (see [Passkeys on real devices](#passkeys-on-real-devices-26-november)). This is our own run, not an independent one.

**So the four tested scenarios are closed, but dfmi is not declared production-ready as a whole.** It stays in the small trial until item 3 is independently accepted.

### Mail server fixes deployed, 26 November

The reviewer delivered a patch for the mail and sign-in server (`walletmail/`). We reviewed it, applied it unchanged with `git am`, and deployed it at **10:04 AM**.

**Two of the issues it fixes were exploitable in production until then.** The reviewer's tests reproduce both against the previous code, locally. We did not try them on production.
- **A self-claimed name gave access to that name's mail.** At sign-in the server accepted a name sent by the client (for example `admin`) without checking it, and the inbox then included mail addressed to that name. Now only an operator-configured mapping, or a name the on-chain resolver confirms, grants a mail alias.
- **Message details were not checked for ownership.** A signed-in user who knew a message id could read its body from the server's memory. Now details and attachments are read from storage and returned only to the sender or a recipient.

The patch also makes several other changes:
- passkeys created before a restore can't sign in until re-registered, which applies only once `SESSIONS_NOT_BEFORE` is set;
- a storage write that fails is reported as an error instead of success;
- sessions are checked against storage on every request;
- mailbox listings read every page;
- attachments can be downloaded with authentication.

**Identity of what runs.**

| | Commit | `server.js` SHA-256 |
|---|---|---|
| Published (this repository) | the patch commit, `Fix mail restoration, durable revocation and attachment access` | `47aa1b68d9e45a2e776b939d59aac847f006c35707fbe4dd99f921da8d6bc473`, the same hash the reviewer's delivery notes give for the server they tested |
| Deployed on email.dfmi.me | — | `73370b02113919144aa9106717363302052c214573db20ac95f4c42f0b54468e` |

The two files differ only in the four configuration defaults described at the top of `walletmail/README.md`: the registry and resolver contract addresses, one address-to-name mapping, and the names checked at startup. The code changes are line-for-line the patch.

**Since 26 November, 6:45 PM UTC (10:45 AM PST), production runs the published file byte-for-byte.**
- The four values above now come from the service's environment file instead of the code.
- Before the switch, both builds were started locally without outside network, and their startup behaviour was identical.
- The running process's `server.js` is sha256 `47aa1b68…`, the same as `walletmail/server.js` here. Anyone can recompute that hash from this repository.
- After the switch: `verify-auth.mjs` 28/28 and `verify-browser.mjs` 22/22 against production.
- The process and host records behind this remain our own operator records.

**Tests.**
- Before deploying, in isolation with loopback-only networking:
  - published build: `mail-restore.mjs` 58/58, `durability.mjs` 49/49;
  - deployed build, with the production configuration: `run` 14, `passkey` 25, `restore` 11, `tls` 3, `identity-e2e` 12, `durability` 49/49 and `mail-restore` 57/58. The one is a check that configures a test name through `KNOWN_ENS_MAPPINGS`, which the deployed build sets in code instead.
  - The previous code fails 30 of 58 and 24 of 49 of those checks.
- After deploying, against production: `verify-auth.mjs` 28/28 and `verify-browser.mjs` 22/22.

**What changes for users.**
- A mailbox name now needs a confirmed owner, so a name that was only typed in at sign-in no longer brings in that name's mail.
- If storage is unavailable, the mail pages show an error instead of an incomplete inbox.
- **Attachments are in the mail page since 10:13 AM.** A message's attachments are listed under its body, each with name, size, type and a download button.
  - The page fetches the file with the session token in the `Authorization` header, never in a URL.
  - It sends that request only to the API's own attachment route, so a tampered download link gets no request and no token.
  - The file always comes back as a download, never rendered in the page, so an HTML attachment can't run in the mail site.
  - Our end-to-end test, with the real page (jsdom) against this server, passes 12 of 12: exact bytes (SHA-256), a hostile filename shown as text, the token only in the header, and a tampered link refused. Against the previous page it fails 4.
  - The deployed page's SHA-256 is `1ab733382645628fa6d1c56a78683ea6246a0a609bf6523c9ddeee52ce869b72`; anyone can compare it with `curl -s https://email.dfmi.me/ | sha256sum`.

**Outgoing mail is sent at most once, and the inbox no longer slows down with total mail (deployed 26 November, 11:46 AM PST).**
- Production again runs the published file byte-for-byte. The `server.js` here and on the server is sha256 `1fc1b7885c6cc08aac892c009a356f6f7103ca3a08b603da14abab655d84ebbe`. The mail page is sha256 `cc8cf9f2cf465861b92c12fefa2ca7f774b02f65e17347a8cbd7c5eecb9ae485`.
- **Outbox.** SES has no idempotency key, so the server keeps one.
  - Before calling SES, it creates `outbox/<wallet>/<messageId>.json` with a conditional write. One `messageId` therefore reaches SES at most once.
  - A retry of a sent message returns the original result.
  - The same `messageId` with different content is refused.
  - If SES rejects a message (a 4xx), it is marked failed, and the same `messageId` may be retried.
  - If the outcome is unknown (a timeout, or a 5xx), the message is **not** resent automatically. The answer says `deliveryMayHaveOccurred: true`, and `GET /api/messages/outbox/:messageId` shows the state.
  - The mail page tells the user to check Sent before sending again. If a message was delivered but its Sent record could not be saved, the page repairs the record with the same `messageId`; this sends nothing.
  - `walletmail/test/outbox.mjs`: 18/18. The SES stub counts every message it accepts. The previous code fails 12; for example, 6 concurrent requests with one `messageId` sent 6 emails.
  - **Two defects found by the reviewer, fixed by their patch (deployed 26 November, 12:34 PM PST).**
    - The SES client used the SDK's default automatic retries. After a lost response, the SDK could resubmit the same message without going through the outbox. It now uses `maxAttempts: 1`.
    - If SES accepted a message but its `sent` outcome could not be saved in the outbox, the API still answered with ordinary success. It now answers 503 with `accepted: true`, `persistenceUnknown: true`, `state: "unknown"` and the message ids.
    - With their tests, `outbox.mjs` is 26/26 and `outbox-sdk.mjs` 8/8. The new test keeps the real SDK retry middleware and replaces only the HTTP transport. Our first tests replaced the whole SES client, so they could not see SDK retries. The unpatched code fails 3 and 5 of these checks.
    - Patched `walletmail/server.js` sha256: `20c5bb41320f53339b590606fea61e0882b339e3b0a085f009376f446d8c6a67`.
    - Production runs this file byte-for-byte since 12:34 PM PST.
    - After deploying, against production:
      - `verify-auth.mjs --skip-expiry` 27/27;
      - `verify-browser.mjs` 22/22;
      - 0 AWS authorization errors in the server log;
      - a new wallet's inbox in 0.39–0.80 s.
- **Inbox cost.** An inbox read lists every message under `raw/` and `content/`, for all users, and keeps the ones addressed to the reader.
  - Before, it read and parsed them one by one, so the time grew with the total mail on the site.
  - Now reads run in parallel (8 at a time), and parsed MIME messages are cached by key, ETag, LastModified and size (64 MB, least recently used evicted).
  - The listing is still read live every time, and who may see a message is still decided per request.
  - `content/` records are small and are not cached, so a storage failure still fails the request instead of giving a partial inbox.
  - `walletmail/test/inbox-equivalence.mjs` gives the previous and the new server the same store. Every user's inbox is byte-identical (4 users). It is still identical with a tiny cache that evicts constantly, after a message is overwritten, and after a message is re-addressed: 14/14. (We first wrote 15/15; the test has 14 checks.)
- **Regression tests on the deployed build:**

  | Test | Passed |
  |---|---|
  | `run` | 14 |
  | `passkey` | 25 |
  | `restore` | 11 |
  | `tls` | 3 |
  | `identity-e2e` | 12 |
  | `mail-restore` | 58/58 |
  | `durability` | 49/49 |
  | attachments page test | 12 |
  | `outbox` | 18 |

- **Against production after deploying:**
  - `verify-auth.mjs --skip-expiry`: 27/27. This run skipped the 2-minute expiry wait, which is the 28th check.
  - `verify-browser.mjs`: 22/22.
  - The server log shows 0 AWS authorization errors.
  - A new wallet's inbox took 2.5–3.4 s before (35 messages under `raw/`). After: 0.79 s for the first read, then 0.38–0.40 s.
  - Sending attachments is not supported.

**Still open**, as listed in the delivery notes:
- a real cloud restore with its evidence;
- the restore runbook carried out end to end;
- independent real-device acceptance;
- production-scale load;
- reliable outbound mail (no automatic resend when `deliveryMayHaveOccurred`).

### Passkeys on real devices, 26 November

On the morning of 26 November, a person ran the manual checklist from [`verify/README.md`](verify/README.md#browser-wallets-verify-browsermjs) on identity.dfmi.app, on two devices. Each used a throwaway key, not a real wallet, and spent nothing.

| Step | iPhone, Safari | Windows laptop, Chrome (Windows Hello) |
|---|---|---|
| 1. Sign in with an ephemeral key, sign the message | passed | passed |
| 2. Register a passkey: the system prompt names identity.dfmi.app; the page says the server verified it | passed | passed |
| 3. Sign out, then sign in with the passkey: the page says the server verified it | passed (all six checks on the page ticked) | passed |
| 4. Cancel the system prompt once: the page says "Cancelled." and no session is created | passed | passed |
| 5. Remove the passkey: signing in with it is then refused | passed | passed |

The prompt cannot be triggered by automation. When a browser is driven by an automation extension, Chrome shows no Windows Hello prompt at all, and the page reports "Cancelled.". On the laptop, every step was therefore clicked and confirmed by the person at the device. This is the "user present" property the check is about.

These are our own results. The reviewer can repeat the checklist on their own devices.

### Send journal: the reviewer's patch, an isolated cloud drill, deployed (26 November, 2:05–2:58 PM PST)

- **The reviewer's patch is applied unchanged** (commit `6624bee`: `1fe4632-journal-fix.patch`, `server.js` sha256 `57c3dfad…`).
  - It adds an authoritative send journal in the events bucket. That bucket is not restored with the mail bucket.
  - The journal is claimed atomically before SES is called.
  - "Not sent" can no longer be inferred from missing events; only a definite SES rejection persisted by the service allows a same-id retry.
  - Closed (`abandoned`) messages stay closed after a mail rollback.
  - The original content fingerprint is kept, so a changed body, subject, recipient or sender is refused.
  - Restored messages stay idempotent on every retry.
- **Our addition on top (next commit): a durable restore guard.**
  - The marker is `journal/_restore-guard/<mail bucket>.json` in the events bucket.
  - While it is on, every instance applies the legacy-restore guard, whatever its environment says. A forgotten `OUTBOX_REQUIRE_EXISTING_JOURNAL` therefore cannot reopen sending.
  - Switch it with `tools/outbox-ops.mjs guard on|off --operator --reason`. Every change is recorded. An unreadable marker counts as on.
  - Production `server.js` sha256: `48099fdca3c428366b3c609ffb1350a2956982d6b93edb3058bddcaa29aaae69`.
- **Tests.**
  - Locally, 264/264 (the reviewer's 252, plus `identity-e2e`).
  - On the mail host with the production `node_modules` and lock file, Node 24.14.1 and SES SDK 3.1026.0, in a network namespace with only loopback: 238/238.
  - The unpatched code fails 10 journal checks.
- **Isolated cloud drill.**
  - **Setup.** A temporary bucket and IAM user that could send only to the SES simulator and was explicitly denied the production guard. The real SES and the real events bucket and journal were used. Every real submission was counted.
  - **Before an AWS Backup**, on the pre-journal server: sent; pending after SES accepted; pending that SES never received, then marked `not-sent` under the OLD rule.
  - **After the backup:**
    - a pre-journal message accepted with no SES event;
    - on the journal server: sent with identical retries and a changed body;
    - answer lost;
    - journal `sent` committed but answer lost;
    - closed `undeterminable`;
    - accepted with no SES event.
  - **After restoring the backup,** with the guard turned on only by the durable marker:
    - every accepted message was answered as a duplicate;
    - the pre-journal message with no record and no event, and a new id, were blocked;
    - the old `failed` and the closed message were refused;
    - changed bodies were refused;
    - Sent history was rebuilt.
  - **After a recorded guard-off,** a new id sent once and old ones stayed blocked.
  - **SES submissions over the whole drill: 8, one per message.** Nothing was resubmitted after the restore.
  - All drill resources were removed.
- **Production.**
  - Deployed 2:53 PM PST. The process (PID, InvocationID, start time) was recorded, and `/proc/<pid>/cwd/server.js` = `48099fdc…`.
  - Against that same process: `verify-auth.mjs` 28/28, `verify-browser.mjs` 22/22 and the real delivery drill 4/4, all with exit code 0.
- Raw records are in our evidence set 9, sent to the reviewer.


These answer the reviewer's remaining items. Raw records are in our evidence set 8, sent to the reviewer. These are our own runs.

- **Production runs this repository's `walletmail/server.js` (sha256 `5a1c33ebda4a3c3b9333f248fcaecfea16f8ff8725ea47b97dc8d6c85409b495`).**
  - It was deployed at 12:54 PM PST.
  - The running process (its PID, InvocationID and start time) was recorded. The hash was read through that process's `/proc/<pid>/cwd/server.js`.
  - Also recorded: Node v24.14.1, the resolved `@aws-sdk/client-sesv2` 3.1026.0 and the lock file hash.
  - `verify-auth.mjs` (28/28, including the expiry wait) and `verify-browser.mjs` (22/22) ran against that same unchanged process, with exit code 0.
- **Pending reconciliation.**
  - SES publishes every external message's events through Amazon Data Firehose to a separate bucket. That bucket is not restored with the mail bucket.
  - The server indexes the events. It turns a `pending` entry into `sent` only on SES acceptance evidence, and never sends anything itself.
  - Before every send, it checks the index. A message SES already accepted is repaired, not resent. If the index cannot be read, nothing is sent.
  - A pending entry with no evidence after 15 minutes is reported in `/api/health` and alerted by our monitor. So are a stopped reconciler and a stale hourly canary. The canary is a probe sent to the SES mailbox simulator to prove the pipeline.
  - An operator resolves an entry with [`walletmail/tools/outbox-ops.mjs`](walletmail/tools/outbox-ops.mjs):

    | Decision | Allowed only when | Result |
    |---|---|---|
    | `sent` | SES recorded an acceptance | entry becomes `sent` |
    | `not-sent` | there is no event at all and canaries before and after the claim prove the pipeline worked | entry becomes `failed`; the user may retry with the **same** messageId |
    | `undeterminable` | otherwise | entry becomes `abandoned`; it is never sent again, and the user is told to check with the recipient |

  - Every decision is recorded with operator, reason and evidence, including in the events bucket. A new messageId is never generated.
  - `walletmail/test/outbox-reconcile.mjs`: 29/29.
- **Real delivery (production, one-off wallets): 4/4.**
  - Messages went to the SES mailbox simulator's `success@`, `bounce@` and `complaint@` addresses, and to a one-off `@dfmi.me` inbox through the real inbound path.
  - Each linked its messageId to one SES message id and to the expected events (Send, Delivery, Bounce, Complaint). The test inbox received its message.
  - A retry of each was not a second submission.
  - Not covered: delivery-delay notices. The simulator cannot produce them.
  - Run it with `walletmail/test/delivery-drill.mjs`.
- **Outbox after a cloud rollback (isolated): 7/7.**
  - **Setup.** A temporary instance ran the deployed server on loopback with a temporary bucket. Its AWS user could send only to the SES simulator. The real SES and the real event pipeline were used, with every real SES submission counted.
  - **Before an AWS Backup:** one message sent; one pending after SES accepted it; one whose `sent` state was saved but whose answer was lost; one pending that SES never received.
  - **After the backup:** one new message was sent. One pending message was answered from SES's events. The never-sent one was resolved `not-sent` by an operator, and then sent with the same messageId.
  - **After restoring the backup** (new message missing, two messages `pending` again), retries of all five submitted **nothing** to SES. The total stayed at 5. Outbox entries and Sent history were rebuilt, and the operator's resolution was still readable.
  - **Limit.** Sent history needs the message body, which SES events do not carry. It is rebuilt when the client retries with the same messageId.
  - **Not counted.** A first run is recorded but not counted: our fault switch was quoted wrongly, and no fault took effect.
- **Backups (owner's decision, 26 November).** AWS Backup of the mail bucket now runs weekly (Sunday 3 AM PT) and keeps each copy 7 days, so one copy is kept. The bucket's versioning (30 days) and cross-region replica are unchanged.


[`walletmail/`](walletmail/) holds the server behind email.dfmi.me, which also handles sign-in for identity.dfmi.app, together with its tests. Everything runs locally, with AWS replaced by a local file; see [`walletmail/README.md`](walletmail/README.md).
- **The published `server.js` is the deployed file, with only configuration defaults changed.** It has no built-in contract addresses, no built-in address-to-name mapping, and the names checked at startup are configurable. The file's header says so. Nothing about sign-in, sessions, passkeys or mail differs.
- **Our run of the published copy:**
  - `restore.mjs` 11 of 11: a rebuilt server keeps revocations. A rolled-back store brings signed-out sessions back unless `SESSIONS_NOT_BEFORE` is set, and with it set every older session is refused.
  - `run.mjs` 14 of 14.
  - `passkey.mjs` 25 of 25.
  - `tls.mjs` 3 of 3.
  - `identity-e2e.mjs` 12 of 12, against the live identity page.
- **What still can't be checked from outside:** that after a real restore the operator actually sets `SESSIONS_NOT_BEFORE`. It is a written step of our restore procedure. The mail data itself is versioned, replicated to a second region and backed up daily. A test restore of that backup brought back every object unchanged.
- **A real backup restore, tied to the application (26 November, 11:24 AM – 12:02 PM PST).**
  - **Setup.**
    - A throwaway wallet was created in production, with two sessions (A and B) and two software passkeys (A and B). No real user's data was used.
    - An on-demand AWS Backup of the mail storage was taken.
  - **After the backup**, in production: passkey B was deleted and session B was signed out. Production then refused both, and session A still worked.
  - **The restore.**
    - The recovery point was restored into a new, private bucket.
    - The restored copy still held session B and passkey B. Production no longer did. Only object names were checked, not contents.
  - **Two isolated instances.**
    - Both ran the deployed `server.js` (sha256 `1fc1b788…`, the file in [`walletmail/`](walletmail/)).
    - Each listened on loopback only and read the restored bucket.
    - `SESSIONS_NOT_BEFORE` was set to the time the restore completed.
    - Their AWS key could read only the restored bucket. A listing of the production bucket with that key was refused (`AccessDenied`).
  - **First run, 17 of 17:**
    - sessions A and B and passkey B were all refused;
    - passkey A was refused until the owner signed in with the wallet and registered it again, and then worked on both instances;
    - a passkey session could not re-register the deleted passkey B;
    - new sessions worked on both instances.
  - **A run we do not count.** Our second run was meant to follow a restart. The drill's control script stopped the wrapper shell instead of the server, so the old processes kept answering. Its 12 passes are not counted.
  - **After the script was fixed** and both instances were really restarted (new processes, no listener in between), the run passed **12 of 12**.
  - **Cleanup.** Afterwards the instances, the drill's AWS user, the restored bucket and the production test passkey and sessions were all removed.
  - These are our own results, from our operator records; the drill needs our AWS account and servers.

### Deployment, 25 November, 5:40–5:55 PM

Every seller now runs the fixed library as published in commit `98ec530`. The deployed copy differs from it only in one code comment.

| Seller | Live from | What changed |
|---|---|---|
| Market report (producer.dfmi.app) | 5:40 PM | The library, and recovery of missing orders is switched on (`recover`, mode `deliver`). This is the only seller with automatic refunds, so the refund fix (problem 1) matters here. Its payment address is used by no other seller. |
| Wrapper (wrap.dfmi.app) | 5:54 PM | The library only. It uses the delivery callback, so problem 4 applied to it. |
| Storefront (shop.dfmi.app), summarizer (summarize.dfmi.app), wangvc.dfmi.app | 5:55 PM | The library only. None of them pays refunds. |

Recovery stays off for the other sellers. The summarizer and the wrapper share one payment address, and wangvc.dfmi.app sells three resources on one address. A payment found on chain could therefore belong to a different seller, or match more than one product.

**How it was deployed.**
- Before each seller, we checked that its running library was byte-for-byte the version the reviewer tested.
- Its order database and library were backed up first.
- After the restart, the old version can be put back from that backup.

**Checked afterwards.**
- All sellers are online with clean logs.
- `verify-payments.mjs` (read-only) against production: all 6 paid endpoints answer `402` with complete payment requirements, and the monitor and backup checks pass (12 of 12; the rate-limit burst was skipped on that run, after a full run of 13 of 13 right after the market report seller was deployed).
- On the market report seller, the first recovery pass started from its newest order. It scanned up to the current block and rebuilt nothing: all of its orders were already known, and no older payment was touched.

**Not shown on production yet.**
- No order has been refunded since the deployment, so the new "look on chain before refunding" step has run only in the drills.
- No order has been missing, so recovery has rebuilt nothing on production.
- Both are covered by drills 9–12 and by the reviewer's restore script.

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

**Mail server capacity (isolated, 26 November).**
- Setup:
  - One Node process on loopback.
  - The object store is in memory, with S3-like latency added (GET 20 ms, LIST 40 ms, PUT 30 ms, ±30%). SES is a stub.
  - Each message is 5.3 KB, the production median.
  - `N` is the number of messages under `raw/`. Production had 35.
  - Run it with `walletmail/test/capacity.mjs`.
- Inbox load times:

  | N | one inbox, before | one inbox, after (cold cache) | 10 users at once, before | 10 users at once, after (warm cache) |
  |---|---|---|---|---|
  | 35 | 1.1 s | 0.5 s | 1.1 s | 0.3 s |
  | 300 | 6.7 s | 1.3 s | 6.5 s | 0.4 s |
  | 1,000 | 21.0 s | 3.3 s | 20.9 s | 0.7 s |
  | 3,000 | 62.5 s | 9.1 s | 61.6 s | 1.5 s |

- Other results:
  - A cold inbox still reads every message once, so after a restart the first read grows with total mail. A per-recipient index would remove that; it is not built.
  - At every N:
    - session checks ran at about 1,240 requests per second (p99 52 ms, 0 errors);
    - 100 concurrent external sends all succeeded, with exactly 100 SES calls.
- **Known limit: attachments are held in memory.**
  - 10 concurrent downloads of a 10 MB attachment raised the process from about 0.2–0.3 GB to 0.7–0.8 GB.
  - The mail host has 0.9 GB of RAM, so large attachments under concurrency are the first thing that would fail.
  - Streaming attachments is not built.
- Production measurement: a real S3 read costs about 2.5× the model per message, so these numbers are a lower bound.

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
