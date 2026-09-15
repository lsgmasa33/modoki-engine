/** The idle gate's grace window is spent by frames that DRAW, not by frames a compile holds (#1252).
 *
 *  Each case drives the frame sequence `Scene3D` runs while a game is paused: ask the gate, then
 *  either submit or return early on a hold. Held frames that spent the window stopped the frame loop
 *  after ~1 s, so a paused game's loading overlay lifted over a canvas still held. */
import { describe, it, expect } from 'vitest';
import { createIdleFrameGrace } from '../../src/runtime/rendering/idleFrameGrace';

const GRACE = 60;
const PAUSED = false;

describe('idleFrameGrace', () => {
  it('a compile holding a paused surface for longer than the window keeps the frame running — the hold still gets asked', () => {
    // A scene-pass borrow or a compile gate's hold: the frame reaches its hold check and returns
    // without submitting. 9.3 s at 60 fps is the iPad mini 5's cold scene-pass compile.
    const grace = createIdleFrameGrace(GRACE);
    let asked = 0;
    for (let frame = 0; frame < 558; frame++) {
      if (grace.shouldIdle(PAUSED)) continue;
      asked++; // held — no submit
    }
    expect(asked).toBe(558);
  });

  it('a gate hold on a paused surface reaches its ceiling release and draws once it lets the frame through', () => {
    // The gate holds for 5 s (300 frames) and then releases the frame; a surface that had idled
    // during the hold never asks again, so the release is never seen and nothing draws.
    const grace = createIdleFrameGrace(GRACE);
    let submitted = 0;
    for (let frame = 0; frame < 400; frame++) {
      if (grace.shouldIdle(PAUSED)) continue;
      const gateHolds = frame < 300;
      if (gateHolds) continue;
      grace.submitted();
      submitted++;
    }
    expect(submitted).toBe(GRACE); // the released frame draws, then the window runs out as usual
  });

  it('frames that draw spend the window, and a paused surface then idles until something is dirty', () => {
    const grace = createIdleFrameGrace(GRACE);
    for (let i = 0; i < GRACE; i++) {
      expect(grace.shouldIdle(PAUSED)).toBe(false);
      grace.submitted();
    }
    expect(grace.shouldIdle(PAUSED)).toBe(true);
    grace.markDirty();
    expect(grace.shouldIdle(PAUSED)).toBe(false);
  });

  it('a playing surface never idles, and its draws still run the window down', () => {
    const grace = createIdleFrameGrace(GRACE);
    for (let i = 0; i < GRACE + 10; i++) {
      expect(grace.shouldIdle(true)).toBe(false);
      grace.submitted();
    }
    expect(grace.shouldIdle(PAUSED)).toBe(true); // pausing right after long play: nothing left to draw
  });
});
