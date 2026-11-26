// Does the mail server verify the RPC's TLS certificate? A fake RPC on 127.0.0.1 presents a self-signed certificate.
// At startup the server resolves ENS names over the RPC (ENS_BOOTSTRAP_NAMES). Untrusted cert → it must send nothing; trusted → it works.
import https from 'node:https'; import { spawn } from 'node:child_process'; import { readFileSync, rmSync } from 'node:fs';
const SERVER = process.argv[2]; let fail = 0; const ok = (m, c) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
async function run(extraEnv) {
  let calls = 0;
  const rpc = https.createServer({ key: readFileSync('rpc.key'), cert: readFileSync('rpc.crt') }, (req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      const msgs = [].concat(JSON.parse(b || '[]')); calls += msgs.length;
      const out = msgs.map((m) => ({ jsonrpc: '2.0', id: m.id, result: m.method === 'eth_chainId' ? '0x1b62c' : m.method === 'net_version' ? '112172' : '0x' + '0'.repeat(64) }));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(JSON.parse(b)) ? out : out[0]));
    });
  });
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  rmSync('s3store.json', { force: true });
  const p = spawn(process.execPath, ['-r', './s3stub.cjs', SERVER], { env: { ...process.env, PORT: '43102', S3_STUB_FILE: 's3store.json', AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x',
    DFMI_RPC: `https://127.0.0.1:${rpc.address().port}`, ENS_REGISTRY: '0x' + '11'.repeat(20), ENS_RESOLVER: '0x' + '22'.repeat(20), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', (d) => (log += d)); p.stderr.on('data', (d) => (log += d));
  await new Promise((r) => setTimeout(r, 4000));
  p.kill(); rpc.close(); return { calls, log };
}
const bad = await run({});
ok(`untrusted certificate: the server sends nothing to that RPC (got ${bad.calls} JSON-RPC calls)`, bad.calls === 0);
const good = await run({ NODE_EXTRA_CA_CERTS: new URL('./rpc.crt', import.meta.url).pathname });
ok(`trusted certificate: the server still uses the RPC (got ${good.calls} JSON-RPC calls)`, good.calls > 0);
const health = good.log.includes('ENS Bootstrap');
ok('server started and ran its ENS bootstrap', health);
console.log(fail ? `${fail} FAILED` : 'all passed'); process.exit(fail ? 1 : 0);
