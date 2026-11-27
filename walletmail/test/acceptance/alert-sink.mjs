// Acceptance D — dedicated test alert receiver: records every alert POSTed by the drill monitor with its receive time.
//   node alert-sink.mjs <port> <out.jsonl>
import http from 'node:http'; import fs from 'node:fs';
const [PORT, OUT] = process.argv.slice(2);
http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
  fs.appendFileSync(OUT, JSON.stringify({ receivedAt: new Date().toISOString(), body: (() => { try { return JSON.parse(b); } catch { return b; } })() }) + '\n'); res.end('ok'); }); })
  .listen(+PORT, '127.0.0.1');
