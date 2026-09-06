/**
 * market.mjs — live market data for the analyst agent.
 *
 * Primary source: TradingView scanner (unauthenticated, multi-asset):
 *   POST https://scanner.tradingview.com/<market>/scan
 *   body { symbols: { tickers: [...] }, columns: [...] }  →  { data: [ { s: "EXCHANGE:SYMBOL", d: [...] } ] }
 * Fallback for crypto: CoinGecko simple/price + global.
 *
 * resolve(prompt) picks instruments from the prompt (English or Chinese) and routes each to its market.
 * snapshot(prompt) fetches them in parallel and returns { asOf, source, instruments[], text, lang }.
 */

const TV = 'https://scanner.tradingview.com';
const TIMEOUT = 7000;

// ---------------------------------------------------------------- instrument catalog
// market: which scan endpoint; ticker: TradingView symbol; label: display name; kind: for formatting
const I = (market, ticker, label, kind = 'price') => ({ market, ticker, label, kind });
const CAT = {
  // crypto
  btc:  I('crypto', 'BINANCE:BTCUSDT', 'Bitcoin (BTC/USDT)', 'crypto'),
  eth:  I('crypto', 'BINANCE:ETHUSDT', 'Ethereum (ETH/USDT)', 'crypto'),
  sol:  I('crypto', 'BINANCE:SOLUSDT', 'Solana (SOL/USDT)', 'crypto'),
  bnb:  I('crypto', 'BINANCE:BNBUSDT', 'BNB (BNB/USDT)', 'crypto'),
  xrp:  I('crypto', 'BINANCE:XRPUSDT', 'XRP (XRP/USDT)', 'crypto'),
  doge: I('crypto', 'BINANCE:DOGEUSDT', 'Dogecoin (DOGE/USDT)', 'crypto'),
  total: I('crypto', 'CRYPTOCAP:TOTAL', 'Total crypto market cap', 'cap'),
  btcd: I('crypto', 'CRYPTOCAP:BTC.D', 'BTC dominance', 'pct'),
  // US indices
  spx:  I('america', 'SP:SPX', 'S&P 500', 'index'),
  ndx:  I('america', 'NASDAQ:NDX', 'Nasdaq 100', 'index'),
  dji:  I('america', 'DJ:DJI', 'Dow Jones', 'index'),
  vix:  I('america', 'TVC:VIX', 'VIX', 'index'),
  // rates, dollar, commodities
  us10y: I('bond', 'TVC:US10Y', 'US 10Y yield', 'yield'),
  us02y: I('bond', 'TVC:US02Y', 'US 2Y yield', 'yield'),
  dxy:  I('forex', 'TVC:DXY', 'US Dollar Index (DXY)', 'index'),
  eurusd: I('forex', 'FX:EURUSD', 'EUR/USD', 'fx'),
  usdjpy: I('forex', 'FX:USDJPY', 'USD/JPY', 'fx'),
  gbpusd: I('forex', 'FX:GBPUSD', 'GBP/USD', 'fx'),
  usdcny: I('forex', 'FX_IDC:USDCNY', 'USD/CNY', 'fx'),
  gold: I('futures', 'COMEX:GC1!', 'Gold (COMEX front month)', 'commodity'),
  silver: I('futures', 'COMEX:SI1!', 'Silver (COMEX front month)', 'commodity'),
  oil:  I('futures', 'NYMEX:CL1!', 'WTI crude (NYMEX front month)', 'commodity'),
  natgas: I('futures', 'NYMEX:NG1!', 'Natural gas (NYMEX front month)', 'commodity'),
  copper: I('futures', 'COMEX:HG1!', 'Copper (COMEX front month)', 'commodity'),
  // China / HK
  sse:  I('china', 'SSE:000001', 'Shanghai Composite', 'index'),
  szse: I('china', 'SZSE:399001', 'Shenzhen Component', 'index'),
  csi300: I('china', 'SSE:000300', 'CSI 300', 'index'),
  hsi:  I('global', 'HKEX:HSI', 'Hang Seng Index', 'index'),
  moutai: I('china', 'SSE:600519', 'Kweichow Moutai (600519)', 'stock'),
  catl: I('china', 'SZSE:300750', 'CATL (300750)', 'stock'),
  byd:  I('china', 'SZSE:002594', 'BYD (002594)', 'stock'),
  tencent: I('global', 'HKEX:700', 'Tencent (0700.HK)', 'stock'),
  alibaba: I('global', 'HKEX:9988', 'Alibaba (9988.HK)', 'stock'),
};
// US stocks: ticker → exchange (display label comes back from TradingView's "description")
const US = { AAPL: 'NASDAQ', MSFT: 'NASDAQ', NVDA: 'NASDAQ', AMZN: 'NASDAQ', GOOGL: 'NASDAQ', GOOG: 'NASDAQ', META: 'NASDAQ', TSLA: 'NASDAQ', NFLX: 'NASDAQ',
             AMD: 'NASDAQ', INTC: 'NASDAQ', AVGO: 'NASDAQ', COIN: 'NASDAQ', MSTR: 'NASDAQ', PYPL: 'NASDAQ', HOOD: 'NASDAQ', PLTR: 'NASDAQ', QCOM: 'NASDAQ',
             V: 'NYSE', MA: 'NYSE', JPM: 'NYSE', GS: 'NYSE', BAC: 'NYSE', BRK_B: 'NYSE', XYZ: 'NYSE', SQ: 'NYSE', UNH: 'NYSE', XOM: 'NYSE', WMT: 'NYSE',
             DIS: 'NYSE', BA: 'NYSE', CRM: 'NYSE', ORCL: 'NYSE', IBM: 'NYSE', TSM: 'NYSE', BABA: 'NYSE', NKE: 'NYSE', KO: 'NYSE', PFE: 'NYSE' };

// keyword → catalog keys (English and Chinese). Order matters only for readability.
const KW = [
  [/\b(btc|bitcoin)\b|比特币/i, ['btc', 'total', 'btcd']],
  [/\b(eth|ethereum|ether)\b|以太坊/i, ['eth']],
  [/\b(sol|solana)\b/i, ['sol']], [/\bbnb\b/i, ['bnb']], [/\b(xrp|ripple)\b|瑞波/i, ['xrp']], [/\b(doge|dogecoin)\b|狗狗币/i, ['doge']],
  [/\b(crypto|altcoins?|加密|币圈|数字货币)\b|加密|币圈/i, ['btc', 'eth', 'sol', 'total', 'btcd']],
  [/\b(s&p|s&p ?500|spx|sp500)\b|标普/i, ['spx']], [/\b(nasdaq|ndx|qqq)\b|纳指|纳斯达克/i, ['ndx']], [/\b(dow|djia)\b|道指|道琼斯/i, ['dji']], [/\bvix\b|恐慌指数/i, ['vix']],
  [/\b(stock market|stocks|equities|wall street|us market)\b|美股|股市/i, ['spx', 'ndx', 'dji', 'vix']],
  [/\b(10[- ]?year|10y|treasur(y|ies)|yields?|rates?|bond market)\b|国债|收益率|利率/i, ['us10y', 'us02y']],
  [/\b(fed|fomc|rate (cut|hike)|interest rates?)\b|美联储|加息|降息/i, ['us10y', 'us02y', 'dxy', 'spx']],
  [/\b(dxy|dollar index|the dollar|usd)\b|美元/i, ['dxy']],
  [/\b(eur ?\/? ?usd|euro)\b|欧元/i, ['eurusd']], [/\b(usd ?\/? ?jpy|yen)\b|日元/i, ['usdjpy']], [/\b(gbp ?\/? ?usd|sterling|pound)\b|英镑/i, ['gbpusd']],
  [/\b(usd ?\/? ?cny|yuan|renminbi|rmb|cnh)\b|人民币|汇率/i, ['usdcny', 'dxy']],
  [/\bgold\b|黄金|金价/i, ['gold']], [/\bsilver\b|白银/i, ['silver']], [/\b(oil|crude|wti|brent)\b|原油|油价/i, ['oil']], [/\b(nat(ural)? ?gas)\b|天然气/i, ['natgas']], [/\bcopper\b|铜价/i, ['copper']],
  [/\b(commodit(y|ies)|metals)\b|大宗商品/i, ['gold', 'silver', 'oil', 'copper']],
  [/\b(a[- ]?shares?|shanghai|shenzhen|csi ?300|china stocks?|chinese (stocks?|market))\b|a股|上证|沪深|深成|沪指|中国股市/i, ['sse', 'szse', 'csi300']],
  [/\b(hang seng|hsi|hong kong|hk stocks?)\b|恒指|港股|恒生/i, ['hsi']],
  [/\bmoutai\b|茅台/i, ['moutai']], [/\bcatl\b|宁德时代/i, ['catl']], [/\bbyd\b|比亚迪/i, ['byd']], [/\btencent\b|腾讯/i, ['tencent']], [/\balibaba\b|阿里巴巴|阿里/i, ['alibaba']],
];
const NAMES = { apple: 'AAPL', microsoft: 'MSFT', nvidia: 'NVDA', amazon: 'AMZN', google: 'GOOGL', alphabet: 'GOOGL', meta: 'META', facebook: 'META', tesla: 'TSLA',
                netflix: 'NFLX', amd: 'AMD', intel: 'INTC', broadcom: 'AVGO', coinbase: 'COIN', microstrategy: 'MSTR', strategy: 'MSTR', paypal: 'PYPL', robinhood: 'HOOD',
                palantir: 'PLTR', qualcomm: 'QCOM', visa: 'V', mastercard: 'MA', jpmorgan: 'JPM', 'goldman sachs': 'GS', goldman: 'GS', 'bank of america': 'BAC',
                berkshire: 'BRK_B', block: 'XYZ', unitedhealth: 'UNH', exxon: 'XOM', walmart: 'WMT', disney: 'DIS', boeing: 'BA', salesforce: 'CRM', oracle: 'ORCL',
                tsmc: 'TSM', nike: 'NKE', 'coca-cola': 'KO', pfizer: 'PFE',
                苹果: 'AAPL', 微软: 'MSFT', 英伟达: 'NVDA', 亚马逊: 'AMZN', 谷歌: 'GOOGL', 特斯拉: 'TSLA', 奈飞: 'NFLX', 台积电: 'TSM', 万事达: 'MA', 摩根大通: 'JPM', 高盛: 'GS' };
const MACRO = ['spx', 'ndx', 'btc', 'dxy', 'us10y', 'gold', 'oil'];
const MARKET_HINT = /\b(market|price|trading|rally|sell-?off|crash|bull|bear|outlook|today|right now|what'?s (going on|happening))\b|行情|价格|走势|涨|跌|市场|今天|现在/i;

export function detectLang(q) { return /[一-鿿]/.test(q) ? 'zh' : 'en'; }

/** Which instruments does this prompt need? Returns [] if it does not look like a market question. */
export function resolve(q) {
  const s = q.toLowerCase();
  const keys = new Set(); const stocks = new Set();
  for (const [re, ks] of KW) if (re.test(s)) ks.forEach(k => keys.add(k));
  for (const [name, t] of Object.entries(NAMES)) if (/^[a-z]/.test(name) ? new RegExp(`\\b${name.replace(/[-.]/g, '\\$&')}\\b`).test(s) : q.includes(name)) stocks.add(t);
  for (const m of q.matchAll(/\$([A-Za-z]{1,5})\b/g)) stocks.add(m[1].toUpperCase());
  for (const t of Object.keys(US)) if (t.length >= 3 && new RegExp(`\\b${t.replace('_', '.')}\\b`).test(q)) stocks.add(t);   // bare uppercase tickers (3+ letters) like NVDA, TSLA; short ones need $V or a name
  if (!keys.size && !stocks.size) {
    if (!MARKET_HINT.test(s)) return [];
    MACRO.forEach(k => keys.add(k));                                    // generic "how's the market" → macro dashboard
  }
  const out = [...keys].map(k => ({ key: k, ...CAT[k] }));
  for (const t of stocks) { const ex = US[t] ?? 'NASDAQ'; out.push({ key: t, market: 'america', ticker: `${ex}:${t.replace('_', '.')}`, label: t.replace('_', '.'), kind: 'stock' }); }
  return out.slice(0, 14);
}

// ---------------------------------------------------------------- fetching
const COLS = ['description', 'close', 'change', 'change_abs', 'high', 'low', 'volume', 'market_cap_basic', 'market_cap_calc', 'currency'];

async function tvScan(market, tickers) {
  const r = await fetch(`${TV}/${market}/scan`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'dfmi-ask/1.0' },
    body: JSON.stringify({ symbols: { tickers, query: { types: [] } }, columns: COLS }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error(`tradingview ${market} ${r.status}`);
  const j = await r.json();
  const rows = {};
  for (const row of j.data ?? []) {
    const d = Object.fromEntries(COLS.map((c, i) => [c, row.d?.[i] ?? null]));
    rows[row.s] = d;
  }
  return rows;
}

async function coingecko() {
  const ids = 'bitcoin,ethereum,solana,binancecoin,ripple,dogecoin';
  const [p, g] = await Promise.all([
    fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`, { signal: AbortSignal.timeout(TIMEOUT) }).then(r => r.ok ? r.json() : Promise.reject(new Error(`coingecko ${r.status}`))),
    fetch('https://api.coingecko.com/api/v3/global', { signal: AbortSignal.timeout(TIMEOUT) }).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  const map = { bitcoin: 'btc', ethereum: 'eth', solana: 'sol', binancecoin: 'bnb', ripple: 'xrp', dogecoin: 'doge' };
  const out = {};
  for (const [id, v] of Object.entries(p)) out[map[id]] = { close: v.usd, change: v.usd_24h_change, market_cap_calc: v.usd_market_cap, volume: v.usd_24h_vol };
  if (g?.data) { out.total = { close: g.data.total_market_cap?.usd, change: g.data.market_cap_change_percentage_24h_usd }; out.btcd = { close: g.data.market_cap_percentage?.btc, change: null }; }
  return out;
}

/** Fetch everything the prompt needs. Never throws: instruments that fail are simply absent. */
export async function snapshot(q) {
  const wanted = resolve(q);
  if (!wanted.length) return null;
  const byMarket = {};
  for (const w of wanted) (byMarket[w.market] ??= []).push(w);
  const results = {}; const sources = new Set(); const errors = [];

  await Promise.all(Object.entries(byMarket).map(async ([market, list]) => {
    try {
      const rows = await tvScan(market, list.map(w => w.ticker));
      for (const w of list) if (rows[w.ticker]?.close != null) { results[w.key] = { ...w, ...rows[w.ticker] }; sources.add('TradingView'); }
    } catch (e) { errors.push(e.message); }
  }));

  // crypto fallback if TradingView gave us nothing for crypto
  const cryptoWanted = wanted.filter(w => w.market === 'crypto');
  if (cryptoWanted.length && !cryptoWanted.some(w => results[w.key])) {
    try { const cg = await coingecko(); for (const w of cryptoWanted) if (cg[w.key]) { results[w.key] = { ...w, description: w.label, ...cg[w.key] }; sources.add('CoinGecko'); } }
    catch (e) { errors.push(e.message); }
  }

  const instruments = wanted.filter(w => results[w.key]).map(w => present(results[w.key]));
  if (!instruments.length) return { asOf: new Date().toISOString(), source: null, instruments: [], text: '', errors, lang: detectLang(q) };
  return {
    asOf: new Date().toISOString(), source: [...sources].join(' + '), instruments, errors,
    text: instruments.map(line).join('\n'), lang: detectLang(q),
  };
}

// ---------------------------------------------------------------- formatting
function present(r) {
  return {
    key: r.key, symbol: r.ticker, name: r.description || r.label, kind: r.kind,
    price: num(r.close), changePct: num(r.change), changeAbs: num(r.change_abs),
    high: num(r.high), low: num(r.low), volume: num(r.volume),
    marketCap: num(r.market_cap_basic ?? r.market_cap_calc), currency: r.currency ?? (r.kind === 'crypto' ? 'USD' : null),
  };
}
function line(i) {
  const unit = i.kind === 'yield' || i.kind === 'pct' ? '%' : '';
  const big = i.kind === 'cap';
  let s = `${i.name}: ${big ? '$' + short(i.price) : fmt(i.price) + unit}`;
  if (i.changePct != null) s += ` (${sign(i.changePct)}%${i.changeAbs != null && !big ? `, ${sign(i.changeAbs)}` : ''} on the day)`;
  if (i.high != null && i.low != null && i.kind !== 'pct') s += `, range ${fmt(i.low)}–${fmt(i.high)}`;
  if (i.volume) s += `, vol ${short(i.volume)}`;
  if (i.marketCap) s += `, mcap $${short(i.marketCap)}`;
  return s;
}
const num = x => (x == null || Number.isNaN(Number(x)) ? null : Number(x));
export const fmt = n => n == null ? '?' : Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : Math.abs(n) >= 100 ? n.toFixed(1) : Math.abs(n) >= 1 ? n.toFixed(2) : n.toPrecision(3);
export const short = n => !n ? '?' : n >= 1e12 ? (n / 1e12).toFixed(2) + 'T' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(0) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : Math.round(n).toString();
export const sign = x => (x == null ? '?' : (x >= 0 ? '+' : '') + (Math.abs(x) >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(2)));
