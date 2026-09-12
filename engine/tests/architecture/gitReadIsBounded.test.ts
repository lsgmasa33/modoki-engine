/** ⚠️ **Every git spawn passes an explicit `maxBuffer` — Node's default is 1 MiB (#1120).**
 *
 *  Exceeding it throws, and none of these sites crash usefully: each has a `catch` that maps ANY
 *  throw onto a semantic answer, so "the output outgrew the pipe" becomes indistinguishable from
 *  "git said no". That is the half that bites — the buffer itself is one token.
 *
 *  Measured on 2026-09-12, and the framing matters: #1114 sized its own instance by HISTORY
 *  (`rev-list HEAD` hits 1 MiB at ~25,575 commits; the repo is at 8,822), which reads as years away
 *  and is the wrong axis. The nearest sites are fed by an AUTHORED ASSET:
 *  `games/court/runtime/assets/scenes/main.scene.json` went 148,417 B → 369,684 B between
 *  2026-08-12 and 2026-09-12 — **2.5x in a month, 35% of the default** — and it is the input to
 *  three separate `git show` reads. Weeks, not years.
 *
 *  What the swallow cost, before the fix:
 *   - `check-scene-churn.mjs` / `check-prefab-churn.mjs` reported a long-committed file as
 *     `NEW FILE (untracked)` and SKIPPED ITS DIFF — the review gate going blind on the largest file
 *     it exists to read. `check-scene-churn.mjs`'s own comment already recorded that silent stop
 *     for the Windows-quoting cause, so an overflow was a second door into a known-bad path.
 *   - `gen-release-notes.mjs` returned `''` and emitted EMPTY release notes at exit 0.
 *   - `typecheck-projects.mjs` and `games/court/tests/changedLevels.ts` fail SAFE (both answer
 *     "could not tell" with a full sweep) but report a false cause — and for Court that is the
 *     ~22-minute corpus sweep, on every run, forever, blaming git.
 *
 *  ⚠️ **The discriminator is MEASURED, not assumed** (see the site comments): exceeding `maxBuffer`
 *  gives `code:'ENOBUFS', status:null`, while git returning a verdict gives a numeric `status`
 *  (128 for "not in this tree"). So "no numeric status" means the process never answered, and only
 *  a completed-but-failed run may be read as a verdict.
 *
 *  This file is the enforcement half only — it does NOT check the catch semantics, which no
 *  presence guard can see. That half is covered behaviourally in `gitReadEnobufs.test.ts`.
 *
 *  Structural twin of `corpusProducerIsShared.test.ts` (itself the twin of
 *  `commentStripperIsShared.test.ts`, #419): one rule, one `EXEMPT` ledger whose entries must each
 *  still TRIP the rule, so the ledger cannot decay into decoration. Scanned via `repoFiles()` — a
 *  hand-rolled walk here would violate that sibling's rule one level up — and comments are stripped
 *  with the shared `stripComments` before parsing. */

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasInternalGames } from '../helpers/repoLayout';

/** The sync/async spawn helpers whose options bag carries `maxBuffer`. `spawnSync` is included
 *  because it takes the same option and is how two of the exempt sites read git. */
const SPAWNERS = new Set(['execFileSync', 'execSync', 'spawnSync', 'execFile', 'exec']);

/** ⚠️ Split, for the same reason `corpusProducerIsShared.test.ts` splits its own: that guard bans
 *  the literal subcommand in any file, and a string LITERAL is not a comment, so `stripComments`
 *  cannot blank it. Naming it plainly in the EXEMPT reasons below made this file an offender
 *  against its own sibling — caught by `npm run verify`, not by review. */
const LS_FILES = 'ls' + '-files';

/** Is this call's first argument git? Covers both shapes: `execFileSync('git', [...])`, where the
 *  argument is the bare program, and `execSync(\`git show ...\`)`, where it is a whole command line
 *  (possibly a template with substitutions). Matching the SOURCE TEXT rather than a resolved value
 *  is deliberate — a constant-folding matcher would have to re-implement the compiler to read
 *  `execSync(cmd)`, and would then quietly stop matching the literal cases it does handle. */
const firstArgIsGit = (arg: ts.Node, sf: ts.SourceFile): boolean =>
  /^git(\s|$|['"`])/.test(arg.getText(sf).replace(/^[`'"]/, ''));

export type GitSpawn = { line: number; bounded: boolean; callee: string; read: string };

/** Which git subcommand a spawn runs, where that is statically knowable — `rev-parse`, `branch`,
 *  `show` — else `'<dynamic>'` for a `(...args)` helper that forwards a rest parameter.
 *
 *  ⚠️ This exists so an EXEMPT row can name the read it pardons instead of merely COUNTING them. A
 *  count alone still fails open within a file: `repoCorpus.mjs` declares one unbounded read, so
 *  binding its `rev-parse` while unbinding one `ls-files` keeps the count at 1 and stays green —
 *  on the corpus producer every other guard is built on. Found by review, after the count fix. */
const gitRead = (node: ts.CallExpression, sf: ts.SourceFile): string => {
  // `execSync('git show …')` / a template: the word after "git".
  const m = node.arguments[0].getText(sf).replace(/^[`'"]/, '').match(/^git\s+([A-Za-z][\w-]*)/);
  if (m) return m[1];
  // `execFileSync('git', ['rev-parse', …])`: the first non-flag string literal. A non-literal
  // element (`-C`'s directory) is skipped rather than ending the search.
  const argv = node.arguments[1];
  if (argv && ts.isArrayLiteralExpression(argv)) {
    for (const el of argv.elements) {
      if (ts.isStringLiteralLike(el) && !el.text.startsWith('-')) return el.text;
    }
  }
  return '<dynamic>';
};

/** Every git spawn in `code`, each flagged with whether it passes a literal `maxBuffer`. */
export function findGitSpawns(code: string, rel: string): GitSpawn[] {
  const sf = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true);
  const found: GitSpawn[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression.getText(sf).split('.').pop() ?? '';
      if (SPAWNERS.has(callee) && firstArgIsGit(node.arguments[0], sf)) {
        // The LAST object literal among the arguments is the options bag for every one of these
        // signatures (`(file, args, opts)` and `(cmd, opts)` alike).
        const opts = node.arguments.slice(1).filter(ts.isObjectLiteralExpression).pop();
        const bounded = !!opts?.properties.some(
          (p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'maxBuffer',
        );
        found.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          bounded,
          callee,
          read: gitRead(node, sf),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** ⚠️ **The migration backlog, not a pardon list.** Each row is a git read whose output is bounded
 *  by something other than the repo's size, with the reason it cannot grow.
 *
 *  ⚠️ **`reads` names WHICH unbounded git reads the file is allowed, and it is load-bearing — a
 *  file-level pardon is fail-open.** Caught by the mutation check in this guard itself: exempting
 *  `repoCorpus.mjs` for its one `rev-parse --show-toplevel` also pardoned its two `ls-files`
 *  reads, so deleting `maxBuffer` from the corpus producer — the most load-bearing git read in the
 *  repo — left this test GREEN. A guard for fail-open guards, failing open.
 *
 *  ⚠️ A bare COUNT was the first fix and is NOT enough — found by review one commit later. With
 *  `unbounded: 1`, binding that `rev-parse` while unbinding one `ls-files` keeps the count at 1
 *  and stays green. Naming the reads closes it in both directions: bind one and the multiset
 *  shrinks, unbind a different one and it changes. `'<dynamic>'` is a helper forwarding a rest
 *  parameter, where the subcommand is not statically knowable. */
const EXEMPT: ReadonlyArray<{ file: string; reads: readonly string[]; reason: string }> = [
  {
    file: 'engine/scripts/repoCorpus.mjs',
    reads: ['rev-parse'],
    reason: 'rev-parse --show-toplevel — one path. This module is the reference producer and its '
      + `two ${LS_FILES} reads DO pass 64 MiB; only the root lookup is unbounded, which is the one `
      + 'call here that cannot grow.',
  },
  {
    file: 'engine/scripts/device.mjs',
    reads: ['rev-parse'],
    reason: 'rev-parse --show-toplevel — one path.',
  },
  {
    file: 'engine/scripts/install-git-hooks.mjs',
    reads: ['rev-parse', 'rev-parse'],
    reason: 'rev-parse --git-common-dir and --git-path hooks — one path each.',
  },
  {
    file: 'engine/scripts/releaseBranch.mjs',
    reads: ['branch'],
    reason: 'branch --show-current — one branch name.',
  },
  {
    file: 'engine/plugins/healNativeConfig.ts',
    reads: ['rev-list'],
    reason: 'rev-list --COUNT HEAD — a single integer. ⚠️ Note the flag: the same subcommand '
      + 'without --count is 361,702 B here and is exactly what #1114 had to bound.',
  },
  {
    file: 'engine/electron/connectClaude.ts',
    reads: [LS_FILES],
    reason: `${LS_FILES} --error-unmatch -- <basename> — a single-path pathspec, so the output is one `
      + 'path or nothing regardless of repo size.',
  },
  {
    file: 'engine/scripts/courtAuthored.mjs',
    reads: ['<dynamic>'],
    reason: 'status --porcelain over a fixed watched list, merge-base, and rev-parse HEAD. '
      + 'Porcelain scales with DIRTY WORKING-TREE ENTRIES, not with history or corpus.',
  },
  {
    file: 'games/court/tests/sweepGate.ts',
    reads: ['<dynamic>'],
    reason: 'Same three reads as courtAuthored.mjs (status --porcelain over a fixed list, '
      + 'merge-base, rev-parse HEAD), for the same reason. Cannot import the engine helper '
      + 'anyway — #29 / gamePortability.test.ts bars a game reaching into engine/.',
  },
];

/** ⚠️ The OSS snapshot ships no `games/` rows, so an EXEMPT entry naming one is definitionally
 *  unsatisfiable there — the trap that turned `corpusProducerIsShared.test.ts` from "ships and
 *  passes" into "ships and fails" when #814 widened it. */
const rootIsPresent = (rel: string): boolean => hasInternalGames() || !rel.startsWith('games/');

describe('every git read passes an explicit maxBuffer (#1120)', () => {
  const files = repoFiles({
    match: /\.(ts|mts|mjs|js)$/,
    exclude: ['node_modules', 'dist'],
    floor: 1500,
  })
    // ⚠️ `*.test.*` only. A test spawning git into a temp repo it just built is bounded by
    // construction, and listing dozens of them would bury the real ledger. `changedLevels.ts` and
    // `sweepGate.ts` live under a `tests/` DIRECTORY but are tools, not specs — they run in the
    // real repo against real history, and they stay in scope.
    .filter(({ rel }) => !/\.test\.[cm]?[jt]s$/.test(rel))
    // ⚠️ `readScannedSource`, not `fs.readFileSync` + a private strip (#812) — it strips by
    // EXTENSION and runs `assertScanIsSane` itself, which is why no separate sanity loop appears
    // below. `commentStripperIsShared.test.ts` fails on the hand-rolled shape, and it caught this
    // file doing exactly that.
    .map(({ rel, abs }) => ({ rel, code: readScannedSource(abs).code }));

  const spawns = files.flatMap((f) => findGitSpawns(f.code, f.rel).map((s) => ({ ...s, rel: f.rel })));

  it('scans a floored corpus and actually FINDS git spawns, bounded and unbounded alike', () => {
    // ⚠️ Non-vacuity, and it needs all three clauses. A file floor alone is satisfied by a
    // detector that matches nothing; a total-spawn floor alone is satisfied by one that can only
    // ever answer "bounded". Requiring at least one of EACH proves both arms run on real input —
    // which is what a guard whose accept side is never exercised cannot claim.
    // ⚠️ **900, not 1500 — a floor here must clear the SNAPSHOT's count, not this clone's.**
    // Measured 2026-09-12: 3,203 files match, 1,518 survive the test-file filter HERE, but the
    // public OSS snapshot ships only `engine build docs` + a few root files, leaving **1,145**.
    // A 1,500 floor is green on every local run and red on the free 3-OS public CI the moment it
    // reaches main — which is how #1014/#1015 reddened that gate, and what
    // `corpusProducerIsShared.test.ts`'s own note (~line 551) warns is "a fact to MEASURE rather
    // than to reason to". Found by review; `npm run verify` structurally cannot see that leg.
    expect(files.length).toBeGreaterThanOrEqual(900);
    expect(spawns.length).toBeGreaterThanOrEqual(10);     // 19 measured 2026-09-12
    expect(spawns.filter((s) => s.bounded).length).toBeGreaterThanOrEqual(1);
    expect(spawns.filter((s) => !s.bounded).length).toBeGreaterThanOrEqual(1);
  });

  it('no file spawns git on the default 1 MiB buffer, outside the EXEMPT ledger', () => {
    // MUTATION CHECK: delete `maxBuffer` from `engine/scripts/typecheck-projects.mjs` — a
    // NON-exempt file — and this goes red naming it.
    //
    // ⚠️ It has to be a non-exempt file. The comment here first named `repoCorpus.mjs`, which is
    // EXEMPT and therefore filtered out two lines below, so that mutation reddens the ledger test
    // instead and this assertion had no falsifying mutation at all. Found by review.
    const exempt = new Set(EXEMPT.map((e) => e.file));
    const offenders = spawns
      .filter((s) => !s.bounded && !exempt.has(s.rel))
      .map((s) => `${s.rel}:${s.line} (${s.callee})`);
    expect(
      offenders,
      'these spawn git without an explicit `maxBuffer`, so Node caps the output at 1 MiB and '
        + 'throws ENOBUFS above it — which every catch in this repo reads as "git said no" '
        + `(#1120):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every EXEMPT entry still exists and still has EXACTLY the unbounded reads it names', () => {
    // The mechanism that keeps the ledger honest, in both directions. Bound one of these sites and
    // its count drops, so the row must be corrected or deleted. Unbind anything ELSE in the same
    // file and the count rises, so the pardon cannot silently widen to cover it — which is the
    // fail-open hole the mutation check found here.
    //
    // Re-runs the REAL detector rather than a private copy of the pattern: two matchers free to
    // disagree is how a load-bearing check ends up checking nothing.
    const byRel = new Map(files.map((f) => [f.rel, f]));
    const wrong: string[] = [];
    for (const e of EXEMPT) {
      const f = byRel.get(e.file);
      if (!f) {
        // ABSENT-BY-LAYOUT is not STALE — see `rootIsPresent`.
        if (rootIsPresent(e.file)) wrong.push(`${e.file} — no longer in the scanned corpus; drop this entry`);
        continue;
      }
      const actual = findGitSpawns(f.code, f.rel).filter((s) => !s.bounded).map((s) => s.read).sort();
      const declared = [...e.reads].sort();
      if (actual.join('|') !== declared.join('|')) {
        wrong.push(
          `${e.file} — names [${declared.join(', ')}] as its unbounded git read(s), found `
          + `[${actual.join(', ')}]. Bind the new one; do not widen the row.`,
        );
      }
    }
    expect(wrong, `EXEMPT ledger out of date:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('the detector tells the cases apart on synthetic input', () => {
    // ⚠️ The accept side, tested. A matcher proven only against offenders cannot distinguish "this
    // repo is clean" from "this matcher stopped matching" — and the bounded cases below are
    // exactly what a future edit would break first.
    const one = (src: string) => findGitSpawns(src, 'synthetic.ts');

    expect(one("execFileSync('git', ['log'], { encoding: 'utf8' });")[0].bounded).toBe(false);
    expect(one("execFileSync('git', ['log'], { encoding: 'utf8', maxBuffer: 1 });")[0].bounded).toBe(true);
    expect(one("spawnSync('git', ['rev-list'], { maxBuffer: 2 });")[0].bounded).toBe(true);

    // the execSync shape, including a template with substitutions
    expect(one('execSync(`git show HEAD:"${rel}"`, { cwd: ROOT });')[0].bounded).toBe(false);
    expect(one('execSync(`git show HEAD:"${rel}"`, { cwd: ROOT, maxBuffer: 3 });')[0].bounded).toBe(true);

    // not git, and not a spawn at all
    expect(one("execFileSync('node', ['-e', ''], { encoding: 'utf8' });")).toEqual([]);
    expect(one("myGitHelper('git', ['log']);")).toEqual([]);
    // ⚠️ a string that merely CONTAINS git is not a git spawn
    expect(one("execSync('npm run gitless', {});")).toEqual([]);
  });
});
