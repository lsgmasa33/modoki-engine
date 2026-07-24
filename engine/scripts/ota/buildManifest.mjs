/** Builds an OTA bundle manifest from a built `dist/` directory: walks every
 *  file, sha256-hashes its contents, and assembles the {@link createManifest}
 *  shape. Node-only (fs). */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createManifest } from './schema.mjs';

function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function walk(dir, root, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, root, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  }
}

/** Hashes every file under `distDir` and returns `{ name, version, engineApi,
 *  files }` ready for `createManifest`/`createRelease`. `engineApi` is passed
 *  in by the caller (the publish CLI), not derived here — it comes from the
 *  engine's own version source of truth (`runtime/version.ts`), which this
 *  module deliberately does not import to stay dist-shape-agnostic. */
export async function buildManifestFiles(distDir) {
  const relPaths = [];
  await walk(distDir, distDir, relPaths);
  relPaths.sort(); // deterministic file order — stable manifest.json diffs across builds
  const files = {};
  for (const rel of relPaths) {
    const abs = path.join(distDir, rel);
    const [hash, { size }] = await Promise.all([hashFile(abs), stat(abs)]);
    files[rel] = { hash, size };
  }
  return files;
}
