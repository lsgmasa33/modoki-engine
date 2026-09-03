#!/usr/bin/env node
/** Per-game web build: typecheck + vite build.
 *
 *  The typecheck is SCOPED to the active MODOKI_PROJECT. The shared
 *  engine/tsconfig.app.json globs `../games` (every game) so `npm run typecheck`
 *  covers the whole repo — but a per-game BUILD shouldn't fail because a SIBLING
 *  game's native Capacitor plugins aren't built in this worktree (their JS/types
 *  live in a gitignored dist/). One project = one game (#29): a build typechecks
 *  the engine app + the ACTIVE in-repo game only, never its siblings.
 *
 *  Full cross-game coverage still lives in `npm run typecheck` (tsc -b engine). */

import { execSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { isProjectDir } from './projectRoots.mjs';
import { parseBuildTarget } from './buildTarget.mjs';
import { scopedTsconfigContent } from './scopedTsconfig.mjs';
import { chooseViteConfig } from './viteConfigChoice.mjs';
import { loadEnginePluginModule } from './loadVendorPlugins.mjs';

// --target parsing lives in buildTarget.mjs (pure, unit-tested) — see its header comment for
// WHY there is no default in either direction (#40).
const parsed = parseBuildTarget(process.argv.slice(2), process.env);
if (!parsed.ok) {
  console.error(parsed.message);
  process.exit(1);
}
const { target, childEnv } = parsed;

const repoRoot = process.cwd();
const engineDir = path.join(repoRoot, 'engine');
const proj = process.env.MODOKI_PROJECT; // 'games/<id>' (in-repo) or an external abs path

// Include the engine app always; add the active project ONLY when it lives inside
// one of this repo's project roots — games/ or demos/ (an external project's TS
// isn't in the repo tsconfig graph, and we never include sibling projects). Paths
// are relative to engineDir, where the generated tsconfig sits, so its `extends` +
// relative includes resolve correctly.
const include = ['app'];
if (proj) {
  const abs = path.resolve(repoRoot, proj);
  if (isProjectDir(repoRoot, abs)) {
    include.push(path.relative(engineDir, abs).split(path.sep).join('/'));
  }
}

// The scoped-config SHAPE (extends + exclude restatement) is shared with
// typecheck-projects.mjs (#24's per-project CI sweep) via scopedTsconfig.mjs — see
// that module's header comment for why `exclude` has to be restated here at all.
// The write itself is deferred to just before the typecheck actually runs (see the
// `existsSync(tscBin)` branch below) — see that branch's comment for why.
const scopedPath = path.join(engineDir, 'tsconfig.app.scoped.json');

// Invoke tsc/vite via their resolved JS entrypoints with THIS node (process.execPath),
// not via a bare `tsc`/`vite` on PATH. Reasons: the packaged editor runs this as
// `node build-web.mjs` (electron-builder strips `scripts`, so `npm run build` isn't
// available) AND ships no node_modules/.bin symlinks — so a PATH lookup finds nothing.
// node_modules/.bin is still prepended to PATH for any grandchild that shells out.
const binDir = path.join(repoRoot, 'node_modules', '.bin');
const sep = process.platform === 'win32' ? ';' : ':';
const runEnv = {
  ...process.env,
  PATH: `${binDir}${sep}${process.env.PATH ?? ''}`,
  ...childEnv,
};
const node = process.execPath;
const q = (s) => JSON.stringify(s);
const run = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: repoRoot, env: runEnv });

/** The SAME two-part project-config check the editor's `/api/build` route runs — for every
 *  target alike (`vite-asset-scanner.ts`'s `/api/build` handler runs it once, before the platform
 *  branch, so it covers web/playable/ios/android identically; this mirrors that, not a
 *  native-only gate). Sibling of #589, where the CLI scaffolder (`add-native-targets.mjs`) reached
 *  the identical scaffold path with none: this script is what `npm run build` actually runs, and
 *  what `docs/build.md` tells a human to run by hand for a device build, and until now it healed a
 *  native project (`healNativeProject`, below) straight from a config nothing had validated.
 *
 *  The union pass is SEPARATE from `validateBuildConfig` because `validateBuildConfig` sees the
 *  already-RESOLVED config, where a bad value has been coerced to its default and is no longer
 *  there to complain about (#39) — the failure this closes: a `capacitor.orientation` typo like
 *  `"potrait"` is silently coerced to the default orientation and ships with rotation UNLOCKED to
 *  the store, invisible to `validateBuildConfig` alone. What this guards is artifact IDENTITY/
 *  behaviour (`app.appId`, `build.appleTeamId`, `capacitor.orientation` and friends), not HTTP
 *  hygiene — which is why a CLI needs it exactly as much as a route does. No `--force` bypass:
 *  that is an owner call.
 *
 *  Gated on `proj`: that's the only case with a `project.config.json` to check (a bare
 *  `npm run build:editor` never reaches this script at all). Degrades to a no-op like the heals
 *  below when the engine plugin can't be loaded — the packaged editor ships no engine sources, and
 *  in THAT case the SOURCE route already validated before spawning this script as a build step. */
async function validateProjectConfig() {
  if (!proj) return;
  const cfgMod = await loadEnginePluginModule(repoRoot, path.join('plugins', 'load-project-config.ts'));
  if (!cfgMod) return;
  const { loadProjectConfig, loadProjectUserConfig, validateBuildConfig, projectConfigUnionErrors } = cfgMod;
  const projectRoot = path.resolve(repoRoot, proj);
  const cfg = loadProjectConfig(projectRoot);
  const cfgErrors = [...projectConfigUnionErrors(projectRoot), ...validateBuildConfig(cfg, loadProjectUserConfig(projectRoot))];
  if (cfgErrors.length) {
    console.error(`[build-web] invalid project settings — not building:\n${cfgErrors.map((e) => `  • ${e}`).join('\n')}`);
    process.exit(1);
  }
}

/** Heal the native project before building it — the CLI half of #90/#148/#150.
 *
 *  `--target native` ONLY: every heal below is a native-artifact concern, so a web/playable
 *  build has nothing to keep fresh and must not pay for it (nor mutate the project).
 *
 *  Why it lives here. The editor's `/api/build` runs THREE in-process heals before the shell
 *  steps of a native build (`vite-asset-scanner.ts`, "Re-heal the native config"):
 *  `healNativeConfig` → `ensureCapacitorDeps` → `vendorEnginePlugins`. `docs/build.md` presents
 *  this CLI recipe as the manual EQUIVALENT of Build → iOS/Android Device, but until #148 it ran
 *  NONE of them, and #148 only added the third — so the documented CLI recipe could produce an
 *  IPA/APK signed with a stale team, missing a newly-required Capacitor plugin, or containing the
 *  PREVIOUS native code, with every signal reporting success. `npm run build -- --target native`
 *  is what the recipe actually runs, so this is the seam where the two paths become equivalent.
 *  This is not a new class of side effect: `build-web.mjs` already mutates the project (re-packs
 *  tarballs, rewrites the `capacitor-game-debug` dep spec, runs `npm install` in the project dir)
 *  since #148, and the CLI path exists precisely for headless/CI use where "go open the editor
 *  once" isn't available.
 *
 *  ORDER IS LOAD-BEARING — copies the editor's exact sequence, do not reorder:
 *   1. `healNativeConfig` — machine/identity settings (iOS DEVELOPMENT_TEAM, Android
 *      local.properties) that must land before anything shells out to xcodebuild/gradle.
 *   2. `ensureCapacitorDeps` — adds any Capacitor dep the engine now requires. When it adds
 *      `capacitor-game-debug`, it writes a PLACEHOLDER spec (`'*'`).
 *   3. `vendorEnginePlugins` — rewrites that placeholder to the real
 *      `file:plugins/<name>-<ver>.tgz`. Running this BEFORE step 2 would mean step 2's
 *      placeholder never gets rewritten — a project stuck depending on a spec npm can't
 *      install. Vendoring is also re-run UNCONDITIONALLY (not just when deps changed): it's
 *      idempotent + content-addressed, so an unchanged plugin re-packs nothing, but a plugin
 *      whose CONTENT changed needs a fresh tarball even when no dep was newly added.
 *   4. `npm install`, gated on EITHER heal having changed something (`depHeal.changed ||
 *      v.needsInstall`) — a tarball or a new dep spec is inert until installed, and gating on
 *      only one of the two conditions would silently skip the other's install.
 *
 *  `ensureCapacitorDeps` needs a PLATFORM, but `--target native` covers both iOS and Android with
 *  no platform of its own — so this heals whichever of `ios/`/`android/` the project already has
 *  on disk. A project with NEITHER folder yet skips the deps heal: that case is the editor's
 *  scaffold-then-build path (`addNativeTarget` scaffolds an empty native folder as part of adding
 *  the target), which this CLI script has no equivalent entry point for.
 *
 *  Each heal degrades to a no-op (not a crash) when its module can't be loaded — the packaged
 *  editor ships no engine sources; on that path `main.ts` already healed/vendored on project
 *  open, and the packaged app can't rebuild a plugin's `dist/` anyway (`canBuild:false`).
 *
 *  NOT defended, deliberately: a HALF-present engine checkout (`addNativeTarget.ts` loadable but
 *  `vendorPlugins.ts` not) would let step 2 write the placeholder `capacitor-game-debug: '*'` spec
 *  and then install it, resolving against the public registry instead of the local tarball. There
 *  is no operational path into that state — a dev checkout has both files and the packaged editor
 *  has neither, so they appear and disappear together — and guarding it would mean gating the
 *  install on which module loaded, which is exactly the coupling step 4 exists to avoid. Recorded
 *  because it was raised and dismissed on reasoning, not because it was never considered.
 *
 *  ⚠️ npm ships `README.md` regardless of the `files` field, so editing a plugin's DOCS re-hashes
 *  its tarball too. Nothing to do differently here — just don't be surprised by a re-vendor after
 *  a docs-only plugin edit. */
async function healNativeProject() {
  if (target !== 'native' || !proj) return;
  const projectRoot = path.resolve(repoRoot, proj);

  // 1. Machine/identity config — DEVELOPMENT_TEAM, local.properties.
  const healMod = await loadEnginePluginModule(repoRoot, path.join('plugins', 'healNativeConfig.ts'));
  if (healMod) {
    for (const n of healMod.healNativeConfig(projectRoot).notes) console.log(`[build-web][heal] ${n}`);
  }

  // 2. Engine-required Capacitor deps, per platform actually present on disk.
  let depsChanged = false;
  const platforms = ['ios', 'android'].filter((p) => existsSync(path.join(projectRoot, p)));
  if (platforms.length) {
    const addMod = await loadEnginePluginModule(repoRoot, path.join('plugins', 'addNativeTarget.ts'));
    if (addMod) {
      for (const platform of platforms) {
        const depHeal = addMod.ensureCapacitorDeps(projectRoot, platform, repoRoot);
        for (const n of depHeal.notes) console.log(`[build-web][heal] ${n}`);
        depsChanged = depsChanged || depHeal.changed;
      }
    }
  }

  // 3. Vendor engine plugins — MUST run after step 2 (see ordering note above).
  const vendorMod = await loadEnginePluginModule(repoRoot, path.join('plugins', 'vendorPlugins.ts'));
  const v = vendorMod ? vendorMod.vendorEnginePlugins(projectRoot, repoRoot) : null;
  if (v?.vendored.length) console.log(`[build-web][heal] vendored engine plugin(s): ${v.vendored.join(', ')}`);

  // 4. Install iff either heal actually changed something.
  //
  // Deliberately NOT short-circuited on a missing vendor module: step 2 may have written new deps
  // into package.json, and those are inert until installed. Bailing out here because step 3 was
  // unavailable would leave the project claiming a dependency that is not on disk — the same
  // shape as the #148/#150 silent-success bug, one step further along. So the install is gated on
  // what CHANGED, never on which module happened to load.
  if (!(depsChanged || v?.needsInstall)) return;
  const why = depsChanged ? 'healed Capacitor plugins' : 'engine plugin changed';
  console.log(`[build-web] ${why} — installing it into the project…`);
  execSync('npm install', { stdio: 'inherit', cwd: projectRoot, env: runEnv });
  // The marker records the vendored spec set, so it is only meaningful when step 3 actually ran.
  if (vendorMod && v) vendorMod.writeVendorMarker(projectRoot, v.expectedVendor);
}

const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
try {
  // FIRST of all — before the heal touches a single native file, let alone the typecheck or the
  // build itself. See validateProjectConfig's own comment for why.
  await validateProjectConfig();
  // Before the typecheck, which resolves the plugin's TS types out of the project's node_modules.
  // A heal that lands after it would be typechecked against the old copy.
  await healNativeProject();
  // Typecheck gate — DEV only. typescript is a devDependency, so the packaged editor
  // doesn't ship it; there the typecheck is also redundant (the engine ships pre-built,
  // and an EXTERNAL project's game code isn't in the tsc scope anyway — see `include`
  // above). vite transpiles TS via esbuild, so the actual build needs no typescript.
  if (existsSync(tscBin)) {
    // Written HERE, not unconditionally at module load: a packaged install's `engine/`
    // is the app's own read-only install directory (e.g. an admin-elevated `C:\Program
    // Files\...` on Windows — writable only during install, not by the running,
    // unelevated app), and this branch not firing there (no tsc shipped) is exactly what
    // makes the write unnecessary too. Doing it unconditionally EPERM'd every build from
    // such an install, dev or packaged, before the target-specific work even started.
    writeFileSync(scopedPath, JSON.stringify(scopedTsconfigContent(include), null, 2) + '\n');
    run(`${q(node)} ${q(tscBin)} -p engine/tsconfig.app.scoped.json`); // app + active game (scoped)
    run(`${q(node)} ${q(tscBin)} -p engine/tsconfig.node.json`);        // vite config / electron
  } else {
    console.log('[build-web] typescript not installed — skipping typecheck (packaged build).');
  }
  // ⚠️ Do NOT add `--configLoader runner` here (tried in bug vSlzfZLr7pIX5Yw0RSSe, reverted).
  // It fixes the `.vite-temp` EPERM below by never bundling the config to disk, but its
  // module runner is torn down once config-loading finishes — so ANY plugin hook that does
  // a dynamic `import()` LATER in the build (writeBundle, generateBundle — exactly what
  // rigged-model-optimize.ts's `@gltf-transform/*` imports and the SSR-postprocessor loader
  // in vite-asset-scanner.ts both do) throws "Vite module runner has been closed". Proved
  // with a two-line repro: a plugin doing `await import('node:fs/promises')` from
  // `writeBundle` fails under `--configLoader runner` and succeeds under the default loader.
  // `--configLoader native` avoids both problems but requires every relative import under
  // `engine/` to carry a real extension (Node's native ESM resolution, unlike Vite's own,
  // does not guess `.ts`) — this repo's plugin tree does not, so native fails to even load
  // vite.config.ts. The `.vite-temp` EPERM on an admin-elevated (`Program Files`) install used
  // to be mitigated at the INSTALLER (build/installer.nsh granted write access to just that
  // one subfolder from the elevated install step) — removed once the CJS config below was
  // measured to not write there at all: a real Build press from a packaged editor installed to
  // `C:\Program Files\Modoki Editor`, grant removed, produced zero files under `.vite-temp` and
  // no EPERM (#326, 2026-08-27).
  //
  // ⚠️ macOS: the same `.vite-temp` write lands INSIDE the signed .app (`REPO_ROOT` is
  // `<Resources>/app.asar.unpacked` when packaged). There it is an integrity seal rather than a
  // permission, and the write SUCCEEDS silently. Measured 2026-08-22: on a build that completes,
  // Vite unlinks the temp file and leaves an EMPTY directory, which `codesign` does not seal — so
  // this alone does not persistently invalidate the signature. It does leave a window during the
  // build where the bundle is invalid, and a build that dies mid-config-load leaves the file. The
  // persistent seal breaks measured on the v0.5.2 rc came from two other writers, both since
  // fixed: `engine/tsconfig.app.scoped.json` (3df0e65d4) and the `.modoki/` backend state
  // (ed17ff8a2). Do not re-derive that from this comment — re-measure, per QA-PKG-0009 step 7.
  //
  // Either way the packaged editor should not write inside its own bundle at all, and the fix is
  // to hand Vite a CJS config, whose loader branch compiles in memory. Which config, and why the
  // choice is by file existence, is `viteConfigChoice.mjs` — not restated here.
  run(`${q(node)} ${q(viteBin)} build --config ${chooseViteConfig(engineDir)}`);
} catch (e) {
  // A failing CHILD already printed its diagnostics via inherited stdio, so re-printing would
  // duplicate them — that is what the bare `catch` here was for, and it stays right for `run()`.
  //
  // But an IN-PROCESS throw has no child and no inherited stdio, so a bare catch swallowed the
  // only useful sentence and exited 1 in silence. #150 made that reachable: `ensureCapacitorDeps`
  // throws by design on a directory that does not look like a Modoki project, and names which
  // markers are missing — precisely the message a headless/CI caller needs, and precisely the
  // caller this path exists for. (`vendorEnginePlugins` had the same shape before #150.)
  // `execSync` failures carry `status`/`signal`; an ordinary Error does not, which is what
  // separates the two without having to thread a flag out of `healNativeProject`.
  const fromChild = e && (typeof e.status === 'number' || e.signal != null);
  if (!fromChild) console.error(`[build-web] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
