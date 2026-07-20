import { describe, it, expect } from 'vitest';
import { computeCanvasScale } from '../../packages/modoki/src/runtime/rendering/canvas2DScaler';

// Helper: design coords → pixel coords
function toPixel(cs: ReturnType<typeof computeCanvasScale>, dx: number, dy: number) {
  return { px: dx * cs.scaleX + cs.offsetX, py: dy * cs.scaleY + cs.offsetY };
}

describe('computeCanvasScale', () => {
  // ── Edge cases ──

  it('returns identity when inputs are zero or negative', () => {
    const cs = computeCanvasScale(0, 0, 100, 100, 'fitH');
    expect(cs.scale).toBe(1);
    expect(cs.compensateX).toBe(1);
    expect(cs.compensateY).toBe(1);
  });

  // ── fitW ──

  describe('fitW', () => {
    it('uniform scale = actualW / refW', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 960, 'fitW');
      expect(cs.scaleX).toBeCloseTo(0.5);
      expect(cs.scaleY).toBeCloseTo(0.5);
    });

    it('matches width exactly, centers vertically', () => {
      // wider canvas than reference aspect → vertical letterbox
      const cs = computeCanvasScale(1080, 1920, 540, 800, 'fitW');
      expect(cs.scaleX).toBeCloseTo(0.5);
      expect(cs.scaleY).toBeCloseTo(0.5);
      expect(cs.offsetX).toBeCloseTo(0); // width matches exactly
      // extra vertical space = (800 - 1920*0.5) / 2 = (800-960)/2 = -80 (crops top/bottom)
      expect(cs.offsetY).toBeCloseTo(-80);
    });

    it('compensation is 1 (uniform)', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 800, 'fitW');
      expect(cs.compensateX).toBeCloseTo(1);
      expect(cs.compensateY).toBeCloseTo(1);
    });

    it('design center maps to pixel center', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 960, 'fitW');
      const { px, py } = toPixel(cs, 540, 960);
      expect(px).toBeCloseTo(270);
      expect(py).toBeCloseTo(480);
    });
  });

  // ── fitH ──

  describe('fitH', () => {
    it('uniform scale = actualH / refH', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 960, 'fitH');
      expect(cs.scaleX).toBeCloseTo(0.5);
      expect(cs.scaleY).toBeCloseTo(0.5);
    });

    it('matches height exactly, centers horizontally', () => {
      // narrower canvas → horizontal letterbox
      const cs = computeCanvasScale(1080, 1920, 400, 960, 'fitH');
      expect(cs.scaleY).toBeCloseTo(0.5);
      expect(cs.scaleX).toBeCloseTo(0.5);
      expect(cs.offsetY).toBeCloseTo(0); // height matches exactly
      // extra horizontal space = (400 - 1080*0.5) / 2 = (400-540)/2 = -70 (crops left/right)
      expect(cs.offsetX).toBeCloseTo(-70);
    });

    it('compensation is 1 (uniform)', () => {
      const cs = computeCanvasScale(1080, 1920, 400, 960, 'fitH');
      expect(cs.compensateX).toBeCloseTo(1);
      expect(cs.compensateY).toBeCloseTo(1);
    });

    it('design center maps to pixel center', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 960, 'fitH');
      const { px, py } = toPixel(cs, 540, 960);
      expect(px).toBeCloseTo(270);
      expect(py).toBeCloseTo(480);
    });
  });

  // ── fill ──

  describe('fill', () => {
    it('non-uniform scale stretches to fill', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 480, 'fill');
      expect(cs.scaleX).toBeCloseTo(0.5);    // 540/1080
      expect(cs.scaleY).toBeCloseTo(0.25);   // 480/1920
    });

    it('offsets are zero (fills exactly)', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 480, 'fill');
      expect(cs.offsetX).toBeCloseTo(0);
      expect(cs.offsetY).toBeCloseTo(0);
    });

    it('design corners map to canvas corners', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 480, 'fill');
      const topLeft = toPixel(cs, 0, 0);
      const bottomRight = toPixel(cs, 1080, 1920);
      expect(topLeft.px).toBeCloseTo(0);
      expect(topLeft.py).toBeCloseTo(0);
      expect(bottomRight.px).toBeCloseTo(540);
      expect(bottomRight.py).toBeCloseTo(480);
    });

    it('compensation undoes stretch for shapes', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 480, 'fill');
      // scale = min(0.5, 0.25) = 0.25
      expect(cs.scale).toBeCloseTo(0.25);
      // compensateX = 0.25 / 0.5 = 0.5
      expect(cs.compensateX).toBeCloseTo(0.5);
      // compensateY = 0.25 / 0.25 = 1
      expect(cs.compensateY).toBeCloseTo(1);
    });

    it('shape scale is uniform after compensation', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 480, 'fill');
      // Effective shape scale on each axis should be equal: scaleX * compensateX === scaleY * compensateY
      expect(cs.scaleX * cs.compensateX).toBeCloseTo(cs.scaleY * cs.compensateY);
      // And both should equal the uniform scale
      expect(cs.scaleX * cs.compensateX).toBeCloseTo(cs.scale);
    });

    it('design center maps to pixel center', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 480, 'fill');
      const { px, py } = toPixel(cs, 540, 960);
      expect(px).toBeCloseTo(270);
      expect(py).toBeCloseTo(240);
    });
  });

  // ── none ──

  describe('none', () => {
    it('scale is 1:1', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 960, 'none');
      expect(cs.scaleX).toBe(1);
      expect(cs.scaleY).toBe(1);
    });

    it('centers the 1:1 reference region in the canvas (doc: "1:1 pixels, centered")', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 960, 'none');
      // 1080×1920 reference centered in a 540×960 canvas → offset by half the difference.
      expect(cs.offsetX).toBe((540 - 1080) / 2); // -270
      expect(cs.offsetY).toBe((960 - 1920) / 2); // -480
    });

    it('compensation is 1', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 960, 'none');
      expect(cs.compensateX).toBe(1);
      expect(cs.compensateY).toBe(1);
    });
  });

  // ── contain (uniform, fit entirely inside → letterbox) ──

  describe('contain', () => {
    it('fits a portrait reference inside a wider canvas, letterboxing horizontally', () => {
      // ref 1080×1920 into 1080×1440: min(1, 0.75) = 0.75. Height binds.
      const cs = computeCanvasScale(1080, 1920, 1080, 1440, 'contain');
      expect(cs.scaleX).toBeCloseTo(0.75);
      expect(cs.scaleY).toBeCloseTo(0.75);
      expect(1920 * cs.scaleY).toBeCloseTo(1440); // height fills
      expect(1080 * cs.scaleX).toBeCloseTo(810);  // width 810 < 1080 → letterbox
      expect(cs.offsetX).toBeCloseTo((1080 - 810) / 2); // 135
      expect(cs.offsetY).toBeCloseTo(0);
      expect(cs.compensateX).toBeCloseTo(1); // uniform
    });

    it('content fits ENTIRELY inside on both axes', () => {
      const cs = computeCanvasScale(1920, 1080, 1080, 1920, 'contain'); // landscape ref, portrait canvas
      expect(1920 * cs.scaleX).toBeLessThanOrEqual(1080 + 1e-6);
      expect(1080 * cs.scaleY).toBeLessThanOrEqual(1920 + 1e-6);
    });
  });

  // ── cover (uniform, cover the canvas → crop overflow) ──

  describe('cover', () => {
    it('covers a wider canvas with a portrait reference, cropping the height', () => {
      // ref 1080×1920 into 1080×1440: max(1, 0.75) = 1. Width binds, height overflows.
      const cs = computeCanvasScale(1080, 1920, 1080, 1440, 'cover');
      expect(cs.scaleX).toBeCloseTo(1);
      expect(cs.scaleY).toBeCloseTo(1);
      expect(1080 * cs.scaleX).toBeCloseTo(1080); // width fills
      expect(1920 * cs.scaleY).toBeCloseTo(1920); // height 1920 > 1440 → cropped
      expect(cs.offsetY).toBeCloseTo((1440 - 1920) / 2); // -240 (crop top/bottom)
      expect(cs.offsetX).toBeCloseTo(0);
    });

    it('content COVERS the canvas on both axes', () => {
      const cs = computeCanvasScale(1920, 1080, 1080, 1920, 'cover');
      expect(1920 * cs.scaleX).toBeGreaterThanOrEqual(1080 - 1e-6);
      expect(1080 * cs.scaleY).toBeGreaterThanOrEqual(1920 - 1e-6);
    });
  });

  // ── Same aspect ratio ──

  describe('same aspect ratio', () => {
    it('fitW and fitH produce identical results', () => {
      const a = computeCanvasScale(1080, 1920, 540, 960, 'fitW');
      const b = computeCanvasScale(1080, 1920, 540, 960, 'fitH');
      expect(a.scaleX).toBeCloseTo(b.scaleX);
      expect(a.scaleY).toBeCloseTo(b.scaleY);
      expect(a.offsetX).toBeCloseTo(b.offsetX);
      expect(a.offsetY).toBeCloseTo(b.offsetY);
    });

    it('fill has compensation 1 (no stretch needed)', () => {
      const cs = computeCanvasScale(1080, 1920, 540, 960, 'fill');
      expect(cs.compensateX).toBeCloseTo(1);
      expect(cs.compensateY).toBeCloseTo(1);
    });
  });
});
