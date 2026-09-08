/** Type sidecar for repoCorpus.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** One matched file: `rel` is git's own repo-relative POSIX path, `abs` is `rel` joined onto
 *  `repoRoot()`. */
export interface RepoCorpusFile {
  rel: string;
  abs: string;
}

export interface RepoFilesOptions {
  /** Repo-relative POSIX prefix(es), OR an absolute path inside the work tree — the absolute form
   *  exists so callers holding a directory from `discoverProjects()`/`findAssetRoots()` never have
   *  to write `path.relative(ROOT, dir).split(path.sep).join('/')`, which is the `node:path`
   *  round-trip this module exists to delete. Matched case-insensitively, segment by segment. */
  under?: string | string[];
  /** Tested against `rel`. A `g`/`y` flag is stripped before use — `.test()` on a sticky RegExp
   *  is stateful and would silently drop every other file when used as a filter predicate. */
  match?: RegExp | ((rel: string) => boolean);
  /** Path segment names to drop wholesale. No default — see the `.mjs` doc-block. */
  exclude?: Iterable<string>;
  /** Required: throws if the final matched count is below this. */
  floor: number;
  /** `true` (default) also enumerates untracked-but-not-ignored files; `false` restricts to
   *  git's index (`--cached` only) — see the `.mjs` doc-block. */
  includeUntracked?: boolean;
}

/** The repo root, as an absolute POSIX path (cached per process). */
export declare function repoRoot(): string;

/** The repo's file corpus, filtered per `options`. Sorted by `rel`. */
export declare function repoFiles(options: RepoFilesOptions): RepoCorpusFile[];
