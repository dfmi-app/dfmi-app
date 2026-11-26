/**
 * WalletMail API Server — v2.0
 *
 * Published copy of the server behind email.dfmi.me (25 November 2026). It differs from the deployed file only in
 * configuration defaults: no built-in contract addresses (ENS_REGISTRY, ENS_RESOLVER), no built-in address-to-name
 * mapping (KNOWN_ENS_MAPPINGS), and the names checked at startup come from ENS_BOOTSTRAP_NAMES.
 *
 * Rewritten to align with WalletMail-Master-Spec-v1.0:
 *   - Challenge/response authentication (single-use challenges)
 *   - EIP-712 typed-data message signing
 *   - Off-chain content storage with hash verification
 *   - Separate internal (on-chain + email) vs external (email-only) send paths
 *   - message_id-based deduplication
 *   - Rate limiting, audit logging
 *   - No private-key storage
 *
 * Endpoints (Spec §15):
 *   POST /api/auth/challenge       — issue a single-use challenge
 *   POST /api/auth/verify          — verify signed challenge, return session
 *   POST /api/auth/passkey/register/options|verify — add a passkey to the signed-in address (server-verified WebAuthn)
 *   POST /api/auth/passkey/login/options|verify    — sign in with a passkey, return session
 *   GET  /api/auth/passkeys, DELETE /api/auth/passkeys/:id — list / remove this address's passkeys
 *   POST /api/messages/prepare     — compute hashes, nonce, message_id
 *   POST /api/messages/content     — upload off-chain content
 *   POST /api/messages/send-internal  — on-chain record + email copy
 *   POST /api/messages/send-external  — SES email only
 *   GET  /api/messages/inbox       — fetch inbox
 *   GET  /api/messages/sent        — fetch sent
 *   GET  /api/messages/:messageId  — fetch single message
 *   POST /api/messages/:messageId/read  — mark read
 *   POST /api/messages/:messageId/star  — toggle star
 *   POST /api/resolve-recipient    — resolve wallet / ENS / email
 *   GET  /api/health               — health check
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { ethers } = require('ethers');
const { v4: uuidv4 } = require('uuid');
const { simpleParser } = require('mailparser');
const webauthn = require('@simplewebauthn/server');

// ─── Config ───
const PORT          = process.env.PORT || 3001;
const EMAIL_DOMAIN  = process.env.EMAIL_DOMAIN || 'dfmi.me';
const S3_BUCKET     = process.env.S3_INCOMING_BUCKET || 'amazon-s3-ses';
const AWS_REGION    = process.env.AWS_REGION || 'us-east-1';
const DFMI_RPC      = process.env.DFMI_RPC || 'https://ethereum.dfmi.app:8541';
const ENS_REGISTRY  = process.env.ENS_REGISTRY || '';   // the dfmi name registry contract (set in .env)
const ENS_RESOLVER  = process.env.ENS_RESOLVER || '';   // fallback resolver contract (set in .env)
const MAILBOX_ADDR  = process.env.MAILBOX_ADDRESS || '';
const CHAIN_ID      = Number(process.env.CHAIN_ID) || 112172;
const TLD           = process.env.TLD || 'dfmi';
// '1' rejects a bad signature; anything else only records the outcome.
const SIG_ENFORCE   = process.env.SIGNATURE_ENFORCE === '1';
const PREPARED_TTL  = Number(process.env.PREPARED_TTL_MS) || 30 * 60 * 1000;
const SESSION_TTL   = 12 * 60 * 60 * 1000;  // 12 hours
const CHALLENGE_TTL = 2 * 60 * 1000;   // 2 min
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX    = 10;

// TLS certificates are verified (Node's default). The RPC (ethereum.dfmi.app, Let's Encrypt) and AWS have valid
// certificates; NODE_TLS_REJECT_UNAUTHORIZED=0 used to be set here, which would have accepted any certificate.

// ─── AWS Clients ───
const ses = new SESv2Client({ region: AWS_REGION });
const s3  = new S3Client({ region: AWS_REGION });

// ─── dFMI Provider ───
let dfmiProvider;
try { dfmiProvider = new ethers.JsonRpcProvider(DFMI_RPC); } catch {}

// ─── Express App ───
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ─── In-Memory Stores (replace with Redis/Postgres in production) ───
const challenges   = new Map();
const sessions     = new Map();
const senderNonces = new Map();  // address → next nonce
const contents     = new Map();  // messageId → { subject, body, hashes... }
const readState    = new Map();  // `addr:emailId` → true
const starState    = new Map();
const sentEmails   = new Map();  // address → []
const rateLimits   = new Map();
const auditLog     = [];
const ensCache     = new Map();

// Pre-populate known ENS mappings
const KNOWN_MAPPINGS = (() => { try { return JSON.parse(process.env.KNOWN_ENS_MAPPINGS || '{}'); } catch { return {}; } })(); // { address: name }
for (const [addr, name] of Object.entries(KNOWN_MAPPINGS)) {
  ensCache.set(addr.toLowerCase(), name);
}

// ─── ENS Helpers ───
function ensNamehash(name) {
  let node = '0x' + '00'.repeat(32);
  if (!name) return node;
  for (const label of name.split('.').reverse()) {
    const h = ethers.keccak256(ethers.toUtf8Bytes(label));
    node = ethers.keccak256(ethers.concat([node, h]));
  }
  return node;
}

async function resolveNameToAddress(name) {
  if (!dfmiProvider) { console.log(`[ENS] Skip resolve "${name}" — no provider`); return null; }
  const full = name.endsWith('.dfmi') ? name : name + '.dfmi';
  const node = ensNamehash(full);
  try {
    console.log(`[ENS] Resolving "${full}" namehash=${node}`);

    // Step 1: Query the registry to find the resolver for this name
    let resolverAddr = ENS_RESOLVER; // fallback to configured resolver
    if (ENS_REGISTRY) {
      try {
        const registry = new ethers.Contract(ENS_REGISTRY,
          ['function resolver(bytes32) view returns (address)',
           'function owner(bytes32) view returns (address)'], dfmiProvider);
        const regResolver = await registry.resolver(node);
        console.log(`[ENS] Registry resolver for "${full}": ${regResolver}`);
        if (regResolver && regResolver !== ethers.ZeroAddress) {
          resolverAddr = regResolver;
        } else {
          // Check if owner exists (name is registered but no resolver set)
          const owner = await registry.owner(node);
          console.log(`[ENS] Registry owner for "${full}": ${owner}`);
        }
      } catch (e) { console.warn(`[ENS] Registry query failed for "${full}":`, e.message); }
    }

    if (!resolverAddr) { console.log(`[ENS] No resolver found for "${full}"`); return null; }

    // Step 2: Query the resolver for the address
    console.log(`[ENS] Using resolver ${resolverAddr} for "${full}"`);
    const resolver = new ethers.Contract(resolverAddr,
      ['function addr(bytes32) view returns (address)'], dfmiProvider);
    const addr = await resolver.addr(node);
    console.log(`[ENS] Result for "${full}": ${addr}`);
    if (addr && addr !== ethers.ZeroAddress) {
      ensCache.set(addr.toLowerCase(), full.replace('.dfmi', ''));
      return addr.toLowerCase();
    }
  } catch (e) { console.warn(`[ENS] Error resolving "${full}":`, e.message); }
  return null;
}

function addressToEmail(address) {
  const name = ensCache.get(address.toLowerCase());
  return name ? `${name}@${EMAIL_DOMAIN}` : `${address.toLowerCase()}@${EMAIL_DOMAIN}`;
}

function emailToAddress(email) {
  const local = email.split('@')[0];
  if (local.startsWith('0x') && local.length === 42) return local.toLowerCase();
  for (const [addr, name] of ensCache) { if (name === local) return addr; }
  return null;
}

// ─── Audit Logger ───
function audit(event, address, details = {}) {
  auditLog.push({ timestamp: Date.now(), event, address, details });
  if (auditLog.length > 10000) auditLog.splice(0, auditLog.length - 10000);
  console.log(`[AUDIT] ${event} | ${address} | ${JSON.stringify(details)}`);
}

// ─── Rate Limiter ───
function checkRateLimit(address) {
  const now = Date.now();
  const e = rateLimits.get(address);
  if (!e || now - e.windowStart > RATE_LIMIT_WINDOW) {
    rateLimits.set(address, { count: 1, windowStart: now });
    return true;
  }
  if (e.count >= RATE_LIMIT_MAX) return false;
  e.count++;
  return true;
}

// ─── Message signatures (Spec §14) ───
// Must stay byte-identical to the client's MESSAGE_TYPES / eip712Domain().
const MESSAGE_TYPES = {
  Message: [
    { name: 'sender',             type: 'address' },
    { name: 'recipientType',      type: 'uint8'   },
    { name: 'recipientValueHash', type: 'bytes32' },
    { name: 'subjectHash',        type: 'bytes32' },
    { name: 'bodyHash',           type: 'bytes32' },
    { name: 'timestamp',          type: 'uint256' },
    { name: 'nonce',              type: 'uint256' },
    { name: 'payloadVersion',     type: 'uint256' },
    { name: 'messageId',          type: 'bytes32' }
  ]
};
function eip712Domain() {
  return { name: 'WalletMail', version: '1', chainId: CHAIN_ID, verifyingContract: MAILBOX_ADDR };
}

// What /prepare handed the client is what the client signed, so keep it and
// rebuild the digest from it rather than from anything /send-internal supplies.
const prepared = new Map();  // messageId → payload

async function persistPrepared(messageId, rec) {
  prepared.set(messageId, rec);
  setTimeout(() => prepared.delete(messageId), PREPARED_TTL);
  try {
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `prepared/${messageId}.json`, Body: JSON.stringify(rec), ContentType: 'application/json' }));
  } catch (e) { console.warn('S3 prepared persist failed:', e.message); }
}

async function loadPrepared(messageId) {
  if (prepared.has(messageId)) return prepared.get(messageId);
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: `prepared/${messageId}.json` }));
    const rec = JSON.parse(await streamToString(data.Body));
    if (rec && rec.messageId) { prepared.set(messageId, rec); return rec; }
  } catch (e) {
    if (e.name !== 'NoSuchKey' && e.name !== 'NotFound') console.warn('S3 prepared load failed:', e.message);
  }
  return null;
}

// A Mailbox address means the client signs EIP-712 typed data; without one it
// falls back to a personal signature. Mirror both branches exactly.
function recoverMessageSigner(rec, signature) {
  if (MAILBOX_ADDR) {
    return ethers.verifyTypedData(eip712Domain(), MESSAGE_TYPES, {
      sender:             ethers.getAddress(rec.sender),
      recipientType:      rec.recipientType,
      recipientValueHash: rec.recipientValueHash,
      subjectHash:        rec.subjectHash,
      bodyHash:           rec.bodyHash,
      timestamp:          rec.timestamp,
      nonce:              rec.nonce,
      payloadVersion:     rec.payloadVersion,
      messageId:          rec.messageId
    }, signature);
  }
  return ethers.verifyMessage('WalletMail:' + rec.messageId + ':' + rec.timestamp, signature);
}

async function checkMessageSignature(walletAddress, messageId, signature) {
  const rec = await loadPrepared(messageId);
  if (!rec) return 'no_prepare_record';
  if (rec.sender.toLowerCase() !== walletAddress.toLowerCase()) return 'sender_mismatch';
  if (!signature) return 'missing_signature';
  try {
    const recovered = recoverMessageSigner(rec, signature);
    return recovered.toLowerCase() === walletAddress.toLowerCase() ? 'ok' : 'signer_mismatch';
  } catch (e) { return 'malformed_signature'; }
}

// ─── Session Storage ───
// The in-memory Map is only a cache; S3 holds the record, so a restart does not
// sign everyone out. A token is read back from S3 at most once per process.
function sessionKey(token) { return `sessions/${token}.json`; }

async function persistSession(token, entry) {
  try {
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: sessionKey(token), Body: JSON.stringify(entry), ContentType: 'application/json' }));
  } catch (e) { console.warn('S3 session persist failed:', e.message); }
}

async function dropSession(token) {
  sessions.delete(token);
  try { await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: sessionKey(token) })); } catch (e) {}
}

async function loadSession(token) {
  if (sessions.has(token)) return sessions.get(token);
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: sessionKey(token) }));
    const entry = JSON.parse(await streamToString(data.Body));
    if (!entry || !entry.address || !entry.expiresAt) return null;
    sessions.set(token, entry);
    return entry;
  } catch (e) {
    if (e.name !== 'NoSuchKey' && e.name !== 'NotFound') console.warn('S3 session load failed:', e.message);
    return null;
  }
}

// ─── Session revocation ───
// "Sign out on all devices" stores a cut-off time per address (S3 + memory): every session
// of that address issued at or before it is rejected, including ones loaded after a restart.
const revokedBefore = new Map();  // address → ms (0 = none)
function revokedKey(addr) { return `sessions-revoked/${addr}.json`; }
async function getRevokedBefore(addr) {
  if (revokedBefore.has(addr)) return revokedBefore.get(addr);
  let t = 0;
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: revokedKey(addr) }));
    t = Number(JSON.parse(await streamToString(data.Body)).before) || 0;
  } catch (e) {
    // Fail closed: if S3 cannot answer, cache nothing and let the request fail.
    if (e.name !== 'NoSuchKey' && e.name !== 'NotFound') throw e;
  }
  revokedBefore.set(addr, t);
  return t;
}
async function revokeAllSessions(addr) {
  const before = Date.now();
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: revokedKey(addr), Body: JSON.stringify({ before }), ContentType: 'application/json' }));
  revokedBefore.set(addr, before);
  for (const [tok, e] of sessions) if (e.address === addr) sessions.delete(tok);
  return before;
}
// Sessions created before issuedAt was recorded: derive it from the fixed TTL.
const sessionIssuedAt = (s) => Number(s.issuedAt) || (Number(s.expiresAt) - SESSION_TTL);
// After session state is restored from a backup (an object-store rollback brings back sessions that had been signed
// out, and loses "sign out on all devices" markers written later), set SESSIONS_NOT_BEFORE to the restore time (ISO
// or ms): every session issued before it is refused, so no revoked session can come back. Users sign in again.
const SESSIONS_NOT_BEFORE = (() => {
  const v = String(process.env.SESSIONS_NOT_BEFORE || '').trim(); if (!v) return 0;
  const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(t)) { console.error(`SESSIONS_NOT_BEFORE is not a time: ${v}`); process.exit(1); }
  return t;
})();

// ─── Auth Middleware ───
async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const s = await loadSession(token);
    if (!s) return res.status(401).json({ error: 'Not authenticated' });
    if (Date.now() > s.expiresAt) { await dropSession(token); return res.status(401).json({ error: 'Session expired' }); }
    if (sessionIssuedAt(s) <= SESSIONS_NOT_BEFORE) { await dropSession(token); return res.status(401).json({ error: 'Session revoked' }); }
    if (sessionIssuedAt(s) <= await getRevokedBefore(s.address)) { await dropSession(token); return res.status(401).json({ error: 'Session revoked' }); }
    req.walletAddress = s.address;
    req.sessionToken  = token;
    req.emailAddress  = addressToEmail(s.address);
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ═══════════════════════════════════════════════════════════════════════
// AUTH (Spec §10, §15)
// ═══════════════════════════════════════════════════════════════════════

async function issueSession(address, extra = {}) {
  const token = uuidv4();
  const now = Date.now();
  const session = { address, issuedAt: now, expiresAt: now + SESSION_TTL, ...extra };
  sessions.set(token, session);
  await persistSession(token, session);
  // Best-effort in-process expiry; loadSession re-checks after a restart.
  setTimeout(() => { dropSession(token); }, SESSION_TTL + 1000);
  return token;
}

app.post('/api/auth/challenge', (req, res) => {
  const { wallet } = req.body;
  if (!wallet || !wallet.startsWith('0x')) return res.status(400).json({ error: 'Invalid wallet' });

  const id = uuidv4();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + CHALLENGE_TTL;
  const nonce = crypto.randomBytes(16).toString('hex');

  const message = [
    'WalletMail Authentication',
    `Domain: ${EMAIL_DOMAIN}`,
    `Wallet: ${wallet.toLowerCase()}`,
    `Challenge: ${id}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date(issuedAt).toISOString()}`,
    `Expires: ${new Date(expiresAt).toISOString()}`
  ].join('\n');

  challenges.set(id, { wallet: wallet.toLowerCase(), issuedAt, expiresAt, used: false, message });
  setTimeout(() => challenges.delete(id), CHALLENGE_TTL + 1000);
  audit('challenge_issued', wallet.toLowerCase(), { challengeId: id });
  res.json({ challengeId: id, message, expiresAt });
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const { challengeId, signature, ensName } = req.body;
    if (!challengeId || !signature) return res.status(400).json({ error: 'Missing fields' });

    const ch = challenges.get(challengeId);
    if (!ch) return res.status(401).json({ error: 'Challenge not found or expired' });
    if (ch.used) return res.status(401).json({ error: 'Challenge already used' });
    if (Date.now() > ch.expiresAt) { challenges.delete(challengeId); return res.status(401).json({ error: 'Challenge expired' }); }

    const recovered = ethers.verifyMessage(ch.message, signature);
    if (recovered.toLowerCase() !== ch.wallet) {
      audit('auth_failed', ch.wallet, { reason: 'sig_mismatch' });
      return res.status(401).json({ error: 'Signature verification failed' });
    }

    ch.used = true;

    if (ensName) {
      ensCache.set(ch.wallet, ensName.replace('.dfmi', ''));
    } else {
      try { await resolveNameToAddress(ch.wallet); } catch {}
    }

    const token = await issueSession(ch.wallet);
    audit('auth_success', ch.wallet);
    res.json({ token, address: ch.wallet, email: addressToEmail(ch.wallet), expiresIn: Math.floor(SESSION_TTL / 1000) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PASSKEYS (WebAuthn), verified on this server
// ═══════════════════════════════════════════════════════════════════════
// A passkey is added to an address by a session that already proved that address with a wallet signature.
// Every ceremony uses a challenge this server generated (single use, CHALLENGE_TTL), and the browser's response
// is verified here: origin, RP ID, challenge, user presence, signature against the stored public key, and the
// signature counter. Only then is a session issued. Passkeys are per RP ID, so each page that offers them is
// listed in PASSKEY_RPS as "rpId=origin" (comma-separated); the request's Origin header selects the entry.
const PASSKEY_RPS = String(process.env.PASSKEY_RPS || 'identity.dfmi.app=https://identity.dfmi.app').split(',')
  .map((x) => x.trim()).filter(Boolean).map((x) => { const [rpId, origin] = x.split('='); return { rpId, origin }; });
const PASSKEY_MAX_PER_ADDRESS = 10;
const passkeyChallenges = new Map();   // id → { kind: 'reg'|'auth', challenge, rpId, origin, address?, expiresAt, used }
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const passkeyRecKey = (credId) => `passkeys/${crypto.createHash('sha256').update(String(credId)).digest('hex')}.json`;
const passkeyIdxKey = (addr) => `passkeys-by-address/${addr}.json`;

// adding or removing passkeys needs a session proved by a wallet signature: a passkey session cannot change passkeys
async function walletSession(req, res) {
  const s = await loadSession(req.sessionToken);
  if (s && s.method === 'passkey') { res.status(403).json({ error: 'Sign in with your wallet to add or remove passkeys' }); return false; }
  return true;
}
function passkeyRp(req) {
  const origin = req.headers.origin;
  return PASSKEY_RPS.find((r) => r.origin === origin) || null;
}
async function s3Json(key) {
  try { const d = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key })); return JSON.parse(await streamToString(d.Body)); }
  catch (e) { if (e.name === 'NoSuchKey' || e.name === 'NotFound') return null; throw e; }
}
const s3PutJson = (key, obj) => s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: JSON.stringify(obj), ContentType: 'application/json' }));
async function passkeyIndex(addr) { return (await s3Json(passkeyIdxKey(addr))) || []; }
function newPasskeyChallenge(entry) {
  if (passkeyChallenges.size > 5000) for (const [k, v] of passkeyChallenges) if (Date.now() > v.expiresAt) passkeyChallenges.delete(k);
  if (passkeyChallenges.size > 5000) return null;
  const id = uuidv4();
  passkeyChallenges.set(id, { ...entry, expiresAt: Date.now() + CHALLENGE_TTL, used: false });
  setTimeout(() => passkeyChallenges.delete(id), CHALLENGE_TTL + 1000);
  return id;
}
// single use: marked used before any verification, so a response can never be tried twice
function takePasskeyChallenge(id, kind) {
  const ch = passkeyChallenges.get(id);
  if (!ch || ch.kind !== kind) return { error: 'Challenge not found or expired' };
  if (ch.used) return { error: 'Challenge already used' };
  ch.used = true;
  if (Date.now() > ch.expiresAt) { passkeyChallenges.delete(id); return { error: 'Challenge expired' }; }
  return { ch };
}

app.post('/api/auth/passkey/register/options', requireAuth, async (req, res) => {
  try {
    const rp = passkeyRp(req);
    if (!rp) return res.status(400).json({ error: 'Passkeys are not enabled for this origin' });
    if (!(await walletSession(req, res))) return;
    if (!checkRateLimit(req.walletAddress)) return res.status(429).json({ error: 'Too many requests' });
    const existing = (await passkeyIndex(req.walletAddress)).filter((p) => p.rpId === rp.rpId);
    if (existing.length >= PASSKEY_MAX_PER_ADDRESS) return res.status(409).json({ error: `At most ${PASSKEY_MAX_PER_ADDRESS} passkeys per address` });
    const options = await webauthn.generateRegistrationOptions({
      rpName: 'dfmi', rpID: rp.rpId, userName: req.walletAddress, userDisplayName: req.walletAddress,
      userID: new TextEncoder().encode(req.walletAddress), attestationType: 'none', timeout: CHALLENGE_TTL,
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      supportedAlgorithmIDs: [-7, -257],
    });
    const challengeId = newPasskeyChallenge({ kind: 'reg', challenge: options.challenge, rpId: rp.rpId, origin: rp.origin, address: req.walletAddress });
    if (!challengeId) return res.status(503).json({ error: 'Busy, try again' });
    res.json({ challengeId, options });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/passkey/register/verify', requireAuth, async (req, res) => {
  try {
    const { challengeId, response } = req.body || {};
    if (!challengeId || !response || typeof response.id !== 'string') return res.status(400).json({ error: 'Missing fields' });
    if (!(await walletSession(req, res))) return;
    const t = takePasskeyChallenge(challengeId, 'reg');
    if (t.error) return res.status(401).json({ error: t.error });
    const ch = t.ch;
    if (ch.address !== req.walletAddress) return res.status(401).json({ error: 'Challenge was issued to another address' });
    let v;
    try {
      v = await webauthn.verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: ch.origin, expectedRPID: ch.rpId, requireUserVerification: false });
    } catch (e) { audit('passkey_register_failed', ch.address, { reason: e.message }); return res.status(401).json({ error: 'Passkey registration could not be verified' }); }
    if (!v.verified) { audit('passkey_register_failed', ch.address, { reason: 'not verified' }); return res.status(401).json({ error: 'Passkey registration could not be verified' }); }
    const c = v.registrationInfo.credential;
    const prior = await s3Json(passkeyRecKey(c.id));
    if (prior) return res.status(409).json({ error: 'This passkey is already registered' });
    const now = new Date().toISOString();
    const rec = { id: c.id, address: ch.address, rpId: ch.rpId, publicKey: b64u(c.publicKey), counter: c.counter, transports: c.transports || [],
      deviceType: v.registrationInfo.credentialDeviceType, backedUp: v.registrationInfo.credentialBackedUp, createdAt: now, lastUsedAt: null };
    await s3PutJson(passkeyRecKey(c.id), rec);
    const idx = (await passkeyIndex(ch.address)).filter((p) => p.id !== c.id);
    idx.push({ id: c.id, rpId: rec.rpId, transports: rec.transports, deviceType: rec.deviceType, backedUp: rec.backedUp, createdAt: now });
    await s3PutJson(passkeyIdxKey(ch.address), idx);
    audit('passkey_registered', ch.address, { rpId: ch.rpId, credential: c.id.slice(0, 16) });
    res.json({ ok: true, passkey: { id: c.id, rpId: rec.rpId, createdAt: now, deviceType: rec.deviceType, backedUp: rec.backedUp } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/passkey/login/options', async (req, res) => {
  try {
    const rp = passkeyRp(req);
    if (!rp) return res.status(400).json({ error: 'Passkeys are not enabled for this origin' });
    let address = null, allow = [];
    if (req.body && req.body.address) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(req.body.address)) return res.status(400).json({ error: 'Invalid address' });
      address = req.body.address.toLowerCase();
      allow = (await passkeyIndex(address)).filter((p) => p.rpId === rp.rpId).map((p) => ({ id: p.id, transports: p.transports }));
      if (!allow.length) return res.status(404).json({ error: 'No passkey is registered for this address' });
    }
    const options = await webauthn.generateAuthenticationOptions({ rpID: rp.rpId, allowCredentials: allow, userVerification: 'preferred', timeout: CHALLENGE_TTL });
    const challengeId = newPasskeyChallenge({ kind: 'auth', challenge: options.challenge, rpId: rp.rpId, origin: rp.origin, address });
    if (!challengeId) return res.status(503).json({ error: 'Busy, try again' });
    res.json({ challengeId, options });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/passkey/login/verify', async (req, res) => {
  try {
    const { challengeId, response } = req.body || {};
    if (!challengeId || !response || typeof response.id !== 'string') return res.status(400).json({ error: 'Missing fields' });
    const t = takePasskeyChallenge(challengeId, 'auth');
    if (t.error) return res.status(401).json({ error: t.error });
    const ch = t.ch;
    const rec = await s3Json(passkeyRecKey(response.id));
    if (!rec || rec.id !== response.id || rec.rpId !== ch.rpId) return res.status(401).json({ error: 'Unknown passkey' });
    if (ch.address && rec.address !== ch.address) return res.status(401).json({ error: 'Passkey belongs to another address' });
    let v;
    try {
      v = await webauthn.verifyAuthenticationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: ch.origin, expectedRPID: ch.rpId,
        credential: { id: rec.id, publicKey: new Uint8Array(Buffer.from(rec.publicKey, 'base64url')), counter: rec.counter, transports: rec.transports }, requireUserVerification: false });
    } catch (e) { audit('passkey_auth_failed', rec.address, { reason: e.message }); return res.status(401).json({ error: 'Passkey could not be verified' }); }
    if (!v.verified) { audit('passkey_auth_failed', rec.address, { reason: 'not verified' }); return res.status(401).json({ error: 'Passkey could not be verified' }); }
    rec.counter = v.authenticationInfo.newCounter; rec.lastUsedAt = new Date().toISOString();
    await s3PutJson(passkeyRecKey(rec.id), rec);   // the counter must be stored before a session is issued
    const token = await issueSession(rec.address, { method: 'passkey' });
    audit('auth_success', rec.address, { method: 'passkey', rpId: rec.rpId });
    res.json({ token, address: rec.address, email: addressToEmail(rec.address), expiresIn: Math.floor(SESSION_TTL / 1000), method: 'passkey',
      passkey: { id: rec.id, rpId: rec.rpId, userVerified: v.authenticationInfo.userVerified } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/passkeys', requireAuth, async (req, res) => {
  try { res.json({ passkeys: await passkeyIndex(req.walletAddress) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/auth/passkeys/:id', requireAuth, async (req, res) => {
  try {
    if (!(await walletSession(req, res))) return;
    const id = String(req.params.id);
    const rec = await s3Json(passkeyRecKey(id));
    if (!rec || rec.address !== req.walletAddress) return res.status(404).json({ error: 'No such passkey' });
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: passkeyRecKey(id) }));
    await s3PutJson(passkeyIdxKey(req.walletAddress), (await passkeyIndex(req.walletAddress)).filter((p) => p.id !== id));
    audit('passkey_removed', req.walletAddress, { credential: id.slice(0, 16) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════
// MESSAGING (Spec §7, §8, §9, §15)
// ═══════════════════════════════════════════════════════════════════════

app.post('/api/messages/prepare', requireAuth, async (req, res) => {
  try {
    const { recipientType, recipientValue, subject, body } = req.body;
    if (!recipientValue || !subject || !body) return res.status(400).json({ error: 'Missing fields' });

    const addr = req.walletAddress;
    // Sync nonce with on-chain contract if available (Spec §14.3: nonce must equal expected)
    let nonce = senderNonces.get(addr) || 0;
    if (dfmiProvider && MAILBOX_ADDR) {
      try {
        const mailbox = new ethers.Contract(MAILBOX_ADDR, ['function getNextNonce(address) view returns (uint256)'], dfmiProvider);
        const chainNonce = Number(await mailbox.getNextNonce(addr));
        if (chainNonce > nonce) nonce = chainNonce;
        senderNonces.set(addr, nonce);
      } catch (e) { console.warn('On-chain nonce check failed:', e.message); }
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const pv = 1;

    const bodyHash    = ethers.keccak256(ethers.toUtf8Bytes(body));
    const subjectHash = ethers.keccak256(ethers.toUtf8Bytes(subject));
    const recipientValueHash = ethers.keccak256(ethers.toUtf8Bytes(recipientValue));

    const coder = ethers.AbiCoder.defaultAbiCoder();
    const metadataHash = ethers.keccak256(coder.encode(
      ['address','uint8','bytes32','bytes32','bytes32','uint256','uint256','uint256'],
      [addr, recipientType === 'ens' ? 1 : 0, recipientValueHash, subjectHash, bodyHash, timestamp, nonce, pv]
    ));
    const messageId = ethers.keccak256(coder.encode(['bytes32'], [metadataHash]));

    senderNonces.set(addr, nonce + 1);
    await persistPrepared(messageId, {
      messageId, sender: addr, recipientType: recipientType === 'ens' ? 1 : 0,
      recipientValueHash, subjectHash, bodyHash, timestamp, nonce, payloadVersion: pv
    });
    audit('message_prepared', addr, { messageId });

    res.json({ messageId, nonce, timestamp, payloadVersion: pv, subjectHash, bodyHash, recipientValueHash, metadataHash });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/messages/content', requireAuth, async (req, res) => {
  try {
    const { messageId, subject, body, recipientValue } = req.body;
    if (!messageId || !subject || !body) return res.status(400).json({ error: 'Missing fields' });

    const subjectHash = ethers.keccak256(ethers.toUtf8Bytes(subject));
    const bodyHash    = ethers.keccak256(ethers.toUtf8Bytes(body));

    const contentKey = `content/${messageId}.json`;
    const payload = JSON.stringify({ messageId, subject, body, recipientValue: recipientValue || '', subjectHash, bodyHash, storedAt: Date.now(), sender: req.walletAddress });

    try {
      await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: contentKey, Body: payload, ContentType: 'application/json' }));
    } catch (e) { console.warn('S3 content upload failed, using in-memory:', e.message); }

    contents.set(messageId, { subject, body, subjectHash, bodyHash, recipientValue: recipientValue || '', sender: req.walletAddress, timestamp: Date.now() });
    audit('content_uploaded', req.walletAddress, { messageId });

    res.json({ stored: true, contentUri: `s3://${S3_BUCKET}/${contentKey}`, subjectHash, bodyHash });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/messages/send-internal', requireAuth, async (req, res) => {
  try {
    const { messageId, recipientWallet, signature, onChainTxHash } = req.body;
    if (!messageId || !recipientWallet) return res.status(400).json({ error: 'Missing messageId or recipientWallet' });
    if (!checkRateLimit(req.walletAddress)) { audit('rate_limited', req.walletAddress); return res.status(429).json({ error: 'Rate limit exceeded' }); }

    // If mailbox is deployed, verify on-chain recording
    if (MAILBOX_ADDR && dfmiProvider && onChainTxHash) {
      try {
        const mailbox = new ethers.Contract(MAILBOX_ADDR, ['function exists(bytes32) view returns (bool)'], dfmiProvider);
        const recorded = await mailbox.exists(messageId);
        if (!recorded) {
          audit('send_internal_rejected', req.walletAddress, { messageId, reason: 'not_on_chain' });
          return res.status(400).json({ error: 'message_id not found on-chain. Record message first.' });
        }
      } catch (e) {
        console.warn('On-chain verification failed (proceeding):', e.message);
      }
    }

    // Verify the signature against what /prepare issued (Spec §14).
    const sigStatus = await checkMessageSignature(req.walletAddress, messageId, signature);
    if (sigStatus !== 'ok') {
      audit('signature_check_failed', req.walletAddress, { messageId, reason: sigStatus, enforced: SIG_ENFORCE });
      if (SIG_ENFORCE) return res.status(400).json({ error: 'Signature verification failed', reason: sigStatus });
    }

    let content = contents.get(messageId);
    // Fall back to S3 if not in memory
    if (!content) {
      try {
        const s3Data = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: `content/${messageId}.json` }));
        const parsed = JSON.parse(await streamToString(s3Data.Body));
        content = { subject: parsed.subject, body: parsed.body, subjectHash: parsed.subjectHash, bodyHash: parsed.bodyHash, recipientValue: parsed.recipientValue || '', sender: parsed.sender, timestamp: parsed.storedAt || Date.now() };
        contents.set(messageId, content);
      } catch (e) { /* not in S3 either */ }
    }
    if (!content) return res.status(400).json({ error: 'Content not uploaded. Call /api/messages/content first.' });

    // On-chain to on-chain: store message for internal delivery, NO email
    // Resolve sender ENS
    const fromEns = ensCache.get(req.walletAddress.toLowerCase());
    // Resolve recipient: could be wallet address, ENS name, or email
    let toWallet = recipientWallet;
    let toEnsName = null;
    const rLower = recipientWallet.toLowerCase();
    if (rLower.startsWith('0x')) {
      toEnsName = ensCache.get(rLower);
    } else if (rLower.endsWith(`@${EMAIL_DOMAIN}`)) {
      // Extract ENS name from email (e.g. admin@dfmi.me -> admin)
      const local = rLower.replace(`@${EMAIL_DOMAIN}`, '');
      toEnsName = local;
      // Try to resolve wallet from ENS
      const resolved = await resolveNameToAddress(local);
      if (resolved) toWallet = resolved;
      else {
        for (const [addr, name] of ensCache) { if (name === local) { toWallet = addr; break; } }
      }
    } else if (rLower.endsWith('.dfmi') || !rLower.includes('@')) {
      // ENS name directly (e.g. admin.dfmi or admin)
      const name = rLower.replace('.dfmi', '');
      toEnsName = name;
      const resolved = await resolveNameToAddress(name);
      if (resolved) toWallet = resolved;
      else {
        for (const [addr, n] of ensCache) { if (n === name) { toWallet = addr; break; } }
      }
    }
    const sentEntry = {
      id: messageId, from: req.walletAddress, fromEmail: fromEns ? `${fromEns}.dfmi` : req.walletAddress,
      to: toWallet, toEmail: toEnsName ? `${toEnsName}.dfmi` : toWallet,
      subject: content.subject, body: content.body, timestamp: Date.now(),
      signature, signatureVerified: sigStatus === 'ok', onChain: !!onChainTxHash, onChainTxHash, internal: true
    };
    if (!sentEmails.has(req.walletAddress)) sentEmails.set(req.walletAddress, []);
    sentEmails.get(req.walletAddress).push(sentEntry);
    // Persist to S3
    try { await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `sent/${req.walletAddress.toLowerCase()}/${messageId}.json`, Body: JSON.stringify(sentEntry), ContentType: 'application/json' })); } catch (e) { console.warn('S3 sent persist failed:', e.message); }

    // Also persist content with recipientValue so inbox scan can find it
    try {
      const contentPayload = JSON.stringify({
        messageId, subject: content.subject, body: content.body,
        recipientValue: toWallet.toLowerCase(),
        subjectHash: content.subjectHash, bodyHash: content.bodyHash,
        storedAt: Date.now(), sender: req.walletAddress
      });
      await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `content/${messageId}.json`, Body: contentPayload, ContentType: 'application/json' }));
    } catch (e) { console.warn('S3 content re-persist failed:', e.message); }

    audit('send_internal', req.walletAddress, { messageId, recipientWallet, onChain: !!onChainTxHash });
    res.json({ sent: true, messageId, internal: true, onChain: !!onChainTxHash });
  } catch (err) { console.error('Send internal error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/messages/send-external', requireAuth, async (req, res) => {
  try {
    const { messageId, recipientEmail, subject, body, signature } = req.body;
    if (!recipientEmail || !subject || !body) return res.status(400).json({ error: 'Missing fields' });
    if (!checkRateLimit(req.walletAddress)) return res.status(429).json({ error: 'Rate limit exceeded' });

    const fid = messageId || `ext-${uuidv4()}`;
    await ses.send(new SendEmailCommand({
      FromEmailAddress: req.emailAddress,
      Destination: { ToAddresses: [recipientEmail] },
      Content: { Simple: {
        Subject: { Data: subject },
        Body: {
          Text: { Data: body },
          Html: { Data: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto"><div style="padding:20px">${body.replace(/\n/g,'<br>')}</div><hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0"><div style="padding:0 20px 20px;font-size:12px;color:#94a3b8"><p>Sent via WalletMail from ${req.walletAddress}</p>${signature?`<p>Sig: ${signature.slice(0,20)}…</p>`:''}</div></div>` }
        }
      }},
      EmailTags: [{ Name: 'wallet', Value: req.walletAddress }, { Name: 'messageId', Value: fid.slice(0,64) }]
    }));

    const sentEntry = {
      id: fid, from: req.walletAddress, fromEmail: req.emailAddress,
      to: recipientEmail, toEmail: recipientEmail, subject, body,
      timestamp: Date.now(), signature, onChain: false, internal: false
    };
    if (!sentEmails.has(req.walletAddress)) sentEmails.set(req.walletAddress, []);
    sentEmails.get(req.walletAddress).push(sentEntry);
    // Persist to S3
    try { await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `sent/${req.walletAddress.toLowerCase()}/${fid}.json`, Body: JSON.stringify(sentEntry), ContentType: 'application/json' })); } catch (e) { console.warn('S3 sent persist failed:', e.message); }

    audit('send_external', req.walletAddress, { messageId: fid, recipientEmail });
    res.json({ sent: true, messageId: fid, fromEmail: req.emailAddress, toEmail: recipientEmail });
  } catch (err) { console.error('Send external error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/messages/inbox', requireAuth, async (req, res) => {
  try {
    const userEmail = req.emailAddress.toLowerCase();
    const walletAddr = req.walletAddress.toLowerCase();
    const emails = [];
    const seenIds = new Set();

    // Build strict alias set — only addresses that belong to THIS wallet
    const aliases = new Set();
    aliases.add(walletAddr);  // raw wallet address
    aliases.add(`${walletAddr}@${EMAIL_DOMAIN}`);  // wallet@dfmi.me
    const ens = ensCache.get(walletAddr);
    if (ens) {
      aliases.add(`${ens}@${EMAIL_DOMAIN}`);  // ens@dfmi.me
      aliases.add(ens);  // bare ens name
      aliases.add(`${ens}.dfmi`);  // ens.dfmi
    }
    // Add the userEmail from auth (addressToEmail result)
    if (userEmail) aliases.add(userEmail);
    console.log(`[Inbox] Wallet: ${walletAddr}, aliases:`, [...aliases]);

    // Load persisted read/star/deleted state from S3
    const deletedIds = new Set();
    try {
      const readListed = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: `state/${walletAddr}/read/`, MaxKeys: 500 }));
      if (readListed.Contents) {
        for (const obj of readListed.Contents) {
          const eid = obj.Key.split('/').pop();
          readState.set(`${walletAddr}:${eid}`, true);
        }
      }
      const starListed = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: `state/${walletAddr}/star/`, MaxKeys: 500 }));
      if (starListed.Contents) {
        for (const obj of starListed.Contents) {
          const eid = obj.Key.split('/').pop();
          const data = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
          const val = await streamToString(data.Body);
          starState.set(`${walletAddr}:${eid}`, val === 'true');
        }
      }
      const deletedListed = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: `state/${walletAddr}/deleted/`, MaxKeys: 500 }));
      if (deletedListed.Contents) {
        for (const obj of deletedListed.Contents) {
          deletedIds.add(obj.Key.split('/').pop());
        }
      }
    } catch (e) { console.warn('S3 state load error:', e.message); }

    // Helper: parse an S3 object into an email entry (always filters by recipient)
    async function parseEmailObject(obj) {
      if (obj.Key.includes('AMAZON_SES_SETUP_NOTIFICATION')) return null;
      try {
        const data = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
        const parsed = await simpleParser(await streamToString(data.Body));

        // Always check that this email is addressed to this wallet owner
        const allRecipients = [
          ...(parsed.to?.value||[]).map(v=>v.address?.toLowerCase()),
          ...(parsed.cc?.value||[]).map(v=>v.address?.toLowerCase())
        ];
        if (!allRecipients.some(a => aliases.has(a))) return null;

        // Skip emails sent BY this wallet owner (those belong in Sent)
        const senderAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
        if (aliases.has(senderAddr)) return null;

        const eid = obj.Key.split('/').pop();
        const wmId = parsed.headers?.get('x-walletmail-id');
        if (wmId && seenIds.has(wmId)) return null;
        if (wmId) seenIds.add(wmId);
        if (seenIds.has(eid)) return null;
        seenIds.add(eid);

        const sk = `${walletAddr}:${eid}`;
        return {
          id: eid, messageId: wmId || null,
          from: parsed.from?.value?.[0]?.address || 'unknown',
          fromName: parsed.from?.value?.[0]?.name || '',
          to: parsed.to?.value?.[0]?.address || userEmail,
          subject: parsed.subject || '(no subject)',
          body: parsed.text || '', html: parsed.html || '',
          timestamp: parsed.date ? parsed.date.getTime() : obj.LastModified.getTime(),
          sentAt: parsed.date ? parsed.date.getTime() : null,
          receivedAt: obj.LastModified ? obj.LastModified.getTime() : null,
          read: !!readState.get(sk), starred: !!starState.get(sk),
          verified: !!wmId, internal: (parsed.from?.value?.[0]?.address||'').endsWith(`@${EMAIL_DOMAIN}`)
        };
      } catch (e) { console.warn('Parse error:', obj.Key, e.message); return null; }
    }

    // 1. Scan raw/ prefix (SES direct S3 delivery) — must match recipients
    try {
      const rawListed = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: 'raw/', MaxKeys: 100 }));
      if (rawListed.Contents) {
        for (const obj of rawListed.Contents.reverse()) {
          const email = await parseEmailObject(obj);
          if (email) emails.push(email);
        }
      }
    } catch (e) { console.warn('Raw scan error:', e.message); }

    // 2. Scan incoming/{wallet}/ prefix (SNS webhook delivery) — already filtered by wallet
    try {
      const incomingListed = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: `incoming/${walletAddr}/`, MaxKeys: 100 }));
      if (incomingListed.Contents) {
        for (const obj of incomingListed.Contents.reverse()) {
          const email = await parseEmailObject(obj);
          if (email) emails.push(email);
        }
      }
    } catch (e) { console.warn('Incoming scan error:', e.message); }

    // 3. Scan content/ prefix for WalletMail internal messages sent to this user
    try {
      const contentListed = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: 'content/', MaxKeys: 100 }));
      if (contentListed.Contents) {
        for (const obj of contentListed.Contents.reverse()) {
          try {
            const data = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
            const raw = await streamToString(data.Body);
            const msg = JSON.parse(raw);
            // Check if this message was sent to this wallet
            const rv = (msg.recipientValue || '').toLowerCase();
            if (rv !== walletAddr && !aliases.has(rv)) continue;
            // Skip messages sent BY this wallet (those go in Sent, not Inbox)
            if ((msg.sender || '').toLowerCase() === walletAddr) continue;
            // Skip if we already have it from raw/ or incoming/
            if (seenIds.has(msg.messageId)) continue;
            seenIds.add(msg.messageId);

            const sk = `${walletAddr}:${msg.messageId}`;
            const senderEns = msg.sender ? ensCache.get(msg.sender.toLowerCase()) : null;
            const recipientEns = ensCache.get(walletAddr);
            emails.push({
              id: msg.messageId, messageId: msg.messageId,
              from: msg.sender || 'unknown',
              fromName: senderEns ? `${senderEns}.dfmi` : (msg.sender || 'unknown'),
              fromEmail: senderEns ? `${senderEns}.dfmi` : (msg.sender || 'unknown'),
              to: walletAddr,
              toEmail: recipientEns ? `${recipientEns}.dfmi` : walletAddr,
              subject: msg.subject || '(no subject)',
              body: msg.body || '',
              html: '',
              timestamp: msg.storedAt || msg.timestamp || obj.LastModified.getTime(),
              read: !!readState.get(sk), starred: !!starState.get(sk),
              verified: true, internal: true
            });
          } catch (e) { /* skip non-JSON or malformed */ }
        }
      }
    } catch (e) { console.warn('Content scan error:', e.message); }

    // Collect unknown wallet addresses and populate cache from stored ENS names
    for (const e of emails) {
      const f = (e.from || '').toLowerCase();
      const t = (e.to || '').toLowerCase();
      if (f.startsWith('0x') && !ensCache.has(f) && e.fromEmail && !e.fromEmail.startsWith('0x') && !e.fromEmail.includes('@')) {
        ensCache.set(f, e.fromEmail.replace('.dfmi', ''));
      }
      if (t.startsWith('0x') && !ensCache.has(t) && e.toEmail && !e.toEmail.startsWith('0x') && !e.toEmail.includes('@')) {
        ensCache.set(t, e.toEmail.replace('.dfmi', ''));
      }
    }

    // Fix & enrich: if both from and to are wallet addresses, it's on-chain
    for (const e of emails) {
      const fromAddr = (e.from || '').toLowerCase();
      const toAddr = (e.to || '').toLowerCase();
      if (fromAddr.startsWith('0x') && toAddr.startsWith('0x')) {
        e.internal = true;
      }
      if (e.internal) {
        const storedFromEns = e.fromEmail && !e.fromEmail.startsWith('0x') && !e.fromEmail.includes('@') ? e.fromEmail : null;
        const storedToEns = e.toEmail && !e.toEmail.startsWith('0x') && !e.toEmail.includes('@') ? e.toEmail : null;

        if (fromAddr.startsWith('0x')) {
          const ens = ensCache.get(fromAddr);
          e.fromEmail = ens ? `${ens}.dfmi` : (storedFromEns || fromAddr);
          e.fromName = ens ? `${ens}.dfmi` : (storedFromEns || fromAddr);
        }
        if (toAddr.startsWith('0x')) {
          const ens = ensCache.get(toAddr);
          e.toEmail = ens ? `${ens}.dfmi` : (storedToEns || toAddr);
        }
      }
    }

    // Filter out deleted emails, then sort by timestamp descending
    const filtered = emails.filter(e => !deletedIds.has(e.id) && !deletedIds.has(e.messageId));
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    res.json({ emails: filtered, count: filtered.length });
  } catch (err) {
    if (err.name === 'NoSuchBucket') return res.json({ emails: [], count: 0 });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages/sent', requireAuth, async (req, res) => {
  try {
    const wallet = req.walletAddress.toLowerCase();
    // Always load from S3 to ensure we have everything persisted
    const s3Emails = [];
    try {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: `sent/${wallet}/`, MaxKeys: 200 }));
      if (listed.Contents && listed.Contents.length > 0) {
        for (const obj of listed.Contents) {
          try {
            const data = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
            const entry = JSON.parse(await streamToString(data.Body));
            s3Emails.push(entry);
          } catch (e) { /* skip bad entries */ }
        }
      }
    } catch (e) { console.warn('S3 sent load error:', e.message); }

    // Merge: S3 is source of truth, add any in-memory that aren't in S3 yet
    const s3Ids = new Set(s3Emails.map(e => e.id));
    const memEmails = (sentEmails.get(wallet) || []).filter(e => !s3Ids.has(e.id));
    // Only include emails actually sent by this wallet
    const all = [...s3Emails, ...memEmails].filter(e => {
      const from = (e.from || '').toLowerCase();
      return from === wallet || from === '';
    });

    // Update in-memory cache
    sentEmails.set(wallet, all);

    // Collect unknown wallet addresses and try to resolve ENS names
    const unknownAddrs = new Set();
    for (const e of all) {
      const f = (e.from || '').toLowerCase();
      const t = (e.to || '').toLowerCase();
      if (f.startsWith('0x') && !ensCache.has(f)) unknownAddrs.add(f);
      if (t.startsWith('0x') && !ensCache.has(t)) unknownAddrs.add(t);
    }
    // Reverse-resolve unknown addresses via ENS (best effort)
    for (const addr of unknownAddrs) {
      try {
        // resolveNameToAddress won't help for reverse, but check if any stored fromEmail/toEmail has a name
        // that we can use to populate the cache
        for (const e of all) {
          if ((e.from || '').toLowerCase() === addr && e.fromEmail && !e.fromEmail.startsWith('0x') && !e.fromEmail.includes('@')) {
            ensCache.set(addr, e.fromEmail.replace('.dfmi', ''));
            break;
          }
          if ((e.to || '').toLowerCase() === addr && e.toEmail && !e.toEmail.startsWith('0x') && !e.toEmail.includes('@')) {
            ensCache.set(addr, e.toEmail.replace('.dfmi', ''));
            break;
          }
        }
      } catch (ex) {}
    }

    // Fix & enrich: if both from and to are wallet addresses, it's on-chain
    for (const e of all) {
      const fromAddr = (e.from || '').toLowerCase();
      const toAddr = (e.to || '').toLowerCase();
      // Detect on-chain: both sides are wallet addresses
      if (fromAddr.startsWith('0x') && toAddr.startsWith('0x')) {
        e.internal = true;
      }
      if (e.internal) {
        // Check if stored fromEmail/toEmail already has ENS name (e.g. from when it was saved)
        const storedFromEns = e.fromEmail && !e.fromEmail.startsWith('0x') && !e.fromEmail.includes('@') ? e.fromEmail : null;
        const storedToEns = e.toEmail && !e.toEmail.startsWith('0x') && !e.toEmail.includes('@') ? e.toEmail : null;

        if (fromAddr.startsWith('0x')) {
          const ens = ensCache.get(fromAddr);
          e.fromEmail = ens ? `${ens}.dfmi` : (storedFromEns || fromAddr);
        }
        if (toAddr.startsWith('0x')) {
          const ens = ensCache.get(toAddr);
          e.toEmail = ens ? `${ens}.dfmi` : (storedToEns || toAddr);
        }
      }
    }

    // Sort by timestamp descending
    all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json({ emails: all, count: all.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/messages/:messageId', requireAuth, (req, res) => {
  const c = contents.get(req.params.messageId);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json({ messageId: req.params.messageId, subject: c.subject, body: c.body, subjectHash: c.subjectHash, bodyHash: c.bodyHash, sender: c.sender, timestamp: c.timestamp });
});

app.post('/api/messages/:messageId/read', requireAuth, async (req, res) => {
  const k = `${req.walletAddress}:${req.params.messageId}`;
  readState.set(k, true);
  // Persist to S3
  try { await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `state/${req.walletAddress}/read/${req.params.messageId}`, Body: 'true', ContentType: 'text/plain' })); } catch (e) { console.warn('S3 read state persist failed:', e.message); }
  res.json({ read: true });
});

app.post('/api/messages/:messageId/star', requireAuth, async (req, res) => {
  const k = `${req.walletAddress}:${req.params.messageId}`;
  const v = !starState.get(k);
  starState.set(k, v);
  // Persist to S3
  try { await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `state/${req.walletAddress}/star/${req.params.messageId}`, Body: v ? 'true' : 'false', ContentType: 'text/plain' })); } catch (e) { console.warn('S3 star state persist failed:', e.message); }
  res.json({ starred: v });
});

app.delete('/api/messages/:messageId', requireAuth, async (req, res) => {
  const wallet = req.walletAddress.toLowerCase();
  const messageId = req.params.messageId;
  const { source } = req.body || {}; // 'inbox' or 'sent'
  try {
    // Mark as deleted in S3 state
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `state/${wallet}/deleted/${messageId}`, Body: 'true', ContentType: 'text/plain' }));
    // If deleting from sent, also remove the sent S3 entry
    if (source === 'sent') {
      try { await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: `sent/${wallet}/${messageId}.json` })); } catch (e) {}
      const mem = sentEmails.get(wallet);
      if (mem) sentEmails.set(wallet, mem.filter(e => e.id !== messageId));
    }
    // Clean up read/star state
    readState.delete(`${wallet}:${messageId}`);
    starState.delete(`${wallet}:${messageId}`);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════
// RESOLUTION (Spec §12.3, §15)
// ═══════════════════════════════════════════════════════════════════════

app.post('/api/resolve-recipient', requireAuth, async (req, res) => {
  try {
    const { input } = req.body;
    if (!input) return res.status(400).json({ error: 'Missing input' });
    const c = input.trim().toLowerCase();

    if (c.startsWith('0x') && c.length === 42) {
      const ens = ensCache.get(c);
      return res.json({ type: 'wallet', wallet: c, ens: ens ? `${ens}.dfmi` : null, email: addressToEmail(c), verified: true, internal: true });
    }

    if (c.endsWith('.dfmi') || (!c.includes('@') && !c.startsWith('0x'))) {
      const name = c.replace('.dfmi','');
      const addr = await resolveNameToAddress(name);
      if (addr) {
        console.log(`[resolve] ENS ${name}.dfmi → ${addr} (internal)`);
        return res.json({ type: 'ens', wallet: addr, ens: `${name}.dfmi`, email: `${name}@${EMAIL_DOMAIN}`, verified: true, internal: true });
      }
      // Check ensCache reverse lookup — name may have been cached from a prior resolution
      for (const [cachedAddr, cachedName] of ensCache) {
        if (cachedName === name) {
          console.log(`[resolve] ENS cache hit ${name}.dfmi → ${cachedAddr} (internal)`);
          return res.json({ type: 'ens', wallet: cachedAddr, ens: `${name}.dfmi`, email: `${name}@${EMAIL_DOMAIN}`, verified: true, internal: true });
        }
      }
      console.log(`[resolve] ENS ${name}.dfmi not resolved on-chain — treating as internal (unverified)`);
      // ENS name not resolved but it's a .dfmi name — still internal, just unverified
      return res.json({ type: 'ens', wallet: null, ens: `${name}.dfmi`, email: `${name}@${EMAIL_DOMAIN}`, verified: false, internal: true });
    }

    if (c.includes('@')) {
      if (c.endsWith(`@${EMAIL_DOMAIN}`)) {
        const local = c.replace(`@${EMAIL_DOMAIN}`,'');
        if (!local.startsWith('0x')) {
          const addr = await resolveNameToAddress(local);
          return res.json({ type: 'email_internal', wallet: addr, ens: addr ? `${local}.dfmi` : null, email: c, verified: !!addr, internal: true });
        }
      }
      return res.json({ type: 'email_external', wallet: null, ens: null, email: c, verified: false, internal: false });
    }

    res.status(400).json({ error: 'Unrecognized format' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════
// CONTACTS — per-address contact book, S3 backed
// ═══════════════════════════════════════════════════════════════════════

const contactBooks = new Map();  // address → []
const MAX_CONTACTS = Number(process.env.MAX_CONTACTS) || 1000;
const CONTACT_LIMITS = {
  id:     Number(process.env.CONTACT_ID_MAX)     || 64,
  name:   Number(process.env.CONTACT_NAME_MAX)   || 200,
  wallet: Number(process.env.CONTACT_WALLET_MAX) || 64,
  ens:    Number(process.env.CONTACT_ENS_MAX)    || 200,
  email:  Number(process.env.CONTACT_EMAIL_MAX)  || 320,
  notes:  Number(process.env.CONTACT_NOTES_MAX)  || 2000
};

function contactField(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

function sanitizeContacts(list) {
  return list.slice(0, MAX_CONTACTS).map(c => ({
    id:        contactField(c && c.id, CONTACT_LIMITS.id) || uuidv4(),
    name:      contactField(c && c.name, CONTACT_LIMITS.name),
    wallet:    contactField(c && c.wallet, CONTACT_LIMITS.wallet),
    ens:       contactField(c && c.ens, CONTACT_LIMITS.ens),
    email:     contactField(c && c.email, CONTACT_LIMITS.email),
    notes:     contactField(c && c.notes, CONTACT_LIMITS.notes),
    createdAt: Number(c && c.createdAt) || Date.now(),
    updatedAt: Number(c && c.updatedAt) || Date.now()
  })).filter(c => c.name || c.wallet || c.ens || c.email);
}

async function loadContacts(wallet) {
  if (contactBooks.has(wallet)) return contactBooks.get(wallet);
  let list = [];
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: `contacts/${wallet}.json` }));
    const parsed = JSON.parse(await streamToString(data.Body));
    const stored = Array.isArray(parsed) ? parsed : (Array.isArray(parsed && parsed.contacts) ? parsed.contacts : null);
    if (stored) list = sanitizeContacts(stored);
  } catch (e) {
    if (e.name !== 'NoSuchKey' && e.name !== 'NotFound') console.warn('S3 contacts load failed:', e.message);
  }
  contactBooks.set(wallet, list);
  return list;
}

app.get('/api/contacts', requireAuth, async (req, res) => {
  try {
    const list = await loadContacts(req.walletAddress.toLowerCase());
    res.json({ contacts: list });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/contacts', requireAuth, async (req, res) => {
  const body = req.body || {};
  const incoming = Array.isArray(body) ? body : (Array.isArray(body.contacts) ? body.contacts : null);
  if (!incoming) return res.status(400).json({ error: 'Expected { contacts: [] }' });
  const wallet = req.walletAddress.toLowerCase();
  const list = sanitizeContacts(incoming);
  contactBooks.set(wallet, list);
  // Persist to S3
  try {
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `contacts/${wallet}.json`, Body: JSON.stringify({ v: 1, address: wallet, updatedAt: Date.now(), contacts: list }), ContentType: 'application/json' }));
  } catch (e) { console.warn('S3 contacts persist failed:', e.message); }
  audit('contacts_saved', wallet, { count: list.length });
  res.json({ saved: true, count: list.length });
});

// ─── Utility Routes ───
// Sign out: this session only.
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  await dropSession(req.sessionToken);
  audit('logout', req.walletAddress);
  res.json({ ok: true });
});

// Sign out on all devices: every session of this address issued until now.
app.post('/api/auth/logout-all', requireAuth, async (req, res) => {
  try {
    const before = await revokeAllSessions(req.walletAddress);
    await dropSession(req.sessionToken);
    audit('logout_all', req.walletAddress, { before });
    res.json({ ok: true, revokedBefore: new Date(before).toISOString() });
  } catch (e) { res.status(503).json({ error: 'Could not revoke sessions, try again' }); }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', spec: 'Master-Spec-v1.0', domain: EMAIL_DOMAIN, mailbox: MAILBOX_ADDR || 'not configured', time: new Date().toISOString() });
});

// Cheap session check — the client uses this to restore a reload without
// touching the inbox scan, and to learn the real expiry.
app.get('/api/session', requireAuth, (req, res) => {
  const token = req.headers.authorization.replace('Bearer ', '');
  const entry = sessions.get(token);
  res.json({
    address: req.walletAddress,
    email: req.emailAddress,
    expiresAt: entry ? entry.expiresAt : null,
    expiresIn: entry ? Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000)) : null
  });
});

// Client runtime config — the browser reads this instead of carrying its own copy
app.get('/api/config', (req, res) => {
  res.json({
    rpc: DFMI_RPC,
    chainId: CHAIN_ID,
    ensRegistry: ENS_REGISTRY,
    ensResolver: ENS_RESOLVER,
    mailboxAddress: MAILBOX_ADDR,
    tld: TLD,
    emailDomain: EMAIL_DOMAIN,
    passkeyRpIds: PASSKEY_RPS.map((r) => r.rpId),
    knownMappings: Object.fromEntries(ensCache)
  });
});

app.post('/api/incoming', async (req, res) => {
  try {
    const n = req.body;
    if (n.Type === 'SubscriptionConfirmation') { console.log('SNS confirm:', n.SubscribeURL); return res.json({ status: 'confirm manually' }); }
    if (n.Type === 'Notification') {
      const m = JSON.parse(n.Message);
      for (const r of m.receipt.recipients) {
        const wa = emailToAddress(r);
        if (wa && m.receipt.action?.type === 'S3') {
          const raw = await s3.send(new GetObjectCommand({ Bucket: m.receipt.action.bucketName, Key: m.receipt.action.objectKey }));
          await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `incoming/${wa}/${m.mail.messageId}.eml`, Body: await streamToString(raw.Body), ContentType: 'message/rfc822' }));
        }
      }
    }
    res.json({ status: 'ok' });
  } catch (err) { console.error('Incoming error:', err); res.status(500).json({ error: err.message }); }
});

async function streamToString(s) { const c = []; for await (const ch of s) c.push(ch); return Buffer.concat(c).toString('utf-8'); }

async function bootstrapEnsNames() {
  console.log('  [ENS Bootstrap] Testing ENS resolution...');
  console.log(`  [ENS Bootstrap] Registry: ${ENS_REGISTRY}`);
  console.log(`  [ENS Bootstrap] Resolver: ${ENS_RESOLVER}`);
  console.log(`  [ENS Bootstrap] RPC: ${DFMI_RPC}`);
  console.log(`  [ENS Bootstrap] Provider: ${dfmiProvider ? 'connected' : 'NOT connected'}`);
  for (const name of String(process.env.ENS_BOOTSTRAP_NAMES ?? 'admin').split(',').map((x) => x.trim()).filter(Boolean)) {
    try {
      const a = await resolveNameToAddress(name);
      if (a) console.log(`  ENS: ${name}.dfmi → ${a}`);
      else console.log(`  ENS: ${name}.dfmi → NOT FOUND`);
    } catch (e) { console.warn(`  ENS fail ${name}:`, e.message); }
  }
}

app.listen(PORT, async () => {
  console.log(`\n  WalletMail API v2.0 (Master-Spec-v1.0)`);
  console.log(`  Port: ${PORT} | Domain: ${EMAIL_DOMAIN} | S3: ${S3_BUCKET}`);
  console.log(`  Mailbox: ${MAILBOX_ADDR || 'not configured'}`);
  console.log(`  Signature check: ${SIG_ENFORCE ? 'ENFORCED' : 'log only'}`);
  console.log(`  Session TTL: ${SESSION_TTL/1000}s | Rate: ${RATE_LIMIT_MAX}/${RATE_LIMIT_WINDOW/1000}s\n`);
  await bootstrapEnsNames();
  console.log('\n  Routes: auth/challenge, auth/verify, auth/logout, auth/logout-all, messages/prepare, messages/content,');
  console.log('  messages/send-internal, messages/send-external, messages/inbox, messages/sent,');
  console.log('  messages/:id, messages/:id/read, messages/:id/star, resolve-recipient,');
  console.log('  contacts (GET/PUT), config, session, health\n');
});
