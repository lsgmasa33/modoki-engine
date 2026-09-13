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

/** Classifies a `gcloud storage ls`/`rm` failure's stderr as "that URL or glob matched nothing" (#836).
 *
 *  A THIRD predicate, deliberately not either of the two above: `ls` and `rm` of a missing prefix or
 *  glob say `ERROR: (gcloud.storage.ls) One or more URLs matched no objects.` (measured against the
 *  real `modoki-www-site` bucket, 2026-09-13) — with no `or files` suffix, so
 *  {@link isGcloudObjectNotFoundError} reads it as "could not check", and no `release.json`, so
 *  `isGcsObjectMissing` does too. Anything else stays a failure the caller must not read as "empty". */
export function isGcloudNoMatchError(stderr) {
  return /matched no objects/i.test(stderr);
}

/** Wraps a value for interpolation into a command run through a real shell — `/bin/sh` on POSIX,
 *  `cmd.exe` on Windows, which is why these calls go through `execSync` at all: Windows resolves
 *  `gcloud` to `gcloud.cmd`, which a shell-less spawn cannot run.
 *
 *  DEFENSE IN DEPTH, not the primary guard: bundle names, versions and buckets are rejected against
 *  OTA_SAFE_TOKEN/OTA_SAFE_BUCKET before they get here, so none of those can carry a shell
 *  metacharacter. What this still protects are paths a script derives itself (mkdtemp staging dirs,
 *  a repo checked out under a path with a space), which must round-trip through the shell intact.
 *
 *  POSIX single quotes suppress all expansion; `'\''` is the standard way to put a literal `'` inside
 *  one. The old `JSON.stringify` form emitted DOUBLE quotes, inside which `$(...)`, backticks and
 *  `${...}` still expand — it only ever JSON-escaped (#649). win32 keeps the double-quote form: cmd.exe
 *  does not treat `'` as a quote at all, so single-quoting would paste the quote characters into the
 *  argument. ⚠️ That win32 branch is UNVALIDATED against a real Windows shell from this machine. */
export function shellQuote(value) {
  return process.platform === 'win32'
    ? JSON.stringify(String(value))
    : `'${String(value).replace(/'/g, "'\\''")}'`;
}
