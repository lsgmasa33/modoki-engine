/**
 * Where electron-builder's `--dir` output actually lives, per platform — the single
 * source of truth for the packaged-app smoke gates.
 *
 * `smoke-packaged.sh` (bash) and `assert-app-csp.mjs` (node) both need the same three
 * answers: which unpacked directory, which executable inside it, and how to kill a
 * leftover instance. They used to hardcode the macOS answers (`mac-arm64/…​.app`,
 * `Contents/MacOS/…`, `pkill -f`), which is why `npm run verify:packaged` — the gate
 * for engine/plugins + engine/scripts changes — could not run on Windows at all.
 *
 * Bash consumes this through the CLI form at the bottom, so neither script carries its
 * own copy of the platform table.
 *
 *   node packagedAppPaths.mjs <outDir> bin|appDir|found
 *   node packagedAppPaths.mjs kill [appDir]
 *   node packagedAppPaths.mjs clearViteCache
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** productName from electron-builder.yml — it names the .app/.exe, so reading it keeps
 *  this in step with a rename instead of duplicating the literal. Regex, not a YAML
 *  dep: the field is a plain top-level scalar. */
export function productName() {
  const yml = readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf8');
  const m = yml.match(/^productName:\s*(.+?)\s*$/m);
  if (!m) throw new Error('[packagedAppPaths] productName missing from electron-builder.yml');
  return m[1].replace(/^["']|["']$/g, '');
}

/** Candidate <unpacked dir, executable> pairs for this platform, most likely first.
 *  macOS varies by arch (mac-arm64 / mac / mac-universal), so probe rather than assume. */
function candidates(outDir, name) {
  if (process.platform === 'darwin') {
    return ['mac-arm64', 'mac', 'mac-universal', 'mac-x64'].map((d) => {
      const appDir = path.join(outDir, d, `${name}.app`);
      return { appDir, bin: path.join(appDir, 'Contents', 'MacOS', name) };
    });
  }
  if (process.platform === 'win32') {
    const appDir = path.join(outDir, 'win-unpacked');
    return [{ appDir, bin: path.join(appDir, `${name}.exe`) }];
  }
  const appDir = path.join(outDir, 'linux-unpacked');
  return [{ appDir, bin: path.join(appDir, name.toLowerCase().replace(/\s+/g, '-')) }];
}

/** Resolve the built app. `found` is false when nothing exists yet (pre-build); the
 *  first candidate is still returned so callers can print a useful expected-path. */
export function resolvePackagedApp(outDir, name = productName()) {
  const list = candidates(outDir, name);
  const hit = list.find((c) => existsSync(c.bin));
  return { ...(hit ?? list[0]), found: Boolean(hit), platform: process.platform };
}

/** The executable INSIDE an already-known app dir. Distinct from resolvePackagedApp,
 *  which searches an electron-builder OUTPUT dir: callers that were handed the app dir
 *  itself (release.yml points the CSP gate at a signed artifact) must not re-derive the
 *  platform subdirectory. On macOS the app dir is a `.app` bundle; elsewhere it is the
 *  unpacked folder that directly contains the binary. */
export function binInAppDir(appDir, name = productName()) {
  if (appDir.endsWith('.app')) return path.join(appDir, 'Contents', 'MacOS', path.basename(appDir, '.app'));
  if (process.platform === 'win32') return path.join(appDir, `${name}.exe`);
  return path.join(appDir, name.toLowerCase().replace(/\s+/g, '-'));
}

/** The OS "application support" root that Electron puts userData dirs under. */
function appSupportRoot() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
}

/** The PACKAGED editor's userData dir — `<app support>/<productName>`.
 *
 *  Electron's `app.getName()` prefers package.json `productName` and falls back to
 *  `name`, and electron-builder injects the former into the packaged package.json, so
 *  the packaged app and a DEV run use DIFFERENT dirs ("Modoki Editor" vs "modoki-app").
 *  Verified from the packaged app's own boot line:
 *    [modoki-electron] logging to …/AppData/Roaming/Modoki Editor/logs/main.log
 *
 *  Deliberately packaged-ONLY: the old hardcoded "modoki-app" cleared the dev cache
 *  instead, and clearing it is not harmless — a dev editor may be running in another
 *  clone, and pulling its dep-cache out from under it breaks that session. */
export function packagedUserData() {
  return path.join(appSupportRoot(), productName());
}

/** Drop the packaged Vite dep-cache. It is baked against whichever tree last ran, and
 *  the signed bundle is read-only so Vite cannot rewrite it in place — a stale one is a
 *  classic packaged-only failure. */
export function clearViteCache() {
  const cache = path.join(packagedUserData(), 'vite-cache');
  if (!existsSync(cache)) return [];
  rmSync(cache, { recursive: true, force: true });
  return [cache];
}

/** Kill a leftover packaged instance. Chromium's --remote-debugging-port fails SILENTLY
 *  when the port is held, so a stale process makes the CSP probe look at a port its app
 *  never opened. Best-effort by design — "nothing to kill" is the normal case. */
export function killPackaged(appDir, name = productName()) {
  try {
    if (process.platform === 'win32') {
      // No pkill on Windows; match the image name. /F because Electron ignores WM_CLOSE
      // when it has no window, which is exactly how the smoke launches it.
      execFileSync('taskkill', ['/F', '/IM', `${name}.exe`], { stdio: 'ignore' });
    } else {
      const pattern = appDir ? `${path.basename(appDir)}/Contents/MacOS` : name;
      execFileSync('pkill', ['-f', pattern], { stdio: 'ignore' });
    }
  } catch { /* nothing running — the normal case */ }
}

// ── CLI (for smoke-packaged.sh) ─────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [a, b] = process.argv.slice(2);
  if (a === 'kill') { killPackaged(b); process.exit(0); }
  if (a === 'clearViteCache') { for (const c of clearViteCache()) console.log('[smoke] cleared', c); process.exit(0); }
  // Native temp dir, forward-slashed so it is usable BOTH by bash and by the native
  // processes the smoke launches. Computed here rather than inline in the shell: Git
  // Bash's MSYS path conversion rewrites a bare "/" argument to the MSYS root, which
  // silently mangled the equivalent `node -e` one-liner into "C:C:/Program Files/Git/...".
  if (a === 'tmpdir') { process.stdout.write(os.tmpdir().split(path.sep).join('/')); process.exit(0); }
  if (!a) { console.error('usage: packagedAppPaths.mjs <outDir> bin|appDir | kill [appDir] | clearViteCache'); process.exit(1); }
  const r = resolvePackagedApp(a);
  const field = b ?? 'bin';
  if (field === 'found') { process.stdout.write(r.found ? '1' : '0'); process.exit(0); }
  process.stdout.write(String(r[field] ?? ''));
}
