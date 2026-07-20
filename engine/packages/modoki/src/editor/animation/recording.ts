/**
 * Animation record mode — the bridge that turns an ordinary trait-field edit
 * (Inspector field, SceneView gizmo) into a keyframe on the open clip.
 *
 * `entityActions.writeTraitField*WithUndo` calls `notifyFieldEdited` after every
 * write. When the Animation Editor is recording, it registers a hook here that
 * inserts/updates a key at the current playhead. Keeping this as a tiny registry
 * (no store/editor imports) keeps `entityActions` decoupled and unit-testable.
 */

import { applyTangentMode } from '../../runtime/animation/curveEval';
import type { AnimationTrack, Keyframe, TrackValueType } from '../../runtime/animation/types';

export type RecordHook = (entityId: number, traitName: string, field: string, value: unknown) => void;

let hook: RecordHook | null = null;

/** Install (or clear with null) the record hook. The Animation Editor sets this
 *  while recording and clears it on stop/unmount. */
export function setRecordHook(h: RecordHook | null): void {
  hook = h;
}

/** Called by entityActions after a trait field is written. No-op unless recording. */
export function notifyFieldEdited(entityId: number, traitName: string, field: string, value: unknown): void {
  hook?.(entityId, traitName, field, value);
}

// ── Pure helpers (used by the hook + unit tests) ──

/** Minimal entity attributes needed to resolve a relative path. */
export interface AttrNode { id: number; name: string; parentId: number }

/** Build the relative name-path from `rootId` down to `entityId` (Unity model).
 *  Returns "" when entityId === rootId, or null if entityId is not a descendant. */
export function relativeEntityPath(rootId: number, entityId: number, byId: Map<number, AttrNode>): string | null {
  if (entityId === rootId) return '';
  const segs: string[] = [];
  let cur = byId.get(entityId);
  while (cur && cur.id !== rootId) {
    segs.push(cur.name);
    if (cur.parentId === 0) { cur = undefined; break; }
    cur = byId.get(cur.parentId);
  }
  if (!cur || cur.id !== rootId) return null; // walked past root → not a descendant
  return segs.reverse().join('/');
}

const TIME_EPS = 1e-4;

/** Coerce a written trait value into the numeric storage used by a track. Enum
 *  tracks store the option index, so the field's static option list maps the
 *  written string → index (falls back to 0 when the value isn't a known option). */
export function encodeValue(type: TrackValueType, value: unknown, options?: string[]): number {
  if (type === 'boolean') return value ? 1 : 0;
  if (type === 'color') {
    if (typeof value === 'number') return value | 0;
    // Color fields may surface as "#rrggbb" / "rrggbb" strings — parse to a packed int.
    if (typeof value === 'string') { const n = parseInt(value.replace(/^#/, ''), 16); return Number.isNaN(n) ? 0 : n & 0xffffff; }
    return 0;
  }
  if (type === 'enum') {
    const i = options ? options.indexOf(String(value)) : -1;
    return i >= 0 ? i : (typeof value === 'number' ? value : 0);
  }
  return typeof value === 'number' ? value : Number(value) || 0;
}

/** Re-apply a key's OWN stored tangent mode (default 'auto'), recomputing its
 *  tangents from current neighbors. This preserves user-set linear/constant/free
 *  keys instead of flattening them to 'auto': an 'auto' key re-smooths, a 'linear'
 *  key re-fits its secants to the (possibly moved) neighbors, a 'constant' key
 *  stays stepped, and a 'free' key keeps its hand-edited handles untouched. */
function reapplyTangent(keys: Keyframe[], i: number): void {
  applyTangentMode(keys, i, keys[i].tangentMode ?? 'auto');
}

/** Insert or update a key at `time` on a copy of `keys`, kept sorted, with each
 *  affected key's tangent recomputed per its own mode. Returns the new keys array. */
export function upsertKey(keys: Keyframe[], time: number, v: number): Keyframe[] {
  const next = keys.map((k) => ({ ...k }));
  const existing = next.findIndex((k) => Math.abs(k.t - time) <= TIME_EPS);
  let idx: number;
  if (existing >= 0) {
    next[existing].v = v;
    idx = existing;
  } else {
    const key: Keyframe = { t: time, v, inTangent: 0, outTangent: 0, tangentMode: 'auto' };
    next.push(key);
    next.sort((a, b) => a.t - b.t);
    idx = next.findIndex((k) => k === key);
  }
  // Recompute the touched key + immediate neighbors, each honoring its own mode.
  reapplyTangent(next, idx);
  if (idx > 0) reapplyTangent(next, idx - 1);
  if (idx < next.length - 1) reapplyTangent(next, idx + 1);
  return next;
}

/** Find a track for (path, trait, field), or undefined. */
export function findTrack(tracks: AnimationTrack[], path: string, trait: string, field: string): AnimationTrack | undefined {
  return tracks.find((t) => t.path === path && t.trait === trait && t.field === field);
}

// ── Track identity + selection-id helpers (single source of truth; C1/C2) ──

/** Stable track-identity string. The clipboard writes it and paste matches on it, so
 *  every producer/consumer MUST agree — hence one function instead of ~9 inline copies. */
export function trackKey(t: { path: string; trait: string; field: string }): string {
  return `${t.path}|${t.trait}|${t.field}`;
}

/** Human-readable field label for a timeline row. Nested paths (a MaterialInstance override's
 *  `overrides.N.source.value`) are collapsed to a short form; flat fields pass through. */
export function formatTrackField(trait: string, field: string): string {
  if (trait === 'MaterialInstance') {
    const m = /^overrides\.(\d+)\.source\.value$/.exec(field);
    if (m) return `override ${m[1]}`;
  }
  return field;
}

/** Parse a "ti:ki" key-selection id into [trackIndex, keyIndex]. */
export function parseKeyId(id: string): [number, number] {
  const [ti, ki] = id.split(':').map(Number);
  return [ti, ki];
}

/** Group "ti:ki" selection ids by track index → set of key indices. */
export function groupSelection(ids: Iterable<string>): Map<number, Set<number>> {
  const m = new Map<number, Set<number>>();
  for (const id of ids) { const [ti, ki] = parseKeyId(id); (m.get(ti) ?? m.set(ti, new Set()).get(ti))!.add(ki); }
  return m;
}

/** Build SelectedKeyRef[] (ti + ORIGINAL time) from selection ids against a clip's
 *  tracks. Ids whose track/key no longer resolve are skipped. */
export function selRefsFromIds(ids: Iterable<string>, tracks: AnimationTrack[]): SelectedKeyRef[] {
  const out: SelectedKeyRef[] = [];
  for (const id of ids) { const [ti, ki] = parseKeyId(id); const t0 = tracks[ti]?.keys[ki]?.t; if (t0 !== undefined) out.push({ ti, t0 }); }
  return out;
}

/** Remap selection ids after removing a set of track indices: drop ids on a removed
 *  track; shift survivors down by the count of removed tracks that precede them. */
export function remapSelectionAfterRemoval(ids: Iterable<string>, removed: Set<number>): Set<string> {
  const next = new Set<string>();
  for (const id of ids) {
    const [ti, ki] = parseKeyId(id);
    if (removed.has(ti)) continue;
    let shift = 0; for (const r of removed) if (r < ti) shift++;
    next.add(`${ti - shift}:${ki}`);
  }
  return next;
}

/** Old→new index permutation for moving track `from` to `to` (both clamped by caller). */
export function reorderPermutation(count: number, from: number, to: number): Map<number, number> {
  const order = Array.from({ length: count }, (_, i) => i);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const oldToNew = new Map<number, number>();
  order.forEach((oldIdx, newIdx) => oldToNew.set(oldIdx, newIdx));
  return oldToNew;
}

/** Remap selection ids through a track-reorder permutation (old→new index). */
export function remapSelectionAfterReorder(ids: Iterable<string>, oldToNew: Map<number, number>): Set<string> {
  const next = new Set<string>();
  for (const id of ids) { const [ti, ki] = parseKeyId(id); next.add(`${oldToNew.get(ti) ?? ti}:${ki}`); }
  return next;
}

/** Resolve the key-selection after a pointer-down on key `id`:
 *  - additive (shift/cmd) toggles `id` in/out of the set;
 *  - a plain click on an ALREADY-selected key keeps the whole group (so a multi-key
 *    drag works) — returns the SAME set reference;
 *  - a plain click on an unselected key selects only it. */
export function resolveKeySelection(current: Set<string>, id: string, additive: boolean): Set<string> {
  if (additive) { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }
  if (current.has(id)) return current; // keep the group
  return new Set([id]);
}

/** The next/previous keyframe time across all tracks relative to `playhead`
 *  (deduped + sorted, epsilon-guarded strictly greater/less). `undefined` when there
 *  is no key in the requested direction. */
export function nextKeyTime(tracks: AnimationTrack[], playhead: number, dir: 1 | -1, eps = 1e-4): number | undefined {
  const times = Array.from(new Set(tracks.flatMap((t) => t.keys.map((k) => k.t)))).sort((a, b) => a - b);
  return dir > 0 ? times.find((t) => t > playhead + eps) : [...times].reverse().find((t) => t < playhead - eps);
}

/** Remap selection ids after deleting a single key (ti,ki): drop that id; same-track
 *  ids with key index > ki shift down by one. */
export function remapSelectionAfterDelete(ids: Iterable<string>, ti: number, ki: number): Set<string> {
  const next = new Set<string>();
  for (const id of ids) {
    const [t, k] = parseKeyId(id);
    if (t === ti && k === ki) continue;
    next.add(t === ti && k > ki ? `${t}:${k - 1}` : id);
  }
  return next;
}

/** A selected key, addressed by its track index + ORIGINAL time (unique within a
 *  track, and stable to match against even as keys re-sort during a drag). */
export interface SelectedKeyRef { ti: number; t0: number }

/**
 * Shift a set of selected keys along the time axis as a rigid group — the core of
 * the dopesheet/curves multi-key drag. Pure so it can be unit-tested:
 *
 *  - `delta` is the grabbed key's target time minus its original time, snapped to
 *    a whole frame, then clamped so NO selected key leaves [0, duration]. Because
 *    the same delta is applied to every selected key, relative spacing is kept.
 *  - Selected keys are matched within each track by their original time `t0`, so
 *    index churn from re-sorting can't strand them.
 *  - Returns the rebuilt tracks (re-sorted) and the selection remapped to the new
 *    sorted indices as `"ti:ki"` ids, plus the applied `delta`.
 */
export function moveKeysInTime(
  baseTracks: AnimationTrack[],
  sel: SelectedKeyRef[],
  grabT0: number,
  targetTime: number,
  frameRate: number,
  duration: number,
): { tracks: AnimationTrack[]; selected: string[]; delta: number } {
  if (!sel.length) return { tracks: baseTracks, selected: [], delta: 0 };
  const snapped = frameRate > 0 ? Math.round(targetTime * frameRate) / frameRate : targetTime;
  const minT0 = Math.min(...sel.map((s) => s.t0));
  const maxT0 = Math.max(...sel.map((s) => s.t0));
  const delta = Math.max(-minT0, Math.min(duration - maxT0, snapped - grabT0));

  const selTimes = new Map<number, Set<number>>();
  for (const s of sel) (selTimes.get(s.ti) ?? selTimes.set(s.ti, new Set()).get(s.ti))!.add(s.t0);

  const selected: string[] = [];
  const tracks = baseTracks.map((tr, ti) => {
    const times = selTimes.get(ti);
    if (!times) return tr;
    const shifted = tr.keys.map((k) => (times.has(k.t) ? { ...k, t: k.t + delta, _sel: true } : { ...k })) as (Keyframe & { _sel?: boolean })[];
    shifted.sort((a, b) => a.t - b.t);
    // Dedup: a moved (selected) key that lands within TIME_EPS of another key collapses
    // to a single key — the SELECTED key wins (the user dragged/nudged it there). Without
    // this, a group shift could leave two keys at the same time (dt=0 discontinuity in
    // eval, a "stuck" leftover), the one path that violated upsertKey's merge invariant. (A2)
    const keys: (Keyframe & { _sel?: boolean })[] = [];
    for (const cur of shifted) {
      const prev = keys[keys.length - 1];
      if (prev && Math.abs(cur.t - prev.t) <= TIME_EPS) {
        if (cur._sel && !prev._sel) keys[keys.length - 1] = cur; // moved key replaces the stationary one
        continue; // else keep prev, drop cur
      }
      keys.push(cur);
    }
    keys.forEach((k, ki) => { if (k._sel) { selected.push(`${ti}:${ki}`); delete k._sel; } });
    return { ...tr, keys: keys as Keyframe[] };
  });
  return { tracks, selected, delta };
}
