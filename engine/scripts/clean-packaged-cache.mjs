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
 *  Also refuses — on every platform, `--dry-run` included, and BEFORE the `--force` kill above —
 *  when a candidate is ITSELF a link (junction or symlink): `rmSync` would remove the link and
 *  leave the payload, so the run would report a wipe that did not happen (#883). ⚠️ That is the
 *  FINAL COMPONENT of a listed candidate only, not a tree walk — a link NESTED inside a candidate
 *  reproduces #883 and is not caught here (#990). See `linkedTargets()`.
 *
 *  Usage:
 *    node engine/scripts/clean-packaged-cache.mjs                  # dry-run-safe subset (default = REAL delete, see flags)
 *    node engine/scripts/clean-packaged-cache.mjs --dry-run         # report only, delete nothing
 *    node engine/scripts/clean-packaged-cache.mjs --toolchain       # also wipe the provisioned JDK/Android SDK/toktx (multi-GB re-download)
 *                                                                   # honours MODOKI_TOOLCHAIN_DIR — wipes the override AND the default
 *    node engine/scripts/clean-packaged-cache.mjs --force           # kill a running packaged instance first instead of aborting
 *    node engine/scripts/clean-packaged-cache.mjs --eject-volumes   # (macOS) eject stale mounted "<productName> *" DMG volumes
 */

import { existsSync, readFileSync, rmSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { productName, killPackaged, REAP_ERROR, appSupportRoot, defaultToolchainDir } from './packagedAppPaths.mjs';
// The ONE 'same directory?' comparison (#869).
import { samePath } from './pathIdentity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

const DRY_RUN = process.argv.includes('--dry-run');
const INCLUDE_TOOLCHAIN = process.argv.includes('--toolchain');
const FORCE = process.argv.includes('--force');
const EJECT_VOLUMES = process.argv.includes('--eject-volumes');

const NAME = productName(); // "Modoki Editor"

function appId() {
  const yml = readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf8');
  const m = yml.match(/^appId:\s*(.+?)\s*$/m);
  if (!m) throw new Error('[clean-packaged-cache] appId missing from electron-builder.yml');
  return m[1].replace(/^["']|["']$/g, '');
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
    for (const dir of [process.env.MODOKI_TOOLCHAIN_DIR, defaultToolchainDir()]) {
      if (!dir) continue;
      const resolved = path.resolve(dir);
      const dflt = defaultToolchainDir();
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
      // This block rescues one shape only: the override being a junction TO the default (the
      // default is listed separately and deleted directly). The other shape — a listed path that
      // is a junction whose target is listed nowhere, e.g. the default location itself junctioned
      // onto a bigger drive with MODOKI_TOOLCHAIN_DIR unset — is now caught downstream by
      // `linkedTargets()`, which REFUSES the run rather than reporting a wipe that did not happen
      // (#883). Note the division of labour: this dedupe keeps a link and its target BOTH on the
      // list so neither is skipped; the guard then stops the run because removing the link would
      // not remove the payload.
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
// ⚠️ **Refuse the WHOLE run; do not skip the entry, and do not follow the link** (#883, owner's
// call). `rmSync(<link>, {recursive: true, force: true})` removes the LINK and leaves the payload —
// measured on Windows (junction) and on macOS (plain directory symlink). It is a cross-platform
// bug that happened to be FOUND on Windows, so the guard is unconditional. Without it the script
// prints "[done] removed N path(s)" over an intact multi-GB provision, which is precisely the
// silent success its own header exists to prevent.
//
// The two rejected alternatives, and why: **skipping the linked entry** trades one wrong report for
// another — the run still claims to have cleaned while the largest thing on the list survives.
// **Following the link** resolves a directory the caller never named and wipes it, which is a blast
// radius this script has no mandate for (#69). So: stop, name the target, hand it to a human.
//
// ⚠️ **`--dry-run` exits non-zero too**, deliberately. A dry run's job is to answer "what would
// this do", and the honest answer under a link is "report success and delete almost nothing".
// Verified before changing the contract: the only invocation in the repo is the flagless
// `clean:packaged-cache` script in `package.json`, so no caller passes it.
const linked = linkedTargets();
if (linked.length > 0) {
  console.error(
    // ⚠️ "are links" is not what every entry establishes: one pushed from the `lstat` catch is
    // UNREADABLE (EACCES/EPERM/ELOOP) and is NOT known to be a link. Its per-entry line says so,
    // but the header is what a reader acts on first, so it must not claim more than it knows.
    `[clean-packaged-cache] REFUSING to run: ${linked.length} target path(s) are links or cannot be read.\n`
    + '  Removing a link deletes the LINK and leaves its contents behind, so this run would report\n'
    + '  success over untouched directories.',
  );
  for (const { p, reason, target, unreadable } of linked) {
    const resolved = unreadable
      ? `(CANNOT BE READ — ${unreadable}; the target may well exist)`
      : target ?? '(DANGLING — resolves to nothing)';
    console.error(`\n  ${p}\n    -> ${resolved}\n    (${reason})`);
  }
  // ⚠️ **Remedy order matters, and an earlier version had it backwards.** "Delete the target by
  // hand" was listed FIRST and does not clear the refusal: delete the target and the link DANGLES,
  // `isSymbolicLink()` is still true, and the next run refuses again — now labelled DANGLING. A
  // user following the leading advice has hand-deleted a multi-GB provision AND still cannot run
  // the script. Removing the link is the step that actually unblocks it, so it goes first.
  console.error(
    '\nTo proceed: REMOVE THE LINK ITSELF (that alone clears this refusal — it deletes no payload),'
    + '\nor replace it with a real directory. Deleting only what it points at leaves a dangling link'
    + '\nand this same refusal.',
  );
  process.exit(1);
}

if (isPackagedRunning()) {
  if (!FORCE) {
    console.error(`[clean-packaged-cache] "${NAME}" is currently running — quit it first, or re-run with --force to kill it.`);
    process.exit(1);
  }
  console.log(`[clean-packaged-cache] killing running "${NAME}"…`);
  if (!DRY_RUN) {
    // ⚠️ **The reap's outcome decides whether the wipe below is safe, so it must not be
    // discarded** (close-out review of #944/#959). We are on this branch because
    // `isPackagedRunning()` said TRUE; if the reap then fails to run at all, the `rmSync` below
    // deletes this app's userData WHILE IT IS LIVE — which this file's own header calls
    // "corrupts rather than cleans", the exact outcome the running-check exists to prevent.
    const outcome = killPackaged();
    // Re-ask the question rather than trusting the verdict alone: `REAP_KILLED` means a signal
    // was delivered, not that the process is gone yet, and a `--force` run that proceeds into
    // the wipe a beat too early has the same consequence as one that never killed anything.
    // `Atomics.wait`, not `execFileSync('sleep')` — Windows has no `sleep`, and this script is
    // the one that runs there too. Up to 2s, re-asking each 100ms.
    const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    for (let i = 0; i < 20 && isPackagedRunning(); i += 1) nap();
    // ⚠️ **Two different facts, and only one of them justifies refusing.** An earlier version
    // OR'd them and then printed "is STILL RUNNING" — stating as fact something the line above
    // had just measured to be false (a box with no `pkill` gives REAP_ERROR; if the human quits
    // the editor during the wait, the app is gone and the message is a lie). The measurement
    // wins: what makes the wipe unsafe is the app being ALIVE, not the reap's verdict.
    if (isPackagedRunning()) {
      console.error(
        `[clean-packaged-cache] refusing to continue: "${NAME}" is STILL RUNNING after the reap`
        + `${outcome === REAP_ERROR ? ' (and the reap itself failed to run)' : ''}. `
        + 'Wiping its userData now would corrupt a live app rather than clean it. Quit it by hand '
        + 'and re-run.',
      );
      process.exit(1);
    }
    if (outcome === REAP_ERROR) {
      // The reap did not run, but the app is demonstrably gone — so the wipe below is safe and
      // refusing would block a legitimate `--force`. Say it happened; do not stop.
      console.warn(`[clean-packaged-cache] the reap did not run, but "${NAME}" is no longer `
        + 'running — continuing.');
    }
  }
}

/** Every candidate whose FINAL COMPONENT is a link (POSIX symlink, or Windows junction/dir-symlink
 *  — `lstat` reports both as `isSymbolicLink()`), with the target it resolves to, or `null` when it
 *  dangles.
 *
 *  ⚠️ **`lstat` on the final component — NOT `realpathSync(p) !== p`.** That comparison answers a
 *  different question: whether ANY component of the path is aliased. Measured on macOS 26.5, it is
 *  true for `/tmp` and for `os.tmpdir()` (`/var/folders/…` → `/private/var/folders/…`), because
 *  `/var`, `/tmp` and `/etc` are themselves symlinks into `/private`. A guard written that way
 *  refuses on a clean machine the moment a candidate acquires an aliased ancestor — which is
 *  nobody's fault and has nothing to do with this defect. What decides whether the `rmSync` below
 *  does the wrong thing is whether the thing being removed IS a link, and `lstat` on the final
 *  component is exactly that question.
 *
 *  ⚠️ **This predicate is NOT a complete answer to "would `rmSync` do the wrong thing here" — it is
 *  the answer for LINKS.** Two shapes defeat it, both measured on macOS 26.5 rather than reasoned
 *  about, and neither is a reason to widen this guard:
 *    - **A Finder alias** is a regular file carrying resolution metadata: `isSymbolicLink()` false,
 *      `isFile()` true, ~1 KB. `rmSync` deletes the alias and the payload survives — #883's exact
 *      symptom through a shape `lstat` cannot see. Nothing writes an alias to these paths; one gets
 *      there only by hand, so it is recorded, not defended against.
 *    - **A mount point** (an external volume at a target path) is also `isSymbolicLink()` false, and
 *      `realpath(p) !== p` is false too, so the rejected predicate misses it as well. Its only
 *      signal is `st.dev !== lstat(dirname(p)).dev`. It is a DIFFERENT failure — `rmSync` traverses
 *      INTO the volume, deletes the contents, then throws on the mount itself — so it wants its own
 *      refusal message and is filed separately (#989) rather than folded in here. Widening a guard
 *      past what its own measurement covers is the mistake this family already made (#958 row 3).
 *
 *    ⚠️ #989's fix may SUBSUME the alias case for free. Both are "the target is not the KIND of
 *    thing we expect" — an alias is a file where a directory belongs, a mount is a volume where a
 *    directory belongs. If #989 lands as a per-target expected-kind check, the alias dies
 *    everywhere except the one row that legitimately IS a file (`<id>.plist`), where it was already
 *    negligible. Worth knowing before writing a second, narrower check.
 *
 *  ⚠️ **And it is the FINAL COMPONENT of a listed candidate, not a tree walk.** A link NESTED
 *  inside a candidate — `…\Modoki\toolchain\android-sdk` junctioned onto another drive, the same
 *  "C: is small" move one level down — reproduces #883 exactly: `rmSync` unlinks it, the payload is
 *  orphaned, and the script prints "[done] removed N path(s)". Reproduced on `win`.
 *
 *  Filed as #990 rather than fixed here, because "refuse on ANY nested link" is **not viable**, and
 *  that took both platforms to establish:
 *    - Windows: `E:\dev-cache\modoki-toolchain`, 23,303 entries, **0 symlinks** — the blunt rule
 *      would be free here.
 *    - POSIX: npm's `node_modules/.bin` shims ARE symlinks (measured on macOS: 60 of 60 entries in
 *      one `.bin`), and this toolchain installs npm tools into `MODOKI_TOOLCHAIN_DIR` —
 *      `npmToolBin` for `gltf-transform` and `gltfpack`. So a provisioned toolchain carries them,
 *      and the blunt rule would refuse on every POSIX run.
 *  ⚠️ **The Windows zero does not transfer** — it is an artifact of npm using `.cmd` shims there
 *  rather than symlinks. Taking it as the answer is exactly the mistake this clone is placed to
 *  avoid. (The POSIX side is a measured MECHANISM, not a count of a real provision: no toolchain
 *  was provisioned on the machine that measured it.) The property that actually separates an npm
 *  shim from #883's shape is whether the link's target ESCAPES the candidate subtree — which is a
 *  design, not a wider `lstat`, and it belongs to #990.
 *
 *  ⚠️ **`throwIfNoEntry: false`, and this runs BEFORE `existsSync`.** `existsSync` FOLLOWS links,
 *  so a DANGLING link reports absent and the delete loop's `if (!existsSync(p)) continue` skips it
 *  in silence — the same fail-open shape as the rest of this family. `lstat` sees it. (Measured:
 *  `existsSync(dangling)` false, `lstatSync(dangling)` succeeds, `realpathSync(dangling)` throws
 *  ENOENT — so a catch-and-return-false resolver would fail open here too. Hence the throw is
 *  caught into a REPORTED `null`, never into a skip.)
 */
/** Can this candidate's own `rmSync` be relied on to delete the payload? Only if it EXISTS and is
 *  not itself a link.
 *
 *  ⚠️ **"Not a link" is not enough, and an earlier version asked only that.** `lstat` with
 *  `throwIfNoEntry:false` returns `undefined` for an ABSENT path, so `!isLink(absent)` was `true` —
 *  and `samePath` compares through `canonicalWithMissingTail`, which is built to equate MISSING
 *  paths. A candidate that does not exist could therefore authorise an exemption and then be
 *  skipped by the delete loop, which is #883 again. Both conditions, in one predicate, so the
 *  double meaning cannot come back. A throw (EACCES/EPERM/ELOOP) means we cannot tell — and
 *  something we cannot read must never authorise deleting something else.
 *
 *  ⚠️ **The EXISTS half is defensive and its mutant is EQUIVALENT on this repo's platforms — said
 *  plainly rather than covered by a test that would pass for another reason.** Dropping it leaves
 *  all six cases green, and that is not a coverage gap: reaching it needs an ABSENT candidate whose
 *  `samePath` equals an EXISTING link target, and `samePath` folds case on win32/darwin — so on a
 *  case-INSENSITIVE volume the case-variant spelling is the same file and therefore exists. The
 *  contradiction only breaks on a case-sensitive mount (`fsutil setCaseSensitiveInfo`, WSL,
 *  case-sensitive APFS), which is #905's accepted hazard arriving at a fail-open call site
 *  `pathIdentity.mjs`'s own list of such consumers does not name. Kept because the cost is one
 *  `&&` and the failure it prevents is silent. */
function isExistingNonLink(p) {
  try {
    const st = lstatSync(p, { throwIfNoEntry: false });
    return !!st && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function linkedTargets() {
  const all = targets();
  const out = [];
  for (const { p, reason } of all) {
    // ⚠️ `throwIfNoEntry:false` suppresses ENOENT ONLY (libuv folds Windows ENOTDIR in there too —
    // a candidate under a regular file returns undefined). EACCES/EPERM/ELOOP still THROW, and an
    // unguarded throw here would abort the script with a raw stack where `existsSync` used to
    // return false and skip. Fail closed, but say which path and why — `pathIdentity.mjs`'s
    // `canonicalWithMissingTail` swallows every throw for the opposite reason and says so.
    let st;
    try {
      st = lstatSync(p, { throwIfNoEntry: false });
    } catch (e) {
      out.push({ p, reason, target: null, unreadable: e.code ?? String(e) });
      continue;
    }
    if (!st || !st.isSymbolicLink()) continue;

    let target = null;
    let unreadable = null;
    try {
      target = realpathSync.native(p);
    } catch (e) {
      // ⚠️ Only ENOENT means DANGLING. Reporting an EACCES as "resolves to nothing" is a false
      // statement about a target that exists, in the one message a human acts on.
      if (e.code !== 'ENOENT') unreadable = e.code ?? String(e);
    }

    // ⚠️ **A link whose target is ITSELF a candidate is not a defect — do not refuse on it.**
    // The shape `targets()`' raw-keyed dedupe exists to rescue: `MODOKI_TOOLCHAIN_DIR` junctioned
    // TO the default location, "an ordinary Windows move when C: is small". Both the link and the
    // real default are listed, so the payload IS deleted — via the default's own entry.
    //
    // ⚠️ **`samePath` is the WRONG tool for this, and using it re-opened #883 verbatim.** It
    // canonicalises BOTH sides through links (`canonicalWithMissingTail`), which is exactly the
    // resolution this guard exists to see through — so two candidates that are each a link to the
    // SAME target satisfied it and exempted EACH OTHER. Driven through the real CLI:
    //
    //     <base>\Modoki\toolchain -> junction -> <base>\PAYLOAD
    //     MODOKI_TOOLCHAIN_DIR    -> junction -> <base>\PAYLOAD
    //     [remove] …\override   [remove] …\Modoki\toolchain   [done] removed 2 path(s)   exit 0
    //     PAYLOAD SURVIVES: true
    //
    // That is the report this file's own header exists to prevent, produced by the fix for it.
    // Found by close-out review; the accept case built link→REAL-DIR, which cannot tell the two
    // predicates apart.
    //
    // The condition the comment always MEANT: some other candidate must BE the target **and not
    // itself be a link** — only then does that candidate's own `rmSync` delete the payload.
    if (target !== null && all.some((c) => c.p !== p && isExistingNonLink(c.p) && samePath(c.p, target))) continue;

    out.push({ p, reason, target, unreadable });
  }
  return out;
}

let removed = 0;
for (const { p, reason } of targets()) {
  // ⚠️ `existsSync` FOLLOWS links, so a DANGLING one reads as absent and is skipped — and this
  // script's own successful run is what creates that state. Measured: with the default location a
  // junction to `MODOKI_TOOLCHAIN_DIR`, the exemption lets the pair through, the loop deletes the
  // real directory first, and the junction is then dangling and skipped here. It survives, and
  // EVERY later run refuses on it — a permanent self-inflicted block, whose remedy text blames a
  // human for hand-deleting the target. `lstat` sees a dangling link, so the link is cleaned up
  // with the payload it pointed at. (Close-out review; the guard above already made this
  // distinction and the delete loop had not caught up.)
  //
  // ⚠️ Unguarded on purpose, and the reason is upstream: `throwIfNoEntry:false` suppresses ENOENT
  // only, so a candidate under a regular file (ENOTDIR on POSIX) throws here where `existsSync`
  // silently skipped. That is unreachable because `linkedTargets()` lstats the same path first and
  // REFUSES the whole run on any throw — the two calls are a matched pair, and this one is safe
  // only for as long as that one runs before it. Do not reorder them.
  if (!lstatSync(p, { throwIfNoEntry: false })) continue;
  console.log(`${DRY_RUN ? '[dry-run] would remove' : '[remove]'} ${p}\n  (${reason})`);
  if (!DRY_RUN) rmSync(p, { recursive: true, force: true });
  removed++;
}

if (EJECT_VOLUMES) ejectStaleVolumes();

if (removed === 0) {
  // Name what was CHECKED, not just that nothing was found (#944). "already clean" and "I looked
  // in the wrong places" were one line and one exit code, so a path-derivation miss reported as a
  // completed wipe. The neighbouring wrong report — a junctioned target printing "removed N
  // path(s)" with the provision intact — is now caught for a candidate that is ITSELF a link:
  // `linkedTargets()` exits 1 before this point (#883). ⚠️ It is NOT caught for a link nested
  // inside a candidate (#990), which produces the same wrong report. So the candidate list stays,
  // and it earns its place twice over: a derivation miss and a nested link both still land here.
  const checked = [...targets()].map(({ p }) => p);
  console.log(`[clean-packaged-cache] nothing found — already clean. Checked ${checked.length} path(s):`);
  for (const p of checked) console.log(`  ${p}`);
}
else console.log(`\n${DRY_RUN ? '[dry-run] would remove' : '[done] removed'} ${removed} path(s).` + (INCLUDE_TOOLCHAIN ? '' : '  (toolchain kept — pass --toolchain to also wipe it.)'));
