// @vitest-environment jsdom
/** Integration: presentation-invariant drag END-TO-END through the real path
 *  (browser PointerEvent -> pointerSource.sample -> inputSystem -> Input resource).
 *  Pins the seam between the source (which writes a RAW clientX delta) and `inputSystem`
 *  (which applies the presentation scale ONCE, at the merge point, per the module-boundaries
 *  plan's P4 design): `Input.pointer.dragX/dragY` IS the presentation-invariant value — there
 *  is no separate "raw frame" a consumer could read instead, which is the single-source-of-
 *  truth fix this design replaced (previously `pointerDrag` scaled but `pointer(world).dragX`
 *  didn't, so the same field had two meanings depending on which accessor you used). This
 *  catches a future double-scale (source pre-scaling) or a regression back to scaling only in
 *  the accessor, which a pure-accessor unit test cannot.
 *
 *  Samples the down and the move as TWO separate `inputSystem` ticks (not one sample after both
 *  DOM events have already fired): `pointerSource`'s edge-latching FIFO (see its header comment)
 *  reports a queued down transition's OWN coordinates on the frame that drains it, then falls
 *  back to level state on the next sample — so collapsing a down+move into one un-ticked sample
 *  would misreport the move's position as the press point, which is the coordinate-space bug
 *  this fix closes (docs/todo.md), not what this test is pinning. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld, type World } from 'koota';
import { pointerSource } from '../../src/runtime/input/pointerSource';
import { Input, pointer, pointerDrag, pointerPos } from '../../src/runtime/traits/Input';
import { inputSystem } from '../../src/runtime/input/inputSystem';
import { __setBaseDprForTest } from '../../src/runtime/input/presentationScale';

function firePointer(type: string, x: number, y: number, pointerId = 1): void {
  const ev = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }) as MouseEvent & { pointerId: number };
  (ev as { pointerId: number }).pointerId = pointerId;
  window.dispatchEvent(ev);
}
const setDpr = (v: number) => { (window as unknown as { devicePixelRatio: number }).devicePixelRatio = v; };

let world: World;
beforeEach(() => {
  world = createWorld();
  world.spawn(Input);
  setDpr(1);
  __setBaseDprForTest(1); // display scale 1, zoom 1
  pointerSource.attach();
});
afterEach(() => { pointerSource.detach(); setDpr(1); __setBaseDprForTest(1); });

describe('pointerDrag presentation-invariant end-to-end', () => {
  it('the same physical drag yields the same pointerDrag magnitude at zoom 0 and zoomed in', () => {
    // At zoom 1: a 100px drag reads 100 both via the accessor and the raw field — they now
    // agree, because inputSystem is the ONLY place that writes dragX/dragY. Sample the down
    // and the move as two separate ticks — the FIFO drains the down transition (its own point,
    // drag 0) on the first, then falls back to level state (the move) on the second.
    firePointer('pointerdown', 200, 300);
    inputSystem(world);
    firePointer('pointermove', 300, 300);
    inputSystem(world);
    expect(pointerDrag(world).x).toBeCloseTo(100, 6);
    expect(pointer(world).dragX).toBeCloseTo(100, 6); // same field, same value — no second meaning
    pointerSource.detach();

    // At zoom 1.44 the SAME physical drag is fewer CSS px (~69.4) at the DOM/source level;
    // inputSystem scales it back to ~100 when it merges into Input, so every reader of
    // Input.pointer.dragX — the accessor or a direct field read — sees the zoom-0 magnitude.
    const w2 = createWorld(); w2.spawn(Input); pointerSource.attach();
    setDpr(1.44);
    const rawUnderZoom = 100 / 1.44;
    firePointer('pointerdown', 200, 300);
    inputSystem(w2);
    firePointer('pointermove', 200 + rawUnderZoom, 300);
    inputSystem(w2);
    expect(pointerDrag(w2).x).toBeCloseTo(100, 2);          // normalized back to ~100
    expect(pointer(w2).dragX).toBeCloseTo(100, 2);          // same value via the raw field
    expect(pointerPos(w2).x).toBeCloseTo(200 + rawUnderZoom, 3); // position stays RAW (for raycast)
  });
});
