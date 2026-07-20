/** Audio playback backend — a thin layer over the Web Audio API.
 *
 *  Graph:  source → sourceGain(volume) → [panner if spatial] → busGain → masterGain → destination
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
import { retryFailedAudioDecodes } from '../loaders/audioBufferCache';

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
}

export interface AudioLogEntry {
  op: 'play' | 'stop' | 'setBusVolume' | 'resume' | 'listener';
  clip?: string;
  bus?: BusName;
  volume?: number;
  spatial?: boolean;
  loop?: boolean;
  /** Spatial start position (record mode) — lets tests assert the WORLD pose a source played at. */
  position?: { x: number; y: number; z: number };
}

// ── Record mode (headless / tests) ────────────────────────────────
let forcedRecord = false;
const log: AudioLogEntry[] = [];

/** Force record mode even when an AudioContext exists (test hook). */
export function setAudioRecordMode(on: boolean): void { forcedRecord = on; }
export function getAudioLog(): readonly AudioLogEntry[] { return log; }
export function clearAudioLog(): void { log.length = 0; }

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
};

// Returned in record mode: `ended: false` so the system tracks it as an active
// source (headless has no real 'ended' callback). Cleared wholesale on stop.
const RECORDING_HANDLE: AudioHandle = {
  stop() { /* no-op */ },
  setVolume() { /* no-op */ },
  setPitch() { /* no-op */ },
  fade() { /* no-op */ },
  stopAfter() { /* no-op */ },
  pause() { /* no-op */ },
  resume() { /* no-op */ },
  setPosition() { /* no-op */ },
  ended: false,
};

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
  graph = { ctx, master, mute, buses: { music: mk(), sfx: mk(), ui: mk() } };
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
export function resume(): void {
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
    return RECORDING_HANDLE;
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
    active.add(this);
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
