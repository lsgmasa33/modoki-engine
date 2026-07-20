/** Small shared helpers for material builders. */

import * as THREE from 'three';

/** Map a .mat.json `side` field ('double' | 'back' | anything else) to a THREE.Side. */
export const sideOf = (v: unknown): THREE.Side =>
  v === 'double' ? THREE.DoubleSide : v === 'back' ? THREE.BackSide : THREE.FrontSide;
