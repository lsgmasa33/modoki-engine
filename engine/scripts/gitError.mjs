/** Did a thrown `child_process` error come from git RETURNING A VERDICT, or from the process never
 *  completing at all? (#1120, #1127)
 *
 *  Every git read in this repo sits behind a `catch` that turns the throw into a semantic answer —
 *  "this file is not in HEAD", "there is no previous tag", "could not tell, sweep everything". That
 *  is fine for a verdict and WRONG for a process that never ran, and the two were indistinguishable
 *  until this predicate existed: a `git show` whose output exceeded Node's 1 MiB default
 *  `maxBuffer` was reported as `NEW FILE (untracked)` and its diff skipped, and an overflowing
 *  `git log` produced empty release notes at exit 0.
 *
 *  ⚠️ **A verdict needs BOTH: a numeric `status` and no `code`.** Measured through real spawns
 *  (`engine/tests/architecture/gitReadEnobufs.test.ts`):
 *
 *      git saying no                    ->  code: undefined, status: 128,  signal: null
 *      exceeding maxBuffer, child alive ->  code: 'ENOBUFS', status: null, signal: 'SIGTERM'
 *      exceeding maxBuffer, child DONE  ->  code: 'ENOBUFS', status: 0,    signal: null
 *      git missing                      ->  code: 'ENOENT',  status: null
 *      killed by a signal               ->  code: undefined, status: null, signal: 'SIGTERM'
 *
 *  ⚠️ **The first version asked about `status` ALONE, and the third row is why that was wrong
 *  (#1127).** Overflow detection and child exit RACE: a child that exits straight after its last
 *  write is reaped before the parent's read overflows, so its real exit code lands in `status` beside
 *  `code: 'ENOBUFS'`. #1120 measured 300/300 of the second row and called it the shape — but its
 *  probe was a `node -e` child, whose slow teardown always loses the race. `/bin/sh -c printf` gives
 *  the third row 1000/1000, and git reaches it whenever its output exceeds `maxBuffer` by less than
 *  one pipe buffer. One red `verify:publish` run was that row, read as a verdict.
 *
 *  Asking for the absence of `code` rather than `code === 'ENOBUFS'` is deliberate: it keeps the
 *  whole class "never returned a verdict" (overflow, missing binary, `ETIMEDOUT`) instead of the one
 *  member that prompted it — and it no longer rests on `status` being absent, which is the half a
 *  race decides. There is deliberately NO `signal` arm: `spawnSync` reports `status: null` whenever
 *  the child died by a signal (a bare kill, a timeout kill and an overflow kill all measured that
 *  way), so the `status` arm already refuses every signal case and a third arm would be one no real
 *  spawn can reach or falsify. The test pins that premise, so a Node that changes it goes red.
 *
 *  ⚠️ Lives in its own module rather than being inlined at each site because a rule implemented
 *  three times diverges (conventions §9) — and the three call sites here each swallow a DIFFERENT
 *  verdict, so the thing they share is exactly this one question and nothing else. */
export function isGitVerdict(error) {
  return typeof error?.status === 'number' && error.code === undefined;
}
