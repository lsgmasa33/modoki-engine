/**
 * Pure instance-matrix composition for the mesh particle render path. Kept separate from
 * meshParticles.ts (which imports `three/webgpu` node materials) so it depends only on
 * core `three` math and stays unit-testable without a GPU/WebGPU module graph.
 */

import * as THREE from 'three';

// Reused scratch — runs per-frame over every alive particle.
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * Compose `count` instance matrices from the simulator's flat outputs into `out`
 * (column-major, 16 floats per instance). The single `rotations[i]` scalar drives a
 * 3-axis tumble (different rates per axis) so a primitive spins in 3D from one value.
 */
export function composeParticleMatrices(
  offsets: Float32Array,
  scales: Float32Array,
  rotations: Float32Array,
  count: number,
  out: Float32Array,
): void {
  for (let i = 0; i < count; i++) {
    const r = rotations[i];
    _e.set(r, r * 0.73, r * 0.31);
    _q.setFromEuler(_e);
    const sc = scales[i];
    _p.set(offsets[i * 3], offsets[i * 3 + 1], offsets[i * 3 + 2]);
    _s.set(sc, sc, sc);
    _m.compose(_p, _q, _s);
    _m.toArray(out, i * 16);
  }
}
