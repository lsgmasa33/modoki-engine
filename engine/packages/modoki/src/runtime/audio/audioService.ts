/** Audio playback backend — a thin layer over the Web Audio API.
 *
 *  Graph:  source → sourceGain(volume) → [panner if spatial] → busGain → masterGain → mute → destination
 *  Buses:  master · music · sfx · ui   (music/sfx/ui feed master; 'master' IS masterGain)
 *
 *  Two source kinds, chosen per-clip by the asset's `loadType`:
 *   - `buffer`  → `AudioBufferSourceNode` fed a decoded `AudioBuffer` (short SFX).
 *   - `stream`  → `HTMLMediaElement` via `MediaElementAudioSourceNode` (long music,
 *                 tiny memory).
 *
 *  Headless / no-AudioContext (SSR, tests): the service enters RECORD MODE — every
 *  `play`/`stop`/`setBusVolume` is appended to an inspectable log and playback is a
 *  no-op. This is what keeps the verification harness silent + deterministic while
 *  still letting a test assert *what would have played* (`getAudioLog()`), with no
 *  dependency on the journal being enabled. */

import { getAudioContext, hasAudioSupport } from './audioContext';
import { audioAssetProvider } from './audioAssetProvider';
function retryFailedAudioDecodes() { audioAssetProvider.get()?.retryFailedAudioDecodes(); }

export type BusName = 'master' | 'music' | 'sfx' | 'ui';

export interface AudioPlaySpec {
  /** Decoded buffer (loadType 'buffer'). Mutually exclusive with `url`. */
  buffer?: AudioBuffer | null;
  /** Streamable URL (loadType 'stream'). Mutually exclusive with `buffer`. */
  url?: string;
  /** The clip guid — carried only for the record log / debugging. */
  clip?: string;
  bus?: BusName;
  volume?: number;   // 0..1
  pitch?: number;    // playbackRate
  loop?: boolean;
  spatial?: boolean;
  refDistance?: number;
  maxDistance?: number;
  rolloff?: number;
  position?: { x: number; y: number; z: number };
}

export interface AudioHandle {
  stop(): void;
  setVolume(v: number): void;
  setPitch(rate: number): void;
  /** Ramp this source's volume to `target` over `durationSec` (linear). The basis
   *  of crossfades — fade an outgoing clip to 0 while fading an incoming one up. */
  fade(target: number, durationSec: number): void;
  /** Stop this source `seconds` from now, scheduled on the AUDIO clock (a
   *  ConstantSourceNode timer) — NOT engine time. So a crossfade tail reaps even
   *  while gameplay is time-stopped (timeScale 0) and regardless of frame rate. */
  stopAfter(seconds: number): void;
  /** Pause playback, keeping position (a stream truly pauses; a buffer source
   *  can't seek, so it mutes and keeps advancing). `resume()` un-pauses. */
  pause(): void;
  resume(): void;
  setPosition(x: number, y: number, z: number): void;
  /** True once the clip has finished / been stopped. */
  readonly ended: boolean;
  /** Seconds of this clip still to play, or `null` when that is not knowable —
   *  a looping source (it never ends), a stream whose metadata has not loaded yet,
   *  or record mode, which has no audio clock at all.
   *
   *  Exists so a playlist can cross-fade INTO the next track: waiting for `ended`
   *  is too late, because by then there is no live voice left to fade out. `null`
   *  must be read as "do not act yet", never as "0". */
  remainingSec(): number | null;
}

export interface AudioLogEntry {
  op: 'play' | 'stop' | 'setBusVolume' | 'resume' | 'listener' | 'fade';
  clip?: string;
  bus?: BusName;
  volume?: number;
  spatial?: boolean;
  loop?: boolean;
  /** Spatial start position (record mode) — lets tests assert the WORLD pose a source played at. */
  position?: { x: number; y: number; z: number };
  /** Ramp length for an `op:'fade'` entry, in seconds. Without this, a crossfade and a
   *  voice-cap steal are both invisible headlessly — the ramp is the whole behaviour, and
   *  a no-op `fade()` cannot tell an authored 250 ms from a hardcoded 10 ms. */
  durationSec?: number;
}

// ── Record mode (headless / tests) ────────────────────────────────
let forcedRecord = false;
const log: AudioLogEntry[] = [];

/** Force record mode even when an AudioContext exists (test hook). */
export function setAudioRecordMode(on: boolean): void { forcedRecord = on; }

/** Live record-mode handles, so a test can end them (see `endRecordedVoices`). */
const recordedVoices = new Set<{ _markEnded(): void }>();

/** Simulate every outstanding record-mode voice reaching its natural end.
 *
 *  Record mode has no audio clock and no `onended`, so nothing ever finishes on its own —
 *  which left the "a finished voice frees its slot" behaviour untestable, and a test that
 *  *looked* like it covered the reap sweep actually passed only because teardown cleared
 *  the list wholesale. This is the missing affordance: record mode exists so tests can
 *  assert what WOULD have happened, and "the sound finished" is part of that.
 *
 *  Not a `stop()` — a natural end is not a teardown, so nothing is logged. */
export function endRecordedVoices(): void {
  for (const h of [...recordedVoices]) h._markEnded();
  recordedVoices.clear();
}
export function getAudioLog(): readonly AudioLogEntry[] { return log; }
export function clearAudioLog(): void { log.length = 0; recordedVoices.clear(); }

function recording(): boolean {
  return forcedRecord || !hasAudioSupport();
}

// Returned on a real no-graph / error path: `ended: true` so the caller reaps it.
const INERT: AudioHandle = {
  stop() { /* no-op */ },
  setVolume() { /* no-op */ },
  setPitch() { /* no-op */ },
  fade() { /* no-op */ },
  stopAfter() { /* no-op */ },
  pause() { /* no-op */ },
  resume() { /* no-op */ },
  setPosition() { /* no-op */ },
  ended: true,
  remainingSec: () => null,
};

// Returned in record mode, ONE PER `play()` — not a shared singleton.
//
// It used to be a single frozen object with `ended: false` hardcoded and a no-op
// `stop()`, which made teardown unobservable in two distinct ways (#289). The
// obvious one: `getAudioLog()` could prove a voice STARTED and never that one was
// torn down, so any lifetime assertion silently passed. The subtler one: because
// every headless source shared the object, `audioSystem`'s per-source reap check
// (`if (src.handle.ended)`) was answered by a process-wide constant rather than by
// the source it was asked about — one handle could not differ from another.
//
// So each play mints its own, flipping its OWN `ended` and appending a `stop` entry.
// `ended` still starts false so the system tracks it as live (headless has no real
// 'ended' callback, and nothing ends a record-mode voice on its own).
class RecordingHandle implements AudioHandle {
  ended = false;
  _markEnded(): void { this.ended = true; }
  // Record mode has no audio clock — see the class banner. `null`, not 0, so a caller
  // that treats 0 as "swap now" does not fire on every headless frame.
  remainingSec(): number | null { return null; }
  // Declared + assigned rather than a `private readonly` constructor parameter:
  // the ROOT tsconfig sets `erasableSyntaxOnly`, under which a parameter property
  // is a hard error (TS1294) — and the package's own tsconfig.check.json does not,
  // so this only fails at `npm run typecheck`, not at the package typecheck.
  private readonly clip?: string;
  constructor(clip?: string) { this.clip = clip; recordedVoices.add(this); }
  stop(): void {
    if (this.ended) return;
    this.ended = true;
    recordedVoices.delete(this);
    log.push({ op: 'stop', clip: this.clip });
  }
  setVolume(): void { /* no-op */ }
  setPitch(): void { /* no-op */ }
  fade(target: number, durationSec: number): void {
    log.push({ op: 'fade', clip: this.clip, volume: target, durationSec });
  }
  // No audio clock in record mode, so a scheduled stop cannot fire on its own. The
  // callers that care (a crossfade tail) also force-stop via `stopWorldAudio`, so the
  // tail is still reaped — just at teardown rather than after `seconds`.
  stopAfter(): void { /* no-op — see above */ }
  pause(): void { /* no-op */ }
  resume(): void { /* no-op */ }
  setPosition(): void { /* no-op */ }
}

// ── Live Web Audio graph (lazy) ───────────────────────────────────
interface Graph {
  ctx: AudioContext;
  master: GainNode;
  /** Global mute, between master and destination — independent of bus/source
   *  volumes so muting doesn't clobber them (Unity-style editor "Mute Audio"). */
  mute: GainNode;
  buses: Record<Exclude<BusName, 'master'>, GainNode>;
}
let graph: Graph | null = null;
const active = new Set<LiveHandle>();
let muted = false; // persists across graph (re)creation

function graphOrNull(): Graph | null {
  if (graph) return graph;
  const ctx = getAudioContext();
  if (!ctx) return null;
  const mute = ctx.createGain();
  mute.gain.value = muted ? 0 : 1;
  mute.connect(ctx.destination);
  const master = ctx.createGain();
  master.connect(mute);
  const mk = () => { const g = ctx.createGain(); g.connect(master); return g; };
  const musicBus = ctx.createGain();
  musicBus.connect(master);
  graph = { ctx, master, mute, buses: { music: musicBus, sfx: mk(), ui: mk() } };
  // Reapply the tracked bus mix to the fresh nodes (they start at gain 1) — the
  // same way `muted` is reapplied above. Without this, a graph recreated after
  // dispose() (error recovery / editor stop-restart) plays every bus at full
  // volume while the busVolumes snapshot still reports the old values.
  master.gain.value = busVolumes.master;
  graph.buses.music.gain.value = busVolumes.music;
  graph.buses.sfx.gain.value = busVolumes.sfx;
  graph.buses.ui.gain.value = busVolumes.ui;
  return graph;
}

/** Global mute — silences ALL audio without touching bus/source volumes. Backs
 *  the editor Game-view "Mute Audio" toggle. Persists if the graph is recreated. */
export function setAudioMuted(m: boolean): void {
  muted = m;
  if (recording()) return;
  const g = graphOrNull();
  if (g) g.mute.gain.value = m ? 0 : 1;
}
export function isAudioMuted(): boolean { return muted; }

function busNode(g: Graph, bus: BusName): GainNode {
  return bus === 'master' ? g.master : g.buses[bus];
}

// Last-set bus volumes — tracked in BOTH live + record mode so a graph recreated
// on editor stop-restart can reapply the mix, and so setBusVolume works headless
// with no AudioContext.
const busVolumes: Record<BusName, number> = { master: 1, music: 1, sfx: 1, ui: 1 };

/** Resume the context after a user gesture (mobile autoplay policy). Also retries
 *  any streaming source whose `HTMLMediaElement.play()` was gesture-rejected — a
 *  buffer source scheduled while suspended sounds on resume, but a paused media
 *  element must be re-kicked or it stays silent forever. */
/** Subsystems that also need the first-user-gesture signal (video: an
 *  `HTMLVideoElement` whose `play()` was autoplay-blocked needs exactly the same
 *  re-kick as a streamed audio clip). They register here rather than each hooking
 *  the DOM themselves, so there is ONE definition of "the user has now interacted"
 *  — App.tsx calls `audioResume()` and everything unlocks together. */
type GestureUnlockListener = () => void;
const gestureUnlockListeners = new Set<GestureUnlockListener>();

/** Register a listener fired on the first user gesture. Returns an unregister fn. */
export function onGestureUnlock(fn: GestureUnlockListener): () => void {
  gestureUnlockListeners.add(fn);
  return () => { gestureUnlockListeners.delete(fn); };
}

/** Route a caller-owned media element's audio through the engine's bus graph.
 *
 *  For VIDEO: the picture is the caller's, the sound is ours. Without this a video's
 *  audio bypasses the mix entirely — a player who muted SFX in settings would still
 *  hear the cutscene. Returns a detach fn plus a volume setter.
 *
 *  ⚠️ `createMediaElementSource` may be called ONCE per element, ever. Call this once
 *  per element and keep the returned handle; re-attaching throws.
 *
 *  Returns null when there is no audio graph (headless/inert) — callers MUST treat
 *  that as "play anyway, unrouted", never as a failure to play. Video playback does
 *  not depend on the audio subsystem existing. */
export function attachMediaElementToBus(
  el: HTMLMediaElement, bus: BusName = 'sfx', volume = 1,
): { setVolume(v: number): void; detach(): void } | null {
  const g = graphOrNull();
  if (!g) return null;
  try {
    const gain = g.ctx.createGain();
    gain.gain.value = volume;
    const src = g.ctx.createMediaElementSource(el);
    src.connect(gain);
    gain.connect(busNode(g, bus));
    return {
      setVolume(v: number) { gain.gain.value = v; },
      detach() {
        try { src.disconnect(); } catch { /* already gone */ }
        try { gain.disconnect(); } catch { /* already gone */ }
      },
    };
  } catch {
    // Already-attached element, or an unsupported context — unrouted audio still
    // plays through the element itself, which beats not playing at all.
    return null;
  }
}

export function resume(): void {
  // Fire the gesture listeners FIRST, and unconditionally.
  //
  // "The user has interacted" is not an audio fact — it is a document fact. This used
  // to sit at the bottom of the function, below the `recording()` early-return, which
  // meant that on any platform WITHOUT Web Audio (`recording()` is true when
  // `hasAudioSupport()` is false) the signal never fired at all. Harmless for audio,
  // since there is nothing to unlock — but VIDEO does not need Web Audio to play, so
  // it would have sat behind the autoplay block forever on exactly those devices.
  for (const fn of gestureUnlockListeners) {
    try { fn(); } catch { /* a subsystem's retry must not break the unlock */ }
  }
  if (recording()) { log.push({ op: 'resume' }); return; }
  const g = graphOrNull();
  if (g && g.ctx.state === 'suspended') {
    // Retry buffer decodes ONLY after the context is running — iOS rejects
    // decodeAudioData while suspended (the scene-load decodes failed there).
    g.ctx.resume().then(retryFailedAudioDecodes).catch(() => { /* ignore */ });
  } else {
    retryFailedAudioDecodes();
  }
  for (const h of active) h.resumeMedia();
}

export function setBusVolume(bus: BusName, volume: number): void {
  busVolumes[bus] = volume;
  if (recording()) { log.push({ op: 'setBusVolume', bus, volume }); return; }
  const g = graphOrNull();
  if (g) busNode(g, bus).gain.value = volume;
}

// ── Mix helper (crossfade) ────────────────────────────────────────
// Handle gains ramped with the AudioParam schedule (no wall-clock timers, so the
// determinism guard stays happy). The broader mix API (bus fades, ducking, mix
// snapshots) was frozen — reintroduce a specific helper when a game needs it.

/** Crossfade two playing handles: fade `outgoing` to 0 and `incoming` up to
 *  `targetVolume` over `durationSec`. The caller owns lifetime — `outgoing` keeps
 *  playing silently until the caller `stop()`s it (looping music never self-ends),
 *  so stop it after the fade. Pass an `incoming` started at volume 0. */
export function crossfade(
  outgoing: AudioHandle | null | undefined,
  incoming: AudioHandle | null | undefined,
  targetVolume = 1,
  durationSec = 0.5,
): void {
  outgoing?.fade(0, durationSec);
  incoming?.fade(targetVolume, durationSec);
}

/** Linear-ramp an AudioParam to `target` over `durationSec`, anchoring the current
 *  value so the ramp starts from where the param actually is. */
function rampParam(ctx: AudioContext, param: AudioParam, target: number, durationSec: number): void {
  const now = ctx.currentTime;
  if (durationSec <= 0) {
    param.cancelScheduledValues(now);
    param.value = target;
    return;
  }
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(target, now + durationSec);
}

/** Position the listener (spatial audio). Orientation defaults to -Z forward / +Y up
 *  in Phase 1 — position drives the audible distance attenuation. */
export function updateListener(x: number, y: number, z: number): void {
  if (recording()) return;
  const g = graphOrNull();
  if (!g) return;
  const l = g.ctx.listener;
  if (l.positionX) {
    l.positionX.value = x; l.positionY.value = y; l.positionZ.value = z;
  } else {
    (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
  }
}

export function play(spec: AudioPlaySpec): AudioHandle {
  if (recording()) {
    log.push({
      op: 'play', clip: spec.clip, bus: spec.bus ?? 'sfx',
      volume: spec.volume ?? 1, spatial: !!spec.spatial, loop: !!spec.loop,
      ...(spec.spatial && spec.position ? { position: { ...spec.position } } : {}),
    });
    return new RecordingHandle(spec.clip);
  }
  const g = graphOrNull();
  if (!g) return INERT;
  try {
    return new LiveHandle(g, spec);
  } catch (err) {
    console.warn('[audioService] play failed:', err);
    return INERT;
  }
}

/** Stop every live source (scene teardown / Stop). */
export function stopAll(): void {
  for (const h of [...active]) h.stop();
}

/** Tear down the whole graph (app unmount / error recovery). */
export function dispose(): void {
  stopAll();
  graph = null;
}

class LiveHandle implements AudioHandle {
  ended = false;
  private deliberatelyPaused = false;
  /** `ctx.currentTime` when a BUFFER source started — a buffer node exposes no playhead,
   *  so its remaining time is derived from the audio clock rather than read back. */
  private bufStartedAt = 0;
  private looping = false;
  private ctx: AudioContext;
  private gain: GainNode;
  private bufSrc?: AudioBufferSourceNode;
  private mediaEl?: HTMLAudioElement;
  private mediaSrc?: MediaElementAudioSourceNode;
  private panner?: PannerNode;

  constructor(g: Graph, spec: AudioPlaySpec) {
    const { ctx } = g;
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = spec.volume ?? 1;

    // Optional spatial panner between source-gain and the bus.
    let tail: AudioNode = this.gain;
    if (spec.spatial) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = spec.refDistance ?? 1;
      p.maxDistance = spec.maxDistance ?? 50;
      p.rolloffFactor = spec.rolloff ?? 1;
      const pos = spec.position ?? { x: 0, y: 0, z: 0 };
      if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
      else (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos.x, pos.y, pos.z);
      this.gain.connect(p);
      this.panner = p;
      tail = p;
    }
    tail.connect(busNode(g, spec.bus ?? 'sfx'));

    if (spec.buffer) {
      const src = ctx.createBufferSource();
      src.buffer = spec.buffer;
      src.loop = !!spec.loop;
      src.playbackRate.value = spec.pitch ?? 1;
      src.connect(this.gain);
      src.onended = () => { if (!spec.loop) this.cleanup(); };
      src.start();
      this.bufStartedAt = ctx.currentTime;
      this.bufSrc = src;
    } else if (spec.url) {
      const el = new Audio(spec.url);
      el.loop = !!spec.loop;
      el.playbackRate = spec.pitch ?? 1;
      el.crossOrigin = 'anonymous';
      const src = ctx.createMediaElementSource(el);
      src.connect(this.gain);
      el.onended = () => { if (!spec.loop) this.cleanup(); };
      el.play().catch(() => { /* gesture-gated; resume() will unlock */ });
      this.mediaEl = el;
      this.mediaSrc = src;
    } else {
      throw new Error('play() needs a buffer or url');
    }
    this.looping = !!spec.loop;
    active.add(this);
  }

  /**
   * Seconds still to play, or `null` when unknowable.
   *
   * `null` for a LOOPING source (it never runs out), for a stream whose metadata has not
   * arrived (`duration` is NaN until then), and for anything already ended. A caller must read
   * `null` as "do not act yet" — returning 0 there would make a playlist swap on the first frame
   * of every track, before a note of it had played.
   *
   * The two source kinds answer differently because they must: a media element carries a real
   * playhead (`currentTime`), while a buffer node exposes none, so its position is derived from
   * the AUDIO clock — which is also the clock the crossfade ramps run on, so the two agree.
   */
  remainingSec(): number | null {
    if (this.ended || this.looping) return null;
    if (this.mediaEl) {
      const { duration, currentTime } = this.mediaEl;
      if (!Number.isFinite(duration)) return null;   // metadata not in yet
      return Math.max(0, duration - currentTime);
    }
    const buf = this.bufSrc?.buffer;
    if (!buf) return null;
    const rate = this.bufSrc?.playbackRate.value || 1;
    return Math.max(0, (buf.duration - (this.ctx.currentTime - this.bufStartedAt) * rate) / rate);
  }

  stop(): void {
    if (this.ended) return;
    try { this.bufSrc?.stop(); } catch { /* already stopped */ }
    if (this.mediaEl) { this.mediaEl.pause(); this.mediaEl.currentTime = 0; }
    this.cleanup();
  }

  setVolume(v: number): void { if (!this.ended) this.gain.gain.value = v; }

  setPitch(rate: number): void {
    if (this.ended) return;
    if (this.bufSrc) this.bufSrc.playbackRate.value = rate;
    if (this.mediaEl) this.mediaEl.playbackRate = rate;
  }

  fade(target: number, durationSec: number): void {
    if (this.ended) return;
    rampParam(this.ctx, this.gain.gain, target, durationSec);
  }

  /** Schedule a stop `seconds` from now on the AUDIO clock, using a silent
   *  ConstantSourceNode as a timer (its `onended` fires at the scheduled stop time,
   *  driven by the audio hardware clock — independent of engine timeScale + frame
   *  rate). This reaps a crossfade tail reliably even during a time-stop. */
  stopAfter(seconds: number): void {
    if (this.ended) return;
    try {
      const timer = this.ctx.createConstantSource();
      timer.onended = () => { try { timer.disconnect(); } catch { /* noop */ } this.stop(); };
      timer.start();
      timer.stop(this.ctx.currentTime + Math.max(0, seconds));
    } catch {
      this.stop(); // scheduling unsupported → stop now (still fades via the gain ramp)
    }
  }

  /** Deliberate pause (playing=false). A stream truly pauses; a buffer source
   *  can't seek, so it mutes (position keeps advancing) — the caller restores its
   *  gain via setVolume on resume. The flag stops resumeMedia() (gesture-unlock)
   *  from un-pausing a source the game intentionally paused. */
  pause(): void {
    if (this.ended || this.deliberatelyPaused) return;
    this.deliberatelyPaused = true;
    if (this.mediaEl) this.mediaEl.pause();
    else this.gain.gain.value = 0;
  }

  resume(): void {
    if (this.ended || !this.deliberatelyPaused) return;
    this.deliberatelyPaused = false;
    // Buffer gain is restored by the reconcile's setVolume on the same frame.
    if (this.mediaEl) this.mediaEl.play().catch(() => { /* gesture-gated; resumeMedia retries */ });
  }

  /** Re-kick a streaming element whose autoplay was gesture-blocked (called from
   *  resume() on the first user gesture). No-op for buffer sources / finished handles. */
  resumeMedia(): void {
    // Don't un-pause a source the game deliberately paused — only re-kick one whose
    // autoplay was gesture-blocked.
    if (this.ended || this.deliberatelyPaused || !this.mediaEl || !this.mediaEl.paused) return;
    this.mediaEl.play().catch(() => { /* still gated — a later gesture retries */ });
  }

  setPosition(x: number, y: number, z: number): void {
    const p = this.panner;
    if (!p || this.ended) return;
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
    else (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
  }

  private cleanup(): void {
    if (this.ended) return;
    this.ended = true;
    try { this.bufSrc?.disconnect(); } catch { /* noop */ }
    try { this.mediaSrc?.disconnect(); } catch { /* noop */ }
    try { this.panner?.disconnect(); } catch { /* noop */ }
    try { this.gain.disconnect(); } catch { /* noop */ }
    active.delete(this);
  }
}
