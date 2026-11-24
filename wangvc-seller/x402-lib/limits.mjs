// limits.mjs — resource limits for the public x402 endpoints (facilitator + every seller). Zero deps.
//
//   hardenServer(server)          header/request/keep-alive timeouts; createServer({maxHeaderSize}) caps headers (→ 431)
//   makeLimiter(opts)             per-IP token-bucket rate limit + global and per-IP concurrency caps
//   readBody(req, res, max)       reads a body up to max bytes; past the limit it STOPS reading, answers 413 and
//                                 closes the connection (Content-Length over the limit is refused before reading)
//   decodePaymentHeader(h, max)   size-capped base64 → JSON for X-PAYMENT
//   safeFetch(url, opts)          outbound fetch with SSRF guard (checked at connect time, so DNS rebinding and
//                                 redirects are covered), a response size cap and a total timeout
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';

export const SERVER_OPTS = { maxHeaderSize: 16 * 1024 }; // pass to createServer(SERVER_OPTS, handler)

export function hardenServer(server, { headersTimeout = 10_000, requestTimeout = 30_000, keepAliveTimeout = 5_000, maxRequestsPerSocket = 100 } = {}) {
  server.headersTimeout = headersTimeout;     // slowloris: whole header block must arrive within this
  server.requestTimeout = requestTimeout;     // whole request (headers + body) must arrive within this
  server.keepAliveTimeout = keepAliveTimeout;
  server.maxRequestsPerSocket = maxRequestsPerSocket;
  return server;
}

// nginx sets X-Real-IP; only believe it when the TCP peer is a trusted proxy. If your proxy connects from a
// non-loopback address, add that address to TRUST_PROXY_IPS (comma-separated).
const TRUSTED = () => new Set(String(process.env.TRUST_PROXY_IPS || '127.0.0.1,::1,::ffff:127.0.0.1').split(',').map((s) => s.trim()).filter(Boolean));
let _trusted = null;
export function clientIp(req) {
  _trusted ??= TRUSTED();
  const peer = req.socket?.remoteAddress || '';
  if (_trusted.has(peer) || _trusted.has(peer.replace(/^::ffff:/, ''))) {
    // only X-Real-IP: our nginx always overwrites it with $remote_addr; X-Forwarded-For's first entry is client-controlled
    const h = String(req.headers['x-real-ip'] || '').trim();
    if (h) return h;
  }
  return peer || 'unknown';
}
/** RATE_EXEMPT_IPS: callers (our own sellers) that skip the per-IP rate bucket; concurrency caps still apply. */
export function isExempt(ip) { return String(process.env.RATE_EXEMPT_IPS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(ip); }

const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));

/**
 * Token bucket per IP (ratePerMin refill, burst capacity) + concurrency caps.
 * acquire(ip) → { ok:true, release() } | { ok:false, status, error, retryAfter }
 */
export function makeLimiter({ ratePerMin = 60, burst = 20, maxConcurrent = 16, maxConcurrentPerIp = 4, maxTracked = 10_000, now = () => Date.now() } = {}) {
  const buckets = new Map(); // ip -> { tokens, at }
  const inflightIp = new Map();
  let inflight = 0;
  const refill = ratePerMin / 60_000;
  function take(ip) {
    const t = now();
    let b = buckets.get(ip);
    if (!b) {
      if (buckets.size >= maxTracked) { // bounded memory: drop the stalest entries
        for (const [k, v] of buckets) { if (t - v.at > 60_000 * burst / Math.max(ratePerMin, 1) || buckets.size >= maxTracked) buckets.delete(k); if (buckets.size < maxTracked * 0.9) break; }
      }
      b = { tokens: burst, at: t }; buckets.set(ip, b);
    }
    b.tokens = Math.min(burst, b.tokens + (t - b.at) * refill); b.at = t;
    if (b.tokens < 1) return Math.ceil((1 - b.tokens) / refill / 1000);
    b.tokens -= 1; return 0;
  }
  return {
    acquire(ip, { cost = true } = {}) {
      if (cost) { const wait = take(ip); if (wait) return { ok: false, status: 429, error: 'rate limit exceeded', retryAfter: wait }; }
      if (inflight >= maxConcurrent) return { ok: false, status: 503, error: 'server busy (too many concurrent requests)', retryAfter: 2 };
      const mine = inflightIp.get(ip) || 0;
      if (mine >= maxConcurrentPerIp) return { ok: false, status: 429, error: 'too many concurrent requests from this client', retryAfter: 2 };
      inflight++; inflightIp.set(ip, mine + 1);
      let done = false;
      return { ok: true, release() { if (done) return; done = true; inflight--; const m = (inflightIp.get(ip) || 1) - 1; if (m <= 0) inflightIp.delete(ip); else inflightIp.set(ip, m); } };
    },
    stats: () => ({ inflight, trackedIps: buckets.size }),
  };
}

/** limiter from env with a prefix, e.g. limiterFromEnv('SELLER', env) reads SELLER_RATE_PER_MIN etc. */
export function limiterFromEnv(prefix, env = process.env, d = {}) {
  const g = (k) => env[`${prefix}_${k}`] ?? process.env[`${prefix}_${k}`];
  return makeLimiter({
    ratePerMin: num(g('RATE_PER_MIN'), d.ratePerMin ?? 60), burst: num(g('BURST'), d.burst ?? 20),
    maxConcurrent: num(g('MAX_CONCURRENT'), d.maxConcurrent ?? 16), maxConcurrentPerIp: num(g('MAX_CONCURRENT_PER_IP'), d.maxConcurrentPerIp ?? 4),
  });
}

/** Run handler under the limiter; rejects with 429/503 + Retry-After without touching the body. */
export async function limited(limiter, req, res, handler, { cors = {} } = {}) {
  const ip = clientIp(req);
  const slot = limiter.acquire(ip, { cost: !isExempt(ip) });
  if (!slot.ok) {
    res.writeHead(slot.status, { 'content-type': 'application/json', 'retry-after': String(slot.retryAfter), ...cors });
    res.end(JSON.stringify({ error: slot.error, retryAfter: slot.retryAfter }));
    req.resume?.(); // drain nothing large: body readers never attached; let the socket close normally
    return;
  }
  res.once('close', slot.release); res.once('finish', slot.release);
  try { return await handler(); } finally { /* released on finish/close (covers handlers that respond later) */ }
}

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/**
 * Read at most maxBytes. Over the limit: stop reading immediately, send 413 with Connection: close and
 * destroy the socket once the response is flushed (the rest of the upload is never buffered).
 */
export function readBody(req, res, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const tooBig = () => {
      req.removeAllListeners('data'); req.pause();
      if (!res.headersSent) {
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close', 'access-control-allow-origin': '*' });
        // stop reading (socket stays paused), half-close so the client can still read the 413, then drop it.
        // Destroying at once would RST the connection and the client — still uploading — often never sees the 413.
        res.end(JSON.stringify({ error: `request body too large (max ${maxBytes} bytes)` }), () => {
          const sock = req.socket; if (!sock) return;
          sock.end(); setTimeout(() => sock.destroy(), 2000).unref();
        });
      } else req.socket?.destroy();
      reject(new HttpError(413, 'body too large'));
    };
    const cl = Number(req.headers['content-length']);
    if (Number.isFinite(cl) && cl > maxBytes) return tooBig();
    const chunks = []; let n = 0; let over = false;
    req.on('data', (c) => { if (over) return; n += c.length; if (n > maxBytes) { over = true; return tooBig(); } chunks.push(c); });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!over) reject(e); });
  });
}
export async function readJson(req, res, maxBytes) {
  const b = await readBody(req, res, maxBytes);
  try { return b.length ? JSON.parse(b.toString('utf8')) : {}; } catch { throw new HttpError(400, 'invalid JSON body'); }
}

/** X-PAYMENT: cap the raw header size before decoding (default 8 KiB; a real payload is ~0.6–1 KiB). */
export function decodePaymentHeader(header, maxLen = 8192) {
  const h = String(header || '');
  if (h.length > maxLen) throw new HttpError(431, `X-PAYMENT header too large (max ${maxLen} chars)`);
  let o;
  try { o = JSON.parse(Buffer.from(h, 'base64').toString('utf8')); } catch { throw new HttpError(400, 'X-PAYMENT is not base64-encoded JSON'); }
  if (!o || typeof o !== 'object' || !o.payload || typeof o.payload !== 'object') throw new HttpError(400, 'X-PAYMENT has no payload');
  return o;
}

// ---------- SSRF-safe outbound fetch ----------
function privateV4(p) {
  if (p[0] === 0 || p[0] === 127 || p[0] === 10) return true;
  if (p[0] === 169 && p[1] === 254) return true;                 // link-local + cloud metadata (169.254.169.254)
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;    // CGNAT
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true; // benchmarking
  if (p[0] === 192 && p[1] === 0 && (p[2] === 0 || p[2] === 2)) return true; // IETF protocol assignments, TEST-NET-1
  if (p[0] === 198 && p[1] === 51 && p[2] === 100) return true;  // TEST-NET-2
  if (p[0] === 203 && p[1] === 0 && p[2] === 113) return true;   // TEST-NET-3
  if (p[0] >= 224) return true;                                   // multicast / reserved / broadcast
  return false;
}
/** IPv6 text → 8 hextets (numbers), accepting every textual form (compressed, embedded dotted quad); null if invalid */
function hextets(a) {
  let s = String(a).toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, ''); // brackets, zone id
  const dq = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dq) { const b = dq.slice(1).map(Number); s = s.slice(0, dq.index) + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16); }
  const halves = s.split('::'); if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [], tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const h = [...head, ...Array(fill).fill('0'), ...tail].map((x) => parseInt(x, 16));
  return h.length === 8 && h.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? h : null;
}
/**
 * true for every address a public-URL fetch must never reach: loopback, private, link-local (incl. cloud metadata),
 * CGNAT, reserved — in IPv4 and in EVERY IPv6 spelling of them. IPv4 embedded in IPv6 (mapped ::ffff:a.b.c.d /
 * ::ffff:7f00:1, compatible ::a.b.c.d, translated ::ffff:0:a.b.c.d, 6to4 2002:AABB:CCDD::) is checked as IPv4;
 * transition / relay ranges that can reach internal space (NAT64, Teredo) are refused outright.
 */
export function isPrivateIP(ip) {
  if (net.isIPv4(ip)) return privateV4(ip.split('.').map(Number));
  if (!net.isIPv6(String(ip).replace(/^\[|\]$/g, '').replace(/%.*$/, ''))) return true; // not an IP we understand → refuse
  const h = hextets(ip); if (!h) return true;
  const v4 = (hi, lo) => privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const zero = (n) => h.slice(0, n).every((x) => x === 0);
  if (zero(8)) return true;                                                     // ::
  if (zero(7) && h[7] === 1) return true;                                       // ::1
  if (zero(5) && h[5] === 0xffff) return v4(h[6], h[7]);                        // ::ffff:a.b.c.d  (mapped)
  if (zero(4) && h[4] === 0xffff && h[5] === 0) return v4(h[6], h[7]) || true;  // ::ffff:0:a.b.c.d (translated): never needed
  if (zero(6)) return true;                                                     // ::a.b.c.d (deprecated compatible)
  if (h[0] === 0x64 && h[1] === 0xff9b) return true;                            // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (h[0] === 0x2002) return v4(h[1], h[2]);                                   // 6to4 embeds an IPv4
  if (h[0] === 0x2001 && h[1] === 0) return true;                               // Teredo 2001::/32
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true;                           // documentation
  if (h[0] === 0x100 && zero(4)) return true;                                   // discard-only 100::/64
  if ((h[0] & 0xfe00) === 0xfc00) return true;                                  // ULA fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0) return true;    // link-local fe80::/10, site-local fec0::/10
  if ((h[0] & 0xff00) === 0xff00) return true;                                  // multicast
  return false;
}

function guardedLookup(allowPrivate) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!allowPrivate) {
        const bad = addrs.find((a) => isPrivateIP(a.address));
        if (bad) { const e = new Error(`blocked: ${hostname} resolves to a private/loopback address`); e.code = 'EBLOCKED'; return cb(e); }
      }
      if (options && options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

/**
 * safeFetch(url, { method, headers, body, maxBytes=1MiB, timeoutMs=15s, maxRedirects=3, allowPrivate=false, overflow:'error'|'truncate' })
 * → { status, headers, url, truncated, bytes, text(), json() }
 */
export async function safeFetch(rawUrl, { method = 'GET', headers = {}, body = null, maxBytes = 1 << 20, timeoutMs = 15_000, maxRedirects = 3, allowPrivate = false, overflow = 'error' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let url = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u; try { u = new URL(url); } catch { throw new HttpError(400, 'invalid URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'only http/https URLs are allowed');
    if (u.username || u.password) throw new HttpError(400, 'credentials in URL are not allowed');
    if (!allowPrivate && net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateIP(u.hostname.replace(/^\[|\]$/g, ''))) throw new HttpError(400, 'blocked: private/loopback address');
    const r = await once(u, { method, headers, body, maxBytes, deadline, allowPrivate, overflow });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      url = new URL(r.headers.location, u).href;
      if (r.status === 303) { method = 'GET'; body = null; }
      continue;
    }
    return r;
  }
  throw new HttpError(502, 'too many redirects');
}

function once(u, { method, headers, body, maxBytes, deadline, allowPrivate, overflow }) {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new HttpError(504, 'outbound request timed out'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers: { 'accept-encoding': 'identity', ...headers }, lookup: guardedLookup(allowPrivate), agent: false }, (res) => {
      const declared = Number(res.headers['content-length']);
      if (overflow === 'error' && Number.isFinite(declared) && declared > maxBytes) { res.destroy(); req.destroy(); return reject(new HttpError(502, `upstream response too large (${declared} > ${maxBytes} bytes)`)); }
      const chunks = []; let n = 0; let truncated = false;
      res.on('data', (c) => {
        if (truncated) return;
        if (n + c.length > maxBytes) {
          if (overflow === 'error') { res.destroy(); req.destroy(); return reject(new HttpError(502, `upstream response too large (> ${maxBytes} bytes)`)); }
          chunks.push(c.subarray(0, maxBytes - n)); n = maxBytes; truncated = true; res.destroy(); finish(); return;
        }
        chunks.push(c); n += c.length;
      });
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, url: u.href, truncated, bytes: buf.length,
          text: () => buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) }); };
      res.on('end', finish);
      res.on('error', (e) => { if (!done) { clearTimeout(timer); reject(e); } });
    });
    const timer = setTimeout(() => { req.destroy(new HttpError(504, 'outbound request timed out')); }, left);
    req.on('error', (e) => { clearTimeout(timer); reject(e.code === 'EBLOCKED' ? new HttpError(400, e.message) : e); });
    if (body) req.write(body);
    req.end();
  });
}
