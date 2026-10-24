#!/usr/bin/env node
/**
 * register.mjs — list the seller on dfmi by giving its payout address a public category.
 *
 * Calls ServiceRegistry.register(payTo, category, label). First-come and immutable:
 * if the address already has a category, this prints it and exits (nothing to undo).
 * Registration is permissionless — any funded key may register any address; gas is ~free
 * on this chain — so REGISTRANT_KEY just needs a little native coin, not special rights.
 *
 *   SELLER_ADDRESS=0x… REGISTRANT_KEY=0x… node register.mjs
 *   Optional: SERVICE_CATEGORY (default 1 = market-data), SERVICE_LABEL (default wangvc-signals),
 *             SERVICE_REGISTRY, RPC, INSECURE_TLS=1
 *
 * Categories (ServiceRegistry.sol): 1=market-data 2=ai-answers 3=api-tools 4=media 5=compute 6..255=open
 */
import { JsonRpcProvider, Wallet, Contract } from 'ethers';

const RPC = process.env.RPC || 'https://ethereum.dfmi.app:8541';
const REGISTRY = process.env.SERVICE_REGISTRY || '0xED134CC9c3D94908B20dd9DDBc2534C199394A81';
const SELLER = process.env.SELLER_ADDRESS || '0x35EED7539a6e19B7427007f727e87A0527450eBe';
const CATEGORY = Number(process.env.SERVICE_CATEGORY || 1);
const LABEL = process.env.SERVICE_LABEL || 'wangvc-signals';
const KEY = process.env.REGISTRANT_KEY;
const ABI = [
  'function categoryOf(address) view returns (uint8)',
  'function register(address payTo, uint8 category, string label)',
];

if (process.env.INSECURE_TLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const provider = new JsonRpcProvider(RPC);
const reg = new Contract(REGISTRY, ABI, provider);

const cur = Number(await reg.categoryOf(SELLER));
if (cur !== 0) {
  console.log(`✓ already registered: ${SELLER} → category ${cur} (first-come, immutable). Nothing to do.`);
  process.exit(0);
}
if (!KEY) {
  console.error('Not registered yet. Set REGISTRANT_KEY (any key with a little native coin; register is permissionless).');
  process.exit(1);
}
const wallet = new Wallet(KEY, provider);
console.log(`registering ${SELLER} → category ${CATEGORY} "${LABEL}" via ${wallet.address} …`);
const tx = await reg.connect(wallet).register(SELLER, CATEGORY, LABEL, { type: 0, gasPrice: 1_000_000_000n, gasLimit: 120_000 });
const r = await tx.wait();
console.log(`✅ registered | tx ${r.hash}`);
console.log(`   It now resolves on-chain; the facilitator adds it to dfmi-catalog.json on your first settlement,`);
console.log(`   and dfmi.app/agents/ + bazaar.dfmi.app surface it once real agent-to-agent settlements land.`);
