/** Frame2D — a subtree fitted to what is on screen of its canvas (rendering/frame2D.ts + core/ecs/localFit2D.ts),
 *  applied in the world-transform pass and never written to the authored Transform. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld, type World } from 'koota';

import { Canvas2D, EntityAttributes, Frame2D, Transform } from '../../src/runtime/traits';
import { transformPropagationSystem, worldTransforms } from '../../src/runtime/core/ecs/transformPropagationSystem';
import { getWorldTransform3D } from '../../src/runtime/core/ecs/worldTransform';
import { localFit2DOf } from '../../src/runtime/core/ecs/localFit2D';
import {
  designToFrame2D, forgetCanvasView2D, frame2DFit, frame2DVisibleLocal, publishCanvasView2D, visibleDesignRect,
} from '../../src/runtime/rendering/frame2D';
import { computeCanvasScale } from '../../src/runtime/rendering/canvas2DScaler';

describe('frame2DFit', () => {
  const view = { left: 0, top: -100, right: 1000, bottom: 2100 };   // 1000 x 2200
  it('cover fills the view, cropping the longer axis, centred', () => {
    const f = frame2DFit(view, 500, 500, 'cover');
    expect(f.kx).toBeCloseTo(4.4);
    expect(f.ky).toBe(f.kx);
    expect(f.x).toBeCloseTo((1000 - 2200) / 2);
    expect(f.y).toBeCloseTo(-100);
  });
  it('contain fits inside, banding the other axis; align picks the edge', () => {
    const f = frame2DFit(view, 500, 500, 'contain', 0.5, 1);
    expect(f.kx).toBeCloseTo(2);
    expect([f.x, f.y]).toEqual([0, 2100 - 1000]);
  });
  it('stretch matches the view on each axis', () => {
    const f = frame2DFit(view, 500, 1100, 'stretch');
    expect([f.x, f.y, f.kx, f.ky]).toEqual([0, -100, 2, 2]);
  });
  it('a degenerate box or view is the identity', () => {
    expect(frame2DFit(view, 0, 500, 'cover')).toEqual({ x: 0, y: 0, kx: 1, ky: 1 });
    expect(frame2DFit({ left: 0, top: 0, right: 0, bottom: 10 }, 5, 5, 'cover')).toEqual({ x: 0, y: 0, kx: 1, ky: 1 });
  });
});

describe('visibleDesignRect', () => {
  it('a tall phone under contain shows more design space above and below the reference', () => {
    // 1080 x 1920 design on a 420 x 912 canvas: contain scales by 420/1080, so 912 px show 2345 design px.
    const s = computeCanvasScale(1080, 1920, 420, 912, 'contain');
    const r = visibleDesignRect(s, 420, 912);
    expect(r.left).toBeCloseTo(0);
    expect(r.right).toBeCloseTo(1080);
    expect(r.bottom - r.top).toBeCloseTo(912 * 1080 / 420);
    expect((r.top + r.bottom) / 2).toBeCloseTo(960);
  });
});

describe('Frame2D in the world-transform pass', () => {
  let w: World;
  beforeEach(() => { w = createWorld(); forgetCanvasView2D(); });
  afterEach(() => { w.destroy(); forgetCanvasView2D(); });

  function scene(frame: Partial<{ width: number; height: number; fit: 'cover' | 'contain' | 'stretch' }> = {}) {
    const canvas = w.spawn(Canvas2D({ referenceWidth: 1000, referenceHeight: 2000 }), EntityAttributes({ name: 'Canvas', parentId: 0 }));
    const host = w.spawn(Transform({ x: 0, y: 0, sx: 1, sy: 1 }), Frame2D({ width: 500, height: 500, fit: 'cover', ...frame }), EntityAttributes({ name: 'Frame', parentId: canvas.id() }));
    const kid = w.spawn(Transform({ x: 100, y: 50, sx: 1, sy: 1 }), EntityAttributes({ name: 'Kid', parentId: host.id() }));
    return { canvas, host, kid };
  }

  it('fits the frame to the canvas (its reference rect, with no renderer) and its children ride along', () => {
    const { host, kid } = scene();
    transformPropagationSystem(w);
    // 500 x 500 covering 1000 x 2000: k = 4, centred across x (-500), flush on y.
    const h = worldTransforms.get(host.id())!;
    expect([h.x, h.y, h.sx, h.sy]).toEqual([-500, 0, 4, 4]);
    const k = worldTransforms.get(kid.id())!;
    expect(k.x).toBeCloseTo(-500 + 400);
    expect(k.y).toBeCloseTo(200);
    expect(k.sx).toBeCloseTo(4);
    // The authored Transform is untouched.
    expect(host.get(Transform)!.sx).toBe(1);
    expect(host.get(Transform)!.x).toBe(0);
  });

  it('follows the canvas when what is on screen changes, even with nothing else moving', () => {
    const { canvas, host } = scene();
    transformPropagationSystem(w);
    publishCanvasView2D(canvas, { left: 0, top: -250, right: 1000, bottom: 2250 });
    transformPropagationSystem(w);
    const h = worldTransforms.get(host.id())!;
    expect(h.sx).toBeCloseTo(5);
    expect(h.y).toBeCloseTo(-250);
  });

  it('the on-demand world pose agrees with the cache', () => {
    const { kid } = scene();
    transformPropagationSystem(w);
    const on = getWorldTransform3D(kid.id(), w);
    const c = worldTransforms.get(kid.id())!;
    expect([on.x, on.y, on.sx]).toEqual([expect.closeTo(c.x), expect.closeTo(c.y), expect.closeTo(c.sx)]);
  });

  it('reports what is on screen in the frame\'s own space, and maps a design point into it', () => {
    const { host } = scene();
    transformPropagationSystem(w);
    const v = frame2DVisibleLocal(host)!;
    expect(v.left).toBeCloseTo(125);
    expect(v.right).toBeCloseTo(375);
    expect([v.top, v.bottom]).toEqual([0, 500]);
    expect(designToFrame2D(host, -500, 0)).toEqual({ x: 0, y: 0 });
  });

  it('on a wide screen the height is the cropped axis: what shows is the middle band of the box', () => {
    const { canvas, host } = scene();
    publishCanvasView2D(canvas, { left: 0, top: 0, right: 2000, bottom: 1000 });
    transformPropagationSystem(w);
    // k = max(2000/500, 1000/500) = 4: the box is 2000 tall, centred on a 1000-tall view.
    const v = frame2DVisibleLocal(host)!;
    expect([v.left, v.right]).toEqual([0, 500]);
    expect(v.top).toBeCloseTo(125);
    expect(v.bottom).toBeCloseTo(375);
  });

  it('an entity that recycles a destroyed frame\'s index does not inherit its fit before the next pass', () => {
    const { host } = scene();
    transformPropagationSystem(w);
    const id = host.id();
    host.destroy();
    const heir = w.spawn(Transform({ x: 3, y: 4, sx: 1, sy: 1 }), EntityAttributes({ name: 'Heir', parentId: 0 }));
    expect(heir.id()).toBe(id);
    const on = getWorldTransform3D(heir.id(), w);
    expect([on.x, on.y, on.sx]).toEqual([3, 4, 1]);
  });

  // The fit COMPOSES with the frame's own Transform (fit · local), it does not replace or add to it: a host that is
  // itself moved and scaled is the only case that tells `fit.x + kx * x` from `fit.x + x` (review, 2026-10-01).
  it('composes with the frame\'s own Transform, in the cache and the on-demand pose alike', () => {
    const { host, kid } = scene();
    host.set(Transform, { ...host.get(Transform)!, x: 10, y: 20, sx: 2, sy: 2 });
    transformPropagationSystem(w);
    const h = worldTransforms.get(host.id())!;
    expect([h.x, h.y, h.sx, h.sy]).toEqual([-500 + 4 * 10, 4 * 20, 8, 8]);
    const k = worldTransforms.get(kid.id())!;
    expect([k.x, k.y]).toEqual([expect.closeTo(-460 + 8 * 100), expect.closeTo(80 + 8 * 50)]);
    const on = getWorldTransform3D(host.id(), w);
    expect([on.x, on.y, on.sx]).toEqual([expect.closeTo(-460), expect.closeTo(80), expect.closeTo(8)]);
  });

  // The fit is made in the canvas's design space and applied in the parent's, so only a direct child of the canvas
  // can be fitted. Under a moved group it would land off by the group's pose (review: x -400 for -500), so a nested
  // Frame2D is refused — composed as before — and said so, once.
  it('a Frame2D below the canvas\'s direct children is not fitted, and warns once', () => {
    const { canvas } = scene();
    const group = w.spawn(Transform({ x: 100, y: 0, sx: 1, sy: 1 }), EntityAttributes({ name: 'Group', parentId: canvas.id() }));
    const nested = w.spawn(Transform({ x: 0, y: 0, sx: 1, sy: 1 }), Frame2D({ width: 500, height: 500 }), EntityAttributes({ name: 'Nested', parentId: group.id() }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      transformPropagationSystem(w);
      transformPropagationSystem(w);
      const n = worldTransforms.get(nested.id())!;
      expect([n.x, n.y, n.sx]).toEqual([100, 0, 1]);
      expect(localFit2DOf(nested.valueOf() as number)).toBeUndefined();
      const said = warn.mock.calls.filter((c) => String(c[0]).includes('"Nested" is not a direct child'));
      expect(said).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('an entity without Frame2D, or a frame under no canvas, composes as before', () => {
    const lone = w.spawn(Transform({ x: 7, y: 9, sx: 1, sy: 1 }), Frame2D({ width: 500, height: 500 }), EntityAttributes({ name: 'Lone', parentId: 0 }));
    transformPropagationSystem(w);
    const l = worldTransforms.get(lone.id())!;
    expect([l.x, l.y, l.sx]).toEqual([7, 9, 1]);
  });
});
