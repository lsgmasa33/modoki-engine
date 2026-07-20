/**
 * The validated WebGPU render primitive: instanced billboard quads via SpriteNodeMaterial,
 * with per-instance position/scale/color/opacity/rotation/frame fed through TSL attribute
 * nodes. Round soft particles by default; an optional texture (with sprite-sheet tiling)
 * replaces the radial alpha. This works under WebGPURenderer where THREE.Points does not
 * (WebGPU has no point-coord builtin and clamps points to 1px).
 *
 * The instance buffers are owned here and handed to the CPU simulator as its output
 * targets, so simulation writes straight into the GPU upload arrays (zero-copy).
 */

import * as THREE from 'three';
import { SpriteNodeMaterial } from 'three/webgpu';
import { attribute, float, mul, texture, uv } from 'three/tsl';
import { orientSampleUv, radialAlpha, softParticleFade, spriteSheetUv } from './billboardTsl';
import { uploadDenseRows } from './attributeUpload';
import type { RenderConfig } from './types';
import type { ParticleOutputs } from './cpuSimulator';

export interface BillboardObject {
  mesh: THREE.Mesh;
  /** Instance buffers for the simulator to write into. */
  outputs: ParticleOutputs;
  /** Upload `aliveCount` instances to the GPU this frame. */
  commit(aliveCount: number): void;
  dispose(): void;
}

export interface BillboardOptions {
  /** sprite texture; when present, replaces the radial soft-circle alpha */
  texture?: THREE.Texture | null;
  tilesX?: number;
  tilesY?: number;
}

export function createBillboard(maxParticles: number, render: RenderConfig, opts: BillboardOptions = {}): BillboardObject {
  // Base quad — clone attributes so this geometry owns them (safe to dispose independently).
  // `aspect` (width/height) makes a non-square billboard; height is driven by per-instance
  // scale, so the quad is (aspect × 1) and width = scale × aspect, height = scale.
  const aspect = render.aspect && render.aspect > 0 ? render.aspect : 1;
  const src = new THREE.PlaneGeometry(aspect, 1);
  // Anchor + offset, baked into the quad (units of startSize; scaleNode multiplies later).
  // 'bottom' shifts the quad up so its bottom edge sits at the particle position; `offset`
  // nudges it further (+x right, +y up).
  const shiftX = render.offset?.[0] ?? 0;
  const shiftY = (render.anchor === 'bottom' ? 0.5 : 0) + (render.offset?.[1] ?? 0);
  if (shiftX !== 0 || shiftY !== 0) src.translate(shiftX, shiftY, 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = src.index ? src.index.clone() : null;
  geo.setAttribute('position', src.attributes.position.clone());
  geo.setAttribute('uv', src.attributes.uv.clone());
  src.dispose();

  const offsets = new Float32Array(maxParticles * 3);
  const scales = new Float32Array(maxParticles);
  const colors = new Float32Array(maxParticles * 3);
  const opacities = new Float32Array(maxParticles);
  const rotations = new Float32Array(maxParticles);
  const frames = new Float32Array(maxParticles);

  const dyn = (a: THREE.InstancedBufferAttribute) => a.setUsage(THREE.DynamicDrawUsage);
  const aOffset = dyn(new THREE.InstancedBufferAttribute(offsets, 3));
  const aScale = dyn(new THREE.InstancedBufferAttribute(scales, 1));
  const aColor = dyn(new THREE.InstancedBufferAttribute(colors, 3));
  const aOpacity = dyn(new THREE.InstancedBufferAttribute(opacities, 1));
  const aRotation = dyn(new THREE.InstancedBufferAttribute(rotations, 1));
  const aFrame = dyn(new THREE.InstancedBufferAttribute(frames, 1));
  geo.setAttribute('aOffset', aOffset);
  geo.setAttribute('aScale', aScale);
  geo.setAttribute('aColor', aColor);
  geo.setAttribute('aOpacity', aOpacity);
  geo.setAttribute('aRotation', aRotation);
  geo.setAttribute('aFrame', aFrame);
  geo.instanceCount = 0;

  const mat = new SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: render.blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  // Per-instance billboard via TSL attribute nodes (SpriteNodeMaterial ignores the
  // InstancedMesh matrix, so we drive position/scale/color/rotation through attributes).
  mat.positionNode = attribute('aOffset', 'vec3');
  mat.scaleNode = attribute('aScale', 'float');
  mat.rotationNode = attribute('aRotation', 'float');

  const tex = opts.texture;
  let opacityExpr;
  if (tex) {
    const tx = Math.max(1, Math.floor(opts.tilesX ?? 1));
    const ty = Math.max(1, Math.floor(opts.tilesY ?? 1));
    // map the quad UV into the current sprite-sheet cell (frame 0 = top-left), then flip V
    // for bottom-origin (KTX2, flipY=false) textures so the sprite reads right-side up.
    const sampleUv = orientSampleUv(
      (tx > 1 || ty > 1)
        ? spriteSheetUv(float(attribute('aFrame', 'float')), tx, ty)
        : uv(),
      tex.flipY === false,
    );
    const t = texture(tex, sampleUv);
    mat.colorNode = mul(t.rgb, attribute('aColor', 'vec3'));
    opacityExpr = mul(t.a, attribute('aOpacity', 'float'));
  } else {
    // Soft round particle: radial alpha falloff from the quad UV × per-instance opacity.
    mat.colorNode = attribute('aColor', 'vec3');
    opacityExpr = mul(attribute('aOpacity', 'float'), radialAlpha());
  }

  // Soft particles: fade alpha as the fragment nears opaque scene geometry, so the
  // billboard dissolves into surfaces instead of showing a hard intersection seam.
  if (render.softParticles) opacityExpr = mul(opacityExpr, softParticleFade());
  mat.opacityNode = opacityExpr;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; // emitter-origin culling would wrongly cull spread particles
  if (render.renderOrder != null) mesh.renderOrder = render.renderOrder;

  return {
    mesh,
    outputs: { offsets, scales, colors, opacities, rotations, frames },
    commit(aliveCount: number) {
      geo.instanceCount = aliveCount;
      // Upload only the dense live prefix [0, aliveCount), not the whole pool (F8).
      uploadDenseRows(aOffset, aliveCount);
      uploadDenseRows(aScale, aliveCount);
      uploadDenseRows(aColor, aliveCount);
      uploadDenseRows(aOpacity, aliveCount);
      uploadDenseRows(aRotation, aliveCount);
      uploadDenseRows(aFrame, aliveCount);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
