// chain-recon.mjs — the seller's own view of the chain, independent of the facilitator's memory.
//
//   const chain = makeChain({ rpc, token });
//   await chain.reconcile(order)  → { state: 'settled', tx, block }                 the payment is on chain (original tx)
//                                 | { state: 'unsettled', final, reason }           not on chain; final = can never settle now
//                                 (throws when the chain cannot be read → the caller must treat the outcome as UNKNOWN)
//   await chain.verifyRefund({ tx, to, minAmount }) → { ok, block, amount, reason }  a dUSD Transfer to the payer, mined, status 1
//
// Plain JSON-RPC over fetch (no ethers): the sellers that need it do not all ship ethers. Event topics are constants.
// Log scans are chunked (the prod node rejects eth_getLogs ranges over 10,000 blocks) and start just before the order
// was created, so a recent order costs one or two calls.

export const TOPIC = {
  PAID_V1: '0x26c4308021cef5cdbc618fee8b61faf9de6b8f7e4e49fac43869dc1a26756408',          // Paid(address,address,uint256,uint256)
  PAID_INTENT: '0x0c079195cbb1a7b3942e131f7ec160662a02811eb1217a8f04696682d8c3790f',      // Paid(address,address,uint256,uint256,uint8)
  AUTH_USED: '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5',        // AuthorizationUsed(address,bytes32)
  TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',         // Transfer(address,address,uint256)
};
const pad = (addr) => '0x' + String(addr).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const word = (data, i) => BigInt('0x' + String(data).replace(/^0x/, '').slice(i * 64, i * 64 + 64));
const lc = (x) => String(x || '').toLowerCase();
const hexNum = (h) => Number(BigInt(h));

export function makeChain({ rpc, token, chunk = 9000, timeoutMs = 15_000, insecure = false } = {}) {
  if (!rpc || !token) throw new Error('chain-recon: rpc and token are required');
  if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed local node only (same switch as dfmi.json "insecure")
  let id = 0;
  async function call(method, params = []) {
    const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  }
  const blockNumber = async () => hexNum(await call('eth_blockNumber'));
  const block = (n) => call('eth_getBlockByNumber', ['0x' + n.toString(16), false]);
  async function logs(filter, from, to) {
    const out = [];
    for (let a = from; a <= to; a += chunk) out.push(...await call('eth_getLogs', [{ ...filter, fromBlock: '0x' + a.toString(16), toBlock: '0x' + Math.min(to, a + chunk - 1).toString(16) }]));
    return out;
  }
  /** first block worth scanning for a payment made around `createdAt` (ms); a little early is fine, late is not */
  async function startBlock(createdAt, latest, latestTs) {
    const back = Math.min(latest, 1000);
    const older = await block(latest - back);
    const bt = back ? Math.max(1, (latestTs - hexNum(older.timestamp)) / back) : 5;
    const secs = Math.max(0, latestTs - Math.floor((createdAt || Date.now()) / 1000)) + 15 * 60; // + margin: clock skew, slow inclusion
    return Math.max(0, latest - Math.ceil(secs / bt));
  }

  async function reconcile(order) {
    const { paymentPayload: pp, paymentRequirements: req } = typeof order.payment === 'string' ? JSON.parse(order.payment) : order.payment;
    const latest = await blockNumber(); const head = await block(latest); const now = hexNum(head.timestamp);
    const from = await startBlock(Date.parse(order.created_at || ''), latest, now);
    if (pp.scheme === 'dfmi-session') {
      const p = pp.payload, a = p.authorization;
      const sig = lc(p.signature).replace(/^0x/, '');
      for (const t0 of [TOPIC.PAID_V1, TOPIC.PAID_INTENT]) {
        for (const l of await logs({ address: p.wallet, topics: [t0, pad(p.sessionKey), pad(a.to)] }, from, latest)) {
          if (word(l.data, 0) !== BigInt(a.amount) || word(l.data, 1) !== BigInt(a.nonce)) continue;
          // the same (key, nonce) can recur after a v3 re-grant: only the tx that carried THIS signature is ours
          const tx = await call('eth_getTransactionByHash', [l.transactionHash]);
          if (!tx || !lc(tx.input).includes(sig)) continue;
          const rc = await call('eth_getTransactionReceipt', [l.transactionHash]);
          if (rc && hexNum(rc.status) === 1) return { state: 'settled', tx: l.transactionHash, block: hexNum(l.blockNumber) };
        }
      }
      const final = now > Number(a.deadline);
      return { state: 'unsettled', final, reason: final ? 'deadline passed and no settlement on chain' : 'not on chain yet (deadline not passed)' };
    }
    const a = pp.payload.authorization; const tok = req?.asset || token;
    for (const l of await logs({ address: tok, topics: [TOPIC.AUTH_USED, pad(a.from), lc(a.nonce)] }, from, latest)) {
      const rc = await call('eth_getTransactionReceipt', [l.transactionHash]);
      if (!rc || hexNum(rc.status) !== 1) continue;
      const moved = rc.logs.some((x) => lc(x.address) === lc(tok) && x.topics[0] === TOPIC.TRANSFER && lc(x.topics[1]) === pad(a.from) && lc(x.topics[2]) === pad(a.to) && word(x.data, 0) === BigInt(a.value));
      if (moved) return { state: 'settled', tx: l.transactionHash, block: hexNum(l.blockNumber) };
    }
    // used on chain but not found in the scanned window: do not guess
    const used = await call('eth_call', [{ to: tok, data: '0xe94a0102' + pad(a.from).slice(2) + lc(a.nonce).replace(/^0x/, '').padStart(64, '0') }, 'latest']).catch(() => null);
    if (used && BigInt(used) !== 0n) throw new Error('authorization is used on chain but its transaction was not found in the scanned range');
    const final = now > Number(a.validBefore);
    return { state: 'unsettled', final, reason: final ? 'validBefore passed and no settlement on chain' : 'not on chain yet (still valid)' };
  }

  async function verifyRefund({ tx, to, minAmount }) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(tx))) return { ok: false, reason: 'not a tx hash' };
    const rc = await call('eth_getTransactionReceipt', [tx]);
    if (!rc) {
      const known = await call('eth_getTransactionByHash', [tx]);
      return known ? { ok: false, pending: true, reason: 'not mined (yet)' } : { ok: false, reason: 'unknown transaction (not on chain, not pending)' };
    }
    if (hexNum(rc.status) !== 1) return { ok: false, reason: 'transaction reverted' };
    let amount = 0n;
    for (const x of rc.logs) if (lc(x.address) === lc(token) && x.topics[0] === TOPIC.TRANSFER && lc(x.topics[2]) === pad(to)) amount += word(x.data, 0);
    if (amount < BigInt(minAmount)) return { ok: false, reason: `transfers ${amount} to ${to}, owed ${minAmount}` };
    return { ok: true, block: hexNum(rc.blockNumber), amount: String(amount) };
  }

  const accountNonce = async (addr) => hexNum(await call('eth_getTransactionCount', [addr, 'latest']));
  const sendRaw = (raw) => call('eth_sendRawTransaction', [raw]);
  return { call, reconcile, verifyRefund, accountNonce, sendRaw, blockNumber };
}

/**
 * Optional automatic refunds from a seller hot wallet (REFUND_PRIVATE_KEY). Signs a dUSD transfer locally with a pinned
 * nonce so the caller can persist { tx, raw, nonce } BEFORE broadcasting: a crash can only lead to re-broadcasting the
 * same bytes, never to a second refund. Needs ethers (loaded on demand).
 */
export async function makeRefunder({ chain, privateKey, token, chainId, gasPriceGwei = 1 }) {
  const { Wallet, Interface } = await import('ethers');
  const w = new Wallet(privateKey); const iface = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);
  return {
    address: w.address,
    async prepare(to, amount) {
      const nonce = await chain.accountNonce(w.address);
      const raw = await w.signTransaction({ type: 0, chainId, nonce, to: token, data: iface.encodeFunctionData('transfer', [to, BigInt(amount)]), gasLimit: 100_000n, gasPrice: BigInt(Math.round(gasPriceGwei * 1e9)), value: 0n });
      const { keccak256 } = await import('ethers');
      return { tx: keccak256(raw), raw, nonce };
    },
    async broadcast(raw) { try { return await chain.sendRaw(raw); } catch (e) { if (/already known|known transaction|nonce too low|already imported/i.test(e.message)) return null; throw e; } },
  };
}
