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
 *  it under the gitignored `build/ota-keys/`). */
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
