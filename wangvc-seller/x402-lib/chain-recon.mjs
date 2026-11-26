// chain-recon.mjs — the seller's own view of the chain, independent of the facilitator's memory.
//
//   const chain = makeChain({ rpc, token });
//   await chain.reconcile(order)  → { state: 'settled', tx, block }          THIS authorization was executed (original tx)
//                                 | { state: 'unsettled', final, reason }    proven NOT executed (from chain state);
//                                                                            final = it can never execute any more
//                                 throws whenever the answer cannot be proven → the caller keeps the order (UNKNOWN)
//   await chain.verifyRefund({ tx, to, minAmount, notBefore, allowedFrom }) → { ok, block, amount, from } | { pending } | { unknown } | { ok:false, reason }
//
// Principles (review 2026-11-24):
//   • "not charged" is never inferred from a log scan coming up empty: it needs chain STATE — the session key's nonce not
//     consumed in the same grant generation, or EIP-3009 authorizationState(from, nonce) == false. Consumed-but-not-found
//     is UNKNOWN, never "unsettled".
//   • "settled" needs the executed call itself: a transaction sent straight to the wallet (pay) or the token
//     (transferWithAuthorization) whose decoded arguments equal the authorization, plus its event in the same receipt.
//     Anything else (batch / proxy calls, different signature bytes) is UNKNOWN.
//   • every RPC failure, null or malformed answer is an error, never a default.
// Plain JSON-RPC over fetch (no ethers: not every seller ships it). eth_getLogs in chunks (prod caps ranges at 10,000 blocks).

import { createHash } from 'node:crypto';

export const TOPIC = {
  PAID_V1: '0x26c4308021cef5cdbc618fee8b61faf9de6b8f7e4e49fac43869dc1a26756408',          // Paid(address,address,uint256,uint256)
  PAID_INTENT: '0x0c079195cbb1a7b3942e131f7ec160662a02811eb1217a8f04696682d8c3790f',      // Paid(address,address,uint256,uint256,uint8)
  AUTH_USED: '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5',        // AuthorizationUsed(address,bytes32)
  TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',         // Transfer(address,address,uint256)
};
const SEL = { pay: '6ad9f49f', twa: 'e3ee160e', sessionNonce: '6d0ae046', sessionGeneration: 'cd39960b', authorizationState: 'e94a0102' };
const lc = (x) => String(x ?? '').toLowerCase();
const strip = (h) => lc(h).replace(/^0x/, '');
const pad = (addr) => '0x' + strip(addr).padStart(64, '0');
const word = (hex, i) => BigInt('0x' + (strip(hex).slice(i * 64, i * 64 + 64) || '0'));
const addrWord = (hex, i) => '0x' + strip(hex).slice(i * 64 + 24, i * 64 + 64);
const hexNum = (h, what) => { if (typeof h !== 'string' || !/^0x[0-9a-f]+$/i.test(h)) throw new Error(`malformed ${what}: ${JSON.stringify(h)}`); return Number(BigInt(h)); };
const sameAddr = (a, b) => strip(a).padStart(40, '0') === strip(b).padStart(40, '0');

/** decode pay(address,address,uint256,uint256,uint256,bytes) calldata */
function decodePay(input) {
  const d = strip(input); if (!d.startsWith(SEL.pay)) return null;
  const a = d.slice(8);
  const off = Number(word(a, 5)) / 32; const len = Number(word(a, off));
  return { sessionKey: addrWord(a, 0), to: addrWord(a, 1), amount: word(a, 2), nonce: word(a, 3), deadline: word(a, 4), signature: a.slice((off + 1) * 64, (off + 1) * 64 + len * 2) };
}
/** decode transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) calldata */
function decodeTwa(input) {
  const d = strip(input); if (!d.startsWith(SEL.twa)) return null;
  const a = d.slice(8);
  return { from: addrWord(a, 0), to: addrWord(a, 1), value: word(a, 2), validAfter: word(a, 3), validBefore: word(a, 4), nonce: '0x' + a.slice(5 * 64, 6 * 64),
    v: Number(word(a, 6)), r: a.slice(7 * 64, 8 * 64), s: a.slice(8 * 64, 9 * 64) };
}

/** The tag an automatic refund carries after its calldata: 32 bytes that name the order it pays (dUSD ignores them). */
export const refundTag = (orderId) => createHash('sha256').update(`dfmi-refund:${orderId}`).digest('hex');

export function makeChain({ rpc, token, chunk = 9000, timeoutMs = 15_000, insecure = false } = {}) {
  if (!rpc || !token) throw new Error('chain-recon: rpc and token are required');
  if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed local node only (same switch as dfmi.json "insecure")
  let id = 0;
  async function call(method, params = []) {
    const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`${method}: RPC HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
    if (!j || typeof j !== 'object' || !('result' in j)) throw new Error(`${method}: malformed JSON-RPC response`);
    return j.result;
  }
  const blockNumber = async () => hexNum(await call('eth_blockNumber'), 'block number');
  async function blockTs(n) {
    const b = await call('eth_getBlockByNumber', ['0x' + n.toString(16), false]);
    if (!b) throw new Error(`block ${n} not available`);
    return hexNum(b.timestamp, 'block timestamp');
  }
  async function head() { const n = await blockNumber(); return { n, ts: await blockTs(n) }; }
  /** last block with timestamp <= ts (binary search over headers: exact, whatever the block times were) */
  async function blockAtOrBefore(ts, latest) {
    let lo = 0, hi = latest;
    if ((await blockTs(0)) > ts) return 0;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if ((await blockTs(mid)) <= ts) lo = mid; else hi = mid - 1; }
    return lo;
  }
  async function logs(filter, from, to) {
    const out = [];
    for (let a = from; a <= to; a += chunk) {
      const part = await call('eth_getLogs', [{ ...filter, fromBlock: '0x' + a.toString(16), toBlock: '0x' + Math.min(to, a + chunk - 1).toString(16) }]);
      if (!Array.isArray(part)) throw new Error('eth_getLogs: malformed result');
      out.push(...part);
    }
    return out;
  }
  async function ethCall(to, data) {
    const r = await call('eth_call', [{ to, data: '0x' + data }, 'latest']);
    if (typeof r !== 'string' || !/^0x[0-9a-f]{64,}$/i.test(r)) throw new Error(`eth_call ${data.slice(0, 8)}: malformed result ${JSON.stringify(r)}`);
    return BigInt(r.slice(0, 66));
  }
  const receiptOk = (rc) => rc && hexNum(rc.status, 'receipt status') === 1;

  async function reconcile(order) {
    const { paymentPayload: pp, paymentRequirements: req } = typeof order.payment === 'string' ? JSON.parse(order.payment) : order.payment;
    const { n: latest, ts: now } = await head();
    const created = Math.floor(Date.parse(order.created_at || '') / 1000) || now;
    if (pp.scheme === 'dfmi-session') {
      const p = pp.payload, a = p.authorization;
      // the tx can only be on chain after the authorization could first execute: scan from well before the order
      const from = await blockAtOrBefore(Math.min(created, Number(a.deadline)) - 7 * 86400, latest); // facilitator caps deadlines at 900 s; 7 days covers foreign relays
      let ambiguous = null;
      for (const t0 of [TOPIC.PAID_V1, TOPIC.PAID_INTENT]) {
        for (const l of await logs({ address: p.wallet, topics: [t0, pad(p.sessionKey), pad(a.to)] }, from, latest)) {
          if (word(l.data, 0) !== BigInt(a.amount) || word(l.data, 1) !== BigInt(a.nonce)) continue;
          const tx = await call('eth_getTransactionByHash', [l.transactionHash]);
          if (!tx) throw new Error(`tx ${l.transactionHash} of a matching Paid event is not available`);
          const d = sameAddr(tx.to, p.wallet) ? decodePay(tx.input) : null;
          const fieldsMatch = d && sameAddr(d.sessionKey, p.sessionKey) && sameAddr(d.to, a.to) && d.amount === BigInt(a.amount) && d.nonce === BigInt(a.nonce) && d.deadline === BigInt(a.deadline);
          if (!fieldsMatch) { ambiguous = `Paid event ${l.transactionHash} not from a direct pay() call with these fields`; continue; }
          if (d.signature !== strip(p.signature)) { ambiguous = `pay() ${l.transactionHash} carries other signature bytes for the same fields`; continue; }
          const rc = await call('eth_getTransactionReceipt', [l.transactionHash]);
          if (!receiptOk(rc)) continue;
          if (!rc.logs.some((x) => sameAddr(x.address, p.wallet) && x.logIndex === l.logIndex)) throw new Error(`receipt of ${l.transactionHash} does not contain the event`);
          return { state: 'settled', tx: l.transactionHash, block: hexNum(l.blockNumber, 'log block') };
        }
      }
      // not found as an executed call: prove from STATE that this authorization was not consumed
      const nonce = await ethCall(p.wallet, SEL.sessionNonce + strip(p.sessionKey).padStart(64, '0'));
      if (a.generation !== undefined) {
        const gen = await ethCall(p.wallet, SEL.sessionGeneration + strip(p.sessionKey).padStart(64, '0'));
        if (gen !== BigInt(a.generation)) throw new Error(`grant generation moved ${a.generation} → ${gen}: the authorization can no longer execute, but whether it did before cannot be proven from state${ambiguous ? '; ' + ambiguous : ''}`);
      }
      if (nonce > BigInt(a.nonce)) throw new Error(`nonce ${a.nonce} is consumed on chain but its transaction was not identified${ambiguous ? ': ' + ambiguous : ''}`);
      if (ambiguous) throw new Error(ambiguous);
      const final = now > Number(a.deadline);
      return { state: 'unsettled', final, reason: final ? `not executed (nonce ${a.nonce} unused) and the deadline has passed` : `not executed yet (nonce ${a.nonce} unused, deadline not passed)` };
    }
    const a = pp.payload.authorization; const tok = req?.asset || token;
    const from = await blockAtOrBefore(Math.min(created, Number(a.validAfter || created)) - 900, latest);
    for (const l of await logs({ address: tok, topics: [TOPIC.AUTH_USED, pad(a.from), lc(a.nonce)] }, from, latest)) {
      const tx = await call('eth_getTransactionByHash', [l.transactionHash]);
      if (!tx) throw new Error(`tx ${l.transactionHash} of an AuthorizationUsed event is not available`);
      const d = sameAddr(tx.to, tok) ? decodeTwa(tx.input) : null;
      if (!d) throw new Error(`authorization ${a.nonce} was consumed by ${l.transactionHash}, not a direct transferWithAuthorization call`);
      const rc = await call('eth_getTransactionReceipt', [l.transactionHash]);
      if (!receiptOk(rc)) continue;
      const ours = sameAddr(d.from, a.from) && sameAddr(d.to, a.to) && d.value === BigInt(a.value) && d.validAfter === BigInt(a.validAfter) && d.validBefore === BigInt(a.validBefore) && lc(d.nonce) === lc(a.nonce);
      // (from, nonce) executes once: a DIFFERENT authorization with the same nonce consumed it → ours can never execute
      if (!ours) return { state: 'unsettled', final: true, reason: `nonce consumed by a different authorization (${l.transactionHash}); this one can never execute` };
      return { state: 'settled', tx: l.transactionHash, block: hexNum(l.blockNumber, 'log block') };
    }
    const used = await ethCall(tok, SEL.authorizationState + strip(a.from).padStart(64, '0') + strip(a.nonce).padStart(64, '0'));
    if (used !== 0n) throw new Error('authorization is used on chain but its transaction was not identified in the scanned range');
    const final = now > Number(a.validBefore);
    return { state: 'unsettled', final, reason: final ? 'not executed (authorizationState false) and validBefore has passed' : 'not executed yet (authorizationState false, still valid)' };
  }

  /**
   * A refund is proven by ONE dUSD Transfer to the payer of at least the owed amount, in a mined, successful tx,
   * in a block no older than `notBefore` (when the order became refundable) and, if given, from an allowed sender.
   */
  async function verifyRefund({ tx, to, minAmount, notBefore = 0, allowedFrom = null }) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(tx))) return { ok: false, reason: 'not a tx hash' };
    const rc = await call('eth_getTransactionReceipt', [tx]);
    if (!rc) {
      const known = await call('eth_getTransactionByHash', [tx]);
      return known ? { ok: false, pending: true, reason: 'not mined (yet)' } : { ok: false, unknown: true, reason: 'unknown transaction (not on chain, not pending)' };
    }
    if (hexNum(rc.status, 'receipt status') !== 1) return { ok: false, reverted: true, reason: 'transaction reverted' };
    const block = hexNum(rc.blockNumber, 'receipt block');
    const ts = await blockTs(block);
    if (ts < notBefore) return { ok: false, reason: `transfer is older (block ${block}) than the refund obligation` };
    const hits = rc.logs.filter((x) => sameAddr(x.address, token) && x.topics[0] === TOPIC.TRANSFER && lc(x.topics[2]) === pad(to) && word(x.data, 0) >= BigInt(minAmount));
    if (!hits.length) return { ok: false, reason: `no single dUSD transfer of at least ${minAmount} to ${to} in this transaction` };
    const sender = '0x' + strip(hits[0].topics[1]).slice(24);
    if (allowedFrom && allowedFrom.length && !allowedFrom.some((a) => sameAddr(a, sender))) return { ok: false, reason: `sender ${sender} is not an allowed refund source` };
    return { ok: true, block, amount: String(word(hits[0].data, 0)), from: sender };
  }

  /** a dUSD transfer from → to of at least minAmount since time `sinceTs` (used before replacing a vanished refund) */
  async function findTransfer({ from, to, minAmount, sinceTs }) {
    const latest = await blockNumber();
    const start = await blockAtOrBefore(sinceTs - 900, latest);
    for (const l of await logs({ address: token, topics: [TOPIC.TRANSFER, pad(from), pad(to)] }, start, latest)) {
      if (word(l.data, 0) >= BigInt(minAmount)) return { tx: lc(l.transactionHash), block: hexNum(l.blockNumber, 'log block') };
    }
    return null;
  }

  /**
   * Has this order already been refunded on chain? Looked up BEFORE an automatic refund is paid, so that a restored or
   * stale 'refund_due' row can never pay a second time. Scans dUSD transfers to the payer from the given senders since
   * sinceTs: a transfer whose calldata carries this order's tag → { tagged }; transfers without any tag (refunds paid
   * before tagging, or by an operator) that no other order has recorded → { untagged: [...] }. Throws when the chain
   * cannot be read: the caller then pays nothing.
   */
  async function findRefund({ froms, to, minAmount, sinceTs, tag, isKnownRefund = () => false }) {
    const latest = await blockNumber();
    const start = await blockAtOrBefore(sinceTs - 900, latest);
    const untagged = [];
    for (const from of froms) {
      for (const l of await logs({ address: token, topics: [TOPIC.TRANSFER, pad(from), pad(to)] }, start, latest)) {
        if (word(l.data, 0) < BigInt(minAmount)) continue;
        const txh = lc(l.transactionHash);
        const tx = await call('eth_getTransactionByHash', [txh]);
        if (!tx) throw new Error(`refund lookup: tx ${txh} not available`);
        const input = strip(tx.input);
        const extra = input.startsWith('a9059cbb') ? input.slice(8 + 128) : '';
        const found = { tx: txh, block: hexNum(l.blockNumber, 'log block'), from: '0x' + strip(l.topics[1]).slice(24) };
        if (extra === tag) return { tagged: found };
        if (!extra && !isKnownRefund(txh)) untagged.push(found);
      }
    }
    return { untagged };
  }

  /**
   * Payments to `payTo` on chain in [fromBlock, toBlock], each rebuilt into the x402 payment payload(s) the buyer may
   * have sent. Used after a restore to recover orders the backup does not have. Only direct transferWithAuthorization
   * calls on the token and direct pay() calls on a session wallet are recognised; anything else is skipped.
   * A session payload's 'generation' is not in the calldata, so both forms are returned (with the generation the
   * wallet reports, and without the field): callers index the order under every candidate.
   */
  async function scanPayments({ payTo, network, fromBlock, toBlock }) {
    const out = [], seen = new Set();
    for (const l of await logs({ address: token, topics: [TOPIC.TRANSFER, null, pad(payTo)] }, fromBlock, toBlock)) {
      const txh = lc(l.transactionHash); if (seen.has(txh)) continue; seen.add(txh);
      const tx = await call('eth_getTransactionByHash', [txh]);
      if (!tx) throw new Error(`payment scan: tx ${txh} not available`);
      const rc = await call('eth_getTransactionReceipt', [txh]);
      if (!receiptOk(rc)) continue;
      const block = hexNum(l.blockNumber, 'log block');
      const t = sameAddr(tx.to, token) ? decodeTwa(tx.input) : null;
      if (t && sameAddr(t.to, payTo)) {
        const authorization = { from: t.from, to: t.to, value: String(t.value), validAfter: String(t.validAfter), validBefore: String(t.validBefore), nonce: t.nonce };
        const signature = '0x' + t.r + t.s + t.v.toString(16).padStart(2, '0');
        out.push({ tx: txh, block, payer: t.from, amount: String(t.value), candidates: [{ x402Version: 1, scheme: 'exact', network, payload: { signature, authorization } }] });
        continue;
      }
      const d = decodePay(tx.input);
      if (d && sameAddr(d.to, payTo)) {
        const wallet = lc(tx.to);
        const auth = { to: d.to, amount: String(d.amount), nonce: String(d.nonce), deadline: String(d.deadline) };
        const base = { wallet, sessionKey: d.sessionKey, signature: '0x' + d.signature };
        const candidates = [];
        let gen = null;
        try { gen = await ethCall(wallet, SEL.sessionGeneration + strip(d.sessionKey).padStart(64, '0')); } catch {}
        if (gen !== null) candidates.push({ x402Version: 1, scheme: 'dfmi-session', network, payload: { ...base, authorization: { ...auth, generation: String(gen) } } });
        candidates.push({ x402Version: 1, scheme: 'dfmi-session', network, payload: { ...base, authorization: auth } });
        out.push({ tx: txh, block, payer: wallet, amount: String(d.amount), candidates });
      }
    }
    return out;
  }

  const accountNonce = async (addr, tag = 'latest') => hexNum(await call('eth_getTransactionCount', [addr, tag]), 'account nonce');
  const sendRaw = (raw) => call('eth_sendRawTransaction', [raw]);
  return { call, reconcile, verifyRefund, findTransfer, findRefund, scanPayments, accountNonce, sendRaw, blockNumber, blockAtOrBefore, head };
}

/**
 * Optional automatic refunds from a seller hot wallet (REFUND_PRIVATE_KEY). Signs a dUSD transfer locally with a pinned
 * nonce so the caller can persist { tx, raw, nonce } BEFORE broadcasting: a crash can only lead to re-broadcasting the
 * same bytes. The wallet must be used by this one seller process only (no other sender may consume its nonces).
 * Needs ethers (loaded on demand).
 */
export async function makeRefunder({ chain, privateKey, token, chainId, gasPriceGwei = 1 }) {
  const { Wallet, Interface, keccak256 } = await import('ethers');
  const w = new Wallet(privateKey); const iface = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);
  return {
    address: w.address,
    /** tag (refundTag(orderId)) is appended to the calldata, so the chain itself shows which order a refund paid */
    async prepare(to, amount, minNonce = 0, tag = '') {
      const nonce = Math.max(await chain.accountNonce(w.address, 'pending'), minNonce);
      if (tag && !/^[0-9a-f]{64}$/.test(tag)) throw new Error('refund tag must be 32 bytes of hex');
      const raw = await w.signTransaction({ type: 0, chainId, nonce, to: token, data: iface.encodeFunctionData('transfer', [to, BigInt(amount)]) + tag, gasLimit: 100_000n, gasPrice: BigInt(Math.round(gasPriceGwei * 1e9)), value: 0n });
      return { tx: keccak256(raw).toLowerCase(), raw, nonce };
    },
    async broadcast(raw) { try { return await chain.sendRaw(raw); } catch (e) { if (/already known|known transaction|nonce too low|already imported/i.test(e.message)) return null; throw e; } },
  };
}
