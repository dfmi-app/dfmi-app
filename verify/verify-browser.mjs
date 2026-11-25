#!/usr/bin/env node
// verify-browser.mjs — check dfmi's browser wallets in a real browser (Chromium, through Playwright), against the live
// pages. Nothing is paid. It uses a throwaway key and a virtual passkey authenticator (Chrome's WebAuthn test API),
// and at the end removes the test passkey and signs the throwaway address out everywhere.
//
// For each page it drives the real UI, then reads EVERYTHING the page can persist — localStorage, sessionStorage,
// IndexedDB, Cache Storage, cookies — and checks that no private key or recovery phrase is in it:
//   wallet.dfmi.app    import a key with a password → stored only as an encrypted keystore → after a reload the key
//                      is locked; a wrong password does not unlock it; the right one does.
//   identity.dfmi.app  sign in with a keystore file → sign the challenge → register a passkey (the browser's own
//                      WebAuthn, verified by the server) → sign out → every token left in storage is refused by the
//                      server → sign in with the passkey → reload: the key is locked.
//
//   npm install && npx playwright install chromium
//   node verify-browser.mjs                 # headless
//   node verify-browser.mjs --headed        # watch it
// Exit code 0 = every check passed. Real-device passkey prompts are a manual check: see README.md.
import crypto from 'node:crypto';
import { Wallet, LangEn } from 'ethers';
import { chromium } from 'playwright';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const WALLET_URL = arg('--wallet', 'https://wallet.dfmi.app/');
const IDENTITY_URL = arg('--identity', 'https://identity.dfmi.app/');
const API = arg('--api', 'https://exchange.dfmi.me').replace(/\/$/, '');
const HEADED = process.argv.includes('--headed');

let pass = 0, fail = 0;
function check(name, ok, detail = '') { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the mail API, for clean-up and for testing left-over tokens ----------
async function call(method, path, body, token) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', origin: new URL(IDENTITY_URL).origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
async function apiSignIn(w) { const c = (await call('POST', '/api/auth/challenge', { wallet: w.address })).j; return (await call('POST', '/api/auth/verify', { challengeId: c.challengeId, signature: await w.signMessage(c.message) })).j.token; }

// ---------- read everything a page can persist ----------
async function dumpStorage(page) {
  const inPage = await page.evaluate(async () => {
    const kv = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; };
    const out = { local: kv(localStorage), session: kv(sessionStorage), idb: [], caches: [] };
    try {
      for (const { name } of (await indexedDB.databases())) {
        const db = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
        for (const store of db.objectStoreNames) {
          const rows = await new Promise((ok) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => ok([]); });
          out.idb.push({ db: name, store, rows: JSON.stringify(rows) });
        }
        db.close();
      }
    } catch (e) { out.idbError = String(e); }
    try { for (const n of await caches.keys()) { const c = await caches.open(n); for (const req of await c.keys()) out.caches.push({ cache: n, url: req.url, body: await (await c.match(req)).text() }); } } catch (e) {}
    return out;
  });
  inPage.cookies = await page.context().cookies();
  return inPage;
}
const allText = (d) => [...Object.entries(d.local), ...Object.entries(d.session)].map(([k, v]) => `${k}=${v}`)
  .concat(d.idb.map((x) => x.rows), d.caches.map((x) => x.body), d.cookies.map((c) => `${c.name}=${c.value}`)).join('\n');
const WORDS = new Set(LangEn.wordlist().getWords?.() ?? Array.from({ length: 2048 }, (_, i) => LangEn.wordlist().getWord(i)));
/** every way a key could leak: the known key, any 32-byte hex that is the key of a wallet this page knows, a phrase */
function findSecrets(dump, { knownKeys = [], addresses = [] }) {
  const text = allText(dump), hits = [];
  for (const k of knownKeys) if (text.toLowerCase().includes(k.toLowerCase().replace(/^0x/, ''))) hits.push('the private key itself');
  const addrs = new Set(addresses.map((a) => a.toLowerCase()));
  for (const m of text.matchAll(/(?:0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g)) {
    try { if (addrs.has(new Wallet('0x' + m[1]).address.toLowerCase())) hits.push(`a private key matching a wallet address (${m[1].slice(0, 6)}…)`); } catch {}
  }
  const words = text.toLowerCase().split(/[^a-z]+/);
  for (let i = 0, run = 0; i < words.length; i++) { run = WORDS.has(words[i]) ? run + 1 : 0; if (run >= 12) { hits.push('a 12-word phrase'); break; } }
  return [...new Set(hits)];
}
/** keystores found in storage: entries that hold an encrypted JSON keystore */
function keystoresIn(dump) {
  const found = [];
  const visit = (v) => {
    if (typeof v === 'string') { if (v.includes('ciphertext')) { try { visit(JSON.parse(v)); } catch {} } return; }
    if (Array.isArray(v)) return v.forEach(visit);
    if (v && typeof v === 'object') {
      const c = v.crypto || v.Crypto;
      if (c && c.ciphertext && v.address) found.push({ address: '0x' + String(v.address).replace(/^0x/, ''), kdf: c.kdf, cipher: c.cipher });
      else Object.values(v).forEach(visit);
    }
  };
  for (const v of [...Object.values(dump.local), ...Object.values(dump.session), ...dump.idb.map((x) => x.rows)]) visit(v);
  return found;
}

const browser = await chromium.launch({ headless: !HEADED });
const W = Wallet.createRandom();
const PW = 'verify-' + crypto.randomBytes(9).toString('base64url');
console.log(`dfmi browser wallet verification · Chromium ${browser.version()}\nthrowaway wallet ${W.address}\n`);
let passkeyCleanup = false;

try {
  // ======================= wallet.dfmi.app =======================
  console.log(`-- ${WALLET_URL} --`);
  {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(WALLET_URL, { waitUntil: 'load' });
    await page.evaluate(() => showPage('import'));
    await page.fill('#import-key', W.privateKey); await page.fill('#import-key-pw', PW); await page.fill('#import-key-label', 'verify-browser');
    await page.click('button[onclick^="importKey"]');
    await page.waitForFunction(() => /Saved|已保存|✓/.test(document.getElementById('import-key-result')?.textContent || ''), null, { timeout: 60_000 });
    check('the key is imported through the page and unlocked in this tab', await page.evaluate(() => typeof wallet !== 'undefined' && wallet?.address) === W.address);
    await page.fill('#import-key', ''); // what the user typed is not storage, but clear it like a careful user would
    let d = await dumpStorage(page);
    const ks = keystoresIn(d);
    check('it is stored only as an encrypted keystore', ks.some((k) => k.address.toLowerCase() === W.address.toLowerCase()), ks.map((k) => `${k.kdf}/${k.cipher}`).join(', ') || 'no keystore found');
    let leaks = findSecrets(d, { knownKeys: [W.privateKey], addresses: [W.address] });
    check('no private key or recovery phrase in localStorage, sessionStorage, IndexedDB, Cache Storage or cookies', leaks.length === 0, leaks.join('; ') || `${Object.keys(d.local).length} local, ${Object.keys(d.session).length} session, ${d.idb.length} IndexedDB stores, ${d.caches.length} cached, ${d.cookies.length} cookies`);
    await page.reload({ waitUntil: 'load' }); await sleep(1500);
    check('after a reload the key is locked (not in the page)', await page.evaluate(() => typeof wallet === 'undefined' || !wallet));
    // unlock through the page's own unlock dialog
    // the page opens its unlock dialog by itself after a reload (one saved wallet: no list to choose from)
    await page.waitForSelector('#unlock-modal:not(.hidden) #unlock-pw', { timeout: 10_000 });
    if (await page.$('#unlock-wallet-list .ws-item')) await page.click('#unlock-wallet-list .ws-item');
    await page.fill('#unlock-pw', PW + 'x'); await page.click('#unlock-modal .btn-primary');
    await page.waitForFunction(() => document.getElementById('unlock-err').style.display === 'block', null, { timeout: 60_000 }).catch(() => {});
    check('a wrong password does not unlock it', await page.evaluate(() => (typeof wallet === 'undefined' || !wallet) && document.getElementById('unlock-err').style.display === 'block'));
    await page.fill('#unlock-pw', PW); await page.click('#unlock-modal .btn-primary');
    await page.waitForFunction(() => typeof wallet !== 'undefined' && !!wallet, null, { timeout: 60_000 }).catch(() => {});
    check('the right password unlocks it', await page.evaluate(() => typeof wallet !== 'undefined' && wallet?.address) === W.address);
    d = await dumpStorage(page); leaks = findSecrets(d, { knownKeys: [W.privateKey], addresses: [W.address] });
    check('…and unlocking writes no key to storage either', leaks.length === 0, leaks.join('; '));
    check('no script errors on the page', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ======================= identity.dfmi.app =======================
  console.log(`\n-- ${IDENTITY_URL} (real WebAuthn, virtual authenticator) --`);
  {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(IDENTITY_URL, { waitUntil: 'load' });
    const keystore = await W.encrypt(PW);
    await page.click('#btnPick');
    await page.click('.dkl-opt[data-k="file"]');
    await page.setInputFiles('.dkl-fi', { name: 'verify-keystore.json', mimeType: 'application/json', buffer: Buffer.from(keystore) });
    await page.fill('.dkl-fpw', PW); await page.click('.dkl-funlock');
    await page.waitForFunction(() => !document.querySelector('.dkl-ov'), null, { timeout: 60_000 });
    await page.waitForFunction(() => !document.getElementById('btnSign').disabled, null, { timeout: 10_000 });
    await page.click('#btnSign');
    await page.waitForFunction(() => typeof auth !== 'undefined' && auth && auth.method === 'signature', null, { timeout: 20_000 });
    check('key sign-in through the page (keystore file + password, challenge signed in the page)', await page.evaluate(() => auth.address) === W.address);
    await page.click('#btnPkReg');
    await page.waitForFunction(() => /good|err/.test(document.getElementById('m-pk').className), null, { timeout: 30_000 });
    const reg = await page.evaluate(() => ({ cls: document.getElementById('m-pk').className, text: document.getElementById('m-pk').textContent }));
    check('the browser creates a passkey; the server verifies and stores it', /good/.test(reg.cls), reg.text);
    passkeyCleanup = /good/.test(reg.cls);
    const creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
    check('…the private part stays in the authenticator (one credential, bound to identity.dfmi.app)', creds.length === 1 && creds[0].rpId === new URL(IDENTITY_URL).hostname, creds.map((c) => c.rpId).join(','));

    let d = await dumpStorage(page);
    const ks = keystoresIn(d);
    let leaks = findSecrets(d, { knownKeys: [W.privateKey], addresses: [W.address] });
    check('no private key or recovery phrase in any browser storage (signed in)', leaks.length === 0, leaks.join('; ') || `${ks.length} encrypted keystore(s) kept, ${Object.keys(d.local).length} local, ${Object.keys(d.session).length} session, ${d.idb.length} IndexedDB stores`);
    check('the passkey itself is not in browser storage', !/passkey/i.test(Object.keys(d.local).join(' ')) && !allText(d).includes(creds[0]?.credentialId?.replace(/=+$/, '') || '§'));

    // sign out: every token-looking value the page left behind must be refused by the server
    await page.click('#btnOut'); await sleep(800);
    d = await dumpStorage(page);
    const candidates = new Set();
    for (const v of [...Object.values(d.local), ...Object.values(d.session), ...d.cookies.map((c) => c.value)]) {
      for (const m of String(v).matchAll(/[A-Za-z0-9_\-.]{24,}/g)) if (!/^0x[0-9a-f]{40}$/i.test(m[0]) && m[0].length < 400) candidates.add(m[0]);
    }
    let accepted = 0;
    for (const t of candidates) if ((await call('GET', '/api/session', undefined, t)).status === 200) accepted++;
    check('after sign out, no token left in browser storage still works on the server', accepted === 0, `${candidates.size} token-like value(s) tried, ${accepted} accepted`);
    check('…and the page itself holds no key', await page.evaluate(() => (typeof key === 'undefined' || !key) && (typeof auth === 'undefined' || !auth)));

    // passkey sign-in, in the real browser
    await page.click('#btnPkLogin');
    await page.waitForFunction(() => /good|err/.test(document.getElementById('m-pk').className) && !/Requesting|Touch/.test(document.getElementById('m-pk').textContent), null, { timeout: 30_000 });
    const pk = await page.evaluate(() => ({ method: auth && auth.method, address: auth && auth.address, token: exch && exch.token, text: document.getElementById('m-pk').textContent }));
    check('passkey sign-in in the browser: the server verifies it and issues a session for the right address', pk.method === 'passkey' && pk.address === W.address, pk.text);
    check('…the session works on the server', !!pk.token && (await call('GET', '/api/session', undefined, pk.token)).status === 200);
    d = await dumpStorage(page); leaks = findSecrets(d, { knownKeys: [W.privateKey], addresses: [W.address] });
    check('no private key in any browser storage (passkey session)', leaks.length === 0, leaks.join('; '));
    await page.reload({ waitUntil: 'load' }); await sleep(1500);
    check('after a reload no key is in the page', await page.evaluate(() => typeof key === 'undefined' || !key || !key.wallet));
    check('no script errors on the page', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }
} catch (e) { check('the run completed', false, e.message.split('\n')[0]); }
finally {
  console.log('\n-- clean up --');
  try {
    const tok = await apiSignIn(W);
    if (passkeyCleanup) {
      const list = await call('GET', '/api/auth/passkeys', undefined, tok);
      const ids = (list.j.passkeys || list.j.items || []).map((p) => p.id);
      let removed = 0; for (const id of ids) if ((await call('DELETE', `/api/auth/passkeys/${encodeURIComponent(id)}`, undefined, tok)).status === 200) removed++;
      check('the test passkey is removed from the server', ids.length > 0 && removed === ids.length, `${removed}/${ids.length}`);
    }
    await call('POST', '/api/auth/logout-all', {}, tok);
    check('all sessions of the throwaway address are ended', (await call('GET', '/api/session', undefined, tok)).status === 401);
  } catch (e) { check('clean up', false, e.message); }
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
