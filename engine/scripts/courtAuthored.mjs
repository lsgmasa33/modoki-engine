/**
 * Did THIS clone author a change that Court's tests depend on?
 *
 * The engine-side half of a predicate with two consumers that cannot import each other:
 *
 *   - `engine/vite.config.ts` (this file) — a FILE-LEVEL gate: drop `games/court/tests/**` from
 *     vitest's discovery entirely when this clone has nothing to do with Court.
 *   - `games/court/tests/sweepGate.ts` — the finer-grained `COURT_SWEEPS` / `COURT_CORPUS` gates,
 *     for a clone that IS working on Court and wants to choose which tiers run.
 *
 * The gate is worth its complexity on measurement: `npm run verify` runs **145 s with Court and
 * 43 s without** on this Mac (2026-08-14, 731 levels). ⚠️ SNAPSHOT — the "with Court" half is
 * superseded (`verify` is 82-86 s as of 2026-08-18, `games/court/test-cost.md` § 9); the gain has
 * not been re-measured since, so the gate's value is un-refreshed, not disproved.
 *
 * ⚠️ **It used to say `describe.skipIf` DOES NOT SAVE WALL CLOCK, and that was a wrong reading of a
 * real measurement — the correction is the useful part.** On 2026-08-13, gating every corpus-walking
 * describe took test-body time from 255.7 s to 50.7 s and moved wall clock from 412 s to 428 s, and
 * that was attributed to ~100 files each paying ~5 s of engine-module import. The actual cause was
 * ONE file: `hintPainting.test.ts` walked the corpus at **describe-body scope**, which a `skipIf`
 * cannot reach — vitest must run a describe callback to collect its tasks, and bills that time under
 * `import`. It cost 419 s of a 434 s run with the sweeps switched off, so both arms were pinned by
 * it. Fixed 2026-08-14 (lazy memo): Court's suite is **135 s**, its real per-file import is
 * ~0.4-1.2 s, and `skipIf` saves exactly what you would expect.
 *
 * The lesson that survives: **a per-file average is not evidence about any file.** Before believing
 * one, rank the files — the ratio here was 400:1.
 *
 * ⚠️ **KEEP IN SYNC with `games/court/tests/sweepGate.ts`, which carries a SECOND COPY.** The
 * extraction was attempted and reverted: a game must be self-contained (`games/<id>` is copied out
 * of the repo), so a relative import from a game's tests into `engine/scripts/` fails
 * `tests/assets/gamePortability.test.ts`. Same forced duplication as `PROJECT_ROOT_DIRS`. The two
 * must agree on the WATCHED list, both fail-safe arms, and the pathspec form of the log walk.
 *
 * `.mjs` rather than `.ts` for the same reason `projectRoots.mjs` is: `vite.config.ts` is loaded
 * before any TS pipeline exists to compile a helper for it.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The paths a Court test's result actually depends on.
 *
 * ⚠️ `games/court` ALONE IS NOT THE ANSWER — the panel-fit family measures Court's narration
 * against the ENGINE's text layout, so a session that rewrites engine text wrapping and touches
 * nothing under `games/court` would have skipped the one suite built to catch it. Deliberately
 * narrow otherwise: widening it to `engine/` would make the gate a no-op on most sessions, which
 * is the cost it exists to avoid.
 */
export const WATCHED = ['games/court', 'engine/packages/modoki/src/runtime/rendering/text'];

/** Runs a git command in the repo, or `null` if it cannot. Injectable so a test can bind it to a
 *  throwaway repo — the merge-vs-authored distinction is a fact about commit topology, and nothing
 *  short of real commits can prove it. */
export function git(...args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;                       // no git, detached, no remote — caller treats this as "run"
  }
}

/**
 * Did the first-parent chain of `base..HEAD` author a commit touching a watched path?
 *
 * ⚠️ **AUTHORED, not merely present — merging someone else's Court work does not count.** The
 * branch that wrote the change already ran the tests before pushing; making every clone that
 * integrates it pay again buys a second run of the same corpus against the same solver.
 *
 * The mechanism is `--first-parent`: a commit AUTHORED here sits on that chain, while one that
 * arrived by merging hangs off a SECOND parent and is invisible to the walk. `--no-merges` then
 * drops the merge commits themselves.
 */
export function authoredInRange(run, base) {
  // ⚠️ A git PATHSPEC (`-- ...WATCHED`), not `--name-only` plus prefix matching in JS. This is a
  // faithful port of the version in `sweepGate.ts` that `sweepGate.test.ts` proves against a real
  // throwaway repo, and the first draft of this file got it wrong — prefix-matching path strings
  // agrees with a pathspec on the easy cases and diverges on renames, quoted paths and
  // `core.quotePath` escaping. Do not "simplify" it back.
  //
  // `--first-parent` = this branch's own line of development; `--no-merges` = drop the merge
  // commits on it. `--format=%H` empties the commit header so the output is non-empty ONLY when a
  // matching commit exists.
  const own = run('log', '--first-parent', '--no-merges', '--format=%H', `${base}..HEAD`, '--', ...WATCHED);
  if (own === null) return null;
  return own.trim() !== '';
}

/**
 * Does this working tree or branch author anything Court's tests depend on? `null` = cannot tell.
 *
 * ⚠️ **FAILS TOWARD RUNNING.** git unavailable, unparseable, or a degenerate range all return
 * `null`, and every consumer maps `null` to "run". A detector that cannot answer must never be
 * indistinguishable from one answering "nothing changed" — that conflation is how a gate rots.
 */
export function courtTouched() {
  // Uncommitted work first — the common case for the session actually editing Court. Deliberately
  // NOT first-parent-aware: a dirty tree is by definition this session's own doing.
  const dirty = git('status', '--porcelain', '--', ...WATCHED);
  if (dirty === null) return null;
  if (dirty.trim() !== '') return true;

  const base = git('merge-base', 'HEAD', 'origin/main');
  if (base === null) return null;

  // ⚠️ A branch with NO commits of its own cannot be asked what it changed, and answering "nothing"
  // there is this gate's worst failure: `merge-base(HEAD, origin/main) === HEAD` on any checkout of
  // `main` itself, which is EVERY CI run. That is the degenerate case, not a negative answer, so it
  // maps to "could not tell" and therefore to RUN.
  if (base.trim() === git('rev-parse', 'HEAD')?.trim()) return null;

  return authoredInRange(git, base.trim());
}
