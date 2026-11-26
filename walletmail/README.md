# walletmail: the mail and sign-in server

This is the API behind **email.dfmi.me**. It also handles sign-in for **identity.dfmi.app**: wallet signatures, passkeys and sessions.
It is published so that sign-in, sign-out and session recovery after a restore can be checked independently.

This local remediation is based on the published `10cc772` source. It includes review fixes and is **not** proof of a production deployment. The published baseline changed these configuration defaults:
- no built-in contract addresses: `ENS_REGISTRY` and `ENS_RESOLVER` are empty unless set;
- no built-in address-to-name mapping: `KNOWN_ENS_MAPPINGS`;
- the names checked at startup come from `ENS_BOOTSTRAP_NAMES`.

The top of the file says the same.

## Running the tests

### Outbox retry and persistence regressions

From `walletmail/test`, run `node outbox.mjs ../server.js` and
`node outbox-sdk.mjs ../server.js`. The latter keeps the real SES SDK middleware
and replaces only HTTP transport; even `AWS_MAX_ATTEMPTS=5` must not cause a
second submission after a lost response or 5xx. S3 and SES are local fixtures.

The SES client explicitly uses `maxAttempts: 1`. If SES accepts a message but
all three attempts to persist its `sent` outbox state fail, the API returns 503
with `accepted: true`, `deliveryMayHaveOccurred: true`, `persistenceUnknown: true`
and the message ID, rather than ordinary success. The response state is `unknown`:
the durable record stays `pending` if writes did not commit, or may be `sent` if
a storage response was lost. Retries with that ID never submit again, including
after restart; a saved `sent` result repairs history. Do not generate a new ID and
resend. Pending outcomes still require reconciliation; this patch does not
claim eventual delivery or automatic repair of an ambiguous outcome.

Requires Node.js 22 or newer and `openssl`. Everything runs on your machine. AWS S3 and SES are replaced by a local
file (`test/s3stub.cjs`), and nothing is sent to dfmi's servers.

```bash
cd walletmail && npm install && cd test
openssl req -x509 -newkey rsa:2048 -nodes -keyout rpc.key -out rpc.crt -days 2 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1
curl -so identity.html https://identity.dfmi.app/ && curl -so keylogin.js https://identity.dfmi.app/keylogin.js
node restore.mjs ../server.js
node run.mjs ../server.js
node passkey.mjs ../server.js
node tls.mjs ../server.js
node identity-e2e.mjs ../server.js
node durability.mjs ../server.js
node mail-restore.mjs ../server.js
```

Each test prints one `PASS` or `FAIL` line per check, ends with `all passed` or `N FAILED`, and exits 0 only if every
check passed.

| Test | Checks | What it shows |
|---|---|---|
| `restore.mjs` | 11 | **Session recovery after a restore.** Sessions, "sign out on all devices" markers and passkeys live only in the object store. Two cases are tested. (A) The server is rebuilt on the same store: a signed-out session stays refused, "sign out on all devices" still holds, and a session that was never signed out keeps working. (B) The store is rolled back to a backup taken before some sign-outs. Without the restore step, the signed-out sessions come back; the test shows this on purpose. With `SESSIONS_NOT_BEFORE` set to the restore time, every session issued before it is refused, a fresh sign-in works and keeps working across restarts, and a malformed value stops the server rather than being ignored. |
| `run.mjs` | 14 | Sign out and "sign out on all devices" revoke sessions, also across a restart. If the object store is down, the server refuses rather than trusting a session it cannot check. |
| `passkey.mjs` | 25 | Passkeys are verified by the server, using a software authenticator that produces real WebAuthn responses. Registration and sign-in work. Replays, forged signatures, the wrong origin or RP ID, and a counter that goes back (a cloned authenticator) are refused. A removed passkey no longer signs in. |
| `tls.mjs` | 3 | The server verifies the chain RPC's TLS certificate. An RPC with an untrusted certificate gets nothing; a trusted one works. |
| `identity-e2e.mjs` | 12 | The live identity.dfmi.app page (in jsdom) against this server, with a software authenticator. Key sign-in, then registering a passkey, then signing out, then signing in with the passkey. Sign out ends the session on the server, and leaves no token in storage and no key in memory. A forged passkey response is refused. |
| `durability.mjs` | 49 | Restores a local snapshot containing a later-deleted passkey, verifies the restore fence on both passkey login paths, exercises wallet-authorized re-enrollment and ownership, and injects failed writes/deletes for passkeys, sessions, prepared messages, content, sent history, contacts and mail state. Warm sessions and a second server process must respect persistent revocation. AWS and outgoing email are replaced by a local fixture. |
| `mail-restore.mjs` | 58 | Restores a complete local object snapshot after deleting content and damaging a MIME object. Exercises all seven listing prefixes beyond one page, cold message details, read/star/deletion state, binary and Unicode-named attachments, cross-wallet isolation, spoofed MIME From headers and self-claimed aliases, deletion-linked attachments, storage faults and a second restart. |

## Mail details and attachments

Mailbox list responses keep their existing `{ emails, count }` format. The server follows every S3 continuation token for raw mail, per-wallet incoming mail, content, sent history and read/star/deleted state before returning success. A storage read error or missing/repeated cursor returns an error instead of a partial successful mailbox. Invalid non-mail objects are still skipped; object manifests and checksums are required when validating a cloud restore.

`GET /api/messages/:messageId` reads persistent content, the caller's sent history, or an authorized MIME object on each request. It works without a warmed cache after restore. Content is visible to its sender or addressed recipient. Raw MIME objects require the caller to appear in To/Cc; a claimed From header is not authorization. Deleted mail is unavailable through both detail and attachment endpoints. A raw message's `X-WalletMail-Id` deletion marker is also respected. Wallet-specific incoming prefixes never grant another wallet access.

Mail access uses wallet addresses and a separate trusted name mapping populated only by operator configuration or successful ENS resolver responses. Login-form `ensName` values and stored display metadata cannot grant mail access. Wallet-shaped local parts are reserved for their wallet address. The local tests exercise configured name ownership; real chain name transfers and the freshness of resolver-derived mappings require separate acceptance.

MIME inbox entries and details expose `attachments: [{ index, filename, contentType, size, downloadUrl }]`. Use the listed message `id` and attachment URL, not the optional MIME Message-ID. To download, fetch `downloadUrl` with the same `Authorization: Bearer <session>` header as other mail APIs. Do not put tokens in URLs. The endpoint `GET /api/messages/:messageId/attachments/:index` returns the original decoded bytes with `Content-Disposition: attachment`, binary content type, `nosniff`, a restrictive CSP and private/no-store caching. UTF-8 filenames are encoded in the disposition header. Internal JSON content has no attachment upload feature and reports an empty attachment array in details.

This backend supplies authenticated attachment metadata and download endpoints; the separately hosted mail UI still needs to consume them. The current compatibility API scans complete prefixes and returns the full mailbox, with MIME attachments parsed in memory. Per-wallet indexing, streaming/size limits and production-scale capacity need separate measurement; this local drill does not establish a production SLO or real AWS restore.

## The restore step

After session state is restored from any copy (an object version, the replica bucket, or a backup), the operator:
1. sets `SESSIONS_NOT_BEFORE` to the restore time (ISO 8601, or milliseconds since the epoch) in the service environment;
2. restarts the server;
3. checks every instance before reopening traffic: a session from before the restore gets `401` from `/api/session`, and a fresh wallet-signature sign-in works;
4. verifies that pre-restore passkeys cannot sign in, including discoverable sign-in without an address. A backup can contain a credential that was deleted later. Every credential whose `createdAt` is at or before the fence, or has a missing/invalid `createdAt`, is refused;
5. has users sign in with their wallet signature and re-enroll their passkeys. A wallet-authenticated session can re-register its own pre-restore credential or register a new one; a passkey-authenticated session cannot re-enroll credentials;
6. retains `SESSIONS_NOT_BEFORE` in the persistent service configuration on every restart and redeploy. Do not clear it while old sessions or credentials can still be present or restored. Test old tokens and removed credentials again after a second restart, and confirm re-enrolled passkeys still work.

All servers must be stopped or gated while restoring the store and applying the fence. Setting the variable on one instance does not fence another running instance.

Everyone signs in again using a wallet signature and re-enrolls passkeys. The fence deliberately disables **all** pre-restore passkeys, including ones that were never removed: a rolled-back store cannot tell which credentials were removed after that backup. Login updates to `lastUsedAt` or signature counters cannot make an old credential new again.

Storage writes must finish before a success response or a cache update. Logout returns an error if the persistent delete fails; the caller must not assume the token is revoked until a successful retry. Authentication checks authoritative session and per-address revocation records on every request, including warm sessions on another process. This increases storage reads and needs capacity validation before deployment.

External sending crosses two services and is not an atomic transaction: SES may accept a message before persisting its outbox outcome or sent-history object fails. The endpoint returns an error with `deliveryMayHaveOccurred: true` in that case. Do not automatically resend it with a new ID. A saved `sent` outbox result allows the same ID to repair sent history without submitting again; a `pending` result stays blocked and requires reconciliation. The SDK's automatic retries are disabled for SES. Real delivery, reconciliation and outbox rollback during recovery still require an isolated cloud drill.

The fault-injection regression writes disposable data in a unique `durability-*` directory. Use no real AWS credentials. The local fixture does not prove AWS versioning, replication, backups, IAM/KMS access, RPO/RTO, or that production operators execute this procedure.

`restore.mjs` tests this mechanism. That the operator really performs the step after a real restore can't be checked from
outside. The status of the most recent restore drill of the payment services is public at <https://dfmi.app/status.json>.


## Durable outbox journal (local fixes based on 1fe4632)

Configure `SES_EVENTS_BUCKET` and `SES_CONFIGURATION_SET` together. The events
bucket must differ from `S3_INCOMING_BUCKET` and must not be rolled back with it.
Before SES is called, an atomic conditional write reserves the message ID in
`journal/<wallet>/<base64url-id>.json`, including the original content fingerprint.
The journal is authoritative; mail-bucket outbox records and sent history are
repairable copies. Keep journal entries and `resolutions/` for at least as long
as message IDs can be retried. Deleting or rolling back these records destroys
that protection. Restrict their write/delete permissions to the mail service
and authorized operators; enable versioning and retain their recovery evidence.

A retry reads the journal and independently retained closures before sending.
An empty event index is never proof of nonacceptance. Healthy canary probes do
not change this: `outbox-ops resolve --as not-sent` is refused. Unknown outcomes
can be left pending or closed as `undeterminable`/`abandoned`. Only a definite
SES rejection persisted by the service is retryable. An abandoned closure stays
in effect even after the mail bucket is restored. Operators must not recreate
or replace IDs to bypass a closure.

The original fingerprint is retained across restoration. A different body,
subject, recipient or sender is rejected. A legacy message with only an SES
event and no trusted fingerprint is blocked instead of inventing sent history
from the retry payload. Identical retries against a journal-backed restored
message remain idempotent, including the second and subsequent retries.

### Upgrade and recovery

1. Stop or gate mail submission during upgrade or restore. Preserve the events
   bucket, journal, resolutions and their permissions independently of mail.
2. Back up the current mail state before upgrading. Existing outbox records with
   trusted fingerprints are imported lazily on retry; an old `failed` record is
   imported as nonretryable because it may have been authorized by the unsafe
   pre-upgrade operator rule. Events alone cannot reconstruct original bodies.
3. If restoring a backup made before the journal was introduced, set
   `OUTBOX_REQUIRE_EXISTING_JOURNAL=1` on every instance before reopening traffic.
   Setting `OUTBOX_RECONCILE_FROM` also enables this guard. Requests without a
   known journal or surviving outbox record stay blocked. Do not clear the guard
   until pre-upgrade send IDs have been independently accounted for; otherwise
   a lost legacy record cannot be distinguished from a new ID. This conservative
   guard can prevent new sends as well as unsafe retries.
4. Grant the service conditional read/write access to `journal/` and read/list
   access to `resolutions/`, plus the existing event-index permissions. Keep the
   events bucket outside the restore operation. Run local regressions first;
   then the owner must validate these permissions and the restore operation on
   isolated cloud resources before deploying. No cloud resources were changed
   by this local patch.
5. Verify that accepted messages, pending messages and abandoned closures still
   prevent a second submission after restart and rollback. Keep raw commands,
   job IDs, hashes and counts. A successful SES call is acceptance, not final
   delivery; delivery-delay and real-cloud evidence remain separate acceptance.

Run from `walletmail/test`:

```sh
node outbox-journal.mjs ../server.js ../tools/outbox-ops.mjs
node outbox-reconcile.mjs ../server.js ../tools/outbox-ops.mjs
node outbox.mjs ../server.js
node outbox-sdk.mjs ../server.js
```

All use local fixtures. The journal suite covers the five independently
reproduced failures plus concurrent claims, failed journal reads/writes,
accepted outcomes that fail to persist, definite rejections, legacy missing
fingerprints, retained closures and the legacy-restore guard.
