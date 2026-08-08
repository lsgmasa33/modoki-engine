/**
 * Per-frame bridge between ECS {@link BlobShadow} entities and a Three.js ground-contact
 * shadow quad — the cheap grounding cue for entities that don't cast a real shadow (see
 * `BlobShadow`'s doc for why). Mirrors `flameMeshSync`'s create/update/reap shape.
 *
 * Each entity gets its OWN Mesh sharing a single module-level `CircleGeometry` — the DISC is
 * the shape; the material just draws it at a uniform opacity. Two softer approaches were built
 * and both rendered fully transparent (a `CanvasTexture` alpha, then a procedural falloff in
 * the node graph); see `buildBlobMaterial` for the bisection. Per frame: raycast straight down
 * from the entity's world position; a hit places the disc flush against the surface (tilted to
 * its normal) and fades opacity by height above it; no hit (or no physics world) hides it.
 */

import * as THREE from 'three';
import { NodeMaterial } from 'three/webgpu';
import { uniform, vec3 } from 'three/tsl';
import type { World } from 'koota';
import { Transform } from '../core/traits/Transform';
import { BlobShadow } from '../traits/BlobShadow';
import { DEFAULT_LAYER } from './layers';
import { worldTransforms, deactivatedEntities } from '../core/ecs/transformPropagationSystem';
import { onWorldSwap } from '../core/ecs/world';
import { getRaycast3D, type Raycast3DHit as RaycastHit } from '../core/raycast3DRegistry';

// ── Pure placement logic (no THREE, no world) — the part the unit tests exercise ──

export type { RaycastHit };

export interface BlobShadowPlacement {
  visible: boolean;
  /** final opacity to draw at (0 when not visible) */
  opacity: number;
  /** blob center in world space, lifted off the surface along its normal — null when hidden */
  position: { x: number; y: number; z: number } | null;
  /** surface normal to orient the quad against — null when hidden */
  normal: { x: number; y: number; z: number } | null;
}

const HIDDEN: BlobShadowPlacement = { visible: false, opacity: 0, position: null, normal: null };

/**
 * Decide where/whether to draw the blob from a ground raycast result. `hit` is the
 * `raycast3D` result (or null — no ground within `maxDrop`, or no physics world at all).
 * `hit.distance` is measured from the entity's ORIGIN, not its feet — a capsule character's
 * origin commonly sits `fadeStart` above the ground it stands on, so without accounting for
 * that a fully-grounded character would already read half-faded. Fade: full `opacity` at
 * `fadeStart` (the entity's normal resting distance from the surface), linearly down to 0 at
 * `fadeStart + fadeHeight` and beyond, clamped. `fadeStart: 0` reproduces the original
 * distance-from-surface behaviour.
 */
export function blobShadowPlacement(
  hit: RaycastHit | null,
  groundOffset: number,
  fadeHeight: number,
  opacity: number,
  fadeStart = 0,
): BlobShadowPlacement {
  if (!hit) return HIDDEN;

  const rise = hit.distance - fadeStart;
  const t = fadeHeight > 0 ? rise / fadeHeight : (rise <= 0 ? 0 : 1);
  const fade = 1 - Math.min(1, Math.max(0, t));

  // A fully faded blob is HIDDEN, not drawn-at-zero-opacity. Without this an entity above
  // `fadeStart + fadeHeight` (a jumping character) keeps costing a draw call to rasterize
  // nothing — precisely the cost-without-benefit this feature exists to avoid.
  const finalOpacity = opacity * fade;
  if (finalOpacity <= 0) return HIDDEN;

  return {
    visible: true,
    opacity: finalOpacity,
    position: {
      x: hit.x + hit.nx * groundOffset,
      y: hit.y + hit.ny * groundOffset,
      z: hit.z + hit.nz * groundOffset,
    },
    normal: { x: hit.nx, y: hit.ny, z: hit.nz },
  };
}

// ── Three.js side ──

interface BlobRec {
  mesh: THREE.Mesh;
  mat: NodeMaterial;
  opacityUniform: { value: number };
}

export interface BlobShadowSyncState {
  recs: Map<number, BlobRec>;
}

export function createBlobShadowSyncState(): BlobShadowSyncState {
  return { recs: new Map() };
}

/** Shared unit disc (radius 0.5, so a mesh scaled by 2*radius has exactly `radius`) —
 *  module-level, never per-entity. */
let _quadGeo: THREE.CircleGeometry | null = null;
function blobGeometry(): THREE.CircleGeometry {
  if (!_quadGeo) _quadGeo = new THREE.CircleGeometry(0.5, 24);
  return _quadGeo;
}

const _up = new THREE.Vector3(0, 0, 1); // CircleGeometry's face normal (it lies in the XY plane)
const _normalVec = new THREE.Vector3();
const _quat = new THREE.Quaternion();

/** Unlit black, drawn at a uniform opacity. The shape is the geometry (a disc), NOT a shader
 *  falloff — see the bisection recorded inside. */
function buildBlobMaterial(): { mat: NodeMaterial; opacityUniform: { value: number } } {
  const mat = new NodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  const opacityUniform = uniform(0);
  // Opacity is the bare uniform, and the SHAPE comes from the geometry (a disc), because a
  // computed falloff term does not render. Bisected in the editor on WebGPU AND on a Huawei Y6
  // on WebGL, so it is not backend-specific: `opacityNode = float(0.7)` draws a solid quad, and
  // the live node graph shows the uniform carrying the right value (0.547), but multiplying it
  // by ANY position-derived falloff — smoothstep OR a plain clamped linear ramp — renders fully
  // transparent. Root cause not established; a hard-edged disc is the shippable shape until it
  // is. See docs/plans/low-end-device-support.md.
  mat.colorNode = vec3(0, 0, 0);
  mat.opacityNode = opacityUniform;
  mat.name = 'blob-disc';
  return { mat, opacityUniform: opacityUniform as unknown as { value: number } };
}

export function syncBlobShadows(world: World, scene: THREE.Object3D, state: BlobShadowSyncState): void {
  const seen = new Set<number>();

  type TransformData = { x: number; y: number; z: number };
  type BlobData = { radius: number; opacity: number; groundOffset: number; maxDrop: number; fadeStart: number; fadeHeight: number };

  world.query(Transform, BlobShadow).updateEach(([tf, bs]: [TransformData, BlobData], entity) => {
    const id = entity.id();
    if (deactivatedEntities.has(id)) return;
    seen.add(id);

    let rec = state.recs.get(id);
    if (!rec) {
      const { mat, opacityUniform } = buildBlobMaterial();
      const mesh = new THREE.Mesh(blobGeometry(), mat);
      mesh.frustumCulled = false; // tiny, cheap, and repositions every frame
      mesh.renderOrder = 10; // after opaque geometry
      mesh.layers.set(DEFAULT_LAYER);
      scene.add(mesh);
      rec = { mesh, mat, opacityUniform };
      state.recs.set(id, rec);
    }

    // World position exactly like the neighbouring sync modules: prefer the propagated
    // world-transform cache, fall back to the entity's local Transform.
    const wt = worldTransforms.get(id);
    const ox = wt ? wt.x : tf.x, oy = wt ? wt.y : tf.y, oz = wt ? wt.z : tf.z;

    const raycast3D = getRaycast3D();
    // exclude: id — the entity casting the shadow must never ground on its OWN collider. The
    // ray starts at the entity's own world position, which sits inside its own capsule/mesh, so
    // without this a `solid: true` cast reports a distance-0 self-hit and the blob renders
    // pinned to the character instead of the ground beneath it (measured on-device, Huawei Y6).
    const hit = raycast3D ? raycast3D(world, ox, oy, oz, 0, -1, 0, { maxDistance: bs.maxDrop, exclude: id }) : null;
    const placement = blobShadowPlacement(hit, bs.groundOffset, bs.fadeHeight, bs.opacity, bs.fadeStart);

    rec.mesh.visible = placement.visible;
    if (!placement.visible || !placement.position || !placement.normal) return;

    rec.mesh.position.set(placement.position.x, placement.position.y, placement.position.z);
    _normalVec.set(placement.normal.x, placement.normal.y, placement.normal.z);
    _quat.setFromUnitVectors(_up, _normalVec);
    rec.mesh.quaternion.copy(_quat);
    rec.mesh.scale.set(bs.radius * 2, bs.radius * 2, 1);
    rec.opacityUniform.value = placement.opacity;
  });

  for (const [id, rec] of state.recs) {
    if (!seen.has(id)) {
      scene.remove(rec.mesh);
      rec.mat.dispose();
      state.recs.delete(id);
    }
  }
}

export function disposeBlobShadowSyncState(state: BlobShadowSyncState, scene: THREE.Object3D): void {
  for (const rec of state.recs.values()) {
    scene.remove(rec.mesh);
    rec.mat.dispose();
  }
  state.recs.clear();
}

/** Dispose the shared quad geometry (module-level, shared across all blobs/scenes). Wired to
 *  `onWorldSwap` like the sibling caches in `flameMeshSync.ts` / `scene3DSync.ts` — it rebuilds
 *  lazily on next use. */
export function disposeBlobShadowCache(): void {
  if (_quadGeo) { _quadGeo.dispose(); _quadGeo = null; }
}
onWorldSwap(disposeBlobShadowCache);
