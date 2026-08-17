#!/usr/bin/env node
/**
 * buy.mjs — x402 buyer / verification client (exact scheme / EVM; requires ethers, Node 18+)
 *
 * Full loop: GET resource → parse 402 payment requirements (v1 body / v2 header) → EIP-3009 offline signature
 *          → retry with payment header → verify delivery → decode settlement receipt → record to purchases.json
 *
 * Usage:
 *   node buy.mjs <resourceUrl>                    # buy (default safety cap $0.10)
 *   node buy.mjs <resourceUrl> --dry-run          # stop before signing; show what would be paid, do not pay
 *   node buy.mjs <resourceUrl> --max 0.50         # raise the price cap for this order (USD)
 *   node buy.mjs <resourceUrl> --allow-mainnet    # allow mainnet payment (default: testnet only)
 *   node buy.mjs <resourceUrl> --method POST      # POST-only endpoint
 *
 * Private key is read from ./.env: BUYER_PRIVATE_KEY=0x...   (never commit or share this file)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';

// ---------- network + USDC EIP-712 domain defaults (accepts.extra wins) ----------
const CHAINS = {
  'base':          { chainId: 8453,  mainnet: true,  domain: { name: 'USD Coin', version: '2' } },
  'base-sepolia':  { chainId: 84532, mainnet: false, domain: { name: 'USDC',     version: '2' } },
  'eip155:8453':   { chainId: 8453,  mainnet: true,  domain: { name: 'USD Coin', version: '2' } },
  'eip155:84532':  { chainId: 84532, mainnet: false, domain: { name: 'USDC',     version: '2' } },
};
// custom network extension: merge ./chains.json (auto-generated or hand-written) with the built-in table
try {
  const extra = JSON.parse(readFileSync(new URL('./chains.json', import.meta.url), 'utf8'));
  Object.assign(CHAINS, extra);
} catch { /* no network extension */ }

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

const log = (...a) => console.log(...a);
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = s => { try { return JSON.parse(Buffer.from(s, 'base64').toString()); } catch { return null; } };

// ---------- parse payment requirements: tolerate multiple protocol shapes ----------
// v1: 402 JSON body { x402Version, accepts: [...] }
// v2: 402 + PAYMENT-REQUIRED response header (base64 JSON: {accepts:[...]}, a single requirement, or an array)
function extractRequirements(res, bodyText) {
  const out = { version: 1, accepts: [], resource: null };
  let body = null;
  try { body = JSON.parse(bodyText); } catch {}
  if (body?.accepts?.length) { out.version = body.x402Version ?? 1; out.accepts = body.accepts; out.resource = body.resource ?? null; return out; }
  if (body?.paymentRequirements) { out.version = body.x402Version ?? 2; out.accepts = [].concat(body.paymentRequirements); out.resource = body.resource ?? null; return out; }
  for (const h of ['payment-required', 'x-payment-required']) {
    const raw = res.headers.get(h);
    if (!raw) continue;
    const dec = unb64(raw) ?? (() => { try { return JSON.parse(raw); } catch { return null; } })();
    if (!dec) continue;
    out.version = dec.x402Version ?? 2;
    out.accepts = dec.accepts ?? [].concat(dec.paymentRequirements ?? dec);
    out.resource = dec.resource ?? null;
    if (out.accepts.length) return out;
  }
  return out;
}

// field-name fallbacks (naming differs across versions / implementations)
const normalize = r => ({
  scheme: r.scheme ?? 'exact',
  network: r.network,
  maxAmountRequired: String(r.maxAmountRequired ?? r.amount ?? r.maxAmount ?? ''),
  payTo: r.payTo ?? r.recipient ?? r.to,
  asset: r.asset ?? r.token ?? r.currency,
  maxTimeoutSeconds: r.maxTimeoutSeconds ?? r.timeout ?? 300,
  extra: r.extra ?? r.assetDetails ?? null,
});

async function main() {
  const argv = process.argv.slice(2);
  const VALUED = new Set(['--max', '--method', '--timeout', '--save']);
  let url; const flags = new Set(); const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (VALUED.has(argv[i])) opts[argv[i]] = argv[++i];
    else if (argv[i].startsWith('--')) flags.add(argv[i]);
    else url ??= argv[i];
  }
  const flag = n => flags.has(n);
  const opt = (n, d) => opts[n] ?? d;
  if (!url) { console.error('Usage: node buy.mjs <resourceUrl> [--dry-run] [--max USD] [--allow-mainnet] [--method POST]'); return 1; }

  const envPath = new URL('./.env', import.meta.url);
  const env = existsSync(envPath)
    ? Object.fromEntries(readFileSync(envPath, 'utf8').split('\n').filter(l => l.includes('=')).map(l => l.split('=').map(s => s.trim())))
    : {};
  const pk = process.env.BUYER_PRIVATE_KEY ?? env.BUYER_PRIVATE_KEY;
  if (!pk) { console.error('Missing private key: set BUYER_PRIVATE_KEY=0x… in .env'); return 1; }
  const wallet = new Wallet(pk);
  const maxUsd = Number(opt('--max', '0.10'));
  const method = opt('--method', 'GET');

  // ---------- 1. first request to get the 402 payment requirements ----------
  log(`\n[1/4] Requesting ${url}`);
  const first = await fetch(url, { method, headers: { accept: 'application/json', 'user-agent': 'meta-bazaar-buy/0.2' }, signal: AbortSignal.timeout(15_000) });
  const firstBody = await first.text();
  if (first.status !== 402) {
    log(`  Endpoint returned ${first.status} (not 402) — free or not an x402 endpoint, stopping.`);
    return 2;
  }
  const { version, accepts, resource: resourceMeta } = extractRequirements(first, firstBody);
  if (!accepts.length) {
    console.error('  Could not parse payment requirements from the 402 response. Diagnostics:');
    console.error('  status:', first.status);
    console.error('  headers:', JSON.stringify(Object.fromEntries(first.headers.entries()), null, 2));
    console.error('  body[0:800]:', firstBody.slice(0, 800) || '(empty)');
    console.error('  → Share the diagnostics above to adapt to this endpoint protocol shape.');
    return 2;
  }

  // pick a requirement: exact + known network only; prefer testnet. Keep the raw object for v2 echo (accepted field)
  const candidates = accepts.map(raw => ({ raw, norm: normalize(raw) })).filter(c => c.norm.scheme === 'exact' && CHAINS[c.norm.network]);
  candidates.sort((a, b) => (CHAINS[a.norm.network].mainnet ? 1 : 0) - (CHAINS[b.norm.network].mainnet ? 1 : 0));
  const chosen = candidates[0];
  if (!chosen) { console.error('  No usable exact/EVM payment requirement. accepts:', JSON.stringify(accepts, null, 2)); return 2; }
  const req = chosen.norm;
  const chain = CHAINS[req.network];
  const priceUsd = Number(req.maxAmountRequired) / 1e6;
  const coin = req.extra?.name === 'DFMI Dollar' ? 'dUSD' : (req.extra?.name || 'coin'); // coin name comes from the quote, not hard-coded USDC

  log(`[2/4] Payment required (v${version}): ${priceUsd} ${coin} | network ${req.network} | payTo ${req.payTo}`);
  log(`      asset ${req.asset} | timeout ${req.maxTimeoutSeconds}s`);

  // ---------- safety gates ----------
  if (chain.mainnet && !flag('--allow-mainnet')) { console.error('  ✋ Mainnet payment is blocked by default; add --allow-mainnet to proceed.'); return 3; }
  if (!(priceUsd > 0) || priceUsd > maxUsd) { console.error(`  ✋ Price $${priceUsd} is invalid or above your limit $${maxUsd}; retry with --max ${priceUsd}.`); return 3; }

  // ---------- 2. EIP-3009 offline signature (sign the authorization only, no on-chain tx) ----------
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: wallet.address, to: req.payTo,
    value: String(req.maxAmountRequired),
    validAfter: String(now - 60),
    validBefore: String(now + (Number(req.maxTimeoutSeconds) || 300)),
    nonce: '0x' + randomBytes(32).toString('hex'),
  };
  const domain = {
    name: req.extra?.name ?? chain.domain.name,
    version: req.extra?.version ?? chain.domain.version,
    chainId: chain.chainId, verifyingContract: req.asset,
  };

  if (flag('--dry-run')) {
    log('[dry-run] Authorization that would be signed (not signed, not paid):');
    log(JSON.stringify({ domain, authorization }, null, 2));
    return 0;
  }

  const signature = await wallet.signTypedData(domain, EIP3009_TYPES, authorization);
  // v1 and v2 payment headers differ: v2 must echo the full accepted requirement object (with extra) and resource
  const payment = version >= 2
    ? { x402Version: version, resource: resourceMeta ?? { url }, accepted: chosen.raw,
        payload: { signature, authorization }, extensions: {} }
    : { x402Version: 1, scheme: 'exact', network: req.network, payload: { signature, authorization } };
  const paymentHeader = b64(payment);
  log(`[3/4] Signed offline (buyer ${wallet.address}); retrying with payment header…`);

  // ---------- 3. retry with payment (send both v1 and v2 headers; the server uses what it recognizes) ----------
  const t0 = Date.now();
  const paid = await fetch(url, {
    method,
    headers: { accept: 'application/json', 'user-agent': 'meta-bazaar-buy/0.2',
               'X-PAYMENT': paymentHeader, 'PAYMENT-SIGNATURE': paymentHeader },
    signal: AbortSignal.timeout(Number(opt('--timeout', 60)) * 1000), // use --timeout 180 for slow supply-chain / LLM generation
  });
  const latencyMs = Date.now() - t0;
  const bodyTextPaid = await paid.text();
  const settle = unb64(paid.headers.get('x-payment-response') ?? paid.headers.get('payment-response') ?? '');

  // ---------- 4. verify goods and record ----------
  const delivered = paid.status === 200 && bodyTextPaid.length > 0;
  log(`[4/4] Response ${paid.status} | ${latencyMs}ms | delivered ${delivered ? '✓' : '✗'} | settlement ${settle?.success ? '✓ tx ' + (settle.transaction ?? '?') : (settle ? JSON.stringify(settle) : 'no receipt header')}`);
  log(`      Body preview: ${bodyTextPaid.slice(0, 300).replace(/\s+/g, ' ')}${bodyTextPaid.length > 300 ? '…' : ''}`);
  if (!delivered) log('      Diagnostic headers:', JSON.stringify(Object.fromEntries(paid.headers.entries())).slice(0, 500));

  // --save <file>: write the full purchased goods to disk (otherwise only a 500-char preview goes to purchases.json)
  const savePath = opt('--save', null);
  if (savePath && delivered) {
    writeFileSync(savePath, bodyTextPaid);
    log(`      Saved goods → ${savePath} (${bodyTextPaid.length} bytes)`);
  }

  const record = {
    time: new Date().toISOString(), resource: url, network: req.network,
    priceUsd, payTo: req.payTo, buyer: wallet.address,
    httpStatus: paid.status, latencyMs, deliveredBytes: bodyTextPaid.length,
    verified_delivery: delivered && !!settle?.success,
    settlement: settle ?? null, bodyPreview: bodyTextPaid.slice(0, 500),
  };
  const logPath = new URL('./purchases.json', import.meta.url);
  const purchases = existsSync(logPath) ? JSON.parse(readFileSync(logPath, 'utf8')) : [];
  purchases.push(record);
  writeFileSync(logPath, JSON.stringify(purchases, null, 2));
  log(`\nRecorded to purchases.json (entry ${purchases.length}). verified_delivery = ${record.verified_delivery}`);
  return 0;
}

// use exitCode instead of process.exit() to avoid a libuv assert crash on Windows from unfinished undici handles
main().then(code => { process.exitCode = code; }).catch(e => { console.error(e); process.exitCode = 1; });
