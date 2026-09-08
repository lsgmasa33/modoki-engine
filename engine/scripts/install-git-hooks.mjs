#!/usr/bin/env node
// Installs the tracked git hooks (engine/scripts/git-hooks/*) into the repo's
// hooks directory. Run automatically via the `prepare` npm script on install,
// or manually with `npm run hooks:install`.
//
// We copy into the git COMMON dir's hooks/, never core.hooksPath, so:
//   - the existing Git LFS hooks there keep working (we never WRITE to hooksPath — but we do READ
//     it, to warn when it makes our install inert; see cloneHooksDir),
//   - the hook is shared by every worktree off the one .git.
// No-ops quietly when there's no git dir (CI tarball, etc.) so install never fails.
//
// ⚠️ **The file git RUNS is this copy, not the tracked source — so editing
// `engine/scripts/git-hooks/*` changes nothing until this re-runs, and nothing used to say so**
// (#909). Measured on two clones the same day: both were running a `prepare-commit-msg` from before
// the `release_*` exemption was written, and a real commit came out carrying the prefix that edit
// removed. `prepare` covers the case where a dependency changed; it does NOT cover a hook source
// edited on its own, which is exactly when this bites. `verify.mjs` therefore runs this as a
// preamble — a heal, not a guard: `CLAUDE.md` records a blocking hook being declined on purpose
// ("the discipline IS the guard"), and a gate going red for another clone's machine state would be
// that argument all over again for a condition one idempotent copy fixes.
//
// ⚠️ **The heal covers an EDITED hook source, not a DELETED one.** The loop only ever adds: retire
// a source and its installed copy runs forever. Left that way on purpose — pruning means deleting
// files from a directory we share with Git LFS, on the strength of a filename.

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, copyFileSync, chmodSync, readdirSync, readFileSync, statSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

const SRC_DIR = fileURLToPath(new URL('./git-hooks/', import.meta.url));

/** Where we WRITE: this clone's own hooks dir, always.
 *
 *  ⚠️ **Deliberately NOT `git rev-parse --git-path hooks`, and a version of this file shipped that
 *  and had to be reverted the same day** (#909 close-out, second review). `--git-path hooks` is the
 *  right answer to *"where does git RUN hooks?"* and the wrong answer to *"where may we WRITE?"* —
 *  it honours `core.hooksPath`, which is typically ONE directory shared by every repo on the
 *  machine. `alreadyInstalled` returns false on any content mismatch, so the installer overwrote
 *  it. Measured, with a global `core.hooksPath` — the exact setup a pre-commit framework creates:
 *
 *      [hooks] installed prepare-commit-msg → ~/.githooks/prepare-commit-msg
 *
 *  The developer's own hook, replaced, in EVERY repo on the machine, from a `npm run verify` — no
 *  backup and one line of output. That is far worse than the staleness this was fixing. So the
 *  write target stays inside the clone, where the blast radius is our own `.git`, and the
 *  hooksPath question is answered by REPORTING instead (below).
 *
 *  Path may be relative to cwd (e.g. `.git` in the main checkout). Using the COMMON dir means a
 *  linked worktree shares the one install, and it leaves the Git LFS hooks that live beside ours
 *  untouched. */
function cloneHooksDir() {
  try {
    const common = execSync('git rev-parse --git-common-dir', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (!common) return null;
    return join(resolve(process.cwd(), common), 'hooks');
  } catch {
    return null; // not a git repo / git not on PATH — skip silently.
  }
}

/** Where git will actually LOOK. Differs from `cloneHooksDir()` only when `core.hooksPath` is set,
 *  and then our install is INERT — the hooks land where nothing reads them.
 *
 *  Reported rather than obeyed, per the docblock above. Silence here is the #909 failure mode with
 *  a second cause: every signal green, and the hook git runs is not ours. */
function gitHooksLookupDir() {
  try {
    const dir = execSync('git rev-parse --git-path hooks', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    return dir ? resolve(process.cwd(), dir) : null;
  } catch {
    return null;
  }
}

const hooksDir = cloneHooksDir();

/** ⚠️ **Two unrelated conditions, deliberately NOT sharing one message** (#944).
 *
 *  They used to: `if (!hooksDir || !existsSync(SRC_DIR))` both printed "no git hooks dir". That is
 *  wrong in the one place it matters most — `verify.mjs` runs this installer as a gate preamble and
 *  FILTERS the "no git hooks dir" line out of its output on purpose (a tarball extract or any
 *  non-git checkout would otherwise print it every single run). So a missing hook SOURCE inherited
 *  a message engineered to be invisible, inside the gate.
 *
 *  `verify`'s filter is a deny-list keyed on that exact prefix, so giving this case its own first
 *  line is all it takes to make it visible — no change to `verify.mjs` is needed. */

// Missing SOURCES is a broken checkout, not a hookless one: engine/scripts/git-hooks/* are TRACKED
// files, so their absence means this tree is wrong rather than differently shaped.
//
// ⚠️ Reported, NOT fatal — and that is load-bearing, not timidity. `prepare` (package.json) runs
// this on EVERY `npm install`, so exiting non-zero here would turn a cosmetic repo-state problem
// into an install that cannot complete — including in the public mirror. #944 asks for these
// outcomes to be *distinguishable*, and explicitly warns against making every empty set fatal.
if (!existsSync(SRC_DIR)) {
  console.error(`[hooks] hook SOURCES missing at ${SRC_DIR} — installed nothing. Tracked files are `
    + 'absent, so this checkout is incomplete; commits from it run whatever hook is already there.');
  process.exit(0);
}

if (!hooksDir) {
  console.log('[hooks] no git hooks dir — skipping hook install');
  process.exit(0);
}

mkdirSync(hooksDir, { recursive: true });

/** Is `dest` already exactly what we would write? Content AND the executable bit — a hook git
 *  cannot execute is as dead as a stale one.
 *
 *  ⚠️ **This is not an optimisation, it is what makes the installer safe to run from the GATE**
 *  (#909). `verify` now re-installs on every run, so an unconditional `console.log` per hook would
 *  put a line of noise on a gate people already scroll past — and the ONE moment that line matters
 *  (you edited a hook source and the copy git runs is behind) would be indistinguishable from the
 *  hundreds of runs where nothing changed. Reporting only a real write is what keeps it legible. */
function alreadyInstalled(src, dest) {
  if (!existsSync(dest)) return false;
  try {
    if (!readFileSync(src).equals(readFileSync(dest))) return false;
    // Windows has no executable bit to speak of; `chmod` is a no-op there and the mode read back
    // never matches, so checking it would report a rewrite on every single run.
    if (process.platform === 'win32') return true;
    return (statSync(dest).mode & 0o111) !== 0;
  } catch {
    return false; // unreadable for any reason — rewrite it rather than reason about why
  }
}

for (const name of readdirSync(SRC_DIR)) {
  const src = join(SRC_DIR, name);
  const dest = join(hooksDir, name);
  if (alreadyInstalled(src, dest)) continue;
  // ⚠️ Write-then-rename, not copy-in-place. `verify` runs this on every gate, so a rewrite can now
  // land WHILE git is executing the hook in the same clone — and `sh` reads a script incrementally,
  // so a truncate-and-refill hands it a half-file. `npm install`-only installation never had that
  // window; the heal opens it, so the heal closes it. Rename is atomic on POSIX; on win32 it can
  // refuse over a locked target, so fall back rather than fail the install.
  //
  // ⚠️ **The fallback is NOT only a win32 story, and saying so was wrong** (close-out review 2).
  // Measured on darwin: with the hooks dir at mode 500 and the hook already present, creating the
  // tmp file fails on the DIRECTORY while overwriting the existing writable FILE succeeds — so the
  // fallback runs and the install completes NON-ATOMICALLY, silently. That is the right trade
  // (installing beats refusing), but it means the rename is a best-effort narrowing of the window,
  // not a guarantee. Do not restate it as one.
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    copyFileSync(src, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, dest);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean up */ }
    copyFileSync(src, dest);
    chmodSync(dest, 0o755);
  }
  console.log(`[hooks] installed ${name} → ${dest}`);
}

// ⚠️ Loud, and deliberately NOT a failure: we will not touch a directory shared with every other
// repo on this machine, but a silent inert install is exactly #909 wearing a different cause.
const lookup = gitHooksLookupDir();
if (lookup && lookup !== hooksDir) {
  console.log(
    `[hooks] WARNING: core.hooksPath points git at ${lookup}, so the hooks installed in\n`
    + `        ${hooksDir} are INERT — git will not run them. Nothing was written to ${lookup}:\n`
    + '        that directory is likely shared with every other repo on this machine. To get the\n'
    + "        commit-message prefix, copy the hook there yourself or unset core.hooksPath.",
  );
}
