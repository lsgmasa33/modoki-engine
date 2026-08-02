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

/** The PowerShell that reaps the packaged app on Windows — pure, so the SCOPING is unit-testable
 *  without spawning or killing anything (`packagedAppPaths.test.ts`). That matters more than usual
 *  here: the only way to test this by execution is to have two packaged instances running and
 *  confirm one survives, which is precisely the situation where getting it wrong is expensive.
 *
 *  `appDir` given → kill only processes whose `ExecutablePath` sits under that dir.
 *  `appDir` omitted → every packaged instance, any clone. That is the DOCUMENTED machine-wide
 *  case (clean-packaged-cache's "simulate a clean install"), matching the macOS fallback, and it
 *  is still narrower than the old `/IM` because it is opt-in rather than the only behaviour.
 *
 *  Single quotes are doubled — PowerShell's escape inside a single-quoted string — so a path or
 *  product name containing one cannot break out of the literal. */
export function winKillCommand(appDir, name = productName()) {
  const q = (s) => String(s).replace(/'/g, "''");
  const select = `Get-CimInstance Win32_Process -Filter 'Name = "${q(name)}.exe"'`;
  // `.StartsWith(dir + '\')`, NOT `-like "$dir\*"`. `-like` is a WILDCARD match, so a `[`, `]`,
  // `*` or `?` anywhere in the path (all legal on Windows, and `%TEMP%` under some usernames has
  // them) would be read as a character class and match nothing — a reap that silently does
  // nothing, indistinguishable from "nothing was running". StartsWith is an exact prefix test.
  // OrdinalIgnoreCase because Windows paths are case-insensitive and Win32_Process reports the
  // on-disk casing, which need not match how the caller spelled it.
  // The trailing separator makes it a DIRECTORY prefix: without it, `…\win-unpacked` would also
  // match a sibling `…\win-unpacked-old`.
  const scope = appDir
    ? ` | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${q(appDir.replace(/[\\/]+$/, ''))}\\', [System.StringComparison]::OrdinalIgnoreCase) }`
    : '';
  // -Force because Electron ignores WM_CLOSE when it has no window — exactly how the smoke
  // launches it. -EA SilentlyContinue: "already gone" is the normal case, not an error.
  return `${select}${scope} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }`;
}

/** Kill a leftover packaged instance. Chromium's --remote-debugging-port fails SILENTLY
 *  when the port is held, so a stale process makes the CSP probe look at a port its app
 *  never opened. Best-effort by design — "nothing to kill" is the normal case. */
export function killPackaged(appDir, name = productName()) {
  // The .sh scripts have the same hazard guarded with bash's `${VAR:?msg}` (reapScoping.test.ts
  // §2, #69 follow-up): a `pkill -f` pattern built from a variable that turns out empty
  // silently widens to match every clone's process on this machine, not just this one. JS has
  // no expansion-time equivalent, so this is the explicit form — thrown OUTSIDE the try/catch
  // below on purpose: that catch exists for "pkill/taskkill found nothing to kill" (their
  // normal, expected non-zero exit), and swallowing THIS guard the same way would silently
  // defeat it. Only triggers when appDir is PASSED but comes out empty/implausibly short (a
  // caller-side bug) — an appDir that's deliberately OMITTED (undefined) is a separate,
  // documented case (see the fallback-to-bare-name comment below) and is left alone here.
  if (appDir !== undefined && (appDir === '' || appDir.length < 10)) {
    throw new Error(`[packagedAppPaths] refusing to reap with an empty/short appDir (${JSON.stringify(appDir)}) — that pattern would match every clone`);
  }
  try {
    if (process.platform === 'win32') {
      // Scope by executable PATH, mirroring the macOS branch below. This used to be
      // `taskkill /F /IM "<name>.exe"`, which is machine-wide BY CONSTRUCTION: an image name
      // cannot distinguish this clone's packaged app from a sibling's, or from the user's
      // installed copy. MEASURED 2026-08-02: a `test-packaged.sh` run in this repo killed the
      // editor the repo owner was testing from `%LOCALAPPDATA%\Programs`, mid-session. That is
      // the same #69 class the macOS branch was fixed for; Windows simply never was, and
      // `reapScoping.test.ts` could not see it because that guard is a text scan over `pkill`
      // patterns in bash scripts.
      //
      // No `taskkill` equivalent of `pkill -f` exists (its /FI filters cannot match a path), so
      // this goes through PowerShell + Win32_Process.ExecutablePath. Dev editors run
      // `electron.exe` and so never match the Name filter at all; the path filter is what keeps
      // one PACKAGED instance from reaping another.
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', winKillCommand(appDir, name)], { stdio: 'ignore' });
    } else {
      // Match the FULL app path, not its basename: every clone's packaged app is called
      // "Modoki Editor.app", so a basename pattern reaps a sibling clone's app too (#69).
      //
      // The no-appDir fallback means "any PACKAGED instance, any clone" (clean-packaged-cache's
      // machine-wide "simulate a clean install"). It used to be the bare product name, and that
      // was MEASURED KILLING DEV EDITORS on 2026-08-01 — the #69 residue, and the direct cause of
      // the repeated `reason=killed exitCode=15` deaths in /tmp/modoki-editor-5180.log:
      //
      //   pkill -f "Modoki Editor"  MATCHES  Electron Helper --type=gpu-process \
      //                                        --user-data-dir=".../Modoki Editor (dev)/<hash>"
      //
      // Electron passes the APP NAME to every child in `--user-data-dir`, so a bare-name pattern
      // matches a DEV editor's helper processes (GPU, network, audio) on every clone — while
      // MISSING the dev main process, whose command line carries no user-data-dir. That is
      // exactly the observed signature: the helpers die, the main process survives and logs
      // three "CHILD PROCESS GONE reason=killed" lines with nothing to blame.
      //
      // Anchoring to the BUNDLE PATH keeps the machine-wide scope the caller wants while making
      // a dev editor structurally unmatchable: a packaged process runs from
      // `…/Modoki Editor.app/Contents/…` (main under `MacOS/`, helpers under `Frameworks/`),
      // whereas a dev editor runs from `…/Electron.app/Contents/…` and only ever mentions the
      // product name inside a data-dir path. Trailing `/Contents/` (not `/Contents/MacOS`) so
      // the packaged app's own helpers are still reaped.
      const pattern = appDir ? `${appDir}/Contents/` : `${name}.app/Contents/`;
      execFileSync('pkill', ['-f', pattern], { stdio: 'ignore' });
    }
  } catch { /* nothing running — the normal case */ }
}

// ── CLI (for smoke-packaged.sh) ─────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [a, b] = process.argv.slice(2);
  if (a === 'kill') { killPackaged(b); process.exit(0); }
  // `binIn <appDir>` — the executable inside an app dir the caller was HANDED (release.yml points
  // the gates at a signed artifact). Distinct from `<outDir> bin`, which SEARCHES a build output
  // dir; conflating them re-derives a platform subdirectory that is already part of the path.
  if (a === 'binIn') { process.stdout.write(binInAppDir(b ?? '')); process.exit(0); }
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
