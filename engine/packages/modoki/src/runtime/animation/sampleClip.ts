/**
 * Apply an animation clip to a bound entity hierarchy at a given time.
 *
 * Shared by BOTH the runtime `animationSystem` and the editor scrub/preview, so
 * authored and played-back motion are guaranteed identical. Tracks bind to the
 * `Animator` root entity by relative name-path (Unity model): "" is the root,
 * "body/arm" is the descendant reached by matching child `EntityAttributes.name`.
 */

import type { World } from 'koota';
import { EntityAttributes } from '../traits/EntityAttributes';
import { getTraitByName, type TraitMeta } from '../ecs/traitRegistry';
import { markUIDirty } from '../ui/uiTreeStore';
import { evalTrackValue } from './curveEval';
import { setPath } from './pathValue';
import type { AnimationClipDef, AnimationTrack } from './types';

/** koota entity handle (minimal surface we use). */
type Ent = {
  id(): number;
  has(trait: unknown): boolean;
  get(trait: unknown): Record<string, unknown> | undefined;
  set(trait: unknown, value: Record<string, unknown>): void;
};

export interface EntityIndex {
  byId: Map<number, Ent>;
  /** parentId → (childName → child entity id). Last writer wins on duplicate names. */
  childrenByParent: Map<number, Map<string, number>>;
}

/** Build a one-shot index of the world's entities by id + name-keyed children.
 *  A single EntityAttributes query; build ONCE per frame and pass it to every
 *  `applyClipAtTime` call so N animators cost O(N + entities), not O(N × entities). */
export function buildEntityIndex(world: World): EntityIndex {
  const byId = new Map<number, Ent>();
  const childrenByParent = new Map<number, Map<string, number>>();
  world.query(EntityAttributes).updateEach(([attr]: [Record<string, unknown>], entity: Ent) => {
    const id = entity.id();
    byId.set(id, entity);
    const parentId = (attr.parentId as number) ?? 0;
    const name = (attr.name as string) ?? '';
    let bucket = childrenByParent.get(parentId);
    if (!bucket) { bucket = new Map(); childrenByParent.set(parentId, bucket); }
    bucket.set(name, id);
  });
  return { byId, childrenByParent };
}

/** Resolve a relative name-path from `rootId` to a descendant entity id, or null.
 *  "" resolves to the root itself. */
export function resolveTrackTarget(index: EntityIndex, rootId: number, path: string): number | null {
  if (!path) return index.byId.has(rootId) ? rootId : null;
  let current = rootId;
  for (const seg of path.split('/')) {
    if (!seg) continue;
    const child = index.childrenByParent.get(current)?.get(seg);
    if (child === undefined) return null;
    current = child;
  }
  return current;
}

/** Coerce an evaluated number to the value a trait field expects. Enum tracks
 *  store an option index, so the field's static option list maps it back to the
 *  string the trait holds (falls back to the raw number if options are absent). */
function coerce(type: AnimationTrack['type'], v: number, options?: string[]): unknown {
  if (type === 'boolean') return v !== 0;
  if (type === 'color') return v | 0;
  if (type === 'enum') return options?.[Math.round(v)] ?? options?.[0] ?? v;
  return v;
}

/** A trait is a UI trait if it declares the UI category or is one of the UI*
 *  traits by name — a belt-and-suspenders check so animating a UI field always
 *  repaints even if a trait forgot to set `componentCategory: 'UI'`. */
function isUITrait(meta: TraitMeta): boolean {
  return meta.componentCategory === 'UI' || meta.name.startsWith('UI');
}

// F5 — drop per-frame allocation on this hot path. The batch map is reused across
// calls (cleared at the top) instead of a fresh `new Map` per animator per frame,
// and keyed by a NUMERIC composite (entityId × K + traitId) rather than a built
// `${id}|${trait}` string — so N animators × T tracks no longer churn N×T strings +
// a Map per call. Trait ids are stable identities assigned once per TraitMeta.
const _traitId = new WeakMap<object, number>();
let _nextTraitId = 1;
function traitNumericId(meta: TraitMeta): number {
  let id = _traitId.get(meta as object);
  if (id === undefined) { id = _nextTraitId++; _traitId.set(meta as object, id); }
  return id;
}
const _WRITE_KEY_STRIDE = 1 << 20; // entityId × stride + traitId; traitIds stay well under the stride
const _writes = new Map<number, { entity: Ent; meta: TraitMeta; patch: Record<string, unknown> }>();

/** Sample every track of `clip` at `time` and write the values onto the bound
 *  entities under `rootId`. Pass a prebuilt `index` (from buildEntityIndex) when
 *  posing many animators in one frame to avoid rebuilding it per call. Returns the
 *  number of tracks applied (useful for tests / "clip not loaded yet" diagnostics).
 *  NOTE: not re-entrant — uses a shared module-scope batch map drained before return. */
export function applyClipAtTime(
  world: World,
  rootId: number,
  clip: AnimationClipDef,
  time: number,
  index?: EntityIndex,
): number {
  const idx = index ?? buildEntityIndex(world);
  let applied = 0;
  let uiTouched = false;
  // Accumulate field writes per (entity, trait) so a trait animated on several
  // fields (Transform px/py/pz) reads + writes ONCE instead of spread-copying per
  // track. Reused map (see _writes note above) — clear any prior call's residue.
  const writes = _writes;
  writes.clear();
  for (const track of clip.tracks) {
    if (track.keys.length === 0) continue;
    const targetId = resolveTrackTarget(idx, rootId, track.path);
    if (targetId === null) continue;
    const entity = idx.byId.get(targetId);
    if (!entity) continue;
    const meta = getTraitByName(track.trait);
    if (!meta || meta.category === 'tag') continue;
    if (!entity.has(meta.trait)) continue;

    const options = track.type === 'enum' ? meta.fields[track.field]?.options : undefined;
    // A dynamic-enum field (no static option list) can't be safely decoded from an
    // index — skip rather than write a raw number into a string field.
    if (track.type === 'enum' && !options) continue;
    const value = coerce(track.type, evalTrackValue(track, time), options);

    const wkey = targetId * _WRITE_KEY_STRIDE + traitNumericId(meta);
    let w = writes.get(wkey);
    if (!w) { w = { entity, meta, patch: {} }; writes.set(wkey, w); }
    w.patch[track.field] = value;
    applied++;
  }
  for (const w of writes.values()) {
    const current = w.entity.get(w.meta.trait) as Record<string, unknown> | undefined;
    if (!current) continue;
    // Fold each patched field onto one object. A dotted field (e.g. a MaterialInstance override's
    // `overrides.0.source.value`) writes into the nested location via setPath, preserving the rest
    // of the array; a flat field is a plain assign. Several fields of one trait batch here, so we
    // apply them in sequence onto the same accumulating object.
    let next: Record<string, unknown> = { ...current };
    for (const [f, v] of Object.entries(w.patch)) {
      if (f.includes('.')) next = setPath(next, f, v);
      else next[f] = v;
    }
    w.entity.set(w.meta.trait, next);
    if (isUITrait(w.meta)) uiTouched = true;
  }
  writes.clear(); // don't pin entities/patches between frames
  // UI rendering is dirty-flag driven (the DOM tree only rebuilds on markUIDirty);
  // a bare entity.set on a UI trait won't repaint. The runtime animationSystem has
  // no other signal, so dirty the tree here when a clip animates a UI trait —
  // otherwise UI clips play in ECS but never visibly move.
  if (uiTouched) markUIDirty();
  return applied;
}

// ─────────────────────────────────────────────────────────────────────────────
// Crossfade (Phase 2) — pose-blend two clips.
//
// The single-clip `applyClipAtTime` above stays the allocation-free hot path (used
// every frame for every animator). Blending needs the RAW sampled values of BOTH
// clips at once, so it can't reuse that path's write-and-drain map — it samples each
// clip into a `PoseMap`, blends per field by TYPE, then writes once. The extra
// allocation is fine because blending only runs DURING an active crossfade (< the
// fade duration per switch), not every frame.
// ─────────────────────────────────────────────────────────────────────────────

/** One field's raw (pre-coerce) sampled value + how to combine/coerce it. */
interface FieldSample { raw: number; type: AnimationTrack['type']; options?: string[]; angle: boolean; }
interface PoseEntry { entity: Ent; meta: TraitMeta; fields: Map<string, FieldSample>; }
/** wkey (entityId × stride + traitId) → the entity's sampled trait fields. */
type PoseMap = Map<number, PoseEntry>;

/** A rotation field is a Transform Euler angle (radians) — blended along the SHORTEST
 *  arc so a crossfade between e.g. +170° and −170° wraps through 180° instead of
 *  spinning the long way through 0°. (The Transform stores rotation as three separate
 *  Euler number tracks, not a quaternion, so this per-axis shortest-arc is the blend
 *  model — full coupled-axis quaternion nlerp is a deliberate non-goal.) */
function isAngleField(meta: TraitMeta, field: string): boolean {
  return meta.name === 'Transform' && (field === 'rx' || field === 'ry' || field === 'rz');
}

/** Sample every track of `clip` at `time` into a fresh PoseMap (raw values, no write). */
function sampleClipPose(idx: EntityIndex, rootId: number, clip: AnimationClipDef, time: number): PoseMap {
  const pose: PoseMap = new Map();
  for (const track of clip.tracks) {
    if (track.keys.length === 0) continue;
    const targetId = resolveTrackTarget(idx, rootId, track.path);
    if (targetId === null) continue;
    const entity = idx.byId.get(targetId);
    if (!entity) continue;
    const meta = getTraitByName(track.trait);
    if (!meta || meta.category === 'tag') continue;
    if (!entity.has(meta.trait)) continue;
    const options = track.type === 'enum' ? meta.fields[track.field]?.options : undefined;
    if (track.type === 'enum' && !options) continue;
    const wkey = targetId * _WRITE_KEY_STRIDE + traitNumericId(meta);
    let entry = pose.get(wkey);
    if (!entry) { entry = { entity, meta, fields: new Map() }; pose.set(wkey, entry); }
    entry.fields.set(track.field, {
      raw: evalTrackValue(track, time),
      type: track.type,
      options,
      angle: track.type === 'number' && isAngleField(meta, track.field),
    });
  }
  return pose;
}

const TWO_PI = Math.PI * 2;
/** Shortest-arc interpolation between two angles (radians). */
function lerpAngle(a: number, b: number, w: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI; else if (d < -Math.PI) d += TWO_PI;
  return a + d * w;
}
/** Per-channel lerp of two packed 0xRRGGBB colors (a plain numeric lerp would blend
 *  the packed integers and produce a wrong hue). */
function lerpColor(a: number, b: number, w: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * w);
  const g = Math.round(ag + (bg - ag) * w);
  const bl = Math.round(ab + (bb - ab) * w);
  return (r << 16) | (g << 8) | bl;
}

/** Combine an outgoing (`from`) and incoming (`to`) field sample at incoming weight `w`
 *  (0 = all `from`, 1 = all `to`), by field TYPE: numbers lerp (angles shortest-arc),
 *  colors lerp per-channel, stepped types (boolean/enum) snap to the dominant side. */
function blendField(from: FieldSample, to: FieldSample, w: number): FieldSample {
  const type = to.type;
  if (type === 'boolean' || type === 'enum') return w >= 0.5 ? to : from;
  if (type === 'color') return { ...to, raw: lerpColor(from.raw, to.raw, w) };
  const raw = to.angle ? lerpAngle(from.raw, to.raw, w) : from.raw + (to.raw - from.raw) * w;
  return { ...to, raw };
}

/** Blend two poses. `to` is the destination; `from` fades out as `w` → 1. A field present
 *  in BOTH blends; a field only one clip animates is applied at full strength (there's no
 *  captured bind pose to fade a mismatched track toward — a documented limitation, harmless
 *  in the common case where both clips animate the same fields). */
function blendPoses(from: PoseMap, to: PoseMap, w: number): PoseMap {
  const out: PoseMap = new Map();
  const keys = new Set<number>([...from.keys(), ...to.keys()]);
  for (const k of keys) {
    const f = from.get(k), t = to.get(k);
    const base = t ?? f!;
    const entry: PoseEntry = { entity: base.entity, meta: base.meta, fields: new Map() };
    const fields = new Set<string>([...(f ? f.fields.keys() : []), ...(t ? t.fields.keys() : [])]);
    for (const field of fields) {
      const fs = f?.fields.get(field), ts = t?.fields.get(field);
      entry.fields.set(field, fs && ts ? blendField(fs, ts, w) : (ts ?? fs)!);
    }
    out.set(k, entry);
  }
  return out;
}

/** Coerce + write a blended pose onto the ECS (batched per entity/trait). Returns the
 *  number of fields written; dirties the UI tree if any UI trait was posed. */
function writePose(pose: PoseMap): number {
  let applied = 0;
  let uiTouched = false;
  for (const entry of pose.values()) {
    const current = entry.entity.get(entry.meta.trait) as Record<string, unknown> | undefined;
    if (!current) continue;
    // Mirror applyClipAtTime's fold: a dotted field (e.g. a MaterialInstance override's
    // `overrides.0.source.value`) writes into the nested location via setPath so the crossfade
    // path handles nested-path tracks too — a plain spread would write a bogus flat key.
    let next: Record<string, unknown> = { ...current };
    for (const [field, fs] of entry.fields) {
      const v = coerce(fs.type, fs.raw, fs.options);
      if (field.includes('.')) next = setPath(next, field, v);
      else next[field] = v;
      applied++;
    }
    entry.entity.set(entry.meta.trait, next);
    if (isUITrait(entry.meta)) uiTouched = true;
  }
  if (uiTouched) markUIDirty();
  return applied;
}

/** Pose an entity hierarchy as a CROSSFADE between an outgoing (`from`) and incoming (`to`)
 *  clip at incoming weight `w` (0..1). Samples both clips, blends per field by type, and
 *  writes once. At `w >= 1` this equals `applyClipAtTime(to)`; callers use the cheap
 *  single-clip path for the no-fade case and only reach here while a fade is active. */
export function applyClipAtTimeBlended(
  world: World,
  rootId: number,
  from: { clip: AnimationClipDef; time: number },
  to: { clip: AnimationClipDef; time: number },
  w: number,
  index?: EntityIndex,
): number {
  const idx = index ?? buildEntityIndex(world);
  const fromPose = sampleClipPose(idx, rootId, from.clip, from.time);
  const toPose = sampleClipPose(idx, rootId, to.clip, to.time);
  return writePose(blendPoses(fromPose, toPose, w));
}

/** Advance a playhead time by `dt` seconds, honoring loop/clamp against `duration`. */
export function advanceClipTime(time: number, dt: number, duration: number, loop: boolean): number {
  let t = time + dt;
  if (duration <= 0) return 0;
  if (loop) {
    t %= duration;
    if (t < 0) t += duration;
    return t;
  }
  return t < 0 ? 0 : t > duration ? duration : t;
}
