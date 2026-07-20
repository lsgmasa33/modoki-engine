/** canvas2DLayout — exhaustive coverage of the single source-of-truth 2D-Canvas
 *  placement function across device sizes × anchor/size/placement × scale modes.
 *
 *  Two kinds of assertions:
 *   1. EXACT hand-computed numbers for clean cases (panel = an integer multiple of
 *      the device, so device→screen scale is exact).
 *   2. INVARIANTS that must hold for every device/anchor/mode combination — these
 *      catch the class of "outline offset / doesn't match the render" bugs.
 */
import { describe, it, expect } from 'vitest';
import {
  computeCanvas2DLayout, resolveUnit, resolveCanvasSize,
  type UISizeSpec, type Canvas2DSpec,
} from '../../src/editor/scene/canvas2DLayout';
import type { AnchorData } from '../../src/runtime/ui/anchorLayout';
import type { Canvas2DScaleMode } from '../../src/runtime/traits/Canvas2D';
import { DEVICE_PRESETS, resolveLogicalSize } from '../../src/editor/scene/devicePresets';

// ── helpers ──────────────────────────────────────────────
function anchor(name: string, o: Partial<AnchorData> = {}): AnchorData {
  return {
    anchor: name,
    top: 0, topUnit: 'px', right: 0, rightUnit: 'px',
    bottom: 0, bottomUnit: 'px', left: 0, leftUnit: 'px',
    pivotX: 0, pivotY: 0, ...o,
  };
}
function size(width: number, widthUnit: string, height: number, heightUnit: string): UISizeSpec {
  return { width, widthUnit, height, heightUnit };
}
const CENTER = (r: { x: number; y: number; w: number; h: number }) => ({ cx: r.x + r.w / 2, cy: r.y + r.h / 2 });

const devices = DEVICE_PRESETS.filter((p) => p.logicalW > 0);
const MODES: Canvas2DScaleMode[] = ['fitW', 'fitH', 'contain', 'cover', 'fill', 'none'];

// ── unit resolution ──────────────────────────────────────
describe('resolveUnit / resolveCanvasSize', () => {
  it('resolves px / % / vw / vh / vmin / vmax against the logical device viewport', () => {
    // signature: resolveUnit(value, unit, axisTotal, vpW, vpH)
    const W = 834, H = 1194; // iPad Pro 11 logical (portrait): vmin=834, vmax=1194
    expect(resolveUnit(200, 'px', W, W, H)).toBe(200);
    expect(resolveUnit(50, '%', W, W, H)).toBeCloseTo(417, 5);    // 50% of own axis (width)
    expect(resolveUnit(50, '%', H, W, H)).toBeCloseTo(597, 5);    // 50% of own axis (height)
    expect(resolveUnit(10, 'vw', W, W, H)).toBeCloseTo(83.4, 5);  // 10% of width
    expect(resolveUnit(10, 'vh', H, W, H)).toBeCloseTo(119.4, 5); // 10% of height
    expect(resolveUnit(10, 'vmin', W, W, H)).toBeCloseTo(83.4, 5);  // 10% of min(W,H)=834
    expect(resolveUnit(10, 'vmax', W, W, H)).toBeCloseTo(119.4, 5); // 10% of max(W,H)=1194
    expect(resolveUnit(0, 'px', W, W, H)).toBe(0);
    expect(resolveUnit(100, undefined, W, W, H)).toBe(100);      // unknown unit → px
  });

  it('vmin/vmax are device-logical-aware: same value, orientation flips which axis wins', () => {
    // Portrait 834×1194: vmin uses 834. Landscape 1194×834: vmin still uses 834 (the
    // smaller axis), so a vmin-sized element is identical in both orientations.
    expect(resolveUnit(20, 'vmin', 0, 834, 1194)).toBeCloseTo(resolveUnit(20, 'vmin', 0, 1194, 834), 5);
    expect(resolveUnit(20, 'vmax', 0, 834, 1194)).toBeCloseTo(resolveUnit(20, 'vmax', 0, 1194, 834), 5);
    expect(resolveUnit(20, 'vmin', 0, 834, 1194)).toBeCloseTo(166.8, 4); // 20% of 834
  });

  it('falls back to full viewport extent when a dimension is zero', () => {
    expect(resolveCanvasSize(size(0, 'px', 0, 'px'), 834, 1194)).toEqual({ w: 834, h: 1194 });
    expect(resolveCanvasSize(size(100, '%', 100, '%'), 834, 1194)).toEqual({ w: 834, h: 1194 });
    expect(resolveCanvasSize(size(200, 'px', 0, 'px'), 834, 1194)).toEqual({ w: 200, h: 1194 });
  });

  it('clamps to maxWidth/maxHeight', () => {
    expect(resolveCanvasSize({ width: 100, widthUnit: '%', height: 100, heightUnit: '%', maxWidth: 600, maxWidthUnit: 'px' }, 834, 1194))
      .toEqual({ w: 600, h: 1194 });
  });
});

// ── EXACT cases ──────────────────────────────────────────
describe('computeCanvas2DLayout — exact hand-computed cases', () => {
  it('full-screen stretch canvas at exact 2× (sling-style: ref 1080×1920 fitH)', () => {
    // iPad Pro 11 portrait (834×1194) into a 1668×2388 panel → device scale exactly 2.
    const L = computeCanvas2DLayout(
      834, 1194, 1668, 2388,
      size(100, '%', 100, '%'), anchor('stretch'),
      { referenceWidth: 1080, referenceHeight: 1920, scaleMode: 'fitH' },
    );
    expect(L.deviceRect).toEqual({ x: 0, y: 0, w: 1668, h: 2388 });
    expect(L.deviceScale).toBe(2);
    expect(L.divRect).toEqual({ x: 0, y: 0, w: 1668, h: 2388 });
    // fitH: scale = 2388/1920 = 1.24375 → content width 1343.25, full height, pillarboxed.
    expect(L.contentRect.h).toBeCloseTo(2388, 5);
    expect(L.contentRect.w).toBeCloseTo(1343.25, 4);
    expect(L.offsetX).toBeCloseTo((1668 - 1343.25) / 2, 4); // 162.375
    // Content is horizontally centered in the div.
    expect(CENTER(L.contentRect).cx).toBeCloseTo(834, 4);
  });

  it('3d-test "Game Canvas": 200×300px, anchor center left:-150, ref 650×1000 fitH', () => {
    // Same iPad 2× panel. Device scale 2.
    const L = computeCanvas2DLayout(
      834, 1194, 1668, 2388,
      size(200, 'px', 300, 'px'),
      anchor('center', { left: -150, leftUnit: 'px', pivotX: 0, pivotY: 0 }),
      { referenceWidth: 650, referenceHeight: 1000, scaleMode: 'fitH' },
    );
    // anchor center → (417,597) logical; left:-150 → (267,597); pivot 0,0 (no shift).
    // div screen = ((267,597)*2, 200*2, 300*2) = (534,1194,400,600).
    expect(L.divRect).toEqual({ x: 534, y: 1194, w: 400, h: 600 });
    // fitH: scale = 600/1000 = 0.6 → content 390×600, offsetX = (400-390)/2 = 5.
    expect(L.contentRect).toEqual({ x: 539, y: 1194, w: 390, h: 600 });
  });

  it('fill mode stretches content to exactly fill the div (no letterbox)', () => {
    const L = computeCanvas2DLayout(
      834, 1194, 1668, 2388,
      size(100, '%', 100, '%'), anchor('stretch'),
      { referenceWidth: 1080, referenceHeight: 1920, scaleMode: 'fill' },
    );
    expect(L.contentRect).toEqual({ x: 0, y: 0, w: 1668, h: 2388 });
  });

  it('contain: a landscape ref letterboxes vertically inside a portrait div', () => {
    // div = full device 1668×2388; ref 1920×1080 (landscape).
    // contain scale = min(1668/1920, 2388/1080) = 0.86875 (width binds).
    const L = computeCanvas2DLayout(
      834, 1194, 1668, 2388,
      size(100, '%', 100, '%'), anchor('stretch'),
      { referenceWidth: 1920, referenceHeight: 1080, scaleMode: 'contain' },
    );
    expect(L.contentRect.w).toBeCloseTo(1668, 3);     // width fills (binding axis)
    expect(L.contentRect.h).toBeCloseTo(938.25, 3);   // 1080 × 0.86875, letterboxed
    expect(L.contentRect.x).toBeCloseTo(0, 3);
    expect(CENTER(L.contentRect).cy).toBeCloseTo(1194, 3);
  });

  it('cover: a landscape ref covers a portrait div, cropping the width overflow', () => {
    // cover scale = max(1668/1920, 2388/1080) = 2.21111 (height binds).
    const L = computeCanvas2DLayout(
      834, 1194, 1668, 2388,
      size(100, '%', 100, '%'), anchor('stretch'),
      { referenceWidth: 1920, referenceHeight: 1080, scaleMode: 'cover' },
    );
    expect(L.contentRect.h).toBeCloseTo(2388, 3);     // height fills (binding axis)
    expect(L.contentRect.w).toBeCloseTo(1920 * (2388 / 1080), 2); // overflows width
    expect(L.contentRect.w).toBeGreaterThan(1668);    // cropped horizontally
    expect(CENTER(L.contentRect).cx).toBeCloseTo(834, 3); // still centered
  });

  it('none mode: content is the reference size, centered, unscaled', () => {
    const L = computeCanvas2DLayout(
      834, 1194, 1668, 2388,
      size(100, '%', 100, '%'), anchor('stretch'),
      { referenceWidth: 600, referenceHeight: 800, scaleMode: 'none' },
    );
    expect(L.contentRect.w).toBe(600);
    expect(L.contentRect.h).toBe(800);
    expect(CENTER(L.contentRect)).toEqual({ cx: 834, cy: 1194 }); // panel center
  });

  it('Free mode (device 0): canvas viewport == panel, scale 1', () => {
    const L = computeCanvas2DLayout(
      0, 0, 800, 600,
      size(100, '%', 100, '%'), anchor('stretch'),
      { referenceWidth: 1080, referenceHeight: 1920, scaleMode: 'fitH' },
    );
    expect(L.deviceRect).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(L.deviceScale).toBe(1);
    expect(L.divRect).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });

  it('vmin-sized canvas: a centered 50vmin square is device-logical-aware', () => {
    // iPad 834×1194 at exact 2× panel. vmin = min(834,1194) = 834.
    // 50vmin = 417 logical → 834 screen px (×2). Centered square.
    const L = computeCanvas2DLayout(
      834, 1194, 1668, 2388,
      size(50, 'vmin', 50, 'vmin'), anchor('center', { pivotX: 0.5, pivotY: 0.5 }),
      { referenceWidth: 100, referenceHeight: 100, scaleMode: 'fill' },
    );
    expect(L.divRect.w).toBeCloseTo(834, 3); // 417 logical × 2
    expect(L.divRect.h).toBeCloseTo(834, 3);
    expect(CENTER(L.divRect).cx).toBeCloseTo(834, 3); // panel center x = 1668/2
    expect(CENTER(L.divRect).cy).toBeCloseTo(1194, 3);
  });

  it('corner anchor honors pivot (top-right, pivot 1,0 keeps the box on-screen)', () => {
    const L = computeCanvas2DLayout(
      400, 800, 400, 800, // 1× panel
      size(100, 'px', 100, 'px'),
      anchor('top-right', { pivotX: 1, pivotY: 0 }),
      { referenceWidth: 100, referenceHeight: 100, scaleMode: 'fill' },
    );
    // top-right anchor x=vpW=400; pivot 1 → x -= 1*100 = 300. y=0.
    expect(L.divRect).toEqual({ x: 300, y: 0, w: 100, h: 100 });
  });
});

// ── INVARIANTS over a representative matrix ───────────────
// One assertion-rich case per combo (keeps the suite to a few hundred focused
// tests rather than thousands). Devices span phone/tablet/abstract aspects.
describe('computeCanvas2DLayout — invariants across devices × anchors × modes', () => {
  const matrixDevices = ['iPhone 16 Pro', 'iPad Pro 11"', '16:9 (1080p)', '1:1']
    .map((n) => devices.find((d) => d.name === n)!);
  const anchors = ['stretch', 'center', 'top-left', 'bottom-right'];
  const sizes: Array<[string, UISizeSpec]> = [
    ['100%×100%', size(100, '%', 100, '%')],
    ['200×300px', size(200, 'px', 300, 'px')],
    ['60vmin square', size(60, 'vmin', 60, 'vmin')],
  ];
  // A non-square panel so letterbox math is genuinely exercised.
  const PANEL_W = 1300, PANEL_H = 900;

  for (const dev of matrixDevices) {
    for (const orient of ['portrait', 'landscape'] as const) {
      const { w: dW, h: dH } = resolveLogicalSize(dev, orient);
      for (const aName of anchors) {
        for (const [sName, ui] of sizes) {
          for (const mode of MODES) {
            const label = `${dev.name}/${orient} ${aName} ${sName} ${mode}`;
            const spec: Canvas2DSpec = { referenceWidth: 1080, referenceHeight: 1920, scaleMode: mode };
            const L = computeCanvas2DLayout(dW, dH, PANEL_W, PANEL_H, ui, anchor(aName), spec);

            it(label, () => {
              // (a) Device frame fits the panel and is centered (≤1px rounding).
              expect(L.deviceRect.w).toBeLessThanOrEqual(PANEL_W + 1);
              expect(L.deviceRect.h).toBeLessThanOrEqual(PANEL_H + 1);
              expect(Math.abs(CENTER(L.deviceRect).cx - PANEL_W / 2)).toBeLessThanOrEqual(1);
              expect(Math.abs(CENTER(L.deviceRect).cy - PANEL_H / 2)).toBeLessThanOrEqual(1);

              // (b) Content region is ALWAYS centered in the div (every mode — the
              //     overflow axis of fitW/fitH extends symmetrically, none centers).
              const dc = CENTER(L.divRect), cc = CENTER(L.contentRect);
              expect(cc.cx).toBeCloseTo(dc.cx, 3);
              expect(cc.cy).toBeCloseTo(dc.cy, 3);

              // (c) Non-stretch div keeps the requested logical aspect (uniform scale).
              const { w: lw, h: lh } = resolveCanvasSize(ui, dW, dH);
              if (aName !== 'stretch' && L.divRect.h > 0 && lh > 0) {
                expect(L.divRect.w / L.divRect.h).toBeCloseTo(lw / lh, 3);
              }

              // (d) Per-mode fit: matched axis fills the div exactly; the other axis
              //     is free to overflow (cover-fit), except fill (covers both) and
              //     none (1:1 reference size).
              if (mode === 'fitW') expect(L.contentRect.w).toBeCloseTo(L.divRect.w, 3);
              if (mode === 'fitH') expect(L.contentRect.h).toBeCloseTo(L.divRect.h, 3);
              if (mode === 'fill') {
                expect(L.contentRect.w).toBeCloseTo(L.divRect.w, 3);
                expect(L.contentRect.h).toBeCloseTo(L.divRect.h, 3);
              }
              if (mode === 'none') {
                expect(L.contentRect.w).toBeCloseTo(spec.referenceWidth, 3);
                expect(L.contentRect.h).toBeCloseTo(spec.referenceHeight, 3);
              }
              if (mode === 'contain' && L.divRect.w > 0 && L.divRect.h > 0) {
                // Fits entirely inside; one axis touches the div edge.
                expect(L.contentRect.w).toBeLessThanOrEqual(L.divRect.w + 1e-3);
                expect(L.contentRect.h).toBeLessThanOrEqual(L.divRect.h + 1e-3);
                const touches = Math.abs(L.contentRect.w - L.divRect.w) < 1e-3 || Math.abs(L.contentRect.h - L.divRect.h) < 1e-3;
                expect(touches).toBe(true);
              }
              if (mode === 'cover' && L.divRect.w > 0 && L.divRect.h > 0) {
                // Covers the div; one axis touches the div edge, the other overflows.
                expect(L.contentRect.w).toBeGreaterThanOrEqual(L.divRect.w - 1e-3);
                expect(L.contentRect.h).toBeGreaterThanOrEqual(L.divRect.h - 1e-3);
                const touches = Math.abs(L.contentRect.w - L.divRect.w) < 1e-3 || Math.abs(L.contentRect.h - L.divRect.h) < 1e-3;
                expect(touches).toBe(true);
              }
            });
          }
        }
      }
    }
  }
});

// ── runtime-vs-outline parity (the bug this whole effort targets) ──
describe('computeCanvas2DLayout — editor outline == runtime content region', () => {
  // The editor outline and the runtime PixiJS render are DIFFERENT code paths but
  // MUST produce the same on-screen rectangle. Both are defined as this function's
  // contentRect, so parity reduces to: scaling the panel (a zoom/DPR change) only
  // scales the result — it never shifts content off the div.
  it('is scale-equivariant: 2× panel → 2× rects, same relative layout', () => {
    const args = [834, 1194] as const;
    const ui = size(200, 'px', 300, 'px');
    const a = anchor('center', { left: -150, leftUnit: 'px' });
    const c: Canvas2DSpec = { referenceWidth: 650, referenceHeight: 1000, scaleMode: 'fitH' };
    const small = computeCanvas2DLayout(...args, 834, 1194, ui, a, c); // 1×
    const big = computeCanvas2DLayout(...args, 1668, 2388, ui, a, c);  // 2×
    expect(big.contentRect.x).toBeCloseTo(small.contentRect.x * 2, 3);
    expect(big.contentRect.y).toBeCloseTo(small.contentRect.y * 2, 3);
    expect(big.contentRect.w).toBeCloseTo(small.contentRect.w * 2, 3);
    expect(big.contentRect.h).toBeCloseTo(small.contentRect.h * 2, 3);
  });
});
