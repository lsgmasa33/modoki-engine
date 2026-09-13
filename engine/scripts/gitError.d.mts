/** Type sidecar for gitError.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** Did a thrown `child_process` error come from git RETURNING A VERDICT, or from the process never
 *  completing at all? (#1120, #1127)
 *
 *  A verdict is a numeric `status` with NO `code` — 128 for "not in this tree" — so
 *  the throw carries an answer a caller may legitimately swallow. Anything else means no verdict was
 *  returned. `status` alone is not enough: an overflowing read whose child had already exited
 *  carries `code:'ENOBUFS'` AND `status:0` (measured, #1127). Swallowing a non-verdict is what
 *  reported a long-committed scene as untracked and emitted empty release notes at exit 0.
 *
 *  Takes `unknown` because a `catch` binding is `unknown` under this repo's TS config, and the
 *  whole point is to be asked from inside one. */
export function isGitVerdict(error: unknown): boolean;
