#!/usr/bin/env node
/**
 * grant.mjs — OWNER-side: issue or revoke a session key on an existing SessionKeyWallet / IntentSessionWallet.
 *
 * This is the only file in buykit that uses the owner's key, and it runs on the owner's machine, not the agent's.
 * The owner needs native coin for gas (grantSession/revokeSession are the owner's own transactions).
 *
 *   OWNER_KEY=0x… node src/grant.mjs new                                   # print a fresh session keypair (nothing on-chain)
 *   OWNER_KEY=0x… node src/grant.mjs grant  <wallet> <sessionKey> <cap> [--days 7] [--mask 2]
 *   OWNER_KEY=0x… node src/grant.mjs revoke <wallet> <sessionKey>
 *   OWNER_KEY=0x… node src/grant.mjs fund   <wallet> <amount>              # move dUSD from the owner into the wallet
 *   OWNER_KEY=0x… node src/grant.mjs status <wallet> <sessionKey>          # read bounds (no gas)
 *
 * --mask is the intentMask for IntentSessionWallet (bit N = category N; 2 = category 1 only; 0 = unrestricted).
 * On a v1 SessionKeyWallet grantSession takes no mask; grant.mjs tries v2 first and falls back to v1.
 */
import { Contract, JsonRpcProvider, Network, Wallet, parseUnits, formatUnits } from 'ethers';
import { loadConfig } from './config.mjs';

const cfg = loadConfig(process.env.BUYKIT_CONFIG);
const [, , cmd, ...rest] = process.argv;
const flag = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
const provider = new JsonRpcProvider(cfg.rpc, Network.from(cfg.chainId), { staticNetwork: true });

if (cmd === 'new') {
  const w = Wallet.createRandom();
  console.log(JSON.stringify({ session_address: w.address, session_private_key: w.privateKey, note: 'give the address to grant; put the private key ONLY in the buyer machine\'s SESSION_KEY' }, null, 2));
  process.exit(0);
}
const ownerKey = process.env.OWNER_KEY;
if (!ownerKey && cmd !== 'status') { console.error('set OWNER_KEY=0x<wallet owner private key> (owner machine only)'); process.exit(2); }
const owner = ownerKey ? new Wallet(ownerKey, provider) : null;
const ABI = [
  'function grantSession(address sessionKey, uint256 cap, uint64 expiry, uint256 intentMask)',
  'function grantSession(address sessionKey, uint256 cap, uint64 expiry)',
  'function revokeSession(address sessionKey)',
  'function sessions(address) view returns (bool active, uint64 expiry, uint256 cap, uint256 spent)',
  'function remaining(address) view returns (uint256)',
  'function owner() view returns (address)',
];
const tx0 = { type: 0, gasPrice: 1_000_000_000n };
const [walletAddr, sessionKey] = rest;
const wallet = walletAddr ? new Contract(walletAddr, ABI, owner ?? provider) : null;

const status = async () => {
  const [s, rem, o] = await Promise.all([wallet.sessions(sessionKey), wallet.remaining(sessionKey), wallet.owner()]);
  return { wallet: walletAddr, owner: o, session_key: sessionKey, active: s.active, expiry: Number(s.expiry) ? new Date(Number(s.expiry) * 1000).toISOString() : null,
    cap: formatUnits(s.cap, cfg.decimals), spent: formatUnits(s.spent, cfg.decimals), remaining: formatUnits(rem, cfg.decimals), symbol: cfg.symbol };
};

try {
  if (cmd === 'status') console.log(JSON.stringify(await status(), null, 2));
  else if (cmd === 'grant') {
    const cap = parseUnits(String(rest[2]), cfg.decimals);
    const expiry = Math.floor(Date.now() / 1000) + Number(flag('--days', 7)) * 86400;
    const mask = BigInt(flag('--mask', 0));
    // v1 or v2? Simulate the v2 call first (no gas, nothing on-chain); a v1 wallet has no such function and reverts the simulation.
    const v2 = wallet.getFunction('grantSession(address,uint256,uint64,uint256)');
    const v1 = wallet.getFunction('grantSession(address,uint256,uint64)');
    let isV2 = true;
    try { await v2.staticCall(sessionKey, cap, expiry, mask, { from: owner.address }); } catch { isV2 = false; }
    if (!isV2 && mask !== 0n) console.error('note: v1 SessionKeyWallet has no intent mask; --mask ignored');
    if (!isV2) { try { await v1.staticCall(sessionKey, cap, expiry, { from: owner.address }); } catch (e) { throw new Error(`grantSession would revert: ${e.reason ?? e.shortMessage ?? e.message} (is OWNER_KEY the wallet owner?)`); } }
    const tx = isV2 ? await v2.send(sessionKey, cap, expiry, mask, { ...tx0, gasLimit: 300_000 }) : await v1.send(sessionKey, cap, expiry, { ...tx0, gasLimit: 300_000 });
    const rc = await tx.wait();
    console.log(JSON.stringify({ granted: true, tx: rc.hash, ...(await status()) }, null, 2));
  } else if (cmd === 'revoke') {
    try { await wallet.revokeSession.staticCall(sessionKey, { from: owner.address }); } catch (e) { throw new Error(`revokeSession would revert: ${e.reason ?? e.shortMessage ?? e.message}`); }
    const rc = await (await wallet.revokeSession(sessionKey, { ...tx0, gasLimit: 100_000 })).wait();
    console.log(JSON.stringify({ revoked: true, tx: rc.hash, ...(await status()) }, null, 2));
  } else if (cmd === 'fund') {
    const token = new Contract(cfg.token, ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], owner);
    const rc = await (await token.transfer(walletAddr, parseUnits(String(rest[1]), cfg.decimals), { ...tx0, gasLimit: 100_000 })).wait();
    console.log(JSON.stringify({ funded: true, tx: rc.hash, wallet_balance: formatUnits(await token.balanceOf(walletAddr), cfg.decimals), symbol: cfg.symbol }, null, 2));
  } else { console.error('usage: grant.mjs new | grant <wallet> <sessionKey> <cap> [--days 7] [--mask 0] | revoke <wallet> <sessionKey> | fund <wallet> <amount> | status <wallet> <sessionKey>'); process.exit(2); }
} catch (e) { console.error('error:', e.shortMessage ?? e.message ?? e); process.exit(1); }
