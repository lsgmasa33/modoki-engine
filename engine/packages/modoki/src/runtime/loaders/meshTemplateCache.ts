/** MeshTemplateCache — shared mesh templates loaded once, used by both Scene3D and SceneView.
 *  Cache is keyed by model path + mesh name for proper identity. */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { UltraHDRLoader } from 'three/examples/jsm/loaders/UltraHDRLoader.js';
import { getModelPostprocessor } from './modelPostprocessorRegistry';
import { getMaterialBuilder } from './materialTypes';
import { registerBuiltinMaterialTypes } from './materialPresets';
import { isGuid, isExternalUrl, resolveGuidToPath, resolveRef, registerAsset, getAssetEntry } from './assetManifest';
import { assetUrl } from './assetUrl';
import { ASSET_FETCH_INIT } from './assetFetch';
import { modelGlbUrl, resolveRefWarnOnce } from './modelGlbUrl';
import { takeParsedGltf, clearParsedGltfHandoff } from './parsedGltfHandoff';
import { addToOwnerSet, removeFromOwnerSet } from './ownerSet';
import { loadTexture3D, releaseTexture3D, isSharedTexture, resolveEnvVariantUrl, getEnvFormat } from './textureResolver';
import { clearParticleCache } from './particleCache';
import { fireDirtyListeners } from '../ecs/entityUtils';
import { clearAnimationClipCache } from './animationClipCache';
import { clearTimelineCache } from './timelineCache';
import { clearControlSpawns } from '../systems/controlSpawnRegistry';
import { clearAnimSetCache } from './animSetCache';
import { clearSpriteAnimCache } from './spriteAnimCache';
import { releaseRiggedModelsForScene, disposeAllRiggedModels, getRiggedOwnerCounts } from './riggedModelCache';
import { releaseAudioForScene, disposeAllAudioBuffers } from './audioBufferCache';
import { releaseFontsForScene, disposeAllFonts } from '../rendering/text/fontAtlasLoader';

// Ensure built-in material presets (pbr/unlit/custom) are registered regardless
// of how this module is imported (production main bundle, tests with reset
// modules, etc.). Idempotent.
registerBuiltinMaterialTypes();

export interface MeshTemplate {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  name: string;
}

/** Hierarchy entry extracted during loadModelTemplates — stores baked world
 *  transforms and parent relationships so loadGLB can spawn ECS entities
 *  without re-parsing the GLB (and with fixupMesh already applied). */
export interface MeshHierarchyEntry {
  name: string;
  /** Transform LOCAL to the resolved parent entity (parentName). The renderer
   *  composes parent.world × child.local, so these are parent-relative, NOT
   *  world-space. Root-parented entries (parentName null) are relative to the
   *  identity import-root group, so their local === world. */
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  /** Name of the nearest ancestor mesh, or null if root-level */
  parentName: string | null;
  color: number;
}

/** One-time warning per unresolved guid. A missing/typo'd ref otherwise renders
 *  nothing (invisible mesh/black material) with only repeated console noise; this
 *  surfaces it once, clearly. */
const unknownGuidSeen = new Set<string>();

/** Resolve a ref to a concrete path. Delegates to the shared
 *  assetManifest.resolveRef (GUID-only; internal asset paths are rejected there
 *  with a loud error, external URLs pass through) and layers on a one-time
 *  unknown-guid warning. Returns undefined if a GUID isn't in the manifest. */
function refToPath(ref: string | undefined | null): string | undefined {
  return resolveRefWarnOnce(ref, 'MeshCache', unknownGuidSeen);
}

/** Global cache: "modelPath/meshName" → MeshTemplate.
 *  INVARIANT (B2): keyed by PATH, NOT by content hash. The `?v=<hash>` cache-bust
 *  only defeats the browser/CDN layer; this in-memory map is invalidated
 *  explicitly via invalidateModel() on re-import. Production loads the manifest
 *  once at boot, so a path's bytes never change mid-session without an explicit
 *  invalidate. If that ever stops holding, key these on `${path}@${hash}`. */
const cache = new Map<string, MeshTemplate>();
const loading = new Map<string, Promise<void>>();
/** Per-model hierarchy: modelPath → hierarchy entries (traversal order) */
const hierarchyCache = new Map<string, MeshHierarchyEntry[]>();

/** Per-model template index (F9): modelPath → its template keys in `cache`.
 *  Kept in lockstep with `cache` via cacheSet/cacheDelete/cacheClear so per-model
 *  lookups (`getTemplatesForModel`/`lookupTemplate`) and `invalidateModel` are
 *  O(meshes-in-model) instead of O(total templates). `cache` keys are
 *  `${modelPath}::${meshName}`; the index splits on the LAST `::` so a model path
 *  that itself contains `::` still indexes correctly. */
const modelTemplateKeys = new Map<string, Set<string>>();

function modelPathOfKey(key: string): string {
  const i = key.lastIndexOf('::');
  return i >= 0 ? key.slice(0, i) : key;
}

function cacheSet(key: string, tmpl: MeshTemplate): void {
  cache.set(key, tmpl);
  const modelPath = modelPathOfKey(key);
  let keys = modelTemplateKeys.get(modelPath);
  if (!keys) { keys = new Set(); modelTemplateKeys.set(modelPath, keys); }
  keys.add(key);
}

function cacheDelete(key: string): void {
  if (!cache.delete(key)) return;
  const modelPath = modelPathOfKey(key);
  const keys = modelTemplateKeys.get(modelPath);
  if (keys) { keys.delete(key); if (keys.size === 0) modelTemplateKeys.delete(modelPath); }
}

function cacheClear(): void {
  cache.clear();
  modelTemplateKeys.clear();
}

/** Get cached hierarchy for a model. Returns undefined if not yet loaded. */
export function getModelHierarchy(modelPath: string): MeshHierarchyEntry[] | undefined {
  return hierarchyCache.get(modelPath);
}

/** Convert a single attribute to a plain (non-normalized) Float32 buffer.
 *  Used to dequantize KHR_mesh_quantization Int16/Int8 position/normal/tangent
 *  attributes for the WebGPU NodeMaterial pipeline (which rejects integer
 *  vertex inputs) WITHOUT applying the mesh's local matrix — the matrix
 *  stays on the node so the entity's Transform captures the same TRS the
 *  artist authored. That keeps animation hooks (rotate an oar, slide a door)
 *  targeting a meaningful Transform instead of one we silently zeroed.
 *
 *  `BufferAttribute.getX/Y/Z/W` denormalize when `normalized=true`, so a
 *  normalized Int16 in [-32767, 32767] reads back as a non-normalized Float32
 *  in [-1, 1] — exactly the range the shader saw before, just in a wider
 *  numeric type WebGPU accepts. Float32 attributes with `normalized=false`
 *  are passed through (skip the alloc). */
function convertAttribToFloat32(geometry: THREE.BufferGeometry, name: string): void {
  const attr = geometry.getAttribute(name);
  if (!attr) return;
  if (attr.array instanceof Float32Array && !attr.normalized) return;
  const itemSize = attr.itemSize;
  const n = attr.count * itemSize;
  const out = new Float32Array(n);

  // Fast path (F8): a normalized integer attribute (the KHR_mesh_quantization
  // shape that dominates the island hot path — position/normal/tangent) is a
  // flat, contiguous typed array, so dequantize it with one tight loop over the
  // raw ints instead of N×itemSize getX/Y/Z/W calls (each a denormalize divide
  // + clamp + index math + method dispatch). THREE's denormalize for signed
  // types is `max(raw / max, -1)`; for unsigned it's `raw / max`. We reproduce
  // it exactly so the result is byte-identical to the generic path. Only the
  // unwrapped-array case qualifies — an InterleavedBufferAttribute has stride/
  // offset, so its `.array` isn't a flat per-component buffer; fall through.
  const raw = attr.array as ArrayLike<number>;
  if (attr.normalized && raw.length === n) {
    let scale = 0;
    let signed = false;
    if (raw instanceof Int16Array) { scale = 32767; signed = true; }
    else if (raw instanceof Uint16Array) { scale = 65535; }
    else if (raw instanceof Int8Array) { scale = 127; signed = true; }
    else if (raw instanceof Uint8Array) { scale = 255; }
    if (scale !== 0) {
      // Divide (not multiply-by-reciprocal) to match THREE's BufferAttribute
      // denormalize byte-for-byte — `getX = max(raw / max, -1)` for signed.
      if (signed) {
        for (let i = 0; i < n; i++) { const v = (raw[i] as number) / scale; out[i] = v < -1 ? -1 : v; }
      } else {
        for (let i = 0; i < n; i++) out[i] = (raw[i] as number) / scale;
      }
      geometry.setAttribute(name, new THREE.BufferAttribute(out, itemSize));
      return;
    }
  }

  // Generic fallback: non-flat (interleaved) storage or an unexpected type.
  for (let i = 0; i < attr.count; i++) {
    if (itemSize >= 1) out[i * itemSize]     = attr.getX(i);
    if (itemSize >= 2) out[i * itemSize + 1] = attr.getY(i);
    if (itemSize >= 3) out[i * itemSize + 2] = attr.getZ(i);
    if (itemSize >= 4) out[i * itemSize + 3] = attr.getW(i);
  }
  geometry.setAttribute(name, new THREE.BufferAttribute(out, itemSize));
}

/** Decide whether an attribute's storage format is one WebGPU's NodeMaterial
 *  pipeline cannot accept as a vertex buffer (THREE.WebGPUAttributeUtils throws
 *  "Vertex format not supported yet", which then crashes createRenderPipeline
 *  every frame and freezes the view). Two unsupported shapes:
 *   - FLOAT but flagged `normalized` — no `float32-norm` GPU format exists. A
 *     malformed accessor (e.g. our converter writing a Float32 array onto a
 *     formerly-quantized texcoord without clearing the flag) lands here.
 *   - 3-component 8/16-bit storage — WebGPU has x1/x2/x4 for narrow types but
 *     no x3, so a quantized vec3 (position/normal) has no direct format.
 *  Anything else (plain Float32, or a 2-/4-component normalized int like a
 *  unorm16x2 UV or snorm16x4 tangent) is left untouched — those map cleanly. */
function isUnsupportedVertexFormat(attr: THREE.BufferAttribute): boolean {
  const isFloat = attr.array instanceof Float32Array;
  if (isFloat) return attr.normalized; // FLOAT + normalized has no GPU format
  return attr.itemSize === 3; // narrow vec3 (no x3 format for 8/16-bit)
}

/** Walk every attribute and dequantize the ones WebGPU can't bind to a plain
 *  non-normalized Float32 buffer. Defense-in-depth: the model converter should
 *  never emit these, but an arbitrary user-imported GLB (or a stale cached LOD
 *  from before the converter fix) otherwise wedges the render loop.
 *  Exported for unit tests. */
export function sanitizeGeometryAttributes(geometry: THREE.BufferGeometry): void {
  if (!geometry.attributes) return;
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.getAttribute(name) as THREE.BufferAttribute;
    if (attr && isUnsupportedVertexFormat(attr)) convertAttribToFloat32(geometry, name);
  }
}

// Expose for debug + asset enumeration (dev only)
if (import.meta.env?.DEV) (globalThis as any).__meshTemplateCache = cache;

/** Get all templates for a model path */
export function getTemplatesForModel(modelPath: string): Map<string, MeshTemplate> {
  const result = new Map<string, MeshTemplate>();
  const keys = modelTemplateKeys.get(modelPath);
  if (!keys) return result;
  const prefixLen = modelPath.length + 2; // strip `${modelPath}::`
  for (const key of keys) {
    const template = cache.get(key);
    if (template) result.set(key.substring(prefixLen), template);
  }
  return result;
}

/** Resolve a mesh template by `<modelPath>::<meshName>`, with a single-mesh
 *  fallback. gltfpack strips mesh names (the mesh is just `mesh_0` after
 *  processing), which breaks lookup when the source `.mesh.json` references
 *  the original name. For single-mesh models this is unambiguous — return
 *  whatever template is under that model path. Multi-mesh models that lose
 *  their names hit a real failure; we don't guess. */
function lookupTemplate(modelPath: string, meshName: string): MeshTemplate | undefined {
  const exact = cache.get(`${modelPath}::${meshName}`);
  if (exact) return exact;
  const all = getTemplatesForModel(modelPath);
  return all.size === 1 ? all.values().next().value : undefined;
}

/** Pick the cache name for a mesh inside a loaded model. THREE's GLTFLoader
 *  synthesizes `mesh.name = "mesh_<index>"` for primitives whose source glTF
 *  Mesh def has no name — which happens on every gltfpack output, since
 *  gltfpack splits a named source node "<Name>" into a named transform-carrier
 *  parent "<Name>" + an unnamed mesh-bearing child. The synthetic name passes
 *  a plain `mesh.name` check but never matches the `.mesh.json` files keyed on
 *  the source name.
 *
 *  THREE sets `userData.name` ONLY when the source had a real name — that's
 *  the reliable discriminator. When the mesh itself lacks userData.name, walk
 *  up to the closest ancestor inside `model` whose userData.name is set and
 *  use that ancestor's sanitized `.name` (which matches the sanitization the
 *  editor's modelImport already applies when authoring the `.mesh.json`
 *  files). Exported for unit tests. */
export function deriveTemplateName(
  mesh: THREE.Object3D,
  model: THREE.Object3D,
  idx: number,
): string {
  if (mesh.userData?.name && mesh.name) return mesh.name;
  let anc: THREE.Object3D | null = mesh.parent;
  while (anc && anc !== model) {
    if (anc.userData?.name && anc.name) return anc.name;
    anc = anc.parent;
  }
  return `mesh_${idx}`;
}

/** Walk up from a mesh to the nearest ANCESTOR that is itself a tracked mesh
 *  entity. Returns that ancestor's Object3D + tracked value, or null when the
 *  mesh is top-level (no mesh ancestor) — in which case it parents to the
 *  import root group.
 *
 *  Critically this does NOT let one mesh "claim" a shared parent group node:
 *  two sibling meshes under a common group (named or not) each walk *past* the
 *  group looking for a real mesh ancestor, so they stay siblings instead of the
 *  second one chaining onto the first-processed sibling. Mesh traversal is
 *  pre-order DFS, so a parent mesh is always tracked before its descendants. */
export function findNearestMeshAncestor<T>(
  mesh: THREE.Object3D,
  model: THREE.Object3D,
  tracked: Map<THREE.Object3D, T>,
): { obj: THREE.Object3D; value: T } | null {
  let node: THREE.Object3D | null = mesh.parent;
  while (node && node !== model) {
    const value = tracked.get(node);
    if (value !== undefined) return { obj: node, value };
    node = node.parent;
  }
  return null;
}

/** Decompose a mesh's transform LOCAL to its resolved parent entity.
 *
 *  The renderer composes `parent.world × child.local` (transformPropagationSystem),
 *  so storing a world-space transform here double-applies the parent's transform
 *  for any non-identity hierarchy (e.g. a child mesh under a translated parent
 *  renders at parent+child instead of child). `parentObj` is the parent mesh's
 *  Object3D — we invert its matrixWorld to bring the mesh into the parent's local
 *  space. For a root-parented mesh (parentObj null) local === world, since the
 *  import root group entity is spawned at identity.
 *
 *  CAVEAT — the result is a TRS triple (position/euler/scale), which cannot
 *  represent shear. If a parent mesh has non-uniform scale and the child is
 *  rotated relative to it, `parentObj.matrixWorld⁻¹ × mesh.matrixWorld` contains
 *  shear that `decompose()` silently drops, so the stored child transform is
 *  approximate. This is inherent to the TRS-based ECS Transform trait, not this
 *  function; such hierarchies are rare in authored GLBs. */
export function decomposeLocalTransform(
  mesh: THREE.Object3D,
  parentObj: THREE.Object3D | null,
): { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } {
  const local = new THREE.Matrix4();
  if (parentObj) local.copy(parentObj.matrixWorld).invert().multiply(mesh.matrixWorld);
  else local.copy(mesh.matrixWorld);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  local.decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q);
  return { position: [p.x, p.y, p.z], rotation: [e.x, e.y, e.z], scale: [s.x, s.y, s.z] };
}


/** Generation counter — incremented on full disposal to invalidate in-flight async loads. */
let cacheGeneration = 0;

/** Dispose a Three.js material and its textures (material.dispose() alone
 *  doesn't free textures). Walks both:
 *   - the standard PBR slots (mat.map / normalMap / …), present on
 *     `MeshStandardMaterial` and its kin
 *   - `mat.userData.textures` — the convention for NodeMaterial / TSL builds
 *     (fileShaderBuilder + any custom shader that stashes its acquired
 *     textures), since TSL `texture(tex)` nodes don't expose a slot the
 *     dispose path can otherwise see. */
/** Parse a material `textureRepeat` field into an [x,y] pair. Accepts a single
 *  positive number (uniform) or a [x,y] array; returns null for absent/invalid. */
function parseTextureRepeat(v: unknown): [number, number] | null {
  if (typeof v === 'number' && v > 0) return [v, v];
  if (Array.isArray(v) && v.length >= 2) {
    const x = Number(v[0]);
    const y = Number(v[1]);
    if (Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0) return [x, y];
  }
  return null;
}

function disposeMaterial(mat: THREE.Material, disposedTex?: Set<string>) {
  const slots: Array<THREE.Texture | null | undefined> = [];
  // Generic walk: dispose ANY enumerable property that is a texture. This
  // future-proofs every PBR slot (map / normalMap / roughnessMap / metalnessMap
  // / aoMap / emissiveMap / clearcoatMap / sheenColorMap / lightMap /
  // displacementMap / bumpMap / alphaMap / envMap / transmission / iridescence /
  // …) without a hand-maintained list, matching riggedModelCache.disposePrototype.
  const props = mat as unknown as Record<string, unknown>;
  for (const key of Object.keys(props)) {
    const val = props[key] as THREE.Texture | undefined;
    if (val && val.isTexture) slots.push(val);
  }
  // `mat.userData.textures` — the convention for NodeMaterial / TSL builds whose
  // `texture(tex)` nodes don't expose a slot the walk above can otherwise see.
  const extra = (mat.userData as { textures?: THREE.Texture[] } | undefined)?.textures;
  if (extra) for (const t of extra) slots.push(t);
  for (const tex of slots) {
    if (!tex) continue;
    // Material map/userData textures come from `loadTexture3D` (refcounted shared
    // cache, texture-shader-font F3). RELEASE one ref per slot occurrence — slots
    // map 1:1 to acquires (each `loadInto` is one `loadTexture3D`; a ref reused
    // across slots returns the same instance + bumped the count once per slot), so
    // the disposedTex uuid-dedup must NOT apply here or a texture shared by two
    // materials would be released once and leak. A texture without the shared key
    // (legacy / non-cache origin, e.g. an env map) is disposed directly, deduped.
    if (isSharedTexture(tex)) { releaseTexture3D(tex); continue; }
    if (!disposedTex || !disposedTex.has(tex.uuid)) {
      tex.dispose();
      disposedTex?.add(tex.uuid);
    }
  }
  mat.dispose();
}

/** Renderers subscribe to drop their live THREE.Mesh references before we
 *  dispose the underlying GPU geometry. Without this, an `invalidateModel`
 *  fired by an editor re-import crashes the next render with
 *  "setIndexBuffer parameter 1 is not of type 'GPUBuffer'" because the
 *  in-scene meshes still hold pointers to the just-disposed buffers. */
type ModelInvalidationListener = (modelPath: string, targets: ReadonlySet<string>) => void;
const modelInvalidationListeners = new Set<ModelInvalidationListener>();

/** Subscribe to model-invalidation events. Returns an unsubscribe function.
 *  Renderers should remove any scene objects rendered from `modelPath` (or any
 *  of its baked LOD siblings, surfaced as `targets`) before this returns —
 *  the cache entries are dropped *after* every listener has run, then GPU
 *  geometry is disposed. */
export function onModelInvalidated(fn: ModelInvalidationListener): () => void {
  modelInvalidationListeners.add(fn);
  return () => { modelInvalidationListeners.delete(fn); };
}

/** Per-source-path snapshot of LOD paths captured at acquireModel time. Used by
 *  release-time invalidation so a manifest entry that gets torn down (rename,
 *  reimport-with-id-change, world swap) before release does not orphan the LOD
 *  templates — the snapshot still names them. */
const modelLodSnapshots = new Map<string, string[]>();

/** Invalidate all cached templates for a model, plus any baked LOD siblings.
 *  Call before re-import. Walks the LOD snapshot (preferred — survives manifest
 *  drift) then falls back to the asset manifest so a model with
 *  `modelCache.lodPaths` clears every LOD GLB's templates too. */
export function invalidateModel(modelPath: string) {
  const targets = new Set<string>([modelPath]);
  const snapshot = modelLodSnapshots.get(modelPath);
  if (snapshot) {
    for (const p of snapshot) targets.add(p);
  } else {
    const entry = getAssetEntry(modelPath);
    for (const p of entry?.modelCache?.lodPaths ?? []) targets.add(p);
  }

  // Notify renderers BEFORE we touch the cache so they can drop any live
  // THREE.Mesh references to soon-disposed GPU geometry.
  for (const fn of modelInvalidationListeners) {
    try { fn(modelPath, targets); }
    catch (e) { console.warn('[MeshCache] invalidation listener threw:', e); }
  }

  const disposedGeo = new Set<string>();
  for (const target of targets) {
    // O(meshes-in-model) via the per-model index instead of scanning all keys.
    for (const key of [...(modelTemplateKeys.get(target) ?? [])]) {
      const tmpl = cache.get(key)!;
      if (!disposedGeo.has(tmpl.geometry.uuid)) {
        tmpl.geometry.dispose();
        disposedGeo.add(tmpl.geometry.uuid);
      }
      cacheDelete(key);
    }
    hierarchyCache.delete(target);
    // Loading keys are `${path}` (runtime) or `${path}:${postprocessorId}`
    // (editor hook-applied) — see loadModelTemplates. Asset paths contain no ':',
    // so split on the last ':' and exact-match the path: this matches both shapes
    // and won't kill an unrelated in-flight load for "/m/foobar" when invalidating
    // "/m/foo".
    for (const key of [...loading.keys()]) {
      const colonIdx = key.lastIndexOf(':');
      const keyPath = colonIdx >= 0 ? key.slice(0, colonIdx) : key;
      if (keyPath === target) loading.delete(key);
    }
  }
  // Clear mesh asset cache entries that reference the source model — the LOD
  // refresh recomputes the resolved templates on next fetch. asset.model is a
  // guid post-migration, so resolve to a path before comparing to modelPath.
  for (const [path, asset] of meshAssetCache) {
    if (asset === MESH_FAILED) continue;
    const assetModelPath = refToPath(asset.model);
    if (assetModelPath === modelPath) meshAssetCache.delete(path);
  }
  console.log(`[MeshCache] Invalidated + disposed cache for ${modelPath} (${targets.size} GLBs, ${disposedGeo.size} geometries)`);
}

/** Load a GLB and extract mesh templates into the cache.
 *  Safe to call multiple times — only loads once per model (runtime), or once per
 *  model+postprocessor when hook-applied (editor import).
 *
 *  Meshes are processed in batches with setTimeout(0) yields between batches so
 *  the main thread can service rAF (and keep the game loop + current scene
 *  rendering) during large GLB parses — important on Android where the island
 *  GLB can otherwise block the main thread for ~2 s.
 *
 *  By default the runtime DOES NOT invoke the postprocessor's `fixupMesh` /
 *  `filterMesh` hooks — fixups are baked into the GLB at import time (Stage A
 *  in the model converter) and the runtime is just a consumer of the baked
 *  artifact. Editor flows that need to re-derive `.mesh.json` / `.mat.json`
 *  files from a fresh parse pass `applyPostprocessorHooks: true` so the
 *  templates carry the post-fixup state before extraction. Postprocessor is
 *  selected per-model via the `postprocessor` field in the GLB's `.meta.json`
 *  sidecar (configurable in the Model Inspector). */
/** Re-exported from the leaf `modelGlbUrl` module so existing importers
 *  (loadGLB, tests) keep importing it from here, while riggedModelCache can
 *  import it without a circular dependency (this module imports that one). */
export { modelGlbUrl };

export function loadModelTemplates(
  path: string,
  root?: { position?: [number, number, number]; rotation?: [number, number, number]; scale?: number },
  postprocessorId: string = 'none',
  applyPostprocessorHooks: boolean = false,
): Promise<void> {
  // The RUNTIME parse is postprocessor-agnostic (hooks off — Stage A baked the
  // fixups into the GLB), so a GLB acquired as a `model` (with the scene's
  // postprocessor) AND transitively via a `mesh` ('none') must share ONE in-flight
  // load + parse instead of keying on the postprocessor and parsing twice (the
  // second clobbering the first under the shared `${path}::${name}` cache key).
  // Only the editor's hook-applied parse (`applyPostprocessorHooks`) genuinely
  // varies by postprocessor, so it keeps a per-postprocessor key. (F1)
  const key = applyPostprocessorHooks ? `${path}:${postprocessorId}` : path;
  if (loading.has(key)) return loading.get(key)!;

  // Snapshot the cache generation so a GLB that resolves AFTER a
  // disposeAllCachedResources (which clears cache/loading and bumps the
  // generation) doesn't `cache.set` owner-less geometry into the freshly-cleared
  // map — it would survive until the NEXT teardown as a stranded GPU leak. Mirrors
  // the material + HDR + rigged-cache guards. (F11)
  const gen = cacheGeneration;

  const promise = new Promise<void>((resolve, reject) => {
    const onGltf = async (gltf: { scene: THREE.Group }) => {
      try {
        const model = gltf.scene;

        // Disposed (teardown / scene-swap) while this GLB was loading → promote
        // nothing, dispose everything we just parsed, and bail. Without this the
        // templates below would land in the now-cleared cache with no owner. (F11)
        if (gen !== cacheGeneration) {
          const droppedTex = new Set<string>();
          model.traverse((child) => {
            const m = child as THREE.Mesh;
            if (!m.isMesh) return;
            m.geometry?.dispose();
            const mat = m.material;
            if (Array.isArray(mat)) for (const x of mat) disposeMaterial(x, droppedTex);
            else if (mat) disposeMaterial(mat as THREE.Material, droppedTex);
          });
          if (typeof (model as { clear?: () => void }).clear === 'function') (model as { clear: () => void }).clear();
          resolve();
          return;
        }

        // Apply root transform
        if (root?.position) model.position.set(...root.position);
        if (root?.rotation) model.rotation.set(...root.rotation);
        if (root?.scale) model.scale.setScalar(root.scale);
        model.updateMatrixWorld(true);

        // Collect meshes
        const meshes: THREE.Mesh[] = [];
        model.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
        });

        const BATCH_SIZE = 4;
        const postprocessor = getModelPostprocessor(postprocessorId);

        // Phase 1: Filter, fixup, and extract hierarchy (needs intact parent chain).
        // Hierarchy info allows loadGLB to spawn entities from cache without
        // re-parsing the GLB — and guarantees fixupMesh is applied consistently.
        const hierarchy: MeshHierarchyEntry[] = [];
        const objectToName = new Map<THREE.Object3D, string>();
        const filtered: THREE.Mesh[] = [];
        const keptGeometries = new Set<THREE.BufferGeometry>();
        const keptMaterials = new Set<THREE.Material>();
        const usedNames = new Set<string>(); // de-collide template names within this load
        let nameIdx = 0;

        for (const mesh of meshes) {
          // Postprocessor hooks only fire on explicit opt-in (editor import
          // pipeline). Runtime callers leave them off because Stage A baked
          // the fixups into the GLB already.
          if (applyPostprocessorHooks && postprocessor.filterMesh && !postprocessor.filterMesh(mesh)) continue;
          if (applyPostprocessorHooks) postprocessor.fixupMesh(mesh);

          // Multi-mesh nodes can bubble up to the same named ancestor; without
          // de-collision the second template silently overwrites the first
          // under the shared `<path>::<name>` cache key (only one primitive
          // ends up rendering). Suffix collisions with `__<idx>`.
          let name = deriveTemplateName(mesh, model, nameIdx);
          if (usedNames.has(name)) name = `${name}__${nameIdx}`;
          usedNames.add(name);
          nameIdx++;
          filtered.push(mesh);
          keptGeometries.add(mesh.geometry);
          if (Array.isArray(mesh.material)) {
            for (const m of mesh.material) keptMaterials.add(m);
          } else {
            keptMaterials.add(mesh.material as THREE.Material);
          }

          // Dequantize integer position/normal/tangent attributes to plain
          // Float32 so WebGPU's NodeMaterial pipeline accepts the geometry.
          // KHR_mesh_quantization (used by gltf-transform meshopt + gltfpack
          // -cc) packs positions as Int16 normalized with the dequant
          // scale/translate sitting on the Mesh node. We convert the buffer
          // type WITHOUT touching `mesh.matrix` — the node TRS stays so the
          // entity's Transform (built from `matrixWorld.decompose` below)
          // captures the same TRS the artist authored. Two reasons:
          //
          //  1) Editor / runtime consistency. Both the editor (source GLB)
          //     and the runtime (LOD GLB) read the same node TRS into the
          //     entity Transform — the prefab and the live render agree.
          //
          //  2) Animation. With identity Transforms the user has nothing to
          //     tween on a per-mesh basis (rotate an oar, slide a door). The
          //     authored node TRS becomes the natural animation handle when
          //     it survives into the ECS Transform.
          //
          //  Geometry stays in LOCAL space; render = entity.Transform ×
          //  local geometry recovers the world position correctly without
          //  any double-apply of `mesh.matrix`.
          // Dequantize any attribute whose storage format WebGPU's NodeMaterial
          // pipeline can't bind (narrow vec3 position/normal/tangent, or a
          // malformed FLOAT-but-normalized texcoord). Generalized from a
          // position/normal/tangent-only pass so a stray UV/color in an
          // unsupported format can't crash the render loop either.
          if (typeof mesh.geometry?.getAttribute === 'function') {
            sanitizeGeometryAttributes(mesh.geometry);
          }

          // Resolve the parent to the nearest ANCESTOR MESH (siblings under a
          // shared group node stay siblings — see findNearestMeshAncestor), then
          // store the transform LOCAL to that parent. The renderer composes
          // parent.world × child.local, so a world-space transform here would
          // double-apply the parent's transform for any non-identity hierarchy.
          const parentMesh = findNearestMeshAncestor(mesh, model, objectToName);
          const local = decomposeLocalTransform(mesh, parentMesh?.obj ?? null);

          const mat = mesh.material as THREE.MeshStandardMaterial;
          hierarchy.push({
            name,
            position: local.position,
            rotation: local.rotation,
            scale: local.scale,
            parentName: parentMesh?.value ?? null,
            color: mat?.color ? mat.color.getHex() : 0xffffff,
          });

          // Register only the mesh itself. Do NOT stamp ancestor group nodes with
          // this mesh's name — that made later siblings resolve their parent to
          // the first-processed sibling instead of staying siblings.
          objectToName.set(mesh, name);
        }

        hierarchyCache.set(path, hierarchy);

        // Phase 2: Strip hierarchy and cache templates (fixupMesh already applied,
        // quantized geometry already baked into Float32 in Phase 1).
        let count = 0;
        let processedInBatch = 0;
        for (const mesh of filtered) {
          mesh.removeFromParent();
          mesh.position.set(0, 0, 0);
          mesh.rotation.set(0, 0, 0);
          mesh.scale.set(1, 1, 1);

          const name = hierarchy[count].name;

          cacheSet(`${path}::${name}`, {
            geometry: mesh.geometry,
            material: mesh.material as THREE.Material,
            name,
          });
          count++;
          processedInBatch++;

          // Yield to rAF between batches so the current scene keeps animating.
          if (processedInBatch >= BATCH_SIZE) {
            processedInBatch = 0;
            await new Promise<void>((r) => setTimeout(r, 0));
          }
        }

        // Dispose any geometry/material/texture from the parsed scene that
        // wasn't promoted into the template cache. Without this, filtered-out
        // meshes (ground planes, helpers) and intermediate Three.js Group
        // nodes leak GPU + heap for the lifetime of the app.
        const disposedTex = new Set<string>();
        model.traverse((child) => {
          const m = child as THREE.Mesh;
          if (m.isMesh) {
            if (m.geometry && !keptGeometries.has(m.geometry)) {
              m.geometry.dispose();
            }
            const mat = m.material;
            if (Array.isArray(mat)) {
              for (const x of mat) if (!keptMaterials.has(x)) disposeMaterial(x, disposedTex);
            } else if (mat && !keptMaterials.has(mat as THREE.Material)) {
              disposeMaterial(mat as THREE.Material, disposedTex);
            }
          }
        });
        // Detach remaining children so the parsed GLTF scene graph can GC.
        // Guarded for test mocks where `model` may not be a real Object3D.
        if (typeof (model as { clear?: () => void }).clear === 'function') (model as { clear: () => void }).clear();

        console.log(`[MeshCache] Loaded ${count} templates from ${path}`);
        resolve();
      } catch (err) {
        console.error(`[MeshCache] Failed during template processing for ${path}:`, err);
        reject(err);
      }
    };

    // The editor importer already parsed this GLB for rig inspection — reuse that
    // parse instead of a second GLTFLoader.load (F4). The runtime scene-load path
    // never offers a handoff, so this is undefined there and we parse as before.
    const handoff = takeParsedGltf(path);
    if (handoff) { void onGltf({ scene: handoff.scene }); return; }

    const gltfLoader = new GLTFLoader();
    // gltfpack-produced LODs use EXT_meshopt_compression — decode them in
    // the browser via three's bundled meshopt decoder.
    gltfLoader.setMeshoptDecoder(MeshoptDecoder);
    gltfLoader.load(modelGlbUrl(path), onGltf, undefined, (error) => {
      console.error(`[MeshCache] Failed to load ${path}:`, error);
      reject(error);
    });
  });

  loading.set(key, promise);
  return promise;
}

/** Get a mesh template by legacy key (e.g., "island/вода"). */
export function getMeshTemplate(key: string): MeshTemplate | undefined {
  return cache.get(key);
}

/** Register a RUNTIME-BUILT mesh under a synthetic key so a normal `Renderable3D`
 *  can reference it (`mesh = key`) and render through the standard renderer path
 *  (`resolveMeshTemplate` → `new THREE.Mesh(template.geometry, material)`).
 *
 *  The key must be a plain string that is NOT a GUID and NOT a `*.mesh.json` path —
 *  those route through the manifest/asset-fetch branches of `resolveMeshTemplate` and
 *  would never hit this cache entry. A synthetic key (e.g. `sling:field:cap`) lands in
 *  the same legacy-key slot primitives/sprite names use (`cache.get(key)`).
 *
 *  For procedurally generated, **Transient** content (e.g. the sling field mesher) that
 *  builds geometry at runtime instead of loading a GLB. The caller **owns the geometry**
 *  (disposed here on overwrite, and by `unregisterRuntimeMeshTemplate`); the `material`
 *  is typically shared/scene-owned (resolve it via `resolveMaterial`) and is NOT disposed
 *  by these helpers. Overwriting an existing key disposes the previous geometry, so a
 *  rebuild is idempotent. */
export function registerRuntimeMeshTemplate(key: string, geometry: THREE.BufferGeometry, material: THREE.Material): void {
  if (isGuid(key) || key.endsWith('.mesh.json')) {
    console.error(`[MeshCache] registerRuntimeMeshTemplate: key "${key}" must not be a GUID or *.mesh.json (it would not resolve via the legacy-key path).`);
    return;
  }
  const prev = cache.get(key);
  if (prev && prev.geometry !== geometry) prev.geometry.dispose();
  cacheSet(key, { geometry, material, name: key });
}

/** Remove a runtime mesh template registered via `registerRuntimeMeshTemplate` and
 *  dispose its geometry. The material is left alone (shared/scene-owned). No-op if the
 *  key isn't registered. */
export function unregisterRuntimeMeshTemplate(key: string): void {
  const t = cache.get(key);
  if (!t) return;
  t.geometry.dispose();
  cacheDelete(key);
}

type MeshAsset = { model: string; mesh: string; postprocessor: string; material?: string };

/** Sentinel for permanently failed mesh-asset fetches. Stored in `meshAssetCache`
 *  so repeated `resolveMeshTemplate` calls short-circuit instead of re-fetching
 *  the same 404 forever. Mirrors MATERIAL_FAILED in fetchMaterial. */
const MESH_FAILED: unique symbol = Symbol('MESH_FAILED');

/** Mesh asset file cache (path → parsed MeshAsset or MESH_FAILED) */
const meshAssetCache = new Map<string, MeshAsset | typeof MESH_FAILED>();

/** Look up a cached mesh asset by guid or path. Returns undefined when the
 *  mesh hasn't been fetched yet or its fetch permanently failed. Exposed for
 *  renderer invalidation listeners that need to map entity → parent model path
 *  without re-fetching. */
export function getMeshAsset(meshRef: string): MeshAsset | undefined {
  const path = refToPath(meshRef);
  if (!path) return undefined;
  const v = meshAssetCache.get(path);
  return v && v !== MESH_FAILED ? v : undefined;
}

/** In-flight mesh-asset fetches, keyed by path. Awaitable for the refcount API. */
const meshAssetLoadPromises = new Map<string, Promise<void>>();

/** Resolve a mesh reference — handles legacy sprite names, *.mesh.json paths,
 *  and asset guids. For mesh assets: fetches the JSON, lazy-loads the model,
 *  returns the template. Returns undefined synchronously if not yet loaded
 *  (triggers async load in background). */
export function resolveMeshTemplate(meshRef: string): MeshTemplate | undefined {
  if (!meshRef) return undefined;

  // GUID — resolve to path via manifest
  if (isGuid(meshRef)) {
    const path = resolveGuidToPath(meshRef);
    if (!path) return undefined;
    meshRef = path;
  }

  // Legacy sprite key (no extension)
  if (!meshRef.endsWith('.mesh.json')) {
    return cache.get(meshRef);
  }

  // Check if we already resolved this mesh asset
  const cached = meshAssetCache.get(meshRef);
  if (cached === MESH_FAILED) return undefined; // permanently failed — stop re-fetching
  if (cached) {
    // cached.model may be a guid; resolve transitively
    const modelPath = refToPath(cached.model);
    if (!modelPath) return undefined;
    // If LODs are baked, templates live under each LOD GLB's path — return
    // LOD0 so single-mesh consumers (Renderable3D prewarm, editor SceneView
    // direct mesh refs) still get a usable template. LOD-aware callers should
    // use `resolveMeshLodInfo` instead.
    const modelEntry = getAssetEntry(cached.model);
    const lodPaths = modelEntry?.modelCache?.lodPaths;
    if (lodPaths && lodPaths.length > 0) {
      return lookupTemplate(lodPaths[0], cached.mesh);
    }
    return lookupTemplate(modelPath, cached.mesh);
  }

  // Not yet loaded — kick off async fetch
  if (!meshAssetLoadPromises.has(meshRef)) fetchMeshAsset(meshRef);
  return undefined;
}

/** Geometry stats (vertex/triangle count + attribute names) for an inspector.
 *  Pure of any cache/IO — derives counts from a resolved template so it can be
 *  unit-tested with a hand-built BufferGeometry. */
export function meshStatsFromTemplate(template: MeshTemplate): { vertices: number; triangles: number; attributes: string[] } {
  const geo = template.geometry;
  const posAttr = geo.attributes?.position;
  const vertices = posAttr ? posAttr.count : 0;
  const triangles = geo.index ? geo.index.count / 3 : Math.floor(vertices / 3);
  const attributes = Object.keys(geo.attributes || {});
  return { vertices, triangles, attributes };
}

/** Await the mesh template for a ref, kicking off the async fetch if needed.
 *  Resolves to the template once loaded, or `undefined` if the fetch
 *  permanently failed (404) or the ref doesn't resolve. Replaces the inspector's
 *  setTimeout-retry polling (F9) with a single awaited promise — when the asset
 *  fails, the promise resolves to `undefined` immediately instead of spinning. */
export async function whenMeshTemplate(meshRef: string): Promise<MeshTemplate | undefined> {
  if (!meshRef) return undefined;

  // Resolve guid → path so we can key the in-flight fetch promise by path.
  let ref = meshRef;
  if (isGuid(ref)) {
    const p = resolveGuidToPath(ref);
    if (!p) return undefined;
    ref = p;
  }

  // Legacy sprite key (no extension) — synchronous cache lookup only.
  if (!ref.endsWith('.mesh.json')) return cache.get(ref);

  // Synchronous fast path (already resolved).
  const immediate = resolveMeshTemplate(ref);
  if (immediate) return immediate;

  // Await the in-flight (or freshly-kicked) mesh-asset fetch, then the model
  // template load it chains into. resolveMeshTemplate above already triggered
  // fetchMeshAsset when not cached.
  await fetchMeshAsset(ref);
  if (meshAssetCache.get(ref) === MESH_FAILED) return undefined;
  return resolveMeshTemplate(ref);
}

/** LOD-aware resolution: returns every LOD level's template + the matching
 *  switch distances, or undefined when the parent model has no baked LODs
 *  (caller falls back to `resolveMeshTemplate` for a single-mesh mount).
 *  Synchronous — returns undefined until every LOD template is loaded.
 *  Templates are returned in distance order (LOD0 first). */
export function resolveMeshLodInfo(
  meshRef: string,
): { templates: MeshTemplate[]; distances: number[] } | undefined {
  if (!meshRef) return undefined;
  let resolvedRef = meshRef;
  if (isGuid(meshRef)) {
    const p = resolveGuidToPath(meshRef);
    if (!p) return undefined;
    resolvedRef = p;
  }
  if (!resolvedRef.endsWith('.mesh.json')) return undefined;
  const cached = meshAssetCache.get(resolvedRef);
  if (!cached || cached === MESH_FAILED) return undefined;

  const modelEntry = getAssetEntry(cached.model);
  const modelCache = modelEntry?.modelCache;
  if (!modelCache?.lodPaths || modelCache.lodPaths.length === 0) return undefined;

  const templates: MeshTemplate[] = [];
  for (const lodPath of modelCache.lodPaths) {
    const t = lookupTemplate(lodPath, cached.mesh);
    if (!t) return undefined; // not fully loaded — caller falls back until ready
    templates.push(t);
  }
  return { templates, distances: modelCache.lodDistances };
}

/** Async: fetch a .mesh.json file and preload its model. Returns a promise the
 *  refcount API can await; safe to call multiple times — dedupes via meshAssetCache + meshAssetLoadPromises. */
function fetchMeshAsset(meshPath: string): Promise<void> {
  if (meshAssetCache.has(meshPath)) return Promise.resolve();
  if (meshAssetLoadPromises.has(meshPath)) return meshAssetLoadPromises.get(meshPath)!;

  const promise = (async () => {
    try {
      const res = await fetch(assetUrl(meshPath), ASSET_FETCH_INIT);
      if (!res.ok) {
        meshAssetCache.set(meshPath, MESH_FAILED); // cache failure — don't retry
        return;
      }
      const asset = await res.json() as { id?: string } & MeshAsset;
      meshAssetCache.set(meshPath, asset);
      // Self-register so future ref-by-guid resolves to this path
      if (asset.id) registerAsset(asset.id, meshPath, 'mesh');

      // Resolve model ref (guid or path) before preloading templates
      const modelPath = refToPath(asset.model);
      if (modelPath) {
        // If the source model has been through the new model-import pipeline
        // (modelCache.lodPaths present), load templates for every LOD GLB.
        // Otherwise load the source GLB directly (legacy single-mesh path).
        const modelEntry = getAssetEntry(asset.model);
        const lodPaths = modelEntry?.modelCache?.lodPaths;
        if (lodPaths && lodPaths.length > 0) {
          // allSettled so a single LOD failure doesn't reject the parent fetch
          // and leak owners of the LODs that DID load.
          const results = await Promise.allSettled(
            lodPaths.map(p => loadModelTemplates(p, undefined, asset.postprocessor || 'none')),
          );
          for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'rejected') {
              console.warn(`[MeshCache] LOD ${lodPaths[i]} failed to load:`, (results[i] as PromiseRejectedResult).reason);
            }
          }
          // Snapshot the LOD list at LOAD time, not just at acquire time — the sync
          // render-path resolver (resolveMeshTemplate) can load these before any
          // acquireMesh runs, and the snapshot must exist so a later release/re-import
          // finds the LOD paths even if the manifest entry was evicted. Mirrors the
          // !has-guarded snapshot in acquireMesh/acquireModel. (F6)
          if (!modelLodSnapshots.has(modelPath)) modelLodSnapshots.set(modelPath, [...lodPaths]);
        } else {
          await loadModelTemplates(modelPath, undefined, asset.postprocessor || 'none');
        }
      }
    } catch (e) {
      console.warn(`[MeshCache] Failed to load mesh asset ${meshPath}:`, e);
      meshAssetCache.set(meshPath, MESH_FAILED);
    } finally {
      meshAssetLoadPromises.delete(meshPath);
    }
  })();

  meshAssetLoadPromises.set(meshPath, promise);
  return promise;
}

// ── Material Asset Resolution ──

const materialCache = new Map<string, THREE.Material | typeof MATERIAL_FAILED>(); // path → material
/** In-flight material fetches, keyed by .mat.json path. Awaitable for the refcount API. */
const materialLoadPromises = new Map<string, Promise<void>>();

/** Invalidate a cached material so it will be re-fetched on next resolve. */
export function invalidateMaterial(matPath: string) {
  const mat = materialCache.get(matPath);
  if (mat && mat !== MATERIAL_FAILED) disposeMaterial(mat);
  materialCache.delete(matPath);
  materialLoadPromises.delete(matPath);
}

/** Resolve material for a mesh: checks Renderable.material, then mesh asset's material field.
 *  Accepts guid or path refs for both arguments. Returns undefined if not resolved yet. */
export function resolveMaterialForMesh(renderableMaterial: string, meshRef: string): THREE.Material | undefined {
  // 1. Explicit material on Renderable. Pass the ORIGINAL ref (guid or path) to
  //    resolveMaterial — it does its own refToPath. Passing the already-resolved
  //    path would make resolveMaterial re-resolve a path and spuriously fire the
  //    legacy-path-ref warning even for a perfectly valid guid.
  if (renderableMaterial) {
    const matPath = refToPath(renderableMaterial);
    if (matPath?.endsWith('.mat.json')) return resolveMaterial(renderableMaterial);
  }
  // 2. Material referenced in the mesh asset file
  if (meshRef) {
    const meshPath = refToPath(meshRef);
    if (meshPath?.endsWith('.mesh.json')) {
      const meshAsset = meshAssetCache.get(meshPath);
      if (meshAsset && meshAsset !== MESH_FAILED && meshAsset.material) return resolveMaterial(meshAsset.material);
    }
  }
  return undefined;
}

const MATERIAL_FAILED: unique symbol = Symbol('MATERIAL_FAILED');

/** Resolve a material reference (guid or *.mat.json path) to a THREE.Material.
 *  Returns undefined if not yet loaded (triggers async load). */
export function resolveMaterial(materialRef: string): THREE.Material | undefined {
  if (!materialRef) return undefined;
  const matPath = refToPath(materialRef);
  if (!matPath || !matPath.endsWith('.mat.json')) return undefined;
  const cached = materialCache.get(matPath);
  if (cached === MATERIAL_FAILED) return undefined; // permanently failed
  if (cached) return cached as THREE.Material;
  if (!materialLoadPromises.has(matPath)) fetchMaterial(matPath);
  return undefined;
}

/** Fetch + parse a material asset. Returns a promise the refcount API can await;
 *  safe to call multiple times — dedupes via materialCache + materialLoadPromises. */
function fetchMaterial(matPath: string): Promise<void> {
  if (materialCache.has(matPath)) return Promise.resolve();
  if (materialLoadPromises.has(matPath)) return materialLoadPromises.get(matPath)!;

  const gen = cacheGeneration; // capture to detect disposal during async load

  const promise = (async () => {
    try {
      const res = await fetch(assetUrl(matPath), ASSET_FETCH_INIT);
      if (!res.ok) {
        materialCache.set(matPath, MATERIAL_FAILED); // cache failure — don't retry
        return;
      }
      const data = await res.json();
      // Self-register so future ref-by-guid resolves to this path
      if (typeof data.id === 'string') registerAsset(data.id, matPath, 'material');

      // Dispatch to the appropriate builder based on `type`. Defaults to 'pbr'
      // for legacy .mat.json files with no type field.
      const type = (data.type as string) ?? 'pbr';
      const builder = getMaterialBuilder(type);
      if (!builder) {
        console.warn(`[MeshCache] Unknown material type "${type}" in ${matPath}. Falling back to a pink material.`);
        materialCache.set(matPath, MATERIAL_FAILED);
        return;
      }
      const mat = await builder.build(data);
      // Per-material outline color (NPR). Only assign when explicitly set;
      // otherwise the `THREE.Material.prototype.lineColor` default fires.
      if (data.lineColor !== undefined) {
        (mat as unknown as { lineColor: THREE.Color }).lineColor = new THREE.Color(data.lineColor as number);
      }
      // Per-material NPR color-preserve (0..1). Only assign when explicitly set;
      // otherwise the prototype default (0 = full NPR grayscale) fires.
      if (data.nprColorPreserve !== undefined) {
        (mat as unknown as { nprColorPreserve: number }).nprColorPreserve = data.nprColorPreserve as number;
      }

      // Load textures if referenced — await full load before caching the
      // material so the render loop only sees complete materials (textures +
      // correct colorSpace). Only applies to built-in material types that have
      // a `.map` slot (MeshStandardMaterial & kin). Custom shaders bind their
      // textures via TSL. Each map's colorspace comes from the texture's own
      // import settings (albedo srgb, normal/rough/metal linear). The PBR maps
      // load in parallel — a single missing map shouldn't block the others.
      // SceneManager.loadScene runs *after* `rendererReady` resolves (gated in
      // createEditor), so KTX2Loader has GPU caps by the time loadTexture3D fires.
      if ('map' in mat) {
        const std = mat as THREE.MeshStandardMaterial;
        const flipY = (data.flipY as boolean) ?? false;
        // Optional UV tiling for tiled surfaces (e.g. a ground plane): `textureRepeat`
        // is a single number (uniform) or [x,y]. Applied to EVERY map so albedo/normal/…
        // stay aligned. NOTE: repeat lives on the THREE.Texture, and textures are shared
        // per-GUID via the refcounted cache — so a repeat set here is seen by any other
        // material using the same texture GUID. Fine for a dedicated tiling texture; give
        // a tiled texture its own GUID if two materials need different repeats.
        const repeat = parseTextureRepeat(data.textureRepeat);
        const jobs: Promise<void>[] = [];
        const loadInto = (ref: unknown, assign: (t: THREE.Texture) => void) => {
          if (typeof ref !== 'string' || !ref) return;
          // A 3D material map is ALWAYS a GUID (the GUID-only ref invariant) or, rarely,
          // an external URL/data URI. A bare value like "1" is malformed project data:
          // resolveRef passes it through unchanged, so we'd fetch `/1` via TextureLoader,
          // 404, and log a cryptic image-error Event. Reject it up front with an
          // actionable message naming the material, and skip that map (don't fire the
          // doomed request) — the rest of the material still loads.
          if (!isGuid(ref) && !isExternalUrl(ref)) {
            console.warn(`[MeshCache] ${matPath}: invalid texture ref ${JSON.stringify(ref)} (expected an asset GUID) — skipping this map. Open the material in the Inspector and assign a texture.`);
            return;
          }
          jobs.push(
            loadTexture3D(ref, { flipY })
              .then((t) => {
                if (repeat) {
                  t.wrapS = THREE.RepeatWrapping;
                  t.wrapT = THREE.RepeatWrapping;
                  t.repeat.set(repeat[0], repeat[1]);
                  t.needsUpdate = true;
                }
                assign(t);
              })
              .catch((e) => console.warn(`[MeshCache] Texture load failed: ${ref}`, e)),
          );
        };
        loadInto(data.texture, (t) => { std.map = t; });
        loadInto(data.alphaTexture, (t) => { std.alphaMap = t; });
        loadInto(data.normalTexture, (t) => {
          std.normalMap = t;
          if (data.normalScale !== undefined) std.normalScale.set(data.normalScale as number, data.normalScale as number);
        });
        loadInto(data.bumpTexture, (t) => { std.bumpMap = t; });
        loadInto(data.displacementTexture, (t) => { std.displacementMap = t; });
        loadInto(data.roughnessTexture, (t) => { std.roughnessMap = t; });
        loadInto(data.metalnessTexture, (t) => { std.metalnessMap = t; });
        loadInto(data.emissiveTexture, (t) => { std.emissiveMap = t; });
        loadInto(data.aoTexture, (t) => { std.aoMap = t; });
        loadInto(data.lightTexture, (t) => { std.lightMap = t; });
        // Environment (reflection) map: an equirectangular texture sampled for
        // reflections — tag the mapping so THREE projects it correctly.
        loadInto(data.envTexture, (t) => { t.mapping = THREE.EquirectangularReflectionMapping; std.envMap = t; });
        if (jobs.length) {
          await Promise.all(jobs);
          std.needsUpdate = true;
        }
      }

      // If cache was disposed while we were loading, discard this material
      if (gen !== cacheGeneration) { disposeMaterial(mat); return; }
      materialCache.set(matPath, mat);
      // Wake the render loop so syncMaterial re-binds this freshly-built instance.
      // Critical for a LIVE material edit: invalidateMaterial() drops the old
      // instance and this refetch is async (fetch + KTX2 texture transcode). The
      // Inspector's persistAssetEdit fires one dirty pulse up front, but a heavy
      // material (several KTX2 maps) can finish rebuilding AFTER that grace window
      // closes — leaving the scene idle, so syncMaterial never re-applies it and the
      // meshes keep the stale material until the next redraw/reload. Firing on
      // completion makes the re-apply deterministic regardless of rebuild latency.
      // (Harmless during initial scene load — the frame loop is already drawing.)
      fireDirtyListeners();
    } catch (e) {
      console.warn(`[MeshCache] Failed to load material ${matPath}:`, e);
      materialCache.set(matPath, MATERIAL_FAILED);
    } finally {
      materialLoadPromises.delete(matPath);
    }
  })();

  materialLoadPromises.set(matPath, promise);
  return promise;
}

/** Dispose all cached GPU resources (geometries, materials, textures).
 *  Call before loading a new scene to free VRAM. */
export function disposeAllCachedResources() {
  cacheGeneration++; // invalidate in-flight async material fetches

  const disposedGeo = new Set<string>();
  const disposedMat = new Set<string>();
  // disposedTex dedupes DIRECT-dispose textures (env maps & other non-shared origins)
  // across both caches. Material map / userData textures now come from the refcounted
  // shared cache (textureResolver, texture-shader-font F3): disposeMaterial RELEASES
  // those (one ref per slot) rather than disposing them, so they're freed exactly when
  // the last scene/material referencing them is — even across the brief window where a
  // texture is shared by the outgoing and incoming scene.
  const disposedTex = new Set<string>();

  // Dispose mesh template geometries and materials
  for (const [, tmpl] of cache) {
    if (!disposedGeo.has(tmpl.geometry.uuid)) {
      tmpl.geometry.dispose();
      disposedGeo.add(tmpl.geometry.uuid);
    }
    if (!disposedMat.has(tmpl.material.uuid)) {
      disposeMaterial(tmpl.material, disposedTex);
      disposedMat.add(tmpl.material.uuid);
    }
  }
  cacheClear();
  loading.clear();
  hierarchyCache.clear();
  meshAssetCache.clear();
  meshAssetLoadPromises.clear();

  // Dispose .mat.json materials (may overlap with template materials — dedupe)
  for (const [, mat] of materialCache) {
    if (mat === MATERIAL_FAILED) continue;
    if (!disposedMat.has(mat.uuid)) {
      disposeMaterial(mat, disposedTex);
      disposedMat.add(mat.uuid);
    }
  }
  materialCache.clear();
  materialLoadPromises.clear();

  // Dispose any cached HDR environments and clear env owners — they're tied
  // to the same cacheGeneration / scene lifetime as everything else here.
  for (const [, tex] of envCache) tex.dispose();
  envCache.clear();
  envLoadPromises.clear();
  envOwners.clear();

  // Clear refcount tracking
  modelOwners.clear();
  modelLodSnapshots.clear();
  meshAssetOwners.clear();
  materialOwners.clear();
  prefabOwners.clear();
  meshTransitiveDeps.clear();
  prefabCache.clear();
  prefabLoadPromises.clear();

  // Particle effect defs and animation clips are plain data (no GPU resources),
  // but they accumulate across scene loads and a late fetch could re-register a
  // stale guid→path. Clearing the clip cache also bumps its generation so any
  // in-flight clip fetch from the old scene is dropped.
  clearParticleCache();
  clearAnimationClipCache();
  clearTimelineCache();
  clearControlSpawns(); // control-track spawns belonged to the world being torn down
  clearAnimSetCache();
  clearSpriteAnimCache();

  // Rigged GLBs (skeletal models) live in a parallel cache with their own GPU
  // resources — dispose them on full teardown too.
  disposeAllRiggedModels();

  // Decoded audio buffers (parallel cache, no GPU resources) — drop on teardown.
  disposeAllAudioBuffers();

  // SDF font atlases (parallel cache) — drop this session's fonts on teardown.
  disposeAllFonts();

  // Drop any editor import parse offered but never consumed (F4) — bounds the leak
  // of an un-taken handoff to a full teardown.
  clearParsedGltfHandoff();

  console.log(`[MeshCache] Disposed all: ${disposedGeo.size} geometries, ${disposedMat.size} materials, ${disposedTex.size} textures`);
}

// ── Refcount API ──────────────────────────────────────────
//
// Per-resource ownership tracked as Set<sceneId>. acquire() adds a sceneId to
// the set (and kicks off the load if not yet cached); release() removes the
// sceneId and disposes the GPU resource when the set becomes empty.
//
// Sub-resources (mesh templates inside a model, textures inside a material)
// live and die with their parent — no separate refcount.
//
// Granularity:
//   - Model     (.glb) → owns mesh templates in `cache`
//   - Mesh      (.mesh.json) → metadata; transitively acquires its model
//   - Material  (.mat.json) → owns one THREE.Material + texture
//   - Prefab    (.prefab.json) → owns parsed JSON
//
// All transitive dependencies are tracked under the same sceneId, so
// releaseAllForScene(sceneId) cleans up everything in one call.
//
// INVARIANT — release is wholesale, per scene, only at scene swap.
// `releaseAllForScene` is the ONLY release entry point used by app/editor code;
// there is no mid-scene per-entity release (deleting an entity does NOT release
// its mesh/material — they stay cached until the scene changes). Because every
// hold a scene has drops together at teardown, a Set<sceneId> is sufficient even
// when one scene acquires the same model via two ref paths (e.g. a ModelSource
// AND a Renderable3D mesh.json): the two holds collapse to one Set entry and the
// resource is disposed exactly once, when the scene goes away. Cross-scene
// sharing across a swap is the point of the refcount — the new scene's resources
// are acquired BEFORE releaseAllForScene(old) runs, so a model shared by two
// consecutive scenes survives (owned by {old,new} → {new}) instead of being
// disposed and re-downloaded. If resource lifetime is ever made finer-grained
// than per-scene (per-entity unload, streaming/LOD eviction, an editor
// "unload unused assets" action), this must become count-based ownership.

export type SceneId = number;

const modelOwners = new Map<string, Set<SceneId>>();      // glb path → owners
const meshAssetOwners = new Map<string, Set<SceneId>>();  // .mesh.json path → owners
const materialOwners = new Map<string, Set<SceneId>>();   // .mat.json path → owners
const prefabOwners = new Map<string, Set<SceneId>>();     // .prefab.json path → owners

// Snapshot of the transitive deps acquired for a (scene, mesh) pair, captured at
// acquire time. Release MUST use this snapshot rather than re-reading the live
// meshAssetCache — a re-import (invalidateModel) between acquire and release can
// evict the mesh-asset entry, which would otherwise strand the model/material
// owners added by acquireMesh and leak the GPU geometry forever.
const meshTransitiveDeps = new Map<string, { model?: string; material?: string }>();
const meshDepKey = (sceneId: SceneId, meshPath: string) => `${sceneId}\x00${meshPath}`;

/** Cache of fetched prefab JSON content. */
const prefabCache = new Map<string, unknown>();
/** In-flight prefab fetches. */
const prefabLoadPromises = new Map<string, Promise<void>>();

const addOwner = (map: Map<string, Set<SceneId>>, key: string, sceneId: SceneId): boolean =>
  addToOwnerSet(map, key, sceneId);

const removeOwner = (map: Map<string, Set<SceneId>>, key: string, sceneId: SceneId): boolean =>
  removeFromOwnerSet(map, key, sceneId);

/** Acquire a GLB model for a scene. Loads if not cached, refcounts if already cached.
 *  Accepts a guid or path; resolves before refcounting (cache keys are paths).
 *  When the model has been through the LOD pipeline (`modelCache.lodPaths`
 *  present), load each LOD GLB instead of the source — the build tree-shaker
 *  drops the source GLB in favor of the derived LODs, so fetching the source
 *  path would 404 on device. Mirrors fetchMeshAsset's LOD-aware branch. */
export async function acquireModel(sceneId: SceneId, glbRef: string, postprocessorId: string = 'none'): Promise<void> {
  const glbPath = refToPath(glbRef);
  if (!glbPath) return;
  addOwner(modelOwners, glbPath, sceneId);
  const modelEntry = getAssetEntry(glbRef);
  const lodPaths = modelEntry?.modelCache?.lodPaths;
  if (lodPaths && lodPaths.length > 0) {
    // Snapshot LODs at acquire so release-time invalidation can dispose them
    // even if the manifest entry has been torn down by then.
    modelLodSnapshots.set(glbPath, [...lodPaths]);
    // allSettled so partial LOD failure doesn't leak the LODs that DID load
    // — invalidateModel will still expand the full snapshot at release.
    const results = await Promise.allSettled(
      lodPaths.map(p => loadModelTemplates(p, undefined, postprocessorId)),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        console.warn(`[MeshCache] LOD ${lodPaths[i]} failed to load:`, (results[i] as PromiseRejectedResult).reason);
      }
    }
  } else {
    await loadModelTemplates(glbPath, undefined, postprocessorId);
  }
}

/** Release a GLB model for a scene. Disposes mesh templates when refcount hits zero. */
export function releaseModel(sceneId: SceneId, glbRef: string): void {
  const glbPath = refToPath(glbRef);
  if (glbPath) releaseModelByPath(sceneId, glbPath);
}

/** Internal: release using the canonical cache-key path directly. Used by
 *  releaseAllForScene where iterating the owners-map keys would otherwise
 *  re-route paths through refToPath and trip the legacy-path warning. */
function releaseModelByPath(sceneId: SceneId, glbPath: string): void {
  const wasLast = removeOwner(modelOwners, glbPath, sceneId);
  if (wasLast) {
    invalidateModel(glbPath); // disposes geometries + clears cache entries (reads snapshot)
    modelLodSnapshots.delete(glbPath); // snapshot kept ONLY while owners exist
  }
}

/** Acquire a .mesh.json asset for a scene. Accepts guid or path. Transitively
 *  acquires its underlying GLB (and the material referenced in the asset, if any). */
export async function acquireMesh(sceneId: SceneId, meshRef: string): Promise<void> {
  const meshPath = refToPath(meshRef);
  if (!meshPath || !meshPath.endsWith('.mesh.json')) return;
  addOwner(meshAssetOwners, meshPath, sceneId);

  // Fetch the .mesh.json (cached). After this, meshAssetCache has the entry.
  await fetchMeshAsset(meshPath);

  const asset = meshAssetCache.get(meshPath);
  if (!asset || asset === MESH_FAILED) return; // load failed; nothing to transitively acquire

  // Record exactly which deps we acquired so release can undo them even if the
  // mesh-asset entry is gone by then (re-import). Merge so a second acquire of
  // the same pair never drops deps captured by the first.
  const prevDeps = meshTransitiveDeps.get(meshDepKey(sceneId, meshPath));
  meshTransitiveDeps.set(meshDepKey(sceneId, meshPath), {
    model: asset.model ?? prevDeps?.model,
    material: asset.material ?? prevDeps?.material,
  });

  // Transitively acquire the underlying GLB
  if (asset.model) {
    const modelPath = refToPath(asset.model);
    if (modelPath) {
      addOwner(modelOwners, modelPath, sceneId);
      // Capture LOD snapshot so the invariant matches acquireModel: release can
      // find the LOD paths regardless of manifest state at release time.
      const modelEntry = getAssetEntry(asset.model);
      const lodPaths = modelEntry?.modelCache?.lodPaths;
      if (lodPaths && lodPaths.length > 0) {
        if (!modelLodSnapshots.has(modelPath)) modelLodSnapshots.set(modelPath, [...lodPaths]);
        // Own the template load explicitly rather than relying on fetchMeshAsset's
        // side effect: if the mesh-asset entry was cached from a prior (now-evicted)
        // scene, fetchMeshAsset short-circuits and never (re)loads templates, but
        // this acquire still adds the owner — leaving an owner with no templates.
        // Idempotent: F1 made the runtime load key path-only, so these dedupe with
        // any load fetchMeshAsset already kicked off (no re-parse). (F3)
        await Promise.allSettled(lodPaths.map(p => loadModelTemplates(p, undefined, asset.postprocessor || 'none')));
      } else {
        await loadModelTemplates(modelPath, undefined, asset.postprocessor || 'none');
      }
    }
  }

  // Transitively acquire the material referenced inside the mesh asset, if any
  if (asset.material) {
    await acquireMaterial(sceneId, asset.material);
  }
}

/** Release a .mesh.json asset for a scene. Releases transitive dependencies. */
export function releaseMesh(sceneId: SceneId, meshRef: string): void {
  const meshPath = refToPath(meshRef);
  if (meshPath) releaseMeshByPath(sceneId, meshPath);
}

function releaseMeshByPath(sceneId: SceneId, meshPath: string): void {
  if (!meshPath.endsWith('.mesh.json')) return;

  // Read the deps we ACTUALLY acquired (snapshot at acquire time). Falling back
  // to the live cache would miss deps whose mesh-asset entry was evicted by a
  // re-import between acquire and release, leaking the model/material owners.
  const key = meshDepKey(sceneId, meshPath);
  const deps = meshTransitiveDeps.get(key);
  meshTransitiveDeps.delete(key);

  const wasLast = removeOwner(meshAssetOwners, meshPath, sceneId);
  if (wasLast) {
    meshAssetCache.delete(meshPath);
  }

  // Release transitive dependencies — these are stored as guids on disk so
  // refToPath flows through the guid branch (no warning).
  if (deps?.model) releaseModel(sceneId, deps.model);
  if (deps?.material) releaseMaterial(sceneId, deps.material);
}

/** Acquire a .mat.json material for a scene. Accepts guid or path. */
export async function acquireMaterial(sceneId: SceneId, matRef: string): Promise<void> {
  const matPath = refToPath(matRef);
  if (!matPath || !matPath.endsWith('.mat.json')) return;
  addOwner(materialOwners, matPath, sceneId);
  await fetchMaterial(matPath);
}

/** Release a .mat.json material for a scene. Disposes when refcount hits zero. */
export function releaseMaterial(sceneId: SceneId, matRef: string): void {
  const matPath = refToPath(matRef);
  if (matPath) releaseMaterialByPath(sceneId, matPath);
}

function releaseMaterialByPath(sceneId: SceneId, matPath: string): void {
  if (!matPath.endsWith('.mat.json')) return;
  const wasLast = removeOwner(materialOwners, matPath, sceneId);
  if (wasLast) {
    invalidateMaterial(matPath); // disposes the THREE.Material + texture
  }
}

/** Acquire a .prefab.json file for a scene. Accepts guid or path. */
export async function acquirePrefab(sceneId: SceneId, prefabRef: string): Promise<void> {
  const prefabPath = refToPath(prefabRef);
  if (!prefabPath) return;
  addOwner(prefabOwners, prefabPath, sceneId);
  await fetchPrefab(prefabPath);
}

// ── Environment (HDR) ────────────────────────────────────
//
// HDRs previously loaded fire-and-forget from the render loop's syncEnvironment
// hook, which caused ~500 ms of unlit/black PBR rendering on scene swap.
// Now SceneManager's acquireResource awaits the HDR before the swap fires so
// the first frame of the new scene already has correct IBL lighting.

const envCache = new Map<string, THREE.DataTexture>();
const envLoadPromises = new Map<string, Promise<void>>();
const envOwners = new Map<string, Set<SceneId>>();
const hdrLoader = new HDRLoader();
// Lazily-built loader for the UltraHDR (gainmap JPEG) format — only constructed if a
// scene actually uses an `ultrahdr` env, so the WASM/loader isn't pulled otherwise.
let ultraHdrLoader: UltraHDRLoader | null = null;
function loaderForEnv(hdrPath: string) {
  if (getEnvFormat(hdrPath) === 'ultrahdr') {
    return ultraHdrLoader ?? (ultraHdrLoader = new UltraHDRLoader());
  }
  return hdrLoader;
}

/** Look up a cached HDR environment texture. Accepts guid or path. Returns undefined if not preloaded. */
export function getCachedEnvironment(hdrRef: string): THREE.DataTexture | undefined {
  const hdrPath = refToPath(hdrRef);
  if (!hdrPath) return undefined;
  return envCache.get(hdrPath);
}

/** Acquire an HDR environment for a scene. Accepts guid or path. */
export async function acquireEnvironment(sceneId: SceneId, hdrRef: string): Promise<void> {
  const hdrPath = refToPath(hdrRef);
  if (!hdrPath) return;
  addOwner(envOwners, hdrPath, sceneId);
  await fetchEnvironment(hdrPath);
}

/** Release an HDR environment for a scene. Disposes the texture on last release. */
export function releaseEnvironment(sceneId: SceneId, hdrRef: string): void {
  const hdrPath = refToPath(hdrRef);
  if (hdrPath) releaseEnvironmentByPath(sceneId, hdrPath);
}

function releaseEnvironmentByPath(sceneId: SceneId, hdrPath: string): void {
  const wasLast = removeOwner(envOwners, hdrPath, sceneId);
  if (wasLast) {
    const tex = envCache.get(hdrPath);
    if (tex) tex.dispose();
    envCache.delete(hdrPath);
    envLoadPromises.delete(hdrPath);
  }
}

/** Evict a cached HDR environment so the next acquire reloads it — called by the
 *  Environment Inspector after a re-import (new downscaled variant). Disposes the
 *  live texture + clears the in-flight promise but KEEPS the scene owners, so the
 *  next `syncEnvironment`/re-acquire re-fetches (the dev server serves the fresh
 *  `~env.hdr` bytes via ETag revalidation). Accepts a guid or path. */
export function invalidateEnvironment(hdrRef: string): void {
  // `hdrRef` may be a GUID (runtime) or the source PATH (editor re-import calls this
  // with the path). resolveRef rejects internal paths LOUDLY, so only route a GUID
  // through it and accept a path as-is — it's just the cache key. (Mirrors invalidateTexture.)
  const hdrPath = isGuid(hdrRef) ? refToPath(hdrRef) : hdrRef;
  if (!hdrPath) return;
  const tex = envCache.get(hdrPath);
  if (tex) tex.dispose();
  envCache.delete(hdrPath);
  envLoadPromises.delete(hdrPath);
}

function fetchEnvironment(hdrPath: string): Promise<void> {
  if (envCache.has(hdrPath)) return Promise.resolve();
  if (envLoadPromises.has(hdrPath)) return envLoadPromises.get(hdrPath)!;

  // Snapshot the generation BEFORE the async load so a release-mid-load (or a
  // full disposeAllCachedResources) is observable when the texture arrives.
  const gen = cacheGeneration;

  const promise = new Promise<void>((resolve) => {
    // Load the converted variant (`~env.hdr` downscaled Radiance, or `~ultrahdr.jpg`
    // gainmap) when the HDR has been converted, else the raw source. The loader is
    // picked by the resolved format (UltraHDRLoader for ultrahdr, else HDRLoader).
    loaderForEnv(hdrPath).load(
      resolveEnvVariantUrl(hdrPath) ?? assetUrl(hdrPath),
      (texture) => {
        // If the cache was disposed or the owner released this HDR mid-load,
        // dispose the just-loaded texture instead of leaving it owner-less in
        // the cache forever.
        if (gen !== cacheGeneration || !envOwners.has(hdrPath)) {
          texture.dispose();
          resolve();
          return;
        }
        texture.mapping = THREE.EquirectangularReflectionMapping;
        envCache.set(hdrPath, texture);
        // Wake the render-on-demand viewport so syncEnvironment applies this IBL.
        // Like the material refetch above, an HDR that finishes loading after the
        // Inspector's dirty grace window (editor live-edit / re-import) would otherwise
        // leave the scene idle and unlit until the next redraw (camera move) or reload.
        fireDirtyListeners();
        resolve();
      },
      undefined,
      (err) => {
        console.warn(`[MeshCache] HDR load failed for ${hdrPath}:`, err);
        resolve(); // resolve anyway — syncEnvironment will fall back to no env
      },
    );
  }).finally(() => {
    envLoadPromises.delete(hdrPath);
  });

  envLoadPromises.set(hdrPath, promise);
  return promise;
}

/** Release a .prefab.json file for a scene. Accepts guid or path. */
export function releasePrefab(sceneId: SceneId, prefabRef: string): void {
  const prefabPath = refToPath(prefabRef);
  if (prefabPath) releasePrefabByPath(sceneId, prefabPath);
}

function releasePrefabByPath(sceneId: SceneId, prefabPath: string): void {
  const wasLast = removeOwner(prefabOwners, prefabPath, sceneId);
  if (wasLast) {
    prefabCache.delete(prefabPath);
  }
}

/** Look up a cached prefab. Accepts guid or path. Returns undefined if not loaded. */
export function getCachedPrefab(prefabRef: string): unknown | undefined {
  const prefabPath = refToPath(prefabRef);
  if (!prefabPath) return undefined;
  return prefabCache.get(prefabPath);
}

/** Evict a prefab from the runtime cache so the next acquire re-fetches it from
 *  disk. Ownership (prefabOwners) is left intact — the scene still holds the
 *  prefab; we only force a fresh read. Called by the editor after it writes a
 *  `.prefab.json` (apply-to-prefab, save-as-prefab) so a subsequent scene load
 *  picks up the new file instead of a stale cached copy. Mirrors invalidateModel
 *  / invalidateMaterial. Accepts guid or path. */
export function invalidatePrefab(prefabRef: string): void {
  // The cache is keyed by the RESOLVED path. A GUID resolves via the manifest; a
  // raw path is its own key (resolveRef rejects internal asset paths → undefined,
  // so refToPath alone would silently no-op on a path). Evict both interpretations
  // so callers can pass either form.
  const resolved = isGuid(prefabRef) ? resolveRef(prefabRef) : undefined;
  for (const key of [resolved, prefabRef]) {
    if (!key) continue;
    prefabCache.delete(key);
    prefabLoadPromises.delete(key);
  }
}

function fetchPrefab(prefabPath: string): Promise<void> {
  if (prefabCache.has(prefabPath)) return Promise.resolve();
  if (prefabLoadPromises.has(prefabPath)) return prefabLoadPromises.get(prefabPath)!;

  const promise = (async () => {
    try {
      const res = await fetch(assetUrl(prefabPath), ASSET_FETCH_INIT);
      if (!res.ok) return;
      const data = await res.json() as { id?: string };
      prefabCache.set(prefabPath, data);
      if (typeof data.id === 'string') registerAsset(data.id, prefabPath, 'prefab');
    } catch (e) {
      console.warn(`[MeshCache] Failed to load prefab ${prefabPath}:`, e);
    } finally {
      prefabLoadPromises.delete(prefabPath);
    }
  })();

  prefabLoadPromises.set(prefabPath, promise);
  return promise;
}

/** Release every resource held by a given scene. Called by SceneManager when a
 *  scene is unloaded; resources held by other scenes survive.
 *
 *  The owner-map keys are canonical (path-form) cache keys, so we go through
 *  the *ByPath helpers — routing them through the public release* functions
 *  would re-resolve them via refToPath and emit the legacy-path deprecation
 *  warning on every scene swap. */
export function releaseAllForScene(sceneId: SceneId): void {
  // Iterate snapshots so we can safely mutate during release
  for (const path of [...meshAssetOwners.keys()]) {
    if (meshAssetOwners.get(path)?.has(sceneId)) releaseMeshByPath(sceneId, path);
  }
  for (const path of [...materialOwners.keys()]) {
    if (materialOwners.get(path)?.has(sceneId)) releaseMaterialByPath(sceneId, path);
  }
  for (const path of [...modelOwners.keys()]) {
    if (modelOwners.get(path)?.has(sceneId)) releaseModelByPath(sceneId, path);
  }
  for (const path of [...prefabOwners.keys()]) {
    if (prefabOwners.get(path)?.has(sceneId)) releasePrefabByPath(sceneId, path);
  }
  for (const path of [...envOwners.keys()]) {
    if (envOwners.get(path)?.has(sceneId)) releaseEnvironmentByPath(sceneId, path);
  }
  // Rigged skeletal GLBs (parallel cache) — release this scene's holds too.
  releaseRiggedModelsForScene(sceneId);
  // Audio buffers (parallel cache) — release this scene's holds too.
  releaseAudioForScene(sceneId);
  // SDF font atlases (parallel cache) — release this scene's holds too.
  releaseFontsForScene(sceneId);
}

/** Debug: snapshot of resource refcounts. Useful in tests + dev console. */
export function getResourceStats() {
  const countOwners = (m: Map<string, Set<SceneId>>) => {
    const result: Record<string, number> = {};
    for (const [k, v] of m) result[k] = v.size;
    return result;
  };
  return {
    models: countOwners(modelOwners),
    meshAssets: countOwners(meshAssetOwners),
    materials: countOwners(materialOwners),
    prefabs: countOwners(prefabOwners),
    environments: countOwners(envOwners),
    rigged: getRiggedOwnerCounts(), // owner counts from the parallel rigged GLB cache (F10)
  };
}
