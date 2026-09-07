/** Type sidecar for pathIdentity.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** The canonical SPELLING of `p`: resolved, and realpath'd via `fs.realpathSync.native` where the
 *  path exists (falling back to `path.resolve` where it does not). A usable path, NOT a
 *  case-folded comparison key — the fold lives in `samePath`. */
export declare function canonicalPath(p: string): string;

/** Do `a` and `b` name the same directory or file? Canonicalises both sides and compares
 *  case-insensitively on win32/darwin. Answers sameness, not trust — gate an untrusted side
 *  first (`deviceClaimsStore.isFullyQualified` is the worked example). */
export declare function samePath(a: string, b: string): boolean;
