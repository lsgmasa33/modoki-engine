/** atlasAllocator — forward shelf growth, then LRU eviction with a free-list once the
 *  atlas is full. Pinning (the ASCII seed) and per-batch protection are honored. Pure,
 *  so no canvas/WASM needed. */

import { describe, it, expect } from 'vitest';
import { AtlasAllocator } from '../../src/runtime/rendering/text/atlasAllocator';

// A 100×100 single page, no gap, 40×40 cells fits exactly 4 cells before it's full:
//   (0,0) (40,0)            [80+40 > 100 → wrap to next row]
//   (0,40)(40,40)           [next row y=80: 80+40 > 100 → spill; maxPages 1 → full]
const SIZE = 100, GAP = 0, PAGES = 1, W = 40, H = 40, CAP = 4;
const NONE = new Set<number>();

/** Fill the page with cps 1..CAP (all forward allocs, no eviction). */
function fillPage(a: AtlasAllocator, pin = false) {
  const cells = [];
  for (let cp = 1; cp <= CAP; cp++) {
    const r = a.alloc(cp, W, H, pin, NONE);
    expect(r).not.toBeNull();
    expect(r!.reused).toBe(false);
    expect(r!.evicted).toEqual([]);
    cells.push(r!.cell);
  }
  return cells;
}

describe('atlasAllocator', () => {
  it('grows forward without eviction until the page is full', () => {
    const a = new AtlasAllocator(SIZE, GAP, PAGES);
    const cells = fillPage(a);
    expect(cells[0]).toMatchObject({ page: 0, x: 0, y: 0 });
    expect(cells[1]).toMatchObject({ page: 0, x: 40, y: 0 });
    expect(cells[2]).toMatchObject({ page: 0, x: 0, y: 40 }); // wrapped
    expect(a.slotCount).toBe(CAP);
    expect(a.freeCount).toBe(0);
  });

  it('evicts the least-recently-used slot when full and reuses its cell', () => {
    const a = new AtlasAllocator(SIZE, GAP, PAGES);
    fillPage(a); // cps 1..4, lastUsed ascending → cp1 oldest
    const r = a.alloc(5, W, H, false, NONE);
    expect(r).not.toBeNull();
    expect(r!.reused).toBe(true);
    expect(r!.evicted).toEqual([1]);          // LRU victim
    expect(r!.cell).toMatchObject({ page: 0, x: 0, y: 0 }); // cp1's recycled cell
    expect(a.has(1)).toBe(false);
    expect(a.has(5)).toBe(true);
    expect(a.slotCount).toBe(CAP);            // one out, one in
    expect(a.freeCount).toBe(0);
  });

  it('touch() refreshes recency so a touched slot is not the next victim', () => {
    const a = new AtlasAllocator(SIZE, GAP, PAGES);
    fillPage(a);
    a.touch(1);                                // cp1 now newest
    const r = a.alloc(5, W, H, false, NONE);
    expect(r!.evicted).toEqual([2]);           // cp2 is now the oldest
    expect(a.has(1)).toBe(true);
  });

  it('never evicts a pinned slot', () => {
    const a = new AtlasAllocator(SIZE, GAP, PAGES);
    a.alloc(1, W, H, /* pin */ true, NONE);    // cp1 pinned (oldest)
    for (let cp = 2; cp <= CAP; cp++) a.alloc(cp, W, H, false, NONE);
    const r = a.alloc(5, W, H, false, NONE);
    expect(r!.evicted).toEqual([2]);           // skips pinned cp1 → cp2
    expect(a.has(1)).toBe(true);
  });

  it('never evicts a slot in the protect set', () => {
    const a = new AtlasAllocator(SIZE, GAP, PAGES);
    fillPage(a);
    const r = a.alloc(5, W, H, false, new Set([1, 2])); // protect the two oldest
    expect(r!.evicted).toEqual([3]);           // → next oldest unprotected
    expect(a.has(1)).toBe(true);
    expect(a.has(2)).toBe(true);
  });

  it('returns null when full and every slot is pinned/protected', () => {
    const a = new AtlasAllocator(SIZE, GAP, PAGES);
    fillPage(a, /* pin */ true);               // all 4 pinned
    const r = a.alloc(5, W, H, false, NONE);
    expect(r).toBeNull();
    expect(a.has(5)).toBe(false);
    expect(a.slotCount).toBe(CAP);             // nothing evicted
  });

  it('recycles a freed cell at its full capacity for a smaller glyph', () => {
    const a = new AtlasAllocator(SIZE, GAP, PAGES);
    fillPage(a);
    a.alloc(5, W, H, false, NONE);             // evicts cp1; its cell is reused (free empty)
    expect(a.freeCount).toBe(0);
    // Page is full again → a smaller glyph must evict once more (cp2, now oldest) and
    // reuses that 40×40 cell whole (capacity preserved for correct future eviction).
    const r = a.alloc(6, 20, 20, false, NONE);
    expect(r!.reused).toBe(true);
    expect(r!.evicted).toEqual([2]);
    expect(r!.cell).toMatchObject({ w: W, h: H }); // full capacity, not the 20×20 request
  });
});
