#!/usr/bin/env node
/**
 * feed.mjs — the public "agents" feed for dfmi.app/agents: what the agents did, and the two moments a human was present.
 *
 * Sources (all read-only):
 *   - the facilitator's settlements ledger (local JSON file): agent-to-agent settlements are the dfmi-session ones
 *     and the paykit:// invoices
 *   - the chain: SessionGranted / SessionRevoked events on the session wallets (= the human's two buttons), and
 *     the live state of each session (cap / spent / remaining / active)
 *
 * Serves:
 *   GET /agents/feed.json     merged timeline + live sessions
 *   GET /agents/              the page (index.html next to this file)
 *
 * Env: SETTLEMENTS (default /home/ubuntu/facilitator/dfmi/settlements.json), WALLETS (comma list of session wallets),
 *      RPC, PORT (4095), LOOKBACK (blocks to scan for grant/revoke on first start, default 60000), POLL (seconds, 20)
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { JsonRpcProvider, Network, Contract, Interface, getAddress, formatUnits } from 'ethers';

const PORT = Number(process.env.PORT ?? 4095);
const SETTLEMENTS = process.env.SETTLEMENTS ?? '/home/ubuntu/facilitator/dfmi/settlements.json';
const WALLETS = (process.env.WALLETS ?? '0x4Be529cB8c2b6B196FB054E737B31BB8CaAcB6d6').split(',').map(s => getAddress(s.trim()));
const RPC = process.env.RPC ?? 'https://ethereum.dfmi.app:8541';
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 112172);
const LOOKBACK = Number(process.env.LOOKBACK ?? 60000);
const POLL = Number(process.env.POLL ?? 20) * 1000;
const DECIMALS = 6;

const net = Network.from({ chainId: CHAIN_ID, name: 'dfmi' });
const provider = new JsonRpcProvider(RPC, net, { staticNetwork: net, batchMaxCount: 1 });
const WALLET_IFACE = new Interface([
  'event SessionGranted(address indexed sessionKey, uint256 cap, uint64 expiry)',
  'event SessionGranted(address indexed sessionKey, uint256 cap, uint64 expiry, uint256 intentMask)',
  'event SessionRevoked(address indexed sessionKey)',
  'event Paid(address indexed sessionKey, address indexed to, uint256 amount, uint256 nonce)',
  'function owner() view returns (address)',
  'function sessions(address) view returns (bool active, uint64 expiry, uint256 cap, uint256 spent)',
]);
const TOPICS = { grant3: WALLET_IFACE.getEvent('SessionGranted(address,uint256,uint64)').topicHash,
                 grant4: WALLET_IFACE.getEvent('SessionGranted(address,uint256,uint64,uint256)').topicHash,
                 revoke: WALLET_IFACE.getEvent('SessionRevoked').topicHash };
const log = (...a) => console.error('[agents-feed]', ...a);
const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
const fmt = (u) => formatUnits(BigInt(u), DECIMALS);

// ---------------------------------------------------------------- state
const state = { updatedAt: null, head: 0, scannedTo: {}, humanEvents: [], sessions: {}, owners: {}, blockTime: {} };

async function blockTime(n) {
  if (state.blockTime[n]) return state.blockTime[n];
  const b = await provider.getBlock(n).catch(() => null);
  const t = b ? new Date(Number(b.timestamp) * 1000).toISOString() : null;
  if (t) state.blockTime[n] = t;
  return t;
}

async function scanWallet(wallet, from, to) {
  const chunk = 1000; const out = [];
  for (let hi = to; hi >= from; hi -= chunk) {
    const lo = Math.max(from, hi - chunk + 1);
    const logs = await provider.getLogs({ address: wallet, fromBlock: lo, toBlock: hi, topics: [[TOPICS.grant3, TOPICS.grant4, TOPICS.revoke]] }).catch(e => { log('getLogs', lo, hi, e.shortMessage ?? e.message); return []; });
    for (const l of logs) {
      const p = WALLET_IFACE.parseLog({ topics: l.topics, data: l.data }); if (!p) continue;
      const isGrant = p.name === 'SessionGranted';
      out.push({ kind: isGrant ? 'grant' : 'revoke', actor: 'human', wallet, sessionKey: p.args.sessionKey,
        cap: isGrant ? fmt(p.args.cap) : null, expiry: isGrant && Number(p.args.expiry) ? new Date(Number(p.args.expiry) * 1000).toISOString() : null,
        tx: l.transactionHash, block: l.blockNumber });
      if (!state.sessions[wallet]) state.sessions[wallet] = {};
      state.sessions[wallet][p.args.sessionKey] = state.sessions[wallet][p.args.sessionKey] ?? {};
    }
  }
  return out;
}

async function refresh() {
  try {
    const head = await provider.getBlockNumber();
    for (const w of WALLETS) {
      const from = state.scannedTo[w] ? state.scannedTo[w] + 1 : Math.max(0, head - LOOKBACK);
      if (from <= head) {
        const evs = await scanWallet(w, from, head);
        for (const e of evs) { e.time = await blockTime(e.block); state.humanEvents.push(e); }
        state.scannedTo[w] = head;
      }
      const c = new Contract(w, WALLET_IFACE, provider);
      if (!state.owners[w]) state.owners[w] = await c.owner().catch(() => null);
      for (const key of Object.keys(state.sessions[w] ?? {})) {
        const s = await c.sessions(key).catch(() => null); if (!s) continue;
        const now = Math.floor(Date.now() / 1000); const expiry = Number(s.expiry);
        state.sessions[w][key] = { active: Boolean(s.active), expired: expiry !== 0 && now > expiry, expiry: expiry ? new Date(expiry * 1000).toISOString() : null,
          cap: fmt(s.cap), spent: fmt(s.spent), remaining: s.active && s.cap > s.spent ? fmt(s.cap - s.spent) : '0.0' };
      }
    }
    state.head = head; state.updatedAt = new Date().toISOString();
  } catch (e) { log('refresh failed:', e.shortMessage ?? e.message); }
}

function agentEvents() {
  if (!existsSync(SETTLEMENTS)) return [];
  let rows; try { rows = JSON.parse(readFileSync(SETTLEMENTS, 'utf8')); } catch { return []; }
  return rows.filter(r => r.scheme === 'dfmi-session' || String(r.resource ?? '').startsWith('paykit://')).map(r => ({
    kind: 'purchase', actor: 'agent', time: r.time, buyer: r.buyer, sessionKey: r.sessionKey ?? null, agentId: r.agentId ?? null, agentName: r.agentName ?? null,
    seller: r.payTo, amount: r.amountUsd != null ? String(r.amountUsd) : fmt(r.amountAtomic ?? 0), description: r.description ?? '', tx: r.tx, block: r.block, scheme: r.scheme ?? 'exact',
  }));
}

function feed() {
  const events = [...agentEvents(), ...state.humanEvents].sort((a, b) => (a.block ?? 0) - (b.block ?? 0) || String(a.time).localeCompare(String(b.time)));
  const purchases = events.filter(e => e.kind === 'purchase');
  return {
    updatedAt: state.updatedAt, head: state.head, chain: `eip155:${CHAIN_ID}`,
    wallets: WALLETS.map(w => ({ wallet: w, owner: state.owners[w] ?? null, sessions: Object.entries(state.sessions[w] ?? {}).map(([key, s]) => ({ sessionKey: key, ...s })) })),
    stats: { purchases: purchases.length, volume: purchases.reduce((a, e) => a + Number(e.amount || 0), 0).toFixed(6),
             humanActions: state.humanEvents.length, lastPurchase: purchases.at(-1)?.time ?? null },
    events: events.slice(-200),
  };
}

// ---------------------------------------------------------------- http
const HTML_PATH = new URL('./index.html', import.meta.url);
createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (u.pathname === '/agents/feed.json' || u.pathname === '/feed.json') { res.writeHead(200, { 'content-type': 'application/json', ...cors }); return res.end(JSON.stringify(feed(), null, 1)); }
  if (u.pathname === '/agents' || u.pathname === '/agents/' || u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cors }); return res.end(readFileSync(HTML_PATH, 'utf8'));
  }
  if (u.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, updatedAt: state.updatedAt, head: state.head })); }
  res.writeHead(404, cors); res.end('not found');
}).listen(PORT, () => log(`http://localhost:${PORT}/agents/  | settlements ${SETTLEMENTS} | wallets ${WALLETS.map(short).join(', ')} | rpc ${RPC}`));

await refresh();
setInterval(refresh, POLL);
