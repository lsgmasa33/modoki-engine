// @vitest-environment jsdom
/** The two producers of #1928's boot-content gate — `Canvas2DMount` and `BootImageProbe`.
 *
 *  `bootContentGate.test.ts` proves the SET; this proves each producer registers while a boot is
 *  armed and settles its token on EVERY path. The failure paths matter most: a token nobody
 *  settles holds every boot to the gate's 5 s ceiling, which is a worse launch than the bug. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { Canvas2DMount } from '../../src/runtime/rendering/Canvas2DMount';
import { BootImageProbe, BootContentHold } from '../../src/runtime/ui/bootContentProbes';
import { armBootContent, pendingBootContent, resetBootContentGate } from '../../src/runtime/core/bootContentGate';
import { resetRenderSettings } from '../../src/runtime/rendering/renderSettings';

/** Only what Canvas2DMount touches. `whenNextRendered` captures the callback so the test plays
 *  the pool's "a frame drew" moment by hand. */
function makePool(opts: { initialized?: boolean; ready?: Promise<void> } = {}) {
  const canvas = document.createElement('canvas');
  const slot = {
    canvas, initialized: opts.initialized ?? true, mounted: true, boundBySim: true, entityId: 7,
    ready: opts.ready ?? Promise.resolve(),
  };
  let drew: (() => void) | null = null;
  const unwatch = vi.fn();
  return {
    slot,
    unwatch,
    draw: () => { const cb = drew; drew = null; cb?.(); },
    mount: vi.fn(() => slot),
    unmount: vi.fn(),
    resizeSlot: vi.fn(),
    whenNextRendered: vi.fn((_s: unknown, cb: () => void) => { drew = cb; return unwatch; }),
  };
}

const origRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  resetBootContentGate();
  resetRenderSettings();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    width: 400, height: 300, top: 0, left: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}),
  })) as unknown as typeof Element.prototype.getBoundingClientRect;
});

afterEach(() => {
  cleanup();
  resetBootContentGate();
  vi.unstubAllGlobals();
  Element.prototype.getBoundingClientRect = origRect;
});

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('Canvas2DMount as a boot-content producer (#1928)', () => {
  it('does not register outside a boot — the editor never arms', () => {
    const pool = makePool();
    render(<Canvas2DMount entityId={7} pool={pool as never} markDirty={() => {}} />);
    expect(pool.whenNextRendered).not.toHaveBeenCalled();
    expect(pendingBootContent()).toEqual([]);
  });

  it('holds the boot until the surface has drawn', () => {
    armBootContent();
    const pool = makePool();
    render(<Canvas2DMount entityId={7} pool={pool as never} markDirty={() => {}} />);
    expect(pendingBootContent()).toEqual(['canvas2d:7']);
    pool.draw();
    expect(pendingBootContent()).toEqual([]);
  });

  it('releases on unmount — a surface that left the screen is not waited for', () => {
    armBootContent();
    const pool = makePool();
    const { unmount } = render(<Canvas2DMount entityId={7} pool={pool as never} markDirty={() => {}} />);
    unmount();
    expect(pool.unwatch).toHaveBeenCalled();
    expect(pendingBootContent()).toEqual([]);
  });

  it('releases when Application.init fails — that canvas will never draw', async () => {
    armBootContent();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = makePool({ initialized: false, ready: Promise.reject(new Error('no GPU')) });
    render(<Canvas2DMount entityId={7} pool={pool as never} markDirty={() => {}} />);
    expect(pendingBootContent()).toEqual(['canvas2d:7']);
    await flush();
    expect(pendingBootContent()).toEqual([]);
    expect(err).toHaveBeenCalled();
  });

  it('releases when the box stays 0×0 — nothing to show, so nothing to wait for', () => {
    armBootContent();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}),
    })) as unknown as typeof Element.prototype.getBoundingClientRect;
    // Run the size retry's frames synchronously, up to its give-up warning.
    let frame = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { if (frame++ < 500) cb(0); return frame; });
    const pool = makePool();
    render(<Canvas2DMount entityId={7} pool={pool as never} markDirty={() => {}} />);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still 0×0'));
    expect(pendingBootContent()).toEqual([]);
  });
});

describe('BootImageProbe (#1928)', () => {
  /** An `Image` whose decode the test settles by hand. */
  function stubImage() {
    const decodes: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    const srcs: string[] = [];
    class FakeImage {
      set src(v: string) { srcs.push(v); }
      decode() { return new Promise<void>((resolve, reject) => { decodes.push({ resolve, reject }); }); }
    }
    vi.stubGlobal('Image', FakeImage);
    return { decodes, srcs };
  }

  it('does nothing outside a boot — not even an Image', () => {
    const img = stubImage();
    render(<BootImageProbe url="/assets/textures/reef.webp" />);
    expect(img.srcs).toEqual([]);
    expect(pendingBootContent()).toEqual([]);
  });

  it('holds the boot until the SAME url the element paints has decoded', async () => {
    armBootContent();
    const img = stubImage();
    render(<BootImageProbe url="/assets/textures/reef.webp?v=1" />);
    expect(img.srcs).toEqual(['/assets/textures/reef.webp?v=1']);
    expect(pendingBootContent()).toEqual(['ui-image:reef.webp?v=1']);
    img.decodes[0].resolve();
    await flush();
    expect(pendingBootContent()).toEqual([]);
  });

  it('releases when the decode FAILS — a broken image must not hold the splash for 5 s', async () => {
    armBootContent();
    const img = stubImage();
    render(<BootImageProbe url="/missing.webp" />);
    img.decodes[0].reject(new Error('EncodingError'));
    await flush();
    expect(pendingBootContent()).toEqual([]);
  });

  it('releases on unmount before the decode lands — the node hid or the scene changed', () => {
    armBootContent();
    stubImage();
    const { unmount } = render(<BootImageProbe url="/a.webp" />);
    unmount();
    expect(pendingBootContent()).toEqual([]);
  });
});

describe('BootContentHold (#1928)', () => {
  it('holds while mounted and releases on unmount — the lazy Canvas2DMount\'s Suspense fallback', () => {
    armBootContent();
    const { unmount } = render(<BootContentHold label="canvas2d:5" />);
    expect(pendingBootContent()).toEqual(['canvas2d:5']);
    unmount();
    expect(pendingBootContent()).toEqual([]);
  });

  it('does nothing outside a boot', () => {
    render(<BootContentHold label="canvas2d:5" />);
    expect(pendingBootContent()).toEqual([]);
  });
});
