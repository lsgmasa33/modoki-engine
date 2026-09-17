/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * electron-builder beforePack hook — stage msdf-atlas-gen (+ its dylib closure)
 * for bundling. Font import (engine/plugins/font-convert.ts) shells out to
 * msdf-atlas-gen to bake mtsdf atlases. What it bundles is the PINNED build
 * (pinnedToolForStaging.cjs, #1327), never whatever the build machine has on PATH —
 * the packaged editor bakes with what it bundles. On macOS that is our own statically
 * linked build (engine/scripts/build-msdf-atlas-gen-macos.sh; Chlumsky ships
 * win32/win64 only), so its dylib closure below is EMPTY.
 *
 * The relocation is kept for an MODOKI_MSDF_ATLAS_GEN pointing at a dynamically
 * linked build (Homebrew's links libpng16 · libtinyxml2 · libfreetype by absolute
 * path): copy the binary + its full non-system dylib closure into build/bin/, then
 * rewrite every absolute load path (and each dylib's own id) to `@loader_path/<name>` so the
 * siblings resolve from wherever Resources/bin ends up. install_name_tool
 * invalidates the ad-hoc signature, so we re-sign each file (electron-builder's
 * signing pass re-signs them again for real; the local ad-hoc sign is what lets an
 * unsigned `--dir` build actually run). The disable-library-validation entitlement
 * (already required by toktx) lets the binary load the sibling dylibs under
 * hardened runtime. main.ts resolves MODOKI_MSDF_ATLAS_GEN to the copy when packaged.
 *
 * Graceful: if the pinned build can't be provisioned on the build machine, log + skip —
 * font import then shows a clear install hint.
 *
 * Two platforms, one destination (build/bin → resources/bin):
 *   • macOS — copy the pinned binary (+ any dylib closure) (below).
 *   • Windows — copy the pinned msdf-atlas-gen.exe (stageMsdfWin32). The win64 build is a
 *     single statically-linked exe (imports only KERNEL32 — no sibling DLLs), so it's a plain
 *     copy, no relocation. A no-op in CI (release-windows.yml pre-stages via download, and
 *     this skips when build/bin is already populated). Other platforms no-op.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pinnedToolForStaging } = require('./pinnedToolForStaging.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BIN_DIR = path.join(PROJECT_ROOT, 'build', 'bin');

/** Drop a half-staged artifact so the NEXT pack re-stages and re-verifies instead of
 *  short-circuiting on its presence. See the throw sites for why this is load-bearing. */
function rmStaged(paths) {
  for (const p of paths) { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } }
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
 *  (a dynamically linked build uses absolute paths, which is what we need). */
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

/** Windows staging: copy the installed msdf-atlas-gen.exe into build/bin (single static exe,
 *  no siblings). Idempotent — skip when build/bin already holds it (CI download step / prior run). */
async function stageMsdfWin32() {
  const out = path.join(BIN_DIR, 'msdf-atlas-gen.exe');
  if (fs.existsSync(out)) {
    console.log('[stage-msdf] build/bin/msdf-atlas-gen.exe already present — skipping (CI-staged or cached).');
    return;
  }
  const bin = pinnedToolForStaging('msdf-atlas-gen');
  if (!bin) {
    console.warn('[stage-msdf] no pinned msdf-atlas-gen.exe (MODOKI_MSDF_ATLAS_GEN, or ' +
      '`npm run toolchain:install -- msdf-atlas-gen`) — skipping bundle. Font import will show an install hint.');
    return;
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.copyFileSync(bin, out);
  try {
    execFileSync(out, ['-version'], { stdio: 'pipe' }); // prints "MSDF-Atlas-Gen v1.4.0", exit 0
    console.log('[stage-msdf] bundled msdf-atlas-gen.exe → build/bin/');
  } catch (e) {
    // ⚠️ **THROW — the staged copy is verified and the verdict must not be discarded**
    // (#945 B3). The check below already existed; its result was logged and dropped, so a
    // relocation or dylib-resolve failure staged a binary that CANNOT RUN and the pack
    // continued, signed it, and shipped it. That is distinct from the tool being ABSENT on
    // this build machine, which stays a graceful skip above (before-pack.cjs's documented
    // contract: a missing optional tool never fails the build). Staged-but-broken is not a
    // missing tool — it is a bad artifact, and it must stop the pack.
      // ⚠️ **Remove the staged copy BEFORE throwing.** Both win32 stagers short-circuit on
      // `fs.existsSync(out)` at the top — *before* this sanity run — so leaving a broken binary
      // in build/bin means the NEXT pack skips staging AND verification and signs a shipping app
      // around the same broken tool, silently. macOS does not have this hole (it re-copies and
      // re-verifies every run); the asymmetry is the idempotence early-return. Found in
      // close-out review of #945 B3.
      rmStaged([out]);
    throw new Error(`[stage-msdf] staged msdf-atlas-gen.exe but it failed to run: ${e instanceof Error ? e.message : e}`, { cause: e });
  }
}

exports.default = async function stageMsdf(context) {
  const platform = context && context.electronPlatformName;
  if (platform === 'win32') return stageMsdfWin32();
  if (platform && platform !== 'darwin') return; // linux/other — nothing to stage

  const bin = pinnedToolForStaging('msdf-atlas-gen');
  if (!bin) {
    console.warn('[stage-msdf] no pinned msdf-atlas-gen (MODOKI_MSDF_ATLAS_GEN, or ' +
      '`npm run toolchain:install -- msdf-atlas-gen`) — skipping bundle; font import will show an install hint.');
    return;
  }

  const closure = dylibClosure(bin); // basename -> source path
  fs.mkdirSync(BIN_DIR, { recursive: true });

  // Drop dylibs a PREVIOUS pack relocated for a dynamically linked build: electron-builder ships
  // all of build/bin, so after the switch to the static pinned build (#1327) a local pack would
  // otherwise carry the old Homebrew closure along, unused. libktx belongs to stage-toktx.
  for (const name of fs.readdirSync(BIN_DIR)) {
    if (name.endsWith('.dylib') && !name.startsWith('libktx') && !closure.has(name)) rmStaged([path.join(BIN_DIR, name)]);
  }

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
    // ⚠️ **THROW — the staged copy is verified and the verdict must not be discarded**
    // (#945 B3). The check below already existed; its result was logged and dropped, so a
    // relocation or dylib-resolve failure staged a binary that CANNOT RUN and the pack
    // continued, signed it, and shipped it. That is distinct from the tool being ABSENT on
    // this build machine, which stays a graceful skip above (before-pack.cjs's documented
    // contract: a missing optional tool never fails the build). Staged-but-broken is not a
    // missing tool — it is a bad artifact, and it must stop the pack.
    rmStaged([outBin, ...dylibNames.map((b) => path.join(BIN_DIR, b))]);
    throw new Error(`[stage-msdf] staged msdf-atlas-gen but it failed to run (dylib resolve?): ${e instanceof Error ? e.message : e}`, { cause: e });
  }
};
