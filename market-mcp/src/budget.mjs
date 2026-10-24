/**
 * budget.mjs — per-session spend accounting for the market MCP.
 *
 * The rule that matters for safety: once a payment authorization (an EIP-3009 signature) has been DISCLOSED
 * to a seller, the reserved amount stays committed. A seller's response — success, failure, silence, timeout —
 * is not proof the authorization was not (or will not be) settled; the signature is a bearer instrument valid
 * until its deadline. Releasing budget on an untrusted response is exactly how repeated calls can authorize
 * more than the session budget. We only release a reservation that was never disclosed (e.g. signing refused
 * before the request, or the endpoint was not even x402).
 *
 * Over-reserving is the safe direction: it can only block further spend, never permit over-spend. Freeing a
 * disclosed-but-unsettled amount requires trustworthy reconciliation (on-chain proof the nonce was never used,
 * after the authorization's deadline) — not done here.
 */
export function createBudget(limit) {
  const EPS = 1e-9;
  let committed = 0; // settled OR disclosed-pending — not releasable on a seller's say-so

  return {
    get limit() { return limit; },
    get spent() { return committed; },
    remaining() { return Math.max(0, limit - committed); },

    /** Reserve `price` before signing. Throws (refuses) if it would exceed the budget. Returns a handle. */
    reserve(price) {
      if (!(price >= 0)) throw new Error(`invalid price ${price}`);
      if (committed + price > limit + EPS)
        throw new Error(`Session budget exhausted: committed ${committed.toFixed(4)} of ${limit}; this costs ${price}.`);
      committed += price;
      return { price, resolved: false };
    },

    /** Resolve a reservation after the attempt. Releases ONLY when the signature was never disclosed. */
    resolve(handle, { disclosed, paid } = {}) {
      if (!handle || handle.resolved) return;
      handle.resolved = true;
      if (paid) return;        // settled → stays committed
      if (disclosed) return;   // signature is out there → stays reserved (pending); may still settle
      committed -= handle.price; // never disclosed → safe to release
    },
  };
}
