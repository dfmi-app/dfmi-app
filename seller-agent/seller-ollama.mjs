#!/usr/bin/env node
/**
 * seller-ollama.mjs — the same seller agent on any OpenAI-compatible endpoint with tool calling.
 *
 * Default target is Ollama Cloud (glm-5.3:cloud). Works unchanged against OpenAI's API or a local Ollama:
 *   LLM_API_URL   default https://ollama.com/v1/chat/completions   (OpenAI: https://api.openai.com/v1/chat/completions,
 *                 local Ollama: http://localhost:11434/v1/chat/completions)
 *   LLM_API_KEY   bearer token (Ollama Cloud key / OpenAI key; empty for local Ollama)
 *   LLM_MODEL     default glm-5.3:cloud   (kimi-k3:cloud, gpt-4o, qwen3, …)
 *
 * The rules, tools and the delivery gate come from seller-core.mjs and are identical to seller.mjs (Claude).
 * Only the model loop differs: send messages + tools → run any tool_calls locally → append results → repeat.
 *
 *   node seller-ollama.mjs "Sell the market report to 0x<buyer> for 0.02 dUSD, due in 7 days."
 *   node seller-ollama.mjs --repl
 */
import { createInterface } from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import { SYSTEM, TOOLS, execTool } from './seller-core.mjs';

// .env next to this file is optional; environment variables win.
const envFile = new URL('./.env', import.meta.url);
const fileEnv = existsSync(envFile)
  ? Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }))
  : {};
const env = (k, d) => process.env[k] ?? fileEnv[k] ?? d;

const API   = env('LLM_API_URL', 'https://ollama.com/v1/chat/completions');
const KEY   = env('LLM_API_KEY', '');
const MODEL = env('LLM_MODEL', 'glm-5.3:cloud');
const MAX_TURNS = Number(env('SELLER_MAX_TURNS', 12));

async function chat(messages) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto', stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`llm ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  const m = d.choices?.[0]?.message;
  if (!m) throw new Error(`no message in response: ${JSON.stringify(d).slice(0, 200)}`);
  return m;
}

async function run(prompt) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const m = await chat(messages);
    messages.push({ role: 'assistant', content: m.content ?? '', ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) });
    if (m.content?.trim()) console.log(m.content.trim());
    if (!m.tool_calls?.length) { console.error(`— done (${turn + 1} turn${turn ? 's' : ''}, ${MODEL})`); return; }
    for (const call of m.tool_calls) {
      const name = call.function?.name;
      let args = {};
      try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : (call.function.arguments ?? {}); } catch {}
      console.error(`  ↳ ${name}(${JSON.stringify(args)})`);
      let content;
      try { content = JSON.stringify(await execTool(name, args), null, 2); }
      catch (e) { content = JSON.stringify({ error: String(e?.message ?? e) }); }
      if (process.env.SELLER_DEBUG) console.error(`  ← ${content.slice(0, 300)}`);
      messages.push({ role: 'tool', tool_call_id: call.id ?? name, name, content });
    }
  }
  console.error(`— stopped after ${MAX_TURNS} turns`);
}

const argv = process.argv.slice(2);
if (argv[0] === '--repl') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => rl.question('seller> ', async (line) => { if (!line.trim()) return ask(); try { await run(line); } catch (e) { console.error('error:', e.message); } ask(); });
  ask();
} else if (argv.length) {
  await run(argv.join(' ')).catch(e => { console.error('error:', e.message); process.exit(1); });
} else {
  console.error('usage: node seller-ollama.mjs "<instruction>"   |   node seller-ollama.mjs --repl');
  process.exit(2);
}
