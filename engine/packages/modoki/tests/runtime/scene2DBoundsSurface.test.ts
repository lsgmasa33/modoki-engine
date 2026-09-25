/** Which BoundsSurface a `Scene2DRenderer` INSTANCE speaks for (#80).
 *
 *  The registry tests next door (`screenBounds.test.ts`) drive `registerBoundsProvider`
 *  with hand-written fake providers, so they pin the registry's behaviour but say nothing
 *  about the seam production actually uses: the renderer deciding its OWN label. That gap
 *  is exactly what #80 was — SceneView's non-primary instance registered no provider at
 *  all, and the naive fix (drop the `if (this.primary)` gate) would have made it publish
 *  rects labelled `'game-2d'`, colliding with the real GameView's. An unlabelled or
 *  mislabelled rect is indistinguishable from another provider's, which is the whole
 *  reason `BoundsSurface` exists — so the label is load-bearing, not cosmetic.
 *
 *  `boundsSurface` is the single source for BOTH the `registerBoundsProvider` argument and
 *  the per-rect `surface` stamp, precisely so those two cannot drift; this pins it for the
 *  two real instance shapes. Reached through an `as any` cast because it is `private` —
 *  TypeScript-only, erased at runtime — which is the right trade for pinning an invariant
 *  that is otherwise only observable from a live editor.
 */

import { describe, it, expect } from 'vitest';
import { createWorld } from 'koota';
import { Scene2DRenderer } from '../../src/runtime/rendering/Scene2D';
import { Canvas2DPool } from '../../src/runtime/rendering/canvas2DPool';

/** The private getter, read the way only a test may. */
const surfaceOf = (r: Scene2DRenderer): string => (r as unknown as { boundsSurface: string }).boundsSurface;

describe('Scene2DRenderer.boundsSurface (#80)', () => {
  it('the primary (runtime/GameView) renderer speaks for game-2d', () => {
    const r = new Scene2DRenderer({ pool: new Canvas2DPool(), primary: true });
    expect(surfaceOf(r)).toBe('game-2d');
  });

  it('a non-primary (editor SceneView) renderer speaks for scene-view, NOT game-2d', () => {
    const r = new Scene2DRenderer({ pool: new Canvas2DPool(), primary: false });
    // The specific regression: publishing 'game-2d' here collides with the real GameView's
    // rects, so an entity-aimed click resolved from the loser lands in the wrong panel
    // while reporting success.
    expect(surfaceOf(r)).toBe('scene-view');
  });

  it('defaults to the primary surface when `primary` is omitted', () => {
    // `this.primary = opts.primary ?? true`, so an un-flagged instance is the runtime one.
    const r = new Scene2DRenderer({ pool: new Canvas2DPool() });
    expect(surfaceOf(r)).toBe('game-2d');
  });

  it('the two shapes never claim the same surface', () => {
    const primary = new Scene2DRenderer({ pool: new Canvas2DPool(), primary: true });
    const editor = new Scene2DRenderer({ pool: new Canvas2DPool(), primary: false });
    expect(surfaceOf(primary)).not.toBe(surfaceOf(editor));
  });
});

/** #1197 — `bounds2DProvider` walks `slots` by entity id, and a slot is disposed only by the NEXT
 *  pass's sweep. koota hands a destroyed entity's index to the next spawn, so between the two an
 *  id-only provider reported the dead entity's rect under the newcomer's id. `activeIds` records which
 *  packed entity claimed each id in the last pass; the provider refuses a slot whose claimant is dead.
 *
 *  Private state is seeded directly (no PixiJS renderer, no pool canvas), so each live slot reports
 *  `screen: null` — the assertion is on WHETHER the id is reported at all, which is the whole defect. */
describe('Scene2DRenderer.bounds2DProvider — refuses a dead owner\'s slot (#1197)', () => {
  type Internals = { slots: Map<number, unknown>; activeIds: Map<number, number>; bounds2DProvider(ids?: Set<number>): Array<{ id: number }> };
  const seed = () => {
    const r = new Scene2DRenderer({ pool: new Canvas2DPool(), primary: true }) as unknown as Internals;
    const world = createWorld();
    const dead = world.spawn();
    const id = dead.id();
    r.slots.set(id, { kind: 'graphics', obj: {} });
    r.activeIds.set(id, dead.valueOf());
    return { r, world, dead, id };
  };

  it('reports the slot while its owner lives (the accept side)', () => {
    const { r, id } = seed();
    expect(r.bounds2DProvider().map((b) => b.id)).toEqual([id]);
  });

  it('reports NOTHING for the id once the owner is destroyed and a newcomer reclaims the index', () => {
    const { r, world, dead, id } = seed();
    dead.destroy();
    const fresh = world.spawn();
    expect(fresh.id()).toBe(id); // premise: the index was reclaimed
    expect(r.bounds2DProvider(new Set([id]))).toEqual([]);
  });

  it('reports nothing for a slot this pass never claimed (no owner stamp)', () => {
    const { r, id } = seed();
    r.activeIds.delete(id);
    expect(r.bounds2DProvider()).toEqual([]);
  });

  it('measures the newcomer once the next pass re-claims the id for it', () => {
    const { r, world, dead, id } = seed();
    dead.destroy();
    const fresh = world.spawn();
    r.activeIds.set(id, fresh.valueOf());
    expect(r.bounds2DProvider().map((b) => b.id)).toEqual([id]);
  });
});

/** #1563 — a 2D rect reports the canvas it was projected into, so an entity aim can keep its samples
 *  inside the host canvas instead of spending them where no press can pick it. The canvas here is
 *  offset and scaled (backing 200x100 drawn at 400x200 from (50, 30)) so a stamp of the backing size,
 *  of the origin, or of the entity's own rect would each fail. */
describe('Scene2DRenderer.bounds2DProvider — reports its drawRect (#1563)', () => {
  it('stamps the host canvas\'s client rect beside the entity\'s rect', () => {
    type Internals = { slots: Map<number, unknown>; activeIds: Map<number, number>; canvasOfEntity: Map<number, number>; pool: unknown;
      bounds2DProvider(ids?: Set<number>): Array<{ id: number; screen: unknown; drawRect?: unknown }> };
    const r = new Scene2DRenderer({ pool: new Canvas2DPool(), primary: true }) as unknown as Internals;
    const world = createWorld();
    const e = world.spawn();
    const rect = { left: 50, top: 30, width: 400, height: 200, right: 450, bottom: 230 };
    r.slots.set(e.id(), { kind: 'graphics', obj: { getBounds: () => ({ minX: 10, minY: 10, maxX: 30, maxY: 20 }) } });
    r.activeIds.set(e.id(), e.valueOf());
    r.canvasOfEntity.set(e.id(), 99);
    r.pool = { getSlot: () => ({ canvas: { isConnected: true, width: 200, height: 100, getBoundingClientRect: () => rect }, app: { renderer: { screen: { width: 200, height: 100 } } } }) };
    const [b] = r.bounds2DProvider();
    expect(b.screen).toEqual({ x: 70, y: 50, w: 40, h: 20 }); // premise: a real projection, not the null branch
    expect(b.drawRect).toEqual({ x: 50, y: 30, w: 400, h: 200 });
  });
});
