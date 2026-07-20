/** layout-bounds — the response-shape contract (docs/mcp-response-budget.md Phase 4).
 *
 *  This was the largest payload in the entire agent surface: ~74k tokens on a 241-entity
 *  scene, of which the O(n²) overlapping-PAIR list alone outweighed every rect combined.
 *  An untargeted call now reports COUNTS; rects and pairs are opt-in.
 *
 *  The load-bearing constraint is NOT the size — it's that `computeLayoutBounds` is a shared
 *  producer. `diagnose.ts:72` calls it with NO params and reads `.offScreen.length`. Summarize
 *  that key away and `modoki_diagnose` breaks in the field, silently, long before a test
 *  notices. So `offScreen` (and `zeroSize`) stay arrays, always. */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestWorld, type TestWorld, EntityAttributes } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { computeLayoutBounds } from '../../app/debug/layoutDump';

registerAllTraits();

let game: TestWorld | undefined;
afterEach(() => {
  game?.dispose(); game = undefined;
  document.querySelectorAll('[data-entity-id]').forEach((el) => el.remove());
});

/** A `ui`-layer entity backed by a real DOM node with a stubbed rect — the path
 *  computeLayoutBounds takes for UI (`getBoundingClientRect` per `[data-entity-id]`). */
function spawnUI(name: string, rect: { x: number; y: number; w: number; h: number }): number {
  const id = game!.spawn(EntityAttributes({ name, layer: 'ui' })).id();
  const el = document.createElement('div');
  el.setAttribute('data-entity-id', String(id));
  el.getBoundingClientRect = () => ({
    left: rect.x, top: rect.y, width: rect.w, height: rect.h,
    right: rect.x + rect.w, bottom: rect.y + rect.h, x: rect.x, y: rect.y, toJSON: () => ({}),
  }) as DOMRect;
  document.body.appendChild(el);
  return id;
}

beforeEach(() => {
  game = createTestWorld({});
});

describe('computeLayoutBounds — untargeted returns counts, not rects', () => {
  it('omits entities[] and overlaps[], reports their counts', () => {
    spawnUI('A', { x: 0, y: 0, w: 100, h: 100 });
    spawnUI('B', { x: 50, y: 50, w: 100, h: 100 }); // overlaps A

    const d = computeLayoutBounds();
    expect(d.count).toBe(2);
    expect(d.entities).toBeUndefined();  // the rects
    expect(d.overlaps).toBeUndefined();  // the O(n²) pair list
    expect(d.overlapsCount).toBe(1);     // ...but the count survives
    expect(d.layerCounts).toEqual({ ui: 2 });
    expect(d.hint).toContain('overlaps=true');
  });

  it('ALWAYS returns offScreen as an id array — diagnose.ts reads .offScreen.length', () => {
    spawnUI('Visible', { x: 0, y: 0, w: 10, h: 10 });
    const hidden = spawnUI('Collapsed', { x: 0, y: 0, w: 0, h: 0 });

    const d = computeLayoutBounds(); // exactly how diagnose.ts calls it
    expect(Array.isArray(d.offScreen)).toBe(true);
    expect(d.offScreen).toContain(hidden);
    expect(d.offScreenCount).toBe(1);
    expect(() => d.offScreen.length).not.toThrow();
  });

  it('reports zeroSize ids — the "collapsed to nothing" answer, without the rects', () => {
    const collapsed = spawnUI('Zero', { x: 5, y: 5, w: 0, h: 20 });
    spawnUI('Fine', { x: 0, y: 0, w: 10, h: 10 });
    const d = computeLayoutBounds();
    expect(d.zeroSize).toEqual([collapsed]);
    expect(d.zeroSizeCount).toBe(1);
  });
});

describe('computeLayoutBounds — opting back into the expensive parts', () => {
  it('ids= implies per-entity rects', () => {
    const a = spawnUI('A', { x: 1, y: 2, w: 3, h: 4 });
    spawnUI('B', { x: 0, y: 0, w: 1, h: 1 });
    const d = computeLayoutBounds({ ids: [a] });
    expect(d.entities).toHaveLength(1);
    expect(d.entities![0].screen).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it('layer= implies per-entity rects', () => {
    spawnUI('A', { x: 0, y: 0, w: 5, h: 5 });
    expect(computeLayoutBounds({ layer: 'ui' }).entities).toHaveLength(1);
  });

  it('entities=true forces rects on an untargeted call', () => {
    spawnUI('A', { x: 0, y: 0, w: 5, h: 5 });
    expect(computeLayoutBounds({ entities: true }).entities).toHaveLength(1);
  });

  it('overlaps=true materializes the pair list, and it agrees with overlapsCount', () => {
    const a = spawnUI('A', { x: 0, y: 0, w: 100, h: 100 });
    const b = spawnUI('B', { x: 50, y: 50, w: 100, h: 100 });
    spawnUI('Far', { x: 900, y: 900, w: 10, h: 10 }); // disjoint

    const d = computeLayoutBounds({ overlaps: true });
    expect(d.overlaps).toEqual([{ a, b, layer: 'ui' }]);
    expect(d.overlapsCount).toBe(d.overlaps!.length);
  });

  it('a nested child inside its parent is not an overlap', () => {
    const parent = game!.spawn(EntityAttributes({ name: 'Parent', layer: 'ui' })).id();
    const pel = document.createElement('div');
    pel.setAttribute('data-entity-id', String(parent));
    pel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(pel);

    const child = game!.spawn(EntityAttributes({ name: 'Child', layer: 'ui', parentId: parent })).id();
    const cel = document.createElement('div');
    cel.setAttribute('data-entity-id', String(child));
    cel.getBoundingClientRect = () => ({ left: 10, top: 10, width: 20, height: 20, right: 30, bottom: 30, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(cel);

    expect(computeLayoutBounds({ overlaps: true }).overlapsCount).toBe(0);
  });
});
