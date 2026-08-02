/** anchorCss unit tests — the CSS applyAnchorStyle actually EMITS.
 *
 *  Distinct from uiAnchorParity.test.ts, which resolves this output through a
 *  hand-written CSS oracle and compares it to the pixel path. That answers "do the
 *  two implementations agree?"; it cannot answer "is the emitted CSS the shape a
 *  browser needs?", because the oracle is our own approximation of CSS and shares
 *  any misunderstanding baked into it. So these assert the declarations directly:
 *  WHICH property carries an offset (the whole substance of the stretched-axis fix
 *  — `right` must land on `style.right`, not folded back into `style.left`), and
 *  that `stretch` emits longhands rather than a shorthand that would need
 *  declaration ORDER to be overridden. */

import { describe, it, expect } from 'vitest';
import type { CSSProperties } from 'react';
import { applyAnchorStyle, type AnchorCssData } from '../../src/runtime/ui/anchorCss';

function anchor(over: Partial<AnchorCssData> = {}): AnchorCssData {
  return {
    anchor: 'center',
    top: 0, topUnit: 'px', right: 0, rightUnit: 'px',
    bottom: 0, bottomUnit: 'px', left: 0, leftUnit: 'px',
    pivotX: 0, pivotY: 0, ...over,
  };
}

const styleFor = (over: Partial<AnchorCssData>): CSSProperties => {
  const s: CSSProperties = {};
  applyAnchorStyle(s, anchor(over));
  return s;
};

describe('applyAnchorStyle — emitted declarations', () => {
  it('always positions absolutely', () => {
    expect(styleFor({ anchor: 'center' }).position).toBe('absolute');
  });

  describe('stretched axis — an offset lands on its OWN edge', () => {
    it('right goes to style.right and leaves style.left at the pinned edge', () => {
      const s = styleFor({ anchor: 'top-stretch', left: 5, leftUnit: '%', right: 5, rightUnit: '%' });
      expect(s.left).toBe('5%');
      expect(s.right).toBe('5%');
      // The bug: `right` folded into `left` as calc(5% - 5%), cancelling to zero.
      expect(String(s.left)).not.toContain('calc');
    });

    it('bottom goes to style.bottom on a vertically stretched axis', () => {
      const s = styleFor({ anchor: 'left-stretch', top: 12, bottom: 20 });
      expect(s.top).toBe(12);
      expect(s.bottom).toBe(20);
    });

    it('a far-edge offset alone does not disturb the near edge', () => {
      const s = styleFor({ anchor: 'h-stretch', right: 40 });
      expect(s.left).toBe(0);
      expect(s.right).toBe(40);
    });

    it('width is cleared on a stretched axis, so the offsets fully govern it', () => {
      // Why an authored UIElement.width is inert here — see docs/todo.md.
      const s = styleFor({ anchor: 'top-stretch', left: 10, right: 10 });
      expect(s.width).toBeUndefined();
      expect(s.height).toBeUndefined(); // top-stretch sets no height either
    });

    it('viewport units become a var() term on the correct edge', () => {
      const s = styleFor({ anchor: 'h-stretch', left: 4, leftUnit: 'vw', right: 6, rightUnit: 'vmin' });
      expect(String(s.left)).toContain('--ui-vw');
      expect(String(s.right)).toContain('--ui-vmin');
    });
  });

  describe('non-stretched axis — an offset SHIFTS the single anchor point', () => {
    it('right subtracts from left off a 100% base', () => {
      const s = styleFor({ anchor: 'top-right', right: 8 });
      expect(s.left).toBe('calc(100% - 8px)');
      expect(s.right).toBeUndefined(); // never emitted on a point axis
    });

    it('bottom subtracts from top off a 100% base', () => {
      const s = styleFor({ anchor: 'bottom-left', bottom: 15 });
      expect(s.top).toBe('calc(100% - 15px)');
      expect(s.bottom).toBeUndefined();
    });

    it('left+right on a point axis DO cancel — that is correct there', () => {
      // Both describe the same edge, so cancelling is the defined behaviour;
      // only a stretched axis reads them as two independent edges.
      const s = styleFor({ anchor: 'top-left', left: 30, right: 30 });
      expect(s.left).toBe('calc(30px - 30px)');
    });
  });

  describe('`stretch` emits longhands, not the `inset` shorthand', () => {
    // Load-bearing: the offset block writes style.right/style.bottom. Against a
    // shorthand those would only win by declaration ORDER (React emits style keys in
    // insertion order) — an invisible dependency in the very code path whose bug was
    // that offsets silently did nothing. Longhands make the 0 an explicit base.
    it('pins all four edges without a shorthand', () => {
      const s = styleFor({ anchor: 'stretch' });
      expect(s.inset).toBeUndefined();
      expect([s.top, s.right, s.bottom, s.left]).toEqual([0, 0, 0, 0]);
    });

    it('offsets compose onto that 0 base on every edge', () => {
      const s = styleFor({ anchor: 'stretch', top: 10, right: 20, bottom: 30, left: 40 });
      expect([s.top, s.right, s.bottom, s.left]).toEqual([10, 20, 30, 40]);
    });

    it('a negative single-sided offset widens past the edge', () => {
      // games/3d-test's `2D` entity (inactive, but the semantics are pinned here).
      const s = styleFor({ anchor: 'stretch', left: -346 });
      expect(s.left).toBe(-346);
      expect(s.right).toBe(0); // far edge stays pinned → the box gets wider
    });
  });

  describe('pivot', () => {
    it('is ignored on stretched axes and applied on point axes', () => {
      expect(styleFor({ anchor: 'stretch', pivotX: 0.5, pivotY: 0.5 }).transform).toBeUndefined();
      expect(styleFor({ anchor: 'top-stretch', pivotX: 0.5, pivotY: 0.5 }).transform)
        .toBe('translate(0%, -50%)'); // X pinned, Y free
      expect(styleFor({ anchor: 'center', pivotX: 0.5, pivotY: 0.5 }).transform)
        .toBe('translate(-50%, -50%)');
    });

    it('offsets on a stretched axis do not reintroduce a pivot translate', () => {
      expect(styleFor({ anchor: 'h-stretch', left: 10, right: 10, pivotX: 1 }).transform)
        .toBeUndefined();
    });
  });

  describe('safeArea padding', () => {
    it('applies only to stretched anchors, on the edges the element reaches', () => {
      const s = styleFor({ anchor: 'top-stretch', safeArea: true });
      expect(String(s.paddingLeft)).toContain('safe-area-inset-left');
      expect(String(s.paddingRight)).toContain('safe-area-inset-right');
      expect(String(s.paddingTop)).toContain('safe-area-inset-top');
      expect(s.paddingBottom).toBeUndefined(); // top-stretch never reaches the bottom
    });

    it('is skipped entirely on a non-stretched anchor', () => {
      const s = styleFor({ anchor: 'center', safeArea: true });
      expect(s.paddingTop).toBeUndefined();
      expect(s.paddingLeft).toBeUndefined();
    });

    it('coexists with stretched-axis offsets — padding does not consume them', () => {
      // The offsets size the BOX; safe-area padding insets its CHILDREN. Regression
      // guard: emitting one must not overwrite the other.
      const s = styleFor({ anchor: 'top-stretch', left: 5, leftUnit: '%', right: 5, rightUnit: '%', safeArea: true });
      expect(s.left).toBe('5%');
      expect(s.right).toBe('5%');
      expect(String(s.paddingLeft)).toContain('safe-area-inset-left');
    });
  });

  it('clears margins (they cannot move an absolutely-positioned anchor)', () => {
    const s: CSSProperties = { marginTop: 10, marginLeft: 10 };
    applyAnchorStyle(s, anchor({ anchor: 'center' }));
    expect(s.marginTop).toBeUndefined();
    expect(s.marginLeft).toBeUndefined();
  });

  it('zIndex is emitted only when non-zero', () => {
    expect(styleFor({ anchor: 'center', zIndex: 5 }).zIndex).toBe(5);
    expect(styleFor({ anchor: 'center', zIndex: 0 }).zIndex).toBeUndefined();
  });
});
