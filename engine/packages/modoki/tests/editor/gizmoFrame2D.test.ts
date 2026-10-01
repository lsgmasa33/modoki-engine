/** The 2D gizmo on a Frame2D entity (#1926 close-out review): the drag runs in world space and is mapped back into
 *  the frame the entity's LOCAL Transform lives in — its parent with its own fit composed in (`localFrame2D`).
 *  Inverting the bare parent wrote the fitted pose into the authored Transform, which the next pass fitted again. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, type World } from 'koota';

import { Canvas2D, EntityAttributes, Frame2D, Transform } from '../../src/runtime/traits';
import { transformPropagationSystem, worldTransforms } from '../../src/runtime/core/ecs/transformPropagationSystem';
import { localFit2DOf } from '../../src/runtime/core/ecs/localFit2D';
import { forgetCanvasView2D } from '../../src/runtime/rendering/frame2D';
import { localFrame2D, worldToLocal2D, type Transform2D } from '../../src/editor/panels/Gizmo2D';

describe('localFrame2D — the frame a fitted entity\'s Transform lives in', () => {
  let w: World;
  beforeEach(() => { w = createWorld(); forgetCanvasView2D(); });
  afterEach(() => { w.destroy(); forgetCanvasView2D(); });

  it('a drag on the fitted host moves it by the drag, as drawn, and the authored Transform by drag / fit', () => {
    const canvas = w.spawn(Canvas2D({ referenceWidth: 1000, referenceHeight: 2000 }), EntityAttributes({ name: 'Canvas', parentId: 0 }));
    // 500 x 500 covering 1000 x 2000: k = 4, x -500 (the review's scenario).
    const host = w.spawn(Transform({ x: 0, y: 0, sx: 1, sy: 1 }), Frame2D({ width: 500, height: 500, fit: 'cover' }), EntityAttributes({ name: 'Frame', parentId: canvas.id() }));
    transformPropagationSystem(w);
    const start = worldTransforms.get(host.id())!;
    expect([start.x, start.sx]).toEqual([-500, 4]);

    // What SceneView does: the canvas has no Transform, so the parent world is null.
    const worldNew: Transform2D = { x: start.x + 10, y: start.y, rz: start.rz, sx: start.sx, sy: start.sy };
    const local = worldToLocal2D(worldNew, localFrame2D(null, localFit2DOf(host.valueOf() as number)));
    host.set(Transform, { ...host.get(Transform)!, x: local.x });
    transformPropagationSystem(w);
    expect(host.get(Transform)!.x).toBeCloseTo(2.5);
    expect(worldTransforms.get(host.id())!.x).toBeCloseTo(-490);
  });

  it('round-trips a local pose under a moved, rotated, scaled parent', () => {
    const parent: Transform2D = { x: 30, y: -12, rz: 0.4, sx: 2, sy: 3 };
    const fit = { x: -500, y: 40, kx: 4, ky: 1.5 };
    const local: Transform2D = { x: 7, y: -9, rz: 0.25, sx: 1.2, sy: 0.8 };
    // The runtime's composition: fit · local, then the parent (transformPropagationSystem).
    const fx = fit.x + fit.kx * local.x, fy = fit.y + fit.ky * local.y;
    const c = Math.cos(parent.rz), s = Math.sin(parent.rz);
    const world: Transform2D = {
      x: parent.x + (parent.sx * fx) * c - (parent.sy * fy) * s,
      y: parent.y + (parent.sx * fx) * s + (parent.sy * fy) * c,
      rz: parent.rz + local.rz, sx: parent.sx * fit.kx * local.sx, sy: parent.sy * fit.ky * local.sy,
    };
    const back = worldToLocal2D(world, localFrame2D(parent, fit));
    for (const k of ['x', 'y', 'rz', 'sx', 'sy'] as const) expect(back[k]).toBeCloseTo(local[k]);
  });

  it('is the parent unchanged when the entity has no fit', () => {
    const parent: Transform2D = { x: 1, y: 2, rz: 0.3, sx: 2, sy: 2 };
    expect(localFrame2D(parent, undefined)).toBe(parent);
    expect(localFrame2D(null, undefined)).toBeNull();
  });
});
