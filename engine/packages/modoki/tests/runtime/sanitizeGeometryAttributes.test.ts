/** Runtime defense for the WebGPU "Vertex format not supported yet" crash.
 *
 *  loadModelTemplates runs sanitizeGeometryAttributes over every cached mesh so
 *  a geometry that carries an attribute WebGPU's NodeMaterial pipeline can't
 *  bind never reaches createRenderPipeline (which throws every frame and
 *  freezes the view). Two unsupported shapes are dequantized to plain Float32:
 *    - FLOAT but flagged `normalized` (no float32-norm GPU format),
 *    - a narrow (8/16-bit) 3-component attribute (no xint*x3 format).
 *  Valid formats — plain Float32, or a 2-/4-component normalized int that maps
 *  to unorm16x2 / snorm16x4 — must be left byte-identical (no needless deopt).
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { sanitizeGeometryAttributes } from '../../src/runtime/loaders/meshTemplateCache';

describe('sanitizeGeometryAttributes', () => {
  it('clears the bogus normalized flag on a FLOAT attribute (keeps values)', () => {
    const geo = new THREE.BufferGeometry();
    const uv = new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2);
    uv.normalized = true; // malformed: FLOAT + normalized — no WebGPU format
    geo.setAttribute('uv', uv);

    sanitizeGeometryAttributes(geo);

    const out = geo.getAttribute('uv');
    expect(out.array).toBeInstanceOf(Float32Array);
    expect(out.normalized).toBe(false);
    expect(Array.from(out.array as Float32Array)).toEqual([0, 0, 1, 0, 0, 1]);
  });

  it('dequantizes a narrow normalized vec3 (no xint16x3 format) to Float32', () => {
    const geo = new THREE.BufferGeometry();
    // Int16 normalized POSITION at full-scale: 32767 -> 1, -32767 -> -1.
    const pos = new THREE.Int16BufferAttribute(new Int16Array([0, 0, 0, 32767, 0, -32767]), 3);
    pos.normalized = true;
    geo.setAttribute('position', pos);

    sanitizeGeometryAttributes(geo);

    const out = geo.getAttribute('position');
    expect(out.array).toBeInstanceOf(Float32Array);
    expect(out.normalized).toBe(false);
    const vals = Array.from(out.array as Float32Array);
    expect(vals[0]).toBeCloseTo(0, 5);
    expect(vals[3]).toBeCloseTo(1, 4);
    expect(vals[5]).toBeCloseTo(-1, 4);
  });

  it('leaves a plain Float32 attribute byte-identical', () => {
    const geo = new THREE.BufferGeometry();
    const src = new Float32Array([0, 0, 0, 1, 2, 3]);
    geo.setAttribute('position', new THREE.BufferAttribute(src, 3));

    sanitizeGeometryAttributes(geo);

    // Same backing array instance — untouched, no realloc.
    expect(geo.getAttribute('position').array).toBe(src);
  });

  it('leaves a valid 2-component normalized int (unorm16x2 UV) untouched', () => {
    const geo = new THREE.BufferGeometry();
    const uv = new THREE.Uint16BufferAttribute([0, 0, 65535, 0, 0, 65535], 2, true);
    geo.setAttribute('uv', uv); // unorm16x2 — a real WebGPU format
    const before = geo.getAttribute('uv').array;

    sanitizeGeometryAttributes(geo);

    const out = geo.getAttribute('uv');
    // Still the same Uint16 buffer — not deopted to Float32.
    expect(out.array).toBe(before);
    expect(out.array).toBeInstanceOf(Uint16Array);
    expect(out.normalized).toBe(true);
  });

  // ── F8: the specialized typed-array dequant fast path must be byte-identical
  // to THREE's generic getX/Y/Z/W denormalize. For each normalized integer type
  // we compare the sanitized output against what getX/getY/getZ would have read
  // from the SAME raw attribute, so any divergence in scale / signed-clamp is
  // caught regardless of the implementation chosen.
  const dequantCases: Array<{ name: string; attr: () => THREE.BufferAttribute }> = [
    {
      name: 'normalized Int16 vec3 (snorm16x3)',
      attr: () => new THREE.Int16BufferAttribute(new Int16Array([0, 16384, -16384, 32767, -32767, 12345, -1, 1, -30000]), 3, true),
    },
    {
      name: 'normalized Int8 vec3 (snorm8x3)',
      attr: () => new THREE.Int8BufferAttribute(new Int8Array([0, 64, -64, 127, -127, 33, -1, 1, -120]), 3, true),
    },
    {
      name: 'normalized Uint8 vec3 (unorm8x3)',
      attr: () => new THREE.Uint8BufferAttribute(new Uint8Array([0, 128, 255, 64, 200, 1, 255, 0, 99]), 3, true),
    },
    {
      name: 'normalized Uint16 vec3 (unorm16x3)',
      attr: () => new THREE.Uint16BufferAttribute(new Uint16Array([0, 32768, 65535, 12345, 60000, 1, 65535, 0, 7777]), 3, true),
    },
  ];

  for (const c of dequantCases) {
    it(`dequantizes ${c.name} byte-identically to the generic getX/Y/Z path`, () => {
      const ref = c.attr(); // untouched reference for the generic denormalize
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', c.attr());

      sanitizeGeometryAttributes(geo);

      const out = geo.getAttribute('position');
      expect(out.array).toBeInstanceOf(Float32Array);
      expect(out.normalized).toBe(false);
      expect(out.count).toBe(ref.count);

      // Expected = exactly what the generic getX/Y/Z path produced: THREE's
      // float64 denormalize, truncated by storing into a Float32Array. The fast
      // path must be byte-identical to this — same backing array contents.
      const expected = new Float32Array(ref.count * ref.itemSize);
      for (let i = 0; i < ref.count; i++) {
        expected[i * 3]     = ref.getX(i);
        expected[i * 3 + 1] = ref.getY(i);
        expected[i * 3 + 2] = ref.getZ(i);
      }
      expect(Array.from(out.array as Float32Array)).toEqual(Array.from(expected));
    });
  }

  it('dequantizes an interleaved normalized attribute via the generic fallback', () => {
    // Interleaved storage has stride/offset, so `.array` is not a flat
    // per-component buffer — the fast path must skip it and the generic
    // getX/Y/Z path must still produce correct values.
    const raw = new Int16Array([
      32767, 0, -32767, 0, // vertex 0: pos(1,0,-1) + 1 pad
      0, 32767, 0, 0,      // vertex 1: pos(0,1,0) + 1 pad
    ]);
    const ib = new THREE.InterleavedBuffer(raw, 4);
    const pos = new THREE.InterleavedBufferAttribute(ib, 3, 0, true);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', pos);

    sanitizeGeometryAttributes(geo);

    const out = geo.getAttribute('position');
    expect(out.array).toBeInstanceOf(Float32Array);
    expect(out.normalized).toBe(false);
    expect(out.getX(0)).toBeCloseTo(1, 4);
    expect(out.getZ(0)).toBeCloseTo(-1, 4);
    expect(out.getY(1)).toBeCloseTo(1, 4);
  });
});
