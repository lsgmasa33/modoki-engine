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

/** Does this tree/branch author anything Court's tests depend on? `null` = cannot tell, and every
 *  consumer must map `null` to "run". */
export declare function courtTouched(): boolean | null;
