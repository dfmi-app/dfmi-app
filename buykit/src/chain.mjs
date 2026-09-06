/**
 * chain.mjs — read-only view of the dfmi chain for a buyer: the session wallet's bounds, balances, and past transfers.
 *
 * Reads only. The one write in buykit (the payment) is not sent from here; it is a signature handed to the facilitator.
 */
import { JsonRpcProvider, Network, Contract, Interface, getAddress, formatUnits, parseUnits } from 'ethers';

const ERC20 = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)', 'function balanceOf(address) view returns (uint256)']);
const TRANSFER_TOPIC = ERC20.getEvent('Transfer').topicHash;

// Shared by SessionKeyWallet (v1) and IntentSessionWallet (v2). v2 adds allowed(); v1 reverts on it, which we treat as "no intent layer".
const WALLET_ABI = [
  'function owner() view returns (address)',
  'function token() view returns (address)',
  'function sessions(address) view returns (bool active, uint64 expiry, uint256 cap, uint256 spent)',
  'function sessionNonce(address) view returns (uint256)',
  'function remaining(address) view returns (uint256)',
  'function allowed(address sessionKey, address to) view returns (bool ok, uint8 category)',
];

export class ChainReader {
  constructor(cfg, provider) {
    this.cfg = cfg;
    const net = Network.from({ chainId: cfg.chainId, name: cfg.chain });
    this.provider = provider ?? new JsonRpcProvider(cfg.rpc, net, { staticNetwork: net, batchMaxCount: 1 });
    this.token = getAddress(cfg.token);
    this.erc20 = new Contract(this.token, ERC20, this.provider);
  }

  wallet(address) { return new Contract(getAddress(address), WALLET_ABI, this.provider); }

  async blockNumber() { return await this.provider.getBlockNumber(); }

  /** The session's on-chain bounds, as the wallet contract sees them right now. */
  async session(walletAddr, sessionKey) {
    const w = this.wallet(walletAddr);
    const [s, nonce, tok, bal] = await Promise.all([w.sessions(sessionKey), w.sessionNonce(sessionKey), w.token(), this.erc20.balanceOf(walletAddr)]);
    const now = Math.floor(Date.now() / 1000);
    const expiry = Number(s.expiry);
    const cap = BigInt(s.cap), spent = BigInt(s.spent);
    return {
      active: Boolean(s.active), expiry: expiry || null, expired: expiry !== 0 && now > expiry,
      cap, spent, remaining: s.active && cap > spent ? cap - spent : 0n,
      nonce: BigInt(nonce), walletBalance: BigInt(bal), tokenMatches: getAddress(tok) === this.token,
    };
  }

  /** Intent check (v2 wallets). Returns null when the wallet has no intent layer (v1). */
  async allowed(walletAddr, sessionKey, payTo) {
    try { const r = await this.wallet(walletAddr).allowed(sessionKey, payTo); return { ok: Boolean(r.ok), category: Number(r.category) }; }
    catch { return null; }
  }

  /**
   * Token transfers FROM the session wallet TO payee in [fromBlock, toBlock].
   * Scans in chunks (cfg.logChunk blocks, default 1000) because many nodes cap the eth_getLogs range;
   * a chunk that still fails with a range error is halved and retried.
   */
  async transfersFromTo(walletAddr, payTo, fromBlock, toBlock) {
    const enc = ERC20.getAbiCoder();
    const topics = [TRANSFER_TOPIC, enc.encode(['address'], [getAddress(walletAddr)]), enc.encode(['address'], [getAddress(payTo)])];
    const head = typeof toBlock === 'number' ? toBlock : await this.blockNumber();
    let chunk = Number(this.cfg.logChunk ?? 1000);
    const out = [];
    for (let hi = head; hi >= fromBlock; ) {
      const lo = Math.max(fromBlock, hi - chunk + 1);
      let logs;
      try { logs = await this.provider.getLogs({ address: this.token, fromBlock: lo, toBlock: hi, topics }); }
      catch (e) {
        if (chunk > 50 && /range|limit|too many|exceed/i.test(String(e?.message ?? e))) { chunk = Math.floor(chunk / 2); continue; }
        throw e;
      }
      for (const l of logs) { const { args } = ERC20.parseLog({ topics: l.topics, data: l.data });
        out.push({ from: args.from, to: args.to, value: BigInt(args.value), txHash: l.transactionHash, block: l.blockNumber }); }
      hi = lo - 1;
    }
    return out.sort((a, b) => a.block - b.block);
  }

  units(amountDecimal) { return parseUnits(String(amountDecimal), this.cfg.decimals); }
  decimal(units) { return formatUnits(BigInt(units), this.cfg.decimals); }
}
