/** Video playback core — the engine's owner of `HTMLVideoElement` lifetime.
 *
 *  One handle per playing clip. The handle owns the element (create → play/pause/
 *  seek/rate → dispose); the AUDIO subsystem owns its sound, routed onto the normal
 *  bus so a cutscene respects the player's volume/mute settings instead of escaping
 *  the mix (see `attachMediaElementToBus`).
 *
 *  ## Why video is not deterministic, and what that means
 *
 *  A media element runs on the BROWSER's clock, not the engine's. `play`/`pause`/
 *  `seek`/`playbackRate` are all controllable — a game absolutely can start a clip on
 *  a button press — but a video CANNOT be advanced by an exact `dt` per frame:
 *  assigning `currentTime` is a SEEK, which on H.264 decodes from the nearest
 *  keyframe, resolves asynchronously, and stutters. So video cannot participate in
 *  `stepSimulation`, and is quarantined from the determinism harness exactly as audio
 *  is, for exactly the same reason.
 *
 *  What it DOES honour is `timeScale`, via `playbackRate` — see `applyTimeScale`.
 *
 *  ## Autoplay
 *
 *  Only the first AUDIBLE playback needs a prior user gesture; muted video autoplays
 *  everywhere. A blocked `play()` is not an error — the handle records it and retries
 *  on the first gesture, reusing the audio subsystem's unlock signal so there is one
 *  definition of "the user has interacted". */

import { attachMediaElementToBus, onGestureUnlock } from '../audio/audioService';
import type { BusName } from '../audio/audioService';

/** How a clip's rate should follow the engine's `timeScale`.
 *
 *  - `diegetic` — the video exists IN the world (a screen on a wall), so time-control
 *    should affect it like anything else: slow-mo slows it, a time-stop freezes it.
 *  - `presentation` — the video IS the presentation layer (a fullscreen cutscene).
 *    A time-stop still pauses it (the game is paused; so is the movie), but slow-mo
 *    does NOT drag it, because stretching dialogue to 0.3× is not what "slow motion"
 *    is asking for.
 *
 *  This distinction is a FEEL call, flagged as such in the plan — if it turns out
 *  wrong, this enum is the single place to change it. */
export type VideoTimeMode = 'diegetic' | 'presentation';

export interface VideoPlaySpec {
  /** Resolved URL of the clip to play (already variant/cache-resolved by the caller). */
  url: string;
  loop?: boolean;
  /** Start muted. A muted clip is exempt from the autoplay gesture requirement. */
  muted?: boolean;
  volume?: number;
  bus?: BusName;
  timeMode?: VideoTimeMode;
  /** Play as soon as it can (subject to autoplay policy). Default true. */
  autoplay?: boolean;
  /** Called when a non-looping clip reaches its end. */
  onEnded?: () => void;
  /** Called when the element errors (bad URL, unsupported codec, network loss). */
  onError?: (message: string) => void;
}

export interface VideoHandle {
  /** The element itself — needed by the texture surfaces, which upload its frames. */
  readonly element: HTMLVideoElement;
  play(): void;
  pause(): void;
  /** Seek in seconds. Async by nature; the picture updates when the decoder catches up. */
  seek(seconds: number): void;
  setVolume(v: number): void;
  setMuted(muted: boolean): void;
  /** Base rate, BEFORE timeScale. `applyTimeScale` multiplies onto this. */
  setRate(rate: number): void;
  readonly ended: boolean;
  readonly timeMode: VideoTimeMode;
  dispose(): void;
}

/** Every live handle, so timeScale + gesture-unlock can sweep them. */
const live = new Set<LiveVideoHandle>();

/** Registered once, lazily — the unlock listener outlives individual handles. */
let unregisterUnlock: (() => void) | null = null;

function ensureUnlockHook(): void {
  if (unregisterUnlock) return;
  unregisterUnlock = onGestureUnlock(() => {
    for (const h of live) h.retryBlockedPlay();
  });
}

/** Last applied engine timeScale, so a handle created mid-slow-mo starts correct
 *  rather than at 1× until the next `applyTimeScale` call. */
let currentTimeScale = 1;

class LiveVideoHandle implements VideoHandle {
  readonly element: HTMLVideoElement;
  readonly timeMode: VideoTimeMode;
  ended = false;
  /** Base rate the game asked for, before timeScale is folded in. */
  private baseRate = 1;
  /** True when a `play()` was rejected by the autoplay policy and is awaiting a gesture. */
  private blocked = false;
  /** True when the GAME paused it — a gesture retry must not un-pause that. */
  private deliberatelyPaused = false;
  /** True once playback has been asked for at least once. `applyRate` RESUMES a clip
   *  that was already running before a time-stop; it must never START one that never
   *  played, or construction would fire play() twice (once from applyRate, once from
   *  the autoplay branch) and a `autoplay: false` clip would start itself the first
   *  time the timeScale changed. */
  private started = false;
  private busRoute: { setVolume(v: number): void; detach(): void } | null = null;
  private disposed = false;

  constructor(spec: VideoPlaySpec) {
    const el = document.createElement('video');
    el.src = spec.url;
    el.loop = !!spec.loop;
    el.muted = !!spec.muted;
    el.volume = spec.volume ?? 1;
    // Required for iOS: without `playsInline` the WKWebView hijacks playback into
    // its native fullscreen player, which destroys a video TEXTURE outright (there
    // are no frames to sample) and takes over the screen for a 2D sprite.
    el.playsInline = true;
    // `anonymous` is what makes a cross-origin clip usable as a WebGL/WebGPU texture.
    // Without it the canvas is tainted and the upload throws a security error — the
    // remote-delivery path would work for a <video> tag and fail for a texture.
    el.crossOrigin = 'anonymous';
    // Hint the browser to start buffering without us calling play() — matters for
    // stream-policy clips, where time-to-first-frame is the whole point.
    el.preload = 'auto';
    this.element = el;
    this.timeMode = spec.timeMode ?? 'diegetic';

    el.addEventListener('ended', () => {
      if (el.loop) return;
      this.ended = true;
      spec.onEnded?.();
    });
    el.addEventListener('error', () => {
      const code = el.error?.code;
      spec.onError?.(`video error${code != null ? ` (code ${code})` : ''}: ${spec.url}`);
    });

    // Route sound onto the bus. Null (no audio graph) is NOT a failure — the element
    // still plays, just unrouted. Video must never depend on audio being up.
    this.busRoute = attachMediaElementToBus(el, spec.bus ?? 'sfx', spec.volume ?? 1);

    live.add(this);
    ensureUnlockHook();
    this.applyRate();
    if (spec.autoplay !== false) this.play();
  }

  /** Effective rate = the game's base rate × timeScale, with `presentation` clips
   *  exempt from slow-mo but NOT from a time-stop. */
  private effectiveRate(): number {
    if (currentTimeScale === 0) return 0;
    return this.timeMode === 'presentation' ? this.baseRate : this.baseRate * currentTimeScale;
  }

  /** Push the effective rate onto the element. A rate of 0 is not a legal
   *  `playbackRate` (it throws in some browsers), so a time-stop PAUSES instead —
   *  which is also the semantically right thing. */
  applyRate(): void {
    if (this.disposed) return;
    const rate = this.effectiveRate();
    if (rate <= 0) {
      if (!this.element.paused) this.element.pause();
      return;
    }
    try { this.element.playbackRate = rate; } catch { /* out-of-range rate — keep the old one */ }
    // Coming out of a time-stop: resume a clip that WAS running. `started` is what
    // keeps this from starting one that never played (see the field's comment).
    if (this.started && this.element.paused && !this.deliberatelyPaused && !this.ended && !this.blocked) {
      void this.attemptPlay();
    }
  }

  private attemptPlay(): Promise<void> {
    const p = this.element.play();
    // Older engines return undefined rather than a promise.
    if (!p || typeof p.catch !== 'function') { this.blocked = false; return Promise.resolve(); }
    return p.then(() => { this.blocked = false; }).catch(() => {
      // Autoplay policy, almost always. Not an error — wait for a gesture.
      this.blocked = true;
    });
  }

  play(): void {
    if (this.disposed || this.ended) return;
    this.deliberatelyPaused = false;
    this.started = true;
    if (this.effectiveRate() <= 0) return; // time-stopped; applyRate resumes it later
    void this.attemptPlay();
  }

  pause(): void {
    if (this.disposed) return;
    this.deliberatelyPaused = true;
    this.element.pause();
  }

  /** Re-kick a play() the autoplay policy rejected. No-op for a clip the game paused
   *  deliberately — a gesture must not override the game's intent. */
  retryBlockedPlay(): void {
    if (this.disposed || !this.blocked || this.deliberatelyPaused || this.ended) return;
    void this.attemptPlay();
  }

  seek(seconds: number): void {
    if (this.disposed) return;
    // Clamp: assigning a negative or past-the-end currentTime throws in some engines.
    const dur = Number.isFinite(this.element.duration) ? this.element.duration : undefined;
    const t = Math.max(0, dur != null ? Math.min(seconds, dur) : seconds);
    try { this.element.currentTime = t; } catch { /* not seekable yet */ }
    if (this.ended && t < (dur ?? Infinity)) this.ended = false;
  }

  setVolume(v: number): void {
    if (this.disposed) return;
    this.element.volume = v;
    this.busRoute?.setVolume(v);
  }

  setMuted(muted: boolean): void {
    if (!this.disposed) this.element.muted = muted;
  }

  setRate(rate: number): void {
    this.baseRate = rate;
    this.applyRate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    live.delete(this);
    try { this.element.pause(); } catch { /* noop */ }
    this.busRoute?.detach();
    this.busRoute = null;
    // Release the decoder + any buffered data. Clearing src alone is not enough on
    // some engines; load() after it is what actually drops the buffer.
    try {
      this.element.removeAttribute('src');
      this.element.load();
    } catch { /* noop */ }
  }
}

/** Create and (by default) start a video handle. */
export function playVideo(spec: VideoPlaySpec): VideoHandle {
  return new LiveVideoHandle(spec);
}

/** Push the engine's current `timeScale` onto every live clip. Called once per frame
 *  by the video system. `diegetic` clips scale with it; `presentation` clips only
 *  respond to a full stop (see VideoTimeMode). */
export function applyTimeScale(timeScale: number): void {
  if (timeScale === currentTimeScale) return;
  currentTimeScale = timeScale;
  for (const h of live) h.applyRate();
}

/** Stop and release every live clip (scene teardown / Stop). */
export function disposeAllVideo(): void {
  for (const h of [...live]) h.dispose();
  live.clear();
}

/** Test/inspection hook — how many clips are live. */
export function liveVideoCount(): number { return live.size; }

/** Test hook — reset module state between tests. */
export function __resetVideoService(): void {
  disposeAllVideo();
  currentTimeScale = 1;
  unregisterUnlock?.();
  unregisterUnlock = null;
}
