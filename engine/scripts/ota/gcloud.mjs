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

import { execFileSync } from 'node:child_process';
import { toSpawn } from '../winSpawn.mjs';

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

/** Run `gcloud <args>` — argv, NO shell (#1537), on both platforms. Returns stdout like
 *  `execFileSync`, and throws its error (with `stdout`/`stderr` attached) on a non-zero exit.
 *
 *  This replaced a `shellQuote` + `execSync` pair. POSIX was already safe (single quotes), but the
 *  win32 branch double-quoted, and cmd.exe expands `%VAR%` inside double quotes — so a staging dir
 *  under a profile path holding `%` changed the upload target. `toSpawn` resolves `gcloud` to
 *  `gcloud.cmd` on Windows and runs it through an escaped cmd.exe line; everything else is a plain exec.
 *  Bundle names, versions and buckets are still refused against OTA_SAFE_TOKEN/OTA_SAFE_BUCKET upstream. */
export function gcloudSync(args, opts = {}) {
  // No `!` special case: the real gcloud.cmd enables delayed expansion only for its python probing and
  // runs `SETLOCAL DisableDelayedExpansion` before forwarding `%*` (SDK 581; verified by the #1537
  // review against the installed script, which retracted an earlier fixture that modelled it wrong).
  const s = toSpawn('gcloud', args, { env: opts.env });
  return execFileSync(s.command, s.args, { ...s.options, ...opts });
}
