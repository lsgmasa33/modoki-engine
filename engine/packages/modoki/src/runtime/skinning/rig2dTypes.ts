/** 2D skinning rig types + normalization — the PURE half of `loaders/rig2dCache.ts` (P7 C13).
 *  Moved to `skinning/` since `rig2dCache.ts` already imports `skinning/rig2dMath` for
 *  `deriveBindMatrices`/`BindBone` — the rig SHAPE is a skinning concern, not a loader
 *  concern. `loaders/rig2dCache.ts` keeps the fetch/cache logic and re-exports everything
 *  here. */

import { deriveBindMatrices, type Mat2D, type BindBone } from './rig2dMath';

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

/** A fresh, valid `.rig2d.json` document: one root bone, one empty v1 part. This is THE ONE
 *  definition behind the Skin Editor's "+ New Rig2D" (`SkinEditor.newRig`), the Assets panel's
 *  "Create 2D Rig" (`builtinCreatableAssets.ts`, via `defaultAssetData('rig2d')`), and the MCP
 *  `create-asset {type:'rig2d'}` route — none of the three inline their own copy, so they cannot
 *  drift into disagreeing about what an empty rig is. `id` is assigned by the caller (the editor
 *  mints one; the create-asset route injects one).
 *
 *  ⚠️ Both editor entry points used to inline their own byte-identical literal under this exact
 *  claim (#417) — the docstring asserted one definition while three existed, and no behavioural
 *  test could tell shared from duplicated. `tests/editor/rig2dCreateParity.test.ts` pins both
 *  editor call sites to this function; `tests/runtime/assetSchemas.test.ts` covers the MCP one. */
export function defaultRig2DFile(): Rig2DFile {
  return {
    sprite: '',
    bones: [{ name: 'root', parent: -1, x: 0, y: 0, rot: 0 }],
    mesh: { verts: [], uvs: [], tris: [] },
    skinIndices: [],
    skinWeights: [],
  };
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
/** Parts we have already reported as having weights outside the skeleton, keyed
 *  `name|boneCount|badCount` — see the warn below for why once-per-call is wrong. */
const _warnedStaleRigParts = new Set<string>();

/** Test-only: forget what has been warned about, so one test's corrupt rig cannot silence the
 *  next one's. Not called by production code — the dedupe is meant to last a session. */
export function resetRig2DWarningsForTests(): void {
  _warnedStaleRigParts.clear();
}

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
  let outOfRange = 0;
  for (let v = 0; v < vertCount; v++) {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const o = v * 4 + i;
      const bi = Array.isArray(srcIdx) && Number.isInteger(srcIdx[o]) ? srcIdx[o] | 0 : 0;
      let w = Array.isArray(srcWgt) && Number.isFinite(srcWgt[o]) ? +srcWgt[o] : (i === 0 && !Array.isArray(srcWgt) ? 1 : 0);
      if (w < 0) w = 0;
      // An index past the end of the skeleton is CLAMPED to bone 0 (the rig still has to render),
      // but it is counted and reported once below. It used to be clamped in silence, and that
      // silence is why #179 went unnoticed: `removeBone` renumbered the skeleton without
      // renumbering a v2 rig's per-part indices, so parts referenced bones that no longer existed
      // and the only symptom was geometry snapping to the root. A rig whose weights outrun its
      // bones is always a data bug — nothing legitimately authors one.
      if (bi >= boneCount || bi < 0) outOfRange++;
      skinIndices[o] = bi >= 0 && bi < boneCount ? bi : 0;
      skinWeights[o] = w;
      sum += w;
    }
    if (sum > 0) { for (let i = 0; i < 4; i++) skinWeights[v * 4 + i] /= sum; }
    else { skinWeights[v * 4] = 1; } // degenerate → fully bind to bone 0
  }

  // ONE line per part, not per vertex — a corrupted rig has thousands of bad indices and a
  // per-vertex warn would bury the very message it exists to deliver.
  //
  // And once per (part, shape), not once per CALL. `normalizeRig2D` is not load-only: the editor's
  // `applySkinDef` re-normalizes on every edit, and its own comment says it is "safe to call per
  // paint move" — so an un-deduped warn fires tens of times a second while someone drags the weight
  // brush across the very rig it is complaining about. Same reason (and same shape) as
  // `_warnedMissingClip` in scene3DSync. The key includes the count so a rig that gets WORSE says
  // so again, rather than being silenced by the first report.
  // `boneCount > 0`: a rig with NO bones yet is a normal authoring state (tessellate the mesh, then
  // add the skeleton), and every vertex defaults to index 0 — which is out of range against an empty
  // bone list. Warning there would fire on an unrigged mesh and tell its author to "undo the bone
  // edit that renumbered them", advice for a thing that never happened.
  if (outOfRange && boneCount > 0) {
    const name = typeof raw?.name === 'string' && raw.name ? raw.name : `part${index}`;
    const key = `${name}|${boneCount}|${outOfRange}`;
    if (!_warnedStaleRigParts.has(key)) {
      _warnedStaleRigParts.add(key);
      console.warn(
        `[rig2d] part "${name}": ${outOfRange} vertex weight(s) reference a bone index outside the ` +
        `skeleton (${boneCount} bone${boneCount === 1 ? '' : 's'}) — clamped to bone 0, so this part ` +
        `will deform wrongly. The rig's weights and its bone list disagree; re-bind the part, or undo ` +
        `the bone edit that renumbered them.`,
      );
    }
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

/** Coerce a raw `.rig2d.json` bone list into concrete bones with defaults.
 *
 *  **THE one copy** (#128). This lived inline in `normalizeRig2D` while the editor
 *  carried three hand-copied siblings — `SkinEditor.concreteBones`,
 *  `SkinCanvas.coerceBones` and `skinPrefab.coerceBones`. #105 Phase 4 unified the
 *  first two into an editor-local module and declared the class closed; a body-identity
 *  sweep found the other two. It lives HERE, in the layer that owns the format, because
 *  the editor's copies had already drifted from this one in two ways nobody noticed:
 *  they skipped the numeric coercion, and they dropped `noScale` entirely.
 *
 *  The file is hand-editable and every field is optional, so this is defensive by
 *  design. Four guards are load-bearing and easy to "simplify" wrongly:
 *
 *   - `Array.isArray` — a `bones` that is present but not an array yields an empty
 *     rig rather than throwing inside `.map`.
 *   - `Number.isInteger(parent)` — NOT truthiness and NOT `typeof number`. Parent is an
 *     INDEX; a float or numeric string would silently address the wrong bone in the
 *     weight solver, and index **0** is a real bone a falsy check would reparent to root.
 *   - `+(v ?? 0) || 0` on the transform fields — coerces a hand-typed `"10"` to a number
 *     and collapses `NaN` to 0. The `?? 0` (not `|| 0`) is what lets a bone legitimately
 *     at x:0, rot:0 keep those values before the coercion runs.
 *   - `noScale` is carried through. It opts the bone out of inheriting its parent's
 *     scale (`skin2DSystem` composes it via `removeScale2D`); dropping it silently
 *     changes how an animated ancestor cascades. */
export function coerceRigBones(raw: Rig2DFile['bones']): Rig2DBone[] {
  return (Array.isArray(raw) ? raw : []).map((b, i) => ({
    name: typeof b?.name === 'string' && b.name ? b.name : `bone${i}`,
    parent: Number.isInteger(b?.parent) ? (b!.parent as number) : -1,
    x: +(b?.x ?? 0) || 0,
    y: +(b?.y ?? 0) || 0,
    rot: +(b?.rot ?? 0) || 0,
    ...(b?.noScale ? { noScale: true } : {}),
  }));
}

/** Coerce arbitrary JSON into a well-formed parsed rig (fill defaults, normalize
 *  weights, derive inverse-bind) so the deform system never sees a malformed rig.
 *  A v1 rig (top-level sprite/mesh/skinIndices/skinWeights) is normalized into a single
 *  `parts` entry; a v2 rig lists `parts` explicitly. The top-level mesh fields are kept
 *  as back-compat aliases pointing at `parts[0]`. */
export function normalizeRig2D(json: Rig2DFile | undefined): ParsedRig2D {
  const bones = coerceRigBones(json?.bones);
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
