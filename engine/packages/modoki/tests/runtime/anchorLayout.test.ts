/** anchorLayout unit tests — resolveAnchorRect for all 16 anchor modes + offsets + pivots. */

import { describe, it, expect } from 'vitest';

async function getModule() {
  return import('../../../src/runtime/ui/anchorLayout');
}

function makeAnchor(anchor: string, overrides: Partial<{
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
    const anchors: { name: string; ax: number; ay: number }[] = [
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
});
