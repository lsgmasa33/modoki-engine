/**
 * A Playwright reporter whose only job is to make a SHORT run fail loudly.
 *
 * Why this exists (see docs/editor.md's e2e-suite passage, 2026-07-29): `npm run test:e2e` once printed `17 passed (1.9m)`
 * and exited 0 on a suite of 46. An immediate re-run on the same commit and the same tree printed
 * `46 passed`. Nothing failed either time — the suite simply ran a SUBSET and still reported
 * success.
 *
 * That is worse than a red run. e2e is the only thing watching editor interaction, and "green" is
 * exactly what a human reads before pushing. A run that quietly covers a third of the suite and
 * says `passed` defeats the ritual it exists to serve. (When this was written e2e had no remote
 * counterpart at all; since #96 the public `ci.yml` runs the whole suite free on every `main`
 * push. That reduces the blast radius — it does not retire the guard, which is what makes a
 * LOCAL pre-push run trustworthy.)
 *
 * The root cause was later found — an orphaned Vite dev server on the e2e port, silently adopted
 * by `webServer.reuseExistingServer: true` and then dying mid-run; see docs/editor.md. The guard
 * predates that diagnosis and deliberately does not depend on it: what CREATES an orphan is still
 * unknown, and a short-run guard is cheap and catches the class whatever the cause. Two
 * independent checks, because they fail differently:
 *
 *  1. **Every discovered test actually ran.** Catches an interrupted/aborted run, which is the
 *     leading theory — Playwright lists the remainder as "did not run" and, in some situations,
 *     still exits 0.
 *  2. **At least `EXPECTED_MIN_TESTS` were discovered.** Catches the case check 1 structurally
 *     cannot see: if DISCOVERY itself comes up short (a broken `testDir`/`testMatch`, a spec file
 *     that throws at import and is silently dropped), then "everything discovered ran" is
 *     trivially true and tells you nothing.
 */

import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

/**
 * A floor, not an exact count — new specs are welcome, a shrinking suite is not. Raise it when the
 * suite grows meaningfully; it is not a number anyone should have to update on every commit.
 * `MODOKI_E2E_MIN_TESTS` overrides it for the rare deliberate subset run (`--grep`, one spec file
 * during development), which would otherwise trip this guard on every invocation.
 */
const EXPECTED_MIN_TESTS = 50;

export default class RunCompleteReporter implements Reporter {
  private discovered = 0;
  private ran = 0;
  private notRun: string[] = [];

  onBegin(_config: FullConfig, suite: Suite): void {
    this.discovered = suite.allTests().length;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // A test the author explicitly skipped (`test.skip`) is not a gap in coverage — it is a
    // decision. One that was EXPECTED to run and ended up skipped/interrupted is the bug.
    if (test.expectedStatus === 'skipped') return;
    if (result.status === 'skipped' || result.status === 'interrupted') {
      this.notRun.push(test.titlePath().filter(Boolean).join(' › '));
      return;
    }
    this.ran++;
  }

  onEnd(result: FullResult): Promise<{ status: FullResult['status'] } | void> | void {
    const min = Number(process.env.MODOKI_E2E_MIN_TESTS ?? EXPECTED_MIN_TESTS);
    const problems: string[] = [];

    if (this.notRun.length > 0) {
      problems.push(
        `${this.notRun.length} discovered test(s) never ran:\n` +
        this.notRun.map((t) => `      - ${t}`).join('\n'),
      );
    }
    if (this.discovered < min) {
      problems.push(
        `only ${this.discovered} tests were DISCOVERED, expected at least ${min}. ` +
        'Either the suite shrank (update EXPECTED_MIN_TESTS in this reporter), a spec file ' +
        'failed to import, or this is a deliberate subset run (set MODOKI_E2E_MIN_TESTS).',
      );
    }
    if (problems.length === 0) return;

    // Printed rather than thrown so it lands AFTER the list reporter's summary, where the reader
    // is already looking for the verdict.
    console.error(
      `\n  ✘ INCOMPLETE E2E RUN — reported "${result.status}", but the run did not cover the suite.\n` +
      problems.map((p) => `    • ${p}`).join('\n') +
      '\n\n    A short green run is not a pass. Re-run with the FULL output (not a tail) and see\n' +
      '    docs/editor.md — the e2e-suite passage is the diagnosis.\n',
    );
    // Override the run's verdict. Setting `process.exitCode` here does NOT work — Playwright
    // assigns its own exit code after reporters finish, so the short run still exited 0 (measured;
    // that is the whole failure mode being guarded, so it would have shipped a guard that printed
    // a warning and passed anyway). Returning a status from `onEnd` is the supported hook.
    return Promise.resolve({ status: 'failed' });
  }
}
