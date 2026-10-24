/**
 * goods.mjs — what the wangvc seller delivers. Structured reports (so the faucet shelf
 * and any x402 client get a summary line + the full signals), freshly read at delivery.
 *
 *   wangvc-brief : all 12 dashboards + a one-line LLM summary of the cross-asset picture.
 *   wangvc-ask   : one question routed to the right dashboard + an analyst answer.
 *
 * Data split: labels.json is bundled (board names + signal labels, stable); data.json is
 * read live from WANGVC_DATA (the wangvc pipeline rewrites it daily). No key, no chain here.
 * The LLM (OpenAI-compatible, defaults to Ollama Cloud) runs only if LLM_API_KEY is set;
 * without it the reports still deliver, just without the written summary.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = process.env.WANGVC_DATA || '/home/ubuntu/App/anthropic/wangvc/data.json';
const LABELS = JSON.parse(readFileSync(resolve(HERE, 'labels.json'), 'utf8'));
const BOARDS = LABELS._boards;
const BOARD_ORDER = Object.keys(BOARDS);

const SIGNALS = {};
for (const [k, label] of Object.entries(LABELS)) {
  if (k === '_boards') continue;
  (SIGNALS[k.split('.')[0]] ||= []).push([k, label]);
}

function loadData() {
  try { return JSON.parse(readFileSync(DATA_PATH, 'utf8')); }
  catch (e) { return { __error: `wangvc data unavailable (${e.message})` }; }
}
const asOf = (d) => d['gold.asof_en'] || new Date().toISOString().slice(0, 10);

const SKIP = /(_en|_zh|_sp|_full|_short|_r|asof|note|sent_|_state)/i;
// one board → [[label, value], …] (structured, for rich rendering + the text fallback)
function boardPairs(prefix, data) {
  const labelled = (SIGNALS[prefix] || [])
    .filter(([k]) => data[k] != null && data[k] !== '')
    .map(([k, label]) => [label, String(data[k])]);
  if (labelled.length) return labelled;
  return Object.entries(data)
    .filter(([k, v]) => k.startsWith(prefix + '.') && !SKIP.test(k) && v != null && v !== '' && typeof v !== 'object')
    .slice(0, 4)
    .map(([k, v]) => [k.split('.').slice(1).join('.'), String(v)]);
}
const fmtPairs = (pairs) => pairs.map(([l, v]) => `  ${l}: ${v}`).join('\n');

// ---------- LLM (optional; OpenAI-compatible, defaults to Ollama Cloud) ----------
const LLM_URL = process.env.LLM_API_URL || 'https://ollama.com/v1/chat/completions';
const LLM_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'glm-5.3:cloud';
async function llm(system, user) {
  if (!LLM_KEY) return null;
  try {
    const r = await fetch(LLM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.2 }),
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

// ---------- question routing ----------
const KEYWORDS = [
  ['btc', /btc|bitcoin|比特币|链上/i],
  ['gold', /gold|黄金|xau/i],
  ['ai', /\bai\b|人工智能|英伟达|nvidia|nvda|半导体|算力|芯片/i],
  ['as', /a股|科创|a-?share|star\s?50|沪深/i],
  ['bd', /美债|国债|收益率|treasury|yield|加息|降息|\bfed\b|联储/i],
  ['cg', /国会|congress|议员|stock\s?act|pelosi/i],
  ['bt', /生物|医药|药|pharma|biotech|xbi/i],
  ['nw', /网络安全|cyber|漏洞|\bcve\b|zscaler|crowdstrike/i],
  ['ep', /能源|光伏|solar|电网|隆基|net-?zero|净零/i],
  ['et', /新兴科技|emerging|量子|quantum|deepfake/i],
  ['vc', /风险投资|venture|\bvc\b|融资|funding|seed/i],
  ['wn', /制造|manufactur|赢家|winner/i],
];
export function routeQuestion(q = '') {
  for (const [p, re] of KEYWORDS) if (re.test(q)) return p;
  return 'ai';
}

// ---------- product A: the whole brief ----------
export async function wangvcBrief() {
  const data = loadData();
  if (data.__error) return { product: 'wangvc-brief', error: data.__error, summary: null };
  const asof = asOf(data);
  const dashboards = BOARD_ORDER.map((p) => ({ board: BOARDS[p], signals: boardPairs(p, data) })).filter((b) => b.signals.length);
  const report = dashboards.map((b) => `【${b.board}】\n${fmtPairs(b.signals)}`).join('\n\n');
  const summary = await llm(
    'You are a wangvc macro analyst. In two sentences, summarize the cross-asset picture from these dashboard signals. Cite 2–3 specific numbers. No hedging, no advice. Discipline: 不听观点, 只看数据。',
    report);
  return {
    product: 'wangvc-brief',
    generatedAt: new Date().toISOString(),
    source: `wangvc · 12 dashboards · as of ${asof}`,
    summary: summary || null,
    summaryBy: summary ? `llm:${MODEL}` : 'template',
    dashboards,
    report,
  };
}

// ---------- product B: per-ask ----------
export async function wangvcAsk({ question = '' } = {}) {
  const data = loadData();
  if (data.__error) return { product: 'wangvc-ask', error: data.__error, summary: null };
  const p = routeQuestion(question);
  const name = BOARDS[p];
  const signals = boardPairs(p, data);
  const signalsText = signals.length ? fmtPairs(signals) : '  (no labelled signals for this board right now)';
  const answer = await llm(
    "You are a wangvc analyst. Answer ONLY from the signals given, in the question's language. Two sentences, no hedging, cite a number. Discipline: 不听观点, 只看数据。",
    `Dashboard: ${name}\nSignals:\n${signalsText}\n\nQuestion: ${question}`);
  return {
    product: 'wangvc-ask',
    generatedAt: new Date().toISOString(),
    source: `wangvc · ${name} · as of ${asOf(data)}`,
    question,
    summary: answer || null,
    summaryBy: answer ? `llm:${MODEL}` : 'template',
    dashboards: [{ board: name, signals }],
    report: `【${name}】\n${signalsText}`,
  };
}

export const CATALOG = {
  'wangvc-brief': () => wangvcBrief(),
  'wangvc-ask': (args) => wangvcAsk(args),
};
export { BOARDS };
