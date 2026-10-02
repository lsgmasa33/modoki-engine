/** Type sidecar for `otaSafeTokens.mjs` — see that file for the design rationale.
 *  Hand-written because the module is plain JS, following the sibling `.d.mts` convention
 *  established by `schema.d.mts`/`signing.d.mts`. */

export const OTA_SAFE_TOKEN: RegExp;
export const OTA_SAFE_BUCKET: RegExp;

/** A signing-key name: a safe token not starting with `-` (it reaches argv as a positional, #1993). */
export function isOtaKeyName(name: unknown): name is string;
