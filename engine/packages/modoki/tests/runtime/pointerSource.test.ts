// @vitest-environment jsdom
/** Pointer input source — the mouse/touch modality of the Input seam.
 *
 *  Proves the DOM plumbing headlessly (jsdom PointerEvents → `sample` into an
 *  InputFrame → central edge derivation), and the load-bearing Android robustness
 *  property: a `pointercancel` mid-gesture ends the gesture as a clean release
 *  (down=false, a `released` edge) rather than stranding `down=true` — so a
 *  drag-to-aim that the browser tries to reclaim doesn't hang.
 *
 *  Runs in the jsdom environment (see engine/vite.config.ts). We dispatch real
 *  PointerEvents on `window`; the source tracks level state, and we derive the
 *  down-edge exactly as `inputSystem` does (`computePointerEdge`). */

import { describe, it, expect, afterEach } from 'vitest';
import { pointerSource } from '../../src/runtime/input/pointerSource';
import { createInputFrame, computePointerEdge, type InputFrame } from '../../src/runtime/input/actions';

/** jsdom lacks a PointerEvent constructor in some versions — synthesize one that
 *  carries pointerId + clientX/clientY, dispatched as the given type. */
function firePointer(type: string, x: number, y: number, pointerId = 1): void {
  const ev = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }) as MouseEvent & { pointerId: number };
  (ev as { pointerId: number }).pointerId = pointerId;
  window.dispatchEvent(ev);
}

/** Sample the source into a fresh frame and derive the down-edge (as inputSystem does). */
function sampleFrame(prev: { down: boolean }): InputFrame {
  const frame = createInputFrame();
  pointerSource.sample(frame);
  computePointerEdge(frame, prev);
  return frame;
}

afterEach(() => { pointerSource.detach(); });

describe('pointerSource', () => {
  it('reports down + position + drag delta across a press→drag→release', () => {
    pointerSource.attach();
    const prev = { down: false };

    // Before any input: up, at origin.
    let f = sampleFrame(prev);
    expect(f.pointer.down).toBe(false);

    // Press at (100,200): down, pressed edge, drag 0, start latched.
    firePointer('pointerdown', 100, 200);
    f = sampleFrame(prev);
    expect(f.pointer.down).toBe(true);
    expect(f.pointer.pressed).toBe(true);
    expect(f.pointer.released).toBe(false);
    expect(f.pointer.x).toBe(100);
    expect(f.pointer.y).toBe(200);
    expect(f.pointer.dragX).toBe(0);
    expect(f.pointer.dragY).toBe(0);
    expect(f.lastDevice).toBe('pointer');

    // Drag to (100,260): still down (no new edge), drag delta from the press start.
    firePointer('pointermove', 100, 260);
    f = sampleFrame(prev);
    expect(f.pointer.down).toBe(true);
    expect(f.pointer.pressed).toBe(false);
    expect(f.pointer.dragX).toBe(0);
    expect(f.pointer.dragY).toBe(60);

    // Release: up, released edge, drag zeroed while up.
    firePointer('pointerup', 100, 260);
    f = sampleFrame(prev);
    expect(f.pointer.down).toBe(false);
    expect(f.pointer.released).toBe(true);
    expect(f.pointer.dragX).toBe(0);
    expect(f.pointer.dragY).toBe(0);
  });

  it('treats pointercancel as a clean release (never strands down=true)', () => {
    pointerSource.attach();
    const prev = { down: false };

    firePointer('pointerdown', 50, 50);
    let f = sampleFrame(prev);
    expect(f.pointer.down).toBe(true);

    // The browser reclaims the touch for a scroll/zoom → pointercancel. Must end the
    // gesture as a release, not hang with down=true.
    firePointer('pointercancel', 50, 50);
    f = sampleFrame(prev);
    expect(f.pointer.down).toBe(false);
    expect(f.pointer.released).toBe(true);
  });

  it('the first pointer owns the gesture — a second finger cannot hijack the drag', () => {
    pointerSource.attach();
    const prev = { down: false };

    firePointer('pointerdown', 10, 10, /*pointerId*/ 1);
    // A second finger presses elsewhere; its id differs → ignored while #1 owns it.
    firePointer('pointerdown', 500, 500, /*pointerId*/ 2);
    let f = sampleFrame(prev);
    expect(f.pointer.x).toBe(10);
    expect(f.pointer.y).toBe(10);

    // Moving the SECOND finger must not move the owned pointer.
    firePointer('pointermove', 600, 600, /*pointerId*/ 2);
    f = sampleFrame(prev);
    expect(f.pointer.x).toBe(10);

    // The owner moves → tracked.
    firePointer('pointermove', 30, 40, /*pointerId*/ 1);
    f = sampleFrame(prev);
    expect(f.pointer.x).toBe(30);
    expect(f.pointer.y).toBe(40);
  });

  it('detach drops listeners and latched state (idempotent)', () => {
    pointerSource.attach();
    const prev = { down: false };
    firePointer('pointerdown', 1, 1);
    pointerSource.detach();
    // After detach a new down must be ignored (no listener) → still up.
    firePointer('pointerdown', 9, 9);
    const f = sampleFrame(prev);
    expect(f.pointer.down).toBe(false);
    pointerSource.detach(); // idempotent
  });
});
