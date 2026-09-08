/** Type sidecar for `gcloud.mjs` — see that file for the design rationale.
 *  Hand-written because the module is plain JS, following the sibling `.d.mts`
 *  convention established by `signing.d.mts`/`schema.d.mts`. */

/** Classifies a `gcloud storage cat`/`objects describe` failure's stderr: a missing object
 *  is the ONLY shape that means "safe to proceed"; every other failure (auth expired,
 *  network blip, wrong bucket permissions) must fail CLOSED. */
export function isGcloudObjectNotFoundError(stderr: string): boolean;
