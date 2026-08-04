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
