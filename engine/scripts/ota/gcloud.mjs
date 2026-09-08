/** Classifying `gcloud storage` failures for the OTA publish pipeline. Shared by
 *  `ota-publish.mjs` (the CLI, run as a child process) and, previously, the editor's
 *  `/api/ota/publish` route directly — that route no longer runs a collision check of its
 *  own (#577: the CLI is the single source of truth for that decision), but the stderr
 *  classifier stays a plain-JS module here so anything shelling out to `gcloud storage`
 *  can share it without importing a Vite plugin module.
 *
 *  NOT the same predicate as `isGcsObjectMissing` in engine/plugins/backend/gcloud.ts, and
 *  the two are INCOMPARABLE — neither is a superset of the other. Each is tuned to the
 *  stderr its own call site actually sees: this one to `gcloud storage cat` of a versioned
 *  `manifest.json`, that one to a `cat` of `release.json` for `/api/ota/status`. Concretely
 *  they disagree BOTH ways — `"…matched no objects:\ngs://b/x"` is missing to that one and
 *  not to this one (this requires the `or files` suffix); `"…/manifest.json not found: 404."`
 *  is missing to this one and not to that one (its 404 clause is gated on the literal
 *  `release.json`). So they must not be unified onto either side: collapsing this one onto
 *  `isGcsObjectMissing` would classify the real 404 of a never-published manifest as "could
 *  not check" and fail EVERY first publish of a new version.
 *
 *  ⚠️ The `not_found`-vs-loose-"not found" note in that file is about an earlier BROAD
 *  version of that same function (which matched `gcloud: command not found`). It says
 *  nothing about this one, which requires `not found: 404` and so never matched that. */

/** Classifies a `gcloud storage cat`/`objects describe` failure's stderr: a missing object
 *  is the ONLY shape that means "safe to proceed" — `gcloud storage cat` reports it as
 *  "not found: 404" or "matched no objects or files" on stderr. Every other failure (auth
 *  expired, network blip, wrong bucket permissions) must fail CLOSED instead of being
 *  treated as "no collision": "could not check" and "definitely absent" are different
 *  answers, and conflating them fails open on exactly the errors a collision guard most
 *  needs to catch. */
export function isGcloudObjectNotFoundError(stderr) {
  return /not found: 404|matched no objects or files/i.test(stderr);
}
