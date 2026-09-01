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
  /** #433: live-applied, like `setMuted`/`setRate` — a game (or the Inspector) toggling
   *  `VideoPlayer.loop` takes effect on the running element immediately. */
  setLoop(loop: boolean): void;
  /** #433: live-applied. Changes `effectiveRate()`, so this reapplies the rate immediately
   *  rather than waiting for the next `applyTimeScale` call to notice. */
  setTimeMode(mode: VideoTimeMode): void;
  readonly ended: boolean;
  readonly timeMode: VideoTimeMode;
  /** #431: true only once playback is OBSERVED running — `!paused && !blocked && !ended`.
   *  Deliberately excludes `readyState` (jsdom reports 0 always, which would make this
   *  unreachable in tests, and a real element that hasn't buffered a frame yet still counts
   *  as "playing" for this contract's purposes: it is not autoplay-blocked and not paused). */
  readonly playing: boolean;
  /** True when the last `play()` request was refused (autoplay policy, almost always) and the
   *  clip is waiting for a gesture. Distinct from `paused`: the game ASKED for playback and did
   *  not get it. `videoSystem` reports this once per refused play REQUEST — see `@video.blocked`. */
  readonly autoplayBlocked: boolean;
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
  // Not `readonly`: #433 makes `timeMode` live-appliable via `setTimeMode`. The interface's
  // own `timeMode` stays `readonly` — nothing outside this class reassigns it directly.
  timeMode: VideoTimeMode;
  /** Set by the element's `ended` EVENT. Never read directly — see the `ended` getter. */
  private endedEvent = false;

  /** Has this clip finished?
   *
   *  ⚠️ Derived from the ELEMENT's own state as well as the event, because the event alone is
   *  not trustworthy enough to hang "stop playing" on. Measured on an iPhone 8: exactly ONE
   *  `@video.start`, never an `@video.end`, and a non-looping backdrop restarting every 8s
   *  forever. The element had `loop:false` and was mid-playback every time it was sampled.
   *
   *  The mechanism is a race the slow device loses. `videoSystem` reconciles every frame and
   *  calls `play()` while `playing` is true; per spec, `play()` when the playback position is
   *  the end SEEKS BACK TO THE START. So a frame that lands while the element sits at its end,
   *  before `ended` has dispatched, rewinds it — and `ended` then never fires at all, because
   *  the element is no longer at the end. A desktop browser dispatches in time and looks fine.
   *
   *  `HTMLMediaElement.ended` is a plain spec property with no event timing to lose, so reading
   *  it closes the window. `attemptPlay` refusing to re-play a running element closes the other
   *  half — either fix alone is sufficient; both are correct independently. */
  get ended(): boolean {
    if (this.endedEvent) return true;
    return !this.element.loop && this.element.ended;
  }
  /** #431: see the interface doc. Read by `videoSystem` BEFORE it calls `play()` each pass —
   *  see that call site for why the ordering matters. */
  get playing(): boolean {
    return !this.element.paused && !this.blocked && !this.ended;
  }
  /** True when the last `play()` request was refused (autoplay policy, almost always) and the
   *  clip is waiting for a gesture. Distinct from `paused`: the game ASKED for playback and did
   *  not get it. `videoSystem` reports this once per refused play REQUEST — see `@video.blocked`. */
  get autoplayBlocked(): boolean { return this.blocked && !this.disposed; }
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
      this.endedEvent = true;
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
    // Already running → do nothing. `videoSystem` calls play() EVERY FRAME while the trait says
    // `playing`, and play() is not the harmless no-op it looks like: at the end of a clip it
    // rewinds (see the `ended` getter). Re-playing a running element buys nothing in any case.
    if (!this.element.paused) { this.blocked = false; return Promise.resolve(); }
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
    // Time-stopped (e.g. a pause menu): don't start a blocked clip (and its audio) under
    // it. The retry comes from `applyTimeScale`, which calls this again on the next
    // timeScale TRANSITION — NOT from `applyRate`, whose resume path excludes a blocked
    // clip on purpose (it runs per frame via videoSystem's setRate/setTimeMode).
    if (this.effectiveRate() <= 0) return;
    void this.attemptPlay();
  }

  seek(seconds: number): void {
    if (this.disposed) return;
    // Clamp: assigning a negative or past-the-end currentTime throws in some engines.
    const dur = Number.isFinite(this.element.duration) ? this.element.duration : undefined;
    const t = Math.max(0, dur != null ? Math.min(seconds, dur) : seconds);
    try { this.element.currentTime = t; } catch { /* not seekable yet */ }
    // Only the EVENT flag needs clearing — `element.ended` clears itself once the position moves
    // back off the end, which is exactly the property that makes the getter above trustworthy.
    if (t < (dur ?? Infinity)) this.endedEvent = false;
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

  setLoop(loop: boolean): void {
    if (this.disposed) return;
    this.element.loop = loop;
    // Turning loop ON must un-strand a clip that already ended: the `ended` getter's own
    // `!element.loop &&` term already treats a looping element as never ended, but
    // `endedEvent` (latched by the element's `ended` DOM event, cleared only by `seek()`) is
    // OR'd in ahead of that term and stays set regardless of `loop`. Left set, `ended` reads
    // true forever, and `play()`'s `if (this.ended) return;` refuses to ever resume it — a
    // clip that is live-applied `loop:true` but never plays again. Clearing it here makes the
    // flag agree with the getter: a looping element cannot be "ended".
    if (loop) this.endedEvent = false;
  }

  setTimeMode(mode: VideoTimeMode): void {
    this.timeMode = mode;
    // `effectiveRate()` depends on `timeMode` — reapply now, or the change is invisible
    // until the next `applyTimeScale` call happens to run.
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

/** Multiplier (0..1) applied to a clip's volume so it fades out over the LAST
 *  `fadeOutSec` seconds. Pure, so the ramp is testable without a media element.
 *
 *  Returns 1 whenever the fade cannot be computed — no fade asked for, a duration the
 *  element has not reported yet (`NaN` before metadata loads, `Infinity` on a live
 *  stream), or a clip shorter than the fade. Silence is the failure that would be
 *  noticed and blamed on the engine; a missed fade is not. A fade longer than the clip
 *  is CLAMPED to the clip rather than refused, so it starts at t=0 and still lands on 0.
 *
 *  Linear in amplitude on purpose. An 8-second beach loop is ambience, and an
 *  equal-power curve holds it near full volume for most of the ramp — which is exactly
 *  what "it should fade as the video ends" is asking not to happen. */
export function videoFadeGain(currentTime: number, duration: number, fadeOutSec: number): number {
  if (!(fadeOutSec > 0)) return 1;
  if (!Number.isFinite(duration) || duration <= 0) return 1;
  const fade = Math.min(fadeOutSec, duration);
  const remaining = duration - currentTime;
  if (!Number.isFinite(remaining)) return 1;
  if (remaining <= 0) return 0;
  if (remaining >= fade) return 1;
  return remaining / fade;
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
  for (const h of live) {
    h.applyRate();
    // #545: a clip that was gesture-unlocked DURING a time-stop refused to start then
    // (retryBlockedPlay's effectiveRate guard) and is still carrying `blocked`. Nothing
    // else is guaranteed to retry it — a second gesture may never come — so a timeScale
    // TRANSITION is where it gets its retry. Safe to call unconditionally: retryBlockedPlay
    // self-guards on disposed/blocked/deliberatelyPaused/ended and on the rate still being 0.
    h.retryBlockedPlay();
  }
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
