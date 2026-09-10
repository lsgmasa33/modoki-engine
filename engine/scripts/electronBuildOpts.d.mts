/** Type sidecar for electronBuildOpts.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */
import type { BuildOptions } from 'esbuild';

/** `engine/electron` — resolved from the module itself, so the build works from any CWD. */
export declare const electronDir: string;

/** The repo root (contains `engine/`). */
export declare const repoRoot: string;

/** The two entry points: `main.ts` (what Electron runs) and `preload.ts` (the renderer bridge). */
export declare const electronEntries: string[];

/** The artifact Electron actually runs, packaged and in dev. */
export declare const electronMainOutfile: string;

/** The app version, read from the root package.json — the single source of truth. */
export declare function appVersion(): string;

/** The esbuild options `build-electron.mjs` uses for the main + preload bundles. Imported rather
 *  than restated by `engine/tests/electron/mainBundleExternals.test.ts` so the two cannot drift
 *  (#945 B1) — and because that guard's whole claim rests on `packages: 'external'` and the real
 *  entry points being the ones under test (#1035).
 *
 *  ⚠️ **`over`'s SHAPE is not guarded.** `mjsTypeSidecars.test.ts` compares the export SET, not
 *  signatures, so widening this type does not fail anything — and adding, say, `packages?: string`
 *  here would let `electronOpts({ packages: 'bundle' })` typecheck while the implementation
 *  silently ignores it, i.e. a caller believing it overrode the one field the #1035 guard rests on.
 *  Keep this in step with the implementation by hand, and do not add a field the implementation
 *  does not read. */
export declare function electronOpts(over?: {
  outdir?: string;
  metafile?: boolean;
  sourcemap?: boolean;
  logLevel?: BuildOptions['logLevel'];
}): BuildOptions;
