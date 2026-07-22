#!/usr/bin/env node
/** Delete orphaned hash directories from the texture cache.
 *
 *  The texture-convert plugin keeps every (source, settings, encoder-version)
 *  permutation it has ever produced under the project's own
 *    .cache/modoki-textures/<urlPath>/<hash>/<variant>.<ext>
 *  Bumping the encoder version (e.g. the mult-of-4 snap) leaves the old hash
 *  dirs behind, taking disk + risking confusion. This script reads each
 *  source's `.meta.json` sidecar to find the currently-referenced hash and
 *  deletes every sibling hash dir.
 *
 *  Idempotent. Safe to re-run. Use `--dry-run` to preview.
 *
 *  Usage:
 *    node scripts/clean-texture-cache.mjs            # delete orphans
 *    node scripts/clean-texture-cache.mjs --dry-run  # report only
 */

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectAssetRoots } from './projectRoots.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// engine/scripts/ → repo root (node_modules + games live at the repo root; the
// engine package lives under engine/).
const ROOT = resolve(__dirname, '..', '..');
const CACHE_DIR = join(ROOT, '.cache/modoki-textures');
const DRY_RUN = process.argv.includes('--dry-run');

if (!existsSync(CACHE_DIR)) {
  console.log(`[clean-texture-cache] no cache at ${CACHE_DIR} — nothing to do.`);
  process.exit(0);
}

/** Mirror of `findAssetRoots()` in plugins/vite-asset-scanner.ts. URL prefix →
 *  filesystem dir. Same convention everywhere. */
async function findAssetRoots() {
  const roots = [];
  const modokiAssets = join(ROOT, 'engine/packages/modoki/src/runtime/assets');
  if (existsSync(modokiAssets)) roots.push({ urlPrefix: '/modoki/assets', absDir: modokiAssets });
  // Every project under games/ + demos/ — see engine/scripts/projectRoots.mjs.
  roots.push(...projectAssetRoots(ROOT));
  return roots;
}

/** Map a URL path (e.g. `/games/3d-test/assets/.../rock.png`) back to its
 *  absolute filesystem path. Returns null when no asset root claims it. */
function urlToAbs(urlPath, roots) {
  const cleaned = urlPath.startsWith('/') ? urlPath : '/' + urlPath;
  for (const root of roots) {
    if (cleaned.startsWith(root.urlPrefix + '/')) {
      return resolve(root.absDir, cleaned.substring(root.urlPrefix.length + 1));
    }
  }
  return null;
}

/** The URL path of a cache subdir, reconstructed by stripping the cache root
 *  and dropping the trailing `<hash>` segment. */
function cacheDirToUrlPath(absSourceCacheDir) {
  return '/' + absSourceCacheDir.substring(CACHE_DIR.length + 1).replace(/\\/g, '/');
}

/** Walk the cache tree to find every `<source>/<hash>/` directory. We detect
 *  "source" dirs by their children: a source dir contains only short-hex
 *  subdirs (the hashes); anything else is an intermediate URL-path segment.
 *  Resilient to per-game asset trees of arbitrary depth. */
async function* walkSourceDirs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (subdirs.length === 0) return;
  // A hash dir is hex, length 16 (texture-cache.ts truncates the sha256 to 16).
  const hashRe = /^[0-9a-f]{16}$/;
  if (subdirs.every((n) => hashRe.test(n))) {
    yield { sourceDir: dir, hashDirs: subdirs };
    return;
  }
  for (const n of subdirs) yield* walkSourceDirs(join(dir, n));
}

const roots = await findAssetRoots();
let kept = 0;
let removed = 0;
let bytesFreed = 0;
const warnings = [];

async function dirSize(p) {
  let total = 0;
  for (const entry of await readdir(p, { withFileTypes: true })) {
    const full = join(p, entry.name);
    if (entry.isFile()) total += (await stat(full)).size;
    else if (entry.isDirectory()) total += await dirSize(full);
  }
  return total;
}

for await (const { sourceDir, hashDirs } of walkSourceDirs(CACHE_DIR)) {
  const urlPath = cacheDirToUrlPath(sourceDir);
  const absSource = urlToAbs(urlPath, roots);
  if (!absSource) {
    // Source removed entirely from the project — drop the whole tree.
    const size = await dirSize(sourceDir);
    if (DRY_RUN) console.log(`[orphan]  ${urlPath}  (${hashDirs.length} hash dirs, ${fmtBytes(size)})  — source missing on disk`);
    else { await rm(sourceDir, { recursive: true, force: true }); console.log(`[removed] ${urlPath}  (source missing)`); }
    removed += hashDirs.length;
    bytesFreed += size;
    continue;
  }
  let currentHash = null;
  const metaPath = absSource + '.meta.json';
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
      currentHash = meta?.textureCache?.hash ?? null;
    } catch (e) {
      warnings.push(`unparseable meta ${metaPath}: ${e.message}`);
    }
  }
  for (const h of hashDirs) {
    if (h === currentHash) { kept++; continue; }
    const hashDir = join(sourceDir, h);
    const size = await dirSize(hashDir);
    if (DRY_RUN) console.log(`[orphan]  ${urlPath}/${h}  ${fmtBytes(size)}  (current hash: ${currentHash ?? 'none'})`);
    else { await rm(hashDir, { recursive: true, force: true }); console.log(`[removed] ${urlPath}/${h}  ${fmtBytes(size)}`); }
    removed++;
    bytesFreed += size;
  }
}

console.log(
  `\n${DRY_RUN ? '[dry-run] would remove' : '[done] removed'} ${removed} hash dir(s) ` +
  `(${fmtBytes(bytesFreed)}); kept ${kept}.` +
  (warnings.length ? `  ${warnings.length} warning(s).` : ''),
);
for (const w of warnings) console.warn('  ' + w);

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
