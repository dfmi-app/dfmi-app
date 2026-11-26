// Regression tests for the external review of 2026-11-24 (dfmi-app/dfmi-app PR #1 @ 9547dac, probes P1–P10).
// Each test is the reviewer's probe turned around: it asserts the FIXED behavior. Mock RPC only, no chain: seconds.
// LIB=<dir> runs them against another copy of the library.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const ROOT = new URL('.', import.meta.url).pathname;

const LIB = process.env.LIB || ROOT;
const mod = (f) => import(pathToFileURL(join(LIB, f)).href);
const { openOrders, makeGate } = await mod('orders.mjs');
const { makeChain, TOPIC } = await mod('chain-recon.mjs');
const { safeFetch, isPrivateIP } = await mod('limits.mjs');

const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20), T = '0x' + '33'.repeat(20), H = '0x' + 'ab'.repeat(32);
const pad = (x) => '0x' + x.slice(2).padStart(64, '0'), word = (n) => BigInt(n).toString(16).padStart(64, '0');
const SIG = '0x' + '12'.repeat(65);
const pp = { scheme: 'dfmi-session', payload: { wallet: A, sessionKey: B, signature: SIG, authorization: { to: T, amount: '20', nonce: '0', generation: '2', deadline: '1' } } };
const order = (id = 'ord_1', payload = pp) => ({ id, payment_key: id, payload_hash: id, resource: 'r', amount: '20', inputs: '{}', payment: JSON.stringify({ paymentPayload: payload, paymentRequirements: { asset: T } }) });
const fresh = () => openOrders(':memory:');
/** mock JSON-RPC: handlers[method](params) → result (throw = RPC error) */
function rpc(handlers) {
  globalThis.fetch = async (_u, opts) => {
    const { method, params } = JSON.parse(opts.body);
    if (!handlers[method]) return { ok: true, json: async () => ({ jsonrpc: '2.0', error: { message: `no mock for ${method}` } }) };
    try { return { ok: true, json: async () => ({ jsonrpc: '2.0', result: await handlers[method](params) }) }; }
    catch (e) { return { ok: true, json: async () => ({ jsonrpc: '2.0', error: { message: e.message } }) }; }
  };
}
const chain = () => makeChain({ rpc: 'http://mock', token: T });
// the reviewer's chain: 10,000 blocks, block 5,000 at t=50,000, blocks 5,000–9,000 fast (7.5 s), the last 1,000 slow (20 s).
// Extrapolating from the last 1,000 blocks puts the start at ~7,455 — after the payment at 5,000.
const tsOf = (n) => n <= 5000 ? n * 10 : n <= 9000 ? 50000 + (n - 5000) * 7.5 : 80000 + (n - 9000) * 20;
const headers = { eth_blockNumber: () => '0x2710', eth_getBlockByNumber: ([n]) => ({ timestamp: '0x' + Math.round(tsOf(Number(BigInt(n)))).toString(16) }) };

test('P1 irregular block times: the log scan starts at or before the payment block (binary search on timestamps)', async () => {
  let from = null;
  rpc({ ...headers, eth_getLogs: ([f]) => { from ??= Number(BigInt(f.fromBlock)); return []; }, eth_call: () => '0x' + word(5) });
  const o = { ...order(), created_at: new Date(50000 * 1000).toISOString() };   // order at block 5000's time
  await chain().reconcile(o).catch(() => {});
  assert.ok(from !== null && from <= 5000, `scan starts at ${from}, the payment block is 5000`);
});

test('P1/P2 nothing found in the logs and the nonce IS consumed → UNKNOWN (throws), never "final unsettled"', async () => {
  rpc({ ...headers, eth_getLogs: () => [], eth_call: ([c]) => (c.data.startsWith('0xcd39960b') ? '0x' + word(2) : '0x' + word(1)) }); // generation 2, nonce 1 > 0
  await assert.rejects(chain().reconcile({ ...order(), created_at: new Date(50000 * 1000).toISOString() }), /consumed on chain/);
});

test('P2 an RPC error on authorizationState / sessionNonce → UNKNOWN, never "final unsettled"', async () => {
  rpc({ ...headers, eth_getLogs: () => [], eth_call: () => { throw new Error('RPC unavailable'); } });
  const exact = { ...order(), created_at: new Date(50000 * 1000).toISOString(),
    payment: JSON.stringify({ paymentPayload: { scheme: 'exact', payload: { authorization: { from: A, to: B, value: '20', validAfter: '0', validBefore: '1', nonce: H } } }, paymentRequirements: { asset: T } }) };
  await assert.rejects(chain().reconcile(exact), /RPC unavailable/);
  await assert.rejects(chain().reconcile({ ...order(), created_at: new Date(50000 * 1000).toISOString() }), /RPC unavailable/);
});

test('P2 malformed JSON-RPC answers are errors, not defaults', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0' }) });  // no result, no error
  await assert.rejects(chain().reconcile({ ...order(), created_at: new Date().toISOString() }), /malformed/);
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  await assert.rejects(chain().reconcile({ ...order(), created_at: new Date().toISOString() }), /HTTP 502/);
});

test('P3 a tx that merely CONTAINS the signature bytes is not accepted as the settlement', async () => {
  rpc({ eth_blockNumber: () => '0x64', eth_getBlockByNumber: ([n]) => ({ timestamp: '0x' + (10000 + Number(BigInt(n)) * 5).toString(16) }),
    eth_getLogs: ([f]) => (f.topics[0] === TOPIC.PAID_V1 ? [{ data: '0x' + word(20) + word(0), transactionHash: H, blockNumber: '0x63', logIndex: '0x0' }] : []),
    eth_getTransactionByHash: () => ({ input: '0xdeadbeef' + SIG.slice(2), to: A }),
    eth_getTransactionReceipt: () => ({ status: '0x1', logs: [{ address: A, logIndex: '0x0' }] }),
    eth_call: ([c]) => (c.data.startsWith('0xcd39960b') ? '0x' + word(2) : '0x' + word(1)) });
  const r = await chain().reconcile({ ...order(), created_at: new Date(10000 * 1000).toISOString() }).catch((e) => ({ state: 'unknown', e: e.message }));
  assert.notEqual(r.state, 'settled', 'not decodable as pay(...) on the wallet → not proof');
});

test('P3 the real pay() call with the same fields and signature IS accepted', async () => {
  const data = '6ad9f49f' + word(BigInt(B)) + word(BigInt(T)) + word(20) + word(0) + word(1) + word(192) + word(65) + SIG.slice(2).padEnd(192, '0');
  rpc({ eth_blockNumber: () => '0x64', eth_getBlockByNumber: ([n]) => ({ timestamp: '0x' + (10000 + Number(BigInt(n)) * 5).toString(16) }),
    eth_getLogs: ([f]) => (f.topics[0] === TOPIC.PAID_V1 ? [{ data: '0x' + word(20) + word(0), transactionHash: H, blockNumber: '0x63', logIndex: '0x0' }] : []),
    eth_getTransactionByHash: () => ({ input: '0x' + data, to: A }),
    eth_getTransactionReceipt: () => ({ status: '0x1', logs: [{ address: A, logIndex: '0x0' }] }) });
  const r = await chain().reconcile({ ...order(), created_at: new Date(10000 * 1000).toISOString() });
  assert.equal(r.state, 'settled'); assert.equal(r.tx, H);
});

test('P4 the background sweeper never stores an error object as delivered goods', async () => {
  const orders = fresh(); orders.create(order()); orders.update('ord_1', { status: 'paid' });
  const gate = makeGate({ orders, fac: null });
  await gate.sweep({ olderThanMs: -1e12, produceFor: () => async () => ({ error: 'data missing' }) });
  assert.notEqual(orders.get('ord_1').status, 'delivered');
  assert.match(orders.get('ord_1').last_error, /error instead of goods/);
  orders.close();
});

test('P5 an automatic refund whose tx is not visible is NEVER discarded and re-prepared while its nonce can still land', async () => {
  const orders = fresh(); orders.create(order()); orders.update('ord_1', { status: 'refund_due', refund_due_at: new Date().toISOString() });
  let prepares = 0; const broadcasts = [];
  const gate = makeGate({ orders, fac: null,
    chain: { verifyRefund: async () => ({ ok: false, unknown: true, reason: 'unknown transaction' }), accountNonce: async () => 0, findRefund: async () => ({ untagged: [] }), findTransfer: async () => null },
    refunder: { address: A, prepare: async () => { const n = prepares++; return { tx: '0x' + String(n).padStart(64, '0'), raw: 'signed' + n, nonce: n }; }, broadcast: async (raw) => broadcasts.push(raw) } });
  for (let i = 0; i < 3; i++) await gate.sweep({ produceFor: () => null });
  assert.equal(prepares, 1, 'one refund prepared');
  assert.deepEqual([...new Set(broadcasts)], ['signed0'], 'only the same signed bytes are re-broadcast');
  assert.equal(orders.get('ord_1').status, 'refund_sent');
  orders.close();
});

test('P5 nonce consumed by ANOTHER tx and no matching transfer on chain → only then a replacement refund', async () => {
  const orders = fresh(); orders.create(order()); orders.update('ord_1', { status: 'refund_due', refund_due_at: new Date().toISOString() });
  let prepares = 0;
  const gate = makeGate({ orders, fac: null,
    chain: { verifyRefund: async () => ({ ok: false, unknown: true, reason: 'unknown transaction' }), accountNonce: async () => 5, findRefund: async () => ({ untagged: [] }), findTransfer: async () => null },
    refunder: { address: A, prepare: async () => { const n = prepares++; return { tx: '0x' + String(n).padStart(64, '0'), raw: 'signed' + n, nonce: n }; }, broadcast: async () => {} } });
  await gate.sweep({ produceFor: () => null });        // prepare #0
  await gate.sweep({ produceFor: () => null });        // nonce 0 used elsewhere, no transfer → abandon #0
  assert.equal(orders.get('ord_1').status, 'refund_due');
  assert.match(orders.get('ord_1').refund_history, /abandoned/);
  // … and if the transfer IS found (our refund landed, its receipt was just not visible): refunded, no second refund
  const o2 = fresh(); o2.create(order()); o2.update('ord_1', { status: 'refund_due', refund_due_at: new Date().toISOString() });
  let p2 = 0;
  const g2 = makeGate({ orders: o2, fac: null,
    chain: { verifyRefund: async () => ({ ok: false, unknown: true, reason: 'x' }), accountNonce: async () => 5, findRefund: async () => ({ untagged: [] }), findTransfer: async () => ({ tx: H, block: 9 }) },
    refunder: { address: A, prepare: async () => ({ tx: '0x' + String(p2++).padStart(64, '0'), raw: 'r', nonce: 0 }), broadcast: async () => {} } });
  await g2.sweep({ produceFor: () => null }); await g2.sweep({ produceFor: () => null }); await g2.sweep({ produceFor: () => null });
  assert.equal(o2.get('ord_1').status, 'refunded'); assert.equal(o2.get('ord_1').refund_tx, H); assert.equal(p2, 1, 'never a second refund');
  orders.close(); o2.close();
});

test('P5/D2 one automatic refund in flight at a time (the hot wallet nonce is never raced)', async () => {
  const orders = fresh();
  for (const id of ['ord_1', 'ord_2', 'ord_3']) { orders.create(order(id)); orders.update(id, { status: 'refund_due', refund_due_at: new Date().toISOString() }); }
  let prepares = 0;
  const gate = makeGate({ orders, fac: null, chain: { verifyRefund: async () => ({ ok: false, pending: true }), accountNonce: async () => 0, findRefund: async () => ({ untagged: [] }), findTransfer: async () => null },
    refunder: { address: A, prepare: async () => ({ tx: '0x' + String(prepares++).padStart(64, '0'), raw: 'r' + prepares, nonce: 0 }), broadcast: async () => {} } });
  await gate.sweep({ produceFor: () => null });
  assert.equal(prepares, 1);
  assert.equal(['ord_1', 'ord_2', 'ord_3'].filter((id) => orders.get(id).status === 'refund_sent').length, 1);
  orders.close();
});

test('P6 the same refund tx in another letter case cannot refund a second order', async () => {
  const orders = fresh();
  for (const id of ['ord_1', 'ord_2']) { orders.create(order(id)); orders.update(id, { status: 'refund_due', refund_due_at: new Date(0).toISOString() }); }
  const gate = makeGate({ orders, fac: null, chain: { verifyRefund: async () => ({ ok: true, block: 1, amount: '20', from: A }) } });
  await gate.claimRefund('ord_1'); await gate.claimRefund('ord_2');
  await gate.recordRefund('ord_1', H);
  await assert.rejects(gate.recordRefund('ord_2', '0x' + H.slice(2).toUpperCase()), /already recorded/);
  assert.equal(orders.get('ord_2').status, 'refund_manual');
  orders.close();
});

test('P7 two writers on one order: a status transition is applied once (conditional update); manual claim excludes the auto refunder', async () => {
  const orders = fresh(); orders.create(order()); orders.update('ord_1', { status: 'paid' });
  const gates = [makeGate({ orders, fac: null }), makeGate({ orders, fac: null })];
  await Promise.all(gates.map((g) => g.sweep({ olderThanMs: -1e12, produceFor: () => async () => { await new Promise((r) => setTimeout(r, 10)); return { goods: true }; } })));
  const o = orders.get('ord_1'); assert.equal(o.status, 'delivered'); assert.equal(o.attempts, 1, 'delivered once');
  // an operator claim and the automatic refunder cannot both take one refund
  orders.update('ord_1', { status: 'refund_due', refund_due_at: new Date().toISOString() });
  let prepares = 0;
  const auto = makeGate({ orders, fac: null, chain: { verifyRefund: async () => ({ ok: false, pending: true }), accountNonce: async () => 0, findRefund: async () => ({ untagged: [] }) }, refunder: { address: A, prepare: async () => ({ tx: '0x' + String(++prepares).padStart(64, '0'), raw: 'r', nonce: 0 }), broadcast: async () => {} } });
  await gates[0].claimRefund('ord_1');
  await auto.sweep({ produceFor: () => null });
  assert.equal(prepares, 0, 'the automatic refunder skips a claimed refund');
  await assert.rejects(gates[1].claimRefund('ord_1'), /not refund_due/);
  orders.close();
});

test('P8 refused but the authorization can still execute → kept (refused), never failed / deleted', async () => {
  const orders = fresh(); orders.create(order());
  const gate = makeGate({ orders, fac: async () => ({ success: false, error: 'temporarily refused' }), chain: { reconcile: async () => ({ state: 'unsettled', final: false, reason: 'not mined yet' }) } });
  await gate.sweep({ olderThanMs: -1e12, produceFor: () => async () => ({}) });
  assert.equal(orders.get('ord_1').status, 'refused');
  // later it executes after all (someone else relayed it): the sweeper finds it and delivers
  const g2 = makeGate({ orders, fac: async () => { throw new Error('must not re-submit'); }, chain: { reconcile: async () => ({ state: 'settled', tx: H, block: 7 }) } });
  await g2.sweep({ olderThanMs: -1e12, produceFor: () => async () => ({ goods: 1 }) });
  assert.equal(orders.get('ord_1').status, 'delivered'); assert.equal(orders.get('ord_1').tx, H);
  orders.close();
});

test('P9 a manual refund must be a transfer AFTER the obligation, and from an allowed sender when configured', async () => {
  const receipt = (from) => ({ status: '0x1', blockNumber: '0x1', logs: [{ address: T, topics: [TOPIC.TRANSFER, pad(from), pad(A)], data: '0x' + word(20) }] });
  rpc({ eth_getTransactionReceipt: () => receipt(B), eth_getBlockByNumber: () => ({ timestamp: '0x' + (1000).toString(16) }) });
  const c = chain();
  assert.equal((await c.verifyRefund({ tx: H, to: A, minAmount: '20', notBefore: 2000 })).ok, false, 'older than the obligation');
  assert.equal((await c.verifyRefund({ tx: H, to: A, minAmount: '20', notBefore: 500, allowedFrom: [T] })).ok, false, 'not from an allowed sender');
  const v = await c.verifyRefund({ tx: H, to: A, minAmount: '20', notBefore: 500, allowedFrom: [B] });
  assert.equal(v.ok, true); assert.equal(v.from.toLowerCase(), B.toLowerCase());
  // several small transfers do not add up to a refund
  rpc({ eth_getTransactionReceipt: () => ({ status: '0x1', blockNumber: '0x1', logs: [10, 10].map((n) => ({ address: T, topics: [TOPIC.TRANSFER, pad(B), pad(A)], data: '0x' + word(n) })) }), eth_getBlockByNumber: () => ({ timestamp: '0x' + (1000).toString(16) }) });
  assert.equal((await chain().verifyRefund({ tx: H, to: A, minAmount: '20', notBefore: 0 })).ok, false);
});

test('P10 safeFetch never reaches loopback / metadata through IPv6 spellings of IPv4', async () => {
  for (const ip of ['::ffff:7f00:1', '::ffff:127.0.0.1', '::127.0.0.1', '::ffff:0:7f00:1', '::ffff:a9fe:a9fe', '2002:7f00:1::', '64:ff9b::7f00:1', 'fe80::1']) assert.equal(isPrivateIP(ip), true, ip);
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111', '::ffff:808:808']) assert.equal(isPrivateIP(ip), false, ip);
  const server = http.createServer((_q, r) => r.end('loopback reached'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::127.0.0.1]']) await assert.rejects(safeFetch(`http://${host}:${server.address().port}/`), /blocked/, host);
  } finally { await new Promise((r) => server.close(r)); }
});

test('P11 an automatic refund is paid only after the chain has answered "not refunded yet": if the lookup fails, nothing is paid', async () => {
  const orders = openOrders(':memory:'); const A = '0x' + 'a'.repeat(40);
  orders.create({ id: 'ord_' + '1'.repeat(32), payment_key: 'k11', payload_hash: 'h11', resource: 'r', payer: A, amount: '20', scheme: 'exact', payment: JSON.stringify({ paymentPayload: { scheme: 'exact', payload: { authorization: { from: A } } }, paymentRequirements: {} }) });
  orders.update('ord_' + '1'.repeat(32), { status: 'refund_due', refund_to: A, refund_due_at: new Date().toISOString() });
  let prepares = 0;
  for (const findRefund of [async () => { throw new Error('RPC down'); }, undefined]) {
    const gate = makeGate({ orders, fac: null, chain: { verifyRefund: async () => ({ ok: false, pending: true }), accountNonce: async () => 0, ...(findRefund ? { findRefund } : {}) },
      refunder: { address: A, prepare: async () => ({ tx: '0x' + String(++prepares).padStart(64, '0'), raw: 'r', nonce: 0 }), broadcast: async () => {} } });
    await gate.sweep({ produceFor: () => null });
  }
  assert.equal(prepares, 0, 'no refund prepared while the chain cannot say whether it was already paid');
  assert.equal(orders.get('ord_' + '1'.repeat(32)).status, 'refund_due', 'the debt is kept');
});
