/** Type sidecar for pathPosix.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** Convert `p` to forward-slash form. Idempotent; safe to call on an already-POSIX path. */
export declare function toPosix(p: string): string;
