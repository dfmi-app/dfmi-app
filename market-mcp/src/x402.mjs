/**
 * x402.mjs — buyer-side x402 "exact" scheme (EVM, EIP-3009). Adapted from dfmi-app/buyers/buy.mjs (MIT).
 *
 * quote(url)                → parses the 402 into usable requirements, never signs
 * buy(url, wallet, limits)  → 402 → offline EIP-3009 signature → paid retry → settlement receipt
 */
import { randomBytes } from 'node:crypto';

// Network → chainId + default EIP-712 domain of the asset (accepts[].extra wins when present).
export const CHAINS = {
  'eip155:112172': { chainId: 112172, mainnet: false, domain: { name: 'DFMI Dollar', version: '1' }, label: 'dfmi (dUSD points)' },
  'base-sepolia':  { chainId: 84532,  mainnet: false, domain: { name: 'USDC', version: '2' },        label: 'Base Sepolia (test USDC)' },
  'eip155:84532':  { chainId: 84532,  mainnet: false, domain: { name: 'USDC', version: '2' },        label: 'Base Sepolia (test USDC)' },
  'base':          { chainId: 8453,   mainnet: true,  domain: { name: 'USD Coin', version: '2' },    label: 'Base mainnet (USDC)' },
  'eip155:8453':   { chainId: 8453,   mainnet: true,  domain: { name: 'USD Coin', version: '2' },    label: 'Base mainnet (USDC)' },
};

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};
const UA = 'dfmi-market-mcp/0.1';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = s => { try { return JSON.parse(Buffer.from(s, 'base64').toString()); } catch { return null; } };

// v1: 402 JSON body { x402Version, accepts }; v2: PAYMENT-REQUIRED header (base64 JSON)
export function extractRequirements(headers, bodyText) {
  let body = null;
  try { body = JSON.parse(bodyText); } catch {}
  if (body?.accepts?.length) return { version: body.x402Version ?? 1, accepts: body.accepts, resource: body.resource ?? null };
  if (body?.paymentRequirements) return { version: body.x402Version ?? 2, accepts: [].concat(body.paymentRequirements), resource: body.resource ?? null };
  for (const h of ['payment-required', 'x-payment-required']) {
    const raw = headers.get(h);
    if (!raw) continue;
    const dec = unb64(raw) ?? (() => { try { return JSON.parse(raw); } catch { return null; } })();
    if (!dec) continue;
    const accepts = dec.accepts ?? [].concat(dec.paymentRequirements ?? dec);
    if (accepts.length) return { version: dec.x402Version ?? 2, accepts, resource: dec.resource ?? null };
  }
  return { version: 1, accepts: [], resource: null };
}

export const normalize = r => ({
  scheme: r.scheme ?? 'exact',
  network: r.network,
  amount: String(r.maxAmountRequired ?? r.amount ?? r.maxAmount ?? ''),
  payTo: r.payTo ?? r.recipient ?? r.to,
  asset: r.asset ?? r.token ?? r.currency,
  maxTimeoutSeconds: Number(r.maxTimeoutSeconds ?? r.timeout ?? 300),
  description: r.description ?? null,
  extra: r.extra ?? r.assetDetails ?? null,
});

const coinName = n => n.extra?.name === 'DFMI Dollar' ? 'dUSD' : (n.extra?.name ?? 'USDC');

/** Usable requirements, cheapest testnet first. Price assumes a 6-decimal stablecoin (dUSD, USDC). */
export function pickable(accepts, { allowMainnet = false } = {}) {
  return accepts
    .map(raw => ({ raw, n: normalize(raw) }))
    .filter(c => c.n.scheme === 'exact' && CHAINS[c.n.network] && (allowMainnet || !CHAINS[c.n.network].mainnet))
    .map(c => ({ ...c, price: Number(c.n.amount) / 1e6, coin: coinName(c.n) }))
    .sort((a, b) => (CHAINS[a.n.network].mainnet - CHAINS[b.n.network].mainnet) || (a.price - b.price));
}

async function first402(url, method) {
  const res = await fetch(url, { method, headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (res.status !== 402) return { status: res.status, preview: text.slice(0, 300) };
  return { status: 402, ...extractRequirements(res.headers, text) };
}

export async function quote(url, { method = 'GET', allowMainnet = false } = {}) {
  const q = await first402(url, method);
  if (q.status !== 402) return { payable: false, status: q.status, note: 'Not an x402 endpoint (did not answer 402).', preview: q.preview };
  const usable = pickable(q.accepts, { allowMainnet });
  return {
    payable: usable.length > 0,
    x402Version: q.version,
    options: q.accepts.map(raw => {
      const n = normalize(raw);
      return { network: n.network, networkLabel: CHAINS[n.network]?.label ?? 'unsupported network', price: Number(n.amount) / 1e6, coin: coinName(n), payTo: n.payTo, asset: n.asset, description: n.description, supported: usable.some(u => u.raw === raw) };
    }),
  };
}

/**
 * Pay for and fetch `url`. `limits.maxPrice` caps this call; `limits.reserve(price)` is called right before signing
 * and must throw to refuse (used for the session budget). Nothing is signed unless both pass.
 */
export async function buy(url, wallet, { method = 'GET', maxPrice = 0.10, allowMainnet = false, timeoutSec = 120, reserve = () => {} } = {}) {
  const q = await first402(url, method);
  if (q.status !== 402) return { paid: false, status: q.status, note: 'Not an x402 endpoint (did not answer 402); nothing paid.', preview: q.preview };
  const usable = pickable(q.accepts, { allowMainnet });
  if (!usable.length) throw new Error(`No supported payment option. Offered: ${JSON.stringify(q.accepts.map(a => a.network))}${allowMainnet ? '' : ' (mainnet disabled)'}`);
  const chosen = usable[0];
  if (!(chosen.price > 0)) throw new Error(`Invalid price ${chosen.n.amount}`);
  if (chosen.price > maxPrice) throw new Error(`Price ${chosen.price} ${chosen.coin} is above max_price ${maxPrice}. Raise max_price to buy.`);
  reserve(chosen.price);

  const { n } = chosen;
  const chain = CHAINS[n.network];
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: wallet.address, to: n.payTo, value: n.amount,
    validAfter: String(now - 60), validBefore: String(now + (n.maxTimeoutSeconds || 300)),
    nonce: '0x' + randomBytes(32).toString('hex'),
  };
  const domain = { name: n.extra?.name ?? chain.domain.name, version: n.extra?.version ?? chain.domain.version, chainId: chain.chainId, verifyingContract: n.asset };
  const signature = await wallet.signTypedData(domain, EIP3009_TYPES, authorization);
  const payment = q.version >= 2
    ? { x402Version: q.version, resource: q.resource ?? { url }, accepted: chosen.raw, payload: { signature, authorization }, extensions: {} }
    : { x402Version: 1, scheme: 'exact', network: n.network, payload: { signature, authorization } };
  const header = b64(payment);

  const t0 = Date.now();
  const res = await fetch(url, {
    method,
    headers: { accept: 'application/json', 'user-agent': UA, 'X-PAYMENT': header, 'PAYMENT-SIGNATURE': header },
    signal: AbortSignal.timeout(timeoutSec * 1000),
  });
  const body = await res.text();
  const settlement = unb64(res.headers.get('x-payment-response') ?? res.headers.get('payment-response') ?? '');
  return {
    paid: !!settlement?.success,
    delivered: res.status === 200 && body.length > 0,
    status: res.status, latencyMs: Date.now() - t0,
    price: chosen.price, coin: chosen.coin, network: n.network, payTo: n.payTo, buyer: wallet.address,
    settlement, body,
  };
}
