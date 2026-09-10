/**
 * The esbuild options that produce the shipped Electron main + preload bundles — DECLARATION ONLY.
 *
 * The exact split, and for the exact reason, as `mcpBuildOpts.mjs` (#945 B1): `build-electron.mjs`
 * runs `await esbuild.build(...)` at module top level, so importing it to reach these options would
 * run a whole Electron build as an import side effect. The options therefore live here, where
 * importing costs nothing, and BOTH the builder and `engine/tests/electron/mainBundleExternals.test.ts`
 * read them from this one place.
 *
 * ⚠️ **Do not restate these in a test.** A verification that rebuilds its own private copy of what
 * ships cannot fail when the shipped thing is wrong — that is the whole of #945 B1, and the MCP
 * test's inlined "mirroring build-electron.mjs" options had already drifted in two fields while
 * staying green. The guard that reads this file needs `packages: 'external'` and the entry points
 * to be the REAL ones, because those two fields are precisely what make #1035 possible.
 *
 * ⚠️ **Nothing may be executed at import time in this file** beyond reading the version out of
 * package.json. That is the property that makes it importable from a test.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `engine/electron` — resolved from THIS file, so the build works from any CWD. */
export const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron');

/** The repo root (contains `engine/`). */
export const repoRoot = path.resolve(electronDir, '..', '..');

/** The two entry points. `main.ts` is what Electron runs; `preload.ts` is the renderer bridge. */
export const electronEntries = [path.join(electronDir, 'main.ts'), path.join(electronDir, 'preload.ts')];

/** The artifact Electron actually runs, packaged and in dev. */
export const electronMainOutfile = path.join(electronDir, 'dist', 'main.cjs');

/**
 * The app version — the SINGLE source of truth is the root package.json. It is bundled in as
 * `__APP_VERSION__` so main.ts can show the real version even in the DEV editor, where Electron is
 * launched with a bare main.cjs (no app package.json) and `app.getVersion()` returns ELECTRON's own
 * version instead.
 */
export function appVersion() {
  return JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
}

/**
 * The shipped options.
 *
 * ⚠️ **`packages: 'external'` is load-bearing and is the reason the guard exists.** Electron plus
 * every npm dependency (sharp, three, gltf-transform, chokidar, …) resolves from node_modules at
 * runtime; only our own TS gets bundled. The cost is that a BARE specifier is not bundled — it
 * survives as a runtime `require` that plain Node must resolve inside the packaged app — and
 * `@modoki/engine` cannot be resolved that way at all (#1035). See
 * `engine/tests/electron/mainBundleExternals.test.ts` and docs/build.md.
 *
 * @param {{ outdir?: string, metafile?: boolean, sourcemap?: boolean, logLevel?: string }} [over]
 *   Overrides the guard needs to build into an isolated dir. Spelled as parameters rather than
 *   spread by the caller so a field it must NOT change (entry points, `packages`, `platform`,
 *   `format`) cannot be overridden by accident.
 * @returns {import('esbuild').BuildOptions}
 */
export function electronOpts(over = {}) {
  return {
    entryPoints: electronEntries,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outdir: over.outdir ?? path.join(electronDir, 'dist'),
    outExtension: { '.js': '.cjs' },
    external: ['electron'],
    packages: 'external',
    sourcemap: over.sourcemap ?? true,
    logLevel: over.logLevel ?? 'info',
    define: { __APP_VERSION__: JSON.stringify(appVersion()) },
    ...(over.metafile ? { metafile: true } : {}),
  };
}
