/** Guard: a `CLAUDE.md` stays inside its size budget, and the budget only ever ratchets DOWN.
 *
 *  Every `CLAUDE.md` on the path to the open project is loaded into an agent's context on EVERY
 *  turn, so each line competes with the actual task for attention. `docs/doc-conventions.md`
 *  states the rule — high-level instruction plus pointers, deep reference extracted to a doc once
 *  a section "is longer than ~40 lines and reads like documentation rather than instruction".
 *
 *  That rule was followed in exactly one direction. Root `CLAUDE.md` records its own history in a
 *  single line — "This file was 125 KB once because that rule was followed in only one direction"
 *  — and by 2026-08-23 the root plus `games/court` had grown back to 139 KB combined, which is
 *  what an agent paid before reading a word of the request. Nothing failed while that happened,
 *  because prose has no compiler: growth is always one justified paragraph at a time.
 *
 *  So the budget is a RATCHET, not a ceiling. Two directions, and the second is the load-bearing
 *  one:
 *   - over budget -> fail. Extract the section to a doc and leave a pointer, per doc-conventions.
 *   - far UNDER budget -> also fail, asking for the baseline to be lowered in the same commit.
 *     A ceiling nobody re-baselines is a ceiling that gets grown into. This is the same shape as
 *     `docCitations.test.ts`'s `KNOWN_DANGLING_TITLES` meta-test (#329): a list that may only
 *     shrink needs a test that notices when an entry stops being needed.
 *
 *  The slack is deliberately generous (SHRINK_SLACK below). This guard exists to catch a file
 *  drifting back up over months, not to bill a commit for deleting a paragraph.
 *
 *  SCOPE: files are enumerated by walking the tree. `verify:publish` runs the shipped guards
 *  inside an assembled OSS snapshot, and that snapshot carries only a HANDFUL of `CLAUDE.md`
 *  files (the starter template, the testbed fixture, and whichever demos ship) — so a sanity
 *  floor tuned to this repo's ~27 goes red there. This guard shipped with exactly that bug for
 *  one commit; it was caught by running the publish gate, not by reasoning about it. Hence the
 *  floor below anchors on two files that exist in BOTH repos instead of on a count.
 *
 *  (`git ls-files` would in fact work there — `publish-engine-oss.sh` `git init`s the stage
 *  precisely so shipped guards can ask git. A tree walk is simply the smaller dependency, and
 *  it keeps this guard honest about untracked files too.)
 *
 *  A file present on disk must carry a budget — that is what makes a NEW project's `CLAUDE.md`
 *  get a deliberate number rather than silently inheriting none. The reverse direction (a
 *  budget naming a file that does not exist) is only checked when this checkout really has the
 *  internal projects: the snapshot ships neither all of `games/` nor all of `demos/`, so there
 *  the missing entries are correct, not rot.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT, hasInternalGames } from '../helpers/repoLayout';

const BUDGET_FILE = path.join(__dirname, 'claude-md-budget.json');

/** How far under budget a file may sit before the baseline is stale enough to re-cut. */
const SHRINK_SLACK = 0.25;

function budgets(): Record<string, number> {
  return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) as Record<string, number>;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'release', 'ios', 'android',
  '.vite', '.gradle', 'DerivedData', 'subgame-dist', 'ads',
  // ⚠️ `.claude` holds AGENT SCRATCH, not repo content — in particular `.claude/worktrees/<id>/`,
  // a full second checkout that a subagent launched with `isolation: 'worktree'` lives in. This
  // walker is a raw `fs.readdirSync`, so without this entry every CLAUDE.md in that checkout is
  // reported as un-budgeted and `npm run verify` goes RED for as long as any worktree agent runs —
  // i.e. during exactly the fan-out workflow CLAUDE.md recommends. (Measured: one review agent
  // produced 20+ offenders and a red gate that had nothing to do with the change under test.)
  // Sibling guards escape this for free by enumerating with `git ls-files`, which cannot see a
  // separate checkout; this one cannot, because an UNTRACKED CLAUDE.md is exactly what it must catch.
  '.claude',
]);

/** Every `CLAUDE.md` in the tree, repo-relative and POSIX-separated. */
function claudeFiles(dir = REPO_ROOT, prefix = ''): string[] {
  const found: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      found.push(...claudeFiles(path.join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name));
    } else if (e.name === 'CLAUDE.md') {
      found.push(prefix ? `${prefix}/CLAUDE.md` : 'CLAUDE.md');
    }
  }
  return found.sort();
}
const trackedClaudeFiles = () => claudeFiles();

describe('CLAUDE.md size budget (context an agent pays on every turn)', () => {
  it('finds the files at all — a zero-file sweep would pass every assertion below', () => {
    // The failure this repo has seen twice: a query stops matching and the guard goes quiet
    // while reporting success. Anchor on a file that exists in BOTH this repo and the OSS
    // snapshot, rather than on a count that only holds here.
    const found = trackedClaudeFiles();
    expect(found).toContain('engine/templates/starter/CLAUDE.md');
    expect(found).toContain('engine/tests/fixtures/testbed/CLAUDE.md');
  });

  it('every tracked CLAUDE.md carries a budget', () => {
    const known = budgets();
    const missing = trackedClaudeFiles().filter((f) => !(f in known));
    expect(
      missing,
      `add a budget to engine/tests/architecture/claude-md-budget.json for:\n  ${missing.join('\n  ')}\n` +
        'Pick roughly the current size plus a little headroom — the number is a commitment, not a measurement.',
    ).toEqual([]);
  });

  it('no CLAUDE.md is over budget', () => {
    const known = budgets();
    const over: string[] = [];
    for (const f of trackedClaudeFiles()) {
      const budget = known[f];
      if (budget === undefined) continue; // reported by the test above
      const size = fs.statSync(path.join(REPO_ROOT, f)).size;
      if (size > budget) {
        over.push(`${f}: ${size} B > ${budget} B budget (+${size - budget})`);
      }
    }
    expect(
      over,
      'A CLAUDE.md outgrew its budget:\n  ' +
        over.join('\n  ') +
        '\n\nPer docs/doc-conventions.md, extract the deep reference to a doc and leave the RULE plus a\n' +
        'pointer behind. Raising the budget is the wrong fix unless the file genuinely gained a new\n' +
        'standing rule that must be in context every turn — say so in the commit if you do.',
    ).toEqual([]);
  });

  it('no budget is stale — a file well under its number gets the number lowered', () => {
    const known = budgets();
    const slack: string[] = [];
    for (const f of trackedClaudeFiles()) {
      const budget = known[f];
      if (budget === undefined) continue;
      const size = fs.statSync(path.join(REPO_ROOT, f)).size;
      if (size < budget * (1 - SHRINK_SLACK)) {
        slack.push(`${f}: ${size} B vs ${budget} B budget — lower it to about ${Math.ceil((size * 1.08) / 500) * 500}`);
      }
    }
    expect(
      slack,
      'A CLAUDE.md shrank well below its budget. Lower the budget in the same commit so the space\n' +
        'you just freed cannot be silently grown back into:\n  ' +
        slack.join('\n  '),
    ).toEqual([]);
  });

  it.skipIf(!hasInternalGames())('no budget names a file that is gone', () => {
    const tracked = new Set(trackedClaudeFiles());
    const stale = Object.keys(budgets()).filter((f) => !tracked.has(f));
    expect(
      stale,
      `these budgets name a CLAUDE.md that no longer exists — drop them:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});
