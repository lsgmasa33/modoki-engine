/** SuperSampleRebuildDebouncer — coalescing logic for NPR SS-scale rebuilds (npr-F9).
 *
 *  An SS-scale change forces a full NPR pipeline dispose()+reconstruct (shader
 *  recompile), so dragging the supersample slider must not recompile every frame.
 *  These tests pin the coalescing contract: a sweep settles to ONE rebuild at the
 *  final value; a value that returns to the live scale cancels; an instant settle
 *  fires immediately. Pure JS, no GPU. */

import { describe, it, expect } from 'vitest';
import {
  SuperSampleRebuildDebouncer,
  DEFAULT_SS_REBUILD_SETTLE_FRAMES,
} from '../../src/runtime/rendering/npr/ssRebuildDebounce';

/** Run `tick(scale)` for `frames` frames; return how many times it signalled a rebuild. */
function tickN(d: SuperSampleRebuildDebouncer, scale: number, frames: number): number {
  let fired = 0;
  for (let i = 0; i < frames; i++) if (d.tick(scale)) fired++;
  return fired;
}

describe('SuperSampleRebuildDebouncer', () => {
  it('never fires while the desired scale equals the applied scale', () => {
    const d = new SuperSampleRebuildDebouncer(1);
    expect(tickN(d, 1, 100)).toBe(0);
    expect(d.appliedScale).toBe(1);
  });

  it('fires exactly once after the target holds for settleFrames, and bakes it', () => {
    const settle = 4;
    const d = new SuperSampleRebuildDebouncer(1, settle);
    // First (settle-1) ticks at the new value are still settling.
    for (let i = 0; i < settle - 1; i++) expect(d.tick(2)).toBe(false);
    // The settle-th tick commits the rebuild.
    expect(d.tick(2)).toBe(true);
    expect(d.appliedScale).toBe(2);
    // Once applied, holding the same value never re-fires.
    expect(tickN(d, 2, 50)).toBe(0);
  });

  it('coalesces a frame-by-frame slider sweep into a single rebuild at the final value', () => {
    const settle = 4;
    const d = new SuperSampleRebuildDebouncer(1, settle);
    // Sweep 2→3→4 one frame each (drag) — none settle.
    expect(d.tick(2)).toBe(false);
    expect(d.tick(3)).toBe(false);
    expect(d.tick(4)).toBe(false);
    // Slider released at 4 — settles after `settle` steady frames.
    let fired = 0;
    for (let i = 0; i < settle; i++) if (d.tick(4)) fired++;
    expect(fired).toBe(1);
    expect(d.appliedScale).toBe(4);
  });

  it('cancels a pending rebuild when the scale returns to the applied value mid-settle', () => {
    const settle = 6;
    const d = new SuperSampleRebuildDebouncer(1, settle);
    // Start settling toward 3...
    expect(d.tick(3)).toBe(false);
    expect(d.tick(3)).toBe(false);
    // ...then drag back to the live value — pending is cancelled.
    expect(d.tick(1)).toBe(false);
    expect(d.appliedScale).toBe(1);
    // Holding at 1 never fires.
    expect(tickN(d, 1, 20)).toBe(0);
  });

  it('restarts the countdown each time the pending target changes', () => {
    const settle = 5;
    const d = new SuperSampleRebuildDebouncer(1, settle);
    // Hold 2 for settle-1 frames (almost settled)...
    for (let i = 0; i < settle - 1; i++) expect(d.tick(2)).toBe(false);
    // ...then switch to 3 — countdown restarts, so it must take `settle` MORE steady frames.
    for (let i = 0; i < settle - 1; i++) expect(d.tick(3)).toBe(false);
    expect(d.tick(3)).toBe(true);
    expect(d.appliedScale).toBe(3);
  });

  it('treats settleFrames=1 as immediate (fires on the first differing frame)', () => {
    const d = new SuperSampleRebuildDebouncer(1, 1);
    expect(d.tick(2)).toBe(true);
    expect(d.appliedScale).toBe(2);
  });

  it('clamps a non-positive settle window to at least 1 frame', () => {
    const d = new SuperSampleRebuildDebouncer(1, 0);
    expect(d.tick(2)).toBe(true);
  });

  it('exposes a sane default settle window', () => {
    expect(DEFAULT_SS_REBUILD_SETTLE_FRAMES).toBeGreaterThan(1);
    const d = new SuperSampleRebuildDebouncer(1);
    expect(tickN(d, 2, DEFAULT_SS_REBUILD_SETTLE_FRAMES - 1)).toBe(0);
    expect(d.tick(2)).toBe(true);
  });
});
