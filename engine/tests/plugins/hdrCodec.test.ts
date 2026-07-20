/** HDR codec — RGBE encode + area-average downscale (Phase 4). Verifies the
 *  round-trip (our encoder → three's HDRLoader decoder) preserves HDR values within
 *  RGBE shared-exponent quantization, plus the pure downscale/target-dims math. */

import { describe, it, expect } from 'vitest';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { floatToRgbe, envTargetDims, downscaleRGBA, encodeHDR, readHdrHeaderDims } from '../../plugins/hdr-codec';

function decodeFloat(buf: Buffer): { data: Float32Array; width: number; height: number } {
  const loader = new HDRLoader();
  (loader as unknown as { type: number }).type = 1015; // FloatType
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return loader.parse(ab as ArrayBuffer) as { data: Float32Array; width: number; height: number };
}
function ramp(W: number, H: number): Float32Array {
  const a = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { a[i * 4] = (i % 9) * 2; a[i * 4 + 1] = (i % 4) * 1.1; a[i * 4 + 2] = (i % 6) * 0.7; a[i * 4 + 3] = 1; }
  return a;
}

describe('envTargetDims', () => {
  it('scales the longest edge to maxSize, preserving aspect', () => {
    expect(envTargetDims(2048, 1024, 1024)).toEqual({ width: 1024, height: 512 });
    expect(envTargetDims(2048, 1024, 512)).toEqual({ width: 512, height: 256 });
  });
  it('never upscales', () => {
    expect(envTargetDims(2048, 1024, 4096)).toEqual({ width: 2048, height: 1024 });
  });
});

describe('downscaleRGBA', () => {
  it('area-averages a 2×2 → 1×1 in linear space', () => {
    // RGBA of four pixels; average of R = (0+2+4+6)/4 = 3, etc. HDR values > 1 kept.
    const src = new Float32Array([
      0, 0, 0, 1, 2, 0, 0, 1,
      4, 0, 0, 1, 6, 0, 0, 1,
    ]);
    const out = downscaleRGBA(src, 2, 2, 1, 1);
    expect(out[0]).toBeCloseTo(3, 5);
  });
  it('returns the same array when dims are unchanged', () => {
    const src = new Float32Array([1, 2, 3, 1]);
    expect(downscaleRGBA(src, 1, 1, 1, 1)).toBe(src);
  });
});

describe('floatToRgbe', () => {
  it('encodes 0 as all-zero rgbe', () => {
    expect(floatToRgbe(0, 0, 0)).toEqual([0, 0, 0, 0]);
  });
  it('encodes an HDR value (>1) with a shared exponent', () => {
    const [r, g, b, e] = floatToRgbe(8, 4, 2);
    expect(e).toBeGreaterThan(128); // exponent byte reflects the >1 magnitude
    expect(r).toBeGreaterThan(g); // relative channel magnitudes preserved
    expect(g).toBeGreaterThan(b);
  });
  it('clamps the exponent byte to ≤255 for an extreme value (no wrap)', () => {
    const [, , , e] = floatToRgbe(1e40, 1e40, 1e40); // ~2^133 → e+128 would be >255
    expect(e).toBe(255);
  });
  it('handles NaN/Inf without a wrapped/garbage exponent', () => {
    expect(floatToRgbe(Number.NaN, 0, 0)).toEqual([0, 0, 0, 0]);
    const [, , , e] = floatToRgbe(Infinity, 0, 0);
    expect(e).toBeLessThanOrEqual(255);
  });
});

describe('readHdrHeaderDims', () => {
  it('parses the -Y H +X W resolution line', () => {
    const buf = encodeHDR(ramp(32, 16), 32, 16);
    expect(readHdrHeaderDims(buf)).toEqual({ width: 32, height: 16 });
  });
});

describe('encodeHDR edge cases', () => {
  it('round-trips a width that is NOT a multiple of 128', () => {
    const W = 100, H = 3; // 100 % 128 ≠ 0, exercises the final short literal chunk
    const tex = decodeFloat(encodeHDR(ramp(W, H), W, H));
    expect(tex.width).toBe(W); expect(tex.height).toBe(H);
    expect(tex.data[0]).toBeCloseTo(ramp(W, H)[0], 5);
  });
  it('round-trips width exactly 128 and height 1', () => {
    const t1 = decodeFloat(encodeHDR(ramp(128, 1), 128, 1));
    expect(t1.width).toBe(128); expect(t1.height).toBe(1);
    const t2 = decodeFloat(encodeHDR(ramp(256, 2), 256, 2));
    expect(t2.width).toBe(256);
  });
  it('throws (loud failure → source fallback) for a width < 8', () => {
    expect(() => encodeHDR(ramp(5, 2), 5, 2)).toThrow(/new-RLE range/);
  });
});

describe('encodeHDR round-trip (encode → HDRLoader.parse)', () => {
  it('preserves HDR pixel values within RGBE quantization', () => {
    const W = 16, H = 8;
    const src = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      // Varied radiance incl. HDR (>1) values across the image.
      src[i * 4] = (i % 5) * 3.0;       // R up to 12
      src[i * 4 + 1] = (i % 3) * 1.5;   // G
      src[i * 4 + 2] = (i % 7) * 0.4;   // B
      src[i * 4 + 3] = 1;
    }
    const buf = encodeHDR(src, W, H);

    const loader = new HDRLoader();
    (loader as unknown as { type: number }).type = 1015; // THREE.FloatType
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const tex = loader.parse(ab as ArrayBuffer) as { data: Float32Array; width: number; height: number };

    expect(tex.width).toBe(W);
    expect(tex.height).toBe(H);
    for (let i = 0; i < W * H; i++) {
      // RGBE shares ONE exponent per pixel, set by the dominant channel — so the
      // quantization step is (pixel max)/256. Every channel must land within ~2 steps
      // (this is the correct RGBE precision bound; small channels have coarse RELATIVE
      // precision by design, which is fine for a PMREM-blurred env).
      const pmax = Math.max(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]);
      const step = pmax / 256;
      for (let c = 0; c < 3; c++) {
        const err = Math.abs(tex.data[i * 4 + c] - src[i * 4 + c]);
        expect(err).toBeLessThanOrEqual(step * 2 + 1e-4);
      }
    }
  });
});
