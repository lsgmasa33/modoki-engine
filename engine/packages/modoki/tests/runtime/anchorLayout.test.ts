/** anchorLayout unit tests — resolveAnchorRect for all 16 anchor modes + offsets + pivots. */

import { describe, it, expect } from 'vitest';
import type { AnchorMode } from '../../src/runtime/traits/UIAnchor';

async function getModule() {
  return import('../../src/runtime/ui/anchorLayout');
}

function makeAnchor(anchor: AnchorMode, overrides: Partial<{
  top: number; topUnit: string;
  right: number; rightUnit: string;
  bottom: number; bottomUnit: string;
  left: number; leftUnit: string;
  pivotX: number; pivotY: number;
}> = {}) {
  return {
    anchor,
    top: 0, topUnit: 'px',
    right: 0, rightUnit: 'px',
    bottom: 0, bottomUnit: 'px',
    left: 0, leftUnit: 'px',
    pivotX: 0, pivotY: 0,
    ...overrides,
  };
}

// Element: 100x60, Viewport: 800x600
const W = 100, H = 60, VPW = 800, VPH = 600;

describe('resolveAnchorRect', () => {
  it('stretch — fills entire viewport', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('stretch'));
    expect(r).toEqual({ x: 0, y: 0, w: VPW, h: VPH });
  });

  // Pivot (0,0) = element's top-left at the anchor point.

  it('center — top-left at viewport center', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('center'));
    expect(r).toEqual({ x: 400, y: 300, w: W, h: H });
  });

  it('top — top-left at top-center', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('top'));
    expect(r).toEqual({ x: 400, y: 0, w: W, h: H });
  });

  it('bottom — top-left at bottom-center', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('bottom'));
    expect(r).toEqual({ x: 400, y: 600, w: W, h: H });
  });

  it('left — top-left at left-center', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('left'));
    expect(r).toEqual({ x: 0, y: 300, w: W, h: H });
  });

  it('right — top-left at right-center', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('right'));
    expect(r).toEqual({ x: 800, y: 300, w: W, h: H });
  });

  it('top-left — origin corner', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('top-left'));
    expect(r).toEqual({ x: 0, y: 0, w: W, h: H });
  });

  it('top-right — top-left at top-right corner', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('top-right'));
    expect(r).toEqual({ x: 800, y: 0, w: W, h: H });
  });

  it('bottom-left — top-left at bottom-left corner', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('bottom-left'));
    expect(r).toEqual({ x: 0, y: 600, w: W, h: H });
  });

  it('bottom-right — top-left at bottom-right corner', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('bottom-right'));
    expect(r).toEqual({ x: 800, y: 600, w: W, h: H });
  });

  it('top-stretch — full width at top', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('top-stretch'));
    expect(r).toEqual({ x: 0, y: 0, w: VPW, h: H });
  });

  it('bottom-stretch — full width, top-left at bottom', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('bottom-stretch'));
    expect(r).toEqual({ x: 0, y: 600, w: VPW, h: H });
  });

  it('left-stretch — full height at left', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('left-stretch'));
    expect(r).toEqual({ x: 0, y: 0, w: W, h: VPH });
  });

  it('right-stretch — full height, top-left at right', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('right-stretch'));
    expect(r).toEqual({ x: 800, y: 0, w: W, h: VPH });
  });

  it('h-stretch — full width, top-left at vertical center', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('h-stretch'));
    expect(r).toEqual({ x: 0, y: 300, w: VPW, h: H });
  });

  it('v-stretch — full height, top-left at horizontal center', async () => {
    const { resolveAnchorRect } = await getModule();
    const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('v-stretch'));
    expect(r).toEqual({ x: 400, y: 0, w: W, h: VPH });
  });

  describe('offsets', () => {
    it('applies pixel top/left offsets', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('top-left', {
        top: 20, left: 10,
      }));
      expect(r).toEqual({ x: 10, y: 20, w: W, h: H });
    });

    it('applies percentage top offset relative to viewport height', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('top-left', {
        top: 10, topUnit: '%',
      }));
      expect(r.y).toBe(60); // 10% of 600
    });

    it('applies percentage left offset relative to viewport width', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('top-left', {
        left: 25, leftUnit: '%',
      }));
      expect(r.x).toBe(200); // 25% of 800
    });
  });

  // ── Comprehensive pivot tests: all non-stretch anchors × 9 pivot positions ──
  // Formula: x = anchorX - pivotX * W, y = anchorY - pivotY * H
  // Anchor points: top-left(0,0) top(400,0) top-right(800,0) left(0,300)
  //   center(400,300) right(800,300) bottom-left(0,600) bottom(400,600) bottom-right(800,600)

  describe('pivot × anchor matrix', () => {
    const anchors: { name: AnchorMode; ax: number; ay: number }[] = [
      { name: 'top-left',     ax: 0,   ay: 0 },
      { name: 'top',          ax: 400, ay: 0 },
      { name: 'top-right',    ax: 800, ay: 0 },
      { name: 'left',         ax: 0,   ay: 300 },
      { name: 'center',       ax: 400, ay: 300 },
      { name: 'right',        ax: 800, ay: 300 },
      { name: 'bottom-left',  ax: 0,   ay: 600 },
      { name: 'bottom',       ax: 400, ay: 600 },
      { name: 'bottom-right', ax: 800, ay: 600 },
    ];
    const pivots = [
      { px: 0,   py: 0 },
      { px: 0,   py: 0.5 },
      { px: 0,   py: 1 },
      { px: 0.5, py: 0 },
      { px: 0.5, py: 0.5 },
      { px: 0.5, py: 1 },
      { px: 1,   py: 0 },
      { px: 1,   py: 0.5 },
      { px: 1,   py: 1 },
    ];

    for (const a of anchors) {
      for (const p of pivots) {
        it(`${a.name} pivot(${p.px},${p.py})`, async () => {
          const { resolveAnchorRect } = await getModule();
          const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor(a.name, {
            pivotX: p.px, pivotY: p.py,
          }));
          expect(r.x).toBe(a.ax - p.px * W);
          expect(r.y).toBe(a.ay - p.py * H);
          expect(r.w).toBe(W);
          expect(r.h).toBe(H);
        });
      }
    }
  });

  // ── Stretch modes: pivot only affects the non-stretched axis ──

  describe('stretch + pivot', () => {
    it('top-stretch: pivotY shifts, pivotX ignored (X stretched)', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('top-stretch', { pivotX: 0.5, pivotY: 0.5 }));
      expect(r.x).toBe(0);       // X stretched — pivot ignored
      expect(r.y).toBe(-30);     // 0 - 0.5 * 60
      expect(r.w).toBe(VPW);
    });

    it('bottom-stretch: pivotY shifts, pivotX ignored', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('bottom-stretch', { pivotX: 0.5, pivotY: 0.5 }));
      expect(r.x).toBe(0);
      expect(r.y).toBe(570);     // 600 - 0.5 * 60
      expect(r.w).toBe(VPW);
    });

    it('left-stretch: pivotX shifts, pivotY ignored (Y stretched)', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('left-stretch', { pivotX: 0.5, pivotY: 0.5 }));
      expect(r.x).toBe(-50);     // 0 - 0.5 * 100
      expect(r.y).toBe(0);       // Y stretched — pivot ignored
      expect(r.h).toBe(VPH);
    });

    it('right-stretch: pivotX shifts, pivotY ignored', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('right-stretch', { pivotX: 0.5, pivotY: 0.5 }));
      expect(r.x).toBe(750);     // 800 - 0.5 * 100
      expect(r.y).toBe(0);
      expect(r.h).toBe(VPH);
    });

    it('h-stretch: pivotY shifts, pivotX ignored', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('h-stretch', { pivotX: 0.5, pivotY: 0.5 }));
      expect(r.x).toBe(0);
      expect(r.y).toBe(270);     // 300 - 0.5 * 60
      expect(r.w).toBe(VPW);
    });

    it('v-stretch: pivotX shifts, pivotY ignored', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('v-stretch', { pivotX: 0.5, pivotY: 0.5 }));
      expect(r.x).toBe(350);     // 400 - 0.5 * 100
      expect(r.y).toBe(0);
      expect(r.h).toBe(VPH);
    });

    it('stretch: both pivots ignored', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('stretch', { pivotX: 0.5, pivotY: 0.5 }));
      expect(r).toEqual({ x: 0, y: 0, w: VPW, h: VPH });
    });
  });

  describe('offsets + pivot', () => {
    it('applies anchor + offset + pivot together', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('top-left', {
        top: 20, left: 30,
        pivotX: 0.5, pivotY: 0.5,
      }));
      // top-left: (0, 0) + offset: (30, 20) - pivot: (50, 30)
      expect(r).toEqual({ x: -20, y: -10, w: W, h: H });
    });

    it('right offset subtracts from x', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('top-right', { right: 10 }));
      // top-right: (800, 0) - right offset: (790, 0)
      expect(r.x).toBe(790);
    });

    it('bottom offset subtracts from y', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('bottom-left', { bottom: 15 }));
      // bottom-left: (0, 600) - bottom offset: (0, 585)
      expect(r.y).toBe(585);
    });
  });

  // ── Offsets on a STRETCHED axis: they INSET their own edge, they do not shift ──
  // A stretched axis pins BOTH edges, so `left`/`right` behave as margins and the
  // box SHRINKS. The axis decides, not the field: on `bottom-stretch` the X offsets
  // inset while the Y offsets keep their point semantics. (Before 2026-07-31 every
  // offset shifted, so left+right cancelled to a full-bleed box.)

  describe('stretched-axis offsets inset (do not shift)', () => {
    it('left+right on top-stretch are side margins and do NOT cancel', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('top-stretch', { left: 40, right: 40 }));
      expect(r.x).toBe(40);
      expect(r.w).toBe(720);   // 800 − 40 − 40, NOT 800
      expect(r.h).toBe(H);     // untouched: Y is not stretched
    });

    it('% left+right resolve against viewport WIDTH and inset', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('bottom-stretch', {
        left: 5, leftUnit: '%', right: 5, rightUnit: '%',
      }));
      expect(r.x).toBe(40);    // 5% of 800
      expect(r.w).toBe(720);   // 90% of 800 — the games/court NarrationBand case
    });

    it('a far-edge offset alone shrinks without moving the near edge', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('h-stretch', { right: 100 }));
      expect(r.x).toBe(0);
      expect(r.w).toBe(700);
    });

    it('a near-edge offset alone moves the near edge and shrinks', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('h-stretch', { left: 100 }));
      expect(r.x).toBe(100);
      expect(r.w).toBe(700);   // far edge stays pinned at 800
    });

    it('top+bottom inset on a vertically stretched axis', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('left-stretch', { top: 30, bottom: 50 }));
      expect(r.y).toBe(30);
      expect(r.h).toBe(520);   // 600 − 30 − 50
      expect(r.w).toBe(W);     // untouched: X is not stretched
    });

    it('full stretch insets on all four edges at once', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('stretch', {
        top: 10, right: 20, bottom: 30, left: 40,
      }));
      expect(r).toEqual({ x: 40, y: 10, w: 740, h: 560 }); // 800−40−20, 600−10−30
    });

    it('a NEGATIVE offset on a stretched axis WIDENS past the edge', async () => {
      // games/3d-test's `2D` entity: a single-sided L=-346 on full stretch. Under
      // shift semantics the whole box slid left; under inset the left edge moves out
      // and the box gets 346 WIDER, with the right edge pinned.
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('stretch', { left: -346 }));
      expect(r.x).toBe(-346);
      expect(r.w).toBe(1146);  // 800 + 346
    });

    it('the axis decides, not the field: bottom-stretch insets X but SHIFTS Y', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('bottom-stretch', { right: 60, bottom: 25 }));
      expect(r.w).toBe(740);   // X stretched → inset
      expect(r.x).toBe(0);
      expect(r.y).toBe(575);   // Y is a point → shift (600 − 25)
      expect(r.h).toBe(H);     // …and the height is untouched
    });

    it('an inset larger than the viewport yields a negative width (not clamped)', async () => {
      // Documents the current contract: no clamping. If clamping is ever wanted it
      // should be a deliberate change with its own test, not an accident.
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('top-stretch', { left: 500, right: 500 }));
      expect(r.w).toBe(-200);
    });

    it('pivot stays ignored on a stretched axis even with offsets', async () => {
      const { resolveAnchorRect } = await getModule();
      const r = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('top-stretch', {
        left: 40, right: 40, pivotX: 0.5, pivotY: 0.5,
      }));
      expect(r.x).toBe(40);    // pivotX ignored — X is stretched
      expect(r.y).toBe(-30);   // pivotY still applies to the un-stretched Y
    });
  });
});

/** isSizeInert — the shared predicate the Inspector's field gating and the scene
 *  validator both read, so neither can disagree with the layout about which authored
 *  size a stretched anchor overwrites (issue #16). */
describe('isSizeInert', () => {
  it('reports width inert on exactly the STRETCH_X modes', async () => {
    const { isSizeInert, STRETCH_X } = await getModule();
    for (const a of STRETCH_X) expect(isSizeInert(a, 'width')).toBe(true);
    for (const a of ['top', 'bottom', 'left', 'right', 'center', 'top-left', 'bottom-right']) {
      expect(isSizeInert(a, 'width')).toBe(false);
    }
  });

  it('reports height inert on exactly the STRETCH_Y modes', async () => {
    const { isSizeInert, STRETCH_Y } = await getModule();
    for (const a of STRETCH_Y) expect(isSizeInert(a, 'height')).toBe(true);
    for (const a of ['top', 'bottom', 'left', 'right', 'center', 'top-left', 'bottom-right']) {
      expect(isSizeInert(a, 'height')).toBe(false);
    }
  });

  it('treats the axes INDEPENDENTLY — top-stretch kills width but not height', async () => {
    // The whole point of the issue: a half-stretched anchor must not gate both fields.
    const { isSizeInert } = await getModule();
    expect(isSizeInert('top-stretch', 'width')).toBe(true);
    expect(isSizeInert('top-stretch', 'height')).toBe(false);
    expect(isSizeInert('left-stretch', 'height')).toBe(true);
    expect(isSizeInert('left-stretch', 'width')).toBe(false);
  });

  it('full stretch makes BOTH axes inert', async () => {
    const { isSizeInert } = await getModule();
    expect(isSizeInert('stretch', 'width')).toBe(true);
    expect(isSizeInert('stretch', 'height')).toBe(true);
  });

  it('agrees with resolveAnchorRect, which is what makes the size inert', async () => {
    // Not a tautology against the constant: prove the layout really does overwrite the
    // authored extent on an axis this predicate calls inert, and preserve it otherwise.
    const { isSizeInert, resolveAnchorRect } = await getModule();
    const stretched = resolveAnchorRect(W, H, VPW, VPH, makeAnchor('top-stretch'));
    expect(isSizeInert('top-stretch', 'width')).toBe(true);
    expect(stretched.w).toBe(VPW);   // authored W=100 overwritten
    expect(stretched.h).toBe(H);     // authored H=60 survives
    expect(isSizeInert('top-stretch', 'height')).toBe(false);
  });
});
