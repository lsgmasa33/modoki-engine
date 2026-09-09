/** Type sidecar for toolchainRoot.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** Top-level entries the toolchain provisions into its own root. Mirrors `toolOwnedDirs()` in
 *  `engine/toolchain/index.ts` (which is typed and cannot be imported from a `.mjs`); the mirror is
 *  guarded by a test that enumerates `TOOL_IDS` and calls the real function, not by hand. */
export declare const TOOLCHAIN_OWNED_ENTRIES: ReadonlySet<string>;

/** Why `dir` must not be removed as a toolchain root — `not-a-directory` (it is a file), or
 *  `foreign` with the SORTED top-level entries the toolchain does not own. */
export interface ToolchainRootRefusal {
  kind: 'not-a-directory' | 'foreign';
  entries: string[];
}

/** The refusal, or `null` when `dir` may be removed. ABSENT and UNREADABLE both return `null`:
 *  absence is not evidence of a foreign directory, and `findDeleteBoundaries` owns the unreadable
 *  case (something unreadable must never authorise a delete).
 *
 *  ⚠️ Asks about CONTENTS on purpose (#1005). The `basename === 'toolchain'` test it replaces was
 *  wrong in both directions, and a `samePath` against `process.env.MODOKI_TOOLCHAIN_DIR` would be
 *  vacuous — `uninstallAll`'s only production caller passes exactly that value in. */
export declare function toolchainRootRefusal(dir: string): ToolchainRootRefusal | null;

/** One refusal message a human can act on. ⚠️ Never tells them to delete the subject — the
 *  realistic one is a home directory or a repo root. */
export declare function describeToolchainRootRefusal(dir: string, r: ToolchainRootRefusal): string;
