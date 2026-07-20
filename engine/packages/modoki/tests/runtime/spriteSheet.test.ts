import { describe, it, expect } from 'vitest';
import {
  gridSliceRects, gridSlices, clampRect, isValidRect, makeSlice, findSlice,
  inferGridFromRects, DEFAULT_PIVOT, type SpriteSlice,
} from '../../src/runtime/loaders/spriteSheet';

describe('gridSliceRects — by count', () => {
  it('tiles a 4x4 grid edge-to-edge with no padding', () => {
    const rects = gridSliceRects({ imgW: 256, imgH: 256, cols: 4, rows: 4 });
    expect(rects).toHaveLength(16);
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 64, h: 64 });
    expect(rects[15]).toEqual({ x: 192, y: 192, w: 64, h: 64 });
  });

  it('is row-major (left→right, top→bottom)', () => {
    const rects = gridSliceRects({ imgW: 200, imgH: 100, cols: 2, rows: 1 });
    expect(rects.map((r) => r.x)).toEqual([0, 100]);
  });

  it('accounts for padding between cells', () => {
    // 3 cols across 100px with 10px gaps → cellW = (100 - 20)/3 = 26 (floored)
    const rects = gridSliceRects({ imgW: 100, imgH: 30, cols: 3, rows: 1, paddingX: 10 });
    expect(rects[0]).toMatchObject({ x: 0, w: 26 });
    expect(rects[1].x).toBe(36); // 26 + 10
  });
});

describe('gridSliceRects — by cell size', () => {
  it('packs as many whole cells as fit', () => {
    const rects = gridSliceRects({ imgW: 250, imgH: 64, cellW: 64, cellH: 64 });
    expect(rects).toHaveLength(3); // 192 ≤ 250 < 256
    expect(rects[2]).toEqual({ x: 128, y: 0, w: 64, h: 64 });
  });

  it('honors an outer offset', () => {
    const rects = gridSliceRects({ imgW: 200, imgH: 64, cellW: 64, cellH: 64, offsetX: 8 });
    expect(rects[0].x).toBe(8);
  });

  it('drops partial edge cells instead of keeping a clamped sliver', () => {
    // A 64px cell with offset 40 on a 100px-wide image: the cell would span
    // 40..104, overhanging the 100px edge. It must be dropped, not clamped to a
    // 60px sliver — every emitted cell is a full cellW×cellH.
    const rects = gridSliceRects({ imgW: 100, imgH: 64, cellW: 64, cellH: 64, offsetX: 40 });
    expect(rects).toHaveLength(0);
    for (const r of rects) { expect(r.w).toBe(64); expect(r.h).toBe(64); }
  });

  it('keeps only whole cells when padding pushes the last one past the edge', () => {
    // 3 cells of 30 + 2 pads of 20 = 130 > 100 → only the cells that fully fit remain.
    const rects = gridSliceRects({ imgW: 100, imgH: 30, cellW: 30, cellH: 30, paddingX: 20 });
    for (const r of rects) { expect(r.x + r.w).toBeLessThanOrEqual(100); expect(r.w).toBe(30); }
  });
});

describe('inferGridFromRects — reverse-engineer grid params', () => {
  it('returns null for no rects', () => {
    expect(inferGridFromRects([])).toBeNull();
  });

  it('round-trips a clean grid (gridSliceRects → infer)', () => {
    const rects = gridSliceRects({ imgW: 256, imgH: 128, cols: 4, rows: 2 });
    const g = inferGridFromRects(rects)!;
    expect(g.cols).toBe(4);
    expect(g.rows).toBe(2);
    expect(g.cellW).toBe(64);
    expect(g.cellH).toBe(64);
    expect(g.offsetX).toBe(0);
    expect(g.offsetY).toBe(0);
    expect(g.paddingX).toBe(0);
    expect(g.paddingY).toBe(0);
  });

  it('recovers offset + padding', () => {
    // 3 cols of 30 with 10px gaps, starting at x=5; one row of 16 at y=8.
    const rects = [
      { x: 5, y: 8, w: 30, h: 16 },
      { x: 45, y: 8, w: 30, h: 16 },
      { x: 85, y: 8, w: 30, h: 16 },
    ];
    const g = inferGridFromRects(rects)!;
    expect(g.cols).toBe(3);
    expect(g.rows).toBe(1);
    expect(g.cellW).toBe(30);
    expect(g.cellH).toBe(16);
    expect(g.offsetX).toBe(5);
    expect(g.offsetY).toBe(8);
    expect(g.paddingX).toBe(10);
    expect(g.paddingY).toBe(0);
  });

  it('clusters a single sprite to a 1×1 grid', () => {
    const g = inferGridFromRects([{ x: 12, y: 20, w: 40, h: 50 }])!;
    expect(g.cols).toBe(1);
    expect(g.rows).toBe(1);
    expect(g.cellW).toBe(40);
    expect(g.offsetX).toBe(12);
    expect(g.offsetY).toBe(20);
  });
});

describe('gridSlices — GUID + name stability', () => {
  it('mints names from a base and index', () => {
    const slices = gridSlices({ imgW: 128, imgH: 64, cols: 2, rows: 1 }, 'coin');
    expect(slices.map((s) => s.name)).toEqual(['coin_0', 'coin_1']);
    expect(slices[0].guid).not.toBe(slices[1].guid);
    expect(slices[0].pivot).toEqual(DEFAULT_PIVOT);
  });

  it('reuses prior GUIDs/names/pivots for the most-overlapping cell on re-slice', () => {
    const prior: SpriteSlice[] = [
      { guid: 'keep-0', name: 'renamed', rect: { x: 0, y: 0, w: 1, h: 1 }, pivot: { x: 0, y: 1 } },
    ];
    const slices = gridSlices({ imgW: 128, imgH: 64, cols: 2, rows: 1 }, 'coin', prior);
    expect(slices[0].guid).toBe('keep-0');
    expect(slices[0].name).toBe('renamed');
    expect(slices[0].pivot).toEqual({ x: 0, y: 1 });
    expect(slices[1].name).toBe('coin_1'); // fresh
  });

  it('keeps a GUID on its image region when the column count changes', () => {
    // 2×1 grid on 128×64 → cells at x=0 and x=64. Re-slice as 4×1 (cells of 32).
    // The GUID that owned the right half (x=64) must stay on a right-half cell, not
    // get reassigned by index to a left cell — overlap matching, not positional.
    const prior = gridSlices({ imgW: 128, imgH: 64, cols: 2, rows: 1 }, 'coin');
    const rightGuid = prior[1].guid; // owned x=64..128
    const reslice = gridSlices({ imgW: 128, imgH: 64, cols: 4, rows: 1 }, 'coin', prior);
    const owner = reslice.find((s) => s.guid === rightGuid);
    expect(owner).toBeDefined();
    expect(owner!.rect.x).toBeGreaterThanOrEqual(64); // still a right-half cell
  });
});

describe('clampRect / isValidRect', () => {
  it('clamps a rect overhanging the image', () => {
    expect(clampRect({ x: 100, y: 100, w: 200, h: 200 }, 128, 128)).toEqual({ x: 100, y: 100, w: 28, h: 28 });
  });
  it('returns null for a zero/negative-area rect', () => {
    expect(clampRect({ x: 200, y: 0, w: 10, h: 10 }, 128, 128)).toBeNull();
  });
  it('validates in-bounds rects', () => {
    expect(isValidRect({ x: 0, y: 0, w: 128, h: 128 }, 128, 128)).toBe(true);
    expect(isValidRect({ x: 1, y: 0, w: 128, h: 128 }, 128, 128)).toBe(false);
  });
});

describe('makeSlice / findSlice', () => {
  it('mints a fresh GUID and defaults pivot to center', () => {
    const s = makeSlice('a', { x: 0, y: 0, w: 10, h: 10 });
    expect(s.guid).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.pivot).toEqual(DEFAULT_PIVOT);
  });
  it('finds by guid', () => {
    const a = makeSlice('a', { x: 0, y: 0, w: 1, h: 1 });
    const b = makeSlice('b', { x: 1, y: 1, w: 1, h: 1 });
    expect(findSlice([a, b], b.guid)).toBe(b);
    expect(findSlice([a, b], 'nope')).toBeUndefined();
  });
});
