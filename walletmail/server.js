/**
 * WalletMail API Server — v2.0
 *
 * Local remediation based on the published source at 10cc772 (25 November 2026).
 * This file includes independent-review fixes; it is not evidence of a production deployment.
 * Configuration defaults omit built-in contract addresses and address-to-name mappings.
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
 *   GET  /api/messages/:messageId/attachments/:index — authenticated binary download
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
// SendEmail has no idempotency token. Retrying inside the SDK after a lost
// response bypasses the outbox claim and can submit the same message twice.
const ses = new SESv2Client({ region: AWS_REGION, maxAttempts: 1 });
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
// Display hints (including login form values and stored mail metadata) are not
// ownership proofs. Only operator mappings or successful resolver reads grant
// access through an ENS mail alias.
const trustedMailNames = new Map();

// Pre-populate known ENS mappings
const KNOWN_MAPPINGS = (() => { try { return JSON.parse(process.env.KNOWN_ENS_MAPPINGS || '{}'); } catch { return {}; } })(); // { address: name }
for (const [addr, name] of Object.entries(KNOWN_MAPPINGS)) {
  ensCache.set(addr.toLowerCase(), name);
  if (typeof name === 'string') trustedMailNames.set(addr.toLowerCase(), name.toLowerCase());
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
      trustedMailNames.set(addr.toLowerCase(), full.replace('.dfmi', '').toLowerCase());
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
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `prepared/${messageId}.json`, Body: JSON.stringify(rec), ContentType: 'application/json' }));
  prepared.set(messageId, rec);
  setTimeout(() => prepared.delete(messageId), PREPARED_TTL);
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
// S3 is authoritative on every request, including requests to another process.
// Never trust a cached token after another instance has revoked it.
function sessionKey(token) { return `sessions/${token}.json`; }

async function persistSession(token, entry) {
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: sessionKey(token), Body: JSON.stringify(entry), ContentType: 'application/json' }));
}

async function dropSession(token) {
  await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: sessionKey(token) }));
  sessions.delete(token);
}

async function loadSession(token) {
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
  await persistSession(token, session);
  sessions.set(token, session);
  // Best-effort in-process expiry; loadSession re-checks after a restart.
  setTimeout(() => { dropSession(token).catch((e) => console.warn('Expired session cleanup failed:', e.message)); }, SESSION_TTL + 1000);
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
// A rollback can restore a credential deleted after the backup. The session fence
// must therefore cover credentials too, including discoverable sign-in. Never use
// lastUsedAt/counter as an epoch: using a credential cannot re-enroll it.
function passkeyAfterRestore(rec) {
  if (!SESSIONS_NOT_BEFORE) return true;
  const created = Date.parse(rec.createdAt);
  return Number.isFinite(created) && created > SESSIONS_NOT_BEFORE;
}
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
    const existing = (await passkeyIndex(req.walletAddress)).filter((p) => p.rpId === rp.rpId && passkeyAfterRestore(p));
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
    if (prior && (prior.address !== ch.address || passkeyAfterRestore(prior))) return res.status(409).json({ error: 'This passkey is already registered' });
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
      allow = (await passkeyIndex(address)).filter((p) => p.rpId === rp.rpId && passkeyAfterRestore(p)).map((p) => ({ id: p.id, transports: p.transports }));
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
    if (!passkeyAfterRestore(rec)) return res.status(401).json({ error: 'Passkey predates restore; sign in with your wallet and register it again' });
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

    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: contentKey, Body: payload, ContentType: 'application/json' }));

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
    // Persist to S3
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `sent/${req.walletAddress.toLowerCase()}/${messageId}.json`, Body: JSON.stringify(sentEntry), ContentType: 'application/json' }));

    // Also persist content with recipientValue so inbox scan can find it
    {
      const contentPayload = JSON.stringify({
        messageId, subject: content.subject, body: content.body,
        recipientValue: toWallet.toLowerCase(),
        subjectHash: content.subjectHash, bodyHash: content.bodyHash,
        storedAt: Date.now(), sender: req.walletAddress
      });
      await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `content/${messageId}.json`, Body: contentPayload, ContentType: 'application/json' }));
    }
    if (!sentEmails.has(req.walletAddress)) sentEmails.set(req.walletAddress, []);
    sentEmails.get(req.walletAddress).push(sentEntry);

    audit('send_internal', req.walletAddress, { messageId, recipientWallet, onChain: !!onChainTxHash });
    res.json({ sent: true, messageId, internal: true, onChain: !!onChainTxHash });
  } catch (err) { console.error('Send internal error:', err); res.status(500).json({ error: err.message }); }
});

// ─── Outbound mail: outbox + idempotency (2026-11-26) ───
// SES has no idempotency key, so the server keeps one: outbox/<wallet>/<messageId>.json, created with a conditional
// write (If-None-Match) BEFORE SES is called. One messageId can therefore reach SES at most once:
//   pending  claimed, SES call in progress or its outcome unknown (timeout, network, 5xx) -> never resent automatically
//   sent     SES accepted it (sesMessageId kept) -> a retry returns the original result and repairs the sent/ record
//   failed   SES rejected it with a 4xx (definitely not sent) -> the same messageId may be retried
// The same messageId with different content is refused.
const outboxKey = (wallet, id) => `outbox/${wallet}/${id}.json`;
const condFailed = (e) => e && (e.name === 'PreconditionFailed' || e.name === 'ConditionalRequestConflict' || e.$metadata?.httpStatusCode === 412 || e.$metadata?.httpStatusCode === 409);
async function outboxGet(key) {
  try { const d = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key })); return { rec: JSON.parse(await streamToString(d.Body)), etag: d.ETag }; }
  catch (e) { if (e.name === 'NoSuchKey' || e.name === 'NotFound') return null; throw e; }
}
const outboxPut = (key, rec, cond) => s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: JSON.stringify(rec), ContentType: 'application/json', ...cond }));
async function outboxUpdate(key, rec) { // retried: once SES has accepted, losing this write would leave the message "unknown"
  let last; for (let i = 0; i < 3; i++) { try { return await outboxPut(key, rec); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 200 * (i + 1))); } } throw last;
}
const sesDefinitelyRejected = (e) => { const c = e?.$metadata?.httpStatusCode; return typeof c === 'number' && c >= 400 && c < 500 && c !== 408 && c !== 429; };

// ─── SES delivery events and pending reconciliation (2026-11-26) ───
// SES publishes an event for every message sent with SES_CONFIGURATION_SET (Send = accepted by SES, then Delivery /
// Bounce / Complaint / Reject / DeliveryDelay / RenderingFailure). Amazon Data Firehose writes them to raw/ in
// SES_EVENTS_BUCKET, a bucket that is NOT restored with the mail bucket, so the evidence survives a rollback.
// Each message carries the tags obw (wallet) and obid (base64url of its messageId), so an event names its outbox entry.
//  - The reconciler indexes every event under index/<wallet>/<obid>/ and turns a 'pending' entry into 'sent' when SES
//    shows it was accepted. It never sends anything.
//  - Before every send, the index is checked: if SES already accepted this messageId (for example the outbox was rolled
//    back by a restore), the outbox is repaired and nothing is sent again.
//  - Pending entries without evidence after OUTBOX_PENDING_ALERT_MS are reported (health + outbox-alerts/) for an
//    operator, who resolves them with tools/outbox-ops.mjs; every resolution is recorded under outbox-resolutions/.
const SES_CONFIGURATION_SET = process.env.SES_CONFIGURATION_SET || '';
const EVENTS_BUCKET = process.env.SES_EVENTS_BUCKET || '';
const RECONCILE_MS = Number(process.env.OUTBOX_RECONCILE_MS) || 30000;
const PENDING_ALERT_MS = Number(process.env.OUTBOX_PENDING_ALERT_MS) || 15 * 60000;
const RECONCILE_LOOKBACK_MS = Number(process.env.OUTBOX_RECONCILE_LOOKBACK_MS) || 3 * 3600000;
const ACCEPTED_EVENTS = new Set(['Send', 'Delivery', 'Bounce', 'Complaint', 'Reject', 'DeliveryDelay']);
const evIndexPrefix = (wallet, id) => `index/${wallet}/${b64u(id)}/`;
const reconcileStatus = { enabled: !!(EVENTS_BUCKET && SES_CONFIGURATION_SET), lastRunAt: null, lastOkAt: null, lastError: null, eventsIndexed: 0, reconciled: 0, pendingStale: 0, pendingStaleOldest: null, lastCanaryAt: null };
const CANARY_WALLET = '0x' + '0'.repeat(40);
// Authoritative journal: separate from the rollbackable mail bucket.
if (!!EVENTS_BUCKET !== !!SES_CONFIGURATION_SET || (EVENTS_BUCKET && EVENTS_BUCKET === S3_BUCKET)) throw new Error('Configure a separate events bucket and configuration set together');
const journalKey = (w, id) => `journal/${w}/${b64u(id)}.json`;
async function journalGet(w, id) {
  try { const d = await s3.send(new GetObjectCommand({ Bucket: EVENTS_BUCKET, Key: journalKey(w, id) })); return { rec: JSON.parse(await streamToString(d.Body)), etag: d.ETag }; }
  catch (e) { if (e.name === 'NoSuchKey' || e.name === 'NotFound') return null; throw e; }
}
const journalPut = (r, cond) => s3.send(new PutObjectCommand({ Bucket: EVENTS_BUCKET, Key: journalKey(r.wallet, r.messageId), Body: JSON.stringify(r), ContentType: 'application/json', ...cond }));
async function closedResolution(w, id) {
  for (const o of await evList(`resolutions/${w}/${b64u(id)}/`)) {
    const r = await evJson(o.Key);
    if (r && (r.decision === 'undeterminable' || r.newState === 'abandoned')) return r;
  }
  return null;
}
async function persistOutcome(key, rec) {
  if (reconcileStatus.enabled) {
    const j = await journalGet(rec.wallet, rec.messageId);
    if (j?.rec.state === 'sent' && j.rec.fp === rec.fp && j.rec.sesMessageId === rec.sesMessageId && rec.state === 'sent') {
      await outboxUpdate(key, j.rec); return; // an event reconciler completed the same outcome
    }
    if (!j || j.rec.state !== 'pending' || j.rec.attemptId !== rec.attemptId) throw new Error('Authoritative claim changed; reconcile outcome');
    await journalPut(rec, { IfMatch: j.etag });
  }
  await outboxUpdate(key, rec);
}
const evS3 = s3;  // same client; EVENTS_BUCKET is a different bucket
async function evJson(key) {
  try { const d = await evS3.send(new GetObjectCommand({ Bucket: EVENTS_BUCKET, Key: key })); return JSON.parse(await streamToString(d.Body)); }
  catch (e) { if (e.name === 'NoSuchKey' || e.name === 'NotFound') return null; throw e; }
}
async function evList(prefix, startAfter) {
  const out = []; let token;
  do {
    const r = await evS3.send(new ListObjectsV2Command({ Bucket: EVENTS_BUCKET, Prefix: prefix, ...(startAfter && !token ? { StartAfter: startAfter } : {}), ...(token ? { ContinuationToken: token } : {}) }));
    out.push(...(r.Contents || [])); token = r.IsTruncated ? r.NextContinuationToken : null;
  } while (token);
  return out;
}
// Events SES recorded for one outbox entry (newest last). Throws if the index cannot be read.
async function outboxEvents(wallet, id) {
  if (!EVENTS_BUCKET) return [];
  const objs = await evList(evIndexPrefix(wallet, id));
  const evs = [];
  for (const o of objs) { const e = await evJson(o.Key); if (e) evs.push(e); }
  return evs.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}
// Firehose concatenates records; split a file into JSON objects
function splitJsonRecords(text) {
  const out = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') { if (depth++ === 0) start = i; } else if (c === '}' && --depth === 0) { try { out.push(JSON.parse(text.slice(start, i + 1))); } catch {} }
  }
  return out;
}
function compactEvent(ev) {
  const type = ev.eventType || ev.notificationType; const mail = ev.mail || {}; const tags = mail.tags || {};
  const wallet = (tags.obw && tags.obw[0] || '').toLowerCase(); let id = null;
  try { id = tags.obid && tags.obid[0] ? Buffer.from(tags.obid[0], 'base64url').toString() : null; } catch {}
  if (!type || !/^0x[0-9a-f]{40}$/.test(wallet) || !id || !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) return null;
  const detail = ev.bounce ? { bounceType: ev.bounce.bounceType, bounceSubType: ev.bounce.bounceSubType, recipients: (ev.bounce.bouncedRecipients || []).map(r => r.emailAddress) }
    : ev.complaint ? { complaintType: ev.complaint.complaintFeedbackType || null, recipients: (ev.complaint.complainedRecipients || []).map(r => r.emailAddress) }
    : ev.delivery ? { recipients: ev.delivery.recipients, smtpResponse: ev.delivery.smtpResponse, processingTimeMillis: ev.delivery.processingTimeMillis }
    : ev.deliveryDelay ? { delayType: ev.deliveryDelay.delayType, expirationTime: ev.deliveryDelay.expirationTime }
    : ev.reject ? { reason: ev.reject.reason } : ev.failure ? { errorMessage: ev.failure.errorMessage } : {};
  return { wallet, messageId: id, eventType: type, sesMessageId: mail.messageId || null, timestamp: (ev.delivery || ev.bounce || ev.complaint || ev.deliveryDelay || {}).timestamp || mail.timestamp || null,
    destination: mail.destination || [], subject: mail.commonHeaders?.subject ?? null, detail };
}
async function markSentFromEvents(wallet, id, evs, by) {
  const acc = evs.find(e => ACCEPTED_EVENTS.has(e.eventType)); if (!acc) return null;
  const key = outboxKey(wallet, id);
  for (let i = 0; i < 3; i++) {
    if (await closedResolution(wallet, id)) return null;
    const j = await journalGet(wallet, id);
    if (j?.rec.state === 'abandoned') return null;
    const mirror = await outboxGet(key), cur = j || mirror;
    if (!cur?.rec.fp) return null;
    const next = { ...cur.rec, state: 'sent', sesMessageId: acc.sesMessageId, sentAt: cur.rec.sentAt || acc.timestamp, reconciledAt: new Date().toISOString(), reconciledBy: by };
    if (!j || j.rec.state !== 'sent') {
      try { await journalPut(next, j ? { IfMatch: j.etag } : { IfNoneMatch: '*' }); }
      catch (e) { if (condFailed(e)) continue; throw e; }
    }
    if (mirror?.rec.state === 'sent' && mirror.rec.fp) return mirror.rec;
    const base = cur ? cur.rec : { messageId: id, wallet, to: acc.destination[0] || null, restoredFromEvents: true };
    const rec = { ...base, state: 'sent', sesMessageId: acc.sesMessageId, sentAt: base.sentAt || acc.timestamp || new Date().toISOString(),
      reconciledAt: new Date().toISOString(), reconciledBy: by, previousState: cur ? cur.rec.state : 'missing' };
    try { await outboxPut(key, rec, mirror ? { IfMatch: mirror.etag } : { IfNoneMatch: '*' }); reconcileStatus.reconciled++; audit('outbox_reconciled', wallet, { messageId: id, from: rec.previousState, by, sesMessageId: acc.sesMessageId }); return rec; }
    catch (e) { if (!condFailed(e)) throw e; }
  }
  throw new Error('outbox reconcile conflict');
}
let reconcileRunning = false, lastStaleSweep = 0;
async function reconcileOnce({ fromMs } = {}) {
  if (!reconcileStatus.enabled || reconcileRunning) return;
  reconcileRunning = true; reconcileStatus.lastRunAt = new Date().toISOString();
  try {
    // 1. index new event files (hour folders in the look-back window; already processed files are skipped)
    const cursor = (await evJson('reconcile/cursor.json')) || { processed: {} };
    if (cursor.lastCanaryAt && (!reconcileStatus.lastCanaryAt || cursor.lastCanaryAt > reconcileStatus.lastCanaryAt)) reconcileStatus.lastCanaryAt = cursor.lastCanaryAt;
    const now = Date.now(), since = fromMs ?? (now - RECONCILE_LOOKBACK_MS);
    const touched = new Map();
    for (let t = since - (since % 3600000); t <= now; t += 3600000) {
      const d = new Date(t), hour = `raw/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCHours()).padStart(2, '0')}/`;
      for (const o of await evList(hour)) {
        if (cursor.processed[o.Key]) continue;
        const d2 = await evS3.send(new GetObjectCommand({ Bucket: EVENTS_BUCKET, Key: o.Key }));
        for (const raw of splitJsonRecords(await streamToString(d2.Body))) {
          const ev = compactEvent(raw); if (!ev) continue;
          const k = `${evIndexPrefix(ev.wallet, ev.messageId)}${ev.eventType}-${ev.sesMessageId}-${String(ev.timestamp).replace(/[^0-9TZ]/g, '')}.json`;
          await evS3.send(new PutObjectCommand({ Bucket: EVENTS_BUCKET, Key: k, Body: JSON.stringify(ev), ContentType: 'application/json' }));
          reconcileStatus.eventsIndexed++;
          if (ev.wallet === CANARY_WALLET) { if (ev.eventType === 'Send' && (!reconcileStatus.lastCanaryAt || ev.timestamp > reconcileStatus.lastCanaryAt)) reconcileStatus.lastCanaryAt = ev.timestamp; continue; }
          touched.set(`${ev.wallet}\n${ev.messageId}`, true);
        }
        cursor.processed[o.Key] = now;
      }
    }
    for (const k of Object.keys(cursor.processed)) if (cursor.processed[k] < now - 2 * RECONCILE_LOOKBACK_MS) delete cursor.processed[k];
    // 2. promote pending entries that SES accepted
    for (const wk of touched.keys()) {
      const [wallet, id] = wk.split('\n'); const cur = await outboxGet(outboxKey(wallet, id));
      if (cur && cur.rec.state !== 'sent' && cur.rec.state !== 'abandoned') await markSentFromEvents(wallet, id, await outboxEvents(wallet, id), 'reconciler');
    }
    await evS3.send(new PutObjectCommand({ Bucket: EVENTS_BUCKET, Key: 'reconcile/cursor.json', Body: JSON.stringify({ ...cursor, lastOkAt: new Date().toISOString(), lastCanaryAt: reconcileStatus.lastCanaryAt }), ContentType: 'application/json' }));
    // 3. stale pending sweep (every 5 reconcile periods)
    if (now - lastStaleSweep >= 5 * RECONCILE_MS) {
      lastStaleSweep = now; let stale = 0, oldest = null;
      for (const o of await listMailObjects('outbox/', 1000).then(r => r.Contents || [])) {
        const cur = await outboxGet(o.Key); if (!cur || cur.rec.state !== 'pending') continue;
        const age = now - Date.parse(cur.rec.claimedAt || 0); if (age < PENDING_ALERT_MS) continue;
        const evs = await outboxEvents(cur.rec.wallet, cur.rec.messageId);
        if (evs.some(e => ACCEPTED_EVENTS.has(e.eventType))) { await markSentFromEvents(cur.rec.wallet, cur.rec.messageId, evs, 'reconciler-sweep'); continue; }
        stale++; if (!oldest || cur.rec.claimedAt < oldest) oldest = cur.rec.claimedAt;
        const ak = `outbox-alerts/${cur.rec.wallet}/${b64u(cur.rec.messageId)}.json`;
        try { await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: ak, Body: JSON.stringify({ wallet: cur.rec.wallet, messageId: cur.rec.messageId, claimedAt: cur.rec.claimedAt, firstAlertAt: new Date().toISOString() }), ContentType: 'application/json', IfNoneMatch: '*' }));
          audit('outbox_pending_alert', cur.rec.wallet, { messageId: cur.rec.messageId, claimedAt: cur.rec.claimedAt }); }
        catch (e) { if (!condFailed(e)) throw e; }
      }
      reconcileStatus.pendingStale = stale; reconcileStatus.pendingStaleOldest = oldest;
    }
    reconcileStatus.lastOkAt = new Date().toISOString(); reconcileStatus.lastError = null;
  } catch (e) { reconcileStatus.lastError = String(e.name || e.message).slice(0, 120); console.error('outbox reconcile failed:', e.message); }
  finally { reconcileRunning = false; }
}
if (reconcileStatus.enabled) {
  const from = process.env.OUTBOX_RECONCILE_FROM ? Date.parse(process.env.OUTBOX_RECONCILE_FROM) : undefined;   // after a restore: replay events since the backup
  setTimeout(() => reconcileOnce(Number.isFinite(from) ? { fromMs: from } : {}), 1000).unref?.();
  setInterval(() => reconcileOnce(), RECONCILE_MS).unref?.();
}

app.post('/api/messages/send-external', requireAuth, async (req, res) => {
  let deliveryMayHaveOccurred = false;
  try {
    const { messageId, recipientEmail, subject, body, signature } = req.body;
    if (!recipientEmail || !subject || !body) return res.status(400).json({ error: 'Missing fields' });
    if (messageId !== undefined && (typeof messageId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(messageId))) return res.status(400).json({ error: 'Invalid messageId' });
    if (!checkRateLimit(req.walletAddress)) return res.status(429).json({ error: 'Rate limit exceeded' });

    const wallet = req.walletAddress.toLowerCase();
    const fid = messageId || `ext-${uuidv4()}`;
    const key = outboxKey(wallet, fid);
    const fp = crypto.createHash('sha256').update(JSON.stringify([recipientEmail, subject, body, req.emailAddress])).digest('hex');
    const sentEntry = (extra = {}) => ({ id: fid, from: req.walletAddress, fromEmail: req.emailAddress, to: recipientEmail, toEmail: recipientEmail, subject, body,
      timestamp: Date.now(), signature, onChain: false, internal: false, ...extra });
    const writeSent = (entry) => s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `sent/${wallet}/${fid}.json`, Body: JSON.stringify(entry), ContentType: 'application/json' }));

    const claim = { state: 'pending', fp, to: recipientEmail, from: req.emailAddress, wallet, messageId: fid, claimedAt: new Date().toISOString(), attemptId: uuidv4() };
    if (reconcileStatus.enabled) {
      // Missing events NEVER authorize resending. Claim independently before SES.
      let evs;
      try { evs = await outboxEvents(wallet, fid); }
      catch { return res.status(503).json({ error: 'Delivery records unavailable; nothing submitted by this request', deliveryMayHaveOccurred: false }); }
      if (await closedResolution(wallet, fid)) return res.status(409).json({ error: 'This message was closed; it will never be resent', state: 'abandoned', deliveryMayHaveOccurred: true });
      let j = await journalGet(wallet, fid), owned = false;
      if (!j) {
        const cur = await outboxGet(key);
        const accepted = evs.some(e => ACCEPTED_EVENTS.has(e.eventType));
        if (accepted && !cur?.rec.fp) return res.status(409).json({ error: 'Original fingerprint unavailable; cannot reconstruct history from caller content', state: 'unknown', deliveryMayHaveOccurred: true });
        if (!cur && (process.env.OUTBOX_REQUIRE_EXISTING_JOURNAL === '1' || !!process.env.OUTBOX_RECONCILE_FROM)) return res.status(503).json({ error: 'Restore guard: no authoritative claim; sending blocked', deliveryMayHaveOccurred: true });
        try { await journalPut(cur ? { ...cur.rec, retryable: false } : claim, { IfNoneMatch: '*' }); owned = !cur; }
        catch (e) { if (!condFailed(e)) throw e; }
        j = await journalGet(wallet, fid);
      }
      if (!j) throw new Error('Send journal unavailable');
      if (j.rec.fp !== fp) return res.status(409).json({ error: 'This messageId was already used for different content', state: j.rec.state });
      if (j.rec.state === 'abandoned') return res.status(409).json({ error: 'This message was closed; it will never be resent', state: 'abandoned', deliveryMayHaveOccurred: true });
      if (evs.some(e => ACCEPTED_EVENTS.has(e.eventType)) && j.rec.state !== 'sent') {
        await markSentFromEvents(wallet, fid, evs, 'pre-send-check'); j = await journalGet(wallet, fid); owned = false;
      }
      if (j.rec.state === 'sent') {
        await outboxPut(key, j.rec);
        await writeSent(sentEntry({ timestamp: Date.parse(j.rec.sentAt) || Date.now(), sesMessageId: j.rec.sesMessageId }));
        return res.json({ sent: true, messageId: fid, duplicate: true, reconciled: true, fromEmail: req.emailAddress, toEmail: recipientEmail, sesMessageId: j.rec.sesMessageId });
      }
      if (j.rec.state === 'failed' && j.rec.retryable === true) {
        try { await journalPut(claim, { IfMatch: j.etag }); owned = true; }
        catch (e) { if (!condFailed(e)) throw e; }
      }
      if (!owned) return res.status(409).json({ error: 'Outcome unknown or another attempt owns this messageId; not resent', state: j.rec.state, deliveryMayHaveOccurred: true });
      await outboxPut(key, claim);
    } else {
    // 1. claim the messageId (at most one SES call per messageId)
    try { await outboxPut(key, claim, { IfNoneMatch: '*' }); }
    catch (e) {
      if (!condFailed(e)) throw e;                                   // storage failure: nothing was sent
      const cur = await outboxGet(key);
      if (!cur) return res.status(503).json({ error: 'Outbox state unavailable, try again', deliveryMayHaveOccurred: false });
      const r = cur.rec;
      if (r.fp !== fp) return res.status(409).json({ error: 'This messageId was already used for a different message', state: r.state });
      if (r.state === 'sent') {                                      // idempotent replay; repair the sent/ record if it was lost
        try { await writeSent(sentEntry({ timestamp: Date.parse(r.sentAt) || Date.now(), sesMessageId: r.sesMessageId })); } catch (err) { console.warn('sent/ repair failed:', err.message); }
        return res.json({ sent: true, messageId: fid, fromEmail: req.emailAddress, toEmail: recipientEmail, duplicate: true, sesMessageId: r.sesMessageId });
      }
      if (r.state === 'failed') {                                    // a definite earlier rejection: re-claim, conditional on that exact record
        try { await outboxPut(key, { ...claim, previous: { state: 'failed', error: r.error, at: r.failedAt } }, { IfMatch: cur.etag }); }
        catch (e2) { if (condFailed(e2)) return res.status(409).json({ error: 'Another attempt for this messageId is in progress', state: 'pending', deliveryMayHaveOccurred: true }); throw e2; }
      } else if (r.state === 'abandoned') {
        return res.status(409).json({ error: 'An operator closed this messageId as undeterminable; it is never sent again. Check with the recipient before writing a new message.', state: 'abandoned', deliveryMayHaveOccurred: true });
      } else {
        return res.status(409).json({ error: 'The outcome of an earlier attempt with this messageId is unknown; it is not resent automatically', state: r.state, claimedAt: r.claimedAt, deliveryMayHaveOccurred: true });
      }
    }

    }

    // 2. send
    let out;
    try {
      out = await ses.send(new SendEmailCommand({
        FromEmailAddress: req.emailAddress,
        Destination: { ToAddresses: [recipientEmail] },
        Content: { Simple: {
          Subject: { Data: subject },
          Body: {
            Text: { Data: body },
            Html: { Data: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto"><div style="padding:20px">${body.replace(/\n/g,'<br>')}</div><hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0"><div style="padding:0 20px 20px;font-size:12px;color:#94a3b8"><p>Sent via WalletMail from ${req.walletAddress}</p>${signature?`<p>Sig: ${signature.slice(0,20)}…</p>`:''}</div></div>` }
          }
        }},
        // tag values may only contain A-Z a-z 0-9 _ -: obid carries the exact messageId (base64url), messageId a readable form
        EmailTags: [{ Name: 'wallet', Value: req.walletAddress }, { Name: 'messageId', Value: fid.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) },
          { Name: 'obw', Value: wallet }, { Name: 'obid', Value: b64u(fid) }],
        ...(SES_CONFIGURATION_SET ? { ConfigurationSetName: SES_CONFIGURATION_SET } : {})
      }));
    } catch (e) {
      if (sesDefinitelyRejected(e)) {                                // SES refused it: not sent, the messageId may be retried
        try { await persistOutcome(key, { ...claim, state: 'failed', retryable: true, error: String(e.name || e.message).slice(0, 200), failedAt: new Date().toISOString() }); } catch (err) { console.warn('outbox failed-state write failed:', err.message); }
        return res.status(502).json({ error: 'The mail service rejected the message: ' + (e.name || e.message), deliveryMayHaveOccurred: false });
      }
      deliveryMayHaveOccurred = true;                                // ambiguous: stays 'pending', never resent automatically
      audit('send_external_unknown', req.walletAddress, { messageId: fid, reason: String(e.name || e.message).slice(0, 120) });
      return res.status(502).json({ error: 'Delivery outcome unknown; it will not be resent automatically', messageId: fid, deliveryMayHaveOccurred: true });
    }
    deliveryMayHaveOccurred = true;

    // 3. record the outcome
    const sentAt = new Date().toISOString();
    try { await persistOutcome(key, { ...claim, state: 'sent', sesMessageId: out?.MessageId || null, sentAt }); }
    catch (e) {
      console.error('outbox sent-state write failed after SES accepted:', e.message);
      audit('send_external_outbox_unpersisted', req.walletAddress, { messageId: fid, sesMessageId: out?.MessageId || null });
      return res.status(503).json({
        error: 'The mail service accepted the message, but its outbox result could not be saved. Do not resend; reconcile this messageId.',
        messageId: fid, state: 'unknown', accepted: true, persistenceUnknown: true,
        deliveryMayHaveOccurred: true, sesMessageId: out?.MessageId || null
      });
    }
    const entry = sentEntry({ sesMessageId: out?.MessageId || null });
    try { await writeSent(entry); }
    catch (e) { return res.status(500).json({ error: 'Sent, but the sent record could not be saved; retry with the same messageId to repair it', messageId: fid, delivered: true, deliveryMayHaveOccurred: true }); }
    if (!sentEmails.has(req.walletAddress)) sentEmails.set(req.walletAddress, []);
    sentEmails.get(req.walletAddress).push(entry);

    audit('send_external', req.walletAddress, { messageId: fid, recipientEmail, sesMessageId: out?.MessageId || null });
    res.json({ sent: true, messageId: fid, fromEmail: req.emailAddress, toEmail: recipientEmail, sesMessageId: out?.MessageId || null });
  } catch (err) { console.error('Send external error:', err); res.status(500).json({ error: err.message, deliveryMayHaveOccurred }); }
});

// Outbox state of one of your own external messages (for a client that got an unclear answer)
app.get('/api/messages/outbox/:messageId', requireAuth, async (req, res) => {
  try {
    const id = req.params.messageId; if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) return res.status(404).json({ error: 'Not found' });
    const cur = (reconcileStatus.enabled ? await journalGet(req.walletAddress.toLowerCase(), id) : null) || await outboxGet(outboxKey(req.walletAddress.toLowerCase(), id));
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const { state, claimedAt, sentAt, failedAt, sesMessageId, error, reconciledAt, reconciledBy, resolution } = cur.rec;
    let events = null;
    try { events = (await outboxEvents(req.walletAddress.toLowerCase(), id)).map(e => ({ eventType: e.eventType, timestamp: e.timestamp, sesMessageId: e.sesMessageId, detail: e.detail })); } catch { events = null; }
    res.set('Cache-Control', 'private, no-store').json({ messageId: id, state, claimedAt, sentAt, failedAt, sesMessageId, error, reconciledAt, reconciledBy,
      resolution: resolution ? { state: resolution.state, at: resolution.at, reason: resolution.reason } : undefined, events });
  } catch (err) { res.status(503).json({ error: 'Could not load outbox state' }); }
});

// Read all pages before returning a successful mailbox response. A truncated
// response without a progressing cursor must fail, never masquerade as complete.
async function listMailObjects(prefix, maxKeys) {
  const Contents = [], seen = new Set();
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, MaxKeys: maxKeys,
      ...(token ? { ContinuationToken: token } : {}) }));
    Contents.push(...(page.Contents || []));
    if (!page.IsTruncated) return { Contents };
    const next = page.NextContinuationToken;
    if (typeof next !== 'string' || !next || seen.has(next)) throw new Error('Incomplete object listing');
    seen.add(next); token = next;
  } while (true);
}

function mailAliases(req) {
  const wallet = req.walletAddress.toLowerCase();
  const aliases = new Set([wallet, `${wallet}@${EMAIL_DOMAIN}`]);
  const ens = trustedMailNames.get(wallet);
  // Wallet-shaped local parts are reserved for that wallet, not ENS aliases.
  if (ens && !/^0x[0-9a-f]{40}$/i.test(ens)) {
    for (const value of [`${ens}@${EMAIL_DOMAIN}`, ens, `${ens}.dfmi`]) aliases.add(value.toLowerCase());
  }
  return aliases;
}

function mimeVisible(parsed, aliases) {
  const recipients = [...(parsed.to?.value || []), ...(parsed.cc?.value || [])];
  return recipients.some(v => aliases.has(v.address?.toLowerCase()));
}

async function mailBytes(key) {
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const chunks = []; for await (const chunk of data.Body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.name === 'NotFound') return null;
    e.mailStorageFailure = true; throw e;
  }
}

function attachmentMetadata(parsed, id) {
  return (parsed.attachments || []).map((a, index) => ({ index,
    filename: Array.from(Buffer.from(String(a.filename || `attachment-${index}.bin`)).toString('utf8')
      .replace(/[\x00-\x1f\x7f/\\]/g, '_')).slice(0, 200).join(''),
    contentType: a.contentType || 'application/octet-stream', size: a.content.length,
    downloadUrl: `/api/messages/${encodeURIComponent(id)}/attachments/${index}` }));
}

// ─── Inbox scan cost (2026-11-26 capacity test) ───
// The inbox reads every object under raw/ and content/ (all users) and keeps the ones addressed to the caller. MIME
// objects are written once, so the parsed result of each is cached by key + ETag/LastModified/Size (bounded by bytes,
// least recently used evicted); the listing is still read live on every request. Reads are done with limited parallelism. Who may see a message is still decided
// per request from the caller's aliases; a storage failure still fails the whole request.
const MAIL_CACHE_MAX = Number(process.env.MAIL_CACHE_BYTES) || 64 * 1024 * 1024;
const MAIL_FETCH_PARALLEL = Number(process.env.MAIL_FETCH_PARALLEL) || 8;
const mailSummaryCache = new Map(); let mailSummaryBytes = 0;
async function cachedSummary(obj, build) {
  const ver = `${obj.ETag || ''}:${obj.LastModified ? new Date(obj.LastModified).getTime() : ''}:${obj.Size ?? ''}`;
  const hit = mailSummaryCache.get(obj.Key);
  if (hit && hit.ver === ver) { mailSummaryCache.delete(obj.Key); mailSummaryCache.set(obj.Key, hit); return hit.val; }
  const val = await build();
  if (val === undefined) return null;                  // object missing right now: do not remember that
  const size = (val ? JSON.stringify(val).length : 0) + obj.Key.length + 64;
  if (hit) { mailSummaryCache.delete(obj.Key); mailSummaryBytes -= hit.size; }
  if (size <= MAIL_CACHE_MAX / 4) {
    mailSummaryCache.set(obj.Key, { ver, val, size }); mailSummaryBytes += size;
    for (const [k, v] of mailSummaryCache) { if (mailSummaryBytes <= MAIL_CACHE_MAX) break; mailSummaryCache.delete(k); mailSummaryBytes -= v.size; }
  }
  return val;
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}
// Parsed MIME message without its attachment bodies (null = unreadable, never shown)
function mimeSummary(obj) {
  if (obj.Key.includes('AMAZON_SES_SETUP_NOTIFICATION')) return null;
  return cachedSummary(obj, async () => {
    const bytes = await mailBytes(obj.Key);              // throws (mailStorageFailure) if storage fails
    if (!bytes) return undefined;
    try {
      const parsed = await simpleParser(bytes);
      const eid = obj.Key.split('/').pop();
      const fromAddr = parsed.from?.value?.[0]?.address;
      return {
        recipients: [...(parsed.to?.value || []), ...(parsed.cc?.value || [])].map(v => v.address?.toLowerCase()).filter(Boolean),
        fromAddr: fromAddr || null, fromName: parsed.from?.value?.[0]?.name || '', toAddr: parsed.to?.value?.[0]?.address || null,
        wmId: parsed.headers?.get('x-walletmail-id') || null, subject: parsed.subject || null,
        text: parsed.text || '', html: parsed.html || '', date: parsed.date ? parsed.date.getTime() : null,
        attachments: attachmentMetadata(parsed, eid),
      };
    } catch (e) { console.warn('Parse error:', obj.Key, e.message); return null; }
  });
}
// content/ records are small JSON: read every time (in parallel), not cached, so a read failure still fails the request
async function contentRecord(obj) {
  const bytes = await mailBytes(obj.Key);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
}

app.get('/api/messages/inbox', requireAuth, async (req, res) => {
  try {
    const userEmail = req.emailAddress.toLowerCase();
    const walletAddr = req.walletAddress.toLowerCase();
    const emails = [];
    const seenIds = new Set();

    const aliases = mailAliases(req);
    console.log(`[Inbox] Wallet: ${walletAddr}, aliases:`, [...aliases]);

    // Load persisted read/star/deleted state from S3
    const deletedIds = new Set();
    try {
      const readListed = await listMailObjects(`state/${walletAddr}/read/`, 500);
      if (readListed.Contents) {
        for (const obj of readListed.Contents) {
          const eid = obj.Key.split('/').pop();
          readState.set(`${walletAddr}:${eid}`, true);
        }
      }
      const starListed = await listMailObjects(`state/${walletAddr}/star/`, 500);
      if (starListed.Contents) {
        for (const obj of starListed.Contents) {
          const eid = obj.Key.split('/').pop();
          const data = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
          const val = await streamToString(data.Body);
          starState.set(`${walletAddr}:${eid}`, val === 'true');
        }
      }
      const deletedListed = await listMailObjects(`state/${walletAddr}/deleted/`, 500);
      if (deletedListed.Contents) {
        for (const obj of deletedListed.Contents) {
          deletedIds.add(obj.Key.split('/').pop());
        }
      }
    } catch (e) { console.warn('S3 state load error:', e.message); throw e; }

    // Helper: an email entry from a parsed message (always filters by recipient)
    function emailFromSummary(obj, m) {
      if (!m) return null;
      // Always check that this email is addressed to this wallet owner
      if (!m.recipients.some(a => aliases.has(a))) return null;
      // Skip emails sent BY this wallet owner (those belong in Sent)
      if (aliases.has((m.fromAddr || '').toLowerCase())) return null;
      const eid = obj.Key.split('/').pop();
      const wmId = m.wmId;
      if (wmId && seenIds.has(wmId)) return null;
      if (wmId) seenIds.add(wmId);
      if (seenIds.has(eid)) return null;
      seenIds.add(eid);
      const sk = `${walletAddr}:${eid}`;
      return {
        id: eid, messageId: wmId || null,
        from: m.fromAddr || 'unknown',
        fromName: m.fromName,
        to: m.toAddr || userEmail,
        subject: m.subject || '(no subject)',
        body: m.text, html: m.html,
        timestamp: m.date ?? obj.LastModified.getTime(),
        sentAt: m.date ?? null,
        receivedAt: obj.LastModified ? obj.LastModified.getTime() : null,
        read: !!readState.get(sk), starred: !!starState.get(sk), attachments: m.attachments.map(a => ({ ...a })),
        verified: !!wmId, internal: (m.fromAddr || '').endsWith(`@${EMAIL_DOMAIN}`)
      };
    }
    async function scanMime(objects) {
      const summaries = await mapLimit(objects, MAIL_FETCH_PARALLEL, mimeSummary);
      objects.forEach((obj, i) => { const email = emailFromSummary(obj, summaries[i]); if (email) emails.push(email); });
    }

    // 1. Scan raw/ prefix (SES direct S3 delivery) — must match recipients
    try {
      const rawListed = await listMailObjects('raw/', 100);
      if (rawListed.Contents) await scanMime(rawListed.Contents.reverse());
    } catch (e) { console.warn('Raw scan error:', e.message); throw e; }

    // 2. Scan incoming/{wallet}/ prefix (SNS webhook delivery) — already filtered by wallet
    try {
      const incomingListed = await listMailObjects(`incoming/${walletAddr}/`, 100);
      if (incomingListed.Contents) await scanMime(incomingListed.Contents.reverse());
    } catch (e) { console.warn('Incoming scan error:', e.message); throw e; }

    // 3. Scan content/ prefix for WalletMail internal messages sent to this user
    try {
      const contentListed = await listMailObjects('content/', 100);
      if (contentListed.Contents) {
        const objects = contentListed.Contents.reverse();
        const msgs = await mapLimit(objects, MAIL_FETCH_PARALLEL, contentRecord);
        for (const [i, obj] of objects.entries()) {
          try {
            const msg = msgs[i];
            if (!msg) continue;
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
          } catch (e) { if (e.mailStorageFailure) throw e; /* skip non-JSON or malformed */ }
        }
      }
    } catch (e) { console.warn('Content scan error:', e.message); throw e; }

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
    res.status(503).json({ error: 'Could not load complete mailbox' });
  }
});

app.get('/api/messages/sent', requireAuth, async (req, res) => {
  try {
    const wallet = req.walletAddress.toLowerCase();
    // Always load from S3 to ensure we have everything persisted
    const s3Emails = [];
    try {
      const listed = await listMailObjects(`sent/${wallet}/`, 200);
      if (listed.Contents && listed.Contents.length > 0) {
        for (const obj of listed.Contents) {
          try {
            const bytes = await mailBytes(obj.Key);
            if (!bytes) continue;
            const entry = JSON.parse(bytes.toString('utf8'));
            s3Emails.push(entry);
          } catch (e) { if (e.mailStorageFailure) throw e; /* skip bad entries */ }
        }
      }
    } catch (e) { console.warn('S3 sent load error:', e.message); throw e; }

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

async function mailJson(key) {
  const bytes = await mailBytes(key);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
}

async function mailDeleted(wallet, ...ids) {
  for (const id of ids.filter(Boolean)) {
    if (await mailBytes(`state/${wallet}/deleted/${id}`)) return true;
  }
  return false;
}

// Resolve details and downloads from the same authoritative source and access
// checks. Never grant access merely because another wallet warmed a cache.
async function visibleMessage(req) {
  const id = req.params.messageId, wallet = req.walletAddress.toLowerCase();
  if (!id || id.length > 256 || id === '.' || id === '..' || /[/\\\x00-\x1f\x7f]/.test(id)) return null;
  if (await mailDeleted(wallet, id)) return null;
  const aliases = mailAliases(req);
  const content = await mailJson(`content/${id}.json`);
  if (content && (String(content.sender || '').toLowerCase() === wallet || aliases.has(String(content.recipientValue || '').toLowerCase()))) {
    return { detail: { messageId: id, subject: content.subject, body: content.body,
      subjectHash: content.subjectHash, bodyHash: content.bodyHash, sender: content.sender,
      timestamp: content.storedAt || content.timestamp, attachments: [] }, attachments: [] };
  }
  const sent = await mailJson(`sent/${wallet}/${id}.json`);
  if (sent && String(sent.from || '').toLowerCase() === wallet) {
    return { detail: { messageId: id, subject: sent.subject, body: sent.body, sender: sent.from,
      timestamp: sent.timestamp, attachments: [] }, attachments: [] };
  }
  const tried = new Set();
  async function mime(key) {
    if (tried.has(key)) return null;
    tried.add(key);
    const bytes = await mailBytes(key);
    if (!bytes) return null;
    let parsed;
    try { parsed = await simpleParser(bytes); } catch { return null; }
    const sender = parsed.from?.value?.[0]?.address?.toLowerCase();
    // Raw incoming From headers can be spoofed. Only recipients may read raw
    // objects; sender access is granted by its authenticated sent/content record.
    if (!mimeVisible(parsed, aliases)) return null;
    const wmId = parsed.headers?.get('x-walletmail-id');
    if (typeof wmId === 'string' && await mailDeleted(wallet, wmId)) return null;
    return { detail: { messageId: id, subject: parsed.subject || '(no subject)', body: parsed.text || '',
      html: parsed.html || '', sender, timestamp: parsed.date?.getTime(), attachments: attachmentMetadata(parsed, id) },
      attachments: parsed.attachments || [] };
  }
  for (const key of [`raw/${id}`, `incoming/${wallet}/${id}`]) {
    const result = await mime(key); if (result) return result;
  }
  // Old SES keys may have nested prefixes; inbox IDs remain their basename.
  for (const prefix of ['raw/', `incoming/${wallet}/`]) {
    const listed = await listMailObjects(prefix, 100);
    for (const obj of listed.Contents) {
      if (obj.Key.split('/').pop() !== id) continue;
      const result = await mime(obj.Key); if (result) return result;
    }
  }
  return null;
}

app.get('/api/messages/:messageId/attachments/:index', requireAuth, async (req, res) => {
  try {
    if (!/^(0|[1-9]\d*)$/.test(req.params.index)) return res.status(404).json({ error: 'Not found' });
    const message = await visibleMessage(req);
    const index = Number(req.params.index);
    const attachment = Number.isSafeInteger(index) && message?.attachments[index];
    if (!attachment) return res.status(404).json({ error: 'Not found' });
    const name = message.detail.attachments[index].filename;
    const encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="attachment-${index}.bin"; filename*=UTF-8''${encoded}`,
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store' });
    res.send(attachment.content);
  } catch (err) { res.status(503).json({ error: 'Could not load attachment' }); }
});

app.get('/api/messages/:messageId', requireAuth, async (req, res) => {
  try {
    const message = await visibleMessage(req);
    if (!message) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'private, no-store').json(message.detail);
  } catch (err) { res.status(503).json({ error: 'Could not load message' }); }
});

app.post('/api/messages/:messageId/read', requireAuth, async (req, res) => {
  try {
    const k = `${req.walletAddress}:${req.params.messageId}`;
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `state/${req.walletAddress}/read/${req.params.messageId}`, Body: 'true', ContentType: 'text/plain' }));
    readState.set(k, true);
    res.json({ read: true });
  } catch (err) { res.status(503).json({ error: 'Could not save read state' }); }
});

app.post('/api/messages/:messageId/star', requireAuth, async (req, res) => {
  try {
    const k = `${req.walletAddress}:${req.params.messageId}`;
    const v = !starState.get(k);
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `state/${req.walletAddress}/star/${req.params.messageId}`, Body: v ? 'true' : 'false', ContentType: 'text/plain' }));
    starState.set(k, v);
    res.json({ starred: v });
  } catch (err) { res.status(503).json({ error: 'Could not save star state' }); }
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
      await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: `sent/${wallet}/${messageId}.json` }));
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
  try {
    const body = req.body || {};
    const incoming = Array.isArray(body) ? body : (Array.isArray(body.contacts) ? body.contacts : null);
    if (!incoming) return res.status(400).json({ error: 'Expected { contacts: [] }' });
    const wallet = req.walletAddress.toLowerCase();
    const list = sanitizeContacts(incoming);
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `contacts/${wallet}.json`, Body: JSON.stringify({ v: 1, address: wallet, updatedAt: Date.now(), contacts: list }), ContentType: 'application/json' }));
    contactBooks.set(wallet, list);
    audit('contacts_saved', wallet, { count: list.length });
    res.json({ saved: true, count: list.length });
  } catch (err) { res.status(503).json({ error: 'Could not save contacts' }); }
});

// ─── Utility Routes ───
// Sign out: this session only.
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    await dropSession(req.sessionToken);
    audit('logout', req.walletAddress);
    res.json({ ok: true });
  } catch (err) { res.status(503).json({ error: 'Could not revoke session, try again' }); }
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
  const { enabled, lastOkAt, lastError, pendingStale, pendingStaleOldest, lastCanaryAt } = reconcileStatus;
  res.json({ status: 'ok', version: '2.0.0', spec: 'Master-Spec-v1.0', domain: EMAIL_DOMAIN, mailbox: MAILBOX_ADDR || 'not configured', time: new Date().toISOString(),
    outbox: { reconcile: enabled, lastOkAt, lastError, pendingStale, pendingStaleOldest, lastCanaryAt } });
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
