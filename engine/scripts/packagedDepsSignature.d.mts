/** Type sidecar for packagedDepsSignature.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** The lockfile's linked workspace packages as `[lockfile key, absolute package dir]`, sorted by key. */
export declare function linkedPackages(repoRoot: string): Array<[string, string]>;

/** 16 hex chars over the root lockfiles' bytes and every linked package's key, file paths and file
 *  bytes (#2064). Skips nested `node_modules/` and dot-directories; throws when a linked dir is missing. */
export declare function packagedDepsSignature(repoRoot: string): string;
