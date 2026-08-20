#!/usr/bin/env node
/**
 * deploy-agent-registry.mjs — 部署全局唯一的 AgentRegistry(公共注册表,谁都能 register 自己的 agent)。
 *
 * 步骤: 部署 → 把地址写进 dfmi.json 的 "agentRegistry" 字段(facilitator 读它) → 打印 wallet.html 要改的那一行。
 * 用法: node deploy-agent-registry.mjs   (需要 .env 里的 DEPLOYER_PRIVATE_KEY)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { JsonRpcProvider, Wallet, ContractFactory } from 'ethers';

const cfgUrl = new URL('./dfmi.json', import.meta.url);
const cfg = JSON.parse(readFileSync(cfgUrl, 'utf8'));
if (cfg.insecure || process.argv.includes('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const localEnv = new URL('./.env', import.meta.url);
const envPath = existsSync(localEnv) ? localEnv : new URL('../.env', import.meta.url);
const env = existsSync(envPath)
  ? Object.fromEntries(readFileSync(envPath, 'utf8').split('\n').filter(l => l.includes('=')).map(l => l.split('=').map(s => s.trim())))
  : {};
const pk = process.env.DEPLOYER_PRIVATE_KEY ?? env.DEPLOYER_PRIVATE_KEY;
if (!pk) { console.error('缺少 DEPLOYER_PRIVATE_KEY(.env)'); process.exit(1); }

const art = JSON.parse(readFileSync(new URL('./agent-registry.json', import.meta.url), 'utf8'));
const provider = new JsonRpcProvider(cfg.rpc);
const deployer = new Wallet(pk, provider);
const gasPrice = BigInt(Math.round((cfg.gasPriceGwei ?? 1) * 1e9));

console.log(`链 ${cfg.rpc} | deployer ${deployer.address}`);
const factory = new ContractFactory(art.abi, art.bytecode, deployer);
const c = await factory.deploy({ type: 0, gasPrice, gasLimit: 2_000_000 });
console.log(`部署中... tx ${c.deploymentTransaction().hash}`);
await c.waitForDeployment();
const addr = await c.getAddress();

cfg.agentRegistry = addr;
writeFileSync(cfgUrl, JSON.stringify(cfg));
console.log(`\n✓ AgentRegistry 部署完成: ${addr}`);
console.log(`✓ 已写入 dfmi.json 的 "agentRegistry" 字段(facilitator 重启后自动启用 agent 归属记账)`);
console.log(`\n还差一步(网页控制台): 把 wallet.html 里这一行`);
console.log(`  var AGENT_REGISTRY = '';`);
console.log(`改成`);
console.log(`  var AGENT_REGISTRY = '${addr}';`);
console.log(`然后重新部署 wallet.html。之后记得: pm2 restart facilitator`);
