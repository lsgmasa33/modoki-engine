/** canvas2DRouting unit tests — verifies Renderable2D entities resolve to their
 *  nearest Canvas2D ancestor. This is the routing that both Scene2D (runtime) and
 *  the editor SceneView overlay use; the bug it guards against is every 2D object
 *  collapsing onto the first canvas instead of its own parent canvas. */

import { describe, it, expect } from 'vitest';
import { findCanvasAncestor } from '../../src/runtime/rendering/canvas2DRouting';

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
