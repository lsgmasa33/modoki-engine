/**
 * Pure clip-edit transforms for the Animation editor — the tricky, high-bug-density
 * operations lifted OUT of AnimationEditor's component closures so they're unit-testable
 * (mirrors how recording.ts extracts upsertKey/moveKeysInTime). Each takes plain data and
 * returns plain data; the component keeps only store wiring + the commit() call.
 */

import { upsertKey, trackKey } from './recording';
import { applyTangentMode } from '../../runtime/animation/curveEval';
import type { AnimationClipDef, AnimationTrack, Keyframe, TrackValueType } from '../../runtime/animation/types';

const EPS = 1e-4;

// ── Copy / paste ──

/** A copied block of keyframes. Times are relative to the earliest copied key
 *  (`t - minT`); `span` = block width, `srcEnd` = absolute time of the last copied key. */
export interface KeyClipboard {
  tracks: { key: string; keys: Keyframe[] }[];
  span: number;
  srcEnd: number;
}

/** Snapshot the selected keys (grouped by track index) into a clipboard. Returns null
 *  if the selection resolves to no keys. Times are normalized to the earliest key. */
export function extractKeyBlock(clip: AnimationClipDef, byTrack: Map<number, Set<number>>): KeyClipboard | null {
  let minT = Infinity, maxT = -Infinity;
  for (const [ti, kis] of byTrack) for (const ki of kis) { const k = clip.tracks[ti]?.keys[ki]; if (k) { minT = Math.min(minT, k.t); maxT = Math.max(maxT, k.t); } }
  if (!Number.isFinite(minT)) return null;
  const tracks = [...byTrack.entries()].map(([ti, kis]) => {
    const tr = clip.tracks[ti];
    return { key: trackKey(tr), keys: [...kis].map((ki) => ({ ...tr.keys[ki], t: tr.keys[ki].t - minT })).sort((a, b) => a.t - b.t) };
  });
  return { tracks, span: maxT - minT, srcEnd: maxT };
}

export interface PasteOptions { minGapFrames: number; gapMarginFrames: number }
export interface PastePlan { tracks: AnimationTrack[]; duration: number; selection: string[] }

/**
 * Plan a paste: DUPLICATE the copied block after the original, separated by the block's
 * own width (min `minGapFrames`) + `gapMarginFrames` breathing room, then step forward
 * one frame at a time until no pasted key collides with an existing key on its track.
 * Grows the clip duration if the paste runs past the end. Carries each key's easing.
 * Frame-index arithmetic (occupied-frame Sets) keeps collision testing O(1). Returns the
 * new tracks, the (possibly grown) duration, and the "ti:ki" ids of the pasted keys.
 */
export function planPaste(clip: AnimationClipDef, cb: KeyClipboard, opts: PasteOptions): PastePlan {
  const fr = clip.frameRate || 60;
  const frameStep = 1 / fr;
  const relFrame = (t: number) => Math.round(t * fr);

  // Occupied frame indices per target track → O(1) collision test.
  const occupied = new Map<string, Set<number>>();
  for (const src of cb.tracks) {
    const tr = clip.tracks.find((t) => trackKey(t) === src.key);
    occupied.set(src.key, new Set(tr ? tr.keys.map((k) => relFrame(k.t)) : []));
  }
  const collides = (baseFrame: number): boolean => {
    for (const src of cb.tracks) {
      const occ = occupied.get(src.key)!;
      for (const k of src.keys) if (occ.has(baseFrame + relFrame(k.t))) return true;
    }
    return false;
  };

  const gapFrames = Math.max(relFrame(cb.span), opts.minGapFrames) + opts.gapMarginFrames;
  let baseFrame = relFrame(cb.srcEnd) + gapFrames;
  const maxIter = Math.ceil((clip.duration + cb.span + 2) * fr) + 1000;
  for (let guard = 0; collides(baseFrame) && guard < maxIter; guard++) baseFrame += 1;

  const pastedTime = (k: Keyframe) => (baseFrame + relFrame(k.t)) * frameStep;
  const duration = Math.max(clip.duration, baseFrame * frameStep + cb.span);

  const tracks = clip.tracks.map((tr) => {
    const src = cb.tracks.find((s) => s.key === trackKey(tr));
    if (!src) return tr;
    // Snapshot the existing keys' tangents by frame. upsertKey re-smooths the 'auto'
    // neighbors of each inserted key — including the key just BEFORE the pasted block,
    // whose INCOMING segment would then shift and visibly move the existing pose (parts
    // jump on paste). Paste must be additive, so restore every pre-existing key's tangents
    // afterward; only the pasted keys (distinct frames, collision-avoided) carry new easing.
    const origTangents = new Map<number, Keyframe>();
    for (const k of tr.keys) origTangents.set(relFrame(k.t), k);
    let keys = tr.keys;
    for (const k of src.keys) {
      const t = pastedTime(k);
      keys = upsertKey(keys, t, k.v);
      // Carry the copied easing (upsertKey re-derives 'auto' tangents otherwise).
      const idx = keys.findIndex((kk) => Math.abs(kk.t - t) <= EPS);
      if (idx >= 0) keys[idx] = { ...keys[idx], inTangent: k.inTangent, outTangent: k.outTangent, inWeight: k.inWeight, outWeight: k.outWeight, broken: k.broken, tangentMode: k.tangentMode };
    }
    keys = keys.map((kk) => {
      const orig = origTangents.get(relFrame(kk.t));
      return orig ? { ...kk, inTangent: orig.inTangent, outTangent: orig.outTangent, inWeight: orig.inWeight, outWeight: orig.outWeight, broken: orig.broken, tangentMode: orig.tangentMode } : kk;
    });
    return { ...tr, keys };
  });

  const selection: string[] = [];
  for (const src of cb.tracks) {
    const ti = tracks.findIndex((tr) => trackKey(tr) === src.key);
    if (ti < 0) continue;
    for (const k of src.keys) { const t = pastedTime(k); const ki = tracks[ti].keys.findIndex((kk) => Math.abs(kk.t - t) <= EPS); if (ki >= 0) selection.push(`${ti}:${ki}`); }
  }
  return { tracks, duration, selection };
}

// ── Break / unify tangents ──

/**
 * Toggle break/unify on the selected keys. If ANY selected key is still unified, BREAK
 * all of them (independent in/out handles); otherwise UNIFY all. Both directions route
 * through applyTangentMode so the persisted `tangentMode` round-trips correctly through
 * `reapplyTangent`: break → 'free' (broken=true, tangents kept, editable independently);
 * unify → 'auto' (broken=false, re-smoothed). This avoids the prior contradictory
 * `{ broken:false, tangentMode:'free' }` state, which silently reverted to broken on the
 * next neighbor recompute. (A3)
 */
export function applyBreakUnify(tracks: AnimationTrack[], byTrack: Map<number, Set<number>>): AnimationTrack[] {
  let anyUnified = false;
  for (const [ti, kis] of byTrack) for (const ki of kis) { const k = tracks[ti]?.keys[ki]; if (k && !k.broken) anyUnified = true; }
  const mode: 'free' | 'auto' = anyUnified ? 'free' : 'auto';
  return tracks.map((tr, ti) => {
    const kis = byTrack.get(ti);
    if (!kis) return tr;
    const keys = tr.keys.map((k) => ({ ...k }));
    for (const ki of kis) if (keys[ki]) applyTangentMode(keys, ki, mode);
    return { ...tr, keys };
  });
}

// ── Value nudge + add-property planning ──

/** Add `dv` to the value of every selected key ON A NUMBER TRACK (color/boolean/enum
 *  tracks are skipped even if selected, so a fractional delta can't corrupt an index). */
export function applyValueNudge(tracks: AnimationTrack[], byTrack: Map<number, Set<number>>, dv: number): AnimationTrack[] {
  return tracks.map((tr, ti) => {
    const kis = byTrack.get(ti);
    if (!kis || tr.type !== 'number') return tr;
    return { ...tr, keys: tr.keys.map((k, ki) => (kis.has(ki) ? { ...k, v: k.v + dv } : k)) };
  });
}

/** A property the picker can add (structural subset of the picker's PropertyCandidate). */
export interface AddCandidate { path: string; trait: string; field: string; type: TrackValueType }

/** Plan the new tracks for an "Add Property" batch: skip candidates already tracked in
 *  `existing` AND duplicates within the batch (matched by trackKey), seeding each new
 *  track with one key at `seedTime` from `readValue(candidate)` (the entity's live value).
 *  Returns only the tracks to append (empty ⇒ caller should not commit). */
export function planAddedTracks<C extends AddCandidate>(
  existing: AnimationTrack[],
  candidates: C[],
  seedTime: number,
  readValue: (c: C) => number,
): AnimationTrack[] {
  const seen = new Set(existing.map(trackKey));
  const added: AnimationTrack[] = [];
  for (const c of candidates) {
    const key = trackKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ path: c.path, trait: c.trait, field: c.field, type: c.type, keys: upsertKey([], seedTime, readValue(c)) });
  }
  return added;
}
