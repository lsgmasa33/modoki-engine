/** The engine ships a procedurally-generated `white.hdr` (see
 *  engine/scripts/gen-white-hdr.mjs) used as the default environment for freshly
 *  created scenes (newScene()). It's a hand-rolled RGBE/RLE Radiance file, so this
 *  test guards that the committed bytes actually DECODE via the same loader the
 *  runtime uses (three's HDRLoader, formerly RGBELoader) to a uniform-white image.
 *  It also pins the .meta.json GUID that newScene() references. */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FloatType } from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { WHITE_HDR_GUID } from '../../packages/modoki/src/runtime/assets/builtinAssets';

const ASSET_DIR = path.resolve(__dirname, '../../packages/modoki/src/runtime/assets');
const HDR = path.join(ASSET_DIR, 'white.hdr');
const META = path.join(ASSET_DIR, 'white.hdr.meta.json');

function parseHdr() {
  const buf = fs.readFileSync(HDR);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new HDRLoader();
  loader.type = FloatType; // decode to Float32 so pixel values are directly readable
  return loader.parse(ab) as { width: number; height: number; data: Float32Array };
}

describe('white.hdr', () => {
  it('decodes via three HDRLoader to a 16×8 image', () => {
    const { width, height } = parseHdr();
    expect(width).toBe(16);
    expect(height).toBe(8);
  });

  it('is uniformly white (every RGB channel ≈ 1.0)', () => {
    const { data, width, height } = parseHdr();
    expect(data.length).toBe(width * height * 4); // RGBA float
    // RGBE decode reconstructs ~1.004 (the mantissa +0.5 rounding), not exactly
    // 1.0 — what matters is every pixel is the SAME near-white value.
    const [r0, g0, b0] = [data[0], data[1], data[2]];
    expect(r0).toBeCloseTo(1.0, 2);
    for (let i = 0; i < data.length; i += 4) {
      expect(data[i]).toBe(r0);     // R uniform
      expect(data[i + 1]).toBe(g0); // G uniform
      expect(data[i + 2]).toBe(b0); // B uniform
    }
  });

  it('sidecar GUID matches the runtime WHITE_HDR_GUID const (no drift)', () => {
    const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
    expect(meta.id).toBe(WHITE_HDR_GUID);
    expect(meta.version).toBe(2);
  });
});
