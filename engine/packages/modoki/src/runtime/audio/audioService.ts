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

import { notifyListeners } from '../core/notifyListeners';
import { createTeardownToken } from '../core/liveness';
import { getAudioContext, hasAudioSupport } from './audioContext';
import { audioAssetProvider } from './audioAssetProvider';
import { hasDocKey } from '../core/docKeys';
import { warnVocabOnce } from '../core/warnVocab';
import {
  recordAudioHealth, type AudioStreamHealth, type AudioResumeOutcome, type AudioKickReason,
} from './audioHealth';
function retryFailedAudioDecodes() { audioAssetProvider.get()?.retryFailedAudioDecodes(); }

/** The mixer's buses — the ONE list. Enum pickers spread it rather than typing the four names out
 *  again beside the table they must agree with (#1074; `docs/format-versioning.md` § 4b-ter). */
export const BUS_NAMES = ['master', 'music', 'sfx', 'ui'] as const;
export type BusName = typeof BUS_NAMES[number];

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
/** A fullscreen ad is up and holds the audio (#1455) — see `holdForFullscreenAd`. */
let adHold = false;
const statechangeWired = new WeakSet<AudioContext>();

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
  // WebKit can bring an interrupted context back to `running` ON ITS OWN when the interruption
  // ends — no gesture, no foreground event our re-arm sees — and a streamed bed the OS paused
  // meanwhile stays paused through it (#1428). Re-kick on that edge. Optional-called: the
  // headless fakes in the test suite are not EventTargets. Once per CONTEXT, not per graph:
  // dispose() rebuilds the graph on the same shared context.
  if (!statechangeWired.has(ctx)) {
    statechangeWired.add(ctx);
    ctx.addEventListener?.('statechange', () => {
      // Never while hidden: a context that comes back to `running` in the background must not
      // start a bed the OS paused there. The foreground re-arm covers the return.
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      // Traced on EVERY edge, including the ones this handler ignores. A context dropping to
      // `interrupted` is half the story of a lost bed, and an entry only on the `running` edge
      // would record the recoveries and none of the losses.
      recordAudioHealth({ kind: 'statechange', state: ctx.state, ctxTime: ctx.currentTime, streams: snapshotStreams() });
      if (ctx.state === 'running' && !hidden) resumeActiveMedia();
    });
  }
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

/** ⚠️ Every caller NORMALISES first — `resolveBus` on the two playback paths, an outright
 *  refusal in `setBusVolume` — so this index is total and needs no guard of its own (#993). Do not
 *  add one: a third check over one table is what let `loaders/primitives.ts` disagree with itself.
 *
 *  ⚠️ This claim has ROTTED once and been FAKED once. It said "the playback path", singular,
 *  while `attachMediaElementToBus` passed `VideoPlayer.bus` raw; the fix for that then cited a
 *  test file that had never existed on any branch — propping up "do not add one" with nothing.
 *  `tests/runtime/audioBusVocabulary.test.ts` exists now and SOURCE-SCANS this file: every
 *  `busNode(` call must pass `resolveBus(…)` or a code literal, with exactly one named exception
 *  (`setBusVolume`, which returns first), and it goes red on a fourth caller rather than
 *  absorbing it. */
function busNode(g: Graph, bus: BusName): GainNode {
  return bus === 'master' ? g.master : g.buses[bus];
}

/**
 * Normalise an authored `AudioSource.bus` to a bus the graph actually has.
 *
 * ⚠️ `AudioSource.bus` LOOKS like a union but its declaration is a cast on a default
 * (`bus: 'sfx' as 'master'|'music'|'sfx'|'ui'`) and the value is read straight off the trait, so a
 * scene carrying `bus: "constructor"` used to reach `busNode` and make `tail.connect(Object)`
 * throw "Failed to execute 'connect' on 'AudioNode'" — killing that entity's audio (#993).
 *
 * Falls back rather than refusing, because the alternative on this path is SILENCE: a typo'd bus
 * should still play. `setBusVolume` makes the opposite call deliberately — see its comment.
 */
export function resolveBus(bus: string | undefined): BusName {
  if (bus === undefined) return 'sfx';
  if (hasDocKey(busVolumes, bus)) return bus as BusName;
  warnVocabOnce('audio', 'AudioSource.bus', bus, "treated as 'sfx'");
  return 'sfx';
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
    // ⚠️ `resolveBus`, NOT the raw field (#993 close-out § 2d). `VideoPlayer.bus` is declared
    // `'sfx' as 'master'|'music'|'sfx'|'ui'` — the same cast-on-a-default that made
    // `AudioSource.bus` unsafe — and reaches here through `videoService.attachMediaElementToBus`
    // as `spec.bus ?? 'sfx'`, which never fires for a prototype name. Unfixed, `connect(Object)`
    // threw into the bare catch below AFTER `createMediaElementSource` had already redirected the
    // element's audio into the graph: the video then played SILENTLY, with no log line anywhere,
    // and `busRoute` was null so `setVolume` was a no-op.
    gain.connect(busNode(g, resolveBus(bus)));
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
  notifyListeners(gestureUnlockListeners, 'audioService:gestureUnlock', []); // a subsystem's retry must not break the unlock
  if (recording()) { log.push({ op: 'resume' }); return; }
  const g = graphOrNull();
  // Read BEFORE the attempt — `ctx.state` mutates under the resume, so a state read afterwards
  // cannot say what the OS had left behind, which is the fact the trace exists to keep.
  const before: string = g ? g.ctx.state : 'no-context';
  // An ad holds the audio: a tap, or the foreground edge iOS fires as the ad's view comes and goes,
  // must not bring our audio back up underneath it. The release resumes.
  if (adHold) { traceResume(g?.ctx, before, 'skipped-held'); return; }
  // ⚠️ "Not running", NOT "=== 'suspended'" (#1428). WebKit has a fourth, non-standard state,
  // `'interrupted'` — what backgrounding, screen lock, a call or Siri leave the context in on
  // current iOS. The old equality skipped exactly that case, so every foreground re-arm and every
  // tap was a no-op for it, and music stayed dead whenever WebKit did not happen to auto-resume
  // the context itself (it does so inconsistently — WebKit bug 263627).
  if (g && needsResume(g.ctx)) {
    const ctx = g.ctx;
    // Retry buffer decodes ONLY after the context is running — iOS rejects
    // decodeAudioData while suspended (the scene-load decodes failed there).
    ctx.resume().then(() => {
      traceResume(ctx, before, 'resolved');
      retryFailedAudioDecodes();
      // A stream re-kicked below, while the context was still interrupted, MAY be refused or
      // re-paused by WebKit (modelled, not observed on a device); kick again once it is running.
      resumeActiveMedia();
    }).catch((err: unknown) => {
      // ⚠️ Recorded AND logged, where it used to be swallowed entirely. A rejected resume is the
      // one outcome that leaves the app silent with nothing of ours having noticed, and the bare
      // `catch {}` here is why #1455 could not be diagnosed from a report. A later gesture still
      // retries — this does not change the recovery, only whether it is visible.
      // Warn only when the trace actually recorded — otherwise a context that refuses every
      // attempt writes a console line on every tap, for the life of the session.
      if (traceResume(ctx, before, 'rejected')) {
        console.warn('[audio] resume() rejected — the context stays', ctx.state, err);
      }
    });
  } else {
    traceResume(g?.ctx, before, !g ? 'no-graph' : before === 'closed' ? 'skipped-closed' : 'skipped-running');
    retryFailedAudioDecodes();
  }
  resumeActiveMedia();
}

/** Snapshot every live STREAM's liveness. Buffer voices report `null` and are dropped — they have
 *  no playhead to read back, and a streamed bed is what these failures are about. */
function snapshotStreams(): AudioStreamHealth[] {
  const out: AudioStreamHealth[] = [];
  for (const h of active) {
    const s = h.streamHealth();
    if (s) out.push(s);
  }
  return out;
}

/** ⚠️ **`collapseRepeat`, and it is load-bearing.** `resume()` runs on EVERY `pointerdown`, so a
 *  healthy app writes `skipped-running` on every tap — 32 taps would evict every `foreground` and
 *  `statechange` entry from the ring, leaving a trace that records only that the player was
 *  tapping. A stuck context refusing every attempt does the same with `rejected`, plus a console
 *  line each time. Collapsing a run of identical outcomes keeps the TRANSITIONS, which is all this
 *  is for, and costs nothing when outcomes alternate.
 *
 *  Returns whether an entry was actually written, so the caller's log line collapses with it. */
function traceResume(ctx: AudioContext | undefined, before: string, outcome: AudioResumeOutcome): boolean {
  return recordAudioHealth({
    kind: 'resume', state: before, stateAfter: ctx?.state, outcome,
    ctxTime: ctx?.currentTime, streams: snapshotStreams(),
  }, { collapseRepeat: true });
}

/** Record that the app has come back to the foreground, after `backgroundedMs` away (`null` when
 *  no preceding hide was seen — a boot-time or gesture-driven foreground).
 *
 *  ⚠️ Call this BEFORE `resume()`, not after: the whole value of the entry is `ctx.state` as the OS
 *  left it. Called after the recovery it would read `running` every time and say nothing.
 *
 *  The duration is the app layer's to measure — `runtime/**` sees no foreground event — so it is a
 *  parameter rather than something this module tracks. `engine/app/useAudioResumeRearm.ts` is the
 *  caller; it is also what dedupes the two events iOS fires for one transition, and
 *  `tests/app/audioResumeRearm.test.tsx` pins that. */
export function noteForeground(backgroundedMs: number | null): void {
  if (recording()) return;
  const ctx = graphOrNull()?.ctx;
  recordAudioHealth({
    kind: 'foreground', state: ctx ? ctx.state : 'no-context',
    backgroundedMs, ctxTime: ctx?.currentTime, streams: snapshotStreams(),
  });
  // The foreground half of the #1455 detection: the caller's `resume()` follows this call, and the
  // check samples after it settles. Only for a context that was RUNNING when the app hid — a
  // never-unlocked one would read as dead — and never under an ad, whose release owns its check.
  const wasRunning = runningAtHide;
  runningAtHide = false;
  if (ctx && wasRunning && !adHold) {
    cancelClockCheck();
    scheduleClockCheck(ctx, false, 'foreground');
  }
}

/** Record that the app is going to the background — the other half of `noteForeground`. Called by
 *  the app shell on the FIRST hide of a transition. Traced, so a foreground that ran no check can be
 *  told apart from one whose check found nothing (#1455 re-review 3). */
export function noteBackground(): void {
  if (recording()) return;
  const ctx = graph?.ctx;
  runningAtHide = !adHold && ctx?.state === 'running';
  recordAudioHealth({ kind: 'background', state: ctx ? ctx.state : 'no-context', ctxTime: ctx?.currentTime, streams: snapshotStreams() });
}

/** Is the audio STILL dead — `running` with a clock that does not advance across `windowMs`? The
 *  dead-audio reload asks this right before reloading: while it waited out a reload blocker the
 *  audio may have recovered on its own (a lock/wake, WebKit's auto-resume). */
export function isAudioStillDead(windowMs: number = CLOCK_WINDOW_MS): Promise<boolean> {
  const ctx = graph?.ctx;
  if (!ctx || ctx.state !== 'running') return Promise.resolve(false);
  const t0 = ctx.currentTime;
  return new Promise((resolve) => {
    setTimeout(() => resolve(ctx.state === 'running' && ctx.currentTime - t0 < CLOCK_FROZEN_EPSILON_S), windowMs);
  });
}

/** Whether the context needs a `resume()` — anything but running or closed. Typed as a string
 *  because `'interrupted'` is not in lib.dom's `AudioContextState`. */
function needsResume(ctx: AudioContext): boolean {
  const state: string = ctx.state;
  return state !== 'running' && state !== 'closed';
}

function resumeActiveMedia(): void {
  if (adHold) return;
  for (const h of active) h.resumeMedia();
}

/** How long after a release to let the resume settle before the first clock sample, and how long
 *  the sample window is. Mechanism, not feel: long enough that a running clock visibly moves. */
const CLOCK_SETTLE_MS = 300;
const CLOCK_WINDOW_MS = 700;
/** Below this many seconds advanced across the window, the clock counts as frozen. */
const CLOCK_FROZEN_EPSILON_S = 0.05;
let clockCheckTimer: ReturnType<typeof setTimeout> | null = null;
/** Invalidated by every cancel: a retry's promise chain settling later must not schedule into a
 *  newer check, or after a dispose (#1455 review — its `finally` used to overwrite the live timer). */
const clockCheckLife = createTeardownToken();
/** The hold's own `suspend()`. ⚠️ `ctx.state` does not read `suspended` until it SETTLES, so a
 *  release landing first (an SDK refusing the show within a bridge round-trip) saw `running`,
 *  skipped the resume — and then the suspend landed, leaving the audio off with nothing traced
 *  (#1455 review, reproduced against the fake). The release chains its resume after this. */
let holdSuspend: Promise<void> | null = null;
/** Was the context RUNNING when the ad took it? Only then is a non-advancing clock after the
 *  release evidence of the #1455 freeze; a context that was never unlocked (an app-open ad before
 *  the first tap) or already interrupted would read as the freeze and warn falsely (#1455 re-review). */
let heldWhileRunning = false;
/** A release's resume is still settling (set by the release, cleared at the check's first sample).
 *  A back-to-back ad holding in that window reads `suspended` and would skip its check (#1455
 *  re-review 2) — it counts as running. */
let releaseResumeInFlight = false;
/** Was the context running when the app went to the background? Only then is a frozen clock after
 *  the foreground the #1455 death rather than a context that was never unlocked. */
let runningAtHide = false;

/** Is a fullscreen ad holding the audio right now? The cue bus drops one-shots while it is. */
export function isAudioHeldForAd(): boolean { return adHold; }

/** What the clock check was checking after. */
export type AudioClockCheckAfter = 'ad' | 'foreground';

const audioDeadListeners = new Set<(after: AudioClockCheckAfter) => void>();

/**
 * Hear the engine declare the page's audio DEAD (#1455): after an ad or a foreground, the context's
 * clock did not advance, and still did not after one suspend→resume retry.
 *
 * Measured on the iPhone Air (2026-09-23, Apple Music took the session while the game was away):
 * in that state NOTHING in the page recovers it — not a resume, not a fresh `AudioContext`, not
 * either of those inside a real user gesture. A page RELOAD does, and so does a screen lock/wake.
 * The app shell's `useDeadAudioReload` turns this into a reload for projects that opt in
 * (`runtime.reloadOnDeadAudio`). Returns the unsubscribe.
 */
export function onAudioDead(fn: (after: AudioClockCheckAfter) => void): () => void {
  audioDeadListeners.add(fn);
  return () => { audioDeadListeners.delete(fn); };
}

function cancelClockCheck(): void {
  if (clockCheckTimer !== null) clearTimeout(clockCheckTimer);
  clockCheckTimer = null;
  clockCheckLife.invalidateAll();
}

/**
 * A fullscreen ad went up (`true`) or came down (`false`) — wired from the ad lifecycle by the app
 * shell (`engine/app/useAudioResumeRearm.ts`, via `onFullscreenAdChange`).
 *
 * **Why (#1455):** the engine used to do nothing here, so our music played under every ad, and on
 * the iPhone Air an interstitial left the context reporting `running` with its clock frozen — all
 * audio gone for the rest of the realm. Google's guidance for an app with its own audio is to pause
 * it for the ad and resume after. So:
 *  - **hold:** pause every stream where it is (the bed resumes from the same place, not silently
 *    running on under the ad) and suspend the context. While held, `resume()` and every media
 *    re-kick stand down — the taps and foreground edges the ad's view causes must not undo it.
 *  - **release:** `resume()` as usual, then CHECK THE CLOCK. A context can claim `running` and not
 *    render, which no state check sees; a frozen clock gets one suspend→resume retry, and both
 *    samples go in the health trace. ⚠️ Whether that retry revives a dead device is UNKNOWN
 *    (on the Air a plain resume did not) — the check's job is first to make the failure visible.
 */
export function holdForFullscreenAd(held: boolean): void {
  if (held === adHold) return;
  adHold = held;
  if (recording()) return;
  cancelClockCheck();
  const ctx = graph?.ctx;
  recordAudioHealth({
    kind: held ? 'ad-hold' : 'ad-release', state: ctx ? ctx.state : 'no-context',
    ctxTime: ctx?.currentTime, streams: snapshotStreams(),
  });
  if (held) {
    for (const h of active) h.holdMedia();
    heldWhileRunning = (!!ctx && ctx.state === 'running') || releaseResumeInFlight;
    releaseResumeInFlight = false;
    // No graph yet = nothing playing; do not create a context just to suspend it.
    // ⚠️ Suspend whenever the context is not CLOSED — not only when it reads `running`. A resume
    // still in flight (a tap's, or the previous ad's release) reads `suspended`/`interrupted` until
    // it settles, and skipping the suspend then let it land under THIS ad (#1455 re-review). A
    // suspend queued behind a pending resume is ordered after it.
    if (ctx && ctx.state !== 'closed') {
      const p = ctx.suspend().catch((e: unknown) => console.warn('[audio] suspend for a fullscreen ad failed:', e));
      holdSuspend = p;
      // Once it has landed there is nothing to wait for: a release after that resumes at once, and
      // a dispose in the same tick cannot swallow it (#1455 re-review 2).
      void p.then(() => { if (holdSuspend === p) holdSuspend = null; });
    }
    return;
  }
  const pendingSuspend = holdSuspend;
  holdSuspend = null;
  const check = heldWhileRunning && ctx ? ctx : null;
  const afterRelease = () => {
    resume();
    // Started AFTER the resume, so a slow hold-suspend cannot eat the sample window.
    if (check) {
      releaseResumeInFlight = true;
      scheduleClockCheck(check, false, 'ad');
    }
  };
  if (pendingSuspend) {
    // Resume only once our own suspend has landed — see `holdSuspend`. A new hold, or a dispose,
    // in between wins (both invalidate the token).
    const live = clockCheckLife.capture();
    void pendingSuspend.then(() => {
      if (adHold || !live()) return;
      afterRelease();
    });
  } else {
    afterRelease();
  }
}

function scheduleClockCheck(ctx: AudioContext, retried: boolean, after: AudioClockCheckAfter): void {
  const alive = clockCheckLife.capture();
  clockCheckTimer = setTimeout(() => {
    releaseResumeInFlight = false;
    const t0 = ctx.currentTime;
    clockCheckTimer = setTimeout(() => {
      clockCheckTimer = null;
      // Hidden = the OS may have paused it legitimately; the foreground re-arm owns that case. A
      // new hold cancelled this timer already.
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (adHold || hidden) return;
      const advanced = ctx.currentTime - t0;
      // Recorded in EVERY visible state, not only `running`: a release whose resume was rejected
      // ("Failed to start the audio device") leaves the context `suspended`, and that is the same
      // dead-after-an-ad failure wearing another state.
      recordAudioHealth({
        kind: 'clock-check', state: ctx.state, ctxTime: ctx.currentTime, advanced, retried, after,
        streams: snapshotStreams(),
      });
      if (ctx.state === 'running' && advanced >= CLOCK_FROZEN_EPSILON_S) return;
      console.warn(`[audio] audio clock not advancing after ${after === 'ad' ? 'an ad' : 'a foreground'} (state ${ctx.state})${retried ? ', after a retry' : ''}`);
      if (retried) {
        // DEAD only in the MEASURED signature: `running` with a frozen clock. A context still
        // `interrupted`/`suspended` after the retry may be held by a live call, Siri or an alarm —
        // a reload cannot help that, and the next tap or WebKit's own auto-resume will (#1428) —
        // so it stays a trace entry and nothing else (#1455 re-review 3).
        if (ctx.state === 'running') {
          recordAudioHealth({ kind: 'audio-dead', state: ctx.state, ctxTime: ctx.currentTime, after, streams: snapshotStreams() });
          notifyListeners(audioDeadListeners, 'audioService:audioDead', [after]);
        }
        return;
      }
      const live = () => !adHold && alive();
      (ctx.state === 'running' ? ctx.suspend() : Promise.resolve())
        // Never bring the context up under a NEW ad that arrived mid-retry.
        .then(() => (live() ? ctx.resume() : undefined))
        .then(() => { if (live()) resumeActiveMedia(); })
        .catch((e: unknown) => console.warn('[audio] resume retry after a frozen clock failed:', e))
        .finally(() => { if (live()) scheduleClockCheck(ctx, true, after); });
    }, CLOCK_WINDOW_MS);
  }, CLOCK_SETTLE_MS);
}

/** A copy of every bus's last-set volume (0..1). Read by the editor's preview envelope, which puts
 *  back what a ▶ preview's `audio.setBusVolume` changed (#1551). */
export function getBusVolumes(): Record<BusName, number> {
  return { ...busVolumes };
}

/** Set a bus's volume. Returns whether the bus was ACCEPTED — `false` means nothing was written,
 *  and a caller mirroring the volume anywhere else (the `audio.setBusVolume` action's mixer store)
 *  must take this answer rather than re-deciding it: a second copy of the rule is how the store
 *  and the mixer came to disagree (#1074). */
export function setBusVolume(bus: BusName, volume: number): boolean {
  // ⚠️ REFUSE an unknown bus, and do it before the write. This line is #986's WRITE half and
  // `busNode` below is #993's read half, and both arrive on the same agent action
  // (`actions/audioControls.ts`, whose `bus` param is an unchecked document string — and whose
  // store write used to run BEFORE this refusal, #1074). `bus: "__proto__"` hits `Object.prototype`'s setter, so the value is lost
  // silently with no own key created; `bus: "constructor"` then made `busNode(…).gain.value`
  // throw. One rejection covers both, and keeps a refused op out of the record log.
  //
  // ⚠️ Refuse here, FALL BACK in `resolveBus` — deliberately different, because the operations
  // differ. A typo'd bus on the playback path should still make a sound; a typo'd bus here names
  // nothing to set, and silently moving the volume of `sfx` instead would be a worse answer than
  // saying so.
  if (!hasDocKey(busVolumes, bus)) {
    warnVocabOnce('audio', 'setBusVolume bus', bus, 'ignored (no such bus)');
    return false;
  }
  busVolumes[bus] = volume;
  if (recording()) { log.push({ op: 'setBusVolume', bus, volume }); return true; }
  const g = graphOrNull();
  if (g) busNode(g, bus).gain.value = volume;
  return true;
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
      // ⚠️ The RESOLVED bus, not the authored one (#993 close-out § 2d). CLAUDE.md makes the
      // journal/record log the sanctioned headless observable, so a log saying `bus: "Music"` for
      // a voice the live graph routes to `sfx` makes the harness disagree with the behaviour it
      // exists to verify. The typo is not lost — `resolveBus` warns it by name.
      op: 'play', clip: spec.clip, bus: resolveBus(spec.bus),
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
  cancelClockCheck();
  // Per-graph detection state: a release + dispose in one tick (realm shutdown) must not leave a
  // stale flag that makes the NEXT ad check a never-running context (#1455 re-review 3). `adHold`
  // stays — it mirrors the ad lifecycle, not this graph.
  releaseResumeInFlight = false;
  runningAtHide = false;
  heldWhileRunning = false;
  graph = null;
}

class LiveHandle implements AudioHandle {
  ended = false;
  private deliberatelyPaused = false;
  /** Whether this source's last play attempt was refused — so a wedged bed records ONE trace entry
   *  per episode rather than one per tap. Cleared by the first success. */
  private playRefused = false;
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
    tail.connect(busNode(g, resolveBus(spec.bus)));

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
      // ⚠️ Deliberately NOT routed through `kick()` — this one refusal is ROUTINE, not a symptom.
      // On iOS every bed start before the first gesture is refused by the autoplay policy, and a
      // shuffle playlist mints a fresh handle per clip, so tracing it would write an entry every
      // few minutes forever and evict the foreground entries the trace exists for. The re-kick
      // that follows IS traced, and that is the one that means something.
      // Under a fullscreen ad the element is left paused (not deliberately), and the release's
      // re-kick starts it from the top — it must not run on under the ad (#1455 review).
      if (!adHold) el.play().catch(() => { /* gesture-gated; resume() will unlock */ });
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
    if (this.mediaEl) this.kick('unpause');
  }

  /** Play the element, and RECORD a refusal instead of swallowing it (#1455 close-out sweep).
   *
   *  A refused `play()` is the other half of a lost bed: the context can come back `running` while
   *  the element stays silent, and a context-only trace cannot tell that apart from a healthy
   *  recovery. The rejection still does not propagate — a later gesture retries, exactly as before.
   *
   *  ⚠️ **At most one entry per stuck episode, not one per attempt.** `resumeActiveMedia()` runs on
   *  every `resume()`, which fires on every pointerdown — so a bed that is wedged would otherwise
   *  write an entry per tap and evict the foreground entries this trace exists for, from a ring
   *  that only holds 32. The flag clears on the first success, so a NEW episode records again. */
  private kick(reason: AudioKickReason): void {
    const el = this.mediaEl;
    // Held by an ad: stay paused, NOT deliberately — the release's re-kick picks it up.
    if (!el || adHold) return;
    el.play().then(
      () => { this.playRefused = false; },
      () => {
        if (this.playRefused) return;
        this.playRefused = true;
        const s = this.streamHealth();
        recordAudioHealth({
          kind: 'play-refused', state: this.ctx.state, reason,
          ctxTime: this.ctx.currentTime, streams: s ? [s] : [],
        });
      },
    );
  }

  /** Re-kick a streaming element whose autoplay was gesture-blocked (called from
   *  resume() on the first user gesture). No-op for buffer sources / finished handles. */
  /** A fullscreen ad took over (#1455): pause a playing stream WITHOUT marking it deliberately
   *  paused, so the release's re-kick (`resumeMedia`) picks it up from the same place. */
  holdMedia(): void {
    if (this.ended || !this.mediaEl || this.mediaEl.paused) return;
    this.mediaEl.pause();
  }

  resumeMedia(): void {
    // Don't un-pause a source the game deliberately paused — only re-kick one whose
    // autoplay was gesture-blocked.
    if (this.ended || this.deliberatelyPaused || !this.mediaEl || !this.mediaEl.paused) return;
    this.kick('re-kick');
  }

  /** This voice's liveness for the audio-health trace, or `null` when it has nothing readable to
   *  report — a buffer source (no playhead to read back) or a finished handle.
   *
   *  ⚠️ Reports `deliberatelyPaused` deliberately: without it a bed the GAME paused and a bed the
   *  OS silently killed are the same two fields, and the whole point of the trace is telling those
   *  apart after the fact. */
  streamHealth(): AudioStreamHealth | null {
    const el = this.mediaEl;
    if (this.ended || !el) return null;
    return {
      paused: el.paused,
      currentTime: el.currentTime,
      duration: Number.isFinite(el.duration) ? el.duration : null,
      readyState: el.readyState,
      error: el.error ? el.error.code : null,
      deliberatelyPaused: this.deliberatelyPaused,
    };
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
