/**
 * readbackToRGBA unit tests — the backend-specific stride + orientation handling
 * for offscreen-capture readback. Guards two regressions that shipped before:
 *   - banding: WebGPU pads rows to 256 bytes (last row unpadded), so the stride
 *     must be computed from w, not inferred from buf.length.
 *   - upside-down: WebGPU is top-down (no flip); WebGL is bottom-up (flip).
 */

import { describe, it, expect } from 'vitest';
import { readbackToRGBA, type ReadbackBackend } from '../../src/runtime/rendering/readbackToRGBA';

/**
 * Build a synthetic readback buffer matching a backend's real row layout, with
 * each SOURCE row/column encoded into the pixel so the output reveals exactly
 * which source row+column each output pixel sampled (drift/flip both show up).
 *   R = source row, G = source column, B = 7 (const), A = 0 (must become 255).
 */
function buildReadback(w: number, h: number, backend: ReadbackBackend): Uint8Array {
  const unpadded = w * 4;
  const stride = backend === 'webgpu' ? Math.ceil(unpadded / 256) * 256 : unpadded;
  // three.js WebGPU buffer leaves the LAST row unpadded; WebGL is tightly packed.
  const len = backend === 'webgpu' ? (h - 1) * stride + unpadded : h * unpadded;
  const buf = new Uint8Array(len);
  for (let r = 0; r < h; r++) {
    const base = r * stride;
    for (let x = 0; x < w; x++) {
      buf[base + x * 4 + 0] = r & 0xff;
      buf[base + x * 4 + 1] = x & 0xff;
      buf[base + x * 4 + 2] = 7;
      buf[base + x * 4 + 3] = 0;
    }
  }
  return buf;
}

function px(out: Uint8ClampedArray, w: number, x: number, y: number): [number, number, number, number] {
  const i = (y * w + x) * 4;
  return [out[i], out[i + 1], out[i + 2], out[i + 3]];
}

describe('readbackToRGBA', () => {
  it('WebGPU: unpads a 256-padded, non-aligned width without drift (banding regression)', () => {
    const w = 900, h = 64; // 900*4=3600 → padded to 3840, so padding is non-zero
    const out = readbackToRGBA(buildReadback(w, h, 'webgpu'), w, h, 'webgpu');
    expect(out.length).toBe(w * h * 4);
    // WebGPU is top-down: output row y came from source row y, across the FULL
    // row width (the right edge is where a wrong stride would drift).
    for (const y of [0, 1, 31, 63]) {
      for (const x of [0, 1, 450, w - 1]) {
        expect(px(out, w, x, y)).toEqual([y & 0xff, x & 0xff, 7, 255]);
      }
    }
  });

  it('WebGPU: the stride must be computed, not inferred from buf.length', () => {
    // Demonstrates the original bug: floor(buf.length / h) underestimates the
    // true 3840-byte stride for width 900, which is why we compute it from w.
    const w = 900, h = 64;
    const padded = 3840, unpadded = 3600;
    const len = (h - 1) * padded + unpadded;
    expect(Math.floor(len / h)).not.toBe(padded);
  });

  it('WebGL: flips bottom-up readback vertically (upside-down regression)', () => {
    const w = 8, h = 4;
    const out = readbackToRGBA(buildReadback(w, h, 'webgl'), w, h, 'webgl');
    expect(out.length).toBe(w * h * 4);
    // WebGL is bottom-up: output row y came from source row (h-1-y).
    for (let y = 0; y < h; y++) {
      expect(px(out, w, 0, y)).toEqual([(h - 1 - y) & 0xff, 0, 7, 255]);
      expect(px(out, w, w - 1, y)).toEqual([(h - 1 - y) & 0xff, (w - 1) & 0xff, 7, 255]);
    }
  });

  it('WebGPU: an aligned width (multiple of 64) has no padding and stays top-down', () => {
    const w = 64, h = 4; // 64*4 = 256, already aligned → stride == w*4
    const out = readbackToRGBA(buildReadback(w, h, 'webgpu'), w, h, 'webgpu');
    for (let y = 0; y < h; y++) {
      expect(px(out, w, 0, y)).toEqual([y & 0xff, 0, 7, 255]);
    }
  });

  it('forces alpha to 255 even when readback alpha is 0', () => {
    const w = 16, h = 8;
    const out = readbackToRGBA(buildReadback(w, h, 'webgpu'), w, h, 'webgpu');
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(255);
  });
});
