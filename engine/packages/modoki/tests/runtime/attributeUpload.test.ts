/** particles F8 — partial dynamic-attribute upload (uploadDenseRows).
 *
 * commit() previously set needsUpdate=true on full maxParticles-sized buffers every
 * frame, re-uploading the whole pool even at low occupancy. uploadDenseRows marks only
 * the dense live prefix [0, rows*itemSize) via addUpdateRange, so the GPU upload scales
 * with aliveCount, not maxParticles. */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { uploadDenseRows } from '../../src/runtime/particles/attributeUpload';

function attr(maxRows: number, itemSize: number) {
  return new THREE.InstancedBufferAttribute(new Float32Array(maxRows * itemSize), itemSize);
}

describe('uploadDenseRows (F8 partial buffer upload)', () => {
  it('bumps version (needsUpdate) and sets a single range covering only the live prefix', () => {
    const a = attr(1000, 3); // 1000-cap, vec3
    const v0 = a.version;
    uploadDenseRows(a, 20);  // 20 live particles
    expect(a.version).toBe(v0 + 1); // needsUpdate=true bumps version (setter-only prop)
    expect(a.updateRanges).toEqual([{ start: 0, count: 20 * 3 }]); // 60 floats, not 3000
  });

  it('scales the range by itemSize (mat4 instanceMatrix = 16 floats/row)', () => {
    const a = attr(500, 16);
    uploadDenseRows(a, 7);
    expect(a.updateRanges).toEqual([{ start: 0, count: 7 * 16 }]);
  });

  it('clears any prior range so frames do not accumulate stale ranges', () => {
    const a = attr(100, 1);
    uploadDenseRows(a, 50);
    uploadDenseRows(a, 10); // next frame, fewer alive
    expect(a.updateRanges).toEqual([{ start: 0, count: 10 }]); // only the latest
  });

  it('emits no range when nothing is alive (still flags needsUpdate)', () => {
    const a = attr(100, 3);
    const v0 = a.version;
    uploadDenseRows(a, 0);
    expect(a.updateRanges).toEqual([]);
    expect(a.version).toBe(v0 + 1);
  });
});
