/** Environment (HDR) conversion service (runs in Node — dev server + build).
 *
 *  Pipeline: decode the source Radiance `.hdr` (three's HDRLoader.parse — robust,
 *  handles RLE + flat), area-average downscale to the settings' maxSize (in linear
 *  radiance space), and re-encode a smaller `.hdr` (hand-rolled RGBE — see
 *  hdr-codec.ts). Output lands in the content cache (env-cache.ts). Cache hits skip
 *  all work. Dependency-free — no ImageMagick / native tool (unlike toktx for KTX2). */

import fs from 'fs';
import path from 'path';
import type { EnvImportSettings } from '../packages/modoki/src/runtime/loaders/environmentSettings';
import { envTargetDims, downscaleRGBA, encodeHDR, readHdrHeaderDims } from './hdr-codec';
import { getEnvCacheDir, envHashKey, envCachePathFor, envCacheHit } from './env-cache';

export interface EnvConvertOptions {
  projectRoot: string;
  /** Source URL path, e.g. /games/x/assets/environment/studio.hdr */
  sourceUrlPath: string;
  /** Absolute filesystem path to the source `.hdr`. */
  absSource: string;
  settings: EnvImportSettings;
}

export interface EnvConvertResult {
  hash: string;
  cached: boolean;
  /** Downscaled (output) dims. */
  width: number;
  height: number;
  /** Original source dims (pre-downscale). */
  srcWidth: number;
  srcHeight: number;
  /** On-disk byte size of the produced `~env.hdr` variant. */
  bytes: number;
}

/** Decode a Radiance `.hdr` to RGBA Float32 via three's HDRLoader (dynamic-imported
 *  so three isn't pulled into the plugin's top-level bundle — mirrors the rigged
 *  converter's lazy @gltf-transform import). */
async function decodeHDR(srcBytes: Buffer): Promise<{ data: Float32Array; width: number; height: number }> {
  const { HDRLoader } = await import('three/examples/jsm/loaders/HDRLoader.js');
  const loader = new HDRLoader();
  (loader as unknown as { type: number }).type = 1015; // THREE.FloatType — decode to float
  const ab = srcBytes.buffer.slice(srcBytes.byteOffset, srcBytes.byteOffset + srcBytes.byteLength);
  const tex = loader.parse(ab as ArrayBuffer) as { data: Float32Array | Uint16Array; width: number; height: number };
  // With type=FloatType the data is a Float32Array; guard in case a three build
  // returns half-float (Uint16) — convert would be needed, but FloatType is honored.
  const data = tex.data instanceof Float32Array ? tex.data : Float32Array.from(tex.data as Uint16Array);
  return { data, width: tex.width, height: tex.height };
}

/** Convert one source HDR into its downscaled `~env.hdr` variant in the content
 *  cache. Returns the hash + dims/size to persist in the meta. */
export async function convertEnvironment(opts: EnvConvertOptions): Promise<EnvConvertResult> {
  const { projectRoot, sourceUrlPath, absSource, settings } = opts;
  const srcBytes = fs.readFileSync(absSource);
  const hash = envHashKey(srcBytes, settings);
  const cacheDir = getEnvCacheDir(projectRoot);
  const outPath = envCachePathFor(cacheDir, sourceUrlPath, hash);

  // Cache-hit FAST PATH: skip the expensive full HDR decode — read the src + variant
  // dims cheaply from their headers (only decode if a header parse unexpectedly fails).
  if (envCacheHit(cacheDir, sourceUrlPath, hash)) {
    const srcDims = readHdrHeaderDims(srcBytes);
    const outDims = readHdrHeaderDims(fs.readFileSync(outPath));
    if (srcDims && outDims) {
      return { hash, cached: true, width: outDims.width, height: outDims.height, srcWidth: srcDims.width, srcHeight: srcDims.height, bytes: fs.statSync(outPath).size };
    }
  }

  const { data, width: srcW, height: srcH } = await decodeHDR(srcBytes);
  const { width: tw, height: th } = envTargetDims(srcW, srcH, settings.maxSize);

  // Re-check the hit (covers the rare header-parse-failed fall-through above).
  if (envCacheHit(cacheDir, sourceUrlPath, hash)) {
    return { hash, cached: true, width: tw, height: th, srcWidth: srcW, srcHeight: srcH, bytes: fs.statSync(outPath).size };
  }

  const downscaled = downscaleRGBA(data, srcW, srcH, tw, th);
  const out = encodeHDR(downscaled, tw, th);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out);
  return { hash, cached: false, width: tw, height: th, srcWidth: srcW, srcHeight: srcH, bytes: out.length };
}
