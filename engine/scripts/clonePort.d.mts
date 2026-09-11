/** Type sidecar for clonePort.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

export declare const DEFAULT_SLOTS: number;

/** The hash INPUT for a repo path: one directory → one key, whatever separators the caller's
 *  shell spelled it with. Exported so its three behaviours are testable on every platform —
 *  through `clonePortOffset` alone they are only falsifiable on win32. */
export declare function canonicalRepoKey(repoRoot: string): string;

/** Stable offset in `0 .. slots-1` for an absolute repo path. */
export declare function clonePortOffset(repoRoot: string, slots?: number): number;

/** Derived port for a clone rooted at `repoRoot`, in `base .. base+slots-1`. */
export declare function clonePort(repoRoot: string, base: number, slots?: number): number;

/** This repo's root (parent of engine/). */
export declare function defaultRepoRoot(): string;
