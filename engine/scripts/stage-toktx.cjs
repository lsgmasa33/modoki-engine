/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * electron-builder beforePack hook (ELECTRON_PLAN Phase 7) — stage the KTX CLI
 * for bundling. Copies `toktx` + `ktx` (gltf-transform's rigged-model encoder, #1351) + their one
 * non-system dependency (`libktx.4.dylib`) into `build/bin/`, which `electron-builder.yml` ships as
 * `extraResources` → `Contents/Resources/bin`. Both CLIs carry an `@executable_path` rpath,
 * so the sibling `libktx.4.dylib` resolves with no `install_name_tool` surgery;
 * electron-builder's signing pass then signs both (the `disable-library-validation`
 * entitlement + same-team signature let `toktx` load `libktx` under hardened runtime).
 *
 * Graceful: if the pinned `toktx` / `ktx` / `libktx` can't be provisioned on the build machine, it
 * logs a warning, clears any earlier partial staging, and skips — the packaged app then falls back to shipping source textures
 * (the runtime resolver degrades), exactly as a dev build without `toktx` does.
 *
 * Two platforms, one destination (build/bin → resources/bin):
 *   • macOS — copy the pinned `toktx` + `ktx` + `libktx.4.dylib` (below).
 *   • Windows — copy the pinned `toktx.exe` + `ktx.exe` + their sibling `ktx.dll` (stageToktxWin32).
 * Both stage the PINNED build (pinnedToolForStaging.cjs, #1327) — never whatever the build
 * machine has on PATH, because the packaged editor converts with what it bundles. In CI the win32
 * branch is a no-op: release-windows.yml pre-stages build/bin via a download step, and this skips
 * when it's already populated.
 * Other platforms (linux) are a no-op.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { pinnedToolForStaging } = require('./pinnedToolForStaging.cjs');

// engine/scripts/ → repo root (build/ + node_modules live at the repo root).
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BIN_DIR = path.join(PROJECT_ROOT, 'build', 'bin');

/** Drop a half-staged artifact so the NEXT pack re-stages and re-verifies instead of
 *  short-circuiting on its presence. See the throw sites for why this is load-bearing. */
function rmStaged(paths) {
  for (const p of paths) { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } }
}

/** The one non-system dylib toktx needs (@rpath/libktx.4.dylib): the pinned install keeps it as a
 *  sibling; an MODOKI_TOKTX pointing into a KTX-Software install keeps it in ../lib. */
function findLibktx(toktxPath) {
  const candidates = [
    path.join(path.dirname(toktxPath), 'libktx.4.dylib'),
    path.join(path.dirname(toktxPath), '..', 'lib', 'libktx.4.dylib'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** `ktx` rides with `toktx`: @gltf-transform/cli 4.4 encodes rigged-model KTX2 with it, found on
 *  PATH beside the bundled toktx (#1351). A bundle without it silently uses the machine's `ktx`. */
const KTX_BIN = process.platform === 'win32' ? 'ktx.exe' : 'ktx';
const WIN_STAGED = ['toktx.exe', 'ktx.exe', 'ktx.dll'];
const MAC_STAGED = ['toktx', 'ktx', 'libktx.4.dylib'];
/** A skipped stage must not leave an EARLIER run's partial set in build/bin: it would ship a toktx
 *  whose rigged encode then always refuses for want of `ktx`. */
const clearStaged = (names) => rmStaged(names.map((n) => path.join(BIN_DIR, n)));

/** Windows staging: copy the installed toktx.exe + ktx.exe + their sibling ktx.dll into build/bin
 *  (the OS resolves the DLL from the .exe's own dir). Idempotent — if build/bin is already
 *  staged (CI's release-windows.yml download step, or a prior run), leave it and return. */
async function stageToktxWin32() {
  const out = path.join(BIN_DIR, 'toktx.exe');
  // All three, not just toktx.exe: a build/bin cached before ktx.exe joined the bundle is incomplete.
  if (WIN_STAGED.every((f) => fs.existsSync(path.join(BIN_DIR, f)))) {
    console.log('[stage-toktx] build/bin/{toktx,ktx}.exe + ktx.dll already present — skipping (CI-staged or cached).');
    return;
  }
  const toktx = pinnedToolForStaging('toktx');
  if (!toktx) {
    clearStaged(WIN_STAGED);
    console.warn('[stage-toktx] no pinned toktx.exe (MODOKI_TOKTX, or `npm run toolchain:install -- toktx`) — ' +
      'skipping bundle. The app falls back to source textures.');
    return;
  }
  const dll = path.join(path.dirname(toktx), 'ktx.dll');
  const ktx = path.join(path.dirname(toktx), 'ktx.exe');
  if (!fs.existsSync(dll) || !fs.existsSync(ktx)) {
    clearStaged(WIN_STAGED);
    console.warn(`[stage-toktx] found toktx.exe (${toktx}) but not its siblings ktx.dll + ktx.exe — skipping bundle ` +
      '(reinstall: `npm run toolchain:install -- toktx msdf-atlas-gen`).');
    return;
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.copyFileSync(toktx, out);
  fs.copyFileSync(ktx, path.join(BIN_DIR, 'ktx.exe'));
  fs.copyFileSync(dll, path.join(BIN_DIR, 'ktx.dll'));
  // Sanity-run the staged copy. `toktx --version` prints to stderr on Windows (stdout on
  // macOS), so read both streams for the log line.
  const r = spawnSync(out, ['--version'], { encoding: 'utf8' });
  const rk = spawnSync(path.join(BIN_DIR, 'ktx.exe'), ['--version'], { encoding: 'utf8' });
  // ⚠️ `r.status` too, not just `r.error`. `spawnSync` sets `error` only when the process could
  // not be STARTED; a binary that starts and exits non-zero (a missing DLL surfaced at runtime,
  // a corrupt copy) leaves `error` undefined with a non-zero status, and the old check passed it
  // — logging `bundled toktx.exe` with an empty version string. The macOS twin uses
  // `execFileSync`, which throws on a non-zero exit, so only this branch had the hole.
  if (r.error || r.status !== 0 || rk.error || rk.status !== 0) {
      // ⚠️ **Remove the staged copy BEFORE throwing.** Both win32 stagers short-circuit on
      // `fs.existsSync(out)` at the top — *before* this sanity run — so leaving a broken binary
      // in build/bin means the NEXT pack skips staging AND verification and signs a shipping app
      // around the same broken tool, silently. macOS does not have this hole (it re-copies and
      // re-verifies every run); the asymmetry is the idempotence early-return. Found in
      // close-out review of #945 B3.
      clearStaged(WIN_STAGED);
    // ⚠️ **THROW — the staged copy is verified and the verdict must not be discarded**
    // (#945 B3). The check below already existed; its result was logged and dropped, so a
    // relocation or dylib-resolve failure staged a binary that CANNOT RUN and the pack
    // continued, signed it, and shipped it. That is distinct from the tool being ABSENT on
    // this build machine, which stays a graceful skip above (before-pack.cjs's documented
    // contract: a missing optional tool never fails the build). Staged-but-broken is not a
    // missing tool — it is a bad artifact, and it must stop the pack.
    const bad = r.error || r.status !== 0 ? ['toktx.exe', r] : ['ktx.exe', rk];
    throw new Error(`[stage-toktx] staged ${bad[0]} but it failed to run: ${bad[1].error ? bad[1].error.message : `exit ${bad[1].status}`}`, { cause: bad[1].error });
  } else {
    const ver = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    console.log(`[stage-toktx] bundled ${ver || 'toktx.exe'} (+ ktx.exe, ktx.dll) → build/bin/`);
  }
}

exports.default = async function stageToktx(context) {
  const platform = context && context.electronPlatformName;
  if (platform === 'win32') return stageToktxWin32();
  if (platform && platform !== 'darwin') return; // linux/other — nothing to stage

  const toktx = pinnedToolForStaging('toktx');
  if (!toktx) {
    clearStaged(MAC_STAGED);
    console.warn('[stage-toktx] no pinned toktx (MODOKI_TOKTX, or `npm run toolchain:install -- toktx`) — ' +
      'skipping bundle; the app will fall back to source textures on import.');
    return;
  }
  const libktx = findLibktx(toktx);
  if (!libktx) {
    clearStaged(MAC_STAGED);
    console.warn(`[stage-toktx] found toktx (${toktx}) but not libktx.4.dylib — skipping bundle.`);
    return;
  }
  const ktx = path.join(path.dirname(toktx), KTX_BIN);
  if (!fs.existsSync(ktx)) {
    clearStaged(MAC_STAGED);
    console.warn(`[stage-toktx] found toktx (${toktx}) but not its sibling ktx — skipping bundle ` +
      '(reinstall: `npm run toolchain:install -- toktx msdf-atlas-gen`).');
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  // copyFileSync follows symlinks → copies the real libktx.4.4.2.dylib bytes.
  fs.copyFileSync(toktx, path.join(BIN_DIR, 'toktx'));
  fs.copyFileSync(libktx, path.join(BIN_DIR, 'libktx.4.dylib'));
  fs.copyFileSync(ktx, path.join(BIN_DIR, 'ktx'));
  fs.chmodSync(path.join(BIN_DIR, 'toktx'), 0o755);
  fs.chmodSync(path.join(BIN_DIR, 'ktx'), 0o755);
  fs.chmodSync(path.join(BIN_DIR, 'libktx.4.dylib'), 0o755);

  // Sanity-check the staged copy actually runs (sibling dylib resolves).
  try {
    // toktx prints its banner to STDERR (exit 0), so capture both streams for the log line.
    const ver = execFileSync(path.join(BIN_DIR, 'toktx'), ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      || spawnSync(path.join(BIN_DIR, 'toktx'), ['--version'], { encoding: 'utf8' }).stderr.trim();
    execFileSync(path.join(BIN_DIR, 'ktx'), ['--version'], { stdio: 'ignore' });
    console.log(`[stage-toktx] bundled ${ver} (+ ktx, libktx) → build/bin/`);
  } catch (e) {
    // ⚠️ **THROW — the staged copy is verified and the verdict must not be discarded**
    // (#945 B3). The check below already existed; its result was logged and dropped, so a
    // relocation or dylib-resolve failure staged a binary that CANNOT RUN and the pack
    // continued, signed it, and shipped it. That is distinct from the tool being ABSENT on
    // this build machine, which stays a graceful skip above (before-pack.cjs's documented
    // contract: a missing optional tool never fails the build). Staged-but-broken is not a
    // missing tool — it is a bad artifact, and it must stop the pack.
    clearStaged(MAC_STAGED);
    throw new Error(`[stage-toktx] staged toktx but it failed to run: ${e instanceof Error ? e.message : e}`, { cause: e });
  }
};
