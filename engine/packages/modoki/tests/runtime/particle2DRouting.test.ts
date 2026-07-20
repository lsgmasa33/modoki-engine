/** particle2DRouting unit tests — the SINGLE routing predicate both particle sync
 *  passes (3D `particleSync`, 2D `particleSync2D`) agree on: does an emitter render in
 *  2D (has a Canvas2D ancestor) or 3D (does not)?
 *
 *  `emitterCanvasId` is the pure core (over Canvas2DRoute maps) and reuses
 *  findCanvasAncestor, so most cases assert it directly; one `buildCanvas2DRoute` case
 *  covers the real-world snapshot build (EntityAttributes.parentId + Canvas2D query),
 *  including the reused out-object clear+repopulate contract. */

import { describe, it, expect } from 'vitest';
import { createWorld } from 'koota';
import { buildCanvas2DRoute, emitterCanvasId, type Canvas2DRoute } from '../../src/runtime/rendering/particle2DRouting';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Canvas2D } from '../../src/runtime/traits/Canvas2D';

const route = (parentOf: [number, number][], canvasIds: number[]): Canvas2DRoute => ({
  parentOf: new Map(parentOf),
  canvasIds: new Set(canvasIds),
});

describe('emitterCanvasId (pure predicate over Canvas2DRoute)', () => {
  it('routes an emitter directly under a Canvas2D to that canvas (→ 2D)', () => {
    const r = route([[7, 17], [17, 0]], [17]);
    expect(emitterCanvasId(r, 7)).toBe(17);
  });

  it('routes an emitter nested under a non-canvas group under a Canvas2D to the canvas', () => {
    // emitter 8 -> group 1 -> canvas 17
    const r = route([[8, 1], [1, 17], [17, 0]], [17]);
    expect(emitterCanvasId(r, 8)).toBe(17);
  });

  it('routes a bare emitter (parentId 0, no Canvas2D ancestor) to null (→ 3D)', () => {
    const r = route([[5, 0]], [17]);
    expect(emitterCanvasId(r, 5)).toBeNull();
  });

  it('routes an emitter with no parent entry at all to null (→ 3D)', () => {
    const r = route([], []);
    expect(emitterCanvasId(r, 5)).toBeNull();
  });

  it('resolves an entity that IS a Canvas2D to itself', () => {
    const r = route([[17, 0]], [17]);
    expect(emitterCanvasId(r, 17)).toBe(17);
  });

  it('resolves to the NEAREST Canvas2D when two nest', () => {
    // emitter 5 -> inner canvas 4 -> outer canvas 2
    const r = route([[5, 4], [4, 2], [2, 0]], [4, 2]);
    expect(emitterCanvasId(r, 5)).toBe(4);
  });
});

describe('buildCanvas2DRoute (snapshot from a live koota world)', () => {
  it('routes emitters over a real hierarchy: direct, nested, bare, and self-canvas', () => {
    const world = createWorld();
    // canvas 2D host
    const canvas = world.spawn(EntityAttributes({ parentId: 0 }), Canvas2D());
    const canvasId = canvas.id();
    // direct child emitter under the canvas
    const direct = world.spawn(EntityAttributes({ parentId: canvasId }));
    // non-canvas group under the canvas, with a nested emitter beneath it
    const group = world.spawn(EntityAttributes({ parentId: canvasId }));
    const nested = world.spawn(EntityAttributes({ parentId: group.id() }));
    // bare emitter at the root (no canvas ancestor)
    const bare = world.spawn(EntityAttributes({ parentId: 0 }));

    const r = buildCanvas2DRoute(world);

    expect(r.canvasIds.has(canvasId)).toBe(true);
    expect(emitterCanvasId(r, direct.id())).toBe(canvasId);
    expect(emitterCanvasId(r, nested.id())).toBe(canvasId);
    expect(emitterCanvasId(r, bare.id())).toBeNull();
    // the canvas entity itself resolves to itself
    expect(emitterCanvasId(r, canvasId)).toBe(canvasId);
  });

  it('reuses an out-object, clearing and repopulating correctly across two builds', () => {
    const world = createWorld();
    const canvasA = world.spawn(EntityAttributes({ parentId: 0 }), Canvas2D());
    const emitterA = world.spawn(EntityAttributes({ parentId: canvasA.id() }));

    const out: Canvas2DRoute = { parentOf: new Map(), canvasIds: new Set() };
    const first = buildCanvas2DRoute(world, out);
    // Same underlying objects reused (no per-frame allocation), populated from the world.
    expect(first.parentOf).toBe(out.parentOf);
    expect(first.canvasIds).toBe(out.canvasIds);
    expect(out.canvasIds.has(canvasA.id())).toBe(true);
    expect(out.parentOf.get(emitterA.id())).toBe(canvasA.id());
    expect(emitterCanvasId(out, emitterA.id())).toBe(canvasA.id());

    // Rebuild the SAME out-object over a FRESH empty world: everything from the first
    // build must be cleared (not accumulated), leaving empty maps.
    buildCanvas2DRoute(createWorld(), out);
    expect(out.canvasIds.size).toBe(0);
    expect(out.parentOf.size).toBe(0);
    expect(emitterCanvasId(out, emitterA.id())).toBeNull();

    // And a third build over a populated world repopulates the cleared out correctly.
    const world3 = createWorld();
    const canvasC = world3.spawn(EntityAttributes({ parentId: 0 }), Canvas2D());
    const emitterC = world3.spawn(EntityAttributes({ parentId: canvasC.id() }));
    const bareC = world3.spawn(EntityAttributes({ parentId: 0 }));
    buildCanvas2DRoute(world3, out);
    expect(out.canvasIds.has(canvasC.id())).toBe(true);
    expect(emitterCanvasId(out, emitterC.id())).toBe(canvasC.id());
    expect(emitterCanvasId(out, bareC.id())).toBeNull();
  });
});
