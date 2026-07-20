/**
 * Per-frame bridge between ECS {@link FlameMesh} entities and a Three.js two-layer flame —
 * the mesh analogue of particleSync. Called from the render phase in both the runtime
 * Scene3D and the editor SceneView/GameView.
 *
 * Each FlameMesh entity gets a GROUP holding an OUTER cone (larger, softer, cooler) and a
 * nested INNER cone (smaller, brighter — the hot core), both concave lathes (base = nozzle
 * at local y=0, tip = +Y at y=1) with a TSL gradient material + soft fresnel edges, on the
 * PARTICLE_LAYER so they composite AFTER the NPR pass (no Sobel outline), depth-tested
 * against the hull. The group carries the entity's world transform (gizmo/pick target).
 *
 * Length = `length × lengthScale`; colors/intensity/softness/blend are live-updated.
 */

import * as THREE from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  positionLocal, normalView, positionViewDirection, time,
  dot, abs, clamp, mix, smoothstep, oneMinus, vec3, float, uniform, sin,
} from 'three/tsl';
import type { World } from 'koota';
import { Transform } from '../traits/Transform';
import { FlameMesh } from '../traits/FlameMesh';
import { PARTICLE_LAYER, DEFAULT_LAYER } from './layers';
import { worldTransforms } from '../../three/systems/transformPropagationSystem';
import { onWorldSwap } from '../ecs/world';

interface FlameUniforms {
  outerColor: { value: THREE.Color };
  outerTip: { value: THREE.Color };
  outerAlpha: { value: number };
  outerIntensity: { value: number };
  innerColor: { value: THREE.Color };
  innerTip: { value: THREE.Color };
  innerAlpha: { value: number };
  innerIntensity: { value: number };
  softness: { value: number };
  flowSpeed: { value: number };
  colorWaver: { value: number };
}

interface FlameRec {
  /** Carries the entity's world transform (gizmo + pick target). */
  group: THREE.Group;
  outerMesh: THREE.Mesh;
  innerMesh: THREE.Mesh;
  outerMat: NodeMaterial;
  innerMat: NodeMaterial;
  u: FlameUniforms;
  additive: boolean;
  segments: number;
}

export interface FlameMeshSyncState {
  recs: Map<number, FlameRec>;
}

export function createFlameMeshSyncState(): FlameMeshSyncState {
  return { recs: new Map() };
}

type TransformData = { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number };
type FlameData = {
  radialSegments: number;
  radius: number; length: number; lengthScale: number; softness: number;
  innerScale: number; innerLength: number; flowSpeed: number; colorWaver: number;
  additive: boolean; afterNPR: boolean;
  outerColor: number; outerTipColor: number; outerAlpha: number; outerIntensity: number;
  innerColor: number; innerTipColor: number; innerAlpha: number; innerIntensity: number;
};

const _e = new THREE.Euler();

/** Unit flame cone: a lathe (solid of revolution), widest at the nozzle (y=0) tapering
 *  with gently CONCAVE sides to a point at the tail (y=1). No mid-bulge. Radially
 *  symmetric → reads from any angle. positionLocal.y is the 0..1 length parameter `t`.
 *  Cached per radial-segment count so flames sharing a resolution share one geometry. */
const _coneGeos = new Map<number, THREE.LatheGeometry>();
function flameGeometry(radialSegments: number): THREE.LatheGeometry {
  const seg = Math.max(3, Math.round(radialSegments) || 16);
  let geo = _coneGeos.get(seg);
  if (!geo) {
    const profile = [
      [1.0, 0.0], [0.9, 0.12], [0.76, 0.28], [0.6, 0.45],
      [0.42, 0.62], [0.26, 0.78], [0.12, 0.9], [0.0, 1.0],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    geo = new THREE.LatheGeometry(profile, seg);
    _coneGeos.set(seg, geo);
  }
  return geo;
}

const TAU = Math.PI * 2;

/** Build one layer's material. `inner` = the hot core layer (ramps core→mid, brighter,
 *  more opaque); else the outer layer (ramps mid→tail, softer, more transparent). The two
 *  layers share `u` so a single color/param update drives both. */
function buildLayer(u: FlameUniforms, additive: boolean, inner: boolean): NodeMaterial {
  const mat = new NodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.side = THREE.DoubleSide; // see the back wall through the front → accumulates as volume
  mat.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;

  const F = (n: number) => float(n);
  const timeN = time as unknown as ReturnType<typeof float>;
  const t = clamp((positionLocal as unknown as { y: ReturnType<typeof float> }).y, F(0), F(1));

  // Each layer uses its OWN base→tip gradient, alpha and brightness — no forced white core.
  const baseC = (inner ? u.innerColor : u.outerColor) as unknown as Parameters<typeof mix>[0];
  const tipC = (inner ? u.innerTip : u.outerTip) as unknown as Parameters<typeof mix>[0];
  const alphaUni = (inner ? u.innerAlpha : u.outerAlpha) as unknown as ReturnType<typeof float>;
  const iUni = (inner ? u.innerIntensity : u.outerIntensity) as unknown as ReturnType<typeof float>;
  const flowSpeedUni = u.flowSpeed as unknown as ReturnType<typeof float>;
  // color waver: smoothly displace the gradient sample point along the length over time so
  // the color shimmers (uniform around the cone → no blotches). Two non-harmonic octaves.
  const waverUni = u.colorWaver as unknown as ReturnType<typeof float>;
  const waver = sin(t.mul(3).sub(timeN.mul(flowSpeedUni))).mul(0.6)
    .add(sin(t.mul(5.3).add(timeN.mul(flowSpeedUni).mul(0.55))).mul(0.4));
  const ct = clamp(t.add(waver.mul(waverUni)), F(0), F(1));
  const color = mix(baseC, tipC, smoothstep(F(0), F(1), ct));

  // length fade: in off the nozzle, out to a soft tip
  const aLen = smoothstep(F(0), F(0.04), t).mul(oneMinus(smoothstep(F(0.55), F(1), t)));
  // soft, feathered silhouette (no hard edge); small floor so the body still reads
  const facing = abs(dot(normalView, positionViewDirection));
  const sUni = u.softness as unknown as ReturnType<typeof float>;
  const band = (clamp(sUni, F(0.05), F(1)) as ReturnType<typeof float>).mul(0.8).add(0.1);
  const edge = smoothstep(F(0), band, facing).mul(0.8).add(0.2);
  // subtle, smooth vertical flicker (low amplitude → gas shimmer, not bands)
  const flick = sin(t.mul(2.5).sub(timeN.mul(flowSpeedUni)).mul(TAU)).mul(0.5).add(0.5);
  const flickMod = flick.mul(0.16).add(0.84); // 0.84..1

  // brightness on color (matters for additive); alpha is the independent opacity ceiling
  const opacity = clamp(aLen.mul(edge).mul(flickMod).mul(alphaUni), F(0), F(1));

  (mat as unknown as { colorNode: unknown }).colorNode = vec3(color.mul(iUni));
  (mat as unknown as { opacityNode: unknown }).opacityNode = opacity;
  return mat;
}

function buildFlame(additive: boolean): { u: FlameUniforms; outerMat: NodeMaterial; innerMat: NodeMaterial } {
  const C = () => uniform(new THREE.Color(1, 1, 1)) as unknown as { value: THREE.Color };
  const N = (v: number) => uniform(v) as unknown as { value: number };
  const u: FlameUniforms = {
    outerColor: C(), outerTip: C(), outerAlpha: N(0.4), outerIntensity: N(1.2),
    innerColor: C(), innerTip: C(), innerAlpha: N(0.9), innerIntensity: N(1.6),
    softness: N(0.45), flowSpeed: N(1.5), colorWaver: N(0.15),
  };
  return { u, outerMat: buildLayer(u, additive, false), innerMat: buildLayer(u, additive, true) };
}

function applyColors(u: FlameUniforms, d: FlameData): void {
  u.outerColor.value.set(d.outerColor).convertSRGBToLinear();
  u.outerTip.value.set(d.outerTipColor).convertSRGBToLinear();
  u.outerAlpha.value = d.outerAlpha;
  u.outerIntensity.value = d.outerIntensity;
  u.innerColor.value.set(d.innerColor).convertSRGBToLinear();
  u.innerTip.value.set(d.innerTipColor).convertSRGBToLinear();
  u.innerAlpha.value = d.innerAlpha;
  u.innerIntensity.value = d.innerIntensity;
  u.softness.value = d.softness;
  u.flowSpeed.value = d.flowSpeed;
  u.colorWaver.value = d.colorWaver;
}

export function syncFlameMeshes(world: World, scene: THREE.Object3D, state: FlameMeshSyncState): void {
  const seen = new Set<number>();

  world.query(Transform, FlameMesh).updateEach(([tf, fm]: [TransformData, FlameData], entity) => {
    const id = entity.id();
    seen.add(id);
    let rec = state.recs.get(id);
    if (!rec) {
      const { u, outerMat, innerMat } = buildFlame(fm.additive);
      const geo = flameGeometry(fm.radialSegments);
      const outerMesh = new THREE.Mesh(geo, outerMat);
      const innerMesh = new THREE.Mesh(geo, innerMat);
      outerMesh.renderOrder = 0;
      innerMesh.renderOrder = 1; // hot core drawn over the outer envelope
      const group = new THREE.Group();
      for (const m of [outerMesh, innerMesh]) {
        m.frustumCulled = false; // tiny, always near the ship — skip per-frame cull cost
        m.layers.set(PARTICLE_LAYER);
        group.add(m);
      }
      group.layers.set(PARTICLE_LAYER); // only the after-NPR particle pass renders it
      scene.add(group);
      rec = { group, outerMesh, innerMesh, outerMat, innerMat, u, additive: fm.additive, segments: fm.radialSegments };
      state.recs.set(id, rec);
    } else {
      if (rec.additive !== fm.additive) {
        const b = fm.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
        rec.outerMat.blending = b; rec.outerMat.needsUpdate = true;
        rec.innerMat.blending = b; rec.innerMat.needsUpdate = true;
        rec.additive = fm.additive;
      }
      if (rec.segments !== fm.radialSegments) {
        const geo = flameGeometry(fm.radialSegments); // shared, not owned
        rec.outerMesh.geometry = geo;
        rec.innerMesh.geometry = geo;
        rec.segments = fm.radialSegments;
      }
    }

    applyColors(rec.u, fm);

    // The GROUP carries the propagated WORLD transform (handles parenting to the ship;
    // falls back to local). Gizmo/picker target the group, so its transform stays the clean
    // entity transform. Entity Transform scale → group scale → multiplies the flame size.
    const wt = worldTransforms.get(id);
    const g = rec.group;
    g.position.set(wt ? wt.x : tf.x, wt ? wt.y : tf.y, wt ? wt.z : tf.z);
    _e.set(wt ? wt.rx : tf.rx, wt ? wt.ry : tf.ry, wt ? wt.rz : tf.rz);
    g.quaternion.setFromEuler(_e);
    g.scale.set(wt ? wt.sx : tf.sx, wt ? wt.sy : tf.sy, wt ? wt.sz : tf.sz);

    // afterNPR (default) → particle layer (composited after the NPR pass, no outline);
    // off → default layer, so it renders THROUGH the NPR pass (gets Sobel/grayscale).
    const layer = (fm.afterNPR ?? true) ? PARTICLE_LAYER : DEFAULT_LAYER;
    g.layers.set(layer);

    const len = Math.max(0, fm.length * (fm.lengthScale ?? 1));
    rec.outerMesh.scale.set(fm.radius, len, fm.radius);
    rec.innerMesh.scale.set(fm.radius * fm.innerScale, len * fm.innerLength, fm.radius * fm.innerScale);
    rec.outerMesh.layers.set(layer);
    rec.innerMesh.layers.set(layer);
  });

  for (const [id, rec] of state.recs) {
    if (!seen.has(id)) {
      scene.remove(rec.group);
      rec.outerMat.dispose();
      rec.innerMat.dispose();
      state.recs.delete(id);
    }
  }
}

export function disposeFlameMeshSyncState(state: FlameMeshSyncState, scene: THREE.Object3D): void {
  for (const rec of state.recs.values()) {
    scene.remove(rec.group);
    rec.outerMat.dispose();
    rec.innerMat.dispose();
  }
  state.recs.clear();
}

/** Dispose the shared lathe-geometry cache (`_coneGeos`). The cache is module-level
 *  and intentionally shared across flames/scenes, so per-mount `disposeFlameMeshSyncState`
 *  correctly leaves it alone — but it had no teardown path at all (F7). Wired to the same
 *  `onWorldSwap` hook that frees the sibling tint/inline-texture caches; it rebuilds lazily
 *  (one LatheGeometry per distinct segment count, usually 1) on next use. */
export function disposeFlameGeometryCache(): void {
  for (const geo of _coneGeos.values()) geo.dispose();
  _coneGeos.clear();
}
// Free the shared lathe cache at the world-swap boundary, mirroring the sibling
// tint/inline-texture caches freed in scene3DSync. Self-registered here so the
// teardown stays co-located with the cache it owns.
onWorldSwap(disposeFlameGeometryCache);
