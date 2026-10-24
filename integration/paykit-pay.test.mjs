// paykit-pay.test.mjs — exercise the ACTUAL paykit session-signing path (paykit/src/pay.mjs --session) end-to-end
// on a local EVM: pay.mjs runs as a real subprocess, reads nonce+generation from the deployed wallet, signs the
// Pay, and POSTs to an HTTP facilitator that submits the real pay() on-chain. LOCAL-EVM ONLY — not production.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, shutdown } from './evmlib.mjs';

after(async () => { await shutdown(); });
const PAY_MJS = new URL('../paykit/src/pay.mjs', import.meta.url).pathname;

function facilitatorServer(env) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const pl = JSON.parse(body).paymentPayload.payload;
        const a = pl.authorization;
        const r = await (await env.wallet.connect(env.owner).pay(pl.sessionKey, a.to, a.amount, a.nonce, a.deadline, pl.signature)).wait();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, transaction: r.hash, blockNumber: r.blockNumber, payer: pl.wallet }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.shortMessage ?? e.message }));
      }
    });
  });
}

test('[local-EVM] paykit pay.mjs --session signs with generation and settles on-chain', { timeout: 30_000 }, async () => {
  const env = await makeEnv({ variant: 'v1' });
  const fac = facilitatorServer(env);
  await new Promise(r => fac.listen(0, r));
  const facUrl = `http://127.0.0.1:${fac.address().port}`;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'paykit-pay-'));
    const cfgPath = join(dir, 'paykit.config.json');
    writeFileSync(cfgPath, JSON.stringify({ chain: 'eip155:112172', chainId: 112172, rpc: env.url, token: env.tokenAddr, symbol: 'dUSD', decimals: 6, facilitator: facUrl, store: './invoices.json' }));
    const payee = '0x00000000000000000000000000000000000000F1';
    const out = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [PAY_MJS, '--session', env.walletAddr, payee, '0.2'],
        { env: { ...process.env, SESSION_KEY: env.sessionKey.privateKey, PAYKIT_CONFIG: cfgPath, PAY_FORCE: '1' } });
      let so = '', se = '';
      c.stdout.on('data', d => so += String(d)); c.stderr.on('data', d => se += String(d));
      c.on('exit', code => resolve({ code, so, se })); c.on('error', reject);
    });
    assert.equal(out.code, 0, `pay.mjs exited 0 (stderr tail: ${out.se.slice(-300)})`);
    const parsed = JSON.parse(out.so);
    assert.match(parsed.tx_hash, /^0x[0-9a-fA-F]{64}$/, 'printed a settlement tx hash');
    assert.equal((await env.token.balanceOf(payee)).toString(), '200000', 'payee received 0.2 on-chain');
    assert.equal((await env.wallet.sessionNonce(env.sessionKey.address)).toString(), '1', 'nonce advanced');
    assert.equal((await env.wallet.sessions(env.sessionKey.address)).spent.toString(), '200000', 'spent recorded');
  } finally {
    await new Promise(r => fac.close(r));
  }
});
