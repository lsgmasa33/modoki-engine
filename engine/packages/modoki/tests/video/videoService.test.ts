// @vitest-environment jsdom

/** Video playback core — timeScale coupling, autoplay-block recovery, and the two
 *  element flags whose absence breaks video silently on iOS / as a texture.
 *
 *  jsdom implements neither `play()` nor `pause()` on HTMLMediaElement, so both are
 *  stubbed. That is fine for what these assert: this suite is about the engine's
 *  decision-making (what rate, play or not, retry or not), not the browser's decoder. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  playVideo, applyTimeScale, disposeAllVideo, liveVideoCount, __resetVideoService,
} from '../../src/runtime/video/videoService';
import { resume as audioResume } from '../../src/runtime/audio/audioService';

/** Resolve/reject the next play() — models the autoplay policy. */
let playBehaviour: 'allow' | 'block' = 'allow';
let playCalls = 0;

beforeEach(() => {
  playBehaviour = 'allow';
  playCalls = 0;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    playCalls++;
    if (playBehaviour === 'block') return Promise.reject(new Error('NotAllowedError'));
    // jsdom won't flip `paused` itself; do it so the service sees a playing element.
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { value: true, configurable: true });
  });
});

afterEach(() => {
  __resetVideoService();
  vi.restoreAllMocks();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('element setup', () => {
  it('sets playsInline — without it iOS hijacks playback into its native fullscreen player', () => {
    // A hijacked element has no frames to sample, so a video TEXTURE renders nothing.
    const h = playVideo({ url: 'a.mp4' });
    expect(h.element.playsInline).toBe(true);
  });

  it('sets crossOrigin anonymous — without it a remote clip taints the canvas as a texture', () => {
    // The failure this prevents is asymmetric and confusing: the same URL works in a
    // <video> tag and throws a security error the moment it's uploaded to a texture.
    const h = playVideo({ url: 'https://cdn.example/a.mp4' });
    expect(h.element.crossOrigin).toBe('anonymous');
  });
});

describe('timeScale coupling', () => {
  it('slows a diegetic clip with slow-mo', () => {
    const h = playVideo({ url: 'a.mp4', timeMode: 'diegetic' });
    applyTimeScale(0.5);
    expect(h.element.playbackRate).toBe(0.5);
  });

  it('does NOT slow a presentation clip — dragging dialogue to 0.3x is not what slow-mo means', () => {
    const h = playVideo({ url: 'a.mp4', timeMode: 'presentation' });
    applyTimeScale(0.3);
    expect(h.element.playbackRate).toBe(1);
  });

  it('pauses BOTH modes at timeScale 0 — the game is stopped, so is the movie', async () => {
    const d = playVideo({ url: 'a.mp4', timeMode: 'diegetic' });
    const p = playVideo({ url: 'b.mp4', timeMode: 'presentation' });
    await flush();
    applyTimeScale(0);
    expect(d.element.paused).toBe(true);
    expect(p.element.paused).toBe(true);
  });

  it('resumes on leaving a time-stop', async () => {
    const h = playVideo({ url: 'a.mp4' });
    await flush();
    applyTimeScale(0);
    expect(h.element.paused).toBe(true);
    applyTimeScale(1);
    await flush();
    expect(h.element.paused).toBe(false);
  });

  it('does NOT resume a clip the game deliberately paused', async () => {
    const h = playVideo({ url: 'a.mp4' });
    await flush();
    h.pause();
    applyTimeScale(0);
    applyTimeScale(1);
    await flush();
    expect(h.element.paused).toBe(true);
  });

  it('multiplies the base rate by timeScale for diegetic clips', () => {
    const h = playVideo({ url: 'a.mp4', timeMode: 'diegetic' });
    h.setRate(2);
    applyTimeScale(0.5);
    expect(h.element.playbackRate).toBe(1);
  });

  it('applies the CURRENT timeScale to a clip created mid-slow-mo', () => {
    applyTimeScale(0.5);
    const h = playVideo({ url: 'late.mp4', timeMode: 'diegetic' });
    // Regression: a handle created during slow-mo used to run at 1x until the next
    // applyTimeScale call, which may never come if the scale doesn't change again.
    expect(h.element.playbackRate).toBe(0.5);
  });
});

describe('autoplay policy', () => {
  // NOTE: this is also the regression guard for an audio-side bug. jsdom has no
  // AudioContext, so audioService is in `recording()` mode here — exactly the
  // no-Web-Audio path where the gesture signal used to return early and never reach
  // its listeners. Video doesn't need Web Audio to play, so on those devices it would
  // have stayed autoplay-blocked forever. If someone moves the listener loop back
  // below that early-return, THIS test is what fails.
  it('treats a blocked play() as pending, not an error, and retries on the first gesture', async () => {
    playBehaviour = 'block';
    const h = playVideo({ url: 'a.mp4' });
    await flush();
    const callsAfterBlock = playCalls;
    // Exactly one attempt: construction must not double-fire play() (applyRate sets
    // the rate, the autoplay branch starts it — only the latter plays).
    expect(callsAfterBlock).toBe(1);

    playBehaviour = 'allow';
    audioResume(); // the single "user has interacted" signal, shared with audio
    await flush();
    expect(playCalls).toBeGreaterThan(callsAfterBlock);
    expect(h.element.paused).toBe(false);
  });

  it('does not let a gesture un-pause a clip the game paused', async () => {
    const h = playVideo({ url: 'a.mp4' });
    await flush();
    h.pause();
    const before = playCalls;
    audioResume();
    await flush();
    expect(playCalls).toBe(before);
    expect(h.element.paused).toBe(true);
  });

  // #545: a gesture during a time-stop (e.g. a pause menu) used to retry a blocked clip
  // with no time-stop check at all, starting it (and its audio) under the menu.
  it('does not retry a blocked clip while time-stopped', async () => {
    playBehaviour = 'block';
    const h = playVideo({ url: 'a.mp4' });
    await flush();

    applyTimeScale(0);
    playBehaviour = 'allow';
    audioResume(); // gesture unlock, fired under a pause menu
    await flush();

    expect(h.element.paused).toBe(true);
  });

  // The naive one-line fix (early-return in `retryBlockedPlay` alone, leaving
  // `applyRate`'s `!this.blocked` exclusion in place) fails exactly this case: `blocked`
  // stays latched true across the time-stop with no later gesture guaranteed to come, so
  // the clip never comes back. `applyRate` removing that exclusion is what makes leaving
  // the time-stop retry it.
  it('resumes a still-blocked clip once the time-stop lifts', async () => {
    playBehaviour = 'block';
    const h = playVideo({ url: 'a.mp4' });
    await flush();

    applyTimeScale(0);
    playBehaviour = 'allow';
    audioResume(); // still time-stopped: must not play yet (previous case)
    await flush();
    expect(h.element.paused).toBe(true);

    applyTimeScale(1); // leaving the time-stop must retry the still-blocked clip
    await flush();
    expect(h.element.paused).toBe(false);
  });

  // Regression guard: `videoSystem` calls `setRate(...)` and `setTimeMode(...)` on every
  // VideoPlayer entity EVERY FRAME, unconditionally — both funnel straight into
  // `applyRate()`. If `applyRate()`'s resume condition ever drops its `!this.blocked`
  // exclusion again, a blocked clip resumes an `element.play()` attempt on every single
  // one of those per-frame calls instead of once, at the next real timeScale transition.
  it('does not spam element.play() on a blocked clip across per-frame setRate/setTimeMode calls', async () => {
    playBehaviour = 'block';
    const h = playVideo({ url: 'a.mp4', timeMode: 'diegetic' });
    await flush();
    const callsAfterBlock = playCalls;
    expect(callsAfterBlock).toBe(1);

    // Model videoSystem's per-frame reconciliation at a STEADY timeScale (no transition).
    for (let i = 0; i < 5; i++) {
      h.setRate(1);
      h.setTimeMode('diegetic');
    }
    await flush();

    expect(playCalls).toBe(callsAfterBlock);
    expect(h.element.paused).toBe(true);
  });
});

describe('lifecycle', () => {
  it('tracks and releases live handles', () => {
    playVideo({ url: 'a.mp4' });
    playVideo({ url: 'b.mp4' });
    expect(liveVideoCount()).toBe(2);
    disposeAllVideo();
    expect(liveVideoCount()).toBe(0);
  });

  it('drops the source on dispose so the decoder buffer is released', () => {
    const h = playVideo({ url: 'a.mp4' });
    h.dispose();
    expect(h.element.getAttribute('src')).toBeNull();
  });

  it('is idempotent on double dispose', () => {
    const h = playVideo({ url: 'a.mp4' });
    h.dispose();
    expect(() => h.dispose()).not.toThrow();
    expect(liveVideoCount()).toBe(0);
  });

  it('ignores play() after dispose', () => {
    const h = playVideo({ url: 'a.mp4' });
    h.dispose();
    const before = playCalls;
    h.play();
    expect(playCalls).toBe(before);
  });
});

describe('seek', () => {
  it('clamps a negative seek to 0', () => {
    const h = playVideo({ url: 'a.mp4' });
    h.seek(-5);
    expect(h.element.currentTime).toBe(0);
  });
});

describe('a clip that reaches its end (#the iPhone 8 loop)', () => {
  /** Put the element where a finished clip really is, WITHOUT dispatching `ended`. That is not
   *  a contrived state: measured on an iPhone 8, a `loop:false` backdrop restarted every 8s
   *  forever and the journal recorded exactly ONE `@video.start` and never an `@video.end` —
   *  the event had not fired once. jsdom's element has no decoder, so both the position and the
   *  `ended` property are stubbed here to model it. */
  function atEnd(el: HTMLVideoElement, paused = true): void {
    Object.defineProperty(el, 'duration', { value: 8, configurable: true });
    Object.defineProperty(el, 'currentTime', { value: 8, writable: true, configurable: true });
    Object.defineProperty(el, 'ended', { value: true, configurable: true });
    Object.defineProperty(el, 'paused', { value: paused, configurable: true });
  }

  it('reports ended from the ELEMENT, not only from the event', () => {
    const h = playVideo({ url: 'a.mp4' });
    expect(h.ended).toBe(false);
    atEnd(h.element);
    expect(h.ended).toBe(true);
  });

  it('refuses to re-play it — play() at the end REWINDS, which is what looped the backdrop', () => {
    const h = playVideo({ url: 'a.mp4' });
    atEnd(h.element);
    const before = playCalls;
    h.play();          // videoSystem calls this every frame while the trait says `playing`
    h.play();
    expect(playCalls).toBe(before);
  });

  it('does NOT report ended for a LOOPING clip, which is meant to run round again', () => {
    const h = playVideo({ url: 'a.mp4', loop: true });
    atEnd(h.element, false);
    expect(h.ended).toBe(false);
  });

  it('does not re-issue play() for an element that is already running', () => {
    // The same call the loop rode in on, in its ordinary form: re-playing a playing element
    // buys nothing, and is only ever a chance to hit the rewind case above.
    const h = playVideo({ url: 'a.mp4' });
    const before = playCalls;
    h.play();
    expect(playCalls).toBe(before);
  });

  it('un-ends on a seek back into the clip, so a replay is still possible', () => {
    const h = playVideo({ url: 'a.mp4' });
    atEnd(h.element);
    Object.defineProperty(h.element, 'ended', { value: false, configurable: true });
    h.seek(0);
    expect(h.ended).toBe(false);
  });

  it('setLoop(true) un-strands a clip that already ended, and it actually resumes', async () => {
    // Reproduces the real path: the element's `ended` EVENT fires (not `atEnd`'s static
    // stub), latching the private `endedEvent` flag that only `seek()` used to clear. A real
    // element also stops (`paused` becomes true) the moment it reaches its end — model that
    // explicitly, since jsdom's synthetic event dispatch below does not do it for us.
    const h = playVideo({ url: 'a.mp4' });
    await flush();
    Object.defineProperty(h.element, 'paused', { value: true, configurable: true });
    h.element.dispatchEvent(new Event('ended'));
    expect(h.ended).toBe(true);

    h.setLoop(true);
    // The getter's own `!element.loop` term would already say false here even with the bug —
    // the bug is that `endedEvent` stays latched underneath it. This is the real assertion.
    expect(h.ended).toBe(false);

    const before = playCalls;
    h.play();
    await flush();
    // Before the fix, `play()`'s `if (this.ended) return;` refused this call outright and
    // `playCalls`/`paused` never moved — asserting only `element.loop === true` would have
    // missed that the clip stayed stranded.
    expect(playCalls).toBeGreaterThan(before);
    expect(h.element.paused).toBe(false);
  });
});

describe('setTimeMode re-applies the rate live', () => {
  it('diegetic -> presentation immediately returns to 1x, without another applyTimeScale call', () => {
    const h = playVideo({ url: 'a.mp4', timeMode: 'diegetic' });
    applyTimeScale(0.5);
    expect(h.element.playbackRate).toBe(0.5);

    h.setTimeMode('presentation');
    expect(h.element.playbackRate).toBe(1);
  });

  it('presentation -> diegetic immediately re-applies the CURRENT timeScale', () => {
    const h = playVideo({ url: 'a.mp4', timeMode: 'presentation' });
    applyTimeScale(0.5);
    expect(h.element.playbackRate).toBe(1);

    h.setTimeMode('diegetic');
    expect(h.element.playbackRate).toBe(0.5);
  });
});
