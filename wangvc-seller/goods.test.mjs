/**
 * goods.test.mjs — the goods, without a chain. (The LLM summary is optional and only
 * runs when LLM_API_KEY is set, so these assert on the always-present structured report.)
 *   node --test goods.test.mjs
 * Uses the live data.json at WANGVC_DATA (default the wangvc pipeline path).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wangvcBrief, wangvcAsk, routeQuestion, BOARDS } from './goods.mjs';

test('routeQuestion maps questions to the right dashboard', () => {
  assert.equal(routeQuestion('BTC 见底没?'), 'btc');
  assert.equal(routeQuestion('黄金还能追吗'), 'gold');
  assert.equal(routeQuestion('英伟达 PE'), 'ai');
  assert.equal(routeQuestion('国会在买什么'), 'cg');
  assert.equal(routeQuestion('光伏见底没'), 'ep');
  assert.equal(routeQuestion('venture funding'), 'vc');
  assert.equal(routeQuestion('something unrelated'), 'ai');
});

test('wangvc-brief is a structured report covering every board', async () => {
  const r = await wangvcBrief();
  assert.equal(r.product, 'wangvc-brief');
  assert.match(r.source, /12 dashboards/);
  assert.ok('summary' in r && 'summaryBy' in r); // present (null without an LLM key)
  for (const name of Object.values(BOARDS)) assert.ok(r.report.includes(name), `report missing board ${name}`);
  assert.match(r.report, /\$|%|pp|[0-9]/);
});

test('wangvc-ask routes to the right board and carries the question', async () => {
  const r = await wangvcAsk({ question: 'BTC 见底没?' });
  assert.equal(r.product, 'wangvc-ask');
  assert.equal(r.question, 'BTC 见底没?');
  assert.ok(r.report.includes(BOARDS.btc), 'ask did not route to BTC board');
});

test('missing question still delivers a dashboard (no crash)', async () => {
  const r = await wangvcAsk({});
  assert.equal(r.product, 'wangvc-ask');
  assert.ok(r.report.length > 0);
});
