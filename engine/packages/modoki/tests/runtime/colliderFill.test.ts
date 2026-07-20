/** drawColliderFillGfx — the sprite='collider' render helper (visible body for
 *  polygon/polyline/concave colliders). Recorded against a mock GraphicsLike so the emitted
 *  path is asserted deterministically (the Canvas + Pixi variants share colliderOutline2D,
 *  so this also pins the shared geometry). */

import { describe, it, expect } from 'vitest';
import { drawColliderFillGfx, colliderOutlineSig, type GraphicsLike } from '../../src/runtime/rendering/render2DUtils';

function recorder() {
  const ops: string[] = [];
  const g: GraphicsLike = {
    rect: (x, y, w, h) => (ops.push(`rect ${x} ${y} ${w} ${h}`), g),
    moveTo: (x, y) => (ops.push(`moveTo ${x} ${y}`), g),
    lineTo: (x, y) => (ops.push(`lineTo ${x} ${y}`), g),
    closePath: () => (ops.push('close'), g),
    ellipse: (x, y, rw, rh) => (ops.push(`ellipse ${x} ${y} ${rw} ${rh}`), g),
    fill: (c) => (ops.push(`fill ${c}`), g),
    stroke: (s) => (ops.push(`stroke ${s.width} ${s.color}`), g),
  };
  return { g, ops };
}
const base = { radius: 0, halfW: 0, halfH: 0, points: '' };

describe('drawColliderFillGfx', () => {
  it('fills a polygon: moveTo, lineTos, close, fill', () => {
    const { g, ops } = recorder();
    drawColliderFillGfx(g, { ...base, shape: 'polygon', points: '[[-10,-10],[10,-10],[0,10]]' }, 0x123456);
    expect(ops).toEqual(['moveTo -10 -10', 'lineTo 10 -10', 'lineTo 0 10', 'close', 'fill 1193046']);
  });

  it('fills a circle as an ellipse', () => {
    const { g, ops } = recorder();
    drawColliderFillGfx(g, { ...base, shape: 'circle', radius: 25 }, 0xff0000);
    expect(ops).toEqual(['ellipse 0 0 25 25', `fill ${0xff0000}`]);
  });

  it('strokes a polyline (open edge chain), no fill', () => {
    const { g, ops } = recorder();
    drawColliderFillGfx(g, { ...base, shape: 'polyline', points: '[[-10,0],[0,10],[10,0]]' }, 0x00ff00);
    expect(ops[0]).toBe('moveTo -10 0');
    expect(ops.some((o) => o.startsWith('stroke'))).toBe(true);
    expect(ops.some((o) => o.startsWith('fill'))).toBe(false);
  });

  it('fills a concave shape as its authored (concave) polygon outline', () => {
    const { g, ops } = recorder();
    drawColliderFillGfx(g, { ...base, shape: 'concave', points: '[[-10,-10],[10,-10],[10,10],[0,0],[-10,10]]' }, 1);
    expect(ops[0]).toBe('moveTo -10 -10');
    expect(ops.filter((o) => o.startsWith('lineTo')).length).toBe(4);
    expect(ops).toContain('close');
  });

  it('colliderOutlineSig changes with the point list', () => {
    const a = colliderOutlineSig({ shape: 'polygon', radius: 0, halfW: 0, halfH: 0, points: '[[0,0]]' });
    const b = colliderOutlineSig({ shape: 'polygon', radius: 0, halfW: 0, halfH: 0, points: '[[1,0]]' });
    expect(a).not.toBe(b);
  });
});
