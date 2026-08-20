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
import { resolveAnchorRect, isSizeInert, type AnchorData, type SafeAreaPx } from '../../src/runtime/ui/anchorLayout';

const VPW = 400, VPH = 800, ELW = 100, ELH = 40;

/** Deliberately four DIFFERENT values: with a symmetric quartet a top/bottom or
 *  left/right mix-up in either path resolves to the same number and the parity check
 *  passes while both paths are wrong together. */
const INSETS: SafeAreaPx = { top: 62, right: 13, bottom: 34, left: 7 };

const MODES: AnchorData['anchor'][] = [
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
  // `var(--ui-sa-<edge>, env(safe-area-inset-<edge>))` — the safe-area inset. The oracle
  // resolves it the way a browser in an editor device preview would: the var is SET, so
  // the fallback is not reached. Still generic CSS knowledge — it does not know which
  // anchors are supposed to get one.
  const sa = s.match(/^(-1\s*\*\s*)?var\(\s*--ui-sa-(top|right|bottom|left)/);
  if (sa) return (sa[1] ? -1 : 1) * INSETS[sa[2] as 'top'];
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
    // Sum the terms of a FLAT calc: `base ± term ± term …`. It grew a third term when a
    // point anchor started composing its safe-area offset onto an authored one, and
    // anchorCss flattens rather than nesting precisely so this stays parseable. Splits
    // only at paren depth 0, so the ` - ` inside a var()'s fallback is not a separator.
    let depth = 0, start = 0, sign = 1, sum = 0;
    for (let i = 0; i <= inner.length; i++) {
      const c = inner[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      const isSep = depth === 0 && i > 0 && (c === '+' || c === '-') && /\s/.test(inner[i - 1]);
      if (i === inner.length || isSep) {
        const piece = inner.slice(start, i).trim();
        if (piece) sum += sign * termPx(piece, total);
        sign = c === '-' ? -1 : 1;
        start = i + 1;
      }
    }
    return sum;
  }
  return termPx(s, total);
}

/** Independent CSS absolute-positioning resolver: turns the style applyAnchorStyle
 *  produced into a pixel rect, knowing only generic CSS (not anchor semantics). */
function resolveCssRect(style: CSSProperties): { x: number; y: number; w: number; h: number } {
  const s = style as Record<string, string | number | undefined>;
  let left = s.left, right = s.right, top = s.top, bottom = s.bottom;
  // applyAnchorStyle emits four LONGHANDS for `stretch`, never the `inset` shorthand —
  // precisely so an offset longhand cannot depend on declaration order to override it.
  // This branch is therefore expected to be dead; it stays as a tripwire so that
  // re-introducing the shorthand keeps the oracle honest rather than silently
  // discarding the offsets. `??=`, not `=`: a longhand always wins over a shorthand.
  if (s.inset === 0 || s.inset === '0') { left ??= 0; right ??= 0; top ??= 0; bottom ??= 0; }

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
  const px = resolveAnchorRect(ELW, ELH, VPW, VPH, a, INSETS);
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
    // Offsets on BOTH edges of a stretched axis — the case that had no coverage at all.
    it('bottom-stretch with % offsets on both stretched edges', () => {
      expectAgree(anchorData({ anchor: 'bottom-stretch', left: 5, leftUnit: '%', right: 5, rightUnit: '%' }));
    });
    it('left-stretch with px offsets on both stretched edges', () => {
      expectAgree(anchorData({ anchor: 'left-stretch', top: 12, topUnit: 'px', bottom: 20, bottomUnit: 'px' }));
    });
    it('full stretch with offsets on all four edges', () => {
      expectAgree(anchorData({
        anchor: 'stretch',
        top: 10, topUnit: 'px', bottom: 30, bottomUnit: 'px',
        left: 5, leftUnit: '%', right: 15, rightUnit: 'px',
      }));
    });
    it('full stretch with a NEGATIVE single-sided offset (widens past the edge)', () => {
      expectAgree(anchorData({ anchor: 'stretch', left: -346, leftUnit: 'px' }));
    });
    it('stretched axis with a vw/vh offset on each edge', () => {
      expectAgree(anchorData({ anchor: 'h-stretch', left: 4, leftUnit: 'vw', right: 6, rightUnit: 'vmin', pivotY: 0.5 }));
    });
  });

  /** Parity pins CONSISTENCY, not correctness — the two implementations can agree
   *  precisely because both are wrong the same way, which is exactly what happened to
   *  stretched-axis offsets (a `right` offset was folded back into the NEAR edge, so
   *  `left: 5%` + `right: 5%` cancelled to a full-bleed box). These assert the
   *  semantics outright so agreement alone can never be mistaken for a green light. */
  describe('stretched-axis offsets INSET their own edge (they do not shift the box)', () => {
    it('left+right on a stretched axis are side margins, and do NOT cancel', () => {
      const a = anchorData({ anchor: 'bottom-stretch', left: 5, leftUnit: '%', right: 5, rightUnit: '%' });
      const r = resolveAnchorRect(ELW, ELH, VPW, VPH, a);
      expect(r.x).toBeCloseTo(20, 5);   // 5% of 400
      expect(r.w).toBeCloseTo(360, 5);  // 400 − 20 − 20 — NOT 400 (the cancelling bug)
      expectAgree(a);
    });
    it('top+bottom on a stretched axis inset vertically', () => {
      const a = anchorData({ anchor: 'left-stretch', top: 12, topUnit: 'px', bottom: 20, bottomUnit: 'px' });
      const r = resolveAnchorRect(ELW, ELH, VPW, VPH, a);
      expect(r.y).toBeCloseTo(12, 5);
      expect(r.h).toBeCloseTo(768, 5);  // 800 − 12 − 20
      expectAgree(a);
    });
    it('a far-edge offset alone shrinks the box without moving the near edge', () => {
      const r = resolveAnchorRect(ELW, ELH, VPW, VPH,
        anchorData({ anchor: 'top-stretch', right: 40, rightUnit: 'px' }));
      expect(r.x).toBeCloseTo(0, 5);
      expect(r.w).toBeCloseTo(360, 5);
    });
    it('a NON-stretched axis still SHIFTS — a far-edge offset moves the box', () => {
      // bottom-stretch stretches X only, so `bottom` must keep its point semantics.
      const r = resolveAnchorRect(ELW, ELH, VPW, VPH,
        anchorData({ anchor: 'bottom-stretch', bottom: 30, bottomUnit: 'px' }));
      expect(r.y).toBeCloseTo(770, 5);  // 800 − 30
      expect(r.h).toBeCloseTo(ELH, 5);  // height untouched
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

/** The THIRD path: `isSizeInert` is the predicate the Inspector greys a field on and
 *  the scene validator warns from. Both are claims about what these two layout paths
 *  do, so the predicate has to agree with the CODE that actually discards the authored
 *  size — not merely with the STRETCH_X/Y constants it happens to be built from. This
 *  drives all 16 modes through applyAnchorStyle and asserts the equivalence directly,
 *  so moving a mode between the stretch lists can never silently un-gate a field. */
describe('isSizeInert agrees with the CSS path that clears the authored size', () => {
  it.each(MODES)("'%s': width inert ⇔ applyAnchorStyle drops the CSS width", (mode) => {
    const style: CSSProperties = { width: ELW, height: ELH };
    applyAnchorStyle(style, anchorData({ anchor: mode }) as AnchorCssData);
    expect(isSizeInert(mode, 'width')).toBe(style.width === undefined);
  });

  it.each(MODES)("'%s': height inert ⇔ applyAnchorStyle drops the CSS height", (mode) => {
    const style: CSSProperties = { width: ELW, height: ELH };
    applyAnchorStyle(style, anchorData({ anchor: mode }) as AnchorCssData);
    expect(isSizeInert(mode, 'height')).toBe(style.height === undefined);
  });

  it('is not vacuous — the 16 modes cover both outcomes on both axes', () => {
    // Guards against the equivalence passing because every mode landed on one side.
    const w = MODES.map((m) => isSizeInert(m, 'width'));
    const h = MODES.map((m) => isSizeInert(m, 'height'));
    expect(new Set(w).size).toBe(2);
    expect(new Set(h).size).toBe(2);
  });

  // Safe area (#272). This is the block the parity test exists for: the offset arm MOVES
  // a point anchor's box, so for the first time the CSS and pixel paths can disagree
  // about where an element IS rather than only about padding its children. Every mode is
  // swept with safeArea on, at several pivots, against an asymmetric inset quartet.
  describe('safe area', () => {
    for (const mode of MODES) {
      for (const [pivotX, pivotY] of [[0, 0], [0.5, 0.5], [1, 1]] as Array<[number, number]>) {
        it(`${mode} @ pivot(${pivotX},${pivotY}) with safeArea`, () => {
          expectAgree(anchorData({ anchor: mode, pivotX, pivotY, safeArea: true }));
        });
      }
    }

    it('composes with authored offsets on a corner (top-right)', () => {
      expectAgree(anchorData({
        anchor: 'top-right', safeArea: true,
        top: 16, topUnit: 'px', right: 10, rightUnit: 'px', pivotX: 1, pivotY: 0,
      }));
    });
    it('composes with a % authored offset (bottom-left)', () => {
      expectAgree(anchorData({
        anchor: 'bottom-left', safeArea: true,
        bottom: 5, bottomUnit: '%', left: 4, leftUnit: 'vw', pivotY: 1,
      }));
    });
    it('a stretched anchor pads its children and does NOT move its own rect', () => {
      // Same rect with and without safeArea — the padding arm cannot move the box. This
      // is what makes double-insetting unrepresentable: the arms touch different things.
      const on = resolveAnchorRect(ELW, ELH, VPW, VPH, anchorData({ anchor: 'top-stretch', safeArea: true }), INSETS);
      const off = resolveAnchorRect(ELW, ELH, VPW, VPH, anchorData({ anchor: 'top-stretch', safeArea: false }), INSETS);
      expect(on).toEqual(off);
    });
    it('safeArea:false opts out completely — the box does not move', () => {
      const off = resolveAnchorRect(ELW, ELH, VPW, VPH, anchorData({ anchor: 'top-left', safeArea: false }), INSETS);
      expect(off.x).toBe(0);
      expect(off.y).toBe(0);
    });
    it('center reaches no edge, so it never moves', () => {
      const on = resolveAnchorRect(ELW, ELH, VPW, VPH, anchorData({ anchor: 'center', safeArea: true }), INSETS);
      const off = resolveAnchorRect(ELW, ELH, VPW, VPH, anchorData({ anchor: 'center', safeArea: false }), INSETS);
      expect(on).toEqual(off);
    });
  });
});
