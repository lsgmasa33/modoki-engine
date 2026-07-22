// @vitest-environment jsdom
/** useOverlayEscape / useOverlay.
 *
 *  The overlay-stack behaviour was previously covered only by a hand-rolled 8-line MIRROR
 *  of the hook inside keymap.test.ts — which tests the design, not the implementation. If
 *  the real hook stopped pushing, or generated a colliding owner id, or leaked a
 *  registration on unmount, every one of those tests would still pass.
 *
 *  These drive the REAL hook through renderHook. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const { useOverlayEscape, useOverlay } = await import('../../src/editor/input/useOverlayEscape');
const { topOverlay, overlayDepth, clearOverlays } = await import('../../src/editor/input/focusScope');
const { resolve, clearBindings, getBindings } = await import('../../src/editor/input/keymap');

const ctxAt = (overlay: string | null) => ({ focusedPanel: null, overlay, textEditable: false });

beforeEach(() => { clearOverlays(); clearBindings(); });

describe('useOverlayEscape', () => {
  it('pushes while open and registers an Escape binding', () => {
    const onClose = vi.fn();
    renderHook(() => useOverlayEscape(true, onClose, 'context-menu'));
    expect(overlayDepth()).toBe(1);

    const hit = resolve('Escape', ctxAt(topOverlay()));
    expect(hit).not.toBeNull();
    hit!.run();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOTHING while closed', () => {
    renderHook(() => useOverlayEscape(false, vi.fn(), 'context-menu'));
    expect(overlayDepth()).toBe(0);
    expect(getBindings()).toHaveLength(0);
  });

  it('cleans up fully on unmount — no leaked overlay or binding', () => {
    const { unmount } = renderHook(() => useOverlayEscape(true, vi.fn(), 'context-menu'));
    expect(overlayDepth()).toBe(1);
    unmount();
    expect(overlayDepth()).toBe(0);
    expect(getBindings()).toHaveLength(0);
  });

  it('gives two instances of the SAME kind distinct owners — no conflict throw', () => {
    // The nested-submenu shape. A per-KIND owner id would collide here and throw
    // KeymapConflictError (same chord + same scope + same owner).
    expect(() => {
      renderHook(() => useOverlayEscape(true, vi.fn(), 'context-menu'));
      renderHook(() => useOverlayEscape(true, vi.fn(), 'context-menu'));
    }).not.toThrow();
    expect(overlayDepth()).toBe(2);
    expect(getBindings()).toHaveLength(2);
  });

  it('routes Escape to the TOP instance only', () => {
    const outer = vi.fn(); const inner = vi.fn();
    renderHook(() => useOverlayEscape(true, outer, 'context-menu'));
    const second = renderHook(() => useOverlayEscape(true, inner, 'context-menu'));

    resolve('Escape', ctxAt(topOverlay()))!.run();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    // Closing the inner one hands Escape back to the outer.
    second.unmount();
    resolve('Escape', ctxAt(topOverlay()))!.run();
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('does not re-register when only onClose changes identity', () => {
    // Menus pass an inline arrow, so onClose is a new function every render. Re-registering
    // on each would churn the overlay stack — hence the ref indirection in the hook.
    let cb = vi.fn();
    const { rerender } = renderHook(({ f }) => useOverlayEscape(true, f, 'menu'), {
      initialProps: { f: cb },
    });
    const first = getBindings()[0];
    cb = vi.fn();
    rerender({ f: cb });
    expect(getBindings()).toHaveLength(1);
    expect(getBindings()[0].id).toBe(first.id); // same registration, not a new one
  });

  it('calls the LATEST onClose after a rerender', () => {
    const oldCb = vi.fn(); const newCb = vi.fn();
    const { rerender } = renderHook(({ f }) => useOverlayEscape(true, f, 'menu'), {
      initialProps: { f: oldCb },
    });
    rerender({ f: newCb });
    resolve('Escape', ctxAt(topOverlay()))!.run();
    expect(newCb).toHaveBeenCalledTimes(1);
    expect(oldCb).not.toHaveBeenCalled(); // the ref must not pin the first closure
  });

  it('toggling open pushes and pops without leaking', () => {
    const { rerender } = renderHook(({ open }) => useOverlayEscape(open, vi.fn(), 'picker'), {
      initialProps: { open: true },
    });
    expect(overlayDepth()).toBe(1);
    rerender({ open: false });
    expect(overlayDepth()).toBe(0);
    expect(getBindings()).toHaveLength(0);
    rerender({ open: true });
    expect(overlayDepth()).toBe(1);
  });
});

describe('useOverlay (no Escape binding)', () => {
  it('pushes the overlay WITHOUT binding Escape', () => {
    // For overlays that own other chords (the SpriteEditor modal claims Cmd+Z) or that
    // deliberately have no Escape-to-close. Adopting the stack must not silently ADD an
    // Escape behaviour a component never had.
    const { result } = renderHook(() => useOverlay(true, 'sprite-editor'));
    expect(overlayDepth()).toBe(1);
    expect(getBindings()).toHaveLength(0);
    expect(resolve('Escape', ctxAt(topOverlay()))).toBeNull();
    expect(result.current).toContain('sprite-editor');
  });

  it('returns a stable id across rerenders', () => {
    const { result, rerender } = renderHook(() => useOverlay(true, 'sprite-editor'));
    const id = result.current;
    rerender();
    expect(result.current).toBe(id); // an unstable id would re-push every render
  });
});
