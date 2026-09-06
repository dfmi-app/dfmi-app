#!/usr/bin/env node
/**
 * pay.mjs — BUYER-side test helper: send the exact amount of an invoice as a plain dUSD transfer.
 *
 * This is the only file in paykit that touches a private key, and it is the buyer's key, not the seller's.
 * It exists so you can test the full loop (create → pay → check → deliver) from one machine.
 * In production the buyer is another agent paying through its own SessionKeyWallet; the seller never runs this.
 *
 *   BUYER_KEY=0x... node src/pay.mjs <pay_to> <exact_amount>
 *   BUYER_KEY=0x... node src/pay.mjs --invoice inv_xxxxxxxxxxxx      # reads pay_to + exact_amount from the local store
 *
 * Prints the tx hash. Then:  node src/cli.mjs check <invoice_id> --tx <hash>
 */
import { Contract, JsonRpcProvider, Network, Wallet, parseUnits, formatUnits } from 'ethers';
import { loadConfig } from './config.mjs';
import { InvoiceStore } from './store.mjs';

const cfg = loadConfig(process.env.PAYKIT_CONFIG);
const key = process.env.BUYER_KEY;
if (!key) { console.error('set BUYER_KEY=0x<buyer private key> in the environment (never commit it)'); process.exit(2); }

const args = process.argv.slice(2);
let payTo, amount;
if (args[0] === '--invoice') {
  const inv = new InvoiceStore(cfg.store).get(args[1]);
  if (!inv) { console.error(`invoice ${args[1]} not found in ${cfg.store}`); process.exit(1); }
  payTo = inv.payee_address; amount = inv.exact_amount;
} else {
  [payTo, amount] = args;
}
if (!payTo || !amount) { console.error('usage: pay.mjs <pay_to> <exact_amount>  |  pay.mjs --invoice <invoice_id>'); process.exit(2); }

const provider = new JsonRpcProvider(cfg.rpc, Network.from(cfg.chainId), { staticNetwork: true });
const wallet = new Wallet(key, provider);
const erc20 = new Contract(cfg.token, [
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
], wallet);

const units = parseUnits(String(amount), cfg.decimals);
const bal = await erc20.balanceOf(wallet.address);
console.error(`buyer ${wallet.address} balance ${formatUnits(bal, cfg.decimals)} ${cfg.symbol}`);
if (bal < units) { console.error(`insufficient balance for ${amount} ${cfg.symbol} (faucet: https://faucet.dfmi.app)`); process.exit(1); }

console.error(`sending ${amount} ${cfg.symbol} → ${payTo} on ${cfg.chain}`);
const tx = await erc20.transfer(payTo, units);
console.error(`tx ${tx.hash} sent, waiting for ${cfg.confirmations} confirmation(s)…`);
const rc = await tx.wait(cfg.confirmations);
console.log(JSON.stringify({ tx_hash: rc.hash, block: rc.blockNumber, from: wallet.address, to: payTo, amount, symbol: cfg.symbol }, null, 2));
