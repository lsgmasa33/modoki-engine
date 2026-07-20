/** Model import settings — single source of truth shared by the editor Model
 *  Inspector, the dev-server conversion service, the build tree-shaker, and the
 *  runtime mesh-template cache (which reads `modelCache.lodPaths` to decide
 *  whether to wrap a mesh in `THREE.LOD`).
 *
 *  Settings live in a GLB's `.meta.json` sidecar (`model` block) and the
 *  conversion service writes its post-conversion bookkeeping back into the
 *  same sidecar (`modelCache` block). The runtime reads both blocks via the
 *  asset manifest — no extra per-file fetch.
 *
 *  This module is pure data + a pair of helpers; everything heavy (CLI flag
 *  building, cache hashing, gltf-transform invocation) lives in `plugins/`.
 */

export type ModelEncoder = 'gltf-transform' | 'gltfpack';
export type LodCount = 1 | 2 | 3;

export interface ModelImportSettings {
  /** Default CLI for any LOD without a per-LOD override (`lodEncoders[i]`
   *  empty). `gltf-transform` is the modular default (geometry ops only —
   *  texture compression is owned by the texture pipeline); `gltfpack` is
   *  the aggressive single-pass option for hero assets. */
  encoder: ModelEncoder;
  /** Per-LOD encoder override (length up to `lodCount`). When an entry is
   *  set, it overrides `encoder` for that level; when empty, falls back to
   *  `encoder`. Common pattern: gltf-transform for LOD0 (preserves quality
   *  + mesh names), gltfpack for LOD1/LOD2 (aggressive count reduction).
   *  Optional — leave undefined for "same encoder for every LOD". */
  lodEncoders?: ModelEncoder[];
  /** How many LOD levels to bake. 1 = no simplification, just the processed
   *  source. 2 = LOD0 + LOD1. 3 = LOD0 + LOD1 + LOD2 (default). */
  lodCount: LodCount;
  /** Per-LOD triangle ratio (length === lodCount). `1.0` = pass the
   *  fixup-baked source through unchanged; values < 1.0 run simplification
   *  for that level (via `--ratio` for gltf-transform `simplify`, or `-si`
   *  for gltfpack). Default keeps LOD0 at 1.0, but artists can drop it for
   *  a global tri budget. */
  lodRatios: number[];
  /** Per-LOD switch distance in world units (length === lodCount). The runtime
   *  passes these to `THREE.LOD.addLevel`. */
  lodDistances: number[];
  /** gltf-transform `--error`: max allowed deviation as a fraction of mesh
   *  radius. The simplifier QUITS once this budget is hit, even if the
   *  target ratio hasn't been reached — so a tight error caps how far ratio
   *  can drive the tri count. Defaults to 0.5 (loose, lets ratio drive);
   *  drop toward 0.01 for hero meshes that must hold shape, or set to 1.0
   *  for fully unconstrained-by-error simplification. */
  simplifyError: number;
  /** Collapse coincident vertices before simplification — usually a quality
   *  win, but can break hard edges on stylized assets. */
  weld: boolean;
  /** Default meshopt (`-cc`) flag for gltfpack LODs without a `lodMeshopt`
   *  override. Quantizes + reorders buffers (EXT_meshopt_compression). */
  meshopt: boolean;
  /** Per-LOD meshopt override (gltfpack only). Length up to `lodCount`. When
   *  set, overrides `meshopt` for that level; when undefined, falls back to
   *  the global default. Lets you keep LOD0 meshopt-compressed for download
   *  size while shipping LOD2 as raw bytes (or vice versa). */
  lodMeshopt?: boolean[];
  /** Default aggressive flag for gltfpack LODs without a `lodAggressive`
   *  override. `false` = `-slb` (lock borders, conservative); `true` = `-sa`
   *  (drop attribute-split protection to actually hit the target ratio).
   *  Conservative stalls at ~50% reduction on assets with split normals;
   *  aggressive hits the ratio at the cost of visible seam quality. */
  aggressiveSimplify: boolean;
  /** Per-LOD aggressive override (gltfpack only). Length up to `lodCount`.
   *  When set, overrides `aggressiveSimplify` for that level. Common pattern:
   *  conservative LOD0 (preserve close-up quality) + aggressive LOD2 (hit
   *  the budget at distance where seams don't show). */
  lodAggressive?: boolean[];
}

export const DEFAULT_MODEL_SETTINGS: ModelImportSettings = {
  encoder: 'gltf-transform',
  lodCount: 3,
  lodRatios: [1.0, 0.4, 0.15],
  lodDistances: [0, 80, 250],
  simplifyError: 0.5,
  weld: true,
  meshopt: true,
  aggressiveSimplify: false,
};

/** Cache bookkeeping persisted in the GLB's meta sidecar by the conversion
 *  service. `hash` keys the content cache (source bytes + settings + encoder
 *  version + loader id + loader recipe version); `lodPaths` lists the produced
 *  LOD GLBs in distance order (LOD0 = `processedPath`, then `lodPaths[1..]`).
 *  Remaining fields are post-conversion stats surfaced in the Inspector. */
export interface ModelCacheInfo {
  hash: string;
  /** Fixup-baked LOD0 GLB path (URL form, e.g. `<glbUrl>.processed.glb`). */
  processedPath: string;
  /** All LOD GLB paths in distance order. Index 0 === `processedPath`. Length
   *  === `lodDistances.length`. */
  lodPaths: string[];
  /** Switch distances mirrored from settings, baked here so the runtime reads
   *  one block (no need to consult the settings block at load time). */
  lodDistances: number[];
  /** Triangle count per LOD (parallel to `lodPaths`). */
  triCounts: number[];
  /** Byte size per LOD (parallel to `lodPaths`). */
  lodBytes: number[];
}

/** Merge persisted settings over the defaults. Tolerates a missing/partial
 *  `model` block (legacy GLBs with no import settings → all defaults). */
export function resolveModelSettings(
  meta: { model?: Partial<ModelImportSettings> } | null | undefined,
): ModelImportSettings {
  const src = meta?.model ?? {};
  // Lengths must match lodCount. If a partial settings block has wrong-length
  // arrays we trust lodCount and trim/pad with the defaults — keeps the editor
  // robust against half-typed JSON during live editing.
  const count: LodCount = (src.lodCount ?? DEFAULT_MODEL_SETTINGS.lodCount) as LodCount;
  return {
    encoder: src.encoder ?? DEFAULT_MODEL_SETTINGS.encoder,
    lodEncoders: src.lodEncoders && src.lodEncoders.length > 0
      ? src.lodEncoders.slice(0, count)
      : undefined,
    lodCount: count,
    lodRatios: alignToCount(src.lodRatios, DEFAULT_MODEL_SETTINGS.lodRatios, count),
    lodDistances: alignToCount(src.lodDistances, DEFAULT_MODEL_SETTINGS.lodDistances, count),
    simplifyError: src.simplifyError ?? DEFAULT_MODEL_SETTINGS.simplifyError,
    weld: src.weld ?? DEFAULT_MODEL_SETTINGS.weld,
    meshopt: src.meshopt ?? DEFAULT_MODEL_SETTINGS.meshopt,
    lodMeshopt: src.lodMeshopt && src.lodMeshopt.length > 0
      ? src.lodMeshopt.slice(0, count)
      : undefined,
    aggressiveSimplify: src.aggressiveSimplify ?? DEFAULT_MODEL_SETTINGS.aggressiveSimplify,
    lodAggressive: src.lodAggressive && src.lodAggressive.length > 0
      ? src.lodAggressive.slice(0, count)
      : undefined,
  };
}

/** Resolve the encoder to use for a specific LOD level. Per-LOD override
 *  wins; falls back to the global `encoder`. */
export function getLodEncoder(settings: ModelImportSettings, level: number): ModelEncoder {
  return settings.lodEncoders?.[level] ?? settings.encoder;
}

/** Resolve the meshopt (`-cc`) flag to use for a specific LOD level. Per-LOD
 *  override wins; falls back to the global `meshopt`. Only meaningful when
 *  the LOD's encoder is `gltfpack` — gltf-transform LODs ignore this. */
export function getLodMeshopt(settings: ModelImportSettings, level: number): boolean {
  return settings.lodMeshopt?.[level] ?? settings.meshopt;
}

/** Resolve the aggressive (`-sa` vs `-slb`) flag to use for a specific LOD
 *  level. Per-LOD override wins; falls back to the global
 *  `aggressiveSimplify`. Only meaningful when the LOD's encoder is
 *  `gltfpack` — gltf-transform LODs ignore this. */
export function getLodAggressive(settings: ModelImportSettings, level: number): boolean {
  return settings.lodAggressive?.[level] ?? settings.aggressiveSimplify;
}

function alignToCount(arr: number[] | undefined, fallback: number[], count: LodCount): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(arr?.[i] ?? fallback[i] ?? (i === 0 ? 1.0 : fallback[fallback.length - 1] ?? 0));
  }
  return out;
}

/** Deterministic per-LOD URL suffix. LOD0 → `.processed.glb`, LOD1+ →
 *  `.lod<N>.glb`. The runtime computes these without reading the hash so
 *  load doesn't require a manifest round-trip. */
export function lodUrlSuffix(level: number): string {
  return level === 0 ? '.processed.glb' : `.lod${level}.glb`;
}

/** Encoder cache key — bump on flag changes to invalidate every cached GLB.
 *  12: un-share deduped attribute accessors before the LOD rebase, so meshes
 *  with byte-identical geometry placed at different transforms no longer
 *  double-transform a shared accessor (fixed the Freeport station rendering
 *  6 of its 28 parts 7-21x too large).
 *  13: Stage A THREE adapter now denormalizes quantized accessors and clears
 *  the `normalized` flag when writing Float32 texcoords back, so a source with
 *  quantized (normalized Uint16) UVs no longer bakes a FLOAT-but-normalized
 *  texcoord — a combo WebGPU has no vertex format for, which crashed
 *  createRenderPipeline every frame and froze the editor (tropical island). */
export const MODEL_ENCODER_VERSION = 13;
