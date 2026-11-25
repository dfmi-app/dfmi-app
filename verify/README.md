# Verify dfmi yourself

Two scripts check dfmi's sign-in and payments from the outside. They call only public endpoints and need no
account, no key and no access to our servers. You don't have to take our word for anything in
`LAUNCH-READINESS.md`; run them instead.

Requirements: Node.js 18 or newer.

```bash
cd verify
npm install
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

## Options

Both scripts take their endpoints as options:
- `verify-auth.mjs`: `--api`, `--origin`.
- `verify-payments.mjs`: `--facilitator`, `--resource`, `--rpc`, `--faucet`, `--status`.

They default to the production endpoints.
