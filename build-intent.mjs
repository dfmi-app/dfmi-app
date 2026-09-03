#!/usr/bin/env node
/**
 * build-intent.mjs — compiles the two intent-layer contracts:
 *   contracts/ServiceRegistry.sol     → service-registry.json
 *   contracts/IntentSessionWallet.sol → intent-wallet.json
 * Usage: node build-intent.mjs
 */
import solc from 'solc';
import { readFileSync, writeFileSync } from 'node:fs';

const files = {
  'ServiceRegistry.sol': 'ServiceRegistry',
  'IntentSessionWallet.sol': 'IntentSessionWallet',
};
const sources = {};
for (const f of Object.keys(files)) sources[f] = { content: readFileSync(new URL(`./contracts/${f}`, import.meta.url), 'utf8') };

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'byzantium', // legacy AuRa chain: solc lowers << to arithmetic, avoiding SHL / PUSH0 / CHAINID
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
if (errs.length) { for (const e of errs) console.error(e.formattedMessage); process.exit(1); }

const outName = { ServiceRegistry: 'service-registry.json', IntentSessionWallet: 'intent-wallet.json' };
for (const [file, name] of Object.entries(files)) {
  const c = out.contracts[file][name];
  const artifact = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
  writeFileSync(new URL(`./${outName[name]}`, import.meta.url), JSON.stringify(artifact, null, 2));
  console.log(`compiled ${name} → ${outName[name]} (${artifact.bytecode.length / 2 - 1} bytes)`);
}
