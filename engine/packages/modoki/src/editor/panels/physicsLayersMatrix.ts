/** The decisions behind `PhysicsLayersEditor.tsx` — the layer list + collision-matrix edits,
 *  kept out of the component so they carry a unit test (tests/editor/physicsLayersMatrix.test.ts).
 *
 *  INVARIANT: every function here returns a SYMMETRIC matrix (bit j of row i === bit i of
 *  row j). The grid shows each direction as its own checkbox, but the runtime ORs the two
 *  (`symmetrizeCollisionMatrix`), so an asymmetric pair renders one cell checked while the
 *  pair always collides — and `toggle`'s XOR flip can never close that gap (#1174). So the
 *  value is normalized through the runtime's own OR on read, and every edit preserves it. */

import { symmetrizeCollisionMatrix } from '../../runtime/physics/physicsLayers';

export const MAX_LAYERS = 16;
const ALL = 0xffff;

export interface PhysicsLayersValue {
  layers: string[];
  collisionMatrix: number[];
}

/** Coerce a stored settings value into a valid, symmetric editor value. A missing row is
 *  all-ones (collide with everything), matching `setPhysicsLayers`' default. */
export function normalizePhysicsLayers(value: unknown): PhysicsLayersValue {
  const v = (value ?? {}) as Partial<PhysicsLayersValue>;
  const layers = Array.isArray(v.layers) && v.layers.length > 0 ? v.layers.slice(0, MAX_LAYERS) : ['Default'];
  const src = Array.isArray(v.collisionMatrix) ? v.collisionMatrix : [];
  const matrix = layers.map((_, i) => (typeof src[i] === 'number' ? (src[i] & ALL) >>> 0 : ALL));
  return { layers, collisionMatrix: symmetrizeCollisionMatrix(matrix) };
}

/** Flip whether layers i and j collide — both directions, so a symmetric matrix stays so. */
export function toggleLayerPair(matrix: number[], i: number, j: number): number[] {
  const m = matrix.slice();
  if (i === j) { m[i] ^= (1 << i); }
  else { m[i] ^= (1 << j); m[j] ^= (1 << i); }
  m[i] &= ALL; m[j] &= ALL;
  return m;
}

/** First free `Layer N` name. */
export function uniqueLayerName(layers: string[]): string {
  let n = layers.length;
  let name = `Layer ${n}`;
  while (layers.includes(name)) name = `Layer ${++n}`;
  return name;
}

/** Append a layer that collides with every existing layer. The new layer's bit is set on
 *  every existing row EXPLICITLY — a customized matrix does not already carry it (#1174). */
export function addPhysicsLayer(value: PhysicsLayersValue): PhysicsLayersValue {
  const { layers, collisionMatrix } = value;
  if (layers.length >= MAX_LAYERS) return value;
  const k = layers.length;
  return {
    layers: [...layers, uniqueLayerName(layers)],
    collisionMatrix: [...collisionMatrix.map((row) => (row | (1 << k)) & ALL), ALL],
  };
}

/** Drop bit k from a 16-bit mask and shift higher bits down one (layer removal). */
function removeBit(v: number, k: number): number {
  const low = v & ((1 << k) - 1);
  const high = (v >>> (k + 1)) << k;
  return (low | high) & ALL;
}

/** Remove layer k (never the last one). */
export function removePhysicsLayer(value: PhysicsLayersValue, k: number): PhysicsLayersValue {
  const { layers, collisionMatrix } = value;
  if (layers.length <= 1) return value;
  return {
    layers: layers.filter((_, i) => i !== k),
    collisionMatrix: collisionMatrix.filter((_, i) => i !== k).map((row) => removeBit(row, k)),
  };
}

/** Does the grid show layer i colliding with layer j? */
export function layerPairChecked(matrix: number[], i: number, j: number): boolean {
  return (matrix[i] & (1 << j)) !== 0;
}
