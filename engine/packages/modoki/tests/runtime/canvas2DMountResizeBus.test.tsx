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
import { render, cleanup, act } from '@testing-library/react';
import { Canvas2DMount } from '../../src/runtime/rendering/Canvas2DMount';
import { forceResizeAllSurfaces } from '../../src/runtime/rendering/resizeBus';
import { setRenderSettings, resetRenderSettings, getRenderSettings } from '../../src/runtime/rendering/renderSettings';

/** A pool stub with just the surface Canvas2DMount uses. `resizeSlot` records every call so a
 *  broadcast's effect is observable as the BACKING SIZE, not merely "a callback ran".
 *
 *  ⚠️ The mount resizes through **`resizeSlot(slot, …)`**, not `resize(entityId, …)` (#213). It
 *  holds the slot it mounted, and re-resolving it by id let a reclaimed `entityMap` entry silently
 *  no-op the resize while the canvas was still on screen — shipping a 1x1 buffer stretched over a
 *  full-size box, with no error and no warning. `resize` is kept on the stub so a regression back
 *  to the id path fails LOUDLY here instead of passing on an undefined method. */
function makePool() {
  const canvas = document.createElement('canvas');
  const resizeSlot = vi.fn();
  const resize = vi.fn();
  const slot = { canvas, initialized: true, mounted: true, boundBySim: true, entityId: 1, ready: Promise.resolve() };
  return {
    canvas,
    slot,
    resizeSlot,
    resize,
    mount: vi.fn(() => slot),
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
    pool.resizeSlot.mockClear();

    // Flip the cap the way the Device tab does, then broadcast.
    setRenderSettings({ pixi: { ...getRenderSettings().pixi, pixelRatioCap: 1 } });
    forceResizeAllSurfaces();

    // 400×300 CSS at dpr 3 capped to 1 → 400×300 backing (not the 1200×900 of raw dpr).
    expect(pool.resizeSlot).toHaveBeenCalledWith(pool.slot, 400, 300);
    // …and NOT through the id path, which is the one that can silently no-op (#213).
    expect(pool.resize).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount — a broadcast must not touch a reclaimed slot', () => {
    const pool = makePool();
    const { unmount } = render(<Canvas2DMount entityId={1} pool={pool as never} markDirty={() => {}} />);
    unmount();
    pool.resizeSlot.mockClear();
    pool.resize.mockClear();

    forceResizeAllSurfaces();

    // ⚠️ This assertion carries MORE weight than it used to. The mount now resizes the slot it
    // holds, so a leaked listener would poke a reclaimed slot's canvas DIRECTLY — the old id
    // lookup happened to miss and no-op, which made unsubscribing look optional. It never was:
    // relying on that miss as a safety net is exactly what hid #213 for a whole session.
    expect(pool.resizeSlot).not.toHaveBeenCalled();
    expect(pool.resize).not.toHaveBeenCalled();
  });
});

describe('Canvas2DMount — the claim/append gap the pool teardown depends on (#213)', () => {
  it('takes the pool claim SYNCHRONOUSLY, and appends the canvas only after slot.ready', async () => {
    // A slot whose Application has NOT finished initialising — the real state on a slow device,
    // and the one every pool test simulates by hand. Nothing until now pinned that Canvas2DMount
    // actually produces it.
    let release!: () => void;
    const ready = new Promise<void>((r) => { release = r; });
    const canvas = document.createElement('canvas');
    const slot = { canvas, initialized: false, mounted: false, boundBySim: true, entityId: 7, ready };
    const pool = {
      slot,
      resizeSlot: vi.fn(),
      resize: vi.fn(),
      mount: vi.fn(() => { slot.mounted = true; return slot; }),
      unmount: vi.fn(),
    };

    render(<Canvas2DMount entityId={7} pool={pool as never} markDirty={() => {}} />);

    // ⚠️ THIS is the state `destroyPool` has to survive: the slot is fully CLAIMED while its
    // canvas is still parentless. The pool must therefore ask `slot.mounted`, never the DOM — a
    // DOM-shaped check reads "nobody is using this" here and destroys a live GPU context that the
    // mount is about to show, which is #213. If this contract ever inverted (append first, claim
    // later) the pool's guard would be testing a state that no longer occurs, and every pool test
    // would keep passing while the device went blank again.
    expect(pool.mount).toHaveBeenCalledWith(7);
    expect(slot.mounted, 'the claim must be held immediately').toBe(true);
    expect(canvas.parentElement, 'and the canvas must NOT be appended yet').toBeNull();

    release();
    await act(async () => { await ready; });

    expect(canvas.parentElement, 'the append lands only once slot.ready resolves').not.toBeNull();
  });
});
