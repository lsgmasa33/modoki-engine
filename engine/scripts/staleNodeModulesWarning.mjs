/** The shared warning text for the #685/#731 "package.json could not be read, so the
 *  stale-node_modules check did not run" case.
 *
 *  Its one caller is `engine/plugins/healNativeProject.ts` — the native-heal sequence both the
 *  editor's `/api/build` and `build-web.mjs --target native` run (#827). It used to have two, one per
 *  entry point, which is why it was extracted: the two copies of the sentence had to match byte for
 *  byte. With the sequence itself shared, one caller is the expected state, not a regression.
 *
 *  A plain `.mjs` module, not TypeScript, for the same reason as `buildClaimsStore.mjs` next door:
 *  the CLI side reaches it through an esbuild bundle of the `.ts` caller, and a `.mjs` needs nothing
 *  loaded to be imported. Typed by the paired `staleNodeModulesWarning.d.mts` sidecar. Its text is
 *  tested directly (`cliNativeBuildHeals.test.ts`, "describeUnreadablePackageJsonWarning"). */

import path from 'node:path';

/** `projectRoot` is the resolved project root whose `package.json` could not be read or parsed —
 *  named in the message so a human reading a build log knows which project it's about. The caller's
 *  `warn` port adds any prefix (`build-web.mjs` prepends `[build-web] `; the editor route sends it
 *  into the SSE build log as-is) — this returns only the sentence itself. The path is joined with
 *  `path.join`, not a literal `/`, so a Windows log names `C:\…\proj\package.json` rather than a
 *  mixed-separator `C:\…\proj/package.json` (public Windows CI caught that). */
export function describeUnreadablePackageJsonWarning(projectRoot) {
  return `⚠️ ${path.join(projectRoot, 'package.json')} could not be read or parsed, so the #685 `
    + 'stale-node_modules check did NOT run for this project — a native build here could ship '
    + 'the wrong plugin bytes undetected.';
}
