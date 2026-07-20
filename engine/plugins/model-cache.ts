/** Content-addressed cache for converted model GLBs.
 *
 *  Derived files are NOT committed — they live under the project's own `.cache/`
 *  (per-game, at the project root; see texture-cache for the node_modules
 *  rationale) and are regenerated on demand (editor Apply / reimport) and at
 *  build time. The cache key is a hash of the source bytes + import settings +
 *  encoder version +
 *  loader id + loader recipe version, so an unchanged GLB + loader is never
 *  re-encoded. Cache layout mirrors the asset URL path:
 *    <cacheDir>/<urlPath>/<hash>/processed.glb
 *    <cacheDir>/<urlPath>/<hash>/lod1.glb
 *    <cacheDir>/<urlPath>/<hash>/lod2.glb
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import {
  MODEL_ENCODER_VERSION,
  type ModelImportSettings,
} from '../packages/modoki/src/runtime/loaders/modelSettings';

/** Bump when the converter pipeline changes shape in a way that all cached
 *  GLBs must be regenerated (e.g. switching default gltf-transform flags). */
export const MODEL_PIPELINE_VERSION = 'mdl-5';

export function getModelCacheDir(projectRoot: string): string {
  return path.join(projectRoot, '.cache', 'modoki-models');
}

function stableSettings(s: ModelImportSettings): string {
  return [
    s.encoder,
    s.lodEncoders?.join(',') ?? '',
    s.lodCount,
    s.lodRatios.join(','), s.lodDistances.join(','),
    s.simplifyError, s.weld,
    s.meshopt, s.lodMeshopt?.join(',') ?? '',
    s.aggressiveSimplify, s.lodAggressive?.join(',') ?? '',
  ].join('|');
}

/** Optional tool-version fingerprints (gltfpack, @gltf-transform/cli,
 *  meshoptimizer). When the caller passes them in, the cache silently
 *  invalidates after a tool upgrade — otherwise the user has to bump
 *  MODEL_PIPELINE_VERSION manually. */
export interface ToolVersions {
  gltfpack?: string;
  gltfTransform?: string;
  meshopt?: string;
}

/** Stable 16-hex content key. Mixes:
 *   - source GLB bytes
 *   - import settings
 *   - MODEL_ENCODER_VERSION (settings module bump)
 *   - MODEL_PIPELINE_VERSION (this cache module bump)
 *   - postprocessor id + recipe version (so fixup code changes invalidate)
 *   - CLI tool versions (gltfpack / gltf-transform / meshoptimizer) so a
 *     tool upgrade transparently re-encodes
 */
export function hashKey(
  srcBytes: Buffer,
  settings: ModelImportSettings,
  postprocessorId: string,
  recipeVersion: number,
  tools?: ToolVersions,
): string {
  return createHash('sha256')
    .update(srcBytes).update('\0')
    .update(stableSettings(settings)).update('\0')
    .update(String(MODEL_ENCODER_VERSION)).update('\0')
    .update(MODEL_PIPELINE_VERSION).update('\0')
    .update(postprocessorId).update('\0')
    .update(String(recipeVersion)).update('\0')
    .update(tools?.gltfpack ?? '').update('\0')
    .update(tools?.gltfTransform ?? '').update('\0')
    .update(tools?.meshopt ?? '')
    .digest('hex').slice(0, 16);
}

/** Cache directory for a specific (source, hash) pair. */
export function cacheDirFor(cacheDir: string, sourceUrlPath: string, hash: string): string {
  const rel = sourceUrlPath.replace(/^\/+/, '');
  return path.join(cacheDir, rel, hash);
}

/** Absolute path of the LOD0 (processed) GLB. */
export function processedCachePath(cacheDir: string, sourceUrlPath: string, hash: string): string {
  return path.join(cacheDirFor(cacheDir, sourceUrlPath, hash), 'processed.glb');
}

/** Absolute path of a LOD GLB (level >= 1). LOD0 is `processedCachePath`. */
export function lodCachePath(cacheDir: string, sourceUrlPath: string, hash: string, level: number): string {
  if (level === 0) return processedCachePath(cacheDir, sourceUrlPath, hash);
  return path.join(cacheDirFor(cacheDir, sourceUrlPath, hash), `lod${level}.glb`);
}

/** glTF 2.0 binary magic — first 4 bytes of a `.glb` file are ASCII "glTF". */
const GLB_MAGIC = Buffer.from('glTF', 'ascii');

/** True when every LOD level the settings ask for is present AND looks like a
 *  real GLB. We check magic bytes + non-zero size because a SIGKILL during a
 *  previous conversion can leave 0-byte or partially-written files that
 *  `fs.existsSync` happily accepts — the runtime then loads an empty GLB and
 *  silently renders nothing. */
export function cacheHit(
  cacheDir: string,
  sourceUrlPath: string,
  hash: string,
  lodCount: number,
): boolean {
  for (let i = 0; i < lodCount; i++) {
    const p = lodCachePath(cacheDir, sourceUrlPath, hash, i);
    if (!isValidGlb(p)) return false;
  }
  return true;
}

/** Remove sibling `<hash>/` dirs for the SAME source that aren't the current
 *  hash. The cache is content-addressed, so once a fresh hash is baked the older
 *  ones (from a prior recipeVersion / settings / tool upgrade) are dead weight —
 *  without pruning they accumulate one dir per change, forever (the 3d-test
 *  island had 28). Best-effort: only touches dirs whose name is a 16-hex hash
 *  (never a `.tmp-*` staging dir or an unexpected sibling), and a locked/in-use
 *  dir is skipped rather than fatal. Returns the count removed. */
export function pruneStaleCacheDirs(cacheDir: string, sourceUrlPath: string, currentHash: string): number {
  const rel = sourceUrlPath.replace(/^\/+/, '');
  const parent = path.join(cacheDir, rel);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); }
  catch { return 0; } // parent missing → nothing to prune
  let pruned = 0;
  for (const e of entries) {
    if (!e.isDirectory() || e.name === currentHash) continue;
    if (!/^[0-9a-f]{16}$/.test(e.name)) continue; // skip staging/tmp + anything unexpected
    try { fs.rmSync(path.join(parent, e.name), { recursive: true, force: true }); pruned++; }
    catch { /* in-use / permission — leave it, it'll be re-pruned next bake */ }
  }
  return pruned;
}

function isValidGlb(absPath: string): boolean {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size < 12) return false; // 12 = GLB header size
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    return buf.equals(GLB_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}
