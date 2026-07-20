/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * electron-builder beforePack hook (ELECTRON_PLAN Phase 7) — stage the KTX CLI
 * for bundling. Copies `toktx` + its one non-system dependency (`libktx.4.dylib`)
 * into `build/bin/`, which `electron-builder.yml` ships as `extraResources` →
 * `Contents/Resources/bin`. `toktx` already carries an `@executable_path` rpath,
 * so the sibling `libktx.4.dylib` resolves with no `install_name_tool` surgery;
 * electron-builder's signing pass then signs both (the `disable-library-validation`
 * entitlement + same-team signature let `toktx` load `libktx` under hardened runtime).
 *
 * Graceful: if `toktx` / `libktx` aren't installed on the build machine, it logs a
 * warning and skips — the packaged app then falls back to shipping source textures
 * (the runtime resolver degrades), exactly as a dev build without `toktx` does.
 *
 * Two platforms, one destination (build/bin → resources/bin):
 *   • macOS — copy the Homebrew/`/usr/local` `toktx` + `libktx.4.dylib` (below).
 *   • Windows — copy an INSTALLED `toktx.exe` + its sibling `ktx.dll` (stageToktxWin32).
 * Both stage whatever the build machine has installed, so a LOCAL `dist:win` bundles the
 * tool the same way `dist:mac` does. In CI the win32 branch is a no-op: release-windows.yml
 * pre-stages build/bin via a download step, and this skips when it's already populated.
 * Other platforms (linux) are a no-op.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// engine/scripts/ → repo root (build/ + node_modules live at the repo root).
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BIN_DIR = path.join(PROJECT_ROOT, 'build', 'bin');

/** Resolve the toktx binary: MODOKI_TOKTX, then PATH, then the standard install. */
function findToktx() {
  if (process.env.MODOKI_TOKTX && fs.existsSync(process.env.MODOKI_TOKTX)) return process.env.MODOKI_TOKTX;
  try { return execFileSync('which', ['toktx'], { encoding: 'utf8' }).trim(); } catch { /* fall through */ }
  const std = '/usr/local/bin/toktx';
  return fs.existsSync(std) ? std : null;
}

/** The one non-system dylib toktx needs: @rpath/libktx.4.dylib → the real file. */
function findLibktx(toktxPath) {
  // Standard install puts it next to the binary's ../lib.
  const candidates = [
    path.join(path.dirname(toktxPath), '..', 'lib', 'libktx.4.dylib'),
    '/usr/local/lib/libktx.4.dylib',
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** Windows: resolve an INSTALLED toktx.exe — MODOKI_TOKTX, then PATH (`where`), then the
 *  standard KTX-Software install (`%ProgramFiles%\KTX-Software\bin`). Install it once on a
 *  dev box with `winget install KhronosGroup.KTX-Software`. */
function findToktxWin() {
  if (process.env.MODOKI_TOKTX && fs.existsSync(process.env.MODOKI_TOKTX)) return process.env.MODOKI_TOKTX;
  try {
    // `where` prints "INFO: Could not find files…" to stderr on a miss — ignore stderr so it doesn't leak.
    const first = execFileSync('where', ['toktx'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim();
    if (first && fs.existsSync(first)) return first;
  } catch { /* not on PATH */ }
  for (const base of [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']]) {
    if (!base) continue;
    const p = path.join(base, 'KTX-Software', 'bin', 'toktx.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Windows staging: copy the installed toktx.exe + its sibling ktx.dll into build/bin
 *  (the OS resolves the DLL from the .exe's own dir). Idempotent — if build/bin is already
 *  staged (CI's release-windows.yml download step, or a prior run), leave it and return. */
async function stageToktxWin32() {
  const out = path.join(BIN_DIR, 'toktx.exe');
  if (fs.existsSync(out)) {
    console.log('[stage-toktx] build/bin/toktx.exe already present — skipping (CI-staged or cached).');
    return;
  }
  const toktx = findToktxWin();
  if (!toktx) {
    console.warn('[stage-toktx] toktx.exe not found (MODOKI_TOKTX / PATH / %ProgramFiles%\\KTX-Software\\bin) — ' +
      'skipping bundle; install it with `winget install KhronosGroup.KTX-Software`. The app falls back to source textures.');
    return;
  }
  const dll = path.join(path.dirname(toktx), 'ktx.dll');
  if (!fs.existsSync(dll)) {
    console.warn(`[stage-toktx] found toktx.exe (${toktx}) but not its sibling ktx.dll — skipping bundle.`);
    return;
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.copyFileSync(toktx, out);
  fs.copyFileSync(dll, path.join(BIN_DIR, 'ktx.dll'));
  // Sanity-run the staged copy. `toktx --version` prints to stderr on Windows (stdout on
  // macOS), so read both streams for the log line.
  const r = spawnSync(out, ['--version'], { encoding: 'utf8' });
  if (r.error) {
    console.warn(`[stage-toktx] staged toktx.exe but it failed to run: ${r.error.message}`);
  } else {
    const ver = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    console.log(`[stage-toktx] bundled ${ver || 'toktx.exe'} (+ ktx.dll) → build/bin/`);
  }
}

exports.default = async function stageToktx(context) {
  const platform = context && context.electronPlatformName;
  if (platform === 'win32') return stageToktxWin32();
  if (platform && platform !== 'darwin') return; // linux/other — nothing to stage

  const toktx = findToktx();
  if (!toktx) {
    console.warn('[stage-toktx] toktx not found (PATH / /usr/local/bin / MODOKI_TOKTX) — ' +
      'skipping bundle; the app will fall back to source textures on import.');
    return;
  }
  const libktx = findLibktx(toktx);
  if (!libktx) {
    console.warn(`[stage-toktx] found toktx (${toktx}) but not libktx.4.dylib — skipping bundle.`);
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  // copyFileSync follows symlinks → copies the real libktx.4.4.2.dylib bytes.
  fs.copyFileSync(toktx, path.join(BIN_DIR, 'toktx'));
  fs.copyFileSync(libktx, path.join(BIN_DIR, 'libktx.4.dylib'));
  fs.chmodSync(path.join(BIN_DIR, 'toktx'), 0o755);
  fs.chmodSync(path.join(BIN_DIR, 'libktx.4.dylib'), 0o755);

  // Sanity-check the staged copy actually runs (sibling dylib resolves).
  try {
    const ver = execFileSync(path.join(BIN_DIR, 'toktx'), ['--version'], { encoding: 'utf8' }).trim();
    console.log(`[stage-toktx] bundled ${ver} (+ libktx) → build/bin/`);
  } catch (e) {
    console.warn(`[stage-toktx] staged toktx but it failed to run: ${e instanceof Error ? e.message : e}`);
  }
};
