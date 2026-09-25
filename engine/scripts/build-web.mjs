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

import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { isProjectDir } from './projectRoots.mjs';
import { parseBuildTarget, nativeHealPlatforms } from './buildTarget.mjs';
import { scopedTsconfigContent } from './scopedTsconfig.mjs';
import { chooseViteConfig } from './viteConfigChoice.mjs';
import { loadEnginePluginModuleResult } from './loadVendorPlugins.mjs';
import { acquireBuildClaim } from './buildClaimsStore.mjs';
import { readGitProvenance, readHeadCommit, settleBuildStamp, writeBuildStamp, BUILD_STAMP_FILENAME } from './ota/buildStamp.mjs';

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
// argv, never a command string (#1537): `node` is process.execPath and the bins live under the
// install dir, so a folder holding `%`, `$(…)` or a space reached a shell through JSON.stringify quoting.
const run = (file, args) => execFileSync(file, args, { stdio: 'inherit', cwd: repoRoot, env: runEnv });

/** Cross-process build claim (#650). `buildLock.ts`'s in-process slot cannot see this script — a
 *  hand-run `npm run build` is a SEPARATE process — so nothing stopped it racing the editor's own
 *  OTA publish (or another CLI build) into the SAME `<project>/dist`, producing a torn bundle that
 *  ships to every installed device. Acquired HERE, before the try block below runs a single thing
 *  (including `validateProjectConfig`, its first line) — the same reasoning `/api/build` itself
 *  uses (vite-asset-scanner.ts: "BEFORE any config load or preflight so a refused build does
 *  nothing at all"). REFUSES AND EXITS rather than waiting: a scripted build must not hang on an
 *  interactive editor, matching what the editor's own routes already do.
 *
 *  Gated on `proj`, like `validateProjectConfig`/`healNativeProject` below: a bare
 *  `npm run build:editor` (no MODOKI_PROJECT) never reaches a project-scoped `dist` at all, so
 *  there is nothing here to claim.
 *
 *  Released in the `finally` below on the normal-completion and thrown-error paths. Several call
 *  sites further down (`validateProjectConfig`'s own `process.exit(1)`) exit the process directly,
 *  which does NOT run a wrapping `finally` — Node's `process.exit()` terminates before pending
 *  `finally` blocks get a turn. Those are covered instead by `acquireBuildClaim`'s own `exit`-event
 *  backstop (installed automatically on a successful claim), which fires on every process
 *  termination path, `process.exit()` included. */
let buildClaim = null;
if (proj) {
  const projectRoot = path.resolve(repoRoot, proj);
  // `acquireBuildClaim` can THROW rather than refuse (e.g. `~/.modoki` is uncreatable, or its lock
  // is genuinely wedged past its deadline — buildClaimsStore.mjs's `withLock`). This script has no
  // wrapping `try` yet at this point in the file — the one below starts AFTER this block — so an
  // uncaught throw here would crash with a raw Node stack trace instead of the `[build-web] …`
  // message every other failure path in this file gives. Catch it here, at the point the claim is
  // taken, and fail the same way `!claimed.ok` already does.
  try {
    const claimed = acquireBuildClaim(projectRoot, `${target} web build (CLI)`, { kind: 'cli' });
    if (!claimed.ok) {
      console.error(`[build-web] ${claimed.message}`);
      process.exit(1);
    }
    buildClaim = claimed;
  } catch (e) {
    console.error(`[build-web] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

/** The SAME project-config check the editor's `/api/build` route runs — `projectBuildConfigErrors`,
 *  the one function every build entry point calls (#827) — for every target alike (the route runs
 *  it once, before the platform branch, so it covers web/playable/ios/android identically; this
 *  mirrors that, not a native-only gate). Sibling of #589, where the CLI scaffolder
 *  (`add-native-targets.mjs`) reached the identical scaffold path with none: this script is what
 *  `npm run build` actually runs, and what `docs/build.md` tells a human to run by hand for a device
 *  build, and until then it healed a native project straight from a config nothing had validated.
 *  What this guards is artifact IDENTITY/behaviour (`app.appId`, `build.appleTeamId`,
 *  `capacitor.orientation` and friends), not HTTP hygiene — which is why a CLI needs it exactly as
 *  much as a route does. No `--force` bypass: that is an owner call.
 *
 *  Gated on `proj`: that's the only case with a `project.config.json` to check (a bare
 *  `npm run build:editor` never reaches this script at all). Degrades to a no-op like the heals
 *  below when the engine plugin can't be loaded — in the packaged editor that's esbuild pruned as
 *  a devDependency, not missing engine sources — and in THAT case the SOURCE route already
 *  validated before spawning this script as a build step.
 *
 *  ⚠️ Uses `loadEnginePluginModuleResult` (#731), not the plain null-returning wrapper: the old
 *  `if (!cfgMod) return;` skipped this whole gate in TOTAL SILENCE, on a source checkout with an
 *  incomplete `npm install` as much as on the legitimate packaged-editor case — the exact
 *  null-conflates-absent-with-unknown shape #714 fixed one level up. Warn with WHICH cause it was,
 *  same as the vendor-plugins load above, and never fail the build over it — this gate's own
 *  defence for the packaged-editor case (the SOURCE route already validated) still holds. */
async function validateProjectConfig() {
  if (!proj) return;
  const { module: cfgMod, reason } = await loadEnginePluginModuleResult(repoRoot, path.join('plugins', 'load-project-config.ts'));
  if (!cfgMod) {
    const why = reason === 'no-esbuild'
      ? 'esbuild is not installed, so load-project-config.ts could not be loaded (expected inside a '
        + 'packaged editor, which ships no devDependencies; on a source checkout it means the '
        + 'install is incomplete — run `npm install` at the repo root)'
      : 'there is no engine/plugins/load-project-config.ts here — this is not a source checkout, so '
        + 'there is nothing to check';
    console.warn(
      `[build-web] ⚠️ ${why}. The project-config validation gate did NOT run, so an invalid `
        + 'project.config.json (e.g. a `capacitor.orientation` typo) could ship undetected.',
    );
    return;
  }
  const cfgErrors = cfgMod.projectBuildConfigErrors(path.resolve(repoRoot, proj));
  if (cfgErrors.length) {
    console.error(`[build-web] invalid project settings — not building:\n${cfgErrors.map((e) => `  • ${e}`).join('\n')}`);
    process.exit(1);
  }
}

/** Generate app icons + splash art for a native build — the CLI half of #1011 facet A.
 *
 *  ⚠️ Before this, icon generation ran from EXACTLY ONE place: `iconStep` in
 *  `engine/plugins/vite-asset-scanner.ts`, i.e. the editor's Build menu. So the CLI native recipe that
 *  CLAUDE.md documents — `npm run build -- --target native`, then `cap sync`, then
 *  xcodebuild/gradle — regenerated NOTHING, and a project whose art or `iconSource` had changed
 *  shipped the previously committed icons with every gate green. There was no guard either: the
 *  freshness stamp lives under a gitignored `.cache/`, so nothing committed records what the shipped
 *  artifacts were built from, and it is a per-MACHINE fact.
 *
 *  ⚠️ Deliberately NOT part of `healNativeProject`: a heal repairs machine/identity config, and burying
 *  a required step inside an optional one is the failure `electron/main.ts`'s `healProjectOnOpen` docblock argues against and
 *  #150 actually shipped. It is its own call, in the main flow, where a reader can see it.
 *
 *  Every input comes from `project.config.json` now, so this passes only the project and the platform —
 *  the script owns resolution AND the freshness check, which is what keeps this from being a second
 *  copy of `iconStep`'s fourteen-flag command line. A non-zero exit FAILS the build: the script only
 *  exits non-zero when something asked for an icon that cannot be read, which is a broken config rather
 *  than an absent one, and shipping stale art over it is the defect this closes. Verified against every
 *  project in the repo: none has an `iconSource` pointing at a missing file. */
async function generateNativeIcons() {
  if (target !== 'native' || !proj) return;
  // ⚠️ The EDITOR's native plan runs this script as its first step and then runs its OWN `iconStep`,
  // so without this the editor build generates every icon twice — two `@capacitor/assets` runs, two
  // sharp splash passes, two collateral snapshots of both native trees, and two windows in which the
  // restore can fail. It is not merely waste: this function does BOTH platforms whenever both dirs
  // exist, so an iOS-only editor build would also rewrite tracked Android art, which is #162/#236's
  // complaint by name. `iconStep` is per-platform, so the editor's copy wins and this one stands
  // down. Set only by that plan's own build-web step — a plain CLI build never carries it.
  // ⚠️ That reason used to read "`iconStep` is the more capable of the two (it falls back to the
  // bundled icon for a project that authors none…)". #1027 removed the difference — both callers
  // now read the default from `scripts/iconAssets.mjs` — so per-platform is the whole of it now.
  if (process.env.MODOKI_ICONS_HANDLED === '1') {
    console.log('[build-web] icon generation left to the caller (MODOKI_ICONS_HANDLED=1).');
    return;
  }
  const projectRoot = path.resolve(repoRoot, proj);
  const platforms = ['ios', 'android'].filter((p) => existsSync(path.join(projectRoot, p)));
  if (!platforms.length) return;

  const script = path.join(repoRoot, 'engine', 'scripts', 'generate-icons.mjs');
  for (const platform of platforms) {
    // ⚠️ `--strict true` (#1028). Without it this function's own promise below — "not building;
    // building on would ship the previously committed art" — covered exactly ONE of the five ways
    // generation can fail, because #1011 facet C made only an unreadable icon SOURCE exit non-zero.
    // The other four exited 0: a non-zero `npx @capacitor/assets` (a NETWORK fetch, and much the
    // likeliest of the five), an unreadable splash source, collateral the wrapper could not
    // restore, and a post-processing throw. So the rare failure aborted the build and the common
    // one did not, which is precisely backwards.
    const res = spawnSync(process.execPath, [script, '--project', projectRoot, '--platform', platform, '--strict', 'true'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    // ⚠️ Two different failures, and telling the operator the wrong one costs them the hunt. A
    // non-zero STATUS is the script's own verdict — it named the bad path already. A NULL status is
    // the child never running or dying on a signal (no node on PATH, OOM, an abort), where "fix the
    // icon source" points at a file that is perfectly fine.
    if (res.error || res.status === null) {
      console.error(`[build-web] could not RUN icon generation for ${platform} — not building. `
        + `${res.error?.message ?? `killed by ${res.signal ?? 'an unknown signal'}`}. `
        + 'This is the generator failing to start, not a problem with the icon source.');
      process.exit(1);
    }
    if (res.status !== 0) {
      console.error(`[build-web] icon generation failed for ${platform} — not building. `
        + 'Fix the icon/splash source it named above (or clear the field in Project Settings); '
        + 'building on would ship the previously committed art.');
      process.exit(1);
    }
  }
}

/** Heal the native project before building it — `healNativeProject` (`engine/plugins/healNativeProject.ts`),
 *  the ONE heal sequence every native-build entry point calls (#827). Which steps run, in what order,
 *  and why that order is load-bearing live there, not here: this function supplies only the I/O.
 *
 *  `--target native` ONLY: every heal is a native-artifact concern, so a web/playable build has
 *  nothing to keep fresh and must not pay for it (nor mutate the project). `ensureCapacitorDeps`
 *  needs a PLATFORM, but `--target native` has none of its own — so this heals whichever of
 *  `ios/`/`android/` the project already has on disk.
 *
 *  Degrades with a warning (never a crash, never silently) when the module cannot be loaded — in a
 *  packaged editor that is esbuild pruned as a devDependency, not missing sources (#714), and there
 *  the `/api/build` route that spawned this script already ran the identical sequence in-process.
 *  On a source checkout the same warning means the install is incomplete. */
async function healNativeProject() {
  if (target !== 'native' || !proj) return;
  const projectRoot = path.resolve(repoRoot, proj);
  const { module: healMod, reason } = await loadEnginePluginModuleResult(repoRoot, path.join('plugins', 'healNativeProject.ts'));
  if (!healMod) {
    const why = reason === 'no-esbuild'
      ? 'esbuild is not installed, so healNativeProject.ts could not be loaded (expected inside a '
        + 'packaged editor, which ships no devDependencies; on a source checkout it means the '
        + 'install is incomplete — run `npm install` at the repo root)'
      : 'there is no engine/plugins/healNativeProject.ts here — this is not a source checkout, so '
        + 'there is nothing to heal';
    console.warn(
      `[build-web] ⚠️ ${why}. The native-project heals and the #685 stale-node_modules check did NOT `
        + 'run, so a native build here could ship a stale team, a missing plugin or the wrong plugin bytes undetected.',
    );
    return;
  }
  // The editor's per-platform build names its platform; a hand-run build covers the folders present (#1062).
  const platforms = nativeHealPlatforms(process.env, (p) => existsSync(path.join(projectRoot, p)));
  const result = await healMod.healNativeProject(projectRoot, repoRoot, platforms, {
    log: (line) => console.log(`[build-web]${line.startsWith('[') ? '' : ' '}${line}`),
    warn: (line) => console.warn(`[build-web] ${line}`),
    install: async (why) => {
      console.log(`[build-web] ${why} — installing it into the project…`);
      try {
        execSync('npm install', { stdio: 'inherit', cwd: projectRoot, env: runEnv });
        return true;
      } catch {
        return false;
      }
    },
  });
  if (result.ok) {
    await writeBuildNumberArgs(projectRoot);
    return;
  }
  // No `[build-web]` prefix on these: the top-level `catch` adds it to every in-process throw.
  if (result.reason === 'stale-node-modules') throw new Error(result.lines.join('\n'));
  if (result.reason === 'facebook-sdk-manifest') throw new Error(result.lines.join('\n'));
  if (result.reason === 'install-failed') throw new Error(`npm install (${result.why}) failed in ${projectRoot} — not building.`);
  throw new Error(result.message);
}

/** #1226: an AUTO build number is no longer written into build.gradle / project.pbxproj, so a hand-run
 *  gradle or xcodebuild after this script must be handed it — the recipes in docs/build.md append
 *  `$(cat <project>/android/.gradle/modoki-build-number.args)` (or the iOS twin). This writes those files
 *  with the number the editor's own build would pass; without it a hand-run debug APK carries the frozen
 *  committed versionCode and fails to install over an editor build (INSTALL_FAILED_VERSION_DOWNGRADE).
 *  Same esbuild-less degradation as the heal above: in a packaged editor the route wrote them already. */
async function writeBuildNumberArgs(projectRoot) {
  const { module: mod } = await loadEnginePluginModuleResult(repoRoot, path.join('plugins', 'healNativeConfig.ts'));
  const { module: cfgMod } = await loadEnginePluginModuleResult(repoRoot, path.join('plugins', 'load-project-config.ts'));
  if (!mod || !cfgMod) return;
  const numbers = mod.injectedBuildNumbers(projectRoot, cfgMod.loadProjectConfig(projectRoot));
  mod.writeBuildNumberArgFiles(projectRoot, numbers);
  for (const n of [...numbers.notes, ...numbers.platformNotes.android, ...numbers.platformNotes.ios]) console.log(`[build-web] ${n}`);
  console.log(`[build-web] build number for a hand-run native build: android=${numbers.android ?? '(committed)'} ios=${numbers.ios ?? '(committed)'} — append $(cat android/.gradle/modoki-build-number.args) to gradlew, $(cat ios/App/build/modoki-build-number.args) to xcodebuild`);
}

const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
// #906: a native dist is what an OTA publish uploads, so it records which tree built it. Read NOW,
// before the heals and icon generation rewrite tracked native files — those are this build's own
// output, not uncommitted source. Web and playable builds are never OTA-published and get no stamp
// (it would otherwise put a private-repo commit id into a public web deploy). See buildStamp.mjs.
const stampStart = target === 'native' && proj ? readGitProvenance(path.resolve(repoRoot, proj)) : null;
try {
  // FIRST of all — before the heal touches a single native file, let alone the typecheck or the
  // build itself. See validateProjectConfig's own comment for why.
  await validateProjectConfig();
  // Before the typecheck, which resolves the plugin's TS types out of the project's node_modules.
  // A heal that lands after it would be typechecked against the old copy.
  await healNativeProject();
  // AFTER the heal: `ensureCapacitorDeps` may have just created the platform directory this writes
  // into, and the icon step is a native-artifact concern like every heal above it. Before the web
  // build, so a failure costs nothing already built.
  await generateNativeIcons();
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
    run(node, [tscBin, '-p', 'engine/tsconfig.app.scoped.json']); // app + active game (scoped)
    run(node, [tscBin, '-p', 'engine/tsconfig.node.json']);        // vite config / electron
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
  run(node, [viteBin, 'build', '--config', chooseViteConfig(engineDir)]);
  if (stampStart) {
    const projectRoot = path.resolve(repoRoot, proj);
    const stamp = settleBuildStamp(stampStart, readHeadCommit(projectRoot));
    writeBuildStamp(path.join(projectRoot, 'dist'), stamp);
    console.log(`[build-web] ${BUILD_STAMP_FILENAME}: commit ${stamp.commit ?? 'unknown'}, dirty ${stamp.dirty ?? 'unknown'}.`);
  }
} catch (e) {
  // A failing CHILD already printed its diagnostics via inherited stdio, so re-printing would
  // duplicate them — that is what the bare `catch` here was for, and it stays right for `run()`.
  //
  // But an IN-PROCESS throw has no child and no inherited stdio, so a bare catch swallowed the
  // only useful sentence and exited 1 in silence. #150 made that reachable: `ensureCapacitorDeps`
  // throws by design on a directory that does not look like a Modoki project, and names which
  // markers are missing — precisely the message a headless/CI caller needs, and precisely the
  // caller this path exists for. (`vendorEnginePlugins` had the same shape before #150.)
  // `execFileSync` failures carry `status`/`signal`; an ordinary Error does not, which is what
  // separates the two without having to thread a flag out of `healNativeProject`.
  const fromChild = e && (typeof e.status === 'number' || e.signal != null);
  if (!fromChild) console.error(`[build-web] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
} finally {
  // Covers the normal-completion path (the build succeeded and fell out of the try normally) and
  // any throw that reaches here WITHOUT going through `catch`'s own `process.exit(1)` above — that
  // exit call terminates before this `finally` gets a turn, so IT is covered by
  // `acquireBuildClaim`'s own exit-hook backstop instead (see the claim's own comment).
  buildClaim?.release();
}
