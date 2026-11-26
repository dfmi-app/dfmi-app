import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const { isoCBOR } = createRequire(import.meta.url)('@simplewebauthn/server/helpers');
const ORIGIN='https://identity.dfmi.app';
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (b) => crypto.createHash('sha256').update(b).digest();
export function authenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const credId = crypto.randomBytes(32);
  const a = { counter: 0, id: b64u(credId) };
  const authData = (rpId, flags, withCred) => {
    const ctr = Buffer.alloc(4); ctr.writeUInt32BE(a.counter);
    const parts = [sha(rpId), Buffer.from([flags]), ctr];
    if (withCred) { const len = Buffer.alloc(2); len.writeUInt16BE(credId.length); parts.push(Buffer.alloc(16), len, credId, Buffer.from(cose)); }
    return Buffer.concat(parts);
  };
  a.create = (options, { origin = ORIGIN, rpId = options.rp.id } = {}) => {
    const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }));
    const att = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(rpId, 0x45, true)]]));
    return { id: a.id, rawId: a.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(cdj), attestationObject: b64u(att), transports: ['internal'] } };
  };
  a.get = (options, { origin = ORIGIN, rpId = options.rpId, counter, tamper = false } = {}) => {
    a.counter = counter ?? a.counter + 1;
    const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
    const ad = authData(rpId, 0x05, false);
    let sig = crypto.sign('sha256', Buffer.concat([ad, sha(cdj)]), privateKey);
    if (tamper) sig = Buffer.from(sig.map((x, i) => (i === sig.length - 1 ? x ^ 1 : x)));
    return { id: a.id, rawId: a.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(cdj), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: b64u(Buffer.from('x')) } };
  };
  return a;
}
