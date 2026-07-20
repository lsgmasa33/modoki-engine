/**
 * Keyframe animation data model — the on-disk `.anim.json` clip format.
 *
 * A clip animates fields of ECS traits over time. Tracks bind to entities by a
 * relative name-path from the entity that carries the `Animator` trait (the
 * "root"), so a clip is a reusable asset that works across prefab instances —
 * the same model as Unity's AnimationClip + Animator.
 *
 * Values are plain numbers:
 *   - `number` tracks  → the field value directly.
 *   - `color`  tracks  → a packed 0xRRGGBB integer (interpolated per channel).
 *   - `boolean` tracks → 0 | 1 (always stepped).
 *   - `enum`   tracks  → the option index into the field's static option list
 *                        (always stepped; decoded back to the string on apply).
 */

export type TrackValueType = 'number' | 'color' | 'boolean' | 'enum';

/** How a key's in/out tangents are derived. Persisted per-key so recording and
 *  neighbor-recompute can preserve a user's choice instead of forcing 'auto'.
 *  Mirrors Unity's tangent menu. (Defined here, not curveEval, so Keyframe can
 *  reference it without a circular import; curveEval re-exports it.) */
export type TangentMode = 'auto' | 'linear' | 'constant' | 'free';

/** A `stepped` (constant) segment is encoded by an outgoing tangent of Infinity
 *  on the left key — matching Unity's "Constant" tangent mode. */
export const STEPPED = Number.POSITIVE_INFINITY;

/** Default weighted-tangent weight (Unity uses 1/3 for free/auto tangents). */
export const DEFAULT_TANGENT_WEIGHT = 1 / 3;

export interface Keyframe {
  /** Time in SECONDS along the clip. */
  t: number;
  /** Value at this key (see TrackValueType for encoding). */
  v: number;
  /** Incoming tangent slope (value-units per second). STEPPED is allowed. */
  inTangent: number;
  /** Outgoing tangent slope (value-units per second). STEPPED → hold this value. */
  outTangent: number;
  /** Weighted-tangent weight for the incoming handle (0..1). Default 1/3. */
  inWeight?: number;
  /** Weighted-tangent weight for the outgoing handle (0..1). Default 1/3. */
  outWeight?: number;
  /** When true, the in/out tangents are edited independently (a "broken" key). */
  broken?: boolean;
  /** How the tangents were last set. Persisted so recording (and a neighbor
   *  value change) re-applies the SAME mode instead of flattening to 'auto'.
   *  Absent ⇒ treated as 'auto' for backward compatibility with older clips. */
  tangentMode?: TangentMode;
}

export interface AnimationTrack {
  /** Relative name-path from the Animator root entity. "" = the root itself.
   *  Segments are separated by "/" and match child EntityAttributes.name. */
  path: string;
  /** Trait name as registered in the trait registry, e.g. "Transform". */
  trait: string;
  /** Field within the trait, e.g. "rx". */
  field: string;
  type: TrackValueType;
  /** Keyframes, kept sorted ascending by `t`. */
  keys: Keyframe[];
}

/** One keyframe of a deform (per-vertex mesh) timeline — a DENSE array of local-space
 *  offset deltas [dx0,dy0,dx1,dy1,…], length 2×vertCount, added to the part's BIND
 *  vertices before skinning (Spine "deform" — cloth/cape flutter, squash beyond what
 *  bones express). Spine's sparse `offset` start is padded to dense at import so the
 *  runtime needs no per-key offset bookkeeping. */
export interface DeformKey {
  /** Time in SECONDS along the clip. */
  t: number;
  /** Dense per-vertex offset deltas in the part's bind/texture space (y-down). */
  offsets: number[];
}

/** A non-scalar animation channel: per-vertex mesh deformation of one rig PART.
 *  Sits ALONGSIDE the scalar `tracks[]` (which drive bones); this drives the mesh
 *  vertices directly. Bound to the `SkinnedSprite2D` entity by the same relative
 *  name-path model, plus a `part` name to pick the part within a multi-part rig.
 *  Interpolated LINEARLY between keys (Spine deform is typically linear; per-frame
 *  curves are a later refinement). */
export interface DeformTrack {
  /** Relative name-path from the Animator root to the SkinnedSprite2D entity. */
  path: string;
  /** Part name within the rig this deform targets (matches Rig2DPart.name). */
  part: string;
  /** Keys sorted ascending by `t`. All keys must share the same vertex count. */
  keys: DeformKey[];
}

export interface AnimationClipDef {
  /** Stable GUID — mirrors the `.meta.json` sidecar id. */
  id: string;
  name: string;
  /** Clip length in seconds. */
  duration: number;
  /** Authoring sample rate ("Samples" in Unity), used for frame snapping. */
  frameRate: number;
  loop: boolean;
  tracks: AnimationTrack[];
  /** Optional per-vertex mesh-deform channels (Spine deform). Absent on scalar-only
   *  clips (the common case) — no cost when unused. */
  deformTracks?: DeformTrack[];
}

/** A fresh empty clip (1 second, 60 fps, looping). */
export function defaultAnimationClip(id: string, name = 'New Clip'): AnimationClipDef {
  return { id, name, duration: 1, frameRate: 60, loop: true, tracks: [] };
}

/** A finite slope or STEPPED (+Infinity) is kept; anything else (undefined / NaN)
 *  becomes 0 (flat). Keeps evalSegment + evalTrack agreeing on missing tangents. */
function normTangent(x: number): number {
  return Number.isFinite(x) || x === STEPPED ? x : 0;
}

/** Fill any missing optional fields so partial/older JSON loads safely. */
export function normalizeAnimationClip(json: Partial<AnimationClipDef>): AnimationClipDef {
  return {
    id: json.id ?? '',
    name: json.name ?? 'Clip',
    duration: typeof json.duration === 'number' ? json.duration : 1,
    frameRate: typeof json.frameRate === 'number' && json.frameRate > 0 ? json.frameRate : 60,
    loop: json.loop ?? true,
    tracks: Array.isArray(json.tracks)
      ? json.tracks.map((tr) => ({
          path: tr.path ?? '',
          trait: tr.trait ?? '',
          field: tr.field ?? '',
          type: tr.type ?? 'number',
          // Default missing/NaN tangents to 0 (flat) so a partial/legacy key
          // interpolates smoothly. Without this, an absent outTangent reads as
          // `undefined` → not finite → evalTrack treats the key as STEPPED (hold),
          // disagreeing with evalSegment which reads it as 0 (smooth). STEPPED
          // (+Infinity) is a deliberate value and preserved. (F8)
          //
          // STEPPED survives JSON via `tangentMode:'constant'`, NOT the raw
          // out-tangent: JSON.stringify(Infinity) === "null", so a saved/imported
          // stepped key loses its +Infinity and would reload as linear. The
          // 'constant' mode IS the persistent stepped marker (applyTangentMode sets
          // both) — reconstruct STEPPED from it here so on-disk / imported holds
          // (e.g. Spine STEPPED curves) round-trip instead of linear-approximating.
          keys: Array.isArray(tr.keys)
            ? tr.keys
                .map((k) => ({
                  ...k,
                  inTangent: normTangent(k.inTangent),
                  outTangent: k.tangentMode === 'constant' ? STEPPED : normTangent(k.outTangent),
                }))
                .sort((a, b) => a.t - b.t)
            : [],
        }))
      : [],
    deformTracks: Array.isArray(json.deformTracks)
      ? json.deformTracks.map((dt) => ({
          path: dt.path ?? '',
          part: dt.part ?? '',
          keys: Array.isArray(dt.keys)
            ? dt.keys
                .map((k) => ({ t: k.t ?? 0, offsets: Array.isArray(k.offsets) ? k.offsets : [] }))
                .sort((a, b) => a.t - b.t)
            : [],
        }))
      : undefined,
  };
}
