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
import { loadVendorPlugins } from './loadVendorPlugins.mjs';

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
const scopedPath = path.join(engineDir, 'tsconfig.app.scoped.json');
writeFileSync(scopedPath, JSON.stringify(scopedTsconfigContent(include), null, 2) + '\n');

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

/** Re-vendor the engine Capacitor plugins into the active project — the CLI half of #90.
 *
 *  `--target native` ONLY: a vendored plugin is a NATIVE artifact, so a web/playable build has
 *  nothing to keep fresh and must not pay for this.
 *
 *  Why it lives here. The editor's `/api/build` re-vendors unconditionally before every native
 *  build (`vite-asset-scanner.ts`), but `docs/build.md` presents the CLI recipe as the manual
 *  equivalent of Build → iOS Device and it had NO vendor call — so editing
 *  `engine/packages/capacitor-*` and following the documented recipe produced an IPA/APK
 *  containing the PREVIOUS native code, with every signal reporting success (#148). Measured:
 *  `games/audio-demo` stayed pinned to the old tarball hash until `vendor-plugins.mjs` was run by
 *  hand. `npm run build -- --target native` is what the recipe actually runs, so this is the seam
 *  where the two paths become equivalent.
 *
 *  Running it every native build is safe by design: `vendorEnginePlugins` is idempotent and
 *  content-addressed, so an unchanged plugin maps to the SAME committed tarball and re-packs
 *  nothing. Only a real content change yields a new filename — and only then does the (slow)
 *  install run.
 *
 *  Degrades to a no-op when `loadVendorPlugins` returns null (the packaged editor ships no engine
 *  sources). That is correct rather than lenient: on that path `main.ts` already vendored on
 *  project open, and the packaged app cannot build a plugin's `dist/` anyway (`canBuild:false`).
 *
 *  ⚠️ npm ships `README.md` regardless of the `files` field, so editing a plugin's DOCS re-hashes
 *  its tarball too. Nothing to do differently here — just don't be surprised by a re-vendor after
 *  a docs-only plugin edit. */
async function vendorNativePlugins() {
  if (target !== 'native' || !proj) return;
  const projectRoot = path.resolve(repoRoot, proj);
  const mod = await loadVendorPlugins(repoRoot);
  if (!mod) return;

  const r = mod.vendorEnginePlugins(projectRoot, repoRoot);
  if (r.vendored.length) console.log(`[build-web] re-vendored engine plugin(s): ${r.vendored.join(', ')}`);
  if (!r.needsInstall) return;

  // A new tarball is inert until it is installed — skipping this would leave the exact stale
  // artifact #148 is about, just one step later.
  console.log('[build-web] engine plugin changed — installing it into the project…');
  execSync('npm install', { stdio: 'inherit', cwd: projectRoot, env: runEnv });
  mod.writeVendorMarker(projectRoot, r.expectedVendor);
}

const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
try {
  // FIRST — before the typecheck, which resolves the plugin's TS types out of the project's
  // node_modules. A re-vendor that lands after it would be typechecked against the old copy.
  await vendorNativePlugins();
  // Typecheck gate — DEV only. typescript is a devDependency, so the packaged editor
  // doesn't ship it; there the typecheck is also redundant (the engine ships pre-built,
  // and an EXTERNAL project's game code isn't in the tsc scope anyway — see `include`
  // above). vite transpiles TS via esbuild, so the actual build needs no typescript.
  if (existsSync(tscBin)) {
    run(`${q(node)} ${q(tscBin)} -p engine/tsconfig.app.scoped.json`); // app + active game (scoped)
    run(`${q(node)} ${q(tscBin)} -p engine/tsconfig.node.json`);        // vite config / electron
  } else {
    console.log('[build-web] typescript not installed — skipping typecheck (packaged build).');
  }
  run(`${q(node)} ${q(viteBin)} build --config engine/vite.config.ts`);
} catch {
  // The failing child already printed its diagnostics via inherited stdio; exit
  // non-zero (without a node stack trace) so the build pipeline reports failure.
  process.exit(1);
}
