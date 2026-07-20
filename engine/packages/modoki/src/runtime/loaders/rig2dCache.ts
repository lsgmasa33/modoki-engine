/** Loads + caches `.rig2d.json` 2D skinning rigs, resolving GUID/path refs through
 *  the shared asset manifest. Mirrors `spriteAnimCache`: the first access kicks off
 *  an async fetch and returns null until it resolves; while a load is PENDING the
 *  per-frame deform driver (`skin2DSystem`) simply retries next frame. A FAILED
 *  fetch is remembered in `failed` and NOT retried at runtime (only invalidate/clear
 *  resets it). A rig is plain DATA (mesh + bind-pose bones + weights) — nothing to
 *  GPU-dispose; the backing texture is owned by the sprite/scene-resource lifecycle.
 *
 *  A `.rig2d.json` holds: a `sprite` GUID (the source texture), a bind-pose bone
 *  hierarchy (`bones`), a deformable `mesh` (verts/uvs/tris in texture space), and
 *  per-vertex `skinIndices`/`skinWeights` (≤4 influences). The inverse-bind matrices
 *  are DERIVED once here (not stored in JSON) via `deriveBindMatrices`.
 *
 *  NOT to be confused with `.animset.json` (skeletal 3D clips) or `.spriteanim.json`
 *  (flipbook sprite clips). */

import { resolveRef, isGuid, registerAsset } from './assetManifest';
import { assetUrl } from './assetUrl';
import { deriveBindMatrices, type Mat2D, type BindBone } from '../skinning/rig2dMath';

/** One bind-pose bone: a name plus its local TRS (relative to its parent bone; the
 *  root bone's parent is -1, so its local is relative to the rig origin). `noScale`
 *  opts the bone out of inheriting its parent's SCALE at pose time (Spine's `noScale`
 *  transform mode) — rotation + translation still inherit. */
export interface Rig2DBone extends BindBone {
  name: string;
  noScale?: boolean;
}

/** One skinnable part: a sprite + deformable mesh + per-vertex weights into the SHARED
 *  bone skeleton. A v1 rig is a single implicit part; a v2 rig lists many (`parts`). */
export interface Rig2DPart {
  name?: string;
  sprite?: string;
  mesh?: { verts?: number[][]; uvs?: number[][]; tris?: number[] };
  skinIndices?: number[];
  skinWeights?: number[];
  /** Draw order within the rig (lower = behind). Defaults to array index. */
  order?: number;
  visible?: boolean;
}

/** The raw `.rig2d.json` payload (pre-normalization). v1 = single top-level
 *  sprite/mesh/skinIndices/skinWeights; v2 = a `parts[]` list over the shared `bones`.
 *  v1 fields are still read and normalized into a one-element `parts`. */
export interface Rig2DFile {
  id?: string;
  bones?: Array<{ name?: string; parent?: number; x?: number; y?: number; rot?: number; noScale?: boolean }>;
  /** v2: many parts sharing the bone skeleton. */
  parts?: Rig2DPart[];
  /** v1 (single part) — synthesized into `parts[0]` when `parts` is absent. */
  sprite?: string;
  mesh?: { verts?: number[][]; uvs?: number[][]; tris?: number[] };
  skinIndices?: number[];
  skinWeights?: number[];
}

/** A parsed, render-ready part: typed geometry buffers + its sprite + draw order. */
export interface ParsedRig2DPart {
  name: string;
  sprite: string;
  order: number;
  visible: boolean;
  vertCount: number;
  verts: Float32Array;       // packed [x0,y0,…] bind positions (texture space)
  uvs: Float32Array;         // packed [u0,v0,…] (0..1 into the part's sprite)
  tris: Uint32Array;         // triangle index buffer
  skinIndices: Uint32Array;  // 4 bone indices per vertex (into the shared bones)
  skinWeights: Float32Array; // 4 weights per vertex (normalized; unused slots 0)
}

/** A parsed, render-ready rig: SHARED skeleton (bones + inverse-bind) + one-or-more
 *  parts. The top-level mesh fields are back-compat ALIASES for `parts[0]` so existing
 *  single-mesh consumers (editor weight heatmap, tests) keep working unchanged. */
export interface ParsedRig2D {
  id?: string;
  bones: Rig2DBone[];
  /** Inverse of each bone's bind-pose rig-origin matrix, per bone index. */
  invBind: Mat2D[];
  boneIndexByName: Map<string, number>;
  /** All skinnable parts, in draw order. Always ≥1 (a v1 rig → one part). */
  parts: ParsedRig2DPart[];
  // ── Back-compat aliases = parts[0] (empty defaults when there are no parts). ──
  sprite: string;
  vertCount: number;
  verts: Float32Array;
  uvs: Float32Array;
  tris: Uint32Array;
  skinIndices: Uint32Array;
  skinWeights: Float32Array;
}

const cache = new Map<string, ParsedRig2D>();
const loading = new Map<string, Promise<void>>();
const failed = new Set<string>();
let generation = 0;

/** Resolve a cache key. A GUID resolves through the manifest; the editor seeds /
 *  invalidates by file path directly (like spriteAnimCache). */
function rig2dCacheKey(refOrPath: string): string | undefined {
  if (!refOrPath) return undefined;
  return isGuid(refOrPath) ? resolveRef(refOrPath) : refOrPath;
}

function toFloat2Packed(pairs: number[][] | undefined, n: number): Float32Array {
  const out = new Float32Array(n * 2);
  if (Array.isArray(pairs)) {
    for (let i = 0; i < n; i++) {
      const p = pairs[i];
      if (Array.isArray(p)) { out[i * 2] = +p[0] || 0; out[i * 2 + 1] = +p[1] || 0; }
    }
  }
  return out;
}

/** Coerce one raw part (mesh + weights + sprite) into a render-ready `ParsedRig2DPart`,
 *  filling defaults, clamping bone indices, and renormalizing weights so LBS is affine. */
function normalizePart(raw: Rig2DPart, index: number, boneCount: number): ParsedRig2DPart {
  const verts2d = raw?.mesh?.verts;
  const vertCount = Array.isArray(verts2d) ? verts2d.length : 0;
  const verts = toFloat2Packed(verts2d, vertCount);
  const uvs = toFloat2Packed(raw?.mesh?.uvs, vertCount);

  const rawTris = Array.isArray(raw?.mesh?.tris) ? raw!.mesh!.tris! : [];
  const tris = Uint32Array.from(rawTris.filter((t) => Number.isFinite(t)).map((t) => t | 0));

  // Skin weights: 4 per vertex. Default every vertex fully to bone 0 when absent,
  // and renormalize each vertex's weights so LBS is affine (sum = 1).
  const skinIndices = new Uint32Array(vertCount * 4);
  const skinWeights = new Float32Array(vertCount * 4);
  const srcIdx = raw?.skinIndices, srcWgt = raw?.skinWeights;
  for (let v = 0; v < vertCount; v++) {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const o = v * 4 + i;
      const bi = Array.isArray(srcIdx) && Number.isInteger(srcIdx[o]) ? srcIdx[o] | 0 : 0;
      let w = Array.isArray(srcWgt) && Number.isFinite(srcWgt[o]) ? +srcWgt[o] : (i === 0 && !Array.isArray(srcWgt) ? 1 : 0);
      if (w < 0) w = 0;
      skinIndices[o] = bi >= 0 && bi < boneCount ? bi : 0;
      skinWeights[o] = w;
      sum += w;
    }
    if (sum > 0) { for (let i = 0; i < 4; i++) skinWeights[v * 4 + i] /= sum; }
    else { skinWeights[v * 4] = 1; } // degenerate → fully bind to bone 0
  }

  return {
    name: typeof raw?.name === 'string' && raw.name ? raw.name : `part${index}`,
    sprite: typeof raw?.sprite === 'string' ? raw.sprite : '',
    order: Number.isFinite(raw?.order) ? (raw!.order as number) : index,
    visible: raw?.visible !== false,
    vertCount, verts, uvs, tris, skinIndices, skinWeights,
  };
}

const EMPTY_PART_ALIASES = {
  sprite: '', vertCount: 0,
  verts: new Float32Array(0), uvs: new Float32Array(0), tris: new Uint32Array(0),
  skinIndices: new Uint32Array(0), skinWeights: new Float32Array(0),
};

/** Coerce arbitrary JSON into a well-formed parsed rig (fill defaults, normalize
 *  weights, derive inverse-bind) so the deform system never sees a malformed rig.
 *  A v1 rig (top-level sprite/mesh/skinIndices/skinWeights) is normalized into a single
 *  `parts` entry; a v2 rig lists `parts` explicitly. The top-level mesh fields are kept
 *  as back-compat aliases pointing at `parts[0]`. */
export function normalizeRig2D(json: Rig2DFile | undefined): ParsedRig2D {
  const rawBones = Array.isArray(json?.bones) ? json!.bones! : [];
  const bones: Rig2DBone[] = rawBones.map((b, i) => ({
    name: typeof b?.name === 'string' && b.name ? b.name : `bone${i}`,
    parent: Number.isInteger(b?.parent) ? (b!.parent as number) : -1,
    x: +(b?.x ?? 0) || 0,
    y: +(b?.y ?? 0) || 0,
    rot: +(b?.rot ?? 0) || 0,
    ...(b?.noScale ? { noScale: true } : {}),
  }));
  const boneIndexByName = new Map<string, number>();
  bones.forEach((b, i) => boneIndexByName.set(b.name, i));
  const { invBind } = deriveBindMatrices(bones);

  // v2 parts[], else synthesize a single part from the v1 top-level fields.
  const rawParts: Rig2DPart[] = Array.isArray(json?.parts) && json!.parts!.length
    ? json!.parts!
    : [{ name: 'main', sprite: json?.sprite, mesh: json?.mesh, skinIndices: json?.skinIndices, skinWeights: json?.skinWeights, order: 0 }];
  const parts = rawParts
    .map((p, i) => normalizePart(p, i, bones.length))
    .sort((a, b) => a.order - b.order);

  const p0 = parts[0];
  return {
    id: json?.id,
    bones, invBind, boneIndexByName, parts,
    // Back-compat aliases for single-mesh consumers (editor heatmap, tests).
    ...(p0
      ? { sprite: p0.sprite, vertCount: p0.vertCount, verts: p0.verts, uvs: p0.uvs, tris: p0.tris, skinIndices: p0.skinIndices, skinWeights: p0.skinWeights }
      : EMPTY_PART_ALIASES),
  };
}

/** Resolve a rig ref to its parsed rig, or null if not yet loaded. Kicks off a lazy
 *  fetch on first miss (retried each frame by the caller). */
export function getRig2D(ref: string): ParsedRig2D | null {
  if (!ref) return null;
  const path = rig2dCacheKey(ref);
  if (!path) return null;
  const hit = cache.get(path);
  if (hit) return hit;
  if (failed.has(path)) return null;
  if (!loading.has(path)) {
    const gen = generation;
    const p = fetch(assetUrl(path))
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((json) => {
        if (gen !== generation) return;       // scene swap mid-flight
        if (cache.has(path)) return;          // editor live-preview seeded it
        const id = (json as Rig2DFile)?.id;
        if (id && isGuid(id)) registerAsset(id, path, 'rig2d');
        cache.set(path, normalizeRig2D(json as Rig2DFile));
      })
      .catch((e) => {
        if (gen === generation) failed.add(path);
        console.warn(`[rig2dCache] failed to load ${path}:`, e);
      })
      .finally(() => loading.delete(path));
    loading.set(path, p);
  }
  return null;
}

/** Directly seed/override a cached rig by path or GUID (editor live-preview +
 *  post-save + tests). */
export function setRig2D(refOrPath: string, def: Rig2DFile): void {
  const path = rig2dCacheKey(refOrPath);
  if (!path) return;
  cache.set(path, normalizeRig2D(def));
  failed.delete(path);
}

/** Drop a cached rig so the next access re-fetches (e.g. after an external edit). */
export function invalidateRig2D(refOrPath: string): void {
  const path = rig2dCacheKey(refOrPath);
  if (!path) return;
  cache.delete(path);
  failed.delete(path);
  loading.delete(path);
}

/** Drop ALL cached rigs (scene swap / full resource disposal / test teardown). */
export function clearRig2DCache(): void {
  generation++;
  cache.clear();
  loading.clear();
  failed.clear();
}
