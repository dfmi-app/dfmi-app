/**
 * config.mjs — loads paykit.config.json (chain, token, RPC) and resolves the invoice store path.
 *
 * Nothing in the config is secret: an RPC URL, a token address, decimals. paykit never holds a key.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadConfig(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.PAYKIT_CONFIG,
    resolve(process.cwd(), 'paykit.config.json'),
    resolve(HERE, '..', 'paykit.config.json'),
  ].filter(Boolean);
  const path = candidates.find(p => existsSync(p));
  if (!path) throw new Error('paykit.config.json not found (set PAYKIT_CONFIG or run from the paykit directory)');
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  for (const k of ['chain', 'chainId', 'rpc', 'token', 'symbol', 'decimals']) {
    if (cfg[k] === undefined) throw new Error(`paykit.config.json is missing "${k}"`);
  }
  cfg.confirmations = Number(cfg.confirmations ?? 1);
  cfg.store = resolve(dirname(path), cfg.store ?? './invoices.json');
  cfg._path = path;
  return cfg;
}
