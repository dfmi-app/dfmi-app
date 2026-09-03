#!/usr/bin/env node
/**
 * build-agent-registry.mjs — compiles contracts/AgentRegistry.sol → agent-registry.json {abi, bytecode}
 * Usage: node build-agent-registry.mjs
 */
import solc from 'solc';
import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync(new URL('./contracts/AgentRegistry.sol', import.meta.url), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'AgentRegistry.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'byzantium', // legacy AuRa chain: avoid newer opcodes such as PUSH0 / CHAINID
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
if (errs.length) { for (const e of errs) console.error(e.formattedMessage); process.exit(1); }
const c = out.contracts['AgentRegistry.sol'].AgentRegistry;
const artifact = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
writeFileSync(new URL('./agent-registry.json', import.meta.url), JSON.stringify(artifact, null, 2));
console.log(`compiled AgentRegistry → agent-registry.json (${artifact.bytecode.length / 2 - 1} bytes)`);
