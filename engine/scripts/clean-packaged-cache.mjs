#!/usr/bin/env node
/** Wipe the PACKAGED editor's on-disk state — userData, OS caches/prefs, and (opt-in) the
 *  provisioned Build Support toolchain — to simulate a clean install on this machine.
 *
 *  Deliberately packaged-ONLY: derives paths from productName()/appId() (electron-builder.yml)
 *  and userDataDir.ts's naming scheme, and never touches `Modoki Editor (dev)/*` — those are
 *  per-clone dev profiles (see CLAUDE.md "Clones" RULE 2); several may be running at once and
 *  clearing one out from under a live dev editor corrupts that session, not this machine's
 *  "packaged install" state.
 *
 *  Refuses to run while a packaged instance is alive (its Chromium profile is open — deleting
 *  under it corrupts rather than cleans) unless `--force` is passed to kill it first.
 *
 *  Usage:
 *    node engine/scripts/clean-packaged-cache.mjs                  # dry-run-safe subset (default = REAL delete, see flags)
 *    node engine/scripts/clean-packaged-cache.mjs --dry-run         # report only, delete nothing
 *    node engine/scripts/clean-packaged-cache.mjs --toolchain       # also wipe the provisioned JDK/Android SDK/toktx (multi-GB re-download)
 *                                                                   # honours MODOKI_TOOLCHAIN_DIR — wipes the override AND the default
 *    node engine/scripts/clean-packaged-cache.mjs --force           # kill a running packaged instance first instead of aborting
 *    node engine/scripts/clean-packaged-cache.mjs --eject-volumes   # (macOS) eject stale mounted "<productName> *" DMG volumes
 */

import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { productName, killPackaged } from './packagedAppPaths.mjs';
// The ONE 'same directory?' comparison (#869).
import { samePath } from './pathIdentity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

const DRY_RUN = process.argv.includes('--dry-run');
const INCLUDE_TOOLCHAIN = process.argv.includes('--toolchain');
const FORCE = process.argv.includes('--force');
const EJECT_VOLUMES = process.argv.includes('--eject-volumes');

const NAME = productName(); // "Modoki Editor"
const SHARED_DIR = 'Modoki'; // engine/electron/userDataDir.ts SHARED_DIR — machine-level toolchain root

function appId() {
  const yml = readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf8');
  const m = yml.match(/^appId:\s*(.+?)\s*$/m);
  if (!m) throw new Error('[clean-packaged-cache] appId missing from electron-builder.yml');
  return m[1].replace(/^["']|["']$/g, '');
}

function appSupportRoot() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
}

function localAppDataRoot() {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return null;
}

const id = appId();
const support = appSupportRoot();

/** { path, reason } — every candidate, always-included first, `--toolchain`-gated last. */
function targets() {
  const list = [
    { p: path.join(support, NAME), reason: 'packaged userData (recent projects, layouts, prefs, caches)' },
    { p: path.join(support, 'modoki-app'), reason: 'legacy pre-rename userData/recents' },
  ];
  if (process.platform === 'darwin') {
    list.push(
      { p: path.join(os.homedir(), 'Library', 'Caches', id), reason: 'Chromium disk cache' },
      { p: path.join(os.homedir(), 'Library', 'Caches', `${id}.ShipIt`), reason: 'auto-updater helper cache' },
      { p: path.join(os.homedir(), 'Library', 'Caches', 'modoki-app-updater'), reason: 'legacy updater cache' },
      { p: path.join(os.homedir(), 'Library', 'Preferences', `${id}.plist`), reason: 'app preferences plist' },
      { p: path.join(os.homedir(), 'Library', 'HTTPStorages', id), reason: 'HTTP cookie/storage cache' },
      { p: path.join(os.homedir(), 'Library', 'Saved Application State', `${id}.savedState`), reason: 'window-restore state' },
      { p: path.join(os.homedir(), 'Library', 'Logs', NAME), reason: 'app logs' },
    );
  } else if (process.platform === 'win32') {
    const local = localAppDataRoot();
    list.push(
      { p: path.join(local, NAME), reason: 'Chromium disk cache (local appdata)' },
      { p: path.join(local, `${NAME}-updater`), reason: 'NSIS/Squirrel updater cache' },
    );
  } else {
    list.push({ p: path.join(os.homedir(), '.cache', NAME), reason: 'Chromium disk cache' });
  }
  if (INCLUDE_TOOLCHAIN) {
    // MODOKI_TOOLCHAIN_DIR OVERRIDES the default location, so wipe BOTH — the override is where the
    // toolchain actually lives when it is set, and the default may still hold an older provision.
    //
    // Why both, and why this matters more than it looks: this script exists to set up a clean-install
    // test. Reporting "[done] removed 3 path(s)" while the LIVE toolchain sits untouched somewhere
    // else does not just fail to clean — it manufactures a test that silently proves nothing, because
    // `ensureNode`/`ensureJdk` return early when their binaries are already present. Measured
    // 2026-08-02 on the Windows clone: MODOKI_TOOLCHAIN_DIR pointed at E:\dev-cache\modoki-toolchain
    // holding ~1.1GB across node/jdk/android-sdk/npm-tools, none of which this script touched.
    const seen = new Set();
    for (const dir of [process.env.MODOKI_TOOLCHAIN_DIR, path.join(support, SHARED_DIR, 'toolchain')]) {
      if (!dir) continue;
      const resolved = path.resolve(dir);
      const dflt = path.join(support, SHARED_DIR, 'toolchain');
      // (#869) The LABEL comparison goes through `samePath`, because `path.resolve` does not fold
      // drive-letter case and `MODOKI_TOOLCHAIN_DIR=e:\…` pointing at the default dir was
      // therefore labelled as an override.
      //
      // ⚠️ The dedupe KEY is deliberately NOT canonical, and an earlier draft of this fix made it
      // so — which SKIPPED a multi-gigabyte directory instead of deleting it (close-out review).
      // If `MODOKI_TOOLCHAIN_DIR` is a junction to the default location (an ordinary Windows move
      // when C: is small), the canonical key of the link IS the target: iteration 1 keys on the
      // target and pushes the LINK, iteration 2 then matches that key and skips the real
      // directory. And `fs.rmSync(<junction>, {recursive:true})` removes only the link —
      // measured: the target's contents survive. So the wipe reported success with the whole
      // provision intact, which is exactly the outcome the "wipe BOTH" note above exists to
      // prevent. Keying on the raw resolved path lists both, and listing one directory twice is
      // a harmless no-op (`force: true`) where skipping it is a silent failure. ⚠️ Under
      // `--dry-run` nothing is removed, so a case-variant override does print the same directory
      // twice — cosmetic, but it is the printed evidence someone reads.
      //
      // ⚠️ **A junctioned toolchain dir is still NOT fully wiped, and that is out of scope here.**
      // `fs.rmSync(<junction>, {recursive:true})` removes only the link — measured, the target's
      // contents survive. This block rescues the case where the override is a junction TO the
      // default (the default is listed separately and deleted directly), but not the case where
      // the listed path is a junction whose target is listed nowhere — e.g. the default location
      // itself junctioned onto a bigger drive, with MODOKI_TOOLCHAIN_DIR unset. Then `--toolchain`
      // prints "removed N path(s)" with the provision intact, which is the silent success the
      // header above exists to prevent. Tracked in #883; fixing it means resolving and wiping a
      // link TARGET, which is not a decision to take inside a finishing pass.
      if (seen.has(resolved)) continue;         // the override may equal the default
      seen.add(resolved);
      list.push({
        p: resolved,
        reason: 'provisioned JDK/Android SDK/toktx/msdf-atlas-gen — MULTI-GB RE-DOWNLOAD'
          + (!samePath(resolved, dflt) ? ' [MODOKI_TOOLCHAIN_DIR]' : ''),
      });
    }
  }
  return list;
}

function isPackagedRunning() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${NAME}.exe`], { encoding: 'utf8' });
      return out.includes(`${NAME}.exe`);
    } catch { return false; }
  }
  try {
    execFileSync('pgrep', ['-f', `${NAME}.app`], { stdio: 'ignore' });
    return true;
  } catch { return false; } // pgrep exits 1 when nothing matches — the normal case
}

function ejectStaleVolumes() {
  if (process.platform !== 'darwin' || !existsSync('/Volumes')) return;
  for (const entry of readdirSync('/Volumes')) {
    if (!entry.startsWith(NAME)) continue;
    const vol = path.join('/Volumes', entry);
    console.log(`${DRY_RUN ? '[dry-run] would eject' : '[eject]'} ${vol}`);
    if (!DRY_RUN) {
      try { execFileSync('diskutil', ['eject', vol], { stdio: 'ignore' }); }
      catch (e) { console.warn(`  ! failed to eject ${vol}: ${e.message}`); }
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────
if (isPackagedRunning()) {
  if (!FORCE) {
    console.error(`[clean-packaged-cache] "${NAME}" is currently running — quit it first, or re-run with --force to kill it.`);
    process.exit(1);
  }
  console.log(`[clean-packaged-cache] killing running "${NAME}"…`);
  if (!DRY_RUN) killPackaged();
}

let removed = 0;
for (const { p, reason } of targets()) {
  if (!existsSync(p)) continue;
  console.log(`${DRY_RUN ? '[dry-run] would remove' : '[remove]'} ${p}\n  (${reason})`);
  if (!DRY_RUN) rmSync(p, { recursive: true, force: true });
  removed++;
}

if (EJECT_VOLUMES) ejectStaleVolumes();

if (removed === 0) console.log('[clean-packaged-cache] nothing found — already clean.');
else console.log(`\n${DRY_RUN ? '[dry-run] would remove' : '[done] removed'} ${removed} path(s).` + (INCLUDE_TOOLCHAIN ? '' : '  (toolchain kept — pass --toolchain to also wipe it.)'));
