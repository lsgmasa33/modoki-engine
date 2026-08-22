/**
 * Per-frame bridge between ECS {@link BlobShadow} entities and a Three.js ground-contact
 * shadow quad — the cheap grounding cue for entities that don't cast a real shadow (see
 * `BlobShadow`'s doc for why). Mirrors `flameMeshSync`'s create/update/reap shape.
 *
 * Each entity gets its OWN Mesh sharing a single module-level `CircleGeometry`. The disc gives
 * the extent; a shader falloff gives the SOFT EDGE (`softness`, live-tunable — see
 * `buildBlobMaterial`, which also records why an earlier attempt at that edge rendered fully
 * transparent and what it was NOT). Per frame: raycast straight down from the entity's world
 * position; a hit places the disc flush against the surface (tilted to its normal) and fades
 * opacity by height above it; no hit (or no physics world) hides it.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { uniform, vec3, uv } from 'three/tsl';
import type { World } from 'koota';
import { Transform } from '../core/traits/Transform';
import { BlobShadow } from '../traits/BlobShadow';
import { DEFAULT_LAYER } from './layers';
import { worldTransforms, deactivatedEntities } from '../core/ecs/transformPropagationSystem';
import { onWorldSwap } from '../core/ecs/world';
import { getRaycast3D, type Raycast3DHit as RaycastHit } from '../core/raycast3DRegistry';
import { getEffectiveThreeSettings } from './renderSettings';

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
  mat: MeshBasicNodeMaterial;
  opacityUniform: { value: number };
  edgeUniform: { value: number };
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

/** The normalized radius at which the edge fade STARTS, from a 0..1 `softness`. 0 is a
 *  hard-edged disc; 1 fades from the very centre outward.
 *
 *  The 0.999 cap keeps `edge0 < edge1` strictly, so the shader never relies on what
 *  `smoothstep(e, e, x)` does: that divides by zero, and the result only lands on a clean hard
 *  step because +/-Inf clamps to 1/0 — except exactly at `x == e`, where it is 0/0. Cheap to
 *  avoid, so avoid it. **It does NOT prevent an invisible blob** — an earlier version of this
 *  comment claimed that, and it was wrong; see {@link buildBlobMaterial}. */
export function blobEdgeStart(softness: number): number {
  const s = Number.isFinite(softness) ? Math.min(1, Math.max(0, softness)) : 0;
  return Math.min(0.999, 1 - s);
}

/** Unlit black disc whose EDGE is a shader falloff:
 *  `alpha = opacity x (1 - smoothstep(edgeStart, 1, r))`, `r` being the normalized distance from
 *  the disc centre. BOTH terms are uniforms, so the height fade and the softness retune per frame
 *  without rebuilding the material — which is what makes softness tunable by eye on a device.
 *
 *  ── WHY THE SOFT EDGE PREVIOUSLY "DID NOT RENDER" — AND IT WAS NEVER THE SHADER ─────────
 *  An earlier pass concluded that multiplying the opacity uniform by ANY position-derived falloff
 *  rendered fully transparent, on WebGPU and WebGL both, root cause unknown — so the shape came
 *  from the geometry and the edge stayed hard.
 *
 *  **No spelling of this falloff has ever been the problem.** Measured directly: the descending
 *  form `r.smoothstep(1, 0.35)` and the ascending `r.smoothstep(0.35, 1).oneMinus()` are
 *  mathematically identical AND render identically here (radial luminance profiles agree within
 *  frame-to-frame animation noise). The descending spelling is also what `radialAlpha()` in
 *  `particles/billboardTsl.ts` has shipped engine-wide all along, on every particle. A prior
 *  version of this comment blamed `smoothstep`'s edge order; that was WRONG and is recorded
 *  rather than quietly deleted, because it is exactly the plausible-but-unverified explanation
 *  this repo keeps paying for.
 *
 *  What actually hides the blob is never the falloff — it is one of these, all of which read as
 *  "the shader renders nothing":
 *    - the game is STOPPED, so there is no physics world, the ground raycast returns null and
 *      `blobShadowPlacement` hides the mesh (the single most common false alarm);
 *    - the editor's panel layout moved the canvas rect, so a screenshot crop aimed by remembered
 *      pixels is looking at empty space;
 *    - the DEPTH TEST clipped it (see below).
 *  **Assert `mesh.visible === true` and project the mesh's screen position IN THE SAME CALL as
 *  the capture.** Three separate wrong readings here came from skipping that.
 *
 *  Also NOT the cause, tested and cleared: the material class (bare `NodeMaterial` and
 *  `MeshBasicNodeMaterial` behave identically), and the varying pipeline (the generated WGSL
 *  writes `varyings.nodeVarying4 = uv` in the vertex stage and reads it in the fragment stage).
 *  **`renderer.debug.getShaderAsync(scene, camera, mesh)` prints that WGSL and settles this whole
 *  class of question in one call** — reach for it before bisecting a node graph by screenshot.
 *
 *  The ascending spelling below is kept as a style choice (it never leans on a spec-undefined
 *  edge order), NOT as the fix.
 *
 *  ⚠️ A LARGE blob on undulating ground is clipped by the DEPTH TEST, not by the shader: the disc
 *  is flat and sits `groundOffset` above ONE raycast hit, so terrain rising inside the radius
 *  occludes it. Scale `groundOffset` with `radius`. This is not a shader bug, and mistaking it
 *  for one is expensive — a debug radius of 2.5 made a working soft edge look broken here. */
function buildBlobMaterial(): {
  mat: MeshBasicNodeMaterial;
  opacityUniform: { value: number };
  edgeUniform: { value: number };
} {
  const mat = new MeshBasicNodeMaterial(); // unlit on purpose — this trait exists to be cheap
  mat.transparent = true;
  mat.depthWrite = false;
  const opacityUniform = uniform(0);
  const edgeUniform = uniform(blobEdgeStart(0.65));
  const r = uv().sub(0.5).length().mul(2);                 // 0 at the centre -> 1 at the rim
  const falloff = r.smoothstep(edgeUniform, 1).oneMinus(); // 1 in the core -> 0 at the rim
  mat.colorNode = vec3(0, 0, 0);
  mat.opacityNode = opacityUniform.mul(falloff);
  mat.name = 'blob-disc';
  return {
    mat,
    opacityUniform: opacityUniform as unknown as { value: number },
    edgeUniform: edgeUniform as unknown as { value: number },
  };
}

export function syncBlobShadows(world: World, scene: THREE.Object3D, state: BlobShadowSyncState): void {
  const seen = new Set<number>();

  type TransformData = { x: number; y: number; z: number };
  type BlobData = { radius: number; opacity: number; groundOffset: number; maxDrop: number; fadeStart: number; fadeHeight: number; softness: number; onlyWhenShadowsOff: boolean };

  // Read ONCE per pass, not per entity: it resolves through `getActiveTierOverrides()`, and the
  // tier cannot change midway through a sync.
  const realShadowsOn = getEffectiveThreeSettings().shadows;

  world.query(Transform, BlobShadow).updateEach(([tf, bs]: [TransformData, BlobData], entity) => {
    const id = entity.id();
    if (deactivatedEntities.has(id)) return;

    // ⚠️ BEFORE the raycast — that is the whole point of the gate. A blob authored as a
    // shadows-off substitute must cost NOTHING on a tier that renders real shadows, rather than
    // paying a scene query per frame per viewport whose result is then thrown away.
    // Deliberately NOT `seen.add`ed: falling through to the sweep below disposes its mesh, so a
    // device that promotes into real shadows also gives back the draw call and the GPU memory. It
    // rebuilds on demotion — a tier-change event, not a per-frame cost.
    if (bs.onlyWhenShadowsOff && realShadowsOn) return;

    seen.add(id);

    let rec = state.recs.get(id);
    if (!rec) {
      const { mat, opacityUniform, edgeUniform } = buildBlobMaterial();
      const mesh = new THREE.Mesh(blobGeometry(), mat);
      mesh.frustumCulled = false; // tiny, cheap, and repositions every frame
      mesh.renderOrder = 10; // after opaque geometry
      mesh.layers.set(DEFAULT_LAYER);
      scene.add(mesh);
      rec = { mesh, mat, opacityUniform, edgeUniform };
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
    // Written every frame, like the opacity — softness is a live-tunable uniform rather than a
    // per-material constant, so editing it in the Inspector (or the debug menu on a device)
    // retunes the edge with no material rebuild and no shader recompile.
    rec.edgeUniform.value = blobEdgeStart(bs.softness);
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
