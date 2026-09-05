/** canvas2DRouting unit tests — verifies Renderable2D entities resolve to their
 *  nearest Canvas2D ancestor. This is the routing that both Scene2D (runtime) and
 *  the editor SceneView overlay use; the bug it guards against is every 2D object
 *  collapsing onto the first canvas instead of its own parent canvas. */

import { describe, it, expect } from 'vitest';
import { findCanvasAncestor, Orphan2DTracker, orphan2DFallbackKey } from '../../src/runtime/rendering/canvas2DRouting';

describe('findCanvasAncestor', () => {
  it('returns null when the entity has no Canvas2D ancestor', () => {
    const parentOf = new Map<number, number>([[2, 1], [1, 0]]);
    const canvasIds = new Set<number>(); // no canvases at all
    expect(findCanvasAncestor(2, parentOf, canvasIds)).toBeNull();
  });

  it('resolves a direct child to its parent canvas', () => {
    const parentOf = new Map<number, number>([[7, 17], [17, 0]]);
    const canvasIds = new Set<number>([17]);
    expect(findCanvasAncestor(7, parentOf, canvasIds)).toBe(17);
  });

  it('resolves a deeply nested descendant to the nearest canvas', () => {
    // 8 -> 1 -> 17(canvas)
    const parentOf = new Map<number, number>([[8, 1], [1, 17], [17, 0]]);
    const canvasIds = new Set<number>([17]);
    expect(findCanvasAncestor(8, parentOf, canvasIds)).toBe(17);
  });

  it('resolves an entity that is itself a Canvas2D to itself', () => {
    const parentOf = new Map<number, number>([[17, 0]]);
    const canvasIds = new Set<number>([17]);
    expect(findCanvasAncestor(17, parentOf, canvasIds)).toBe(17);
  });

  it('picks the NEAREST canvas when ancestors nest two canvases', () => {
    // child 5 -> innerCanvas 4 -> outerCanvas 2 -> root 0
    const parentOf = new Map<number, number>([[5, 4], [4, 2], [2, 0]]);
    const canvasIds = new Set<number>([4, 2]);
    expect(findCanvasAncestor(5, parentOf, canvasIds)).toBe(4);
  });

  it('routes siblings of different canvases independently (the reported bug)', () => {
    // Mirrors the "2D Animation" scene:
    //   Game Canvas (17): demo(1), Square(7), Metal(8 -> demo 1)
    //   "2D" canvas (20): Circle(19)
    const parentOf = new Map<number, number>([
      [1, 17], [7, 17], [8, 1], [17, 0],
      [19, 20], [20, 0],
    ]);
    const canvasIds = new Set<number>([17, 20]);
    expect(findCanvasAncestor(1, parentOf, canvasIds)).toBe(17);  // demo
    expect(findCanvasAncestor(7, parentOf, canvasIds)).toBe(17);  // Square 2D
    expect(findCanvasAncestor(8, parentOf, canvasIds)).toBe(17);  // Metal (nested)
    expect(findCanvasAncestor(19, parentOf, canvasIds)).toBe(20); // Circle 2D -> its OWN canvas, not the first one
  });

  it('treats parentId 0 (root) as having no canvas ancestor', () => {
    const parentOf = new Map<number, number>([[5, 0]]);
    const canvasIds = new Set<number>([17]);
    expect(findCanvasAncestor(5, parentOf, canvasIds)).toBeNull();
  });

  it('terminates on a cyclic parent chain instead of looping forever', () => {
    const parentOf = new Map<number, number>([[1, 2], [2, 1]]); // 1 <-> 2 cycle, no canvas
    const canvasIds = new Set<number>([99]);
    expect(findCanvasAncestor(1, parentOf, canvasIds)).toBeNull();
  });

  it('finds the canvas even when a cycle exists below it', () => {
    // 3 -> 17(canvas), but 3 also self-cycles via a stray entry shouldn't matter
    const parentOf = new Map<number, number>([[3, 17], [17, 0]]);
    const canvasIds = new Set<number>([17]);
    expect(findCanvasAncestor(3, parentOf, canvasIds)).toBe(17);
  });

  it('treats a missing parent entry as root (no ancestor)', () => {
    const parentOf = new Map<number, number>(); // entity 5 unknown
    const canvasIds = new Set<number>([17]);
    expect(findCanvasAncestor(5, parentOf, canvasIds)).toBeNull();
  });

  // The `visited` out-param is what Scene2D's per-frame cache layer uses to cache
  // the whole walked path → resolved canvas in one pass (so siblings sharing
  // intermediate ancestors short-circuit). It must list every NON-canvas entity
  // walked, in order, and exclude the resolved canvas itself.
  describe('visited out-param (Scene2D path-caching layer)', () => {
    it('collects the walked path excluding the resolved canvas', () => {
      // 8 -> 1 -> 17(canvas)
      const parentOf = new Map<number, number>([[8, 1], [1, 17], [17, 0]]);
      const canvasIds = new Set<number>([17]);
      const visited: number[] = [];
      expect(findCanvasAncestor(8, parentOf, canvasIds, visited)).toBe(17);
      expect(visited).toEqual([8, 1]); // not 17 — the canvas returns early
    });

    it('collects nothing when the entity is itself a canvas', () => {
      const parentOf = new Map<number, number>([[17, 0]]);
      const canvasIds = new Set<number>([17]);
      const visited: number[] = [];
      expect(findCanvasAncestor(17, parentOf, canvasIds, visited)).toBe(17);
      expect(visited).toEqual([]);
    });

    it('collects the full no-ancestor path (so it caches as "none")', () => {
      const parentOf = new Map<number, number>([[5, 3], [3, 0]]);
      const canvasIds = new Set<number>([17]);
      const visited: number[] = [];
      expect(findCanvasAncestor(5, parentOf, canvasIds, visited)).toBeNull();
      expect(visited).toEqual([5, 3]);
    });

    it('lists each cyclic member at most once and still terminates', () => {
      const parentOf = new Map<number, number>([[1, 2], [2, 1]]); // 1 <-> 2 cycle
      const canvasIds = new Set<number>([99]);
      const visited: number[] = [];
      expect(findCanvasAncestor(1, parentOf, canvasIds, visited)).toBeNull();
      expect(visited).toEqual([1, 2]); // no duplicates, no infinite loop
    });
  });
});

describe('Orphan2DTracker', () => {
  it('warns exactly once per orphaning, at the configured frame count', () => {
    const t = new Orphan2DTracker();
    expect(t.note(1, () => 'guid-1', 3)).toBeNull(); // frame 1
    expect(t.note(1, () => 'guid-1', 3)).toBeNull(); // frame 2
    expect(t.note(1, () => 'guid-1', 3)).toBe('guid-1'); // frame 3 — crosses the threshold
    expect(t.note(1, () => 'guid-1', 3)).toBeNull(); // frame 4 — already warned
  });

  it('clear() forgets a recovered entity so a later re-orphaning warns again', () => {
    const t = new Orphan2DTracker();
    t.note(1, () => 'guid-1', 1);
    t.clear(1, () => 'guid-1');
    expect(t.note(1, () => 'guid-1', 1)).toBe('guid-1'); // warns again
  });

  // The bug this guards: `frames` is keyed by the numeric entity id, which koota recycles. An
  // entity that dies while still orphaned never calls clear() (it never recovers, it's gone), so
  // its count sat in `frames` forever — the next entity koota hands that SAME id inherited a
  // count >= afterFrames and could never again hit note()'s exact-equality trigger.
  it('an entity that dies orphaned (no clear()) leaves a stale count for the id koota recycles', () => {
    const t = new Orphan2DTracker();
    // Entity id 1 orphans for 2 frames, warns, then DIES — no clear() call, ever.
    t.note(1, () => 'dead-guid', 2);
    t.note(1, () => 'dead-guid', 2); // warns
    // koota recycles id 1 for a brand-new entity with its own guid. `frames.get(1)` is already 2
    // (>= afterFrames) here, so every subsequent call only grows it further — it can never again
    // land exactly on `afterFrames`, and the new entity that owns this id can never warn.
    expect(t.note(1, () => 'new-guid', 2)).toBeNull(); // frame 1 for the NEW entity — should warn here
    expect(t.note(1, () => 'new-guid', 2)).toBeNull(); // frame 2 — still nothing
    expect(t.note(1, () => 'new-guid', 2)).toBeNull(); // frame 3 — and never will
  });

  it('prune() forgets a dead id, unblocking the new entity that recycles it', () => {
    const t = new Orphan2DTracker();
    t.note(1, () => 'dead-guid', 2);
    t.note(1, () => 'dead-guid', 2); // warns; entity 1 then dies with no clear()
    t.prune(new Set()); // entity 1 is no longer alive — sweep drops its stale count
    expect(t.note(1, () => 'new-guid', 2)).toBeNull(); // frame 1 for the recycled id
    expect(t.note(1, () => 'new-guid', 2)).toBe('new-guid'); // frame 2 — warns right on schedule
  });

  it('prune() leaves counts for ids still in aliveIds untouched', () => {
    const t = new Orphan2DTracker();
    t.note(1, () => 'guid-1', 3);
    t.note(1, () => 'guid-1', 3); // frame 2, not yet warned
    t.prune(new Set([1])); // still alive — must not reset the count
    expect(t.note(1, () => 'guid-1', 3)).toBe('guid-1'); // frame 3 — still crosses on schedule
  });

  it('prune() is a no-op on an empty tracker', () => {
    const t = new Orphan2DTracker();
    expect(() => t.prune(new Set())).not.toThrow();
  });

  // #700 (second half): `warned` has the SAME id-recycling collision as `frames` — a guid-less
  // orphan warns under an `id:<n>` fallback key (`orphan2DFallbackKey`), dies without a
  // recovering `clear()` call, and koota then hands its numeric id to an unrelated new entity.
  // Before this fix, the surviving `id:<n>` key in `warned` silenced that new entity FOREVER —
  // `note()` never returns the key a second time once it's in `warned`, and nothing ever removed
  // it. `prune()` must drop it exactly like it drops the stale `frames` count.
  it('prune() forgets a dead id:<n> warned key, letting the entity that recycles the id warn again', () => {
    const t = new Orphan2DTracker();
    const deadKey = orphan2DFallbackKey(1);
    expect(t.note(1, () => deadKey, 1)).toBe(deadKey); // entity 1 warns once, then dies — no clear()

    t.prune(new Set()); // entity 1 is no longer alive

    // koota recycles id 1 for a brand-new entity, also guid-less (same fallback KEY FORM).
    const newKey = orphan2DFallbackKey(1);
    expect(newKey).toBe(deadKey); // same string — this is exactly the collision
    expect(t.note(1, () => newKey, 1)).toBe(newKey); // must warn again for the new occupant
  });

  it('prune() leaves a warned GUID key alone — a guid never recycles, so it is not id-keyed', () => {
    const t = new Orphan2DTracker();
    expect(t.note(1, () => 'guid-1', 1)).toBe('guid-1'); // warns under a guid key
    t.prune(new Set()); // entity 1 no longer alive by id — must NOT touch the guid key
    // Warned-again would return null (already warned) if the guid key survived; it does.
    expect(t.note(1, () => 'guid-1', 1)).toBeNull();
  });

  it('prune() leaves warned id:<n> keys for ids still in aliveIds untouched', () => {
    const t = new Orphan2DTracker();
    const key = orphan2DFallbackKey(2);
    expect(t.note(2, () => key, 1)).toBe(key);
    t.prune(new Set([2])); // id 2 still alive — its warned key must survive
    expect(t.note(2, () => key, 1)).toBeNull(); // still warned — not reset by the prune
  });
});
