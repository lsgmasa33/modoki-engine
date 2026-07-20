/** UIAnchor parity (F4): the live DOM (UINode's CSS, via applyAnchorStyle) and the
 *  editor overlay (anchorLayout.resolveAnchorRect, pixel rects) implement the SAME
 *  16-mode anchor placement in two representations. They must agree or the editor
 *  preview silently disagrees with on-device positioning. This feeds identical anchor
 *  data to both, resolves the CSS to a pixel rect with an INDEPENDENT CSS-positioning
 *  oracle (it knows generic CSS — %, calc, translate — NOT anchor semantics), and
 *  asserts the rects match. A fix to one path that misses the other fails the build. */

import { describe, it, expect } from 'vitest';
import type { CSSProperties } from 'react';
import { applyAnchorStyle, type AnchorCssData } from '../../src/runtime/ui/anchorCss';
import { resolveAnchorRect, type AnchorData } from '../../src/runtime/ui/anchorLayout';

const VPW = 400, VPH = 800, ELW = 100, ELH = 40;

const MODES = [
  'stretch', 'center', 'top', 'bottom', 'left', 'right',
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
  'top-stretch', 'bottom-stretch', 'left-stretch', 'right-stretch',
  'h-stretch', 'v-stretch',
];

function anchorData(over: Partial<AnchorData> = {}): AnchorData {
  return {
    anchor: 'center',
    top: 0, topUnit: 'px', right: 0, rightUnit: 'px',
    bottom: 0, bottomUnit: 'px', left: 0, leftUnit: 'px',
    pivotX: 0, pivotY: 0, ...over,
  };
}

// Viewport-var → px, for VPW=400, VPH=800 (matches UIRenderer's --ui-v* publishing).
const VP_PX: Record<string, number> = {
  vw: VPW / 100, vh: VPH / 100, vmin: Math.min(VPW, VPH) / 100, vmax: Math.max(VPW, VPH) / 100,
};

/** Resolve a single CSS length TERM to px: 'Npx', 'N%', or 'N * var(--ui-vX, ...)'. */
function termPx(t: string, total: number): number {
  const s = t.trim();
  const v = s.match(/^(-?\d+(?:\.\d+)?)\s*\*\s*var\(\s*--ui-(vw|vh|vmin|vmax)/);
  if (v) return Number(v[1]) * VP_PX[v[2]];
  if (s.endsWith('%')) return (parseFloat(s) / 100) * total;
  return parseFloat(s); // 'Npx' or bare number
}

/** Resolve a CSS length (number=px, term, or 'calc(B% ± term)' / 'calc(term)') against a total. */
function resolveLen(v: string | number | undefined, total: number): number {
  if (v === undefined) return 0;
  if (typeof v === 'number') return v;
  const s = v.trim();
  if (s.startsWith('calc(')) {
    const inner = s.slice(5, -1).trim();
    // base ± term, where base is always a percentage from the anchor's 50%/100% origin.
    const m = inner.match(/^(-?\d+(?:\.\d+)?%)\s*([+-])\s*(.+)$/);
    if (m) return termPx(m[1], total) + (m[2] === '-' ? -1 : 1) * termPx(m[3], total);
    return termPx(inner, total); // bare term wrapped in calc(), e.g. calc(10 * var(--ui-vw))
  }
  return termPx(s, total);
}

/** Independent CSS absolute-positioning resolver: turns the style applyAnchorStyle
 *  produced into a pixel rect, knowing only generic CSS (not anchor semantics). */
function resolveCssRect(style: CSSProperties): { x: number; y: number; w: number; h: number } {
  const s = style as Record<string, string | number | undefined>;
  let left = s.left, right = s.right, top = s.top, bottom = s.bottom;
  if (s.inset === 0 || s.inset === '0') { left = 0; right = 0; top = 0; bottom = 0; }

  // Horizontal: left+right with auto width → stretch; else natural width at left.
  let x: number, rw: number;
  if (right !== undefined && s.width === undefined) {
    x = resolveLen(left, VPW);
    rw = VPW - resolveLen(left, VPW) - resolveLen(right, VPW);
  } else { x = resolveLen(left, VPW); rw = ELW; }

  // Vertical: top+bottom with auto height → stretch; else natural height at top.
  let y: number, rh: number;
  if (bottom !== undefined && s.height === undefined) {
    y = resolveLen(top, VPH);
    rh = VPH - resolveLen(top, VPH) - resolveLen(bottom, VPH);
  } else { y = resolveLen(top, VPH); rh = ELH; }

  // transform: translate(tx%, ty%) shifts by a % of the ELEMENT box.
  if (typeof s.transform === 'string') {
    const m = s.transform.match(/translate\((-?\d+(?:\.\d+)?)%,\s*(-?\d+(?:\.\d+)?)%\)/);
    if (m) { x += (Number(m[1]) / 100) * rw; y += (Number(m[2]) / 100) * rh; }
  }
  return { x, y, w: rw, h: rh };
}

function cssRect(a: AnchorCssData) {
  const style: CSSProperties = {};
  applyAnchorStyle(style, a);
  return resolveCssRect(style);
}

function expectAgree(a: AnchorData) {
  const px = resolveAnchorRect(ELW, ELH, VPW, VPH, a);
  const css = cssRect(a);
  expect(css.x).toBeCloseTo(px.x, 5);
  expect(css.y).toBeCloseTo(px.y, 5);
  expect(css.w).toBeCloseTo(px.w, 5);
  expect(css.h).toBeCloseTo(px.h, 5);
}

describe('UIAnchor CSS ↔ pixel-rect parity (F4)', () => {
  const pivots: Array<[number, number]> = [[0, 0], [0.5, 0.5], [1, 1], [0.25, 0.75]];

  for (const mode of MODES) {
    for (const [pivotX, pivotY] of pivots) {
      it(`${mode} @ pivot(${pivotX},${pivotY})`, () => {
        expectAgree(anchorData({ anchor: mode, pivotX, pivotY }));
      });
    }
  }

  describe('with offsets', () => {
    it('px offsets off a 0 base (top-left)', () => {
      expectAgree(anchorData({ anchor: 'top-left', top: 20, left: 12, pivotX: 0, pivotY: 0 }));
    });
    it('px offset folds into calc off a 50% base (top)', () => {
      expectAgree(anchorData({ anchor: 'top', left: 12, leftUnit: 'px', pivotX: 0.5 }));
    });
    it('right offset subtracts off a 100% base (right)', () => {
      expectAgree(anchorData({ anchor: 'right', right: 8, rightUnit: 'px', pivotX: 1, pivotY: 0.5 }));
    });
    it('percent offsets (top mode, % units)', () => {
      expectAgree(anchorData({ anchor: 'top', left: 10, leftUnit: '%', pivotX: 0.5 }));
    });
    it('percent right offset off a 0 base (bottom-left)', () => {
      expectAgree(anchorData({ anchor: 'bottom-left', right: 10, rightUnit: '%', bottom: 5, bottomUnit: '%', pivotX: 0, pivotY: 1 }));
    });
    it('offsets on a stretched mode (top-stretch with top offset)', () => {
      expectAgree(anchorData({ anchor: 'top-stretch', top: 16, topUnit: 'px', pivotY: 0.5 }));
    });
  });

  describe('with viewport-unit offsets (vw/vh/vmin/vmax)', () => {
    it('vw offset off a 0 base (top-left)', () => {
      expectAgree(anchorData({ anchor: 'top-left', left: 10, leftUnit: 'vw', pivotX: 0, pivotY: 0 }));
    });
    it('vh offset folds into calc off a 50% base (left mode, top offset)', () => {
      expectAgree(anchorData({ anchor: 'left', top: 8, topUnit: 'vh', pivotY: 0.5 }));
    });
    it('vmin offset off a 100% base (right mode, subtracted)', () => {
      expectAgree(anchorData({ anchor: 'right', right: 5, rightUnit: 'vmin', pivotX: 1, pivotY: 0.5 }));
    });
    it('vmax offset off a 100% base (bottom mode)', () => {
      expectAgree(anchorData({ anchor: 'bottom', bottom: 6, bottomUnit: 'vmax', pivotX: 0.5, pivotY: 1 }));
    });
    it('mixed vw left + vh top on center', () => {
      expectAgree(anchorData({ anchor: 'center', left: 4, leftUnit: 'vw', top: 7, topUnit: 'vh', pivotX: 0.5, pivotY: 0.5 }));
    });
  });
});
