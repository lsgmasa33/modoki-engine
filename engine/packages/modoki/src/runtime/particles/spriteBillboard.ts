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
import { resolveTiles, type RenderConfig } from './types';
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

/**
 * Resolve a `RenderConfig`'s billboard-quad fields (`aspect`/`anchor`/`offset`) to the
 * (aspect, shiftX, shiftY) triple {@link computeQuadCorners} consumes. Shared by every quad
 * builder AND the in-place applier ({@link applyQuadInPlace}) so a def and its rebuilt/patched
 * geometry can never read the fields differently (#769).
 */
export function resolveQuadShift(render: RenderConfig): { aspect: number; shiftX: number; shiftY: number } {
  // `aspect` (width/height) makes a non-square billboard; height is driven by per-instance
  // scale, so the quad is (aspect × 1) and width = scale × aspect, height = scale.
  const aspect = render.aspect && render.aspect > 0 ? render.aspect : 1;
  // Anchor + offset, baked into the quad (units of startSize; scaleNode multiplies later).
  // 'bottom' shifts the quad up so its bottom edge sits at the particle position; `offset`
  // nudges it further (+x right, +y up).
  const shiftX = render.offset?.[0] ?? 0;
  const shiftY = (render.anchor === 'bottom' ? 0.5 : 0) + (render.offset?.[1] ?? 0);
  return { aspect, shiftX, shiftY };
}

/**
 * The 4 corner positions (12 floats, matching `THREE.PlaneGeometry(aspect, 1)`'s own vertex
 * order: top-left, top-right, bottom-left, bottom-right) of a billboard quad shifted by
 * `shiftX`/`shiftY`. Pure arithmetic — no THREE geometry allocation — so both a fresh build
 * and an in-place rewrite of an existing quad ({@link applyQuadInPlace}) derive these 12
 * numbers from the exact same place (#769: the earlier duplicate here and in
 * `gpuComputeBackend.ts` is what let the two silently drift).
 */
export function computeQuadCorners(aspect: number, shiftX: number, shiftY: number): Float32Array {
  const halfW = aspect / 2;
  const halfH = 0.5;
  return new Float32Array([
    -halfW + shiftX, halfH + shiftY, 0,
    halfW + shiftX, halfH + shiftY, 0,
    -halfW + shiftX, -halfH + shiftY, 0,
    halfW + shiftX, -halfH + shiftY, 0,
  ]);
}

/**
 * Rewrite an existing billboard quad's `position` attribute in place for a changed
 * `aspect`/`anchor`/`offset` (a `renderQuadKey` change, #769) — `uv`/`index` never change
 * under these fields, so only the 12 position floats move. Refuses (returns `false`) rather
 * than write a partial buffer when `geo` isn't the plain 4-vertex quad every billboard
 * builder emits — callers MUST fall back to a full rebuild on `false`. Unlike
 * `canWriteTextPositionsInPlace` in `text/textMesh.ts`, whose refusal is a live path (a
 * missing page texture, a wrapping change), this guard has no caller that can trip it today
 * — both call sites are already gated on `mode !== 'mesh'`, and every non-mesh geometry is
 * built by `createBillboard`/`buildMesh`, which always emit a 4-vertex itemSize-3 position.
 * It stays as a shape assertion against a future caller, not a refusal anything currently
 * reaches.
 */
export function applyQuadInPlace(geo: THREE.BufferGeometry, render: RenderConfig): boolean {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.itemSize !== 3 || pos.count !== 4) return false;
  const { aspect, shiftX, shiftY } = resolveQuadShift(render);
  const corners = computeQuadCorners(aspect, shiftX, shiftY);
  (pos.array as Float32Array).set(corners);
  pos.needsUpdate = true;
  return true;
}

export function createBillboard(maxParticles: number, render: RenderConfig, opts: BillboardOptions = {}): BillboardObject {
  // Base quad — index/uv come from a throwaway PlaneGeometry (invariant under aspect/anchor/
  // offset); the position attribute is built directly from computeQuadCorners so the initial
  // build and any later in-place rewrite (applyQuadInPlace) derive it from the same function.
  const { aspect, shiftX, shiftY } = resolveQuadShift(render);
  const src = new THREE.PlaneGeometry(aspect, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = src.index ? src.index.clone() : null;
  geo.setAttribute('position', new THREE.BufferAttribute(computeQuadCorners(aspect, shiftX, shiftY), 3));
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
    const tx = resolveTiles(opts.tilesX);
    const ty = resolveTiles(opts.tilesY);
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
