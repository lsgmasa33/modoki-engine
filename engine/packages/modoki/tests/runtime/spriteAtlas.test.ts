import { describe, it, expect } from 'vitest';
import { packAtlas, type PackInput, type PackedFrame } from '../../src/runtime/loaders/spriteAtlas';

/** Two INNER content rects overlap (any shared area)? */
function overlaps(a: PackedFrame, b: PackedFrame): boolean {
  if (a.page !== b.page) return false;
  return !(a.rect.x + a.rect.w <= b.rect.x || b.rect.x + b.rect.w <= a.rect.x ||
           a.rect.y + a.rect.h <= b.rect.y || b.rect.y + b.rect.h <= a.rect.y);
}

/** Minimum gap (px) between two content rects on the same page (0 if they touch/overlap
 *  on an axis). For non-overlapping rects this is the separating-axis distance. */
function gap(a: PackedFrame, b: PackedFrame): number {
  const dx = Math.max(b.rect.x - (a.rect.x + a.rect.w), a.rect.x - (b.rect.x + b.rect.w));
  const dy = Math.max(b.rect.y - (a.rect.y + a.rect.h), a.rect.y - (b.rect.y + b.rect.h));
  return Math.max(dx, dy);
}

function mk(n: number, w: number, h: number): PackInput[] {
  return Array.from({ length: n }, (_, i) => ({ guid: `s${i.toString().padStart(3, '0')}`, w, h }));
}

describe('packAtlas', () => {
  it('places every member with no overlap', () => {
    const frames = packAtlas(mk(20, 30, 30), { pageSize: 256, padding: 2, extrude: 1 });
    expect(frames.overflow).toEqual([]);
    expect(frames.frames).toHaveLength(20);
    for (let i = 0; i < frames.frames.length; i++) {
      for (let j = i + 1; j < frames.frames.length; j++) {
        expect(overlaps(frames.frames[i], frames.frames[j])).toBe(false);
      }
    }
  });

  it('keeps content rects separated by at least padding + 2*extrude', () => {
    const padding = 4, extrude = 2;
    const r = packAtlas(mk(16, 28, 28), { pageSize: 256, padding, extrude });
    const f = r.frames;
    for (let i = 0; i < f.length; i++) {
      for (let j = i + 1; j < f.length; j++) {
        if (f[i].page !== f[j].page) continue;
        // Adjacent (touching on one axis) rects must be at least the full gutter apart.
        expect(gap(f[i], f[j])).toBeGreaterThanOrEqual(padding + 2 * extrude);
      }
    }
  });

  it('preserves each member size and offsets content by extrude from the page edge', () => {
    const r = packAtlas([{ guid: 'a', w: 17, h: 23 }], { pageSize: 64, padding: 3, extrude: 5 });
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0].rect).toMatchObject({ x: 5, y: 5, w: 17, h: 23 });
  });

  it('snaps page dimensions up to a multiple of 4 and never exceeds pageSize', () => {
    const r = packAtlas(mk(4, 30, 30), { pageSize: 256, padding: 1, extrude: 1 });
    for (const p of r.pages) {
      expect(p.w % 4).toBe(0);
      expect(p.h % 4).toBe(0);
      expect(p.w).toBeLessThanOrEqual(256);
      expect(p.h).toBeLessThanOrEqual(256);
    }
  });

  it('spills onto additional pages when one page is full', () => {
    // 64x64 sprites on a 128 page → at most 4 per page (2x2), so 10 need ≥3 pages.
    const r = packAtlas(mk(10, 64, 64), { pageSize: 128, padding: 0, extrude: 0 });
    expect(r.overflow).toEqual([]);
    const pageCount = new Set(r.frames.map((f) => f.page)).size;
    expect(pageCount).toBeGreaterThanOrEqual(3);
    expect(r.pages).toHaveLength(pageCount);
  });

  it('reports overflow for members that exceed maxPages', () => {
    const r = packAtlas(mk(10, 64, 64), { pageSize: 128, padding: 0, extrude: 0, maxPages: 1 });
    // Page fits 4; the remaining 6 overflow.
    expect(r.frames.filter((f) => f.page === 0)).toHaveLength(4);
    expect(r.overflow).toHaveLength(6);
  });

  it('reports a member larger than a whole page as overflow', () => {
    const r = packAtlas([{ guid: 'big', w: 300, h: 10 }, { guid: 'ok', w: 10, h: 10 }],
      { pageSize: 256, padding: 0, extrude: 0 });
    expect(r.overflow).toContain('big');
    expect(r.frames.map((f) => f.spriteGuid)).toContain('ok');
  });

  it('is deterministic — identical input yields identical layout', () => {
    const opts = { pageSize: 256, padding: 2, extrude: 1 };
    const inputs = [
      { guid: 'c', w: 40, h: 20 }, { guid: 'a', w: 20, h: 40 },
      { guid: 'b', w: 30, h: 30 }, { guid: 'd', w: 50, h: 50 },
    ];
    expect(packAtlas(inputs, opts)).toEqual(packAtlas([...inputs].reverse(), opts));
  });
});
