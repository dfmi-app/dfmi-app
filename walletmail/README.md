# walletmail: the mail and sign-in server

This is the API behind **email.dfmi.me**. It also handles sign-in for **identity.dfmi.app**: wallet signatures, passkeys and sessions.
It is published so that sign-in, sign-out and session recovery after a restore can be checked independently.

This local remediation is based on the published `10cc772` source. It includes review fixes and is **not** proof of a production deployment. The published baseline changed these configuration defaults:
- no built-in contract addresses: `ENS_REGISTRY` and `ENS_RESOLVER` are empty unless set;
- no built-in address-to-name mapping: `KNOWN_ENS_MAPPINGS`;
- the names checked at startup come from `ENS_BOOTSTRAP_NAMES`.

The top of the file says the same.

## Running the tests

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

External sending crosses two services and is not an atomic transaction: SES may accept a message before persisting its sent-history object fails. The endpoint returns an error with `deliveryMayHaveOccurred: true` in that case. Do not automatically resend it on the basis of that error. Durable outbox/idempotent delivery is outside this patch; real SES behavior and the recovery runbook still require an isolated cloud drill.

The fault-injection regression writes disposable data in a unique `durability-*` directory. Use no real AWS credentials. The local fixture does not prove AWS versioning, replication, backups, IAM/KMS access, RPO/RTO, or that production operators execute this procedure.

`restore.mjs` tests this mechanism. That the operator really performs the step after a real restore can't be checked from
outside. The status of the most recent restore drill of the payment services is public at <https://dfmi.app/status.json>.
