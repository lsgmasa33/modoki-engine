/** Type sidecar for pathIdentity.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** The canonical SPELLING of `p`: resolved, and realpath'd via `fs.realpathSync.native` where the
 *  path exists (falling back to `path.resolve` where it does not). A usable path, NOT a
 *  case-folded comparison key — the fold lives in `samePath`.
 *
 *  ⚠️ **This is the spelling canonicaliser, not the comparison one** (#892). Its `resolve`
 *  fallback follows no symlinks, so do NOT build a predicate on it — use `samePath` /
 *  `isUnderOrSame`, which compare in a space that resolves links even for a missing path. */
export declare function canonicalPath(p: string): string;

/** Do `a` and `b` name the same directory or file? Canonicalises both sides — resolving links in
 *  the longest EXISTING ancestor and re-appending the missing tail, so a symlinked, junctioned or
 *  `subst`ed spelling matches whether or not the path exists (#892) — and compares
 *  case-insensitively on win32/darwin. Answers sameness, not trust — gate an untrusted side
 *  first (`deviceClaimsStore.isFullyQualified` is the worked example). */
export declare function samePath(a: string, b: string): boolean;

/** The comparison KEY for an already-canonical path (or a single segment) on this platform:
 *  case-folded on win32/darwin, identity elsewhere. Exported for lookups rather than
 *  comparisons (`backendPortForClone`, #881). Folds case and nothing else — feed it
 *  `canonicalPath()` output, not a raw relative path. */
export declare function pathCaseKey(s: string): string;

/** Is `child` the same path as `parent`, or inside it? (#881) Canonicalises and folds BOTH sides
 *  before `path.relative`, which folds case on win32 but NOT on darwin. Includes equality —
 *  `electron/projects.ts`'s `isUnderRepo` answers STRICT containment and stays separate. */
export declare function isUnderOrSame(parent: string, child: string): boolean;
