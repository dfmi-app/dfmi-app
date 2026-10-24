/**
 * purchase.mjs — one buy attempt against the session budget (the glue between buy() and the budget).
 *
 * Reserve before signing; release only if the signature was never disclosed. If buyImpl throws at or after
 * signing, the throw propagates and the reservation is deliberately NOT resolved, so it stays committed —
 * the disclosed authorization may still settle.
 */
export async function purchase({ url, wallet, budget, maxPrice, allowMainnet = false, method, buyImpl }) {
  let reservation = null;
  const reserve = price => { reservation = budget.reserve(price); };
  const r = await buyImpl(url, wallet, { method, maxPrice, allowMainnet, reserve });
  budget.resolve(reservation, { disclosed: r.disclosed, paid: r.paid });
  return { ...r, pending: !!(r.disclosed && !r.paid) };
}
