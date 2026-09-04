/** Shell-injection safety regexes for OTA publish inputs (name/version/key, and the bucket
 *  URL) — pulled out of `engine/plugins/backend/gcloud.ts` into a plain `.mjs` module (#649,
 *  the same move #582 made for `otaSigningKeyRefusal`/`otaBundleDistKindRefusal` in
 *  `publishGuards.mjs`) so BOTH the TS editor routes (`editorBackendRouter.ts`,
 *  `vite-asset-scanner.ts`) and `engine/scripts/ota-publish.mjs` (a CLI that reaches the SAME
 *  shared gcloud publish operation, run as a child process) share ONE definition. A `.ts`
 *  module can't be imported by the `.mjs` CLI, so before this move the CLI validated only
 *  presence of `--name`/`--version`/`--bucket`, not charset — exactly #582's class of bug: a
 *  guard one of two entry points to the same operation enforces and the other lacks. */

/** A version/bundle-name/key-name string interpolated into a `bash -c` command
 *  (buildStepShell.ts) — must never carry shell metacharacters. Same discipline as
 *  `validateBuildConfig`. */
export const OTA_SAFE_TOKEN = /^[A-Za-z0-9._-]{1,64}$/;
/** A `gs://bucket[/prefix]` URL, similarly constrained before shell interpolation. */
export const OTA_SAFE_BUCKET = /^gs:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._/-]*)?$/;
