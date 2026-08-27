/**
 * Which Vite config `build-web.mjs` / `build-subgame.mjs` hands to `vite build` (#326).
 *
 * The PACKAGED editor ships an esbuild-bundled CJS copy of `vite.config.ts` beside the original
 * (emitted at pack time by `stage-vite-config.cjs`). Vite's default `bundle` config loader takes
 * a different branch per module format, and only one of them writes to disk:
 *
 *   ESM config (`.ts` under a `"type": "module"` package) → compiles to
 *     `<nearest node_modules>/.vite-temp/…mjs`, imports it, then unlinks it.
 *   CJS config (`.cjs`)                                   → hooks `require.extensions` and
 *     compiles IN MEMORY. Writes nothing, ever.
 *
 * In a packaged app that temp path is inside the signed `.app` (macOS) or under an elevated
 * `C:\Program Files` install (Windows, where the `mkdir` raises EPERM and Vite rethrows —
 * `loadConfigFromBundledFile` only swallows EACCES). Handing Vite the `.cjs` removes the write.
 *
 * ⚠️ The choice is driven by "am I running inside a packaged app", NOT by "does a `.cjs` exist".
 * Existence alone was the first cut and it is wrong in both directions:
 *   - A pack that fails or is interrupted between `beforePack` and `afterPack` leaves the staged
 *     `.cjs` behind in the SOURCE tree. Under an existence check, every later DEV build in that
 *     clone would silently use that snapshot — frozen at the failed pack, diverging with every
 *     edit after it. The stale-copy class, and invisible because the build succeeds.
 *   - A packaged app whose `.cjs` never got staged (esbuild unresolvable, or a multi-target pack
 *     racing the cleanup) would silently fall back to the writing config — the original bug,
 *     restored, with nothing said.
 * Deciding on packaged-ness makes a stray `.cjs` inert in a clone and a missing one LOUD in a
 * packaged app, which is the direction each failure should fail in.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Two independent signals, either sufficient. The path marker is intrinsic — `REPO_ROOT` is
 *  `<Resources>/app.asar.unpacked` in a packaged app (`engine/electron/main.ts`) — so it holds
 *  even for a build spawned without the env. `MODOKI_PACKAGED` covers the case where asar is
 *  disabled and that marker is absent. */
export function isPackagedEngineDir(engineDir, env = process.env) {
  return engineDir.split(path.sep).includes('app.asar.unpacked') || env.MODOKI_PACKAGED === '1';
}

/** @param {string} engineDir absolute path to `engine/`
 *  @param {(p: string) => boolean} [exists] injectable for tests
 *  @param {NodeJS.ProcessEnv} [env] injectable for tests
 *  @param {(m: string) => void} [warn] injectable for tests
 *  @returns {string} repo-relative config path for `vite build --config` */
export function chooseViteConfig(engineDir, exists = existsSync, env = process.env, warn = console.warn) {
  if (!isPackagedEngineDir(engineDir, env)) return 'engine/vite.config.ts';
  if (exists(path.join(engineDir, 'vite.config.cjs'))) return 'engine/vite.config.cjs';
  warn('[build] WARNING: packaged, but engine/vite.config.cjs was not staged — this build will '
    + 'write node_modules/.vite-temp INSIDE the app bundle. On macOS that breaks its code '
    + 'signature; on an admin-elevated Windows install (e.g. C:\\Program Files) the write itself '
    + 'EPERMs and the build fails outright — there is no installer-level mitigation for this '
    + 'anymore (#326). Check the beforePack stager (engine/scripts/stage-vite-config.cjs).');
  return 'engine/vite.config.ts';
}
