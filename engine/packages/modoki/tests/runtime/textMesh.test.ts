/** buildTextGeometry tests — vertex/UV/index layout, Y-down vs Y-up, index type
 *  promotion. A single quad is enough to pin every corner exactly. */

import { describe, it, expect } from 'vitest';
import { buildTextGeometry, buildTextGeometryByPage, buildTextPositionsByPage, buildTextColorsByPage } from '../../src/runtime/rendering/text/textMesh';
import type { TextQuad } from '../../src/runtime/rendering/text/layoutText';

const quad: TextQuad = { unicode: 65, x0: 10, y0: 0, x1: 60, y1: 80, u0: 0, v0: 0, u1: 0.5, v1: 0.8, page: 0 };

describe('buildTextGeometry', () => {
  it('emits 4 verts + 6 indices per quad in TL,TR,BR,BL order (Y-down)', () => {
    const g = buildTextGeometry([quad]);
    expect(g.vertexCount).toBe(4);
    expect(g.positions).toEqual(new Float32Array([10, 0, 60, 0, 60, 80, 10, 80]));
    expect(g.uvs).toEqual(new Float32Array([0, 0, 0.5, 0, 0.5, 0.8, 0, 0.8]));
    // two triangles: TL,BL,BR / TL,BR,TR
    expect(Array.from(g.indices)).toEqual([0, 3, 2, 0, 2, 1]);
  });

  it('negates Y when yUp', () => {
    const g = buildTextGeometry([quad], { yUp: true });
    // y0=0 → -0, y1=80 → -80
    expect(g.positions).toEqual(new Float32Array([10, -0, 60, -0, 60, -80, 10, -80]));
  });

  it('flips V when flipV', () => {
    const g = buildTextGeometry([quad], { flipV: true });
    expect(g.uvs).toEqual(new Float32Array([0, 1, 0.5, 1, 0.5, 0.2, 0, 0.2]));
  });

  it('offsets indices per quad', () => {
    const g = buildTextGeometry([quad, { ...quad }]);
    expect(g.vertexCount).toBe(8);
    expect(Array.from(g.indices).slice(6)).toEqual([4, 7, 6, 4, 6, 5]);
  });

  it('uses Uint16 indices under the quad cap, Uint32 above', () => {
    expect(buildTextGeometry([quad]).indices).toBeInstanceOf(Uint16Array);
    const many = Array.from({ length: 16384 }, () => quad); // 65536 verts > 65535
    expect(buildTextGeometry(many).indices).toBeInstanceOf(Uint32Array);
  });

  it('handles an empty quad list', () => {
    const g = buildTextGeometry([]);
    expect(g.vertexCount).toBe(0);
    expect(g.positions).toHaveLength(0);
    expect(g.indices).toHaveLength(0);
    expect(g.colors).toHaveLength(0);
  });

  it('emits white per-vertex colours by default, the quad colour when set', () => {
    const white = buildTextGeometry([quad]);
    expect(Array.from(white.colors)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]); // 4 verts × RGBA
    const tinted = buildTextGeometry([{ ...quad, color: [1, 0, 0, 0.5] }]);
    // every vertex of the glyph carries the same colour
    for (let v = 0; v < 4; v++) {
      expect(Array.from(tinted.colors).slice(v * 4, v * 4 + 4)).toEqual([1, 0, 0, 0.5]);
    }
  });
});

describe('buildTextGeometryByPage', () => {
  it('returns one geometry for single-page (all page 0) text — the baked path', () => {
    const pages = buildTextGeometryByPage([quad, { ...quad }]);
    expect(pages).toHaveLength(1);
    expect(pages[0].page).toBe(0);
    expect(pages[0].geo.vertexCount).toBe(8);
  });

  it('groups quads by page, ascending, each geometry holding only its page\'s quads', () => {
    const q0 = { ...quad, page: 0 };
    const q2 = { ...quad, page: 2, x0: 100 };
    const q1 = { ...quad, page: 1 };
    // interleaved + out of order → still grouped + sorted 0,1,2
    const pages = buildTextGeometryByPage([q2, q0, q1, { ...q0 }]);
    expect(pages.map((p) => p.page)).toEqual([0, 1, 2]);
    expect(pages[0].geo.vertexCount).toBe(8); // two page-0 quads
    expect(pages[1].geo.vertexCount).toBe(4);
    expect(pages[2].geo.vertexCount).toBe(4);
    // page-2 geometry carries the page-2 quad's x0, not page-0's
    expect(pages[2].geo.positions[0]).toBe(100);
  });

  it('handles an empty quad list', () => {
    expect(buildTextGeometryByPage([])).toEqual([]);
  });
});

describe('buildTextPositionsByPage (animation hot path)', () => {
  const q0 = { ...quad, page: 0 };
  const q1 = { ...quad, page: 1, x0: 100 };

  it('matches buildTextGeometryByPage positions per page (same grouping/order/Y-flip)', () => {
    for (const opts of [{}, { yUp: true }]) {
      const full = buildTextGeometryByPage([q1, q0, { ...q0 }], opts);
      const posOnly = buildTextPositionsByPage([q1, q0, { ...q0 }], opts);
      expect(posOnly.map((p) => p.page)).toEqual(full.map((p) => p.page)); // 0,1
      posOnly.forEach((p, i) => expect(p.positions).toEqual(full[i].geo.positions));
    }
  });

  it('handles an empty quad list', () => {
    expect(buildTextPositionsByPage([])).toEqual([]);
  });
});

describe('buildTextColorsByPage (colour animation hot path)', () => {
  const q0 = { ...quad, page: 0, color: [1, 0, 0, 1] as const };
  const q1 = { ...quad, page: 1 }; // no colour → white

  it('emits per-page colour buffers grouped/ordered by page (default white)', () => {
    const out = buildTextColorsByPage([q1, q0]);
    expect(out.map((p) => p.page)).toEqual([0, 1]);
    expect(Array.from(out[0].colors).slice(0, 4)).toEqual([1, 0, 0, 1]); // page-0 tinted
    expect(Array.from(out[1].colors).slice(0, 4)).toEqual([1, 1, 1, 1]); // page-1 white
  });

  it('handles an empty quad list', () => {
    expect(buildTextColorsByPage([])).toEqual([]);
  });
});
