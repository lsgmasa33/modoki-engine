/**
 * WHERE the machine-level provisioned toolchain lives when nobody said — the ONE derivation.
 *
 * Split out of `packagedAppPaths.mjs` for #1297, for the same reason `pathIdentity.mjs` was
 * (#988/#1004): `engine/toolchain/index.ts` needs this and CANNOT import `packagedAppPaths.mjs`,
 * whose module-scope `fileURLToPath(import.meta.url)` throws in the bundled Electron main (esbuild
 * emits `import_meta = {}` there). This file must therefore stay a pure leaf: no `import.meta`, no
 * module-scope side effects. `packagedAppPaths.mjs` re-exports all three names so its callers and
 * tests keep their import.
 *
 * Why the toolchain needs it: an asset CONVERSION (ffmpeg/ffprobe) resolves ONLY the provisioned,
 * pinned copy — never a PATH binary — so every machine converts with the same build (#1297). The
 * Electron editor sets `MODOKI_TOOLCHAIN_DIR` itself; a plain `npm run dev` / `npm run build` /
 * vitest process does not, and without this default it would find no pinned copy at all even on a
 * machine that has provisioned one.
 */

import path from 'node:path';
import os from 'node:os';

/** The OS "application support" root that Electron puts userData dirs under.
 *
 *  ⚠️ **The three branches do not read the same inputs, and that asymmetry has bitten a test.**
 *  win32 and linux honour an env var (`APPDATA` / `XDG_CONFIG_HOME`); **darwin honours neither** and
 *  derives from `os.homedir()` alone. So a fixture that sandboxes the environment moves this root on
 *  two platforms and not on the third — which is exactly how `cleanPackagedCacheLinkGuard.test.ts`
 *  came to pass on Windows and Linux and fail on macOS. Anything that needs to know where these
 *  paths land must CALL this, never re-derive it.
 *
 *  ⚠️ **Pure/platform-injectable — the shape `needsWinShell`/`toSpawn` use in
 *  `engine/scripts/winSpawn.mjs` (NOT in this file; an earlier draft said "below") — and for a reason this
 *  file learned the hard way.** Reading `process.platform` directly would make the RULE itself
 *  unpinnable — every leg could only assert its own shape, and the darwin shape is the one no gate
 *  this repo runs would ever execute. Deriving callers off a shared helper stops them drifting from
 *  each other but proves nothing about whether the helper is RIGHT; that needs one test comparing
 *  each branch to a literal, which is legitimate exactly here because the literal IS the
 *  specification rather than a copy of it. `packagedAppPaths.test.ts` holds it. */
export function appSupportRoot(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME ?? path.join(home, '.config');
}

/** `engine/electron/userDataDir.ts`'s SHARED_DIR — the machine-level root the provisioned Build
 *  Support toolchain lives under, shared by every clone rather than per-app. */
export const SHARED_DIR = 'Modoki';

/** Where the provisioned toolchain lives when `MODOKI_TOOLCHAIN_DIR` is unset — where the Electron
 *  editor provisions (`resolveToolchainDir(app.getPath('appData'))`), where
 *  `clean-packaged-cache.mjs --toolchain` looks, and where a conversion resolves its pinned
 *  ffmpeg/ffprobe (#1297).
 *
 *  Exported so a TEST can build a fixture at the real default rather than re-deriving the path —
 *  `clean-packaged-cache.mjs` itself cannot be imported for it, because it is a top-level program
 *  and importing it would run the wipe. Deriving it twice is the guard-by-literal shape, and it had
 *  already gone wrong once: a fixture that assumed `<sandbox>/Modoki/toolchain` is right on win32
 *  and linux and wrong on darwin (see `appSupportRoot` above). */
export function defaultToolchainDir() {
  return path.join(appSupportRoot(), SHARED_DIR, 'toolchain');
}
