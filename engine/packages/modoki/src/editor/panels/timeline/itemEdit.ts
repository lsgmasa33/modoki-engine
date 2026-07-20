/** Pure track-item helpers for the Timeline editor — add / move / update / delete the item
 *  (clip / marker / cue / span) at an index within a track, plus read helpers. Kept free of React
 *  and the store so they're unit-testable and reused by the panel's coalesced-undo commit path.
 *
 *  Every function returns a NEW track (immutable) or null-free primitive; callers wrap the result
 *  in `commit(d => …)`. The panel then runs the whole doc through `normalizeTimeline` on save, so a
 *  patch that would drop below the normalize floor (e.g. an empty clip name) is the caller's to
 *  guard — these helpers apply exactly what they're given. */

import type {
  TrackDef, AnimationClipBlock, SignalMarker, AudioCueBlock, ActivationSpan, ControlClipBlock,
} from '../../../runtime/timeline/types';

/** A partial patch for whichever item kind the target track holds. */
export type TrackItemPatch =
  Partial<AnimationClipBlock> | Partial<SignalMarker> | Partial<AudioCueBlock> | Partial<ActivationSpan> | Partial<ControlClipBlock>;

/** Add an item to a track at time `t` with sensible (non-empty, normalize-surviving) defaults. */
export function withAddedItem(track: TrackDef, t: number): TrackDef {
  switch (track.type) {
    case 'animation': return { ...track, clips: [...track.clips, { start: t, duration: 1, clip: 'clip' }] };
    case 'signal': return { ...track, markers: [...track.markers, { t, action: 'action' }] };
    case 'audio': return { ...track, cues: [...track.cues, { t, clip: 'audio-guid' }] };
    case 'activation': return { ...track, spans: [...track.spans, { start: t, end: t + 1 }] };
    case 'control': return { ...track, clips: [...track.clips, { start: t, duration: 1, prefab: 'prefab-guid' }] };
  }
}

/** Retime an item within a track (interpret `newTime` by kind; spans shift, keeping width). */
export function withMovedItem(track: TrackDef, itemIdx: number, newTime: number): TrackDef {
  switch (track.type) {
    case 'animation': return { ...track, clips: track.clips.map((c, i) => (i === itemIdx ? { ...c, start: newTime } : c)) };
    case 'signal': return { ...track, markers: track.markers.map((m, i) => (i === itemIdx ? { ...m, t: newTime } : m)) };
    case 'audio': return { ...track, cues: track.cues.map((c, i) => (i === itemIdx ? { ...c, t: newTime } : c)) };
    case 'activation': return { ...track, spans: track.spans.map((s, i) => (i === itemIdx ? { start: newTime, end: newTime + (s.end - s.start) } : s)) };
    case 'control': return { ...track, clips: track.clips.map((c, i) => (i === itemIdx ? { ...c, start: newTime } : c)) };
  }
}

/** Merge `patch` into the item at `itemIdx` (a field-level edit from the inspector). Out-of-range
 *  index → the track is returned unchanged. */
export function withUpdatedItem(track: TrackDef, itemIdx: number, patch: TrackItemPatch): TrackDef {
  switch (track.type) {
    case 'animation': return { ...track, clips: track.clips.map((c, i) => (i === itemIdx ? { ...c, ...(patch as Partial<AnimationClipBlock>) } : c)) };
    case 'signal': return { ...track, markers: track.markers.map((m, i) => (i === itemIdx ? { ...m, ...(patch as Partial<SignalMarker>) } : m)) };
    case 'audio': return { ...track, cues: track.cues.map((c, i) => (i === itemIdx ? { ...c, ...(patch as Partial<AudioCueBlock>) } : c)) };
    case 'activation': return { ...track, spans: track.spans.map((s, i) => (i === itemIdx ? { ...s, ...(patch as Partial<ActivationSpan>) } : s)) };
    case 'control': return { ...track, clips: track.clips.map((c, i) => (i === itemIdx ? { ...c, ...(patch as Partial<ControlClipBlock>) } : c)) };
  }
}

/** Remove the item at `itemIdx`. */
export function withDeletedItem(track: TrackDef, itemIdx: number): TrackDef {
  switch (track.type) {
    case 'animation': return { ...track, clips: track.clips.filter((_, i) => i !== itemIdx) };
    case 'signal': return { ...track, markers: track.markers.filter((_, i) => i !== itemIdx) };
    case 'audio': return { ...track, cues: track.cues.filter((_, i) => i !== itemIdx) };
    case 'activation': return { ...track, spans: track.spans.filter((_, i) => i !== itemIdx) };
    case 'control': return { ...track, clips: track.clips.filter((_, i) => i !== itemIdx) };
  }
}

/** The item count for a track. */
export function itemCount(track: TrackDef): number {
  switch (track.type) {
    case 'animation': return track.clips.length;
    case 'signal': return track.markers.length;
    case 'audio': return track.cues.length;
    case 'activation': return track.spans.length;
    case 'control': return track.clips.length;
  }
}

/** The item at `itemIdx` (union across kinds), or undefined if out of range. */
export function getItem(
  track: TrackDef, itemIdx: number,
): AnimationClipBlock | SignalMarker | AudioCueBlock | ActivationSpan | ControlClipBlock | undefined {
  switch (track.type) {
    case 'animation': return track.clips[itemIdx];
    case 'signal': return track.markers[itemIdx];
    case 'audio': return track.cues[itemIdx];
    case 'activation': return track.spans[itemIdx];
    case 'control': return track.clips[itemIdx];
  }
}
