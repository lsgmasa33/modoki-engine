/** Rigged-model cache — the "parallel path" for skeletal GLBs.
 *
 *  The normal model pipeline (`meshTemplateCache.loadModelTemplates`) FLATTENS a
 *  GLB: it strips the node hierarchy, zeroes transforms, extracts per-mesh
 *  `BufferGeometry`, and discards `gltf.animations`. That's fatal for skinned
 *  meshes, which need the bone hierarchy + `Skeleton` + bind matrices + clips
 *  intact. So a rigged GLB is loaded here INSTEAD, kept WHOLE:
 *
 *    cache[path] = { prototype: gltf.scene, animations: AnimationClip[] }
 *
 *  The prototype is never added to a live scene — the render sync clones it per
 *  entity via `SkeletonUtils.clone` (each clone gets its own skeleton + pose) and
 *  builds an `AnimationMixer` from the shared clips.
 *
 *  Ownership mirrors `meshTemplateCache`'s scene-scoped refcount (`Set<sceneId>`):
 *  acquired by `SceneManager.loadScene` from the scene's `resources` manifest,
 *  released wholesale by `releaseAllForScene` (wired in meshTemplateCache). A
 *  LAZY owner (`LAZY_OWNER`) keeps editor-authored models (drag a GLB → add a
 *  SkinnedModel, no manifest entry yet) resident until full teardown. */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { isInternalAssetPath, getAssetEntry } from './assetManifest';
import { modelGlbUrl, resolveRefWarnOnce } from './modelGlbUrl';
import { addToOwnerSet, removeFromOwnerSet } from './ownerSet';
import { lodUrlSuffix } from './modelSettings';
import { getKTX2Loader, onRendererReady } from './textureResolver';
import { getModelPostprocessor } from './modelPostprocessorRegistry';
import { takeParsedGltf, disposePendingGltf } from './parsedGltfHandoff';

export interface RiggedModel {
  /** The parsed GLB scene graph — bones, SkinnedMeshes, materials. Cloned per
   *  instance; never mutated or added to a live scene directly. */
  prototype: THREE.Group;
  /** The GLB's animation clips, shared across all clones' mixers. */
  animations: THREE.AnimationClip[];
}

export type SceneId = number;

/** Sentinel owner for editor lazy-loads (no manifest entry). Negative so it can
 *  never collide with a real scene id. */
const LAZY_OWNER: SceneId = -1;

// INVARIANT (B2): keyed by PATH, not content hash — same contract as
// meshTemplateCache. The ?v=<hash> URL cache-bust handles the browser/CDN layer;
// this map is invalidated explicitly via invalidateRiggedModel() on re-import.
const cache = new Map<string, RiggedModel>();
const loadPromises = new Map<string, Promise<void>>();
const owners = new Map<string, Set<SceneId>>();

// Bumped on full dispose so a load that resolves AFTER teardown disposes its
// result instead of leaving an owner-less entry in the cache forever.
let generation = 0;

// Constructed lazily on first load (not at module scope) so importing this
// module is side-effect-free — matches meshTemplateCache, and keeps callers that
// never load a rigged GLB (and test mocks without setMeshoptDecoder) working.
let _gltfLoader: GLTFLoader | undefined;
function getLoader(): GLTFLoader {
  if (!_gltfLoader) {
    _gltfLoader = new GLTFLoader();
    _gltfLoader.setMeshoptDecoder(MeshoptDecoder);
    // Rigged GLBs are optimized at import time (/api/optimize-rigged): their
    // embedded textures become KTX2 and geometry/animation become meshopt. The
    // shared KTX2Loader singleton already has its transcoder path + GPU-format
    // detection wired by setActiveRenderer() at renderer init, so decoding the
    // KTX2 textures (UASTC→ASTC/BC7) reuses that exact config. Raw-texture GLBs
    // (un-optimized / no toktx) still load — KTX2Loader is only consulted when
    // the GLB actually carries a KHR_texture_basisu image.
    try {
      _gltfLoader.setKTX2Loader(getKTX2Loader());
    } catch (e) {
      console.warn('[RiggedCache] KTX2Loader unavailable — KTX2 textures in rigged GLBs will fail to decode:', e);
    }
  }
  return _gltfLoader;
}

const unknownGuidSeen = new Set<string>();

function refToPath(ref: string | undefined | null): string | undefined {
  const raw = resolveRefWarnOnce(ref, 'RiggedCache', unknownGuidSeen);
  // When a derived optimized variant exists (resize + KTX2 + meshopt, produced
  // by convertRiggedModel), request it at the CURRENT-context URL — the raw
  // asset path + suffix — NOT the stored `modelCache.processedPath`. That stored
  // value bakes in the import-time base (`/games/<id>/assets/…` in a repo build
  // vs `/assets/…` in a flat MODOKI_PROJECT) and 404s when the project is served
  // in a different context. lodUrlSuffix(0) === '.processed.glb', matching the
  // dev middleware + build copy. If the variant isn't available in this context
  // (cache keyed under a different base, or not yet derived), fetchRiggedModel
  // falls back to the raw URL so the model still renders (unoptimized).
  if (raw && ref && getAssetEntry(ref)?.modelCache) return raw + lodUrlSuffix(0);
  return raw;
}

const addOwner = (key: string, sceneId: SceneId): void => { addToOwnerSet(owners, key, sceneId); };

/** Remove an owner; returns true if that was the LAST owner. */
const removeOwner = (key: string, sceneId: SceneId): boolean => removeFromOwnerSet(owners, key, sceneId);

/** Dispose every geometry/material/texture in a parsed GLB scene. Called on last
 *  release — safe because clones SHARE these (SkeletonUtils.clone reuses geometry
 *  + materials by reference), so this only runs once no clone can exist anymore.
 *  Dedupes textures across meshes (a material/texture shared by several
 *  SkinnedMeshes is disposed once) by threading one `disposedTex` set through
 *  the per-mesh `disposeMesh`. */
function disposePrototype(model: RiggedModel): void {
  const disposedTex = new Set<THREE.Texture>();
  model.prototype.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) disposeMesh(mesh, disposedTex);
  });
}

/** Raw-source fallback URL for a `.processed.glb` variant path (strip the
 *  suffix). Undefined when `path` is already the raw URL. */
function rawFallbackOf(path: string): string | undefined {
  const suffix = lodUrlSuffix(0); // '.processed.glb'
  return path.endsWith(suffix) ? path.slice(0, -suffix.length) : undefined;
}

/** Dispose a single mesh's geometry + materials (+ their textures). Used when a
 *  postprocessor's filterMesh drops a mesh from the prototype before caching,
 *  and per-mesh by `disposePrototype` on last release. Pass a shared
 *  `disposedTex` set to dedupe textures across multiple meshes (a texture used
 *  by several meshes is disposed once). */
function disposeMesh(mesh: THREE.Mesh, disposedTex?: Set<THREE.Texture>): void {
  mesh.geometry?.dispose();
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of mats) {
    if (!mat) continue;
    for (const key of Object.keys(mat)) {
      const tex = (mat as unknown as Record<string, unknown>)[key] as THREE.Texture | undefined;
      if (tex && tex.isTexture) {
        if (disposedTex) {
          if (!disposedTex.has(tex)) { tex.dispose(); disposedTex.add(tex); }
        } else {
          tex.dispose();
        }
      }
    }
    mat.dispose();
  }
}

function fetchRiggedModel(path: string, postprocessorId?: string): Promise<void> {
  if (cache.has(path)) { disposePendingGltf(path); return Promise.resolve(); }
  if (loadPromises.has(path)) return loadPromises.get(path)!;

  const gen = generation;
  // Try the derived variant first; on failure, fall back to the raw source so a
  // missing/mis-based variant (e.g. project served in a different URL context
  // than it was imported in) never leaves the model invisible.
  const fallback = rawFallbackOf(path);
  const candidates = fallback ? [path, fallback] : [path];
  const promise = new Promise<void>((resolve) => {
    // Promote a parsed scene into the cache (shared by the GLTFLoader callback and
    // the editor import handoff). `loadedFrom` is just the log label.
    const finishLoad = (gltf: { scene: THREE.Group; animations?: THREE.AnimationClip[] }, loadedFrom: string) => {
      // Disposed (teardown) or released mid-load → drop the result.
      if (gen !== generation || !owners.has(path)) {
        const tmp: RiggedModel = { prototype: gltf.scene, animations: gltf.animations ?? [] };
        disposePrototype(tmp);
        resolve();
        return;
      }
      // Strip embedded lights/cameras — imported models often bundle the
      // artist's scene lights (e.g. an FBX PointLight at intensity 787 that
      // blows out the whole model). The scene provides lighting + camera.
      const extras: THREE.Object3D[] = [];
      gltf.scene.traverse((o) => {
        if ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera) extras.push(o);
      });
      for (const o of extras) o.removeFromParent();

      // Apply the model postprocessor's filterMesh — the rigged mirror of the
      // static loader (loadGLB). Drops excluded meshes (e.g. a baked ground
      // "Plane") from the prototype ONCE, so every SkeletonUtils clone inherits
      // the filtered tree. Without this, re-importing the FBX (which re-adds the
      // Plane to the GLB) brings it back, since the rigged path never honored it.
      const postprocessor = postprocessorId ? getModelPostprocessor(postprocessorId) : null;
      if (postprocessor?.filterMesh) {
        const drop: THREE.Mesh[] = [];
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && !postprocessor.filterMesh!(mesh)) drop.push(mesh);
        });
        for (const mesh of drop) { mesh.removeFromParent(); disposeMesh(mesh); }
        if (drop.length) console.log(`[RiggedCache] postprocessor "${postprocessorId}" dropped ${drop.length} mesh(es): ${drop.map((m) => m.name).join(', ')}`);
      }

      const model: RiggedModel = { prototype: gltf.scene, animations: gltf.animations ?? [] };
      // Key under the original `path` (the refToPath result) so getRiggedModel
      // / owners lookups resolve regardless of which candidate actually loaded.
      cache.set(path, model);
      console.log(`[RiggedCache] Loaded ${loadedFrom} — ${model.animations.length} clip(s): ${model.animations.map((c) => c.name).join(', ')}`);
      resolve();
    };

    // The editor importer already parsed this GLB for rig inspection — reuse that
    // parse instead of a second GLTFLoader.load (F4). Runtime acquires never offer.
    const handoff = takeParsedGltf(path);
    if (handoff) { finishLoad({ scene: handoff.scene, animations: handoff.animations }, `${path} (import handoff)`); return; }

    const tryLoad = (i: number) => getLoader().load(
      // modelGlbUrl appends the model's content hash as ?v=<hash> in PROD builds
      // (mirrors the static modelGlbUrl path) so a re-import busts immutable
      // CDN/browser caches. Both candidates (the `.processed.glb` variant and
      // the raw fallback) resolve the hash from the base model's manifest entry.
      modelGlbUrl(candidates[i]),
      (gltf) => finishLoad(gltf as { scene: THREE.Group; animations?: THREE.AnimationClip[] }, candidates[i]),
      undefined,
      (err) => {
        if (i + 1 < candidates.length) {
          console.warn(`[RiggedCache] ${candidates[i]} failed; falling back to raw ${candidates[i + 1]}`);
          tryLoad(i + 1);
        } else {
          console.error(`[RiggedCache] Failed to load ${path}:`, err);
          resolve(); // resolve anyway — the render sync just skips an unloaded model
        }
      },
    );
    // An optimized rigged GLB (`.processed.glb`) carries its textures as embedded
    // KTX2 (KHR_texture_basisu), decoded by the shared KTX2Loader the GLTFLoader
    // was handed above. That loader can't decode until setActiveRenderer wires its
    // GPU caps (detectSupport), so start the load only once the renderer is ready —
    // otherwise the GLTFLoader's internal KTX2 decode races WebGPU init and throws
    // "Missing initialization with `.detectSupport( renderer )`" (the same Android
    // race fixed for loadTexture3D). onRendererReady fires synchronously if the
    // renderer is already active; a rigged model only loads in a 3D-render context,
    // so the renderer always arrives (a 2D-only `disable3D` game never gets here).
    onRendererReady(() => tryLoad(0));
  }).finally(() => {
    loadPromises.delete(path);
  });

  loadPromises.set(path, promise);
  return promise;
}

// ── Public API ──────────────────────────────────────────

/** The model's postprocessor id from its manifest entry (baked from the GLB's
 *  `.meta.json`). A rigged model has no ModelSource trait to carry it, so this is
 *  the runtime source for filterMesh (e.g. dropping a baked ground "Plane"). */
function postprocessorFor(modelRef: string): string | undefined {
  return getAssetEntry(modelRef)?.postprocessor;
}

/** Acquire a rigged GLB for a scene (manifest-driven). Accepts guid or path. */
export async function acquireRiggedModel(sceneId: SceneId, modelRef: string): Promise<void> {
  const path = refToPath(modelRef);
  if (!path) return;
  addOwner(path, sceneId);
  await fetchRiggedModel(path, postprocessorFor(modelRef));
}

/** Per-path owner counts for the rigged cache — mirrors meshTemplateCache's
 *  countOwners so `getResourceStats` can surface stuck rigged owners (a refcount
 *  that never empties after the last release). Observability only. (F10) */
export function getRiggedOwnerCounts(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [path, set] of owners) result[path] = set.size;
  return result;
}

/** Release every rigged GLB held by a scene; disposes on last owner. */
export function releaseRiggedModelsForScene(sceneId: SceneId): void {
  for (const path of [...owners.keys()]) {
    if (!owners.get(path)?.has(sceneId)) continue;
    if (removeOwner(path, sceneId)) {
      const model = cache.get(path);
      if (model) disposePrototype(model);
      cache.delete(path);
      loadPromises.delete(path);
    }
  }
}

/** Editor convenience: ensure a model is loading even without a manifest entry
 *  (drag a GLB → add a SkinnedModel). Held by LAZY_OWNER so it stays resident for
 *  the session; cleared by `disposeAllRiggedModels`. Idempotent + deduped. */
export function ensureRiggedModelLoaded(modelRef: string): void {
  const path = refToPath(modelRef);
  if (!path) return;
  // Already cached → nothing to load; drop any import handoff so it can't strand.
  if (cache.has(path)) { disposePendingGltf(path); return; }
  addOwner(path, LAZY_OWNER);
  void fetchRiggedModel(path, postprocessorFor(modelRef));
}

/** Evict a rigged model from the cache so the next acquire reloads the
 *  freshly-derived variant (editor re-import). Disposes the cached prototype —
 *  the caller MUST have evicted any live clones first: scene3DSync's
 *  `attachInvalidationListener` does this on the `onModelInvalidated` event,
 *  which fires (synchronously) from `invalidateModel` BEFORE this is called.
 *  Owners are left intact so the next render re-acquires + reloads. Idempotent. */
export function invalidateRiggedModel(modelRef: string): void {
  // Accept a GUID (resolve to the cache key) OR a literal asset path. The import
  // pipeline invalidates by PATH — before the GUID has been read from the meta —
  // so routing a path through refToPath would hit resolveRef's "use a GUID" reject
  // (a spurious console.error) AND silently no-op. For a path we can't consult the
  // manifest to know if it loaded raw or as the optimized variant, so clear BOTH
  // candidate keys (`path` and `path + '.processed.glb'`).
  const keys = isInternalAssetPath(modelRef)
    ? [modelRef, modelRef + lodUrlSuffix(0)]
    : [refToPath(modelRef)];
  for (const key of keys) {
    if (!key) continue;
    const model = cache.get(key);
    if (model) disposePrototype(model);
    cache.delete(key);
    loadPromises.delete(key);
  }
}

/** Look up a loaded rigged model. Accepts guid or path. Undefined until loaded. */
export function getRiggedModel(modelRef: string): RiggedModel | undefined {
  const path = refToPath(modelRef);
  if (!path) return undefined;
  return cache.get(path);
}

/** Clip names available in a loaded rigged model (for the Inspector dropdown).
 *  Empty until the GLB has loaded. Accepts guid or path. */
export function getClipNames(modelRef: string): string[] {
  return getRiggedModel(modelRef)?.animations.map((c) => c.name) ?? [];
}

/** One mesh node of a rigged model + the distinct material slots it uses. */
export interface RigMeshNode {
  /** GLB mesh-node name (the `SkinnedMeshRenderer.node` value). */
  node: string;
  /** Distinct material-slot names used by this node (the override slot keys). */
  materials: string[];
}

/** The rigged model's mesh-node structure: one entry per mesh node, each with
 *  its distinct material slots. Drives import (one SkinnedMeshRenderer per node)
 *  and the Inspector. Empty until the GLB has loaded. Mirrors scene3DSync's
 *  `buildNodes` grouping (named-Group parent = node, else the mesh's own name —
 *  so the 148 eye primitives collapse to one node). Accepts guid or path. */
export function getRigStructure(modelRef: string): RigMeshNode[] {
  const model = getRiggedModel(modelRef);
  if (!model) return [];
  const nodes = new Map<string, Set<string>>();
  model.prototype.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const p = mesh.parent as (THREE.Object3D & { isGroup?: boolean }) | null;
    const nodeName = (p && p.name && (p.isGroup || p.type === 'Group')) ? p.name : mesh.name;
    let set = nodes.get(nodeName);
    if (!set) { set = new Set(); nodes.set(nodeName, set); }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) { const s = (m?.name) || mesh.name; if (s) set.add(s); }
  });
  return [...nodes].map(([node, mats]) => ({ node, materials: [...mats] }));
}

/** Distinct material slots for ONE mesh node (the Inspector's per-renderer
 *  pickers). Empty until the GLB has loaded. Accepts guid or path. */
export function getNodeMaterials(modelRef: string, node: string): string[] {
  return getRigStructure(modelRef).find((n) => n.node === node)?.materials ?? [];
}

/** Bone names in a loaded rigged model's skeleton (for the BoneAttachment
 *  Inspector dropdown). Empty until the GLB has loaded. Accepts guid or path. */
export function getBoneNames(modelRef: string): string[] {
  const model = getRiggedModel(modelRef);
  if (!model) return [];
  const names: string[] = [];
  model.prototype.traverse((o) => { if ((o as THREE.Bone).isBone) names.push(o.name); });
  return names;
}

/** Dispose ALL cached rigged models (full teardown / world reset). */
export function disposeAllRiggedModels(): void {
  generation++;
  for (const model of cache.values()) disposePrototype(model);
  cache.clear();
  loadPromises.clear();
  owners.clear();
}
