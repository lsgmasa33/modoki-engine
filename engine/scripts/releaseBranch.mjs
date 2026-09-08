/**
 * The release-branch convention, and the preconditions for publishing a release snapshot (#904).
 *
 * A release is cut on a dedicated hub branch — `release_0_7_0` for version `0.7.0` — rather than
 * on `main`. The reason is measurement, not tidiness: 1,722 commits landed on `main` in the ten
 * days after `release/v0.6.0` was tagged, five clones push continuously, and the release ritual
 * (`.claude/skills/release-version/SKILL.md`) spans `verify:all`, an RC artifact build and packaged
 * QA with a Windows hard-stop handoff. Its own § 4b says "any commit after this step invalidates
 * 4b AND 4c". Without a branch, the tree that gets tagged is not the tree that was tested.
 *
 * ⚠️ **Why the clean-tree check is load-bearing rather than hygiene.**
 * `scripts/publish-engine-oss.sh` builds its file LIST from `git ls-files` — tracked files only,
 * which is the fail-safe its own header describes — and then `rsync`s the CONTENT from the clone
 * root. So the bytes it publishes are whatever is on disk, tracked-but-modified included. The
 * branch names which commit a release claims to be; only this check makes that claim true.
 *
 * ⚠️ **Untracked files are not "dirty" — EXCEPT under `oss/`, and that exception is the whole
 * subtlety.** Step 1 of the publisher copies `rsync --files-from=<manifest>`, so an untracked file
 * anywhere else provably cannot ship and refusing a release for a stray scratch file would be
 * wrong. But step 2's overlay is `rsync -a "$HERE/oss/.github/" "$STAGE/.github/"` — a
 * DIRECTORY-wide working-tree copy with no manifest filter. So an untracked file under `oss/`
 * (a `ci.yml.orig` left by a conflict, a workflow an agent drafted and never committed) ships
 * into the public mirror permanently, and the safety scan has no rule for the two classes most
 * likely to be in a stray workflow (the Apple Team ID and the internal `gs://` bucket — see the
 * publisher's own header).
 *
 * An earlier version of this file claimed untracked files "cannot reach the snapshot at all". That
 * was false, and it was asserted in four places including the NAME of a test that could not fail.
 *
 * This module is the single source of truth for the name and the preconditions, imported by both
 * the shell publisher (via the CLI mode at the bottom) and its test. It lives under
 * `engine/scripts/` rather than `scripts/` on purpose: `engine/` ships in the OSS snapshot, so a
 * test importing it compiles there, and no entry has to be added to the publisher's
 * exclusion chain (which `engine/tests/assets/publishExclusions.test.ts` parses textually).
 */

// #910: the ONE "was this module run directly?" check. Same directory, so it ships in the OSS
// snapshot alongside this file and adds no entry to the publisher's exclusion chain.
import { isEntryPoint } from './entryPoint.mjs';

/**
 * `0.7.0` → `release_0_7_0`.
 *
 * Underscores, not `release/0.7.0`, and this is not a style choice: `release/v*` is already the
 * private repo's annotated-TAG namespace (14 of them, `release/v0.2.28` … `release/v0.6.0`). A
 * branch spelled `release/0.7.0` sitting beside those tags makes every `git checkout release/…`
 * ambiguous to a reader, even where git itself resolves it (refs/heads vs refs/tags).
 */
export function releaseBranchFor(version) {
  const parsed = parseReleaseVersion(version);
  if (!parsed.ok) return null;
  return `release_${parsed.major}_${parsed.minor}_${parsed.patch}`;
}

/**
 * The `wip/*` claim label for a branch — `docs/task-claiming.md`'s branch→label mapping, as code.
 *
 * The mapping is identity for the six clone branches, and **`release_*` maps to `wip/main`**: a
 * release branch is the hub wearing a different hat, not a seventh clone. This exists because
 * `wip/$(git branch --show-current)` was pasted into two skills and three places in the doc, and on
 * a release branch every one of them creates `wip/release_0_7_0` — a label `gh` mints silently on
 * first use, and which is absent from that doc's own not-claimable filter, so the issue reads as
 * UNCLAIMED to all five other clones. That is the #39 double-work scar, and it is reachable: the
 * owner's ruling is that a release-gate failure is fixed ON the release branch.
 *
 * A helper rather than a warning in each of the five places, because these are COMMANDS and a
 * command can be fixed once — the same reason `editorPorts.mjs` exists instead of five launchers
 * each deriving a port.
 */
export function claimLabelFor(branch) {
  const b = String(branch ?? '').trim();
  if (b === '') return null;
  if (/^release_/.test(b)) return 'wip/main';
  return `wip/${b}`;
}

/**
 * A release version is exactly three numeric components, none of them with a leading zero — i.e.
 * a semver core, not merely three digit-runs.
 *
 * Not pedantry: the branch name is derived by replacing `.` with `_`, so `0.7.0-rc.1` would become
 * `release_0_7_0-rc_1`. Nobody would type that, which means nobody could be *on* it, which means
 * the refusal below would fire on a version that looks perfectly ordinary. Refusing the version up
 * front says what is actually wrong. An RC is already served by the public `rc-v*` branch the
 * release skill cuts — a different mechanism, on the mirror, for building artifacts.
 */
export function parseReleaseVersion(version) {
  // `0|[1-9]\d*` per each component, not `\d+`: `1.0.010` is three digit-runs and is NOT valid
  // semver, so it would publish a public tag `v1.0.010` and an electron-updater feed no semver
  // parser can order. The reason code says `not-semver-triple`, so the regex has to actually mean
  // it — a guard whose name overstates what it enforces is worse than one that admits its scope.
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(version ?? '').trim());
  if (!m) return { ok: false, reason: 'not-semver-triple' };
  return { ok: true, major: m[1], minor: m[2], patch: m[3] };
}

/**
 * The three preconditions for publishing a release snapshot, as one verdict.
 *
 * Returns `{ ok, code, message }` rather than a boolean or a bare string, because the caller has to
 * print BOTH what it expected and what it found — "wrong branch" without the two names is a
 * message that sends someone to `git branch` to work out what the script already knew. Callers
 * branch on `.ok`; never on the verdict's truthiness, since an object and a message string are
 * both always truthy.
 *
 * @param {object} state
 * @param {string} state.version   the version being published (the snapshot's own version)
 * @param {string} state.branch    `git branch --show-current` — empty string when detached
 * @param {boolean} state.dirty    tracked files differ from HEAD (staged or unstaged)
 * @param {boolean} [state.untrackedOverlay]  untracked files exist under `oss/` — these DO ship,
 *                                            via the overlay's unfiltered directory rsync
 * @param {string} [state.manifestVersion]    the version in `package.json`, when the caller knows
 *                                            it, so an explicit `--version` that disagrees with the
 *                                            tree it is publishing can be refused
 */
export function checkReleaseState({
  version,
  branch,
  dirty,
  untrackedOverlay = false,
  manifestVersion = undefined,
}) {
  const expected = releaseBranchFor(version);
  if (expected === null) {
    return {
      ok: false,
      code: 'bad-version',
      message:
        `--release needs a plain X.Y.Z version, got "${version}".\n` +
        `  A prerelease has no release branch: "0.7.0-rc.1" would derive "release_0_7_0-rc_1".\n` +
        `  Build RC artifacts on the public rc-v* branch instead (release-version skill § 4b).`,
    };
  }

  const actual = String(branch ?? '').trim();
  if (actual === '') {
    return {
      ok: false,
      code: 'detached',
      message:
        `--release needs ${expected} checked out; HEAD is detached.\n` +
        `  A detached HEAD publishes bytes no branch names, which is what --release exists to stop.`,
    };
  }
  if (actual !== expected) {
    // ⚠️ Being on a release branch for a DIFFERENT version is not "wrong branch" — it is the
    // ordinary state between the release ritual's step 2b (cut the branch, named for the version
    // being released) and step 4 (bump package.json to it). Told "expects release_0_6_0", the
    // operator would cut a branch for the version they are LEAVING. The fix is the bump, and the
    // message has to say so: a refusal that misdirects is worse than one that only refuses.
    if (/^release_(0|[1-9]\d*)_(0|[1-9]\d*)_(0|[1-9]\d*)$/.test(actual)) {
      // ⚠️ Which side is behind decides the advice, and an earlier version of this message did not
      // look: it assumed the BRANCH was always ahead and told the operator to bump. On a superseded
      // release branch (package.json already past it) that advice moves them further from a valid
      // state, and it said "do NOT cut release_0_7_1" while release_0_7_1 was the correct branch —
      // the same misdirection this whole case was added to remove, mirrored.
      const [, bMaj, bMin, bPat] = /^release_(\d+)_(\d+)_(\d+)$/.exec(actual);
      const branchVer = `${bMaj}.${bMin}.${bPat}`;
      const br = [bMaj, bMin, bPat].map(Number);
      const pkg = String(version).split('.').map(Number);
      // First component that differs decides the order — the branch name and the version are both
      // known-good triples by this point (the regex above, and parseReleaseVersion earlier).
      const d = br.findIndex((n, i) => n !== pkg[i]);
      const branchIsAhead = d !== -1 && br[d] > pkg[d];
      // ⚠️ Do NOT offer "pass --version to match the branch". The only real caller always passes
      // --manifest-version too, so that lands on `version-mismatch`, whose own advice is "drop
      // --version" — back here. Measured: a two-cycle with no exit. Only the bump escapes.
      return {
        ok: false,
        code: 'branch-version-skew',
        message: branchIsAhead
          ? `--release: you are on ${actual} but package.json still says ${version}.\n` +
            `  That is the gap between cutting the branch and bumping the version.\n` +
            `  Bump package.json to ${branchVer} (release-version skill § 4), then re-run.\n` +
            `  Nothing else escapes this state: --version alone lands on version-mismatch.`
          : `--release: you are on ${actual} but package.json is already at ${version}.\n` +
            `  This branch is BEHIND — ${version} was bumped or released after it was cut, so\n` +
            `  ${actual} is a superseded release branch, not the one being cut.\n` +
            `  Check out the branch for ${version} (${expected}), or cut it per § 2b.`,
      };
    }
    return {
      ok: false,
      code: 'wrong-branch',
      message:
        `--release expects ${expected} (from version ${version}); on ${actual}.\n` +
        `  Release branches are cut by the HUB, from main — see release-version skill § 2b, which\n` +
        `  handles a fresh cut and a resume, and knows which of the two this is.\n` +
        `  ⚠️ Do NOT cut ${expected} from here. A release branch created on top of another\n` +
        `  branch's work satisfies every check below, so --push would publish THAT work as\n` +
        `  v${version} and force-move the public tag.\n` +
        `  Dropping --release does not help either: --push alone does all of that with no checks.`,
    };
  }

  // Last, deliberately: being on the wrong branch is the more useful thing to be told first, and a
  // dirty tree on the wrong branch would otherwise report the dirt and hide the branch.
  if (dirty) {
    return {
      ok: false,
      code: 'dirty',
      message:
        `--release needs a clean tree on ${expected}; tracked files differ from HEAD.\n` +
        `  The publisher rsyncs CONTENT from the working tree (only the file LIST comes from git),\n` +
        `  so an uncommitted edit would ship inside a snapshot that claims to be this commit.\n` +
        `  Commit it (or stash it) and re-run. Untracked files elsewhere are fine; untracked files\n` +
        `  under oss/ are NOT, and are reported separately.`,
    };
  }

  if (untrackedOverlay) {
    return {
      ok: false,
      code: 'untracked-overlay',
      message:
        `--release found UNTRACKED files under oss/ on ${expected}.\n` +
        `  Unlike the rest of the tree, these DO ship: the overlay step is an unfiltered\n` +
        `  \`rsync -a oss/.github/ <stage>/.github/\`, not a manifest copy — so a stray .orig or an\n` +
        `  uncommitted workflow would be published to the public mirror permanently.\n` +
        `  Commit or delete them. (Untracked files ELSEWHERE are fine and are not checked.)`,
    };
  }

  // Last: the snapshot's version comes from package.json unless --version overrides it, and the
  // override is the one way to publish a tag that disagrees with the tree it contains. An installed
  // app would then report a version the update feed does not advertise.
  if (manifestVersion !== undefined && String(manifestVersion).trim() !== String(version).trim()) {
    return {
      ok: false,
      code: 'version-mismatch',
      message:
        `--release: --version ${version} disagrees with package.json (${manifestVersion}).\n` +
        `  The snapshot would carry ${manifestVersion} and be tagged v${version}, so the update\n` +
        `  feed advertises a version the installed app does not report.\n` +
        `  Bump package.json first (release-version skill § 4), or drop --version.`,
    };
  }

  return { ok: true, code: 'ok', message: `${expected} clean — publishing v${version} from it` };
}

// ── CLI: `node engine/scripts/releaseBranch.mjs check --version X.Y.Z --branch NAME [--dirty]` ────
// Used by scripts/publish-engine-oss.sh. Exits 0 and prints the ok message, or exits 2 and prints
// the refusal on stderr — so the shell can `|| exit 2` without re-deriving anything.
// `--branch-for X.Y.Z` prints just the branch name, for messages and for the release ritual.
//
// ⚠️ **The entry check is `isEntryPoint` (#910) — never a hand-rolled compare, and never the
// `import.meta.url === `file://${process.argv[1]}`` template this file used to carry.** That
// template is unequal on win32 by construction, so the CLI block never ran and node exited **0**;
// `publish-engine-oss.sh` does `node releaseBranch.mjs check … || exit 2`, so exit 0 meant the
// branch check, the clean-tree check, the skew check and the version cross-check were ALL silently
// skipped and `--release` published anyway — a guard failing OPEN on the one platform CLAUDE.md
// says cannot be diagnosed from a Mac. Found by the public `ci/main` windows-latest leg (#904), not
// locally. The symlink variant of the same defect IS reachable on darwin and is pinned below.
if (isEntryPoint(import.meta.url)) {
  // Top-level await is fine here: this file is an ES module.
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };

  if (argv.includes('--claim-label')) {
    // Reads the branch itself rather than taking one, so the call site stays a one-liner that
    // cannot be pasted with the wrong branch. `git` failing yields '' -> exit 2, never a bad label.
    const { execFileSync } = await import('node:child_process');
    let branch = '';
    try {
      branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
    } catch {
      // Leave it '' — `claimLabelFor('')` is null, which exits 2 below. git failing and git
      // reporting no branch are the same answer here: we cannot name a claim label.
    }
    const label = claimLabelFor(branch);
    if (label === null) {
      process.stderr.write('cannot derive a claim label: no branch checked out (detached HEAD?)\n');
      process.exit(2);
    }
    process.stdout.write(`${label}\n`);
    process.exit(0);
  }

  const branchFor = flag('--branch-for');
  if (argv.includes('--branch-for') && branchFor === undefined) {
    // Otherwise it fell through to `check` and complained about --version, a flag nobody passed.
    process.stderr.write('--branch-for needs a version argument\n');
    process.exit(2);
  }
  if (branchFor !== undefined) {
    const name = releaseBranchFor(branchFor);
    if (name === null) {
      process.stderr.write(`not a plain X.Y.Z version: ${branchFor}\n`);
      process.exit(2);
    }
    process.stdout.write(`${name}\n`);
    process.exit(0);
  }

  const verdict = checkReleaseState({
    version: flag('--version'),
    branch: flag('--branch') ?? '',
    dirty: argv.includes('--dirty'),
    untrackedOverlay: argv.includes('--untracked-overlay'),
    manifestVersion: flag('--manifest-version'),
  });
  if (verdict.ok) {
    process.stdout.write(`${verdict.message}\n`);
    process.exit(0);
  }
  process.stderr.write(`✖ ${verdict.message}\n`);
  process.exit(2);
}
