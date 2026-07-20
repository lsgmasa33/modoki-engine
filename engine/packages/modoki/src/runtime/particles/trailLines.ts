/**
 * Trail render object: a single `THREE.LineSegments` drawing each particle's recent
 * position history as a fading streak. The simulator owns the per-particle history (it
 * already manages the pool + swap-remove) and writes the line vertices/colors straight
 * into these buffers each frame; this module just owns the geometry/material and the
 * per-frame draw-range update.
 *
 * Uses a classic `LineBasicMaterial` with vertex colors — proven to render under Modoki's
 * WebGPURenderer (the editor grid is the same primitive), unlike `THREE.Points`. Per-vertex
 * alpha isn't available on classic lines, so the fade is baked into the vertex RGB and read
 * as an alpha taper under additive blending (the typical trail look).
 */

import * as THREE from 'three';
import { uploadDenseRows } from './attributeUpload';
import type { RenderConfig } from './types';
import type { TrailOutputs } from './cpuSimulator';

export interface TrailObject {
  mesh: THREE.LineSegments;
  outputs: TrailOutputs;
  /** Set the draw range to the live particle count this frame + upload. */
  commit(aliveCount: number): void;
  dispose(): void;
}

export function createTrail(maxParticles: number, segments: number, render: RenderConfig): TrailObject {
  const seg = Math.max(2, Math.floor(segments));
  const vPer = (seg - 1) * 2; // vertices per particle (line-list)
  const positions = new Float32Array(maxParticles * vPer * 3);
  const colors = new Float32Array(maxParticles * vPer * 3);

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', colAttr);
  geo.setDrawRange(0, 0);

  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: render.blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
  });

  const mesh = new THREE.LineSegments(geo, mat);
  mesh.frustumCulled = false;
  if (render.renderOrder != null) mesh.renderOrder = render.renderOrder;

  return {
    mesh,
    outputs: { positions, colors },
    commit(aliveCount: number) {
      // Hide rather than issue a 0-vertex draw (WebGPU warns on empty draws).
      mesh.visible = aliveCount > 0;
      const liveVerts = aliveCount * vPer;
      geo.setDrawRange(0, liveVerts);
      // Upload only the live vertices, not the whole maxParticles*vPer buffer (F8).
      uploadDenseRows(posAttr, liveVerts);
      uploadDenseRows(colAttr, liveVerts);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
