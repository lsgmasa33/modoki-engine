/** Type sidecar for clonePort.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

export declare const DEFAULT_SLOTS: number;

/** Stable offset in `0 .. slots-1` for an absolute repo path. */
export declare function clonePortOffset(repoRoot: string, slots?: number): number;

/** Derived port for a clone rooted at `repoRoot`, in `base .. base+slots-1`. */
export declare function clonePort(repoRoot: string, base: number, slots?: number): number;

/** This repo's root (parent of engine/). */
export declare function defaultRepoRoot(): string;
