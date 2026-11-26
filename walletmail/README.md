# walletmail: the mail and sign-in server

This is the API behind **email.dfmi.me**. It also handles sign-in for **identity.dfmi.app**: wallet signatures, passkeys and sessions.
It is published so that sign-in, sign-out and session recovery after a restore can be checked independently.

`server.js` is the deployed file with only configuration defaults changed:
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

## The restore step

After session state is restored from any copy (an object version, the replica bucket, or a backup), the operator:
1. sets `SESSIONS_NOT_BEFORE` to the restore time (ISO 8601, or milliseconds since the epoch) in the service environment;
2. restarts the server;
3. checks that a session from before the restore gets `401` from `/api/session`, and that a new sign-in works.

Everyone signs in again once. That is the cost of making sure that no signed-out session can come back.

`restore.mjs` tests this mechanism. That the operator really performs the step after a real restore can't be checked from
outside. The status of the most recent restore drill of the payment services is public at <https://dfmi.app/status.json>.
