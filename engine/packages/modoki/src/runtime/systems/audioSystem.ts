/** audioSystem — presentation-tier system that turns AudioSource/AudioListener
 *  traits + the cue bus into playback via `audioService`.
 *
 *  Registered at SYSTEM_PRIORITY.AUDIO (250) — after transform propagation so
 *  positions are current, and ≥ TRANSFORM so it still runs while paused. It is
 *  registered ONLY in the app pipeline (never in `createTestWorld`), like
 *  characterInput/characterAnimation, so the headless harness stays deterministic;
 *  and `audioService` is itself a no-op (record-only) without an AudioContext.
 *
 *  DECLARATIVE playback — the system fully reconciles each AudioSource's live
 *  handle from its trait fields, so games control audio by editing traits (via the
 *  built-in `audio.*` actions) instead of hand-driving the service:
 *   - `autoplay` sets `playing=true` once, on first appearance.
 *   - `playing` is the control input: true → start/resume; false → pause (handle
 *     kept, position retained). A hard STOP is the imperative `stopEntityAudio`
 *     (the `audio.stop` action) which tears the handle down.
 *   - `clip` change on a playing source → swap; `crossfadeSec > 0` crossfades the
 *     old out and the new in, else it's a hard cut.
 *   - `volume`/`pitch`/`spatial` position are applied live every frame.
 *
 *  "Not playing → no sound": audio only sounds while the game is Playing (mirrors
 *  skeletal animation). Leaving Play stops every source + crossfade tail and drops
 *  pending cues.
 *
 *  THREE-free by design: spatial positions default to each entity's LOCAL Transform, so a
 *  pure-2D game with 3D rendering disabled pulls no Three code through audio. For nested rigs
 *  the app injects a WORLD-position resolver (`setAudioWorldPositionResolver`, reading the
 *  Three-computed `worldTransforms` cache) — the Three dependency stays on the APP side. */

import type { World, Entity, ExtractSchema, TraitValue } from 'koota';
import { Transform } from '../traits/Transform';
import { AudioSource } from '../traits/AudioSource';
import { AudioListener } from '../traits/AudioListener';
import { getPlayState } from './playState';
import { isTimelinePreviewActive } from './timelinePreview';
import { onWorldSwap } from '../ecs/world';
import {
  play, updateListener, crossfade, type AudioHandle, type AudioPlaySpec, type BusName,
} from '../audio/audioService';
import { drainAudioCues, clearAudioCues, type AudioCue } from '../audio/audioCues';
import { getCachedAudioBuffer, resolveAudioUrl } from '../loaders/audioBufferCache';
import { getAudioLoadType } from '../loaders/assetManifest';
import { hasAudioSupport } from '../audio/audioContext';

/** A live entity-owned source: its handle, the clip it's playing (to detect a
 *  swap), and whether it's currently paused (playing=false, handle retained). */
interface SourceState {
  handle: AudioHandle;
  clip: string;
  paused: boolean;
}

interface AudioState {
  /** Live entity sources keyed by entity id. */
  sources: Map<number, SourceState>;
  /** Entities whose autoplay already fired (so it doesn't restart after a stop). */
  autoplayed: Set<number>;
  /** Handles fading out under a crossfade. Each self-stops on the AUDIO clock via
   *  `handle.stopAfter(...)` (robust to timeScale/frame rate); this list only exists
   *  so a game Stop / scene swap can force-stop a tail mid-fade, and to sweep ended
   *  handles. */
  fadingOut: AudioHandle[];
  /** One-shot clip cues whose buffer wasn't decoded yet — retried for a bounded number of frames.
   *  On iOS the eager scene-load decode is REJECTED while the AudioContext is suspended and only
   *  completes after the first-gesture resume; the first shot's cue fires on that same gesture,
   *  before decode lands, so without a retry it is silently dropped. */
  pendingCues: { cue: AudioCue; frames: number }[];
}

/** ~2s at 60fps — long enough to cover the first-gesture decode window, short enough that a
 *  genuinely-missing clip is dropped quickly rather than retried forever. */
const ONE_SHOT_RETRY_FRAMES = 120;
/** Hard cap so rapid cueing of an undecoded clip can't grow the retry list unbounded. */
const MAX_PENDING_CUES = 32;

const states = new WeakMap<World, AudioState>();
function stateFor(world: World): AudioState {
  let s = states.get(world);
  if (!s) { s = { sources: new Map(), autoplayed: new Set(), fadingOut: [], pendingCues: [] }; states.set(world, s); }
  return s;
}

/** Stop + forget a world's live audio (scene swap / teardown). Scoped to the given
 *  world — NOT a global stopAll — so a swap in one viewport can't cut audio in
 *  another (editor dual-viewport). */
export function stopWorldAudio(world: World): void {
  const s = states.get(world);
  if (s) {
    for (const src of s.sources.values()) src.handle.stop();
    s.sources.clear();
    s.autoplayed.clear();
    for (const h of s.fadingOut) h.stop();
    s.fadingOut = [];
    s.pendingCues = [];
  }
  clearAudioCues(world);
}

/** Hard-stop one entity's audio (tear the handle down, distinct from pause). Backs
 *  the built-in `audio.stop` action. Safe to call for an entity with no live handle.
 *
 *  Does NOT clear the autoplay guard: an in-Play Stop must STICK, but clearing the
 *  guard would let `autoplay` re-fire next frame and restart the source. (The guard
 *  is reset only when the game leaves Play or the entity is removed, so autoplay
 *  fires again on the next Play / re-spawn, not after a manual stop.) */
export function stopEntityAudio(world: World, entity: Entity): void {
  const s = states.get(world);
  if (!s) return;
  const id = entity.id();
  const src = s.sources.get(id);
  if (src) { src.handle.stop(); s.sources.delete(id); }
}

// Each scene load creates a NEW koota world; stop the departing world's audio so
// looping/streaming sources don't orphan and stack across swaps.
onWorldSwap((_next, old) => { if (old) stopWorldAudio(old); });

/** Build a play spec for a clip, or `null` if a buffer clip isn't decoded yet
 *  (retry next frame). In record mode (no AudioContext) the buffer is never
 *  present, so we still return a spec — `audioService.play` logs it. */
function resolveSpec(clip: string, opts: Partial<AudioPlaySpec>): AudioPlaySpec | null {
  if (!clip) return null;
  if (getAudioLoadType(clip) === 'stream') {
    const url = resolveAudioUrl(clip);
    return url ? { url, clip, ...opts } : null;
  }
  const buffer = getCachedAudioBuffer(clip);
  if (!buffer && hasAudioSupport()) return null; // real mode, not decoded yet → wait
  return { buffer: buffer ?? null, clip, ...opts };
}

export function audioSystem(world: World): void {
  const state = stateFor(world);
  // The Timeline panel's forward preview plays cues/sources with the sim otherwise stopped, so
  // treat "previewing" like "playing" here (see runtime/systems/timelinePreview.ts). Everywhere
  // below, `playing` means "audio is live" — pause/stop/scrub all clear the preview flag.
  const playing = getPlayState() === 'playing' || isTimelinePreviewActive();

  if (!playing) {
    // Silence: stop everything, forget autoplay, discard pending cues.
    if (state.sources.size || state.fadingOut.length) {
      for (const src of state.sources.values()) src.handle.stop();
      state.sources.clear();
      for (const h of state.fadingOut) h.stop();
      state.fadingOut = [];
    }
    state.autoplayed.clear();
    state.pendingCues = [];
    drainAudioCues(world);
    world.query(AudioSource).updateEach(([a]) => { if (a.playing) a.playing = false; });
    return;
  }

  // Sweep crossfade tails that have self-stopped (via their audio-clock stopAfter).
  if (state.fadingOut.length) state.fadingOut = state.fadingOut.filter((h) => !h.ended);

  // 1. Listener pose — first enabled AudioListener's WORLD position (falls back to local).
  let listenerSet = false;
  world.query(Transform, AudioListener).updateEach(([, al], entity) => {
    if (listenerSet || !al.enabled) return;
    const p = positionOf(entity);
    updateListener(p.x, p.y, p.z);
    listenerSet = true;
  });

  // 2. Reconcile AudioSource entities from their trait fields.
  const seen = new Set<number>();
  world.query(AudioSource).updateEach(([a], entity) => {
    const id = entity.id();
    seen.add(id);

    // autoplay declares intent once (survives a later Stop via the autoplayed guard).
    if (a.autoplay && !state.autoplayed.has(id)) {
      state.autoplayed.add(id);
      a.playing = true;
    }

    let src = state.sources.get(id);

    // Drop a finished (non-looping) source.
    if (src && src.handle.ended) {
      state.sources.delete(id);
      src = undefined;
      a.playing = false;
    }

    if (a.playing) {
      if (src && src.clip === a.clip) {
        // Same clip: resume if paused, then apply live params.
        if (src.paused) { src.handle.resume(); src.paused = false; }
        src.handle.setVolume(a.volume);
        src.handle.setPitch(a.pitch);
        if (a.spatial) { const p = positionOf(entity); src.handle.setPosition(p.x, p.y, p.z); }
      } else {
        // No handle, or the clip changed → start the (new) clip.
        startOrSwap(state, entity, a, src);
      }
    } else if (src && !src.paused) {
      // playing=false → pause (keep the handle + position).
      src.handle.pause();
      src.paused = true;
    }
  });

  // Stop handles whose entity (or AudioSource trait) vanished this frame.
  for (const [id, src] of [...state.sources]) {
    if (!seen.has(id)) {
      src.handle.stop();
      state.sources.delete(id);
      state.autoplayed.delete(id);
    }
  }

  // 3. Drain the cue bus → fire-and-forget one-shots (NOT tracked per entity). Run whenever there
  //    are fresh cues OR deferred ones still waiting on a buffer decode (the iOS first-shot case).
  const cues = drainAudioCues(world);
  if (cues.length || state.pendingCues.length) playCues(world, state, cues);
}

/** Start `a.clip` on `entity`, replacing `prev` (a handle for a now-stale clip, or
 *  none). Crossfades when `crossfadeSec > 0` and there's a live prior handle; else
 *  a hard cut. No-op when the clip isn't loaded yet (retried next frame). */
function startOrSwap(state: AudioState, entity: Entity, a: TraitValue<ExtractSchema<typeof AudioSource>>, prev: SourceState | undefined): void {
  // TraitValue types default-bearing fields as optional; coerce to their runtime defaults.
  const clip = a.clip ?? '';
  const crossfadeSec = a.crossfadeSec ?? 0;
  const cross = crossfadeSec > 0 && !!prev && !prev.paused;
  const pos = positionOf(entity);
  const spec = resolveSpec(clip, {
    bus: a.bus as BusName, volume: cross ? 0 : a.volume, pitch: a.pitch, loop: a.loop,
    spatial: a.spatial, refDistance: a.refDistance, maxDistance: a.maxDistance,
    rolloff: a.rolloff, position: pos,
  });
  if (!spec) return; // not decoded yet — keep the current source, retry next frame
  const next = play(spec);
  if (cross && prev) {
    crossfade(prev.handle, next, a.volume, crossfadeSec);
    // Reap the outgoing tail on the audio clock (survives time-stop), and track it
    // so a game Stop / scene swap can force-stop it mid-fade.
    prev.handle.stopAfter(crossfadeSec + 0.1);
    state.fadingOut.push(prev.handle);
  } else {
    prev?.handle.stop();
  }
  state.sources.set(entity.id(), { handle: next, clip, paused: false });
  a.playing = true;
}

function playCues(world: World, state: AudioState, cues: AudioCue[]): void {
  // Retry one-shots deferred on a previous frame — their buffer may have finished decoding (e.g.
  // after the iOS first-gesture resume). Play the ready ones; age out the rest, dropping at 0.
  if (state.pendingCues.length) {
    const still: { cue: AudioCue; frames: number }[] = [];
    for (const p of state.pendingCues) {
      const spec = resolveSpec(p.cue.clip ?? '', { bus: p.cue.bus, volume: p.cue.volume, pitch: p.cue.pitch });
      if (spec) { play(spec); continue; }
      if (--p.frames > 0) still.push(p);
    }
    state.pendingCues = still;
  }
  for (const cue of cues) {
    if (cue.clip) {
      const spec = resolveSpec(cue.clip, { bus: cue.bus, volume: cue.volume, pitch: cue.pitch });
      if (spec) { play(spec); continue; }
      // Buffer clip not decoded yet (iOS: decode lands only after the first-gesture resume) → defer
      // and retry for a bounded window instead of dropping the shot. Stream clips + record mode
      // resolve immediately, so a null there is a genuine miss, not a decode wait — don't queue.
      if (getAudioLoadType(cue.clip) !== 'stream' && hasAudioSupport() && state.pendingCues.length < MAX_PENDING_CUES) {
        state.pendingCues.push({ cue, frames: ONE_SHOT_RETRY_FRAMES });
      }
      continue;
    }
    if (!cue.name) continue;
    // Named cue → play every AudioSource whose playOnCue matches, as a one-shot.
    world.query(AudioSource).updateEach(([a], entity) => {
      if (a.playOnCue !== cue.name) return;
      const pos = positionOf(entity);
      const spec = resolveSpec(a.clip, {
        bus: (cue.bus ?? a.bus) as BusName, volume: cue.volume ?? a.volume,
        pitch: cue.pitch ?? a.pitch, spatial: a.spatial, refDistance: a.refDistance,
        maxDistance: a.maxDistance, rolloff: a.rolloff, position: pos,
      });
      if (spec) play(spec);
    });
  }
}

// Injected WORLD-position resolver (P3 — hierarchy-and-world-transform-plan). The app wires
// this to the `worldTransforms` cache so a PARENTED audio source/listener is spatialized at
// its WORLD position (correct for nested rigs). Left null when audio is used standalone →
// falls back to the LOCAL Transform, keeping this module THREE-free by default (the world
// cache is computed by the Three-dependent transformPropagationSystem). Audio runs at
// SYSTEM_PRIORITY.AUDIO (250) > TRANSFORM (200), so the cache reflects this frame's final poses.
let _worldPos: ((entityId: number) => { x: number; y: number; z: number } | undefined) | null = null;
/** Wire a world-position resolver for spatial audio (app-side; reads the worldTransforms cache). */
export function setAudioWorldPositionResolver(fn: typeof _worldPos): void { _worldPos = fn; }

/** Entity's WORLD position for spatial audio (via the injected resolver), falling back to its
 *  LOCAL Transform, or origin when it has no Transform. */
function positionOf(entity: Entity): { x: number; y: number; z: number } {
  const w = _worldPos?.(entity.id());
  if (w) return { x: w.x, y: w.y, z: w.z };
  const tf = entity.has(Transform) ? entity.get(Transform) : undefined;
  return tf ? { x: tf.x, y: tf.y, z: tf.z } : { x: 0, y: 0, z: 0 };
}
