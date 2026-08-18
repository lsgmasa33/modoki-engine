/** PhysicsLayersEditor — adding a layer must keep the collision matrix SYMMETRIC.
 *
 *  The panel's "+ Add layer" used to append an all-ones row without setting the new
 *  layer's bit on the existing rows. That is invisible on a default (all-ones) matrix
 *  and wrong on every customized one: the saved matrix is asymmetric, and the runtime's
 *  symmetrize() ORs the gap closed on load — so the grid the human just authored is not
 *  what the game ends up doing. */

import { describe, it, expect } from 'vitest';
import { appendLayerRow } from '../../src/editor/panels/PhysicsLayersEditor';

/** matrix[i] has bit j iff layers i and j collide. */
const isSymmetric = (m: number[]) =>
  m.every((row, i) => m.every((_, j) => ((row >>> j) & 1) === ((m[j] >>> i) & 1)));

describe('appendLayerRow', () => {
  it('sets the new layer bit on every EXISTING row (customized matrix stays symmetric)', () => {
    // demos/2d-physics-demo's real baseline — deliberately not all-ones.
    const next = appendLayerRow([3, 7, 2]);
    expect(next).toHaveLength(4);
    expect(next[3]).toBe(0xffff);        // the new row collides with everything
    expect(next[0] & (1 << 3)).toBeTruthy();
    expect(next[1] & (1 << 3)).toBeTruthy();
    expect(next[2] & (1 << 3)).toBeTruthy();
    expect(isSymmetric(next)).toBe(true);
  });

  it('preserves the existing rows other bits — it only ORs the new one in', () => {
    const next = appendLayerRow([3, 7, 2]);
    expect(next[0] & 0b111).toBe(3);
    expect(next[1] & 0b111).toBe(7);
    expect(next[2] & 0b111).toBe(2);
  });

  it('is a no-op in effect on an all-ones (default) matrix — the old behaviour', () => {
    expect(appendLayerRow([0xffff])).toEqual([0xffff, 0xffff]);
  });

  it('stays inside 16 bits', () => {
    const next = appendLayerRow(Array(15).fill(0));
    expect(next.every((row) => row >= 0 && row <= 0xffff)).toBe(true);
    expect(next[0]).toBe(1 << 15);
  });
});
