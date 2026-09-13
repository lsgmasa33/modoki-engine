/** Physics Layers dialog decisions (#1174). The grid shows each direction of a layer pair as
 *  its own checkbox, but the runtime ORs the two — so every edit must keep the matrix
 *  symmetric, or a pair the grid shows as "not colliding" still collides at runtime. */

import { describe, it, expect } from 'vitest';
import {
  normalizePhysicsLayers, toggleLayerPair, addPhysicsLayer, removePhysicsLayer, layerPairChecked, MAX_LAYERS,
} from '../../src/editor/panels/physicsLayersMatrix';
import {
  setPhysicsLayers, resetPhysicsLayers, layersCollide, getPhysicsLayerMatrix,
} from '../../src/runtime/physics/physicsLayers';

const isSymmetric = (m: number[]) =>
  m.every((_, i) => m.every((__, j) => ((m[i] >>> j) & 1) === ((m[j] >>> i) & 1)));

describe('physicsLayersMatrix', () => {
  it('#1174 repro: + Add layer on a customized matrix, then one click decouples the new pair — at runtime too', () => {
    // demos/2d-physics-demo's shipped matrix: Default, Ground, Ghost.
    let v = normalizePhysicsLayers({ layers: ['Default', 'Ground', 'Ghost'], collisionMatrix: [3, 7, 2] });
    v = addPhysicsLayer(v);
    expect(v.layers).toEqual(['Default', 'Ground', 'Ghost', 'Layer 3']);
    expect(isSymmetric(v.collisionMatrix)).toBe(true);
    // The new layer collides with every existing one, in BOTH grid cells.
    for (let i = 0; i < 3; i++) {
      expect(layerPairChecked(v.collisionMatrix, i, 3)).toBe(true);
      expect(layerPairChecked(v.collisionMatrix, 3, i)).toBe(true);
    }
    // The body's click: cell (2,3) once → both cells unchecked, and the runtime agrees.
    v = { ...v, collisionMatrix: toggleLayerPair(v.collisionMatrix, 2, 3) };
    expect(layerPairChecked(v.collisionMatrix, 2, 3)).toBe(false);
    expect(layerPairChecked(v.collisionMatrix, 3, 2)).toBe(false);
    try {
      setPhysicsLayers(v);
      expect(layersCollide(2, 3)).toBe(false);
      expect(layersCollide(3, 2)).toBe(false);
    } finally { resetPhysicsLayers(); }
  });

  it('reads an asymmetric stored matrix through the runtime OR, so grid and runtime agree on every pair', () => {
    const stored = { layers: ['A', 'B', 'C'], collisionMatrix: [0b001, 0b011, 0b100] }; // B→A only
    const v = normalizePhysicsLayers(stored);
    try {
      setPhysicsLayers(stored);
      expect(v.collisionMatrix).toEqual(getPhysicsLayerMatrix());
    } finally { resetPhysicsLayers(); }
    expect(layerPairChecked(v.collisionMatrix, 0, 1)).toBe(true);
    // ...and a toggle on that pair now actually decouples it.
    const m = toggleLayerPair(v.collisionMatrix, 0, 1);
    expect(layerPairChecked(m, 0, 1) || layerPairChecked(m, 1, 0)).toBe(false);
  });

  it('adding to a default all-ones matrix is unchanged behaviour', () => {
    const v = addPhysicsLayer(normalizePhysicsLayers({ layers: ['Default'], collisionMatrix: [0xffff] }));
    expect(v.collisionMatrix).toEqual([0xffff, 0xffff]);
  });

  it('remove keeps symmetry and shifts higher layers down', () => {
    const v = removePhysicsLayer(normalizePhysicsLayers({ layers: ['A', 'B', 'C'], collisionMatrix: [0b101, 0b010, 0b101] }), 1);
    expect(v.layers).toEqual(['A', 'C']);
    expect(v.collisionMatrix).toEqual([0b11, 0b11]);
  });

  it('respects the 16-layer cap and the keep-one floor', () => {
    const full = normalizePhysicsLayers({ layers: Array.from({ length: MAX_LAYERS }, (_, i) => `L${i}`) });
    expect(addPhysicsLayer(full)).toBe(full);
    const one = normalizePhysicsLayers({ layers: ['Default'] });
    expect(removePhysicsLayer(one, 0)).toBe(one);
  });
});
