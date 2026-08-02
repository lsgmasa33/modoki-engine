/** Canvas2DMount ↔ resizeBus integration.
 *
 *  resizeBus.test.ts proves the REGISTRY in isolation; this proves the SEAM — that the
 *  mount actually subscribes, that a broadcast re-measures through the real
 *  computeBackingSize path (so a live `pixi.pixelRatioCap` flip reaches the pool), and
 *  that unmount unsubscribes.
 *
 *  The teardown half is the one that matters and the one nobody asserts by default: a
 *  leaked listener keeps calling `updateSize` for an entity whose slot the pool has
 *  already reclaimed, so every later flip resizes a canvas that is no longer on screen —
 *  and mount/unmount churn multiplies it. */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { Canvas2DMount } from '../../src/runtime/rendering/Canvas2DMount';
import { forceResizeAllSurfaces } from '../../src/runtime/rendering/resizeBus';
import { setRenderSettings, resetRenderSettings, getRenderSettings } from '../../src/runtime/rendering/renderSettings';

/** A pool stub with just the surface Canvas2DMount uses. `resize` records every call so a
 *  broadcast's effect is observable as the BACKING SIZE, not merely "a callback ran". */
function makePool() {
  const canvas = document.createElement('canvas');
  const resize = vi.fn();
  return {
    canvas,
    resize,
    mount: vi.fn(() => ({ canvas, initialized: true, ready: Promise.resolve() })),
    unmount: vi.fn(),
  };
}

/** jsdom gives every element a 0×0 box, and computeBackingSize returns 0×0 for an
 *  unmeasured box ON PURPOSE (see canvas2DSizing) — which would make `resize` never fire
 *  and this test vacuous. Stub a real rect so the measure path produces a size. */
function stubRect(w: number, h: number) {
  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}),
  })) as unknown as typeof Element.prototype.getBoundingClientRect;
}

const origRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  resetRenderSettings();
  stubRect(400, 300);
  vi.stubGlobal('devicePixelRatio', 3);
  // ResizeObserver is not in jsdom; the mount constructs one. A no-op stub keeps the
  // component's own observer out of the way so `resize` calls are attributable to the BUS.
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  resetRenderSettings();
  vi.unstubAllGlobals();
  Element.prototype.getBoundingClientRect = origRect;
});

describe('Canvas2DMount ↔ resizeBus', () => {
  it('re-measures on a broadcast, applying the CURRENT pixelRatioCap (the live-flip path)', () => {
    const pool = makePool();
    setRenderSettings({ pixi: { ...getRenderSettings().pixi, pixelRatioCap: 2 } });
    render(<Canvas2DMount entityId={1} pool={pool as never} markDirty={() => {}} />);
    pool.resize.mockClear();

    // Flip the cap the way the Device tab does, then broadcast.
    setRenderSettings({ pixi: { ...getRenderSettings().pixi, pixelRatioCap: 1 } });
    forceResizeAllSurfaces();

    // 400×300 CSS at dpr 3 capped to 1 → 400×300 backing (not the 1200×900 of raw dpr).
    expect(pool.resize).toHaveBeenCalledWith(1, 400, 300);
  });

  it('unsubscribes on unmount — a broadcast must not touch a reclaimed slot', () => {
    const pool = makePool();
    const { unmount } = render(<Canvas2DMount entityId={1} pool={pool as never} markDirty={() => {}} />);
    unmount();
    pool.resize.mockClear();

    forceResizeAllSurfaces();

    expect(pool.resize).not.toHaveBeenCalled();
  });
});
