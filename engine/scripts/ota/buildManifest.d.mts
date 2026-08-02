/** Type sidecar for `buildManifest.mjs` — see that file for the design rationale.
 *  Hand-written because the module is plain JS (Node-only, no build step), following
 *  the sibling `.d.mts` convention established by `schema.d.mts`. */

import type { OtaFileEntry } from './schema.mjs';

/** Hashes every file under `distDir` and returns a `{ [relPath]: OtaFileEntry }` map
 *  ready for `createManifest`/`createRelease`. `relPath` uses forward slashes and is
 *  sorted for deterministic manifest.json diffs across builds. */
export function buildManifestFiles(distDir: string): Promise<Record<string, OtaFileEntry>>;
