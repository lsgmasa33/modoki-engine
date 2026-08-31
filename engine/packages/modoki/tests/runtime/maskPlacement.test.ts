/** maskOffsetWorld unit tests (#449 review round 2, Fix 1) — see the doc comment on the function
 *  for the bug this guards: R·(S·offset), NOT S·(R·offset). */

import { describe, it, expect } from 'vitest';
import { maskOffsetWorld } from '../../src/runtime/rendering/maskPlacement';

describe('maskOffsetWorld', () => {
  it('identity: no rotation, unit scale, unit compensation returns the offset unchanged', () => {
    const { ox, oy } = maskOffsetWorld(37, -12, 0, 1, 1, 1, 1);
    expect(ox).toBeCloseTo(37);
    expect(oy).toBeCloseTo(-12);
  });

  it('pure translation with scale only (no rotation)', () => {
    const { ox, oy } = maskOffsetWorld(10, 20, 0, 2, 3, 1, 1);
    expect(ox).toBeCloseTo(20);
    expect(oy).toBeCloseTo(60);
  });

  it('pure rotation only (unit scale) — rz = π/2 turns (x,0) into (0,x)', () => {
    const { ox, oy } = maskOffsetWorld(100, 0, Math.PI / 2, 1, 1, 1, 1);
    expect(ox).toBeCloseTo(0);
    expect(oy).toBeCloseTo(100);
  });

  it('combined case: rz=π/2, sx=1, sy=2, offset (100,0) -> (0,100), NOT (0,200)', () => {
    const { ox, oy } = maskOffsetWorld(100, 0, Math.PI / 2, 1, 2, 1, 1);
    expect(ox).toBeCloseTo(0);
    expect(oy).toBeCloseTo(100);
    expect(oy).not.toBeCloseTo(200);
  });

  it('non-uniform comp is applied per-axis after rotation', () => {
    const { ox, oy } = maskOffsetWorld(10, 0, 0, 1, 1, 3, 5);
    expect(ox).toBeCloseTo(30);
    expect(oy).toBeCloseTo(0);
  });

  it('negative offset', () => {
    const { ox, oy } = maskOffsetWorld(-100, 0, Math.PI / 2, 1, 2, 1, 1);
    expect(ox).toBeCloseTo(0);
    expect(oy).toBeCloseTo(-100);
  });

  it('rz = π flips both axes', () => {
    const { ox, oy } = maskOffsetWorld(10, 20, Math.PI, 1, 1, 1, 1);
    expect(ox).toBeCloseTo(-10);
    expect(oy).toBeCloseTo(-20);
  });
});
