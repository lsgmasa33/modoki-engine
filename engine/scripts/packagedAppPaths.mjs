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
import { isEntryPoint } from './entryPoint.mjs';

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
export function binInAppDir(appDir, name = productName(), platform = process.platform) {
  // ⚠️ The macOS branch keys on the ARGUMENT, not the platform — deliberately, per the docblock:
  // a caller handed a `.app` bundle gets its layout wherever the check runs. Only the win32/else
  // split is platform-derived, and `platform` is injectable for the same reason `appSupportRoot`'s
  // is (and `needsWinShell`/`spawnable` in `engine/toolchain/index.ts`): otherwise each leg can
  // pin only its own branch,
  // and this function had NO per-platform test at all until close-out swept for its shape.
  if (appDir.endsWith('.app')) return path.join(appDir, 'Contents', 'MacOS', path.basename(appDir, '.app'));
  if (platform === 'win32') return path.join(appDir, `${name}.exe`);
  return path.join(appDir, name.toLowerCase().replace(/\s+/g, '-'));
}

/** The OS "application support" root that Electron puts userData dirs under.
 *
 *  ⚠️ **The three branches do not read the same inputs, and that asymmetry has bitten a test.**
 *  win32 and linux honour an env var (`APPDATA` / `XDG_CONFIG_HOME`); **darwin honours neither** and
 *  derives from `os.homedir()` alone. So a fixture that sandboxes the environment moves this root on
 *  two platforms and not on the third — which is exactly how `cleanPackagedCacheLinkGuard.test.ts`
 *  came to pass on Windows and Linux and fail on macOS. Anything that needs to know where these
 *  paths land must CALL this, never re-derive it.
 *
 *  ⚠️ **Pure/platform-injectable — the shape `needsWinShell`/`spawnable` use in
 *  `engine/toolchain/index.ts` (NOT in this file; an earlier draft said "below") — and for a reason this
 *  file learned the hard way.** Reading `process.platform` directly would make the RULE itself
 *  unpinnable — every leg could only assert its own shape, and the darwin shape is the one no gate
 *  this repo runs would ever execute. Deriving callers off a shared helper stops them drifting from
 *  each other but proves nothing about whether the helper is RIGHT; that needs one test comparing
 *  each branch to a literal, which is legitimate exactly here because the literal IS the
 *  specification rather than a copy of it. `packagedAppPaths.test.ts` holds it. */
export function appSupportRoot(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME ?? path.join(home, '.config');
}

/** `engine/electron/userDataDir.ts`'s SHARED_DIR — the machine-level root the provisioned Build
 *  Support toolchain lives under, shared by every clone rather than per-app. */
export const SHARED_DIR = 'Modoki';

/** Where `--toolchain` looks when `MODOKI_TOOLCHAIN_DIR` is unset.
 *
 *  Exported so a TEST can build a fixture at the real default rather than re-deriving the path —
 *  `clean-packaged-cache.mjs` itself cannot be imported for it, because it is a top-level program
 *  and importing it would run the wipe. Deriving it twice is the guard-by-literal shape, and it had
 *  already gone wrong once: a fixture that assumed `<sandbox>/Modoki/toolchain` is right on win32
 *  and linux and wrong on darwin (see `appSupportRoot` above). */
export function defaultToolchainDir() {
  return path.join(appSupportRoot(), SHARED_DIR, 'toolchain');
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
 *  clone, and pulling its dep-cache out from under it breaks that session.
 *
 *  `home` defaults to this process's `os.homedir()` (which honours `$HOME`). A caller asking where a
 *  RUNNING editor keeps its state passes the editor's home instead — see `editorHomeDir` in
 *  `livePackagedEditor.mjs` for why those differ on darwin. */
export function packagedUserData(home = os.homedir()) {
  return path.join(appSupportRoot(process.platform, process.env, home), productName());
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
  //
  // ⚠️ **ONE spelling, deliberately — the two-spelling loop belongs to `killPackaged`, not here**
  // (#958 close-out review). A commit briefly OR-ed a second clause in by calling
  // `altPathSpelling` from this function. That was wrong twice over, and the second way is
  // dangerous:
  //
  //   1. **Redundant.** `killPackaged` already loops `dirs = [appDir, alt]` and calls this once per
  //      spelling. Measured: with the caller holding a link, `dirs.length === 2` — the set match
  //      was already there. The isolated measurement that motivated the change drove
  //      `winKillCommand` directly, which is not how it is ever called.
  //   2. **It bypassed the width guard and could widen a kill to a DRIVE ROOT.** `killPackaged`
  //      admits the alternate only if `altRaw.length >= 10`, for the reason its own comment gives.
  //      Recomputing the alt here skipped that: measured, a junction whose target is `C:\` emitted
  //      `StartsWith('C:\')`, which with the `Name` filter is every packaged editor on the drive —
  //      the owner's installed copy and every sibling clone's. #69's blast radius, produced by the
  //      fix meant to prevent it.
  //
  // So: keep this function PURE and single-spelling. Anything that needs a second spelling gets it
  // from `killPackaged`, where the guard lives. (`altPathSpelling` is also NOT `reap_alt_pattern`'s
  // equivalent — that helper additionally requires the pattern to sit under the registered root, so
  // it cannot return something shallower, and this one can. That caveat now lives with the
  // implementation in `pathIdentity.mjs`, which is where it moved in #988; this used to say "the
  // docblock below" and the docblock below is now the re-export.)
  const scope = appDir
    ? ` | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${q(String(appDir).replace(/[\\/]+$/, ''))}\\', [System.StringComparison]::OrdinalIgnoreCase) }`
    : '';
  // -Force because Electron ignores WM_CLOSE when it has no window — exactly how the smoke
  // launches it. -EA SilentlyContinue: "already gone" is the normal case, not an error.
  // Emit the matched COUNT on stdout. `Stop-Process -EA SilentlyContinue` exits 0 whether it
  // stopped a process or matched nothing, so unlike pkill the exit status cannot distinguish
  // killed-something from matched-nothing — and that silence is #944's half of this bug. The
  // count is materialised BEFORE stopping (@(...) forces an array, so a single match still
  // counts 1 rather than collapsing to a scalar); stopping first would leave nothing to count.
  return `$p = @(${select}${scope}); $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }; Write-Output $p.Count`;
}

/** The clone's OTHER spelling of an absolute path — re-exported from the path-identity SSOT.
 *
 *  ⚠️ **Moved to `pathIdentity.mjs` in #988/#1004, and this re-export is not a courtesy.** A third
 *  copy was about to be written for `engine/toolchain/index.ts`, which cannot import THIS module at
 *  all: the `REPO` const at the top evaluates `fileURLToPath(import.meta.url)`, and esbuild emits
 *  `import_meta = {}` in the bundled Electron main, so the import would throw at load. The re-export
 *  keeps this module's five callers and its tests on their existing import; the contract, the
 *  caller-owns-the-width-guard rule and the `reap_alt_pattern` comparison all live with the
 *  implementation. Do not re-inline it here. */
export { altPathSpelling } from './pathIdentity.mjs';
import { altPathSpelling } from './pathIdentity.mjs';

/** How a reap turned out. `exit 0` is right for all three — "nothing running" is the normal
 *  case — but they are NOT the same event, and collapsing them into one silent `catch` is what
 *  made every bash caller append `|| true` and made the silence structural (#944). */
export const REAP_KILLED = 'killed';
export const REAP_NONE = 'none';
export const REAP_ERROR = 'error';

/** Decode the win32 reap's stdout into an outcome. Pure and exported for the same reason
 *  `winKillCommand` is: the decision is unit-testable without spawning anything, and the
 *  behavioural cases in `killPackagedGuard.test.ts` are all `skipIf(win32)` so on a Mac NOTHING
 *  executes this branch. A text scan over the source cannot see an off-by-one in it — and did
 *  not: the first version's own comment claimed an empty stdout was an ERROR while the code
 *  returned NONE, because `Number('')` is 0 and `Number.isFinite(0)` is true.
 *
 *  ⚠️ **Empty stdout is an ERROR, not "nothing running".** `Stop-Process -EA SilentlyContinue`
 *  exits 0 whether it stopped something or matched nothing, so the COUNT is the only signal;
 *  no count at all means the command did not get far enough to print one. Reading that as an
 *  empty match is how a Windows reap that never ran reports success — #944's exact silence.
 *  Requires a bare run of digits: a warning line ahead of the number, or a blank stream, is
 *  not a count. */
export function decodeWinReap(stdout) {
  const t = String(stdout ?? '').trim();
  if (!/^\d+$/.test(t)) return REAP_ERROR;
  return Number(t) > 0 ? REAP_KILLED : REAP_NONE;
}

/** Kill a leftover packaged instance. Chromium's --remote-debugging-port fails SILENTLY
 *  when the port is held, so a stale process makes the CSP probe look at a port its app
 *  never opened. Best-effort by design — "nothing to kill" is the normal case.
 *
 *  Returns one of REAP_KILLED / REAP_NONE / REAP_ERROR — see those constants for why the
 *  three are distinguished rather than swallowed together. */
export function killPackaged(appDir, name = productName()) {
  // The .sh scripts have the same hazard guarded with bash's `${VAR:?msg}` (reapScoping.test.ts
  // §2, #69 follow-up): a `pkill -f` pattern built from a variable that turns out empty
  // silently widens to match every clone's process on this machine, not just this one. JS has
  // no expansion-time equivalent, so this is the explicit form — thrown OUTSIDE the try/catch
  // below on purpose: that catch DECODES pkill's exit status (0 signalled / 1 no match /
  // >=2 usage or fatal), and routing THIS guard through it would report a caller-side bug as
  // one of those three ordinary outcomes and continue. Only triggers when appDir is PASSED but comes out empty/implausibly short (a
  // caller-side bug) — an appDir that's deliberately OMITTED (undefined) is a separate,
  // documented case (see the fallback-to-bare-name comment below) and is left alone here.
  if (appDir !== undefined && (appDir === '' || appDir.length < 10)) {
    throw new Error(`[packagedAppPaths] refusing to reap with an empty/short appDir (${JSON.stringify(appDir)}) — that pattern would match every clone`);
  }
  // Both spellings this clone's app dir can be reached by, most specific first. Two SEPARATE
  // invocations below, never an ERE alternation: `pkill -f` takes an ERE, so a pattern built as
  // "$A|$B" with either side empty matches EVERY PROCESS ON THE MACHINE — #69's disaster
  // reintroduced by the fix meant to prevent it (`lib/repo-reap.sh` carries the same warning).
  // The no-appDir fallback has no path to canonicalise, so it stays a single reap.
  // ⚠️ The alternate must clear the SAME width guard as the argument. A 40-char `appDir` can be
  // a symlink to a very short real path, and the check above only ever saw the argument — so an
  // unchecked `alt` would slip a pattern past the one guard whose stated contract is that every
  // branch here guards against WIDENING the match.
  const altRaw = appDir === undefined ? null : altPathSpelling(appDir);
  const alt = altRaw !== null && altRaw.length >= 10 ? altRaw : null;
  const dirs = alt === null ? [appDir] : [appDir, alt];
  let outcome = REAP_NONE;
  for (const dir of dirs) {
    const one = _killOne(dir, name);
    // KILLED wins over NONE, and an ERROR is never masked by a later success — a usage/fatal
    // failure on either spelling means this reap cannot be trusted to have done its job.
    if (one === REAP_ERROR) outcome = REAP_ERROR;
    else if (one === REAP_KILLED && outcome !== REAP_ERROR) outcome = REAP_KILLED;
  }
  return outcome;
}

/** One spelling, one reap. Split out of killPackaged so the two-spelling loop above reads as
 *  the policy it is, and so the exit-status decoding lives in exactly one place. */
function _killOne(appDir, name) {
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
      // `Stop-Process -EA SilentlyContinue` exits 0 whether it stopped something or matched
      // nothing, so the status cannot carry the answer the way pkill's does. winKillCommand
      // emits the matched COUNT on stdout instead — hence `pipe` rather than `ignore` here.
      //
      // ⚠️ **Decoded HERE, not in the shared catch below — the two branches have incompatible
      // exit-code vocabularies.** `powershell.exe -Command` exits **1** on a terminating error
      // (WMI unavailable, access denied, a `Get-CimInstance` failure), and pkill's 1 means "no
      // match". Routing PowerShell through pkill's decode therefore reported a WMI failure as
      // `REAP_NONE`/"nothing running" — reintroducing, on the branch that had just gained the
      // count plumbing, precisely the silence #944 exists to remove.
      //
      // So: a clean exit with a parseable count is the ONLY non-error outcome. The decode lives
      // in `decodeWinReap` — pure, exported and unit-tested, because every behavioural case in
      // killPackagedGuard.test.ts is skipIf(win32) and so never executes this branch on a Mac.
      try {
        const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', winKillCommand(appDir, name)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return decodeWinReap(out);
      } catch {
        return REAP_ERROR; // any non-zero exit here is a failure to RUN the reap, never "no match"
      }
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
      return REAP_KILLED; // pkill exits 0 only when it matched AND signalled
    }
  } catch (e) {
    // POSIX ONLY — the win32 branch above decodes and returns without reaching here (see its
    // comment for why sharing this decode was a live bug).
    //
    // `pkill`'s exit codes are three states, and this catch used to flatten all of them into
    // one silent "nothing running": 0 = signalled, 1 = no match, >=2 = usage error or fatal.
    // A usage error therefore read as "nothing was running" — indistinguishable from success,
    // which is exactly the shape #944 was filed for. Decode it instead.
    //
    // A non-numeric status (ENOENT: no `pkill` on this box at all) is an ERROR for the same
    // reason — the reap did not happen and the caller must not be told it did.
    const status = /** @type {{ status?: unknown }} */ (e).status;
    if (status === 1) return REAP_NONE;
    return REAP_ERROR;
  }
}

// ── CLI (for smoke-packaged.sh) ─────────────────────────────────────────────
if (isEntryPoint(import.meta.url)) {
  const [a, b] = process.argv.slice(2);
  // `exit 0` for all three outcomes — "nothing running" is the normal case and every bash caller
  // appends `|| true` anyway — but SAY which one happened. A reap that cannot report the
  // difference between "killed it", "nothing there" and "pkill itself failed" is why that `|| true`
  // became structural (#944); the message is what makes the third state visible at all.
  if (a === 'kill') {
    const outcome = killPackaged(b);
    if (outcome === REAP_KILLED) console.log('[kill] reaped a packaged instance', b ?? '(any clone)');
    else if (outcome === REAP_NONE) console.log('[kill] nothing running', b ?? '(any clone)');
    // ⚠️ **stdout, NOT stderr.** All five bash callers invoke this as
    // `node "$PATHS" kill … 2>/dev/null || true` (they always have — it hid pkill's own noise,
    // which `stdio:'ignore'` already suppresses), so an alarm on stderr is discarded by every
    // consumer that exists. Measured: the two HARMLESS outcomes printed and the one that
    // matters did not, which made the whole reporting half of #944 a no-op. Found in
    // close-out review.
    else console.log('[kill] FAILED to reap — the reap did not run, so a stale instance may still hold the port', b ?? '(any clone)');
    process.exit(0);
  }
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
