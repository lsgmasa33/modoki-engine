/** Types for `courtAuthored.mjs` — same pattern as `projectNeedsInstall.d.mts`: the helper is
 *  `.mjs` because `vite.config.ts` loads before any TS pipeline exists to compile it. */

/** Paths a Court test's result depends on. */
export declare const WATCHED: string[];

/** Run a git command in the repo, or `null` if it cannot. */
export declare function git(...args: string[]): string | null;

/** Did `base..HEAD`'s first-parent chain author a commit touching a watched path? `null` = unknown. */
export declare function authoredInRange(
  run: (...args: string[]) => string | null,
  base: string,
): boolean | null;

/** Why a probe could not answer with a boolean (#826). `'no-own-commits'` is the degenerate
 *  `merge-base === HEAD` range — git ANSWERED; HEAD just has nothing beyond `origin/main`. */
export type ScopeUnknown = 'git-failed' | 'no-own-commits';

/** Does this tree/branch author anything Court's tests depend on? A `ScopeUnknown` means "cannot
 *  tell", and every consumer must map it to "run" — test `=== false`, never truthiness (a reason
 *  string is truthy). */
export declare function courtTouched(): boolean | ScopeUnknown;
