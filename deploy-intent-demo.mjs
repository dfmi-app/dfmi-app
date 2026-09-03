#!/usr/bin/env node
/**
 * deploy-intent-demo.mjs — one-shot deployment of the intent layer:
 *   1. deploy ServiceRegistry (reused if dfmi.json already has serviceRegistry)
 *   2. register a category: splitter (the producer's payout address) → category 1 "market-data"
 *   3. deploy IntentSessionWallet (owner = DEPLOYER, dUSD, registry)
 *   4. fund it → generate a session key → grantSession(cap, 7 days, intentMask = category 1 only)
 *   5. write intent-wallet.deployed.json (contains the session private key — keep it in .gitignore, never push it)
 *
 * Usage: node deploy-intent-demo.mjs   (requires DEPLOYER_PRIVATE_KEY in .env; .env may live in this directory or its parent)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { JsonRpcProvider, Wallet, Contract, ContractFactory, parseUnits } from 'ethers';

const cfgUrl = new URL('./dfmi.json', import.meta.url);
const cfg = JSON.parse(readFileSync(cfgUrl, 'utf8'));
if (cfg.insecure || process.argv.includes('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const localEnv = new URL('./.env', import.meta.url);
const envPath = existsSync(localEnv) ? localEnv : new URL('../.env', import.meta.url);
const env = existsSync(envPath)
  ? Object.fromEntries(readFileSync(envPath, 'utf8').split('\n').filter(l => l.includes('=')).map(l => l.split('=').map(s => s.trim())))
  : {};
const pk = process.env.DEPLOYER_PRIVATE_KEY ?? env.DEPLOYER_PRIVATE_KEY;
if (!pk) { console.error('Missing DEPLOYER_PRIVATE_KEY (.env)'); process.exit(1); }

const regArt = JSON.parse(readFileSync(new URL('./service-registry.json', import.meta.url), 'utf8'));
const walArt = JSON.parse(readFileSync(new URL('./intent-wallet.json', import.meta.url), 'utf8'));
const provider = new JsonRpcProvider(cfg.rpc);
const owner = new Wallet(pk, provider);
const gasPrice = BigInt(Math.round((cfg.gasPriceGwei ?? 1) * 1e9));
const tx0 = { type: 0, gasPrice };
console.log(`chain ${cfg.rpc} | owner ${owner.address}`);

// 1. ServiceRegistry
let regAddr = cfg.serviceRegistry;
if (!regAddr) {
  const f = new ContractFactory(regArt.abi, regArt.bytecode, owner);
  const c = await f.deploy({ ...tx0, gasLimit: 1_000_000 });
  await c.waitForDeployment();
  regAddr = await c.getAddress();
  cfg.serviceRegistry = regAddr;
  writeFileSync(cfgUrl, JSON.stringify(cfg));
  console.log(`✓ ServiceRegistry deployed: ${regAddr} (written to dfmi.json)`);
} else console.log(`ServiceRegistry reused: ${regAddr}`);

// 2. register a category: the producer's payout address (splitter) → category 1 "market-data"
const reg = new Contract(regAddr, regArt.abi, owner);
const cat = Number(await reg.categoryOf(cfg.splitter));
if (cat === 0) {
  await (await reg.register(cfg.splitter, 1, 'market-data', { ...tx0, gasLimit: 200_000 })).wait();
  console.log(`✓ Category registered: splitter ${cfg.splitter} → 1 (market-data)`);
} else console.log(`splitter already registered as category ${cat}`);

// 3. IntentSessionWallet
const wf = new ContractFactory(walArt.abi, walArt.bytecode, owner);
const w = await wf.deploy(owner.address, cfg.token, regAddr, { ...tx0, gasLimit: 4_000_000 });
await w.waitForDeployment();
const walletAddr = await w.getAddress();
console.log(`✓ IntentSessionWallet deployed: ${walletAddr}`);

// 4. fund the wallet and issue a card that may only buy market-data
const token = new Contract(cfg.token, ['function transfer(address,uint256) returns (bool)'], owner);
const fund = parseUnits('1', 6);
await (await token.transfer(walletAddr, fund, { ...tx0, gasLimit: 100_000 })).wait();
console.log(`✓ Funded with 1.00 dUSD of operating balance`);

const session = Wallet.createRandom();
const cap = parseUnits('0.5', 6);
const expiry = Math.floor(Date.now() / 1000) + 7 * 86400;
const intentMask = 1n << 1n; // category 1 (market-data) only
await (await w.grantSession(session.address, cap, expiry, intentMask, { ...tx0, gasLimit: 300_000 })).wait();
console.log(`✓ Session granted ${session.address} | cap 0.50 | 7 days | intent = market-data only (mask ${intentMask})`);

// 5. record it (contains a private key — never commit)
writeFileSync(new URL('./intent-wallet.deployed.json', import.meta.url), JSON.stringify({
  chain: cfg.rpc, chainId: cfg.chainId, token: cfg.token,
  registry: regAddr, wallet: walletAddr, owner: owner.address,
  session: { address: session.address, privateKey: session.privateKey },
  cap: String(cap), expiry, intentMask: String(intentMask),
}, null, 2));
console.log(`\nDone. Next, the three-line proof of the intent layer:`);
console.log(`  node intent-pay.mjs ${cfg.splitter} 0.02        # → ✓ settled (market-data, within intent)`);
console.log(`  node intent-pay.mjs ${cfg.centralBank} 0.02     # → ⛔ reverted "unregistered payee" (outside intent)`);
console.log(`  (record saved to intent-wallet.deployed.json — make sure it is in .gitignore)`);
