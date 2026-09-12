/** Did a thrown `child_process` error come from git RETURNING A VERDICT, or from the process never
 *  completing at all? (#1120)
 *
 *  Every git read in this repo sits behind a `catch` that turns the throw into a semantic answer —
 *  "this file is not in HEAD", "there is no previous tag", "could not tell, sweep everything". That
 *  is fine for a verdict and WRONG for a process that never ran, and the two were indistinguishable
 *  until this predicate existed: a `git show` whose output exceeded Node's 1 MiB default
 *  `maxBuffer` was reported as `NEW FILE (untracked)` and its diff skipped, and an overflowing
 *  `git log` produced empty release notes at exit 0.
 *
 *  ⚠️ **The discriminator is `status`, and it is MEASURED rather than assumed** — see
 *  `engine/tests/architecture/gitReadEnobufs.test.ts`, which drives both cases through real spawns:
 *
 *      exceeding maxBuffer  ->  code: 'ENOBUFS', status: null,  signal: 'SIGTERM'
 *      git saying no        ->  code: undefined, status: 128,   signal: null
 *      git missing (ENOENT) ->  code: 'ENOENT',  status: null
 *
 *  So a NUMERIC `status` means the process ran to completion and git chose that exit code; anything
 *  else means no verdict was ever returned. Checking `status` rather than `code === 'ENOBUFS'` is
 *  deliberate: it catches the whole class (a missing binary, a timeout kill, a signal) instead of
 *  the one member that prompted it.
 *
 *  ⚠️ Lives in its own module rather than being inlined at each site because a rule implemented
 *  three times diverges (conventions §9) — and the three call sites here each swallow a DIFFERENT
 *  verdict, so the thing they share is exactly this one question and nothing else. */
export function isGitVerdict(error) {
  return typeof error?.status === 'number';
}
