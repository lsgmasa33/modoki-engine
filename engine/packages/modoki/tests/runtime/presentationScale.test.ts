// @vitest-environment jsdom
/** Presentation-invariant input — game feel must not drift under editor/browser/OS zoom.
 *
 *  Page zoom rescales the CSS coordinate system (fewer clientX px per physical drag), so a
 *  pixel-magnitude gameplay value (sling's `dragPx × pullPerPx`) would silently weaken. The
 *  contract (module-boundaries plan, P4): `inputSystem` scales the pointer drag delta ONCE,
 *  when it merges the sampled frame into the `Input` resource — so `Input.pointer.dragX/dragY`
 *  IS the zoom-0-equivalent magnitude, and `pointerDrag` is a plain read of it, not a second
 *  scale. `pointerPos` (a position, ratio-matched to getBoundingClientRect for raycast) stays
 *  raw always. The end-to-end zoom behaviour (source → inputSystem → resource) is covered by
 *  `presentationScaleIntegration.test.ts`; this file unit-tests `getPresentationScale` itself
 *  and pins that `setPointer` (the headless test-harness setter, which bypasses inputSystem
 *  entirely) still sees/produces RAW deltas — the documented contract for headless/deterministic
 *  tests — so the accessor never re-applies scaling on top of whatever's already stored. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { Input, setPointer, pointer, pointerDrag, pointerPos } from '../../src/runtime/traits/Input';
import {
  getPresentationScale, calibratePresentationScale, __setBaseDprForTest,
} from '../../src/runtime/input/presentationScale';

const setDpr = (v: number) => { (window as unknown as { devicePixelRatio: number }).devicePixelRatio = v; };

let world: ReturnType<typeof createWorld>;
beforeEach(() => {
  world = createWorld();
  world.spawn(Input);
  setDpr(1);
  __setBaseDprForTest(1); // display scale 1, zoom 1
});
afterEach(() => { __setBaseDprForTest(1); setDpr(1); });

describe('getPresentationScale', () => {
  it('is 1 at zoom 1', () => { expect(getPresentationScale()).toBe(1); });

  it('equals the page-zoom factor via devicePixelRatio / baseDpr', () => {
    setDpr(1.44); // editor zoom level 2 on a scale-1 display
    expect(getPresentationScale()).toBeCloseTo(1.44, 6);
  });

  it('calibrate recovers the true display scale from an authoritative zoom factor', () => {
    // Simulate a retina display (base 2) already zoomed to f=1.5 at calibration time.
    setDpr(3); // 2 × 1.5
    calibratePresentationScale(1.5); // baseDpr := 3 / 1.5 = 2
    expect(getPresentationScale()).toBeCloseTo(1.5, 6);
    // Reset zoom to 1 → dpr drops to the display scale; scale must return to 1 (not < 1).
    setDpr(2);
    expect(getPresentationScale()).toBeCloseTo(1.0, 6);
  });
});

describe('defensive guards', () => {
  it('returns 1 when devicePixelRatio is a transient/invalid 0 (no divide collapse)', () => {
    setDpr(0);
    expect(getPresentationScale()).toBe(1);
  });

  it('calibrate ignores a non-positive zoom factor (no divide-by-zero / sign flip)', () => {
    setDpr(2);
    calibratePresentationScale(1); // baseDpr := 2
    calibratePresentationScale(0);  // ignored
    calibratePresentationScale(-1); // ignored
    expect(getPresentationScale()).toBeCloseTo(1, 6); // baseDpr still 2 → 2/2
  });
});

describe('pointerDrag is a plain read; setPointer (headless) stays raw regardless of zoom', () => {
  it('setPointer under a non-1 zoom still produces the RAW delta — inputSystem is the only scaler', () => {
    // setPointer is the documented headless-harness setter: it bypasses inputSystem entirely
    // (see traits/Input.ts and presentationScale.ts's own "tests ... see raw deltas" contract),
    // so even with a non-1 zoom active, the delta it derives is untouched by presentation scale.
    setDpr(1.44);
    setPointer(world, { x: 200, y: 300, down: true });   // press latches start=(200,300)
    setPointer(world, { x: 300, y: 300, down: true });   // drag → raw dragX 100, NOT scaled
    expect(pointerDrag(world).x).toBeCloseTo(100, 6);
    expect(pointer(world).dragX).toBeCloseTo(100, 6); // same value via the raw field — one meaning
  });

  it('pointerPos stays raw (viewport CSS px) so raycast against getBoundingClientRect is unaffected', () => {
    setDpr(1.44);
    setPointer(world, { x: 100, y: 400, down: true });
    setPointer(world, { x: 123, y: 456, down: true });
    expect(pointerPos(world)).toEqual({ x: 123, y: 456 }); // NOT scaled
  });
});
