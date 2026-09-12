/** Type sidecar for gitError.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** Did a thrown `child_process` error come from git RETURNING A VERDICT, or from the process never
 *  completing at all? (#1120)
 *
 *  A NUMERIC `status` means git ran and chose that exit code — 128 for "not in this tree" — so the
 *  throw carries an answer a caller may legitimately swallow. Anything else means no verdict was
 *  returned: measured, exceeding `maxBuffer` gives `code:'ENOBUFS', status:null`, and a missing
 *  binary gives `ENOENT`. Swallowing THOSE is what reported a long-committed scene as untracked and
 *  emitted empty release notes at exit 0.
 *
 *  Takes `unknown` because a `catch` binding is `unknown` under this repo's TS config, and the
 *  whole point is to be asked from inside one. */
export function isGitVerdict(error: unknown): boolean;
