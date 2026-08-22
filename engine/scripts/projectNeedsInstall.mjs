/**
 * Does a project under games/ or demos/ need its own `npm install`?
 *
 * Extracted from `bootstrap-game-deps.mjs` so the rule is TESTABLE — that script's body runs on
 * import (it installs things), so nothing could assert on its selection without doing the work.
 * The rule lives here, in one place, and `projectNeedsInstall.test.ts` sweeps the real projects
 * against it.
 *
 * ⚠️ The test used to be `!pkg.workspaces` alone, and that silently skipped every project that has
 * real dependencies but owns no sub-packages — 14 of them (#215). A fresh clone got no
 * `node_modules` for any of them, so their native builds died at package resolution:
 *
 *     xcodebuild: error: Could not resolve package dependencies:
 *       the package at '…/games/court/node_modules/@capacitor/haptics' cannot be accessed
 *
 * …because the committed `Package.swift` correctly points at the game's OWN node_modules (the
 * self-contained-game rule), and nothing ever populated it. It also explains the "cap sync
 * rewrites Package.swift into a portability violation" trap: with the package missing locally,
 * Capacitor resolves it to the repo root and writes an escaping path. Install the deps and the
 * rewrite has no reason to happen.
 */

/** True when this project's `package.json` means "run npm install in my folder".
 *
 *  TWO independent reasons, and the second is the one #215 was missing:
 *   - `workspaces` — it owns sub-packages (game-native plugins, app-services) that must be LINKED.
 *   - any `dependencies` / `devDependencies` — it has real deps that must be INSTALLED.
 *
 *  @param {{workspaces?: unknown, dependencies?: object, devDependencies?: object}} pkg
 *  @returns {boolean}
 */
export function projectNeedsInstall(pkg) {
  if (!pkg || typeof pkg !== 'object') return false;
  if (pkg.workspaces) return true;
  const deps = Object.keys(pkg.dependencies ?? {}).length;
  const dev = Object.keys(pkg.devDependencies ?? {}).length;
  return deps + dev > 0;
}
