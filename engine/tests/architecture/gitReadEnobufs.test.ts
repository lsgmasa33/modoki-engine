/** ⚠️ **The half a presence guard cannot see: what a git read DOES when it overflows (#1120).**
 *
 *  `gitReadIsBounded.test.ts` proves every git spawn passes a `maxBuffer`. It cannot prove the
 *  thing the class is actually about — that exceeding one is reported as a failure rather than
 *  silently converted into a semantic answer. Before the fix:
 *
 *   - `check-scene-churn.mjs` / `check-prefab-churn.mjs` caught ANY throw and printed
 *     `NEW FILE (untracked)`, then `continue`d — so a long-committed file read as untracked and
 *     its diff was skipped. The review gate went blind on the largest file it exists to read.
 *   - `gen-release-notes.mjs`'s `gitSafe` returned `''` on any throw, emitting EMPTY release notes
 *     at exit 0.
 *
 *  Both now ask `isGitVerdict` first. This file pins the measurement that predicate rests on, using
 *  REAL spawns rather than a hand-built error object — a fake would model whatever shape we
 *  happened to believe, which is precisely the assumption under test.
 *
 *  ⚠️ **#1120's version of this file asserted a RACE as if it were a fact (#1127).** It pinned
 *  `typeof e.status !== 'number'` on an overflow, measured 300/300, and `isGitVerdict` was that
 *  same expression — so the one red `verify:publish` run it produced was the shipped predicate
 *  failing, not a flaky test. A child that has already exited when the overflow is detected
 *  carries its real exit code. The cases below therefore FORCE each branch instead of sampling,
 *  and assert the invariant (`isGitVerdict === false`) rather than the premise. */

import { describe, it, expect } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { readScannedSource } from '@modoki/engine/testing';
import { isGitVerdict } from '../../scripts/gitError.mjs';
import { repoRoot } from '../../scripts/repoCorpus.mjs';

/** Run `fn`, return whatever it threw. Fails loudly if it did not throw — a test that silently
 *  passes on "no error" would assert nothing at all. */
const thrown = (fn: () => unknown): NodeJS.ErrnoException & { status?: unknown; signal?: unknown } => {
  try {
    fn();
  } catch (e) {
    return e as NodeJS.ErrnoException & { status?: unknown; signal?: unknown };
  }
  throw new Error('expected this to throw, and it did not — the case under test did not happen');
};

describe('an overflowing git read is not mistaken for a git verdict (#1120, #1127)', () => {
  it('exceeding maxBuffer while the child is still writing is not a verdict', () => {
    // MUTATION CHECK: make `isGitVerdict` return true unconditionally -> red here.
    //
    // ⚠️ **The overflow is generated, not read out of this repo, and that is deliberate.** The
    // first version ran `git rev-list HEAD` with a 64-byte buffer, which overflows here (361,702 B
    // at 8,822 commits) and CANNOT overflow on the public CI: `actions/checkout` takes no
    // `fetch-depth`, so the clone is depth-1 and `rev-list HEAD` emits one 41-byte sha — no throw,
    // and `thrown()` would raise "expected this to throw". Green on every local run, red on the
    // free 3-OS public gate the moment it reached main. `npm run verify` structurally cannot see
    // that leg. Found by review.
    //
    // What is under test is a `child_process` property — the SHAPE of an overflow error — which is
    // what `isGitVerdict` consumes, and it does not depend on which binary produced it.
    //
    // ⚠️ Deliberately NO assertion on `status` here. This child USUALLY loses the race (node's
    // teardown is slow, so the kill lands first and `status` is null), but "usually" is exactly the
    // premise #1127 disproved. The branch where it wins is forced by the next case.
    const e = thrown(() => execFileSync(
      process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'],
      { encoding: 'utf8', maxBuffer: 64 },
    ));
    expect(e.code).toBe('ENOBUFS');
    expect(isGitVerdict(e)).toBe(false);
  });

  it('exceeding maxBuffer AFTER the child exited carries a numeric status — and is still not a verdict (#1127)', () => {
    // MUTATION CHECK: revert `isGitVerdict` to `typeof error?.status === 'number'` (#1120's
    // version) -> red here, and ONLY here among the predicate cases.
    //
    // The race, forced rather than sampled. The child hands its stdout to a grandchild and exits at
    // once; the grandchild writes the overflowing output later. `spawnSync` waits for the pipe to
    // close, so the child's exit is reaped long before the overflow is detected — and the error
    // carries BOTH `code: 'ENOBUFS'` and the child's real exit code. Measured 30/30 (and with
    // `exit(3)`, `status: 3` 10/10). Sampling was how #1120 got this wrong: `/bin/sh -c printf`
    // lands here 1000/1000 and a `node -e` writer 0/100, so which one a probe happened to use
    // decided the "measurement". Git reaches this branch whenever its output exceeds `maxBuffer`
    // by less than one pipe buffer: it writes its last chunk and exits before the parent overflows.
    //
    // No shell and no POSIX binary, so it runs on every leg of the 3-OS gate. The grandchild is left
    // to die on its own: once the parent closes the pipe its write fails and it exits.
    const handOff = 'const { spawn } = require("node:child_process");'
      + ' spawn(process.execPath, ["-e", "setTimeout(() => process.stdout.write(\\"x\\".repeat(5000)), 250)"],'
      + ' { stdio: ["ignore", "inherit", "ignore"] }).unref();'
      + ' process.exit(0);';
    const e = thrown(() => execFileSync(process.execPath, ['-e', handOff], { encoding: 'utf8', maxBuffer: 64 }));
    expect(e.code).toBe('ENOBUFS');
    // The premise, pinned rather than assumed: if this stops holding, the case no longer exercises
    // the branch it exists for, and it must say so rather than pass on the other one.
    expect(e.status).toBe(0);
    expect(isGitVerdict(e)).toBe(false);
  });

  it('git answering "not in this tree" IS a verdict — status 128', () => {
    // ⚠️ The accept side. Without it, `isGitVerdict` could return false always and the test above
    // would still pass, while every churn run started throwing on genuinely new files.
    //
    // MUTATION CHECK: make `isGitVerdict` return false unconditionally -> red here.
    // `execFileSync`, the shape the churn gates now use. Works in a depth-1 clone: HEAD exists.
    const e = thrown(() => execFileSync(
      'git', ['show', 'HEAD:definitely/not/a/real/path.json'],
      { cwd: repoRoot(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ));
    expect(e.status).toBe(128);
    expect(isGitVerdict(e)).toBe(true);
  });

  it('a binary that does not exist is not a verdict either', () => {
    // Why the predicate asks for the ABSENCE of a `code` rather than `code === 'ENOBUFS'`: it has
    // to catch the whole class of "never ran", not the one member that prompted it.
    const e = thrown(() => execFileSync('modoki-no-such-binary-1120', [], { encoding: 'utf8' }));
    expect(e.code).toBe('ENOENT');
    expect(isGitVerdict(e)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('a child killed by a signal has a NULL status — why the predicate needs no signal arm', () => {
    // `isGitVerdict` asks about `status` and `code` only. That is sound only while a signal death
    // never comes with a numeric `status` — a kill carries no `code`, so the `status` arm is the
    // one refusing it. Measured on a bare kill, a timeout kill and an overflow kill: `status: null`
    // every time. Pinned here so a Node that changes it goes red instead of turning a killed git
    // into a verdict.
    //
    // MUTATION CHECK: make `isGitVerdict` ignore `status` (`error?.code === undefined`) -> red here.
    //
    // ⚠️ Skipped on Windows: signals are emulated there and this shape is unmeasured on that leg,
    // so asserting it would be a guess (docs/windows.md — no Windows hypotheses from a Mac).
    const e = thrown(() => execFileSync(
      process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], { encoding: 'utf8' },
    ));
    expect(e.signal).toBe('SIGTERM');
    expect(e.code).toBeUndefined();
    expect(e.status).toBeNull();
    expect(isGitVerdict(e)).toBe(false);
  });

  it('through a SHELL a missing git looks like a verdict — which is why no site may use one', () => {
    // ⚠️ The finding that review caught after the #1120 fix landed. The churn gates ran
    // `execSync('git show …')`, and a shell that cannot find git exits **127** — a NUMERIC status.
    // `isGitVerdict` therefore read "git is not installed" as "git said no", swallowed the throw,
    // and printed NEW FILE (untracked) for every committed file: the exact silent-blind gate #1120
    // exists to close, reintroduced by its own fix. Both sites now use `execFileSync` (asserted
    // below), where the same failure is ENOENT with a null status.
    //
    // MUTATION CHECK: none needed on the predicate — this pins a PLATFORM behaviour that decides
    // which spawn shape is safe. If a future Node/shell stops returning 127 here, the reasoning in
    // `gitError.mjs` needs re-reading, and this goes red to force that.
    const viaShell = thrown(() => execSync('modoki-no-such-binary-1120 show HEAD:x',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    expect(typeof viaShell.status).toBe('number');
    expect(isGitVerdict(viaShell)).toBe(true);          // …and so it would have been SWALLOWED

    const viaArgv = thrown(() => execFileSync('modoki-no-such-binary-1120', [], { encoding: 'utf8' }));
    expect(viaArgv.code).toBe('ENOENT');
    expect(isGitVerdict(viaArgv)).toBe(false);          // the shape the sites use: not a verdict
  });

  it('the three swallowing sites actually ASK — the predicate is wired, not merely present', () => {
    // ⚠️ This repo's dominant defect class is a guard wired to something that never fires, and a
    // pure-function test cannot tell a live predicate from a dead one. Each of these sites still
    // swallows a DIFFERENT verdict, so what is checked is that the question is asked at all.
    const SITES = [
      'engine/scripts/check-scene-churn.mjs',
      'engine/scripts/check-prefab-churn.mjs',
      'engine/scripts/gen-release-notes.mjs',
    ];
    const missing: string[] = [];
    for (const rel of SITES) {
      // ⚠️ STRIPPED source (#812). Reading raw would let a COMMENT mentioning the predicate
      // satisfy this check — a fail-open in the one test that exists to prove it is wired.
      const { code: src } = readScannedSource(`${repoRoot()}/${rel}`);
      const imports = /import\s*\{[^}]*\bisGitVerdict\b[^}]*\}\s*from\s*['"][^'"]*gitError\.mjs['"]/.test(src);
      // Called in a REFUSING position: `!isGitVerdict(...)` is what turns a non-verdict into a
      // throw. A bare call that ignored the answer would satisfy a looser check and do nothing.
      const refuses = /!\s*isGitVerdict\s*\(/.test(src);
      // ⚠️ And no shell-string git spawn: through a shell a missing git exits 127, which
      // `isGitVerdict` cannot tell from a real verdict (pinned by the test above).
      const noShell = !/execSync\s*\(\s*[`'"]\s*git\s/.test(src);
      if (!imports || !refuses || !noShell) {
        missing.push(`${rel} (imports: ${imports}, refuses: ${refuses}, no-shell: ${noShell})`);
      }
    }
    expect(
      missing,
      'these sites swallow a git throw but no longer ask whether it was a verdict, so an '
        + `overflow is silently reported as a semantic answer again (#1120):\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});
