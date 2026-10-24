// evmlib.mjs — isolated local-EVM harness for end-to-end tests. Disposable keys, mock token, ganache in-process.
// Not production: no public chain, no real credentials.
import ganache from 'ganache';
import solc from 'solc';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcProvider, Wallet, Contract, ContractFactory, parseUnits } from 'ethers';

const CHAIN_ID = 112172; // the wallet contracts hardcode this in their EIP-712 domain

function compileOne(file, name) {
  const input = {
    language: 'Solidity',
    sources: { [file]: { content: readFileSync(new URL(file, import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'london', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter(e => e.severity === 'error');
  if (errs.length) throw new Error(errs.map(e => e.formattedMessage).join('\n'));
  const c = out.contracts[file][name];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

export const ART = {
  token: compileOne('./contracts/MockERC20.sol', 'MockERC20'),
  registry: compileOne('../contracts/ServiceRegistry.sol', 'ServiceRegistry'),
  v1: compileOne('../contracts/SessionKeyWallet.sol', 'SessionKeyWallet'),
  v2: compileOne('../contracts/IntentSessionWallet.sol', 'IntentSessionWallet'),
};

export const PAY_TYPES = { Pay: [
  { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'generation', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] };

// One ganache HTTP node is shared across tests (node startup is the slow part); each test deploys fresh contracts.
let _node = null;
export async function getNode() {
  if (_node) return _node;
  const server = ganache.server({ chain: { chainId: CHAIN_ID }, wallet: { deterministic: true, totalAccounts: 3 }, logging: { quiet: true }, miner: { instamine: 'eager' } });
  await server.listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const provider = new JsonRpcProvider(url, undefined, { staticNetwork: true });
  provider.pollingInterval = 50; // ganache mines instantly; default 4s receipt polling would make tx.wait() crawl
  const owner = await provider.getSigner(0);
  _node = { server, url, provider, owner };
  return _node;
}
export async function shutdown() { if (_node) { try { await _node.server.close(); } catch { } _node = null; } }

/** On the shared node, deploy mock token + the chosen wallet variant, fund it, and grant a session. */
export async function makeEnv({ variant = 'v1', cap = 1_000000n, expirySecs = 3600, intentMask = 0n, fund = 5_000000n } = {}) {
  const { url, provider, owner } = await getNode(); // owner also acts as relayer/facilitator submitter

  const tokenC = await new ContractFactory(ART.token.abi, ART.token.bytecode, owner).deploy();
  await tokenC.waitForDeployment();
  const tokenAddr = await tokenC.getAddress();

  let walletC, registryAddr = null;
  if (variant === 'v2') {
    const reg = await new ContractFactory(ART.registry.abi, ART.registry.bytecode, owner).deploy();
    await reg.waitForDeployment(); registryAddr = await reg.getAddress();
    walletC = await new ContractFactory(ART.v2.abi, ART.v2.bytecode, owner).deploy(await owner.getAddress(), tokenAddr, registryAddr);
  } else {
    walletC = await new ContractFactory(ART.v1.abi, ART.v1.bytecode, owner).deploy(await owner.getAddress(), tokenAddr);
  }
  await walletC.waitForDeployment();
  const walletAddr = await walletC.getAddress();
  await (await tokenC.mint(walletAddr, fund)).wait();

  const sessionKey = Wallet.createRandom();
  const expiry = BigInt(Math.floor(Date.now() / 1000) + expirySecs);
  const grant = async (exp = expiry, msk = intentMask) => {
    if (variant === 'v2') await (await walletC.grantSession(sessionKey.address, cap, exp, msk)).wait();
    else await (await walletC.grantSession(sessionKey.address, cap, exp)).wait();
  };
  await grant();

  const cfg = {
    chain: 'eip155:112172', chainId: CHAIN_ID, rpc: url, token: tokenAddr, symbol: 'dUSD', decimals: 6,
    facilitator: 'http://facilitator.local', confirmations: 1, lookbackBlocks: 5000,
    wallet: walletAddr, store: join(mkdtempSync(join(tmpdir(), 'buykit-evm-')), 'purchases.json'),
  };

  const domain = { name: 'dfmi SessionKeyWallet', version: '1', chainId: CHAIN_ID, verifyingContract: walletAddr };
  const token = new Contract(tokenAddr, ART.token.abi, provider);
  const wallet = new Contract(walletAddr, (variant === 'v2' ? ART.v2 : ART.v1).abi, provider);

  return {
    variant, provider, url, cfg, owner, token, tokenAddr, wallet, walletAddr, registryAddr, sessionKey, cap, expiry, domain, grant,
    units: (d) => parseUnits(String(d), 6),
    async close() { /* shared node; closed once via shutdown() */ },
  };
}

/** A fake facilitator: BuyKit posts the signed Pay here; we submit the REAL pay() to the deployed contract.
 *  capture:true records the payload and does NOT submit (to get a signed-but-unused authorization). */
export function facilitator(env, { capture = false } = {}) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const pl = JSON.parse(init.body).paymentPayload.payload;
    calls.push(pl);
    if (capture) return { status: 200, json: async () => ({ success: false, error: 'captured (not submitted)' }) };
    try {
      const a = pl.authorization;
      const tx = await env.wallet.connect(env.owner).pay(pl.sessionKey, a.to, a.amount, a.nonce, a.deadline, pl.signature);
      const r = await tx.wait();
      return { status: 200, json: async () => ({ success: true, transaction: r.hash, blockNumber: r.blockNumber, payer: env.walletAddr }) };
    } catch (e) {
      return { status: 200, json: async () => ({ success: false, error: e.shortMessage ?? e.reason ?? e.message }) };
    }
  };
  return { fetchImpl, calls };
}
