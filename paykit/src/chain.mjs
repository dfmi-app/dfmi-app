/**
 * chain.mjs — read-only view of the dfmi chain for a seller.
 *
 * Everything here is a read: eth_blockNumber, eth_getLogs, eth_getTransactionReceipt.
 * No signer, no key, no write. A failure to read is reported as "unknown", never as "unpaid".
 */
import { JsonRpcProvider, Network, Interface, getAddress, formatUnits, parseUnits } from 'ethers';

const ERC20 = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const TRANSFER_TOPIC = ERC20.getEvent('Transfer').topicHash;

export class ChainReader {
  /** @param {object} cfg paykit config  @param {object} [provider] injected provider (tests) */
  constructor(cfg, provider) {
    this.cfg = cfg;
    // staticNetwork: never probe the network on startup, and never print to stdout (stdout is the MCP channel).
    const net = Network.from({ chainId: cfg.chainId, name: cfg.chain });
    this.provider = provider ?? new JsonRpcProvider(cfg.rpc, net, { staticNetwork: net, batchMaxCount: 1 });
    this.token = getAddress(cfg.token);
  }

  async blockNumber() { return await this.provider.getBlockNumber(); }

  /** blockNumber with a deadline, for callers that must not hang on a slow RPC (invoice creation). */
  async blockNumberWithin(ms = 5000) {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`RPC timeout after ${ms}ms`)), ms); });
    try { return await Promise.race([this.provider.getBlockNumber(), timeout]); } finally { clearTimeout(timer); }
  }

  /**
   * All token transfers INTO `payee` between fromBlock and toBlock.
   * Returns [{ from, to, value (bigint), txHash, block, logIndex }]
   */
  async transfersTo(payee, fromBlock, toBlock = 'latest') {
    const to = getAddress(payee);
    const logs = await this.provider.getLogs({
      address: this.token,
      fromBlock,
      toBlock,
      topics: [TRANSFER_TOPIC, null, ERC20.getAbiCoder().encode(['address'], [to])],
    });
    return logs.map(l => {
      const { args } = ERC20.parseLog({ topics: l.topics, data: l.data });
      return { from: args.from, to: args.to, value: BigInt(args.value), txHash: l.transactionHash, block: l.blockNumber, logIndex: l.index ?? l.logIndex };
    });
  }

  /**
   * Verify one settlement transaction: did `txHash` move at least `amountUnits` of the token to `payee`?
   * Used for x402 settlement receipts ("PAYMENT-RESPONSE" header carries a transaction hash).
   */
  async verifyTx(txHash, payee, amountUnits) {
    const rcpt = await this.provider.getTransactionReceipt(txHash);
    if (!rcpt) return { found: false };
    if (rcpt.status !== 1) return { found: true, success: false, reason: 'transaction reverted' };
    const to = getAddress(payee);
    let paid = 0n; let from = null;
    for (const l of rcpt.logs) {
      if (getAddress(l.address) !== this.token || l.topics[0] !== TRANSFER_TOPIC) continue;
      const { args } = ERC20.parseLog({ topics: l.topics, data: l.data });
      if (getAddress(args.to) === to) { paid += BigInt(args.value); from = args.from; }
    }
    const head = await this.blockNumber();
    return {
      found: true, success: paid >= BigInt(amountUnits), paid_units: paid.toString(),
      from, block: rcpt.blockNumber, confirmations: head - rcpt.blockNumber + 1,
    };
  }

  units(amountDecimal) { return parseUnits(String(amountDecimal), this.cfg.decimals); }
  decimal(units) { return formatUnits(BigInt(units), this.cfg.decimals); }
}
