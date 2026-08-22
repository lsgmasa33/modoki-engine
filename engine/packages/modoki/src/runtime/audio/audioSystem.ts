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
import { Transform } from '../core/traits/Transform';
import { AudioSource } from '../traits/AudioSource';
import {
  AudioSettings, AUDIO_SETTINGS_DEFAULT_LIMIT, AUDIO_SETTINGS_DEFAULT_STEAL_FADE,
} from '../traits/AudioSettings';
import { AudioListener } from '../traits/AudioListener';
import { getPlayState } from '../core/playState';
import { isTimelinePreviewActive } from '../core/timelinePreview';
import { onWorldSwap } from '../core/ecs/world';
import {
  play, updateListener, crossfade, type AudioHandle, type AudioPlaySpec, type BusName,
} from './audioService';
import { drainAudioCues, clearAudioCues, type AudioCue } from './audioCues';
import { audioAssetProvider } from './audioAssetProvider';
function getCachedAudioBuffer(ref: string) { return audioAssetProvider.get()?.getCachedAudioBuffer(ref); }
function resolveAudioUrl(ref: string) { return audioAssetProvider.get()?.resolveAudioUrl(ref); }
function getAudioLoadType(ref: string): 'buffer' | 'stream' { return audioAssetProvider.get()?.getAudioLoadType(ref) ?? 'buffer'; }
import { hasAudioSupport } from './audioContext';
import { emit, entityRef } from '../core/journal';

/** The audio subsystem's semantic journal event — the assertion surface every other
 *  subsystem already has (`@zone`, `@sequence`, `@collision`) and audio did not (#289).
 *
 *  Emitted HERE rather than in `audioService` on purpose. The service is a Web Audio
 *  backend that knows nothing about entities and is fully no-op'd in record mode; the
 *  system is where playback intent is decided, so this is the only layer that can name
 *  the ENTITY a voice belongs to and that fires identically headless and live. That
 *  matters because the harness runs with no AudioContext at all — an event emitted from
 *  the backend would be describing the mock, not the game.
 *
 *  `entity` is the stable GUID via `entityRef` (surviving a scene hot-reload) and is
 *  omitted for a fire-and-forget cue one-shot, which has no owning entity by design.
 *  Deliberately NOT routed through the cue bus: `audioCues.ts`'s header explains why
 *  playback must not depend on the journal, and this is the reverse direction — an
 *  observation of playback that has already been decided. */
export type AudioPhase =
  | 'start' | 'swap' | 'pause' | 'resume' | 'stop' | 'end'
  /** A one-shot cue given up on — `reason` says whether it aged out or overflowed the retry list. */
  | 'dropped'
  /** An entity source whose clip will not resolve. Emitted ONCE per (entity, clip), at `warn`,
   *  because that retry is unbounded — see `startOrSwap`. */
  | 'unresolved'
  /** A one-shot cut short to stay under `AudioSettings.sfxVoiceLimit`. */
  | 'stolen';

interface AudioEventDetail {
  clip?: string;
  bus?: string;
  loop?: boolean;
  spatial?: boolean;
  /** Crossfade duration on a `swap`, when one was applied. */
  crossfadeSec?: number;
  /** Why a `stop` happened — teardown paths a caller can otherwise not tell apart. */
  reason?: string;
}

/** Terminal event for a `fadingOut` entry, wherever it is reaped from.
 *
 *  ONE helper rather than the guard inlined at each of the three reap sites, because the
 *  decision it makes — "a `silent` entry already emitted its terminal event, so emitting
 *  another would double-count it against `start`" — is only REACHABLE from one of those
 *  sites headlessly: record mode has no audio clock, so a stolen tail never self-ends and
 *  the per-frame sweep never sees one. Inlined, the sweep's copy of the guard was untested
 *  and a mutation that removed it stayed green. Shared, testing any reap site tests the
 *  decision. */
function reapTail(
  world: World, t: { handle: AudioHandle; clip: string; silent?: boolean }, reason?: string,
): void {
  if (t.silent) return; // its terminal event was the `stolen` emitted when it was cut
  journalAudio(world, reason ? 'stop' : 'end', undefined, { clip: t.clip, ...(reason ? { reason } : {}) });
}

function journalAudio(
  world: World, phase: AudioPhase, entity: Entity | undefined, detail: AudioEventDetail = {},
): void {
  emit('@audio', { phase, ...(entity ? { entity: entityRef(entity) } : {}), ...detail }, world);
}

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
  /** Kept as `{handle, clip}` rather than a bare handle so a tail's teardown can name
   *  the clip it belonged to. A tail IS a voice — it is audible, and it is one of the
   *  concurrent sources a voice-count measurement has to include — so leaving it out of
   *  the trace made `start`/`swap` and `stop`/`end` unbalanced by exactly one per
   *  crossfade, which is precisely the arithmetic the deferred voice cap needs. */
  fadingOut: { handle: AudioHandle; clip: string; silent?: boolean }[];
  /** Live fire-and-forget one-shots, OLDEST FIRST — insertion order IS age order, which is
   *  what makes oldest-first stealing a `shift()` rather than a search. Only `sfx`-bus
   *  one-shots are tracked, because only they are subject to the cap. Before this the
   *  handle from a one-shot `play()` was discarded outright, so nothing in the engine knew
   *  how many were sounding. */
  oneShots: { handle: AudioHandle; clip: string }[];
  /** Entities already warned about an unresolvable clip, keyed by entity id → the clip
   *  warned about. `startOrSwap` retries a missing clip EVERY frame forever, so the warn
   *  has to fire once per (entity, clip) or it would be 60 events/sec. */
  warnedUnresolved: Map<number, string>;
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
  if (!s) {
    s = {
      sources: new Map(), autoplayed: new Set(), fadingOut: [], oneShots: [],
      warnedUnresolved: new Map(), pendingCues: [],
    };
    states.set(world, s);
  }
  return s;
}

/** Stop + forget a world's live audio (scene swap / teardown). Scoped to the given
 *  world — NOT a global stopAll — so a swap in one viewport can't cut audio in
 *  another (editor dual-viewport). */
export function stopWorldAudio(world: World): void {
  const s = states.get(world);
  if (s) {
    for (const src of s.sources.values()) {
      src.handle.stop();
      journalAudio(world, 'stop', undefined, { clip: src.clip, reason: 'world-teardown' });
    }
    s.sources.clear();
    s.autoplayed.clear();
    for (const t of s.fadingOut) {
      t.handle.stop();
      reapTail(world, t, 'world-teardown');
    }
    s.fadingOut = [];
    for (const o of s.oneShots) {
      o.handle.stop();
      journalAudio(world, 'stop', undefined, { clip: o.clip, reason: 'world-teardown' });
    }
    s.oneShots = [];
    s.warnedUnresolved.clear();
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
  if (src) {
    src.handle.stop();
    s.sources.delete(id);
    journalAudio(world, 'stop', entity, { clip: src.clip, reason: 'entity-stop' });
  }
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
  // treat "previewing" like "playing" here (see runtime/core/timelinePreview.ts). Everywhere
  // below, `playing` means "audio is live" — pause/stop/scrub all clear the preview flag.
  const playing = getPlayState() === 'playing' || isTimelinePreviewActive();

  if (!playing) {
    // Silence: stop everything, forget autoplay, discard pending cues.
    if (state.sources.size || state.fadingOut.length || state.oneShots.length) {
      for (const src of state.sources.values()) {
        src.handle.stop();
        journalAudio(world, 'stop', undefined, { clip: src.clip, reason: 'not-playing' });
      }
      state.sources.clear();
      for (const t of state.fadingOut) {
        t.handle.stop();
        reapTail(world, t, 'not-playing');
      }
      state.fadingOut = [];
      for (const o of state.oneShots) {
        o.handle.stop();
        journalAudio(world, 'stop', undefined, { clip: o.clip, reason: 'not-playing' });
      }
      state.oneShots = [];
    }
    state.autoplayed.clear();
    state.warnedUnresolved.clear();
    state.pendingCues = [];
    drainAudioCues(world);
    world.query(AudioSource).updateEach(([a]) => { if (a.playing) a.playing = false; });
    return;
  }

  // Sweep finished one-shots so a dead voice cannot hold a slot against the cap. In live
  // mode a non-looping source self-reaps via `onended`; in record mode nothing ends on its
  // own, which is what lets a headless test drive the cap deterministically.
  if (state.oneShots.length) {
    state.oneShots = state.oneShots.filter((o) => {
      if (!o.handle.ended) return true;
      journalAudio(world, 'end', undefined, { clip: o.clip });
      return false;
    });
  }

  // Sweep crossfade tails that have self-stopped (via their audio-clock stopAfter).
  if (state.fadingOut.length) {
    state.fadingOut = state.fadingOut.filter((t) => {
      if (!t.handle.ended) return true;
      // `silent` = a stolen voice, whose terminal event (`stolen`) was already emitted when
      // it was cut. It rides here only so teardown can force-stop it mid-ramp; emitting
      // `end` as well would double-count it against `start`.
      reapTail(world, t);
      return false;
    });
  }

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
      journalAudio(world, 'end', entity, { clip: src.clip });
      state.sources.delete(id);
      src = undefined;
      a.playing = false;
    }

    if (a.playing) {
      if (src && src.clip === a.clip) {
        // Same clip: resume if paused, then apply live params.
        if (src.paused) {
          src.handle.resume();
          src.paused = false;
          journalAudio(world, 'resume', entity, { clip: src.clip });
        }
        src.handle.setVolume(a.volume);
        src.handle.setPitch(a.pitch);
        if (a.spatial) { const p = positionOf(entity); src.handle.setPosition(p.x, p.y, p.z); }
      } else {
        // No handle, or the clip changed → start the (new) clip.
        startOrSwap(world, state, entity, a, src);
      }
    } else if (src && !src.paused) {
      // playing=false → pause (keep the handle + position).
      src.handle.pause();
      src.paused = true;
      journalAudio(world, 'pause', entity, { clip: src.clip });
    }
  });

  // Stop handles whose entity (or AudioSource trait) vanished this frame.
  for (const [id, src] of [...state.sources]) {
    if (!seen.has(id)) {
      src.handle.stop();
      state.sources.delete(id);
      state.autoplayed.delete(id);
      journalAudio(world, 'stop', undefined, { clip: src.clip, reason: 'entity-gone' });
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
function startOrSwap(world: World, state: AudioState, entity: Entity, a: TraitValue<ExtractSchema<typeof AudioSource>>, prev: SourceState | undefined): void {
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
  if (!spec) {
    // Not decoded yet — keep the current source and retry next frame. Unlike the cue
    // path this retry is UNBOUNDED, so a clip that can never resolve (a broken ref, a
    // stream URL the manifest cannot resolve) leaves `a.playing` true forever while the
    // trace shows nothing at all for the entity — indistinguishable from one that never
    // tried to play, and exactly the failure a QA case most wants to catch. Warn ONCE
    // per (entity, clip): every frame would be 60 events/sec, which would flush the ring.
    const id = entity.id();
    if (state.warnedUnresolved.get(id) !== clip) {
      state.warnedUnresolved.set(id, clip);
      emit('@audio', { phase: 'unresolved', entity: entityRef(entity), clip }, world, 'warn');
    }
    return;
  }
  state.warnedUnresolved.delete(entity.id()); // it resolved — re-arm the warn
  const next = play(spec);
  if (cross && prev) {
    crossfade(prev.handle, next, a.volume, crossfadeSec);
    // Reap the outgoing tail on the audio clock (survives time-stop), and track it
    // so a game Stop / scene swap can force-stop it mid-fade.
    prev.handle.stopAfter(crossfadeSec + 0.1);
    state.fadingOut.push({ handle: prev.handle, clip: prev.clip });
  } else {
    prev?.handle.stop();
  }
  state.sources.set(entity.id(), { handle: next, clip, paused: false });
  a.playing = true;
  journalAudio(world, prev ? 'swap' : 'start', entity, {
    clip, bus: a.bus, loop: a.loop, spatial: a.spatial,
    ...(cross ? { crossfadeSec } : {}),
  });
}

/** Play a fire-and-forget one-shot, enforcing `AudioSettings.sfxVoiceLimit`.
 *
 *  Only `sfx`-bus one-shots are counted or stolen — music is on its own bus, `ui` is
 *  deliberately uncapped, and entity-owned `AudioSource` voices are never stolen at all
 *  (a looping ambience is the oldest voice forever, so oldest-first would kill it the
 *  instant the cap engaged). See `AudioSettings` for the reasoning behind each exemption. */
function playOneShot(
  world: World, state: AudioState, spec: AudioPlaySpec, limit: number, stealFadeSec: number,
): void {
  const bus = spec.bus ?? 'sfx';
  if (bus !== 'sfx' || limit <= 0) { play(spec); return; }
  // Oldest first: insertion order is age order, so the victim is always at the head.
  while (state.oneShots.length >= limit) {
    const victim = state.oneShots.shift();
    if (!victim) break;
    // Ramp to silence rather than cutting: a bare stop is an amplitude discontinuity, i.e.
    // an audible click on EVERY steal. Duration is AUTHORED (`sfxStealFadeSec`) because it
    // is a feel value; 0 is a legitimate authored choice meaning "hard cut".
    if (stealFadeSec > 0) {
      victim.handle.fade(0, stealFadeSec);
      victim.handle.stopAfter(stealFadeSec);
      // Hand the ramping handle to `fadingOut` rather than orphaning it. Dropping the last
      // reference would mean teardown could no longer force-stop it mid-ramp — the exact
      // capability `fadingOut` exists to provide — and in record mode, where `stopAfter` is
      // a no-op, nothing would ever call `stop()` on it, so it would sit `ended:false`
      // forever with a `play` in the log and no matching `stop`. `silent` because its
      // terminal event is the `stolen` below, not a second `end`.
      state.fadingOut.push({ handle: victim.handle, clip: victim.clip, silent: true });
    } else {
      victim.handle.stop(); // hard cut — no ramp to outlive us, so reap it here
    }
    journalAudio(world, 'stolen', undefined, { clip: victim.clip, bus, reason: 'voice-cap' });
  }
  const handle = play(spec);
  // An INERT handle (no graph / play threw) reports ended:true and would be swept next
  // frame anyway, but tracking it would let a dead voice hold a slot for a frame.
  if (!handle.ended) state.oneShots.push({ handle, clip: spec.clip ?? '' });
}

/** The authored voice-cap settings, falling back to the trait's own defaults when no scene
 *  entity carries `AudioSettings`. Read once per frame rather than per shot. */
function audioSettings(world: World): { limit: number; stealFadeSec: number } {
  const a = world.queryFirst(AudioSettings)?.get(AudioSettings);
  return {
    // FLOORED: the Inspector's number box accepts a typed fraction (step:1 only constrains
    // the spinner), and `while (length >= 2.5)` settles at 3 rather than 2 — an off-by-one
    // effective cap that no error would report. A voice count is an integer by nature.
    limit: Math.floor(a?.sfxVoiceLimit ?? AUDIO_SETTINGS_DEFAULT_LIMIT),
    stealFadeSec: a?.sfxStealFadeSec ?? AUDIO_SETTINGS_DEFAULT_STEAL_FADE,
  };
}

function playCues(world: World, state: AudioState, cues: AudioCue[]): void {
  const { limit, stealFadeSec } = audioSettings(world);
  // Retry one-shots deferred on a previous frame — their buffer may have finished decoding (e.g.
  // after the iOS first-gesture resume). Play the ready ones; age out the rest, dropping at 0.
  if (state.pendingCues.length) {
    const still: { cue: AudioCue; frames: number }[] = [];
    for (const p of state.pendingCues) {
      const spec = resolveSpec(p.cue.clip ?? '', { bus: p.cue.bus, volume: p.cue.volume, pitch: p.cue.pitch });
      if (spec) {
        playOneShot(world, state, spec, limit, stealFadeSec);
        journalAudio(world, 'start', undefined, { clip: p.cue.clip, bus: p.cue.bus });
        continue;
      }
      if (--p.frames > 0) { still.push(p); continue; }
      // Aged out — the clip never decoded. Previously a completely silent drop, which is
      // the one audio failure a player DOES notice and no trace recorded.
      emit('@audio', { phase: 'dropped', clip: p.cue.clip, reason: 'decode-timeout' }, world, 'warn');
    }
    state.pendingCues = still;
  }
  for (const cue of cues) {
    if (cue.clip) {
      const spec = resolveSpec(cue.clip, { bus: cue.bus, volume: cue.volume, pitch: cue.pitch });
      if (spec) {
        playOneShot(world, state, spec, limit, stealFadeSec);
        journalAudio(world, 'start', undefined, { clip: cue.clip, bus: cue.bus });
        continue;
      }
      // Buffer clip not decoded yet (iOS: decode lands only after the first-gesture resume) → defer
      // and retry for a bounded window instead of dropping the shot. Stream clips + record mode
      // resolve immediately, so a null there is a genuine miss, not a decode wait — don't queue.
      if (getAudioLoadType(cue.clip) !== 'stream' && hasAudioSupport()) {
        if (state.pendingCues.length < MAX_PENDING_CUES) {
          state.pendingCues.push({ cue, frames: ONE_SHOT_RETRY_FRAMES });
        } else {
          // The retry list is full, so this shot is discarded outright. The age-out path
          // below already emits `dropped`; this branch did not, which left the WORST case
          // (a cold-boot burst of >32 undecoded cues — the exact scenario pendingCues
          // exists for) as the one silent drop remaining.
          emit('@audio', { phase: 'dropped', clip: cue.clip, reason: 'retry-overflow' }, world, 'warn');
        }
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
      if (spec) {
        // A named cue fans out to matching AudioSources, but each shot is still a
        // fire-and-forget one-shot (no handle is retained on the entity), so it counts
        // against the cap like any other. What is exempt is a source's OWN declarative
        // playback via `startOrSwap`, which the cap never touches.
        playOneShot(world, state, spec, limit, stealFadeSec);
        journalAudio(world, 'start', entity, { clip: a.clip, bus: cue.bus ?? a.bus, spatial: a.spatial });
      }
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
