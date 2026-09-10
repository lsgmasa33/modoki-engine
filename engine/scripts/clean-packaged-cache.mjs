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
 *  Refuses to run while a packaged instance is alive IN THE STATE IT WOULD DELETE (its Chromium
 *  profile is open — deleting under it corrupts rather than cleans) unless `--force` is passed to
 *  kill it first. The predicate is `livePackagedEditor.mjs`; read its header before touching it,
 *  because the obvious spelling of this check is the one that was wrong (#1037). Two properties
 *  worth knowing here: **`--dry-run` never consults it** (a report-only run deletes nothing, so
 *  liveness cannot change its answer), and a sibling clone's packaged smoke running out of its own
 *  temp dir is deliberately NOT a blocker.
 *
 *  ⚠️ **KNOWN GAP: `--toolchain` does not check for a live DEV editor** (owner, 2026-09-10, asked
 *  and declined). The toolchain is shared between dev and packaged, so a `--toolchain` wipe can
 *  proceed with a dev editor running and this guard reporting all clear. Left as a gap on purpose
 *  rather than guarded: **nobody has established that a toolchain wipe actually breaks a running
 *  dev editor** — `ensureNode`/`ensureJdk` resolve at build time, not continuously — and a guard
 *  against an unobserved failure would be the third refusal in this script defended by reasoning
 *  rather than measurement. If you see a dev editor break this way, that observation is the thing
 *  that should motivate the fix; record it before writing one.
 *
 *  Also refuses — on every platform, `--dry-run` included, and BEFORE the `--force` kill above —
 *  when a candidate's subtree is not SELF-CONTAINED, because `rmSync` acts on names rather than
 *  data and its report is then wrong in one of two directions: it severs a link out of the subtree
 *  (payload orphaned, success reported — #883, #990) or recurses INTO a mounted volume (contents
 *  deleted, then a failure part-way — #989). The walk is `deleteBoundary.mjs`, shared with
 *  `engine/toolchain/index.ts`'s `forceRemoveDir` so both delete sites refuse alike (#1004).
 *  See `linkedTargets()` for the ONE exemption this script adds on top.
 *
 *  Usage:
 *    node engine/scripts/clean-packaged-cache.mjs                  # dry-run-safe subset (default = REAL delete, see flags)
 *    node engine/scripts/clean-packaged-cache.mjs --dry-run         # report only, delete nothing
 *    node engine/scripts/clean-packaged-cache.mjs --toolchain       # also wipe the provisioned JDK/Android SDK/toktx (multi-GB re-download)
 *                                                                   # honours MODOKI_TOOLCHAIN_DIR — wipes the override AND the default
 *    node engine/scripts/clean-packaged-cache.mjs --force           # kill a running packaged instance first instead of aborting
 *    node engine/scripts/clean-packaged-cache.mjs --eject-volumes   # (macOS) eject stale mounted "<productName> *" DMG volumes
 */

import { existsSync, readFileSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { productName, killPackaged, REAP_ERROR, appSupportRoot, defaultToolchainDir, packagedUserData } from './packagedAppPaths.mjs';
// The ONE 'same directory?' comparison (#869).
import { samePath } from './pathIdentity.mjs';
// The ONE 'would a recursive delete misreport this subtree?' walk (#990/#989/#1004).
import { findDeleteBoundaries, describeBoundary } from './deleteBoundary.mjs';
// The ONE 'does this look like a toolchain root?' check, shared with toolchain/index.ts (#1005).
import { toolchainRootRefusal, describeToolchainRootRefusal } from './toolchainRoot.mjs';
// The ONE 'is a packaged editor living in what I am about to delete?' check (#1037).
import { findBlockingEditors, sharedStatePaths, stagingRoots } from './livePackagedEditor.mjs';

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
        // ⚠️ Flagged because the CONTENTS check below applies to these and to NOTHING else (#1005).
        // The other candidates (userData, the Chromium cache, the install dir) are not toolchain
        // roots at all, so asking "does this look like a toolchain?" of them would be a category
        // error — a userData dir legitimately holds anything.
        //
        // ⚠️ The flag is on BOTH entries in this block, `defaultToolchainDir()` included, and that
        // is deliberate even though only the override is a user-supplied free path. The question
        // the check asks is "is this a toolchain root?", which is fair to ask of the default too —
        // it can hold a stale or foreign tree — and with MODOKI_TOOLCHAIN_DIR unset the default is
        // the ONLY toolchain candidate, so scoping the flag to the override would switch the guard
        // off entirely in the commonest configuration. (An earlier version of this comment
        // justified the flag by "a user-supplied free path", which was not true of the code it
        // annotated — close-out review.)
        toolchainRoot: true,
        reason: 'provisioned JDK/Android SDK/toktx/msdf-atlas-gen — MULTI-GB RE-DOWNLOAD'
          + (!samePath(resolved, dflt) ? ' [MODOKI_TOOLCHAIN_DIR]' : ''),
      });
    }
  }
  return list;
}

/** Packaged instances LIVING IN the state this run would delete — see `livePackagedEditor.mjs`
 *  for why the question is about the targets and the executable rather than about a NAME in argv.
 *
 *  ⚠️ Candidates are recomputed per call, not captured: the `--force` path calls this again after
 *  the reap, and between the two calls the only thing that may have changed is which processes are
 *  alive. Recomputing keeps the two answers about the same set of paths. */
function blockingEditors() {
  return findBlockingEditors({
    productName: NAME,
    candidates: targets().map((t) => t.p),
    // Both from `livePackagedEditor.mjs`, not re-derived here: a second spelling of the
    // bundle-id-keyed list is the shadowing shape this file already fixed once, and it would go
    // stale the day a name-keyed candidate is added to `targets()` alone.
    sharedStatePaths: sharedStatePaths(id, NAME),
    stagingRoots: stagingRoots(),
    // `packagedUserData()`, not a second spelling of it (close-out review): this file already
    // imports the module that owns where packaged state lives, and a hand-re-derivation here would
    // keep checking the old location the day that moves — the guard then silently stops blocking.
    defaultUserData: packagedUserData(),
  });
}

function describeBlockers(blockers) {
  return blockers
    .map((b) => `  pid ${b.pid} — ${b.exe}\n      using ${b.userData}`)
    .join('\n');
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
// ⚠️ **The gap this closes is the SECOND half of #1005, and it was an asymmetry, not an oversight.**
// `uninstallAll()` guarded its toolchain delete (by the wrong property — the NAME — which is what
// #1005 reports); this script guarded its identical delete by NOTHING. `deleteBoundary.mjs`'s own
// comment records the shape: a filesystem root handed in as MODOKI_TOOLCHAIN_DIR was covered at the
// toolchain site because `basename !== 'toolchain'` happened to reject it, and "nothing covered the
// cache-cleaner one". Roots are handled now (the walk reports them as a mount), but the ordinary
// case never was: MODOKI_TOOLCHAIN_DIR pointed at a home directory or a repo root is a plain,
// self-contained directory, so no boundary exists and this script would recursively delete it and
// report success.
//
// It runs BEFORE the boundary refusal deliberately: this is the cheaper and more certain answer
// (one `readdir`, no walk), and a human who has aimed the variable at the wrong place should be
// told THAT rather than a link diagnostic about a directory they never meant to hand over.
const notToolchains = targets()
  .filter((t) => t.toolchainRoot)
  .map((t) => ({ ...t, refusal: toolchainRootRefusal(t.p) }))
  .filter((t) => t.refusal !== null);
if (notToolchains.length > 0) {
  console.error(
    `[clean-packaged-cache] REFUSING to run: ${notToolchains.length} toolchain candidate(s) are not`
    + '\n  a Modoki toolchain root. This script deletes them RECURSIVELY, so it stops rather than'
    + '\n  act on a directory that is probably not ours.',
  );
  // ⚠️ One shared wording with `uninstallAll`, so the two delete sites cannot describe the same
  // refusal two ways — and so neither can drift into telling a user to hand-delete the directory
  // it has just refused to touch. `deleteBoundary.mjs` records what that costs (#883's remedy text
  // "lost a user their provision AND left them still blocked").
  for (const { p, refusal } of notToolchains) {
    console.error(`\n  ${describeToolchainRootRefusal(p, refusal)}`);
  }
  process.exit(1);
}

const linked = linkedTargets();
if (linked.length > 0) {
  // ⚠️ The header must not claim more than every entry establishes. It used to say "are links",
  // which was already wrong for the UNREADABLE ones (EACCES/EPERM/ELOOP — not known to be links)
  // and is wrong again for MOUNTS. The per-entry lines carry the distinction, but the header is
  // what a reader acts on first.
  const kinds = new Set(linked.map(({ boundary }) => boundary.kind));
  console.error(
    `[clean-packaged-cache] REFUSING to run: ${linked.length} boundary(ies) would make this run\n`
    + '  misreport what it deleted. A recursive delete acts on NAMES, not data — it severs a link\n'
    + '  out of a directory (payload orphaned, success reported) and recurses INTO a mounted volume\n'
    + '  (contents deleted, then a failure part-way).',
  );
  for (const { p, reason, boundary } of linked) {
    // The candidate is named separately from the boundary, because after #990 they are often not
    // the same path: the entry the human recognises is the candidate, the thing that has to be
    // dealt with is the boundary, and a message giving only one of them is unactionable.
    const where = boundary.path === p ? '' : `\n    (found inside ${p})`;
    console.error(`\n  ${describeBoundary(boundary)}${where}\n    (${reason})`);
  }
  // ⚠️ **Remedy order matters, and an earlier version had it backwards.** "Delete the target by
  // hand" was listed FIRST and does not clear the refusal: delete the target and the link DANGLES,
  // `isSymbolicLink()` is still true, and the next run refuses again — now labelled DANGLING. A
  // user following the leading advice has hand-deleted a multi-GB provision AND still cannot run
  // the script. Removing the link is the step that actually unblocks it, so it goes first.
  if (kinds.has('link')) {
    console.error(
      '\nFor a LINK: REMOVE THE LINK ITSELF (that alone clears this refusal — it deletes no payload),'
      + '\nor replace it with a real directory. Deleting only what it points at leaves a dangling link'
      + '\nand this same refusal.',
    );
  }
  // ⚠️ A mount needs its OWN remedy and must never inherit the link one (#989). "Remove the link"
  // is not a thing you can do to a mounted volume, and a reader who tries will either fail or —
  // worse — unmount and then hand the delete the empty directory underneath.
  if (kinds.has('mount')) {
    console.error(
      '\nFor a MOUNTED VOLUME: point the setting somewhere else (MODOKI_TOOLCHAIN_DIR is the one'
      + '\nthat is meant to be redirected), or unmount the volume from that path. Do NOT delete its'
      + '\ncontents by hand to get past this — that is the outcome the refusal exists to prevent.',
    );
  }
  if (kinds.has('unreadable')) {
    console.error(
      '\nFor a path that CANNOT BE READ: nothing is being claimed about it — the run stops because'
      + '\nsomething unreadable must never authorise deleting something else. Fix the permission, or'
      + '\nremove the path by hand once you have looked at what it is.',
    );
  }
  process.exit(1);
}

// ⚠️ **A dry run never consults this at all** (#1037). Liveness decides whether DELETING is safe,
// and a dry run deletes nothing — the old order asked the question first and refused a report-only
// run on the strength of it, which is most of what made this guard fire when it had no business
// firing. `--dry-run`'s job is to answer "what would this do", and a live editor does not change
// that answer.
const blockers = DRY_RUN ? [] : blockingEditors();
// ⚠️ `null` is "the process table could not be READ", which is not "nothing is running" — see
// `livePackagedEditor.mjs`. Refusing is the only safe reading: this script's next act is a
// recursive delete of an app's state.
if (blockers === null) {
  console.error(
    `[clean-packaged-cache] refusing to continue: could not read the process table, so it is `
    + `unknown whether "${NAME}" is running. Deleting its state while it is live corrupts rather `
    + 'than cleans. Re-run once the process list is readable, or quit the editor and pass --force.',
  );
  process.exit(1);
}
if (blockers.length > 0) {
  if (!FORCE) {
    console.error(
      `[clean-packaged-cache] "${NAME}" is currently running out of the state this would delete `
      + `— quit it first, or re-run with --force to kill it:\n${describeBlockers(blockers)}`,
    );
    process.exit(1);
  }
  console.log(`[clean-packaged-cache] killing running "${NAME}"…`);
  {
    // No `if (!DRY_RUN)` here any more (close-out review): a dry run now short-circuits the
    // liveness check entirely above, so this branch was unreachable with DRY_RUN true and the
    // condition read as a guard that could still fire. ⚠️ The visible consequence is that
    // `--dry-run --force` says NOTHING about a live editor — it is a report of what would be
    // deleted, and liveness does not change that report.
    // ⚠️ **The reap's outcome decides whether the wipe below is safe, so it must not be
    // discarded** (close-out review of #944/#959). We are on this branch because
    // `blockingEditors()` was non-empty; if the reap then fails to run at all, the `rmSync` below
    // deletes this app's userData WHILE IT IS LIVE — which this file's own header calls
    // "corrupts rather than cleans", the exact outcome the running-check exists to prevent.
    const outcome = killPackaged();
    // Re-ask the question rather than trusting the verdict alone: `REAP_KILLED` means a signal
    // was delivered, not that the process is gone yet, and a `--force` run that proceeds into
    // the wipe a beat too early has the same consequence as one that never killed anything.
    // `Atomics.wait`, not `execFileSync('sleep')` — Windows has no `sleep`, and this script is
    // the one that runs there too. ⚠️ **Up to ~3.5s, not the 2s this said** (close-out review):
    // 20 naps of 100ms PLUS 21 evaluations of the predicate, and each of those spawns two `ps`
    // processes — measured at ~70ms per call on an 841-row machine. The number is stated because a
    // wrong one here reads as a timeout budget somebody may rely on.
    const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    for (let i = 0; i < 20 && (blockingEditors()?.length ?? 1) > 0; i += 1) nap();
    // ⚠️ **Two different facts, and only one of them justifies refusing.** An earlier version
    // OR'd them and then printed "is STILL RUNNING" — stating as fact something the line above
    // had just measured to be false (a box with no `pkill` gives REAP_ERROR; if the human quits
    // the editor during the wait, the app is gone and the message is a lie). The measurement
    // wins: what makes the wipe unsafe is the app being ALIVE, not the reap's verdict.
    // `?? 1` again: an unreadable process table after the reap is not proof the app is gone.
    const after = blockingEditors();
    if (after === null) {
      console.error(
        `[clean-packaged-cache] refusing to continue: the process table became unreadable after the`
        + ` reap, so whether "${NAME}" is still running is UNKNOWN. Wiping its userData now would`
        + ' corrupt a live app rather than clean it.',
      );
      process.exit(1);
    }
    if (after.length > 0) {
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

/** Every boundary, at or inside a candidate, that would make this run misreport what it deleted —
 *  as `{ p, reason, boundary }`, where `p` is the CANDIDATE (the entry a human recognises) and
 *  `boundary.path` is the thing that has to be dealt with. After #990 those are frequently not the
 *  same path.
 *
 *  The walk itself lives in `deleteBoundary.mjs` and is shared with `engine/toolchain/index.ts`'s
 *  `forceRemoveDir` (#1004); its docblock carries the mechanism, the accept side (a nested link
 *  resolving INSIDE the subtree is fine — npm's `.bin` shims), and the measured blind spots. This
 *  function adds exactly ONE thing on top: the exemption below, which is specific to this script's
 *  candidate list and must not migrate into the shared walk.
 *
 *  ⚠️ **Why the previous predicate is gone, so it does not come back.** It `lstat`ed the FINAL
 *  COMPONENT of each candidate and asked only "is it a symlink?". That was correct for what it
 *  covered and is preserved as the walk's depth-0 case — but it was one point in a three-axis
 *  space, and it missed a link NESTED below the final component (#990) and a MOUNT POINT, which
 *  `lstat` does not report as a link at all (#989).
 *
 *  ⚠️ **The `realpathSync(p) !== p` predicate stays REJECTED, and the walk does not use it.** That
 *  comparison is true whenever ANY component is aliased — measured on macOS 26.5 for `/tmp` and
 *  `os.tmpdir()`, because `/var`, `/tmp` and `/etc` are themselves symlinks into `/private` — so it
 *  refuses on a clean machine for a reason unrelated to this defect. What the walk does at depth 0
 *  instead is resolve the PARENT and re-append the component, which is ancestor-INSENSITIVE and so
 *  is not that predicate wearing a different name. See `deleteBoundary.mjs`.
 *
 *  ⚠️ **A Finder alias is still not covered, and deliberately.** It is a regular file carrying
 *  resolution metadata (`isSymbolicLink()` false, `isFile()` true, ~1 KB); `rmSync` deletes it and
 *  the payload survives — #883's symptom through a shape `lstat` cannot see. An earlier note here
 *  speculated that #989's fix would subsume it via a per-target expected-KIND check. **It does
 *  not, and that was not taken**: an expected-kind rule has to carve out the row that legitimately
 *  IS a file (`<id>.plist`), and nothing writes an alias to these paths — one gets there only by
 *  hand, and the failure is the benign direction. Recorded, not defended against.
 *
 *  ⚠️ **This runs BEFORE `existsSync`, and that ordering is load-bearing.** `existsSync` FOLLOWS
 *  links, so a DANGLING candidate reports absent and the delete loop's own skip would drop it in
 *  silence — the same fail-open shape as the rest of this family. The walk `lstat`s, so it sees
 *  one. (Measured: `existsSync(dangling)` false, `lstatSync(dangling)` succeeds,
 *  `realpathSync(dangling)` throws ENOENT — so a catch-and-return-false resolver would fail open
 *  here too.) Note the asymmetry that follows, because it looks like an inconsistency and is not:
 *  a dangling candidate is REPORTED, while a dangling link nested inside one is allowed — it points
 *  at nothing, so severing it orphans nothing.
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
    // ⚠️ **The walk is the SSOT (`deleteBoundary.mjs`), and it answers more than this function used
    // to.** It used to `lstat` the FINAL COMPONENT of each candidate and ask only "is it a
    // symlink?" — one point in a three-axis space. The walk covers the other two: a link NESTED
    // below the final component (#990) and a MOUNT POINT, which `lstat` does not report as a link
    // at all (#989). `engine/toolchain/index.ts`'s `forceRemoveDir` calls the same walk (#1004), so
    // the two recursive-delete sites in this repo now refuse on the same inputs for the same
    // reasons — which is the whole point of moving it out of here.
    for (const b of findDeleteBoundaries(p)) {
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
      //
      // ⚠️ **Scoped to the CANDIDATE ITSELF (`b.path === p`), never to a nested finding.** The
      // rescue is about `targets()`' own dedupe listing a link and its target as two entries, so
      // the payload is deleted via the other entry. A link buried inside a candidate has no such
      // second entry — exempting it would hand back exactly the orphan #990 is about. And a MOUNT
      // is never exempt on any of these grounds: no other candidate's `rmSync` deletes a volume,
      // and we would not want one that did.
      if (b.kind === 'link' && b.path === p && b.target !== null
        && all.some((c) => c.p !== p && isExistingNonLink(c.p) && samePath(c.p, b.target))) continue;

      out.push({ p, reason, boundary: b });
    }
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
