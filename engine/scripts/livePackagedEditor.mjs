#!/usr/bin/env node
/** "Is a packaged editor holding the state this run is about to delete?" — the ONE predicate
 *  `clean-packaged-cache.mjs` asks before it deletes anything (#1037).
 *
 *  ── The defect this replaces ─────────────────────────────────────────────────────────────────
 *  The old check was `pgrep -f "<productName>.app"`: *"does the string `Modoki Editor.app` appear
 *  in ANY process's argv on this machine?"* That is a different question from the one that makes a
 *  wipe unsafe, and it was wrong in both directions at once — which is the tell that a predicate
 *  asks the wrong thing rather than asking the right thing badly:
 *
 *   - **Too broad, three ways, all OBSERVED.** `pgrep -f` matches a full command line, so it fired
 *     on another clone's packaged smoke running out of its own temp dir (nothing to do with this
 *     machine's installed state); on a shell running a heredoc that merely QUOTED the path; and on
 *     a `grep` typed to debug this very issue — the diagnostic for the bug triggered the bug. It
 *     also refused `--dry-run`, which deletes nothing, because the liveness check ran before
 *     `DRY_RUN` was ever consulted.
 *   - **Too narrow.** It cannot see a running DEV editor at all, whose binary is
 *     `…/node_modules/electron/dist/Electron.app/…` and which only ever mentions the product name
 *     inside a `--user-data-dir` path.
 *
 *  Cost: it red-gated `npm run verify` on four different clones, and `verify:publish` with it —
 *  the hub's only gate against a private value reaching the public mirror.
 *
 *  ── What this asks instead ───────────────────────────────────────────────────────────────────
 *  Two questions, in order, and the second is the one the old predicate could not express:
 *
 *   1. **Is this process EXECUTING the packaged bundle?** Decided from the executable path, never
 *      from the rest of argv. A shell, a grep or an agent session quoting the path is then
 *      structurally unmatchable. This is `killPackaged`'s discipline in `packagedAppPaths.mjs`,
 *      which anchors its reap to `<appDir>/Contents/` for exactly this reason and which this site
 *      never inherited — #899/#913's shape again, a fix that did not generalise to the site beside
 *      it. ⚠️ "Executable path" is what `ps -o comm=` reports, and on macOS that is **`argv[0]` as
 *      exec'd**, not the resolved image — measured: a `node` spawned with `argv0` set to a
 *      nonexistent `…/Modoki Editor.app/Contents/MacOS/Modoki Editor` reports exactly that. Every
 *      launcher passes the real path, so nothing incidental matches; it is also what lets a test
 *      stand in for a packaged editor without a signed bundle on disk.
 *   2. **Is it THIS installation?** Its `--user-data-dir` (or, absent one, the packaged default)
 *      under one of the paths this run would delete. A sibling clone's smoke points at its own
 *      session scratchpad and is therefore none of our business; the developer's real editor
 *      defaults to the candidate and still blocks.
 *
 *  ⚠️ **A blocking process blocks the WHOLE run, not just the candidate it matched.** The
 *  candidates are one installation's state — userData, Chromium caches, prefs, logs — and a live
 *  editor holds more of them than its `--user-data-dir` names. Matching one is what identifies the
 *  installation; it is not a licence to delete the others out from under it.
 */

import { outputLines, parsePidRows } from './subprocessText.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { isUnderOrSame } from './pathIdentity.mjs';

/** Every plausible reading of `--user-data-dir` in a command line, most specific first.
 *
 *  ⚠️ **Plural, and that is the whole design.** `ps` renders argv space-joined, so an unquoted
 *  value containing spaces is INDISTINGUISHABLE from a value followed by more arguments — and the
 *  macOS packaged default contains two spaces (`Application Support`, and the product name). Both
 *  readings of `--user-data-dir=/Users/x/Library/Application Support/Modoki Editor /repo/court`
 *  are grammatical, and no parser can choose between them from this input.
 *
 *  A single-answer parser therefore has to guess, and MEASURED, every wrong guess failed OPEN:
 *  the over-long value resolved outside every candidate, so a live editor holding the default
 *  userData read as "not ours" and its state was deleted. Returning all the readings lets the
 *  caller block if ANY of them lands in the target set, which fails CLOSED — a spurious refusal is
 *  recoverable, deleting a running app's state is not.
 *
 *  Returns `[]` when the flag is absent, or present with no value (`--user-data-dir --other`), or
 *  empty (`--user-data-dir=""` — which Chromium itself falls back to the default for). `[]` means
 *  "use the platform default", NOT "this process has no state". */
export function userDataDirCandidatesFromCommand(command) {
  const s = String(command ?? '');
  // The LAST occurrence: Chromium honours the last `--user-data-dir` when several are passed, so
  // an earlier one is a value this process is NOT using.
  const quoted = [...s.matchAll(/--user-data-dir[= ]("([^"]*)"|'([^']*)')/g)];
  // ⚠️ Quoted wins over a later BARE occurrence, which contradicts Chromium's last-wins when both
  // spellings appear in one command line. Contrived, and unreachable on posix where `ps` does not
  // re-quote argv; left because resolving it would mean interleaving two scans for a shape nobody
  // has produced. Fail-open if it ever happens, so it is written down.
  if (quoted.length > 0) {
    // Quoted is unambiguous — one reading, exactly.
    const v = quoted[quoted.length - 1];
    const val = v[2] ?? v[3] ?? '';
    return val ? [val] : [];
  }
  const bare = [...s.matchAll(/--user-data-dir[= ](.+?)(?=\s+--|$)/g)];
  if (bare.length === 0) return [];
  const raw = bare[bare.length - 1][1].trim();
  // `--user-data-dir --enable-features=X` — the flag took no value at all. The regex cannot match
  // this (the lookahead stops it), but `--user-data-dir=--foo` can still arrive; a value that is
  // itself a flag is not a path.
  if (!raw || raw.startsWith('--')) return [];
  // Every space boundary is a plausible end of the path. Longest first: the whole run is the
  // reading that is right whenever the path genuinely contains spaces, which is the common case
  // on macOS.
  const parts = raw.split(' ');
  const out = [];
  for (let n = parts.length; n >= 1; n -= 1) {
    const candidate = parts.slice(0, n).join(' ');
    if (candidate) out.push(candidate);
  }
  return out;
}

/** Does this EXECUTABLE path belong to the packaged app?
 *
 *  ⚠️ Anchored to `<name>.app/Contents/` on posix rather than to the basename, and to the exact
 *  `<name>.exe` leaf on win32. A dev editor runs from `Electron.app/Contents/…`, so it cannot
 *  match either — which is deliberate for the userData half (dev keeps its own tree) and is the
 *  documented gap for `--toolchain`, where the toolchain is shared and the right question would be
 *  "is ANY editor running". That gap is stated in `clean-packaged-cache.mjs`'s header rather than
 *  guessed at here: nobody has yet shown a toolchain wipe actually breaks a live dev editor. */
export function isPackagedExecutable(exePath, productName, platform = process.platform) {
  const exe = String(exePath ?? '');
  if (!exe) return false;
  if (platform === 'win32') {
    return exe.toLowerCase().endsWith(`\\${productName}.exe`.toLowerCase());
  }
  return exe.includes(`/${productName}.app/Contents/`);
}

/** The pure decision: which of these processes block a wipe of these candidates?
 *
 *  @param rows        `{ pid, exe, command }` — `exe` is the EXECUTABLE path, `command` the argv.
 *  @param opts.productName      the packaged app's product name.
 *  @param opts.candidates       absolute paths this run would delete.
 *  @param opts.defaultUserData  where a packaged instance keeps state when launched with no
 *                               `--user-data-dir`.
 *  @param opts.platform         overridable for tests.
 *  @returns the blocking rows, each with the `userData` that identified it.
 */
export function blockingEditors(rows, opts) {
  const {
    productName, candidates, defaultUserData, platform = process.platform,
    sharedStatePaths = [], stagingRoots = [],
  } = opts;
  // Hoisted: it depends on nothing in the row, and computing it per row is what hid the defect the
  // close-out review caught — a branch that reads no row field looks row-specific inside the loop.
  const wouldDeleteSharedState = (candidates ?? []).some(
    (c) => sharedStatePaths.some((sp) => isUnderOrSame(sp, c) || isUnderOrSame(c, sp)),
  );
  const out = [];
  for (const row of rows ?? []) {
    if (!isPackagedExecutable(row.exe, productName, platform)) continue;

    // ⚠️ **A STAGED bundle is a smoke copy, not this machine's install, and it is checked FIRST.**
    // `smoke-packaged.sh` stages at `$TMPBASE/modoki-pkg-smoke-<clone>`. Ordering is the whole
    // lesson of the close-out review: with the shared-state branch first, every packaged process on
    // a real Mac blocked — including a sibling clone's smoke — which IS #1037, restored by its own
    // fix. Worse on `--force`, where a non-empty blocker list caused by ANOTHER clone drives a
    // machine-wide `pkill` that kills that clone's in-flight smoke.
    const staged = stagingRoots.some((r) => isUnderOrSame(r, row.exe));
    const declared = userDataDirCandidatesFromCommand(row.command);

    // A staged bundle with NO `--user-data-dir` cannot be attributed to us: Electron gives helpers
    // a data dir but not the main process, and `chrome_crashpad_handler` never gets one. Defaulting
    // those to OUR userData is what made one helper inside a sibling's smoke block this clone.
    // A staged bundle that DOES declare a dir is still tested below — if it points at our state, it
    // is using our state whatever its bundle location.
    //
    // ⚠️ **STATED GAP, win32, unobserved.** "staged + flagless ⇒ not ours" is an inference from
    // BUNDLE location to STATE location, and those are independent: a packaged binary launched
    // with no `--user-data-dir` uses the default wherever its bundle sits. So a staged bundle whose
    // MAIN process is launched flagless would be skipped while genuinely using our state. Every
    // launcher in this repo passes `--user-data-dir` to a staged bundle (`smoke-packaged.sh:129`),
    // so the shape has no producer here — and per CLAUDE.md a Windows path hazard is not
    // diagnosable from a Mac. Recorded rather than guarded, on the same principle as the
    // `--toolchain` gap: a guard against an unobserved failure is a refusal defended by reasoning.
    // If a flagless staged main process is ever seen, require it to declare a userData outside our
    // candidates instead of exempting it on bundle location alone.
    if (staged && declared.length === 0) continue;

    // ⚠️ **Some of what this run deletes is keyed on the BUNDLE ID, not on a user-data dir** —
    // `Preferences/<appId>.plist`, `HTTPStorages/<appId>`, `Caches/<appId>`, `Saved Application
    // State/<appId>`. An INSTALLED editor holds those whatever `--user-data-dir` it was launched
    // with, so a userData-only test hands them to the delete while it is live. Staged copies are
    // excluded above by design: their state is transient, and treating them as holders is exactly
    // the cross-clone refusal #1037 exists to remove.
    if (!staged && wouldDeleteSharedState) {
      out.push({ ...row, userData: '(bundle-id-scoped state, held regardless of --user-data-dir)' });
      continue;
    }

    // No declared value means the platform default — NOT "no state". Reading absence as "nothing
    // to protect" is what lets the developer's own editor through, and that is the one process
    // this guard most exists to catch.
    const readings = declared.length > 0 ? declared.map((d) => path.resolve(d)) : [defaultUserData];
    for (const userData of readings) {
      if (!userData) continue;
      // Either direction counts: the candidate may BE the userData root, or sit inside it, or
      // contain it. All three mean this run would delete state a live process is using.
      const hit = (candidates ?? []).some((c) => isUnderOrSame(c, userData) || isUnderOrSame(userData, c));
      // ANY plausible reading matching is enough — see `userDataDirCandidatesFromCommand` for why
      // this is deliberately the fail-CLOSED direction.
      if (hit) { out.push({ ...row, userData }); break; }
    }
  }
  return out;
}

/** The paths a live INSTALLED editor holds regardless of its `--user-data-dir`, because they are
 *  keyed on the bundle id (or, on win32, the product name) rather than on a data dir.
 *
 *  ⚠️ **Resolved against the REAL home, not `$HOME` — except as ROOT, where it follows `$HOME`; the
 *  rule and its reason live in `invokingUserHome`.** `os.userInfo().homedir` reads the passwd
 *  entry — verified: with `HOME=/tmp/fake-home`, `os.homedir()` returns the fake and this returns
 *  the real one. That difference is the entire mechanism that keeps a SANDBOXED run unblocked: its
 *  candidates move with `$HOME` and so can never overlap these. ⚠️ The redirect is therefore
 *  load-bearing — a sandbox that *unsets* HOME instead makes `os.homedir()` fall back to the real
 *  home and this check starts firing.
 *
 *  ⚠️ `os.userInfo()` THROWS (`ERR_SYSTEM_ERROR`, `uv_os_get_passwd`) when the uid has no passwd
 *  entry — a container run as `--user 1000:1000`. Caught, because dying with a stack trace instead
 *  of this script's own refusal helps nobody. */
export function sharedStatePaths(appId, productName, platform = process.platform, uid = process.getuid?.()) {
  const home = invokingUserHome(uid);
  if (!home) return [];
  if (platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Preferences', `${appId}.plist`),
      path.join(home, 'Library', 'HTTPStorages', appId),
      path.join(home, 'Library', 'Caches', appId),
      path.join(home, 'Library', 'Caches', `${appId}.ShipIt`),
      path.join(home, 'Library', 'Saved Application State', `${appId}.savedState`),
      path.join(home, 'Library', 'Logs', productName),
    ];
  }
  if (platform === 'win32') {
    // ⚠️ NOT empty, and saying it was empty was an unargued claim contradicted by the caller's own
    // target list (close-out review): `%LOCALAPPDATA%\<productName>` and `…-updater` are keyed on
    // the product NAME, sit outside `%APPDATA%\<productName>`, and are held by a live editor
    // irrespective of its data dir — finding 1's mechanism, on the other platform.
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(local, productName), path.join(local, `${productName}-updater`)];
  }
  return [path.join(home, '.cache', productName)];
}

/** The home a packaged editor resolves its OWN default state against — the input for "where does
 *  a flagless editor keep its userData", which `blockingEditors` needs as `defaultUserData`.
 *
 *  ⚠️ **On darwin that is the passwd home, NOT `$HOME`.** Measured 2026-09-11 with the dev Electron
 *  binary and a `main.js` printing `app.getPath(...)`: under `HOME=/tmp/fakehome`, `home` and
 *  `appData` both still report `/Users/<user>` — as do Foundation's `NSHomeDirectory()` and
 *  `NSSearchPathForDirectoriesInDomains`, which Chromium's `DIR_APP_DATA` is built on. Node's
 *  `os.homedir()` DOES honour `$HOME`, so deriving the default from it attributes every flagless
 *  packaged editor on the machine to whatever `$HOME` this process was given.
 *
 *  That is #1037 reopened: the guard suite's `sandboxEnv` redirects `$HOME` into a fixture, so a
 *  sibling clone's `release/` build (flagless, not staged) read as "using `<fixture>/Library/
 *  Application Support/Modoki Editor`" and reddened `verify`. In production `$HOME` is the passwd
 *  home and nothing changes.
 *
 *  ⚠️ **win32/linux: unchanged, and that is a stated gap, not a finding.** Chromium on linux reads
 *  `$HOME`/`XDG_CONFIG_HOME` (so `os.homedir()` is the right model there); on win32 it reads the
 *  known-folder API rather than `%APPDATA%`, which would make `appSupportRoot`'s env read the same
 *  mismatch — but that is source-reading, not a measurement, and a Windows path hazard is not
 *  diagnosable from a Mac. `sharedStatePaths`' win32 `process.env.LOCALAPPDATA` read is the same
 *  shape. Measure on `win` before changing either.
 *
 *  ⚠️ **Only when this process runs as the SAME user as the editor it is asking about — so never as
 *  root.** `os.userInfo()` is the passwd entry of THIS process's uid. Under `sudo -E` (and any sudo
 *  that keeps `$HOME`) the script is uid 0 while `$HOME` — and therefore `targets()` — is still the
 *  invoking user's: the passwd home is then `/var/root`, a flagless live editor's userData would be
 *  attributed there, match no candidate, and the wipe would proceed under it (close-out review of
 *  #1037). For uid 0 this returns `os.homedir()`, the pre-#1037 derivation, which is correct there
 *  for the only editor that matters: the invoking user's, whose home IS that `$HOME`. The same rule
 *  governs `sharedStatePaths` — both go through `invokingUserHome`, so they cannot disagree.
 *
 *  `os.userInfo()` throws for a uid with no passwd entry; this then falls back to `os.homedir()`, the
 *  pre-#1037 derivation. */
export function editorHomeDir(platform = process.platform, uid = process.getuid?.()) {
  if (platform !== 'darwin') return os.homedir();
  return invokingUserHome(uid) ?? os.homedir();
}

/** The home of the user this process is acting FOR — the one whose `targets()` a run deletes, and so
 *  the one whose live editor matters. Shared by `editorHomeDir` and `sharedStatePaths` so the two
 *  cannot disagree about it: they did once, and `sharedStatePaths` still failed OPEN as root after
 *  `editorHomeDir` had been fixed (close-out review of #1037 — an installed editor launched with a
 *  foreign `--user-data-dir` stopped blocking the bundle-id-keyed caches under `sudo -E`).
 *
 *  - Not root: the passwd home (`os.userInfo()`), which ignores `$HOME` — what Electron uses on
 *    darwin, and what keeps a sandboxed run's redirected candidates from matching.
 *  - Root (`uid === 0`, e.g. `sudo -E`): `os.homedir()`, i.e. `$HOME` — the invoking user's, since the
 *    passwd home would be `/var/root` while `targets()` are still under `$HOME`.
 *  - `null` when the passwd entry cannot be read (`os.userInfo()` throws for a uid with none). */
function invokingUserHome(uid) {
  if (uid === 0) return os.homedir() || null;
  try { return os.userInfo().homedir || null; } catch { return null; }
}

/** Roots under which a packaged bundle is a STAGED copy rather than an install.
 *
 *  One entry: `isUnderOrSame` canonicalises both operands, so `/var/folders/…` and
 *  `/private/var/folders/…` already compare equal on darwin — an explicit `'/private' + tmpdir()`
 *  second entry was redundant there and produced the nonsense `/privateC:\Users\…\Temp` on
 *  win32. */
export function stagingRoots() {
  return [os.tmpdir()];
}

/** Enumerate every process, as `{ pid, exe, command }`.
 *
 *  ⚠️ `exe` and `command` come from SEPARATE queries on posix and are joined by pid, deliberately.
 *  macOS `ps -Ao comm=` prints the full executable path and it CONTAINS SPACES (`…/Modoki
 *  Editor.app/Contents/MacOS/Modoki Editor`), so asking one `ps` for both columns produces a line
 *  no parser can split correctly. Getting that wrong fails open — an unsplittable row looks like
 *  "not an editor" — which is the direction that deletes a live app's state.
 *
 *  ⚠️ **Returns `null` when the enumeration FAILED, never `[]`.** The two are opposite facts and
 *  collapsing them is the exact silence `packagedAppPaths.mjs` already had to remove (#944): its
 *  win32 reap documents that `powershell -Command` exits 1 on a terminating error — WMI
 *  unavailable, access denied, a `Get-CimInstance` failure — and decodes that as `REAP_ERROR`
 *  rather than "nothing running". This module's one caller deletes things, so an empty list read
 *  as "nothing is live" wipes `%APPDATA%\\Modoki Editor` under a live editor on any box where the
 *  query cannot run. An earlier version of this file said "the caller decides what an empty answer
 *  means"; there is one caller and it could not. */
export function listProcesses(platform = process.platform) {
  try {
    if (platform === 'win32') {
      const script = 'Get-CimInstance Win32_Process | ForEach-Object { '
        + '"$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }';
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      return outputLines(out).map((line) => {
        const [pid, exe, ...rest] = line.split('\t');
        return { pid: Number(pid), exe: exe ?? '', command: rest.join('\t') };
      // ⚠️ A row with NO `ExecutablePath` is one this user cannot open — unknown, not "not an
      // editor". Dropping it silently is the same fail-open as swallowing the query error above,
      // so it is kept with an empty `exe`; `isPackagedExecutable` then returns false for it, which
      // is the honest answer, and the row still counts toward "we enumerated something".
      }).filter((r) => Number.isFinite(r.pid));
    }
    // ⚠️ `-Ao`, NOT `-Axo`, on BOTH queries. `x` is BSD-style and Linux procps refuses to combine
    // it with UNIX-style `-A` (`error: must set personality to get -x option`), which threw here
    // and reddened the public ubuntu leg while every Mac gate stayed green. `x` buys nothing on
    // macOS either: it only lifts the must-have-a-tty restriction that `-A` has already lifted —
    // measured, the pid sets differ only by process churn between the two calls, symmetrically.
    // ⚠️ `maxBuffer`, following #1120's rule for git reads — the mechanism is identical here.
    // Node's default is 1 MiB and `pid=,command=` carries FULL argv: measured on this Mac, 874
    // processes render ~87 KB for `comm=`, but a machine with long command lines is the same
    // distance from the cap as Court's scene was. The sibling `stopDevServer.mjs` has been bounded
    // all along, so this was the inconsistent one.
    //
    // ⚠️ NOT the same severity as #1120's sites, and the difference is worth stating: overflow
    // throws, the `catch` below answers `null`, and `null` means "could not ASK" — which this
    // module's caller must not read as "nothing is running". So it fails SAFE (the packaged smoke
    // refuses rather than deleting a live editor's state); what it loses is the CAUSE, reported as
    // "could not enumerate" when the truth is "the output outgrew the pipe".
    const exeOut = execFileSync('ps', ['-Ao', 'pid=,comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
    const cmdOut = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
    return joinPidColumns(exeOut, cmdOut);
  } catch {
    return null; // could not ASK — not the same as "nothing is running"
  }
}

/** Two `ps -Ao pid=,<col>=` captures joined by pid → `[{ pid, exe, command }]`.
 *
 *  Exported and PURE so a CRLF fixture can reach it: `listProcesses` above execs `ps` twice, so
 *  nothing could test this join before (#1118). A pid present in the `comm=` capture but absent
 *  from `command=` keeps an empty `command` rather than being dropped — the two calls are separate
 *  `ps` invocations, so process churn between them is normal and a missing column is not a reason
 *  to forget the pid exists. */
export function joinPidColumns(exeOut, cmdOut) {
  const commands = new Map();
  for (const { pid, rest } of parsePidRows(cmdOut)) commands.set(pid, rest);
  return parsePidRows(exeOut).map(({ pid, rest }) => ({ pid, exe: rest, command: commands.get(pid) ?? '' }));
}

/** The question the CLI actually asks. See the module header.
 *
 *  @returns the blocking rows, or `null` when the process table could not be READ — which the
 *  caller must not treat as "nothing is running". */
export function findBlockingEditors({
  productName, candidates, defaultUserData, platform = process.platform,
  sharedStatePaths = [], stagingRoots = [],
}) {
  const rows = listProcesses(platform);
  if (rows === null) return null;
  return blockingEditors(rows, { productName, candidates, defaultUserData, platform, sharedStatePaths, stagingRoots });
}
