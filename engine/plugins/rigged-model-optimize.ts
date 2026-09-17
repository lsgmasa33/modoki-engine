/** Rigged-model converter (runs in Node — dev reimport + build).
 *
 *  The static model pipeline (`convertModel` in model-convert.ts) is wrong for
 *  skeletal GLBs: it STRIPS embedded textures (static models rebuild materials
 *  from sidecar `.mat.json`) and flattens the node hierarchy for the per-mesh
 *  `.mesh.json` path. A rigged GLB must stay WHOLE — bones, skeleton, bind
 *  matrices, clips, AND its embedded textures.
 *
 *  So rigged GLBs get this much simpler converter, which — exactly like
 *  `convertModel` — derives a NEW optimized GLB into the gitignored model cache
 *  and NEVER touches the committed source:
 *    1. resize embedded textures to the texture setting's maxSize (downscale)
 *    2. KTX2-compress them (gltf-transform `uastc`/`etc1s`, via toktx)
 *    3. meshopt-compress geometry + animation (EXT_meshopt_compression — the
 *       runtime already wires MeshoptDecoder)
 *  All passes preserve skinning + clips.
 *
 *  The derived GLB is the cache `processed.glb` (content-hashed on source bytes
 *  + texture settings + encoder version), served in dev by the same
 *  `<src>.glb.processed.glb` middleware as static models, copied to `dist/` at
 *  build, and resolved at runtime via the `modelCache.processedPath` URL. The
 *  raw source GLB stays committed and untouched — mirroring the static pattern.
 *
 *  CLI invocation mirrors model-convert.ts (`npx --no-install
 *  @gltf-transform/cli ...`), proven in this codebase for the static path. */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { detect as detectTool, forgetDetection, withToolOnPath, resetToolchainCache, gltfTransformInvocation, spawnable } from '../toolchain';
import { resolveUastcLevel, resolveUastcRdoLambda, type TextureImportSettings } from '../packages/modoki/src/runtime/loaders/textureSettings';
import {
  getModelCacheDir, processedCachePath, cacheDirFor, cacheHit, MODEL_PIPELINE_VERSION,
} from './model-cache';
import type { ConversionFailure } from './asset-conversion-strict';

/** Bump when the conversion recipe changes (passes, flags, tool expectations)
 *  so the content hash changes and previously-derived cache GLBs regenerate.
 *  v2: added the submesh-merge pass (joinPrimitives by material). */
/** v3 (#1337/#1351): retires entries a swallowed KTX2 failure published as raw textures under the
 *  with-toktx key, and ones an unpinned PATH `ktx` encoded — neither is distinguishable by its key. */
export const RIGGED_ENCODER_VERSION = 3;

const GLTF_TRANSFORM_MISSING_MSG =
  "@gltf-transform/cli not found. Install it from the editor's Build Support dialog, or `npm i -D @gltf-transform/cli`.";
const TOKTX_MISSING_MSG =
  'toktx (KTX-Software CLI) is not provisioned — needed for KTX2 texture compression. Asset conversion ' +
  'uses only the pinned copy, never one on PATH (#1327): install it from Build → Build Support…, or run ' +
  '`npm run toolchain:install -- toktx msdf-atlas-gen`.';

let gltfTransformOk: boolean | null = null;
let gltfTransformVersion = '';
let toktxOk: boolean | null = null;
let toktxVersion = '';
let toktxDir = '';

/** For tests — forget cached CLI-availability probes. */
export function __resetRiggedCliChecks(): void {
  gltfTransformOk = null;
  gltfTransformVersion = '';
  toktxOk = null;
  toktxVersion = '';
  toktxDir = '';
  resetToolchainCache();
}

function ensureGltfTransformCli(): void {
  if (gltfTransformOk === null) {
    try {
      const inv = gltfTransformInvocation();
      const s = spawnable(inv.command, [...inv.prefixArgs, '--version']);
      const out = execFileSync(s.command, s.args, { stdio: ['ignore', 'pipe', 'pipe'], shell: s.shell });
      gltfTransformVersion = out.toString().trim();
      gltfTransformOk = true;
    } catch {
      gltfTransformOk = false;
    }
  }
  if (!gltfTransformOk) throw new Error(GLTF_TRANSFORM_MISSING_MSG);
}

/** Probe toktx availability WITHOUT throwing — used both before encoding and when
 *  computing the cache key, so the key reflects whether KTX2 will actually run and
 *  which toktx version produced it (C2/C3: a no-toktx machine's uncompressed output
 *  caches under a DIFFERENT key than a with-toktx machine's, so neither poisons the
 *  other). Resolves toktx via the shared toolchain, honouring MODOKI_TOKTX (the packaged
 *  editor's bundled binary) — NOT bare `toktx` on PATH, which is absent in a dmg. */
function probeToktx(): boolean {
  // A MISS is not cached: toktx is pinned (#1327), so a machine that used to rely on a PATH copy
  // starts without one and gets it from Build Support / `toolchain:install` mid-session — possibly
  // in the other process. A cached miss would ship raw textures until the editor restarted.
  if (!toktxOk) {
    // Forget FIRST: the shared detect cache may hold a miss another caller left there
    // (pinnedConversionCli leaves one after a failed conversion).
    forgetDetection('toktx');
    const d = detectTool('toktx');
    toktxOk = d.present;
    toktxVersion = d.version ?? '';
    toktxDir = d.dir ?? (d.command ? path.dirname(d.command) : '');
  }
  return toktxOk;
}

/** @gltf-transform/cli 4.4 encodes KTX2 with KTX-Software's `ktx`, looked up on PATH — not `toktx`.
 *  `withToolOnPath('toktx')` puts the pinned toktx's dir first, so the pinned `ktx` BESIDE it is what
 *  runs; when that dir has none, the lookup falls through to whatever `ktx` the machine has (an
 *  unpinned encoder under a key naming the pinned toktx), or to nothing. So the encode requires it
 *  (#1351). Returns the error to throw, or null. */
function missingKtxBesideToktx(dir: string): string | null {
  const ktx = path.join(dir, process.platform === 'win32' ? 'ktx.exe' : 'ktx');
  if (dir && fs.existsSync(ktx)) return null;
  return `KTX-Software's \`ktx\` is not provisioned beside toktx${dir ? ` (${dir})` : ''} — gltf-transform encodes ` +
    'KTX2 with it, and asset conversion never uses one from PATH (#1351). Reinstall the pinned copy: ' +
    '`npm run toolchain:install -- toktx msdf-atlas-gen`, or Build → Build Support….';
}

/** For tests — the rigged path's `ktx`-beside-toktx requirement (#1351). */
export { missingKtxBesideToktx as __missingKtxBesideToktx };

/** For tests — the rigged path's own toktx probe (#1327: a miss must not stick). */
export { probeToktx as __probeRiggedToktx };


function runGltfTransform(args: string[], label: string): void {
  try {
    // Resolve the CLI (packaged userData install → PATH; dev → npx --no-install). Its KTX2 passes
    // (uastc/etc1s) spawn `toktx` by bare name, so inject the resolved toktx dir into PATH — makes
    // the packaged bundled toktx (MODOKI_TOKTX) reachable.
    const inv = gltfTransformInvocation();
    const s = spawnable(inv.command, [...inv.prefixArgs, ...args]);
    execFileSync(s.command, s.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: withToolOnPath('toktx'),
      shell: s.shell,
    });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
    throw new Error(`gltf-transform ${label} failed: ${stderr}`, { cause: e });
  }
}

/** Map a modoki TextureFormat to the gltf-transform KTX2 CLI command, or null
 *  for non-KTX2 formats (webp/png — those stay raw; KTX2 is a 3D GPU format).
 *  `ktx2-astc` (native, zero-transcode) has no embedded-GLB equivalent, so it
 *  maps to universal UASTC (transcodes to ASTC on device anyway). */
export function ktxCommandFor(format: TextureImportSettings['format']): 'uastc' | 'etc1s' | null {
  switch (format) {
    case 'ktx2-etc1s': return 'etc1s';
    case 'ktx2-uastc':
    case 'ktx2-astc': return 'uastc';
    case 'webp':
    case 'png': return null;
  }
}

/** KTX2 CLI FLAGS (no command/paths) for a settings combo — the single source of
 *  truth shared by both the encoder invocation AND the cache key, so a flag change
 *  here re-derives the cache (C2) and the two can never drift.
 *
 *  UASTC level + RDO lambda come from the SHARED texture settings
 *  ({@link resolveUastcLevel}/{@link resolveUastcRdoLambda}) — the same knobs the
 *  standalone texture converter uses — reconciling a former inconsistency (this path
 *  hardcoded rdo-lambda 4 vs the texture converter's 1.0). Default is now the shared
 *  1.0 (higher quality; set the RDO λ higher in the Model Inspector to shrink). λ=0
 *  disables RDO (omit --rdo/--rdo-lambda). Zstd level stays fixed at 18. Exported for
 *  unit tests (the reconciled flag vector). */
export function ktxFlags(cmd: 'uastc' | 'etc1s', settings: TextureImportSettings): string[] {
  if (cmd !== 'uastc') return ['--quality', '255', '--mipmaps', String(settings.mipmaps)];
  const rdo = resolveUastcRdoLambda(settings.uastcRdoLambda);
  return [
    '--level', String(resolveUastcLevel(settings.uastcLevel)),
    ...(rdo > 0 ? ['--rdo', '--rdo-lambda', String(rdo)] : []),
    '--zstd', '18',
    '--mipmaps', String(settings.mipmaps),
  ];
}

/** The KTX2 portion of the cache signature: the command + its exact flags (or
 *  'none' for non-KTX2 formats). */
function ktxSignature(settings: TextureImportSettings): string {
  const cmd = ktxCommandFor(settings.format);
  return cmd ? `${cmd} ${ktxFlags(cmd, settings).join(' ')}` : 'none';
}

/** A GLB's JSON chunk, or null for a non-GLB / unparseable one (no full parse / no THREE). */
function glbJson(buf: Buffer): Record<string, unknown> | null {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) return null; // 'glTF' magic
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) return null; // first chunk must be 'JSON'
  try {
    return JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  } catch {
    return null;
  }
}

/** Whether a GLB embeds any image — i.e. whether a KTX2 step has anything to encode. An unreadable
 *  one counts as having images, so a skip is never hidden by a parse failure. Exported for tests. */
export function glbHasImages(buf: Buffer): boolean {
  const json = glbJson(buf);
  return !json || (Array.isArray(json.images) && json.images.length > 0);
}

/** Parse a GLB's `extensionsUsed` from its JSON chunk.
 *  Returns [] for a non-GLB or a glTF without the array. Exported for tests. */
export function glbExtensionsUsed(absPath: string): string[] {
  const json = glbJson(fs.readFileSync(absPath));
  return json && Array.isArray(json.extensionsUsed) ? json.extensionsUsed : [];
}

/** Run the rigged optimization passes from `absInput` → `absOutput`, driven by
 *  modoki texture settings:
 *    resize → max(settings.maxSize)   (downscale only; the 4K hero maps that
 *                                       dominate the payload)
 *    KTX2   → uastc/etc1s per settings.format, honoring settings.mipmaps
 *    meshopt → geometry + animation   (EXT_meshopt_compression)
 *  Skinning (JOINTS/WEIGHTS/skins) + animation clips are preserved by every
 *  pass. Never mutates the input. */
/** Submesh merge — collapse a mesh's same-material primitives into one (Unity-style).
 *  A rigged GLB authored as hundreds of single-poly primitives (e.g. alien-animal's
 *  148 eye prims across 2 materials) becomes one draw call per material per mesh
 *  (215 → 5 here). Only a mesh's primitive LIST is rewritten — skinning
 *  (JOINTS/WEIGHTS), the skeleton, the named mesh nodes, and clips are untouched, so
 *  the runtime's per-node `SkinnedMeshRenderer` material slots still resolve.
 *
 *  Done programmatically with `joinPrimitives` (not the CLI `join`): for a skinned
 *  model with TRS animation the CLI's implicit `flatten` is a no-op, so its `join`
 *  merges 0 within-mesh primitives. Skips a group that isn't join-compatible (mixed
 *  attributes / draw modes) rather than failing the whole conversion. Runs BEFORE
 *  meshopt so the compressor sees the merged geometry. */
async function mergeSubmeshesByMaterial(absInput: string, absOutput: string): Promise<void> {
  const [{ NodeIO }, { ALL_EXTENSIONS }, { joinPrimitives }] = await Promise.all([
    import('@gltf-transform/core'),
    import('@gltf-transform/extensions'),
    import('@gltf-transform/functions'),
  ]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(absInput);
  let before = 0;
  let after = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    const prims = mesh.listPrimitives();
    before += prims.length;
    // Group a mesh's primitives by Material instance (same material = same draw call).
    const byMaterial = new Map<ReturnType<typeof prims[number]['getMaterial']>, typeof prims>();
    for (const p of prims) {
      const mat = p.getMaterial();
      const arr = byMaterial.get(mat);
      if (arr) arr.push(p);
      else byMaterial.set(mat, [p]);
    }
    for (const group of byMaterial.values()) {
      if (group.length <= 1) { after += 1; continue; }
      try {
        const merged = joinPrimitives(group);
        mesh.addPrimitive(merged);
        for (const p of group) p.dispose();
        after += 1;
      } catch (e) {
        after += group.length; // incompatible group → leave unmerged
        console.warn(`[rigged-optimize] submesh-merge skipped a ${group.length}-primitive group: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  await io.write(absOutput, doc);
  console.log(`[rigged-optimize] submesh-merge: ${before} → ${after} primitive(s)`);
}

/** Decide whether the meshopt pass dropped the KTX2 texture extension. Some
 *  @gltf-transform/cli versions' `meshopt` re-serialize without re-registering
 *  KHR_texture_basisu and silently strip it (→ black textures). Fires only when
 *  basisu was ACTUALLY present before meshopt (`basisuBeforeMeshopt`) but is gone
 *  from the output — NOT merely because a KTX2 command ran (a textureless rig
 *  encodes no basisu, so there is nothing to drop). When it fires the pipeline
 *  degrades to the pre-meshopt KTX2 GLB instead of aborting. Pure + exported so the
 *  decision is unit-tested without invoking a real CLI. */
export function meshoptDroppedBasisu(basisuBeforeMeshopt: boolean, outputExtensions: string[]): boolean {
  return basisuBeforeMeshopt && !outputExtensions.includes('KHR_texture_basisu');
}

async function runRiggedPipeline(absInput: string, absOutput: string, settings: TextureImportSettings, toktxAtKey: boolean, toktxDirAtKey: string): Promise<{ ktx2Applied: boolean; meshoptApplied: boolean }> {
  ensureGltfTransformCli();
  let ktx2Applied = false;
  let meshoptApplied = true;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-rig-'));
  try {
    const afterMerge = path.join(tmpDir, 'merged.glb');
    const afterResize = path.join(tmpDir, 'resize.glb');
    const afterTex = path.join(tmpDir, 'tex.glb');

    // 0. Submesh merge (programmatic, geometry-only) — collapse same-material
    //    primitives so meshopt below compresses the merged geometry, not hundreds
    //    of tiny prims. Never touches skinning/skeleton/clips.
    await mergeSubmeshesByMaterial(absInput, afterMerge);

    // 1. Resize to the texture setting's maxSize. --width/--height are MAXIMUMS,
    //    aspect-preserved, and "Texture dimensions are never increased" (verified:
    //    @gltf-transform/cli 4.3.0 `resize --help`) — so a sub-maxSize texture is
    //    left as-is, never upscaled (C11). Re-confirm this guarantee on a CLI bump.
    //    This is the dominant win — a 4096² baseColor/normal is ~18-28 MB of source
    //    PNG (89 MB GPU); capping at 2048 quarters it.
    runGltfTransform(
      ['resize', afterMerge, afterResize, '--width', String(settings.maxSize), '--height', String(settings.maxSize)],
      'resize',
    );
    let texInput = afterResize;

    // 2. KTX2 textures per settings.format (UASTC default — high quality, cheap
    //    transcode to ASTC/BC7 on device). Needs the provisioned toktx. Skipped
    //    (keep raw textures, still meshopt) when toktx is missing or the format is a
    //    non-KTX2 (webp/png) one; an encode that FAILS with toktx present throws (#1337).
    const ktxCmd = ktxCommandFor(settings.format);
    if (ktxCmd) {
      try {
        if (!toktxAtKey) throw new Error(TOKTX_MISSING_MSG);
        const noKtx = missingKtxBesideToktx(toktxDirAtKey);
        if (noKtx) throw new Error(noKtx);
        runGltfTransform([ktxCmd, texInput, afterTex, ...ktxFlags(ktxCmd, settings)], ktxCmd);
        texInput = afterTex;
        ktx2Applied = true;
      } catch (e) {
        // toktx PRESENT but the encode failed: refuse. The cache key already names that toktx, so
        // publishing the raw-texture GLB here would make every later import a cache hit on it (#1337).
        // Throwing discards the staging dir; the build records a conversion failure and a dev
        // reimport surfaces the error.
        if (toktxAtKey) throw e;
        // toktx MISSING: the derived GLB carries RAW textures, cached under the distinct `toktx:` key
        // (riggedHash) so a machine that has toktx never reuses it (C3). convertRiggedModel reports
        // it as `ktx2Skipped` so the production build's strict gate can refuse it.
        console.warn(`[rigged-optimize] KTX2 texture compression SKIPPED (shipping raw textures): ${e instanceof Error ? e.message : e}`);
      }
    }

    // Whether KTX2 actually produced basisu textures to protect. `ktx2Applied`
    // only means the encode COMMAND ran — a textureless rig (e.g. the procedural
    // skinned-test cylinder, vertex-colored only) encodes nothing, so the GLB never
    // gains KHR_texture_basisu. Keying the guard on this (not ktx2Applied) stops the
    // C1 check from firing spuriously on textureless rigs (where there is nothing
    // for meshopt to "drop").
    const basisuBeforeMeshopt = ktx2Applied && glbExtensionsUsed(texInput).includes('KHR_texture_basisu');

    // 3. meshopt geometry + animation LAST. The terminal CLI write must be the
    //    meshopt pass — a later texture pass would re-serialize without
    //    EXT_meshopt_compression and drop the geometry compression. meshopt's IO
    //    preserves the KTX2 image bytes (KHR_texture_basisu passthrough); the
    //    caller asserts that survived (C1). Preserves skinning + animation tracks.
    runGltfTransform(['meshopt', texInput, absOutput], 'meshopt');

    // C1: meshopt must preserve the KTX2 textures (KHR_texture_basisu passthrough).
    // Some @gltf-transform/cli versions' `meshopt` re-serialize WITHOUT re-registering
    // the basisu extension and silently drop it (→ black/broken KTX2 textures). When
    // that happens, DEGRADE GRACEFULLY: publish the pre-meshopt KTX2 GLB (`texInput`,
    // still in tmpDir here) — textures intact, geometry just not meshopt-compressed —
    // instead of throwing, which would leave NO processed.glb at all (404 on every
    // load + a failed build). riggedHash mixes the gltf-transform version, so a CLI
    // that fixes this regenerates under a new key automatically.
    if (meshoptDroppedBasisu(basisuBeforeMeshopt, glbExtensionsUsed(absOutput))) {
      console.warn(
        `[rigged-optimize] meshopt (gltf-transform ${gltfTransformVersion || '?'}) dropped ` +
        'KHR_texture_basisu — shipping the KTX2 GLB WITHOUT meshopt geometry compression to ' +
        'keep textures intact. Pin a gltf-transform whose `meshopt` preserves basisu to restore it.',
      );
      fs.copyFileSync(texInput, absOutput);
      meshoptApplied = false;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return { ktx2Applied, meshoptApplied };
}

/** Content key for the derived rigged GLB. Mixes source bytes + the texture
 *  settings + the EXACT KTX2 flags + the encoder/pipeline versions + the CLI tool
 *  versions (gltf-transform always; toktx only when KTX2 applies, empty when
 *  missing). So a recipe tweak (flags), a tool upgrade, OR toktx going from
 *  absent→present all regenerate instead of silently reusing stale output.
 *  Exported for unit tests (cache-key invalidation). */
export function riggedHash(
  srcBytes: Buffer,
  settings: TextureImportSettings,
  tools: { gltfTransform: string; toktx: string },
): string {
  const ktxCmd = ktxCommandFor(settings.format);
  return createHash('sha256')
    .update(srcBytes).update('\0')
    .update(`${settings.format}|${settings.maxSize}|${settings.mipmaps}`).update('\0')
    .update(ktxSignature(settings)).update('\0')
    .update(`gt:${tools.gltfTransform}`).update('\0')
    .update(ktxCmd ? `toktx:${tools.toktx}` : 'toktx:n/a').update('\0')
    .update(String(RIGGED_ENCODER_VERSION)).update('\0')
    .update(MODEL_PIPELINE_VERSION)
    .digest('hex').slice(0, 16);
}

export interface ConvertRiggedOptions {
  projectRoot: string;
  /** Source URL path, e.g. /games/alien-animal/assets/models/alien-animal.glb */
  sourceUrlPath: string;
  /** Absolute filesystem path to the source GLB. */
  absSource: string;
  settings: TextureImportSettings;
}

export interface ConvertRiggedResult {
  hash: string;
  /** True when the derived GLB was already cached (no work done). */
  cached: boolean;
  /** Absolute path of the derived GLB in the model cache (the `processed.glb`). */
  processedPath: string;
  /** On-disk byte size of the derived GLB. */
  bytes: number;
  /** Set when the settings ask for KTX2 but the GLB carries RAW textures because toktx is not
   *  provisioned — true of a cache hit on such an output too. The build turns it into a
   *  conversion failure (#1337); dev keeps the model loading. */
  ktx2Skipped?: string;
}

/** The strict-gate entry a converted rigged model owes the production build, or null. Raw textures
 *  under a KTX2 format (toktx not provisioned) ship so the model loads, but they are an unoptimized
 *  production asset, so the gate must see them (#1337). */
export function riggedConversionFailure(virtualPath: string, conv: Pick<ConvertRiggedResult, 'ktx2Skipped'>): ConversionFailure | null {
  return conv.ktx2Skipped ? { virtualPath, kind: 'rigged model', error: `KTX2 skipped — ${conv.ktx2Skipped}` } : null;
}

/** Derive the optimized rigged GLB into the content-addressed model cache (the
 *  same cache + `processed.glb` layout `convertModel` uses, so the dev
 *  middleware, build copy, and runtime resolution all reuse the static
 *  plumbing). Cache-aware: a hit short-circuits the encoder calls. The source
 *  GLB is read-only — never mutated. */
export async function convertRiggedModel(opts: ConvertRiggedOptions): Promise<ConvertRiggedResult> {
  ensureGltfTransformCli();
  const { projectRoot, sourceUrlPath, absSource, settings } = opts;
  const srcBytes = fs.readFileSync(absSource);
  // Probe toktx now (best-effort, no throw) so the cache key reflects whether KTX2
  // will run + which toktx produced it (C3). Only relevant when the format is KTX2.
  // Captured ONCE, with the version the key names: the module globals can change under a concurrent
  // import across the awaits below, and the encode must follow the key (#1327).
  const toktxAtKey = ktxCommandFor(settings.format) ? probeToktx() : false;
  const toktxDirAtKey = toktxDir;
  const hash = riggedHash(srcBytes, settings, { gltfTransform: gltfTransformVersion, toktx: toktxAtKey ? toktxVersion : '' });
  const cacheDir = getModelCacheDir(projectRoot);
  const outPath = processedCachePath(cacheDir, sourceUrlPath, hash);
  // An encode that fails WITH toktx throws (never published), so a result under a KTX2 format is
  // raw exactly when toktx was missing at key time — which the key itself records.
  // A textureless rig has nothing to skip (the skinned-test primitives are vertex-coloured).
  const ktx2Skipped = ktxCommandFor(settings.format) && !toktxAtKey && glbHasImages(srcBytes) ? TOKTX_MISSING_MSG : undefined;

  if (cacheHit(cacheDir, sourceUrlPath, hash, 1)) {
    return { hash, cached: true, processedPath: outPath, bytes: fs.statSync(outPath).size, ktx2Skipped };
  }

  // Atomic publish: encode into a staging dir sibling to the final hash dir,
  // then rename into place (mirrors convertModel's torn-write protection for
  // concurrent reimport requests).
  const finalDir = cacheDirFor(cacheDir, sourceUrlPath, hash);
  fs.mkdirSync(path.dirname(finalDir), { recursive: true });
  const stagingDir = `${finalDir}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(stagingDir, { recursive: true });
  const stagedOut = path.join(stagingDir, 'processed.glb');
  let renamed = false;
  try {
    // The pipeline guarantees KTX2 textures survive: meshopt preserves basisu, or
    // (on a CLI version that drops it) the pipeline falls back to the pre-meshopt
    // KTX2 GLB. meshoptApplied=false means that fallback fired — the cached GLB is
    // correct (textures intact), just larger (no geometry compression).
    const { meshoptApplied } = await runRiggedPipeline(absSource, stagedOut, settings, toktxAtKey, toktxDirAtKey);
    if (!meshoptApplied) {
      console.warn(`[rigged-optimize] ${sourceUrlPath}: cached WITHOUT meshopt geometry compression (basisu-preserving fallback).`);
    }
    // Size from the file we just wrote, BEFORE the publish race — a concurrent
    // writer may win the rename so `outPath` could briefly not exist (ENOENT on a
    // post-publish statSync). (C6)
    const bytes = fs.statSync(stagedOut).size;
    try {
      if (fs.existsSync(finalDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
      else fs.renameSync(stagingDir, finalDir);
      renamed = true;
    } catch {
      fs.mkdirSync(finalDir, { recursive: true });
      if (!fs.existsSync(outPath)) fs.copyFileSync(stagedOut, outPath);
      renamed = true;
    }
    return { hash, cached: false, processedPath: outPath, bytes, ktx2Skipped };
  } finally {
    if (!renamed) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
