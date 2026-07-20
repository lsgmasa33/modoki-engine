/** 2D primitive geometry — single source of truth (was F7 editor-vs-runtime parity).
 *
 *  There used to be TWO 2D renderers (the PixiJS runtime + the editor's DOM Canvas2D SceneView),
 *  each with a `drawPrimitiveShape*` emitter; this test asserted the two agreed. The SceneView is
 *  now PixiJS too (the Canvas2D twins were retired in the Pixi cutover), so there's a SINGLE emitter
 *  (`drawPrimitiveShapeGfx`) — no cross-backend drift to guard. What remains worth pinning: the Pixi
 *  emitter faithfully reproduces the shared geometry (`computeShapeGeometry` / `computePivotOffset`),
 *  and the shared sprite-scale contract, so a refactor of the geometry helpers can't silently shift a
 *  vertex under the (now sole) renderer. */

import { describe, it, expect } from 'vitest';
import {
  computePivotOffset,
  computeShapeGeometry,
  computeSpriteScale,
  drawPrimitiveShapeGfx,
  type GraphicsLike,
  type ShapeGeometry,
} from '../../src/runtime/rendering/render2DUtils';
import type { PrimitiveShape } from '../../src/runtime/rendering/renderUtils';

type Call = [string, ...number[]];

/** Records the path ops issued against a PixiJS Graphics. */
function recordingGfx(): { calls: Call[]; gfx: GraphicsLike } {
  const calls: Call[] = [];
  const gfx: GraphicsLike = {
    rect: (...a: number[]) => { calls.push(['rect', ...a]); return gfx; },
    moveTo: (...a: number[]) => { calls.push(['moveTo', ...a]); return gfx; },
    lineTo: (...a: number[]) => { calls.push(['lineTo', ...a]); return gfx; },
    ellipse: (...a: number[]) => { calls.push(['ellipse', ...a]); return gfx; },
    closePath: () => gfx,
    fill: () => gfx,
  };
  return { calls, gfx };
}

/** Keep only vertex-emitting ops. */
function vertices(calls: Call[]): Call[] {
  return calls.filter(c => c[0] === 'rect' || c[0] === 'moveTo' || c[0] === 'lineTo' || c[0] === 'ellipse');
}

/** The vertices we EXPECT from a ShapeGeometry — the single source of truth the emitter reproduces. */
function expectedVertices(geo: ShapeGeometry): Call[] {
  if (geo.kind === 'rect') return [['rect', geo.x, geo.y, geo.w, geo.h]];
  if (geo.kind === 'triangle') {
    return [['moveTo', geo.ax, geo.ay], ['lineTo', geo.bx, geo.by], ['lineTo', geo.cx, geo.cy]];
  }
  return [['ellipse', geo.cx, geo.cy, geo.rx, geo.ry]];
}

describe('render2D primitive geometry (single source of truth)', () => {
  const shapes: PrimitiveShape[] = ['square', 'triangle', 'circle'];
  // A spread of half-extents and pivots, incl. asymmetric + edge pivots.
  const samples = [
    { w: 50, h: 30, px: 0.5, py: 0.5 },
    { w: 50, h: 30, px: 0, py: 0 },
    { w: 50, h: 30, px: 1, py: 1 },
    { w: 100, h: 200, px: 0.25, py: 0.75 },
    { w: 12, h: 12, px: 0.5, py: 0.5 },
  ];

  for (const shape of shapes) {
    for (const s of samples) {
      it(`${shape} @ pivot(${s.px},${s.py}) ${s.w}x${s.h}: the Pixi emitter reproduces the shared geometry`, () => {
        const { ox, oy } = computePivotOffset(s.w, s.h, s.px, s.py);
        const geo = computeShapeGeometry(shape, s.w, s.h, ox, oy);

        const { calls: gfxCalls, gfx } = recordingGfx();
        drawPrimitiveShapeGfx(gfx, shape, s.w, s.h, ox, oy, 0xabcdef);

        expect(vertices(gfxCalls)).toEqual(expectedVertices(geo));
      });
    }
  }

  it('triangle pivot offset matches the old inline runtime math (w - w*2*px)', () => {
    // The runtime previously wrote the triangle apex as moveTo(w - w*2*px, oy). That must equal the
    // shared geometry's ax = w + ox where ox = -w*2*px. Pin it so a refactor of computePivotOffset/
    // computeShapeGeometry can't quietly shift the apex.
    const w = 80, h = 40, px = 0.3, py = 0.6;
    const { ox } = computePivotOffset(w, h, px, py);
    const geo = computeShapeGeometry('triangle', w, h, ox, 0);
    expect(geo.kind).toBe('triangle');
    if (geo.kind === 'triangle') expect(geo.ax).toBeCloseTo(w - w * 2 * px);
  });

  it('sprite scale is shared (single source — no second copy to drift)', () => {
    // Scene2D reads computeSpriteScale; assert the keepAspect contract the runtime relies on
    // (uniform = min of the two axis scales).
    const a = computeSpriteScale(100, 50, 200, 200, false);
    expect([a.scaleX, a.scaleY]).toEqual([1, 0.5]);
    const b = computeSpriteScale(100, 50, 200, 200, true);
    expect([b.scaleX, b.scaleY]).toEqual([0.5, 0.5]);
  });
});
