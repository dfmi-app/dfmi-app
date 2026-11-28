#!/usr/bin/env node
/**
 * register.mjs — list the seller on dfmi by giving its payout address a public category.
 *
 * Calls ServiceRegistry.register(payTo, category, label). ServiceRegistry now requires proof of control
 * (msg.sender == payTo), so REGISTRANT_KEY MUST be the seller address's own key — you can only categorize
 * your own payout address, not someone else's. A controller may re-run this to correct its category (no
 * longer first-come-immutable). REGISTRANT_KEY needs a little native coin for gas.
 *
 *   SELLER_ADDRESS=0x… REGISTRANT_KEY=0x<key for SELLER_ADDRESS> node register.mjs
 *   Optional: SERVICE_CATEGORY (default 1 = market-data), SERVICE_LABEL (default wangvc-signals),
 *             RPC, INSECURE_TLS=1
 *   Required: SERVICE_REGISTRY (no default; the old built-in address was the pre-fix, first-come registry)
 *
 * Categories (ServiceRegistry.sol): 1=market-data 2=ai-answers 3=api-tools 4=media 5=compute 6..255=open
 */
import { JsonRpcProvider, Wallet, Contract } from 'ethers';

const RPC = process.env.RPC || 'https://ethereum.dfmi.app:8541';
// No default: the old built-in address was the pre-fix registry (first-come, anyone could register any address).
// Pass the ServiceRegistry that enforces msg.sender == payTo, e.g. the one recorded by deploy-intent.mjs.
const REGISTRY = process.env.SERVICE_REGISTRY;
if (!REGISTRY) {
  console.error('Set SERVICE_REGISTRY to the ServiceRegistry address (the self-registration registry; there is no built-in default).');
  process.exit(1);
}
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
  console.log(`✓ already registered: ${SELLER} → category ${cur}. Re-run with REGISTRANT_KEY = this address's key to change it.`);
  process.exit(0);
}
if (!KEY) {
  console.error('Not registered yet. Set REGISTRANT_KEY = the private key of SELLER_ADDRESS (the registry requires msg.sender == payTo).');
  process.exit(1);
}
const wallet = new Wallet(KEY, provider);
// Proof of control: the registry will revert unless the sender is the address being categorized. Fail early with a clear message.
if (wallet.address.toLowerCase() !== SELLER.toLowerCase()) {
  console.error(`REGISTRANT_KEY (${wallet.address}) must be the key for SELLER_ADDRESS (${SELLER}); the registry only lets an address categorize itself.`);
  process.exit(1);
}
console.log(`registering ${SELLER} → category ${CATEGORY} "${LABEL}" via ${wallet.address} …`);
const tx = await reg.connect(wallet).register(SELLER, CATEGORY, LABEL, { type: 0, gasPrice: 1_000_000_000n, gasLimit: 120_000 });
const r = await tx.wait();
console.log(`✅ registered | tx ${r.hash}`);
console.log(`   It now resolves on-chain; the facilitator adds it to dfmi-catalog.json on your first settlement,`);
console.log(`   and dfmi.app/agents/ + bazaar.dfmi.app surface it once real agent-to-agent settlements land.`);
