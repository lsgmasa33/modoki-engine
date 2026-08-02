/** Type sidecar for `zip.mjs` — see that file for the design rationale.
 *  Hand-written because the module is plain JS (Node-only, `node:zlib`), following
 *  the sibling `.d.mts` convention established by `schema.d.mts`. */

/** One file to write into the archive: `path` relative, forward-slash, no leading
 *  "/"; `data` the raw file contents. */
export interface OtaZipEntry {
  path: string;
  data: Buffer;
}

/** Builds a ZIP archive buffer from `entries` (local file headers + central
 *  directory + EOCD, STORED or DEFLATE per entry). */
export function buildZip(entries: OtaZipEntry[]): Buffer;

/** Builds a ZIP from every file under `distDir`, given the files' paths relative to
 *  it (forward-slash) — a thin convenience over `buildZip` for `ota-publish.mjs`. */
export function buildZipFromDir(distDir: string, relPaths: string[]): Promise<Buffer>;
