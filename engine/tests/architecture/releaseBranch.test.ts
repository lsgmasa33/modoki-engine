/** Unit + seam: the release-branch convention (#904).
 *
 *  FOUR surfaces, because the mechanism spans four files and a green test on one says nothing about
 *  the others. It said "three" once, and the surface it omitted was the one that actually decides
 *  whether a release is refused:
 *
 *  1. `engine/scripts/releaseBranch.mjs` — the derivation, the refusals and the claim-label
 *     mapping, as library calls.
 *  2. Its CLI mode — the seam `scripts/publish-engine-oss.sh` actually uses. The library being
 *     right proves nothing about the exit code the shell reads, which is the same reason
 *     `editorPortsCli.test.ts` exists beside `editorPorts.test.ts` (#349).
 *  3. **`scripts/publish-engine-oss.sh`'s own `--release` block** — which paths it gates, the
 *     argument handling, and that it refuses BEFORE assembling. The omission that mattered: while
 *     nothing pinned it, `--push` without `--release` published and force-moved the public tag.
 *  4. `engine/scripts/git-hooks/prepare-commit-msg` — driven for real in a throwaway repo, because
 *     a text-parse of the `case` would assert the source rather than the behaviour.
 *
 *  ⚠️ The ACCEPT side is tested as deliberately as the reject side. A wrong derivation, or an
 *  over-eager refusal, would refuse every legitimate release — a guard that only ever rejects is
 *  indistinguishable from one that is simply broken (see docs/falsifiable-tests.md).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasPublishScripts } from '../helpers/repoLayout';
import {
  releaseBranchFor,
  parseReleaseVersion,
  checkReleaseState,
  claimLabelFor,
} from '../../scripts/releaseBranch.mjs';

const REPO = path.resolve(__dirname, '../../..');
const CLI = path.join(REPO, 'engine/scripts/releaseBranch.mjs');
const HOOK = path.join(REPO, 'engine/scripts/git-hooks/prepare-commit-msg');
const PUBLISHER = path.join(REPO, 'scripts/publish-engine-oss.sh');

describe('releaseBranchFor', () => {
  it('derives the underscore branch name from a plain version', () => {
    expect(releaseBranchFor('0.7.0')).toBe('release_0_7_0');
    expect(releaseBranchFor('1.0.0')).toBe('release_1_0_0');
    // Multi-digit components must survive: a naive per-character replace would mangle these.
    expect(releaseBranchFor('10.20.30')).toBe('release_10_20_30');
  });

  it('trims surrounding whitespace — the version arrives from `node -e` and from a shell $()', () => {
    expect(releaseBranchFor(' 0.7.0\n')).toBe('release_0_7_0');
  });

  it('returns null for anything that is not a plain X.Y.Z', () => {
    // A prerelease is the case that matters: it would otherwise derive `release_0_7_0-rc_1`, a name
    // nobody would be on, so the branch check would fire on a version that looks ordinary.
    expect(releaseBranchFor('0.7.0-rc.1')).toBeNull();
    expect(releaseBranchFor('v0.7.0')).toBeNull();
    expect(releaseBranchFor('0.7')).toBeNull();
    expect(releaseBranchFor('0.7.0.1')).toBeNull();
    expect(releaseBranchFor('')).toBeNull();
    // Not a string at all — the CLI hands over whatever `--version` was given, including nothing.
    expect(releaseBranchFor(undefined as unknown as string)).toBeNull();
  });
});

describe('parseReleaseVersion', () => {
  it('splits the three components as strings, preserving a leading zero', () => {
    expect(parseReleaseVersion('0.7.0')).toEqual({
      ok: true,
      major: '0',
      minor: '7',
      patch: '0',
    });
  });

  it('reports why, rather than throwing', () => {
    expect(parseReleaseVersion('0.7.0-rc.1')).toEqual({ ok: false, reason: 'not-semver-triple' });
  });
});

describe('checkReleaseState — the ACCEPT side', () => {
  it('accepts the derived branch with a clean tree', () => {
    const v = checkReleaseState({ version: '0.7.0', branch: 'release_0_7_0', dirty: false });
    expect(v.ok).toBe(true);
    expect(v.code).toBe('ok');
    // The message has to name the branch: it is what the operator reads to confirm the right cut.
    expect(v.message).toContain('release_0_7_0');
    expect(v.message).toContain('0.7.0');
  });

  it('accepts when --version agrees with package.json', () => {
    expect(
      checkReleaseState({
        version: '0.7.0',
        branch: 'release_0_7_0',
        dirty: false,
        manifestVersion: '0.7.0',
      }).ok,
    ).toBe(true);
  });

  it('accepts untracked files OUTSIDE oss/ — the caller reports those as not-overlay', () => {
    // ⚠️ This replaces a test that asserted `dirty: false` literally and was therefore a second copy
    // of the accept case above — it could not fail alone, and the claim in its NAME ("untracked
    // cannot ship") was false: the oss/.github overlay is an unfiltered directory rsync. The real
    // untracked behaviour is split — the shell decides WHICH untracked files matter (covered in the
    // publisher describe below), this decides what to do once told.
    expect(
      checkReleaseState({
        version: '0.7.0',
        branch: 'release_0_7_0',
        dirty: false,
        untrackedOverlay: false,
      }).ok,
    ).toBe(true);
  });
});

describe('checkReleaseState — the REJECT side, one code each', () => {
  it('refuses a prerelease version before it can derive a branch nobody is on', () => {
    const v = checkReleaseState({ version: '0.7.0-rc.1', branch: 'release_0_7_0', dirty: false });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('bad-version');
    // It must point at the mechanism that DOES serve an RC, or the reader is stuck.
    expect(v.message).toContain('rc-v');
  });

  it('refuses a detached HEAD', () => {
    const v = checkReleaseState({ version: '0.7.0', branch: '', dirty: false });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('detached');
  });

  it('refuses the wrong branch, naming BOTH the expected and the actual', () => {
    const v = checkReleaseState({ version: '0.7.0', branch: 'main', dirty: false });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('wrong-branch');
    expect(v.message).toContain('release_0_7_0');
    expect(v.message).toContain('main');
    // And it must say how to get there — a refusal that withholds the fix costs a round trip.
    expect(v.message).toContain('git switch -c release_0_7_0');
  });

  it('refuses a dirty tree on the right branch', () => {
    const v = checkReleaseState({ version: '0.7.0', branch: 'release_0_7_0', dirty: true });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('dirty');
  });

  it('refuses untracked files under oss/, because those DO ship', () => {
    const v = checkReleaseState({
      version: '0.7.0',
      branch: 'release_0_7_0',
      dirty: false,
      untrackedOverlay: true,
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('untracked-overlay');
    // The message must say WHY these differ from untracked files elsewhere, or the next reader
    // "harmonises" the two and reintroduces the hole.
    expect(v.message).toContain('rsync');
    expect(v.message).toContain('ELSEWHERE');
  });

  it('refuses a --version that disagrees with package.json', () => {
    const v = checkReleaseState({
      version: '0.7.0',
      branch: 'release_0_7_0',
      dirty: false,
      manifestVersion: '0.6.0',
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('version-mismatch');
    expect(v.message).toContain('0.6.0');
    expect(v.message).toContain('0.7.0');
  });

  it('does NOT refuse on version when the caller does not know the manifest version', () => {
    // The distinguishing case for the mismatch check: `undefined` must mean "not checked", not
    // "differs from undefined". Without this, every library caller that omits it is refused.
    expect(
      checkReleaseState({ version: '0.7.0', branch: 'release_0_7_0', dirty: false }).ok,
    ).toBe(true);
  });

  it('rejects three digit-runs that are not a semver core — the reason code says so', () => {
    // `1.0.010` would publish public tag v1.0.010 and an update feed no semver parser can order.
    expect(releaseBranchFor('1.0.010')).toBeNull();
    expect(releaseBranchFor('01.0.0')).toBeNull();
    expect(releaseBranchFor('1.0.0')).toBe('release_1_0_0');
    expect(releaseBranchFor('10.0.0')).toBe('release_10_0_0');
  });

  it('reports the BRANCH first when both the branch and the tree are wrong', () => {
    // Ordering is deliberate and worth pinning: told only "dirty tree", an operator on `main`
    // commits their work and is refused again for the reason that was true all along.
    const v = checkReleaseState({ version: '0.7.0', branch: 'main', dirty: true });
    expect(v.code).toBe('wrong-branch');
  });
});

describe('claimLabelFor — a release branch claims as the HUB', () => {
  it('is identity for the six clone branches', () => {
    expect(claimLabelFor('main')).toBe('wip/main');
    expect(claimLabelFor('work-ai')).toBe('wip/work-ai');
    expect(claimLabelFor('work-ai2')).toBe('wip/work-ai2');
    expect(claimLabelFor('work-ai3')).toBe('wip/work-ai3');
    expect(claimLabelFor('work-qa')).toBe('wip/work-qa');
    expect(claimLabelFor('win')).toBe('wip/win');
  });

  it('maps any release branch to wip/main, never to a label of its own', () => {
    // The whole point: wip/release_0_7_0 does not exist, `gh` would mint it silently, and
    // docs/task-claiming.md's not-claimable filter does not list it — so the issue reads as
    // unclaimed to all five other clones (#39's double-work scar).
    expect(claimLabelFor('release_0_7_0')).toBe('wip/main');
    expect(claimLabelFor('release_10_20_30')).toBe('wip/main');
  });

  it('returns null rather than a bogus label when there is no branch', () => {
    expect(claimLabelFor('')).toBeNull();
    expect(claimLabelFor(undefined as unknown as string)).toBeNull();
  });

  it('the --claim-label CLI prints a well-formed label for whatever is checked out', () => {
    // ⚠️ Deliberately NOT an enumeration of the six clone branches. This ran inside the OSS
    // snapshot's own throwaway test repo, whose branch is `master`, and correctly printed
    // `wip/master` — the earlier assertion listed the six and failed on a right answer. Which
    // branches map to which label is `claimLabelFor`'s unit tests' job (above, all six plus
    // release_*); what the CLI adds is that it reads the branch and emits ONE clean line.
    const r = spawnSync(process.execPath, [CLI, '--claim-label'], { encoding: 'utf8', cwd: REPO });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^wip\/[A-Za-z0-9._\-/]+$/);
    // The one thing it must never emit, whatever branch it finds.
    expect(r.stdout).not.toContain('wip/release_');
  });
});

describe('releaseBranch.mjs CLI — the seam the shell publisher reads', () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

  it('--branch-for prints just the name, exit 0', () => {
    const r = run(['--branch-for', '0.7.0']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('release_0_7_0');
  });

  it('--branch-for exits 2 on a prerelease, so the shell cannot use a bad name', () => {
    const r = run(['--branch-for', '0.7.0-rc.1']);
    expect(r.status).toBe(2);
    expect(r.stdout.trim()).toBe('');
  });

  it('check exits 0 and prints to STDOUT when the state is good', () => {
    const r = run(['check', '--version', '0.7.0', '--branch', 'release_0_7_0']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('release_0_7_0');
    expect(r.stderr.trim()).toBe('');
  });

  it('check exits 2 and prints to STDERR on a refusal', () => {
    // stderr matters: the publisher runs this bare, so a refusal must land where an operator sees
    // it even when stdout is being captured.
    const r = run(['check', '--version', '0.7.0', '--branch', 'main']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('release_0_7_0');
    expect(r.stderr).toContain('✖');
  });

  it('treats a missing --dirty as clean and a present one as dirty', () => {
    expect(run(['check', '--version', '0.7.0', '--branch', 'release_0_7_0']).status).toBe(0);
    expect(
      run(['check', '--version', '0.7.0', '--branch', 'release_0_7_0', '--dirty']).status,
    ).toBe(2);
  });

  it('refuses a missing --branch rather than defaulting to something', () => {
    // `git branch --show-current` prints nothing on a detached HEAD, and the shell passes that
    // through as an empty argument — so "absent" and "detached" must land on the same refusal
    // rather than on a silent pass.
    expect(run(['check', '--version', '0.7.0']).status).toBe(2);
  });
});

// ⚠️ Skipped where `scripts/` is absent — i.e. inside the assembled OSS snapshot, which ships
// `engine/`, `build/`, `docs/` and root configs but NOT `scripts/`. Without this the four tests below
// spawn a missing file, get exit 127, and turn the free public `ci/main` run red; `verify:publish`
// caught it locally because it runs the shipped guards inside the stage. This is the RUNTIME-path
// twin of what `publishExclusions.test.ts` guards for static imports — that guard's own header says
// a runtime read is a different failure (ENOENT/127, not TS2307) handled by these repoLayout helpers.
describe.skipIf(!hasPublishScripts())(
  'publish-engine-oss.sh --release — the shell block that actually refuses',
  () => {
  /** The publisher refuses before doing any work, so every case here is fast and touches nothing.
   *  This is the FOURTH surface: the library being right says nothing about the shell's argument
   *  handling, its `git diff` derivation, or which paths it gates. */
  const run = (args: string[]) =>
    spawnSync('bash', [PUBLISHER, ...args], { encoding: 'utf8', cwd: REPO });

  it('refuses --push with no --release — the path that tags the PUBLIC mirror', () => {
    // ⚠️ The finding this pins: --release used to be opt-in, so this exact command published a
    // snapshot, force-moved the public vX.Y.Z tag and started the signed release builds from
    // whatever branch happened to be checked out.
    const r = run(['--push']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--release');
    // It must refuse BEFORE any assembling, or the refusal costs a full copy+scan.
    expect(r.stdout).not.toContain('Assembling');
  });

  it('refuses --release together with --branch, in either argument order', () => {
    for (const args of [
      ['--release', '--branch', 'ci/x'],
      ['--branch', 'ci/x', '--release'],
    ]) {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('mutually exclusive');
    }
  });

  it('refuses --release on the wrong branch, naming the branch it wanted', () => {
    // Runs in the real repo, which is never on a release branch during a test run.
    const r = run(['--release']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/release_\d+_\d+_\d+/);
    expect(r.stdout).not.toContain('Assembling');
  });

  it('does NOT refuse a plain dry run — verify:publish must keep working', () => {
    // The distinguishing case for the new publish gate: it is scoped to --push-without---branch, so
    // a dry run and a CI snapshot are unaffected. Without this, tightening the gate silently breaks
    // `npm run verify:publish` on every clone. Asserted by reaching the assemble step, not by
    // running the whole (slow) snapshot: `--version` bad enough to fail later would mask it, so we
    // check the guard did not fire.
    const r = spawnSync('bash', [PUBLISHER, '--out', '/dev/null/definitely-not-a-dir'], {
      encoding: 'utf8',
      cwd: REPO,
    });
    expect(r.stderr).not.toContain('requires --release');
  });
  },
);

// ⚠️ Skipped on win32: this file SHIPS in the OSS snapshot, which runs on the free public
// `windows-latest` leg, and the block below spawns a POSIX `sh` and relies on the hook's
// `sed -i.bak`. Git-Bash is on PATH there (editorPortsCli spawns `bash` on the `win` clone and
// passes), so this would probably work — "probably" is not what a public CI leg should rest on, and
// the hook it covers only ever runs under git's own shell on a developer machine.
describe.skipIf(process.platform === 'win32')('prepare-commit-msg exempts release branches', () => {
  /** A throwaway repo with `branch` checked out, the hook run over `subject`, and the resulting
   *  first line returned. Real git, real hook — no mocking of the thing under test. */
  function firstLineAfterHook(branch: string, subject: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-hook-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' });
      git('init', '-q');
      git('checkout', '-q', '-b', branch);
      const msgFile = path.join(dir, 'COMMIT_EDITMSG');
      fs.writeFileSync(msgFile, `${subject}\n`);
      // $2 empty = a normal commit, which is the only source the hook acts on.
      const r = spawnSync('sh', [HOOK, msgFile], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      return fs.readFileSync(msgFile, 'utf8').split('\n')[0];
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('leaves a release branch commit unprefixed', () => {
    expect(firstLineAfterHook('release_0_7_0', 'chore(release): 0.7.0')).toBe(
      'chore(release): 0.7.0',
    );
  });

  it('still leaves main unprefixed', () => {
    expect(firstLineAfterHook('main', 'merge thing')).toBe('merge thing');
  });

  it('still prefixes a worker branch — the exemption must not have widened to everything', () => {
    // The distinguishing case. Without it, deleting the whole `case` block (or replacing it with a
    // bare `exit 0`) passes both tests above, and the hook silently stops working for the five
    // clones it exists for.
    expect(firstLineAfterHook('work-ai2', 'fix thing')).toBe('[work-ai2] fix thing');
  });
});
