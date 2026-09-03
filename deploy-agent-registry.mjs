#!/usr/bin/env node
/**
 * deploy-agent-registry.mjs — deploys the single global AgentRegistry (a public registry: anyone can register their own agent).
 *
 * Steps: deploy → write the address into the "agentRegistry" field of dfmi.json (the facilitator reads it) → print the line to change in wallet.html.
 * Usage: node deploy-agent-registry.mjs   (requires DEPLOYER_PRIVATE_KEY in .env)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { JsonRpcProvider, Wallet, ContractFactory } from 'ethers';

const cfgUrl = new URL('./dfmi.json', import.meta.url);
const cfg = JSON.parse(readFileSync(cfgUrl, 'utf8'));
if (cfg.insecure || process.argv.includes('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // local/self-signed RPC only — never use against a production endpoint

const localEnv = new URL('./.env', import.meta.url);
const envPath = existsSync(localEnv) ? localEnv : new URL('../.env', import.meta.url);
const env = existsSync(envPath)
  ? Object.fromEntries(readFileSync(envPath, 'utf8').split('\n').filter(l => l.includes('=')).map(l => l.split('=').map(s => s.trim())))
  : {};
const pk = process.env.DEPLOYER_PRIVATE_KEY ?? env.DEPLOYER_PRIVATE_KEY;
if (!pk) { console.error('Missing DEPLOYER_PRIVATE_KEY (.env)'); process.exit(1); }

const art = JSON.parse(readFileSync(new URL('./agent-registry.json', import.meta.url), 'utf8'));
const provider = new JsonRpcProvider(cfg.rpc);
const deployer = new Wallet(pk, provider);
const gasPrice = BigInt(Math.round((cfg.gasPriceGwei ?? 1) * 1e9));

console.log(`chain ${cfg.rpc} | deployer ${deployer.address}`);
const factory = new ContractFactory(art.abi, art.bytecode, deployer);
const c = await factory.deploy({ type: 0, gasPrice, gasLimit: 2_000_000 });
console.log(`Deploying... tx ${c.deploymentTransaction().hash}`);
await c.waitForDeployment();
const addr = await c.getAddress();

cfg.agentRegistry = addr;
writeFileSync(cfgUrl, JSON.stringify(cfg));
console.log(`\n✓ AgentRegistry deployed: ${addr}`);
console.log(`✓ Written to the "agentRegistry" field of dfmi.json (the facilitator enables agent attribution automatically after restart)`);
console.log(`\nOne step left (web console): change this line in wallet.html`);
console.log(`  var AGENT_REGISTRY = '';`);
console.log(`to`);
console.log(`  var AGENT_REGISTRY = '${addr}';`);
console.log(`then redeploy wallet.html. Afterwards, remember: pm2 restart facilitator`);
