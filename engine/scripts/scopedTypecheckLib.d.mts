/** Type sidecar for `scopedTypecheckLib.mjs` — see that file for the design rationale.
 *  Hand-written for the same reason `projectRoots.d.mts` is: the module is plain JS (its main
 *  consumer is a Node script that cannot import TypeScript), but `typecheckProjectsSelection.test.ts`
 *  imports it and is typechecked by `engine/tsconfig.test.json`. A `@ts-expect-error` was the
 *  alternative and it is worse — it suppresses every future type error in the same import, and it
 *  went stale immediately (the directive landed on the comment line, not the import). */

/** Files whose change alters the scoped-config SHAPE for every project, touched or not, and so
 *  escalate the selection to a full sweep. Repo-relative POSIX paths. */
export declare const MACHINERY_PATHS: readonly string[];

/** How many of `dirAbs`'s own AUTHORED files appear in a `tsc --listFiles` dump.
 *  Installed/built output (`node_modules`, `dist`) is excluded. */
export declare function countProgramFiles(listed: string, dirAbs: string): number;

/** Labels of projects OTHER than `self` whose files reached the program — the proof that a
 *  scoped config is actually scoped. */
export declare function foreignProjects(
  listed: string,
  projects: readonly { root: string; name: string; dir: string }[],
  self: string,
): string[];

/** The sanctioned cross-project imports, keyed by consumer label (`'games/chess'`). Mirrors
 *  `KNOWN_ESCAPES` in `engine/tests/assets/gamePortability.test.ts`, guarded against drift. */
export declare const KNOWN_CROSS_PROJECT: Readonly<Record<string, readonly string[]>>;

/** Drop absolute-path lines from tsc output, so a diagnostic is not buried under `--listFiles`. */
export declare function stripFileList(text: string): string;
