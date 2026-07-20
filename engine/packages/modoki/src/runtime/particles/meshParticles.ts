/**
 * Mesh particle render path: each particle is an instance of a small 3D primitive
 * (box/sphere/cone/tetra/torus) drawn through a single `THREE.InstancedMesh`. Useful for
 * debris, confetti, rocks, coins — anything that should tumble in 3D rather than face the
 * camera like a billboard.
 *
 * Returns the same {@link BillboardObject} shape the sprite path does, so the backend can
 * swap render paths without caring which it built. Per-instance transform comes from the
 * simulator's offsets/scales/rotations (composed CPU-side into the instance matrix each
 * frame); per-instance color/opacity ride along as TSL attribute nodes, zero-copy like the
 * billboard path. A single `rotation` scalar is fanned out across all three axes so the
 * primitive tumbles convincingly without the simulator needing a full quaternion per particle.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute } from 'three/tsl';
import type { MeshPrimitive, RenderConfig } from './types';
import type { ParticleOutputs } from './cpuSimulator';
import type { BillboardObject } from './spriteBillboard';
import { composeParticleMatrices } from './meshMatrices';
import { uploadDenseRows } from './attributeUpload';

/**
 * Build the unit primitive geometry for a mesh particle (shared by the CPU InstancedMesh
 * path here and the GPU instanced-storage path in gpuComputeBackend). Sizes are ~unit so
 * the per-particle `scale` maps directly to world size.
 */
export function makeParticlePrimitiveGeometry(prim: MeshPrimitive | undefined): THREE.BufferGeometry {
  switch (prim) {
    case 'sphere': return new THREE.SphereGeometry(0.5, 12, 8);
    case 'cone': return new THREE.ConeGeometry(0.5, 1, 12);
    case 'tetra': return new THREE.TetrahedronGeometry(0.6);
    case 'torus': return new THREE.TorusGeometry(0.38, 0.18, 8, 16);
    case 'box':
    default: return new THREE.BoxGeometry(1, 1, 1);
  }
}

export function createMeshParticles(maxParticles: number, render: RenderConfig): BillboardObject {
  const geo = makeParticlePrimitiveGeometry(render.meshPrimitive);

  // Per-instance color + opacity (read via TSL); written into directly by the simulator.
  const colors = new Float32Array(maxParticles * 3);
  const opacities = new Float32Array(maxParticles);
  const aColor = new THREE.InstancedBufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
  const aOpacity = new THREE.InstancedBufferAttribute(opacities, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aColor', aColor);
  geo.setAttribute('aOpacity', aOpacity);

  const additive = render.blend === 'additive';
  const Mat = render.meshLit ? MeshStandardNodeMaterial : MeshBasicNodeMaterial;
  const mat = new Mat({
    transparent: true,
    depthWrite: !additive, // solid (normal-blend) chunks should write depth; additive glow should not
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  mat.colorNode = attribute('aColor', 'vec3');
  mat.opacityNode = attribute('aOpacity', 'float');

  const mesh = new THREE.InstancedMesh(geo, mat, maxParticles);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false; // emitter-origin bounds would wrongly cull spread particles
  mesh.count = 0;
  if (render.renderOrder != null) mesh.renderOrder = render.renderOrder;

  // offsets/scales/rotations stay CPU-side (consumed into the instance matrix); colors/opacities
  // alias the GPU instance buffers so the simulator writes straight through. frames unused.
  const outputs: ParticleOutputs = {
    offsets: new Float32Array(maxParticles * 3),
    scales: new Float32Array(maxParticles),
    colors,
    opacities,
    rotations: new Float32Array(maxParticles),
    frames: new Float32Array(maxParticles),
  };

  return {
    mesh,
    outputs,
    commit(aliveCount: number) {
      composeParticleMatrices(outputs.offsets, outputs.scales, outputs.rotations, aliveCount, mesh.instanceMatrix.array as Float32Array);
      mesh.count = aliveCount;
      // Upload only the dense live prefix [0, aliveCount), not the whole pool (F8).
      uploadDenseRows(mesh.instanceMatrix, aliveCount);
      uploadDenseRows(aColor, aliveCount);
      uploadDenseRows(aOpacity, aliveCount);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      mesh.dispose();
    },
  };
}
