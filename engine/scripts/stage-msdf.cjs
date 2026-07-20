/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * electron-builder beforePack hook — stage msdf-atlas-gen (+ its dylib closure)
 * for bundling. Font import (engine/plugins/font-convert.ts) shells out to
 * msdf-atlas-gen to bake mtsdf atlases; it was the last SYSTEM-tool gap after
 * ffmpeg. There is NO prebuilt macOS binary (Chlumsky ships win32/win64 only) and
 * the Homebrew one links three non-system Homebrew dylibs
 * (libpng16 · libtinyxml2 · libfreetype, with freetype → libpng), so it isn't
 * portable as-is.
 *
 * We relocate it the same way stage-toktx.cjs handles libktx: copy the binary +
 * its full non-system dylib closure into build/bin/, then rewrite every absolute
 * Homebrew load path (and each dylib's own id) to `@loader_path/<name>` so the
 * siblings resolve from wherever Resources/bin ends up. install_name_tool
 * invalidates the ad-hoc signature, so we re-sign each file (electron-builder's
 * signing pass re-signs them again for real; the local ad-hoc sign is what lets an
 * unsigned `--dir` build actually run). The disable-library-validation entitlement
 * (already required by toktx) lets the binary load the sibling dylibs under
 * hardened runtime. main.ts resolves MODOKI_MSDF_ATLAS_GEN to the copy when packaged.
 *
 * Graceful: if msdf-atlas-gen isn't installed on the build machine, log + skip —
 * font import then degrades to a system binary (dev) or a clear install hint.
 *
 * Two platforms, one destination (build/bin → resources/bin):
 *   • macOS — relocate the Homebrew binary + its dylib closure (below).
 *   • Windows — copy an INSTALLED msdf-atlas-gen.exe (stageMsdfWin32). The win64 build is a
 *     single statically-linked exe (imports only KERNEL32 — no sibling DLLs), so it's a plain
 *     copy, no relocation. Stages whatever the build machine has installed, so a LOCAL
 *     `dist:win` bundles it like `dist:mac` does; a no-op in CI (release-windows.yml pre-stages
 *     via download, and this skips when build/bin is already populated). Other platforms no-op.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BIN_DIR = path.join(PROJECT_ROOT, 'build', 'bin');

/** Resolve msdf-atlas-gen: MODOKI_MSDF_ATLAS_GEN, then PATH, then Homebrew. */
function findMsdf() {
  if (process.env.MODOKI_MSDF_ATLAS_GEN && fs.existsSync(process.env.MODOKI_MSDF_ATLAS_GEN)) {
    return process.env.MODOKI_MSDF_ATLAS_GEN;
  }
  try { return execFileSync('which', ['msdf-atlas-gen'], { encoding: 'utf8' }).trim(); } catch { /* fall through */ }
  const std = '/opt/homebrew/bin/msdf-atlas-gen';
  return fs.existsSync(std) ? std : null;
}

/** Non-system dylib load paths a Mach-O references (skips /usr/lib + /System). */
function nonSystemDeps(machoPath) {
  let out;
  try { out = execFileSync('otool', ['-L', machoPath], { encoding: 'utf8' }); } catch { return []; }
  return out.split('\n').slice(1)
    .map((l) => l.trim().split(' ')[0])
    .filter((p) => p && !p.startsWith('/usr/lib') && !p.startsWith('/System'));
}

/** Transitive non-system dylib closure of a binary, as absolute source paths.
 *  Ignores the binary's own self-reference and any @rpath/@loader_path entry
 *  (the Homebrew binary uses absolute /opt/homebrew paths, which is what we need). */
function dylibClosure(binPath) {
  const found = new Map(); // basename -> absolute source path
  const stack = [binPath];
  const visited = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (visited.has(p)) continue;
    visited.add(p);
    for (const dep of nonSystemDeps(p)) {
      if (dep.startsWith('@') || dep === p) continue; // skip self-id + relative
      if (!fs.existsSync(dep)) continue;
      const base = path.basename(dep);
      if (!found.has(base)) { found.set(base, dep); stack.push(dep); }
    }
  }
  return found;
}

function adhocSign(file) {
  try { execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'pipe' }); } catch { /* electron-builder re-signs */ }
}

/** Windows: resolve an INSTALLED msdf-atlas-gen.exe — MODOKI_MSDF_ATLAS_GEN, then PATH
 *  (`where`). No winget package: install once by downloading Chlumsky's
 *  msdf-atlas-gen-*-win64.zip and setting MODOKI_MSDF_ATLAS_GEN (or putting it on PATH). */
function findMsdfWin() {
  if (process.env.MODOKI_MSDF_ATLAS_GEN && fs.existsSync(process.env.MODOKI_MSDF_ATLAS_GEN)) {
    return process.env.MODOKI_MSDF_ATLAS_GEN;
  }
  try {
    // `where` prints "INFO: Could not find files…" to stderr on a miss — ignore stderr so it doesn't leak.
    const first = execFileSync('where', ['msdf-atlas-gen'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim();
    if (first && fs.existsSync(first)) return first;
  } catch { /* not on PATH */ }
  return null;
}

/** Windows staging: copy the installed msdf-atlas-gen.exe into build/bin (single static exe,
 *  no siblings). Idempotent — skip when build/bin already holds it (CI download step / prior run). */
async function stageMsdfWin32() {
  const out = path.join(BIN_DIR, 'msdf-atlas-gen.exe');
  if (fs.existsSync(out)) {
    console.log('[stage-msdf] build/bin/msdf-atlas-gen.exe already present — skipping (CI-staged or cached).');
    return;
  }
  const bin = findMsdfWin();
  if (!bin) {
    console.warn('[stage-msdf] msdf-atlas-gen.exe not found (MODOKI_MSDF_ATLAS_GEN / PATH) — skipping bundle; ' +
      'download msdf-atlas-gen-*-win64.zip from https://github.com/Chlumsky/msdf-atlas-gen/releases and set ' +
      'MODOKI_MSDF_ATLAS_GEN (or add it to PATH). Font import will show an install hint.');
    return;
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.copyFileSync(bin, out);
  try {
    execFileSync(out, ['-version'], { stdio: 'pipe' }); // prints "MSDF-Atlas-Gen v1.4.0", exit 0
    console.log('[stage-msdf] bundled msdf-atlas-gen.exe → build/bin/');
  } catch (e) {
    console.warn(`[stage-msdf] staged msdf-atlas-gen.exe but it failed to run: ${e instanceof Error ? e.message : e}`);
  }
}

exports.default = async function stageMsdf(context) {
  const platform = context && context.electronPlatformName;
  if (platform === 'win32') return stageMsdfWin32();
  if (platform && platform !== 'darwin') return; // linux/other — nothing to stage

  const bin = findMsdf();
  if (!bin) {
    console.warn('[stage-msdf] msdf-atlas-gen not found (PATH / /opt/homebrew/bin / MODOKI_MSDF_ATLAS_GEN) — ' +
      'skipping bundle; font import will fall back to a system binary.');
    return;
  }

  const closure = dylibClosure(bin); // basename -> source path
  fs.mkdirSync(BIN_DIR, { recursive: true });

  // Copy the binary + every dylib into build/bin (basenames only).
  const outBin = path.join(BIN_DIR, 'msdf-atlas-gen');
  fs.copyFileSync(bin, outBin); // follows symlinks → real bytes
  fs.chmodSync(outBin, 0o755);
  const dylibNames = [...closure.keys()];
  for (const [base, src] of closure) {
    const dst = path.join(BIN_DIR, base);
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o644);
  }

  // Rewrite load paths to @loader_path siblings. For each Mach-O we own, every
  // non-system dep that is one of OUR dylibs becomes @loader_path/<name>.
  const relocate = (file) => {
    for (const dep of nonSystemDeps(file)) {
      const base = path.basename(dep);
      if (dep.startsWith('@loader_path/')) continue;
      if (dylibNames.includes(base)) {
        try { execFileSync('install_name_tool', ['-change', dep, `@loader_path/${base}`, file], { stdio: 'pipe' }); } catch { /* noop */ }
      }
    }
  };
  // Each dylib: set its own id to @loader_path/<name>, then fix its inter-dylib deps.
  for (const base of dylibNames) {
    const f = path.join(BIN_DIR, base);
    try { execFileSync('install_name_tool', ['-id', `@loader_path/${base}`, f], { stdio: 'pipe' }); } catch { /* noop */ }
    relocate(f);
  }
  relocate(outBin);

  // install_name_tool invalidated signatures — re-adhoc-sign (dylibs first).
  for (const base of dylibNames) adhocSign(path.join(BIN_DIR, base));
  adhocSign(outBin);

  // Sanity-check: msdf-atlas-gen with no args prints usage (exit 0) IF the sibling
  // dylibs resolve. A dyld failure (missing/unresolved dylib) exits non-zero.
  try {
    execFileSync(outBin, [], { stdio: 'pipe' });
    console.log(`[stage-msdf] bundled msdf-atlas-gen (+ ${dylibNames.length} dylibs: ${dylibNames.join(', ')}) → build/bin/`);
  } catch (e) {
    console.warn(`[stage-msdf] staged msdf-atlas-gen but it failed to run (dylib resolve?): ${e instanceof Error ? e.message : e}`);
  }
};
