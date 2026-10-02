/** Ed25519 signing for OTA release documents. Node-only (uses `node:crypto`'s
 *  built-in Ed25519 support — Node 12+ — so no signing dependency is added to
 *  the repo). Keys are exchanged as raw 32-byte values, base64url-encoded (the
 *  JWK `x`/`d` field), NOT PEM/DER — this is the form that is cheapest to bake
 *  into a native app (a single string constant) and to re-derive a KeyObject
 *  from on either side. */

import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey, createPrivateKey } from 'node:crypto';
import { signingPayload } from './schema.mjs';

/** Generates a fresh Ed25519 keypair. Returns raw base64url-encoded keys —
 *  `publicKey` is what gets baked into the app; `privateKey` MUST stay off the
 *  device and out of the repo (see engine/scripts/ota-keygen.mjs, which writes
 *  it under the project's gitignored `build/ota-keys/`, #1983). */
export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'jwk' }).x,
    privateKey: privateKey.export({ format: 'jwk' }).d,
  };
}

function publicKeyObjectFromRaw(rawBase64url) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: rawBase64url }, format: 'jwk' });
}

function privateKeyObjectFromRaw(rawBase64url, publicKeyBase64url) {
  // Node's JWK import for OKP private keys requires the public `x` alongside
  // `d` — both are already carried around together in ota-keygen's output, so
  // this is never a burden on the caller.
  return createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: rawBase64url, x: publicKeyBase64url }, format: 'jwk' });
}

/** The DER prefix of an Ed25519 PKCS#8 private key, before its 32-byte seed (RFC 8410 § 7). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The public half a raw (base64url) Ed25519 private key DERIVES, or null when it is not one. The
 *  only check that a keypair file is a pair: its `publicKey` field is just a claim, and a file whose
 *  private half belongs to another key signs releases every installed app rejects (#1993). Built from
 *  the seed alone on purpose — the JWK import wants `x` beside `d`, i.e. the very claim being checked. */
export function derivePublicKey(privateKey) {
  if (typeof privateKey !== 'string') return null;
  const seed = Buffer.from(privateKey, 'base64url');
  if (seed.length !== 32 || seed.toString('base64url') !== privateKey) return null;
  try {
    const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    return createPublicKey(key).export({ format: 'jwk' }).x;
  } catch {
    return null;
  }
}

/** Returns a NEW release object equal to `unsignedRelease` plus a `sig` field:
 *  the Ed25519 signature (base64url) over `signingPayload(unsignedRelease)`. */
export function signRelease(unsignedRelease, { privateKey, publicKey }) {
  const keyObject = privateKeyObjectFromRaw(privateKey, publicKey);
  const payload = Buffer.from(signingPayload(unsignedRelease), 'utf8');
  const sig = nodeSign(null, payload, keyObject).toString('base64url');
  return { ...unsignedRelease, sig };
}

/** Verifies a signed release's `sig` against its own `signingPayload` (every
 *  field except `sig`). Returns a boolean — never throws on a malformed/absent
 *  `sig`, so callers can treat "invalid" and "unparseable" the same way. */
export function verifyRelease(release, publicKey) {
  if (typeof release?.sig !== 'string' || !release.sig) return false;
  try {
    const keyObject = publicKeyObjectFromRaw(publicKey);
    const payload = Buffer.from(signingPayload(release), 'utf8');
    const sig = Buffer.from(release.sig, 'base64url');
    return nodeVerify(null, payload, keyObject, sig);
  } catch {
    return false;
  }
}
