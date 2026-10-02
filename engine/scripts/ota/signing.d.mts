/** Type sidecar for `signing.mjs` — see that file for the design rationale.
 *  Hand-written because the module is plain JS (Node-only, `node:crypto`'s Ed25519),
 *  following the sibling `.d.mts` convention established by `schema.d.mts`. */

import type { OtaRelease, OtaReleaseUnsigned } from './schema.mjs';

/** Generates a fresh Ed25519 keypair. Both keys are raw base64url-encoded values (a
 *  JWK `x`/`d` field), not PEM/DER. */
export function generateKeypair(): { publicKey: string; privateKey: string };

/** The public half a raw (base64url) Ed25519 private key derives, or null when it is not one —
 *  the check that a keypair file is a PAIR, not merely a file claiming a `publicKey` (#1993). */
export function derivePublicKey(privateKey: unknown): string | null;

/** Returns a NEW release object equal to `unsignedRelease` plus a `sig` field — the
 *  Ed25519 signature (base64url) over `signingPayload(unsignedRelease)`. */
export function signRelease(
  unsignedRelease: OtaReleaseUnsigned,
  keys: { privateKey: string; publicKey: string },
): OtaRelease;

/** Verifies a signed release's `sig` against its own `signingPayload` (every field
 *  except `sig`). `release` is deliberately `unknown` — this never throws on a
 *  malformed/absent `sig` or a garbage/null input, it just returns `false`, so
 *  callers (and this file's own tests) pass arbitrary shapes through it on purpose. */
export function verifyRelease(release: unknown, publicKey: string): boolean;
