/** The shared warning text for the #685/#731 "package.json could not be read, so the
 *  stale-node_modules check did not run" case — emitted by TWO call sites that must say the exact
 *  same thing, because they are documented as equivalent (docs/build.md, #148 parity):
 *  `build-web.mjs` (the CLI `--target native` recipe `npm run build` actually runs) and
 *  `engine/plugins/vite-asset-scanner.ts`'s `/api/build` route (the editor's own build pipeline).
 *
 *  A plain `.mjs` module, not TypeScript, because `build-web.mjs` is a CLI script that cannot
 *  import `.ts` files — same reasoning as `buildClaimsStore.mjs`/`buildClaimsStore.d.mts` next
 *  door. `vite-asset-scanner.ts` imports this file directly too (both already import
 *  `projectRoots.mjs` from this same directory the identical way), typed by the paired
 *  `staleNodeModulesWarning.d.mts` sidecar.
 *
 *  This replaces a text-extraction test (`cliNativeBuildHeals.test.ts`'s former "#731 equivalence"
 *  describe block) that `eval`'d each call site's own string literal to prove the two matched byte
 *  for byte. That approach broke the moment the shared text was actually extracted here — there is
 *  no longer a per-file literal for either side to diverge on, which was the whole point. Now there
 *  is exactly ONE copy of the sentence; a content change to it is caught by testing this function's
 *  own output directly, and a call site quietly re-inlining its own literal instead of calling this
 *  function is caught by asserting BOTH sides actually import and call it. */

/** `projectRoot` is the resolved project root whose `package.json` could not be read or parsed —
 *  named in the message so a human reading a build log knows which project it's about. Callers add
 *  their own prefix on top (`build-web.mjs` prepends `[build-web] ` before logging; the editor
 *  route sends this string straight into the SSE build log with no prefix at all) — this returns
 *  only the sentence itself, so that prefixing stays each caller's own concern. */
export function describeUnreadablePackageJsonWarning(projectRoot) {
  return `⚠️ ${projectRoot}/package.json could not be read or parsed, so the #685 `
    + 'stale-node_modules check did NOT run for this project — a native build here could ship '
    + 'the wrong plugin bytes undetected.';
}
