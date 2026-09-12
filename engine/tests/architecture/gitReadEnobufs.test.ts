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
 *  happened to believe, which is precisely the assumption under test. If a future Node gives an
 *  overflow a numeric `status`, the fix silently reverts to the old behaviour and this goes red. */

import { describe, it, expect } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { readScannedSource } from '@modoki/engine/testing';
import { isGitVerdict } from '../../scripts/gitError.mjs';
import { repoRoot } from '../../scripts/repoCorpus.mjs';

/** Run `fn`, return whatever it threw. Fails loudly if it did not throw — a test that silently
 *  passes on "no error" would assert nothing at all. */
const thrown = (fn: () => unknown): NodeJS.ErrnoException & { status?: unknown } => {
  try {
    fn();
  } catch (e) {
    return e as NodeJS.ErrnoException & { status?: unknown };
  }
  throw new Error('expected this to throw, and it did not — the case under test did not happen');
};

describe('an overflowing git read is not mistaken for a git verdict (#1120)', () => {
  it('exceeding maxBuffer throws WITHOUT a numeric status — so it is not a verdict', () => {
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
    const e = thrown(() => execFileSync(
      process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'],
      { encoding: 'utf8', maxBuffer: 64 },
    ));
    expect(e.code).toBe('ENOBUFS');
    expect(typeof e.status).not.toBe('number');
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
    // Why the predicate asks about `status` rather than `code === 'ENOBUFS'`: it has to catch the
    // whole class of "never ran", not the one member that prompted it.
    const e = thrown(() => execFileSync('modoki-no-such-binary-1120', [], { encoding: 'utf8' }));
    expect(e.code).toBe('ENOENT');
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
