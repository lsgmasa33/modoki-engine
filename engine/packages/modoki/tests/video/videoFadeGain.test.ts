/** `videoFadeGain` — the end-of-clip audio ramp.
 *
 *  Pure by design, so the ramp is testable without a media element (the element's clock is the
 *  one thing video can never be stepped on; see videoService's determinism banner). What these
 *  pin is the SHAPE of the ramp and, more importantly, every way it must decline to fade:
 *  silence is the failure a player notices and blames on the engine, a missed fade is not. */

import { describe, it, expect } from 'vitest';
import { videoFadeGain } from '../../src/runtime/video/videoService';

describe('videoFadeGain', () => {
  it('is 1 with no fade asked for — the default is a hard cut', () => {
    expect(videoFadeGain(7.9, 8, 0)).toBe(1);
    expect(videoFadeGain(7.9, 8, -1)).toBe(1);
    expect(videoFadeGain(7.9, 8, NaN)).toBe(1);
  });

  it('is 1 until the ramp starts, then falls linearly to 0 at the end', () => {
    // 8s clip, 3s fade: full volume through t=5, then a straight line down.
    expect(videoFadeGain(0, 8, 3)).toBe(1);
    expect(videoFadeGain(5, 8, 3)).toBe(1);
    expect(videoFadeGain(6.5, 8, 3)).toBeCloseTo(0.5, 6);
    expect(videoFadeGain(7.25, 8, 3)).toBeCloseTo(0.25, 6);
    expect(videoFadeGain(8, 8, 3)).toBe(0);
  });

  it('stays 0 past the end — a clip holding its last frame is silent, not restored', () => {
    expect(videoFadeGain(9, 8, 3)).toBe(0);
  });

  it('clamps a fade longer than the clip rather than refusing it', () => {
    // 5s fade on a 4s clip: starts at t=0 and still lands exactly on 0.
    expect(videoFadeGain(0, 4, 5)).toBe(1);
    expect(videoFadeGain(2, 4, 5)).toBeCloseTo(0.5, 6);
    expect(videoFadeGain(4, 4, 5)).toBe(0);
  });

  it('does not fade on a duration the element cannot report', () => {
    // NaN before metadata loads; Infinity on a live stream; 0 on a broken element. Each would
    // otherwise produce a gain of NaN or a permanently silent clip.
    expect(videoFadeGain(1, NaN, 3)).toBe(1);
    expect(videoFadeGain(1, Infinity, 3)).toBe(1);
    expect(videoFadeGain(1, 0, 3)).toBe(1);
  });
});
