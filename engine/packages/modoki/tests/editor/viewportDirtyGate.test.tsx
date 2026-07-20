/** SceneView 3D viewport idle render gate — regression tests.
 *
 *  Pins two contracts that, when broken, leave a visibly stale viewport:
 *   1. The countdown gate skips idle frames but draws for `grace` frames after a mark,
 *      and `live`/`controlsMoving` always force a draw.
 *   2. A view-mode (3D ↔ 2D/UI) or layer-toggle change RE-ARMS the gate. These are
 *      component-local props, not editor-store fields, so they bypass the store's
 *      dirty subscription — the exact bug where switching 2D↔3D with a device preset
 *      selected showed a half-broken frame (3D grid in 2D mode). */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createViewportDirtyGate, useRearmDirtyOnChange, DIRTY_GRACE } from '../../src/editor/panels/viewportDirtyGate';

describe('createViewportDirtyGate — countdown', () => {
  it('draws for `grace` frames after construction, then settles to idle', () => {
    const gate = createViewportDirtyGate(3);
    // grace=3: three drawing frames…
    expect(gate.shouldDraw(false, false)).toBe(true);
    expect(gate.shouldDraw(false, false)).toBe(true);
    expect(gate.shouldDraw(false, false)).toBe(true);
    // …then idle (no draw) — a truly static viewport submits nothing.
    expect(gate.shouldDraw(false, false)).toBe(false);
    expect(gate.shouldDraw(false, false)).toBe(false);
  });

  it('markDirty re-arms the full grace window', () => {
    const gate = createViewportDirtyGate(2);
    gate.shouldDraw(false, false); // 2 -> 1
    gate.shouldDraw(false, false); // 1 -> 0
    expect(gate.shouldDraw(false, false)).toBe(false); // idle
    gate.markDirty();
    expect(gate.frames()).toBe(2);
    expect(gate.shouldDraw(false, false)).toBe(true);
    expect(gate.shouldDraw(false, false)).toBe(true);
    expect(gate.shouldDraw(false, false)).toBe(false);
  });

  it('forces a draw while live (sim / preview) without consuming the countdown', () => {
    const gate = createViewportDirtyGate(0); // start idle
    expect(gate.shouldDraw(false, false)).toBe(false);
    expect(gate.shouldDraw(true, false)).toBe(true);  // live forces draw
    expect(gate.shouldDraw(true, false)).toBe(true);  // and keeps drawing
    expect(gate.frames()).toBe(0);                    // didn't burn grace frames
  });

  it('forces a draw while OrbitControls are still moving', () => {
    const gate = createViewportDirtyGate(0);
    expect(gate.shouldDraw(false, false)).toBe(false);
    expect(gate.shouldDraw(false, true)).toBe(true);  // controlsMoving forces draw
    expect(gate.shouldDraw(false, false)).toBe(false); // settled -> idle again
  });

  it('defaults to DIRTY_GRACE frames when no grace is passed', () => {
    const gate = createViewportDirtyGate();
    expect(gate.frames()).toBe(DIRTY_GRACE);
  });
});

describe('useRearmDirtyOnChange — re-arm on mode/layer change (the regression)', () => {
  type Props = { mode: '3d' | 'ui'; layers: { show3D: boolean; show2D: boolean; showUI: boolean } };
  const LAYERS = { show3D: true, show2D: true, showUI: true };

  it('marks dirty on mount, then again whenever mode flips', () => {
    const markDirty = vi.fn();
    const { rerender } = renderHook(
      ({ mode, layers }: Props) => useRearmDirtyOnChange(markDirty, [mode, layers]),
      { initialProps: { mode: '3d', layers: LAYERS } as Props },
    );
    expect(markDirty).toHaveBeenCalledTimes(1); // mount

    rerender({ mode: 'ui', layers: LAYERS }); // 3D -> 2D : MUST re-arm
    expect(markDirty).toHaveBeenCalledTimes(2);

    rerender({ mode: '3d', layers: LAYERS }); // 2D -> 3D : MUST re-arm
    expect(markDirty).toHaveBeenCalledTimes(3);
  });

  it('does NOT re-arm when neither mode nor layers changed (no wasted redraws)', () => {
    const markDirty = vi.fn();
    const { rerender } = renderHook(
      ({ mode, layers }: Props) => useRearmDirtyOnChange(markDirty, [mode, layers]),
      { initialProps: { mode: '3d', layers: LAYERS } as Props },
    );
    markDirty.mockClear();
    rerender({ mode: '3d', layers: LAYERS }); // same identity refs
    expect(markDirty).not.toHaveBeenCalled();
  });

  it('re-arms when a layer toggle changes', () => {
    const markDirty = vi.fn();
    const { rerender } = renderHook(
      ({ mode, layers }: Props) => useRearmDirtyOnChange(markDirty, [mode, layers]),
      { initialProps: { mode: '3d', layers: LAYERS } as Props },
    );
    markDirty.mockClear();
    rerender({ mode: '3d', layers: { ...LAYERS, show2D: false } });
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it('end-to-end: a real gate goes idle, then a mode flip re-arms it via the hook', () => {
    const gate = createViewportDirtyGate(1);
    gate.shouldDraw(false, false);                 // burn the single grace frame
    expect(gate.shouldDraw(false, false)).toBe(false); // idle: viewport would be stale

    const { rerender } = renderHook(
      ({ mode }: { mode: '3d' | 'ui' }) => useRearmDirtyOnChange(() => gate.markDirty(), [mode]),
      { initialProps: { mode: '3d' as const } },
    );
    gate.shouldDraw(false, false); // consume the mount re-arm
    while (gate.shouldDraw(false, false)) { /* drain back to idle */ }
    expect(gate.shouldDraw(false, false)).toBe(false);

    rerender({ mode: 'ui' }); // switch 3D -> 2D
    expect(gate.frames()).toBe(1);                  // re-armed
    expect(gate.shouldDraw(false, false)).toBe(true); // draws -> no stale frame
  });
});
