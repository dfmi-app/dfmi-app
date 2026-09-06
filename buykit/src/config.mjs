/**
 * config.mjs — loads buykit.config.json (chain, token, RPC, facilitator) and the two runtime secrets from the environment.
 *
 *   SESSION_WALLET   address of the SessionKeyWallet / IntentSessionWallet the owner funded (not secret)
 *   SESSION_KEY      private key of the session key the owner granted on that wallet (secret; bounded by the wallet)
 *
 * The config file holds nothing secret. The session key lives only in the environment of the buyer's machine.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadConfig(explicitPath) {
  const candidates = [explicitPath, process.env.BUYKIT_CONFIG, resolve(process.cwd(), 'buykit.config.json'), resolve(HERE, '..', 'buykit.config.json')].filter(Boolean);
  const path = candidates.find(p => existsSync(p));
  if (!path) throw new Error('buykit.config.json not found (set BUYKIT_CONFIG or run from the buykit directory)');
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  for (const k of ['chain', 'chainId', 'rpc', 'token', 'symbol', 'decimals', 'facilitator']) {
    if (cfg[k] === undefined) throw new Error(`buykit.config.json is missing "${k}"`);
  }
  cfg.confirmations = Number(cfg.confirmations ?? 1);
  cfg.lookbackBlocks = Number(cfg.lookbackBlocks ?? 20000);
  cfg.store = resolve(dirname(path), cfg.store ?? './purchases.json');
  cfg.wallet = process.env.SESSION_WALLET ?? cfg.wallet ?? null;
  cfg._path = path;
  return cfg;
}

export function loadSessionKey() {
  const k = process.env.SESSION_KEY;
  if (!k) throw new Error('SESSION_KEY is not set (the session key private key the owner granted; never commit it)');
  return k;
}
