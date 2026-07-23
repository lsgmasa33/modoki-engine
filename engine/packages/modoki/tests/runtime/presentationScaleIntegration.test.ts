// @vitest-environment jsdom
/** Integration: presentation-invariant drag END-TO-END through the real path
 *  (browser PointerEvent -> pointerSource.sample -> Input resource -> pointerDrag accessor),
 *  not just the accessor in isolation. Pins the seam between the source (which writes a RAW
 *  clientX delta) and the accessor (which applies the presentation scale): the frame stays raw,
 *  the accessor normalizes. This catches a future double-scale (source pre-scaling) or a consumer
 *  reading frame.pointer.dragX directly, which the accessor-only unit test cannot. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld, type World } from 'koota';
import { pointerSource } from '../../src/runtime/input/pointerSource';
import { Input, getInput, pointerDrag, pointerPos } from '../../src/runtime/traits/Input';
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
    // At zoom 1: a 100px drag reads 100 both raw and normalized.
    firePointer('pointerdown', 200, 300);
    firePointer('pointermove', 300, 300);
    const frame = getInput(world)!;
    pointerSource.sample(frame);
    expect(frame.pointer.dragX).toBeCloseTo(100, 6);   // raw
    expect(pointerDrag(world).x).toBeCloseTo(100, 6);  // normalized (scale 1)
    pointerSource.detach();

    // At zoom 1.44 the SAME physical drag is fewer CSS px (~69.4); the FRAME stays raw, the
    // accessor scales it back to ~100 so game feel is unchanged.
    const w2 = createWorld(); w2.spawn(Input); pointerSource.attach();
    setDpr(1.44);
    const rawUnderZoom = 100 / 1.44;
    firePointer('pointerdown', 200, 300);
    firePointer('pointermove', 200 + rawUnderZoom, 300);
    const f2 = getInput(w2)!;
    pointerSource.sample(f2);
    expect(f2.pointer.dragX).toBeCloseTo(rawUnderZoom, 3); // RAW ~69.4 (scale lives in the accessor only)
    expect(pointerDrag(w2).x).toBeCloseTo(100, 2);         // normalized back to ~100
    expect(pointerPos(w2).x).toBeCloseTo(200 + rawUnderZoom, 3); // position stays RAW (for raycast)
  });
});
