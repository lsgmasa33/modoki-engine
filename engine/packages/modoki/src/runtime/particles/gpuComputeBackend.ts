/**
 * GPU-compute implementation of {@link IParticleBackend} — a TSL compute-shader sim for
 * very high particle counts (100k+), behind the same interface as the CPU backend.
 *
 * State lives entirely in GPU storage buffers (position/velocity/age/life/size/rot/spin/
 * seed). A per-frame compute pass integrates motion (gravity + drag + curl-ish noise),
 * ages particles, and respawns dead ones in place. Emission is **continuous full-pool**
 * (the `emission.fillPool` mode — the only one this backend implements, hence the router
 * requires it for GPU eligibility; the CPU sim honors `fillPool` identically so the look
 * matches either backend): every slot is always alive (ages staggered at init), rate is
 * `maxParticles ÷ lifetime` rather than `emission.rateOverTime`. The render reads the
 * same buffers via storage reads into a `SpriteNodeMaterial` billboard (or an instanced
 * 3D primitive in mesh mode), sampling the over-life size/opacity/color from baked LUTs.
 *
 * Scope: the high-count cases (snow, embers, dust, motes, sparkle, debris). Force fields,
 * collision (plane/sphere/box, kill/bounce) and mesh-primitive rendering ARE handled here —
 * they're pure per-particle math that fits compute, and are built into the kernel only
 * when an effect uses them (the common no-force/no-collision case pays nothing). Trails
 * and sub-emitters are NOT handled (they need history buffers / atomic event plumbing) —
 * the router routes effects using either, or running without a WebGPU compute backend, to
 * the CPU sim. Compute requires the native WebGPU backend (unavailable under `forceWebGL`).
 */

import * as THREE from 'three';
import { SpriteNodeMaterial, MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn, If, instanceIndex, instancedArray, uniform, hash, float, int, vec2, vec3, vec4,
  texture, uv, mix, sin, cos, max, floor, abs, sign, select,
  positionLocal, normalLocal,
} from 'three/tsl';
import { renderStructuralKey, clampSimDt, PREWARM_STEP, seekSteps, MAX_GPU_FORCES, type IParticleBackend, type ParticleEffectDef, type ParticleHandle, type EmitterShapeType } from './types';
import { resolveCollider } from './colliders';
import { resolveShape } from './emitterShapes';
import { resolveGravity, type Vec3 } from './simSpec';
import { createOverLifeLUT, type OverLifeLUT } from './gpuLut';
import { makeParticlePrimitiveGeometry } from './meshParticles';
import { orientSampleUv, radialAlpha, softParticleFade, spriteFrameNode, spriteSheetUv } from './billboardTsl';
import { loadTexture3D, releaseTexture3D } from '../loaders/textureResolver';

/** Minimal view of the renderer used to dispatch compute passes. */
interface ComputeRenderer { compute(node: unknown): void; }

const TAU = Math.PI * 2;
const DEG2RAD = Math.PI / 180;
// Reused scratch for resolving scalar/vector gravity into a vec3 in applyUniforms (no per-call alloc).
const _grav: Vec3 = { x: 0, y: 0, z: 0 };
// polyline is a 2D-only spawn shape (PixiJS backend); the GPU compute backend is 3D-only, so it
// maps to point (0). A GPU effect never carries a polyline shape in practice — this just keeps the
// index total over EmitterShapeType.
const SHAPE: Record<EmitterShapeType, number> = { point: 0, cone: 1, sphere: 2, box: 3, circle: 4, cylinder: 5, polyline: 0 };
// MAX_GPU_FORCES (the unrolled force-field cap) is shared from ./types so the router's
// eligibility check (gpuDefSupported) and this kernel agree — an effect with more forces
// than the cap now falls back to CPU instead of silently dropping the extras (F11).
const COLL = { none: 0, kill: 1, bounce: 2 } as const;
const COLLIDER = { plane: 0, sphere: 1, box: 2, cylinder: 3 } as const;

// Storage-buffer nodes are only consumed via `.toAttribute()` in the render builder.
// @types/three resolves `ReturnType<typeof instancedArray>` to one (wrong) instantiation
// so the per-buffer types (vec3/float) don't match the params — keep them loose.
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type LooseBuf = any;

// @types/three under-types `uniform()` (returns a bare UniformNode without the fluent
// `.mul/.equal/.x` operator API that `float()/int()/vec3()` get). Cast uniform results
// to the properly-typed node intersected with `{ value }` (for the JS-side updates).
type FNode = ReturnType<typeof float>;
type INode = ReturnType<typeof int>;
type VNode = ReturnType<typeof vec3>;
type V4Node = ReturnType<typeof vec4>;
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Uni<N> = N & { value: any };
function uni(value: number, type: 'int'): Uni<INode>;
function uni(value: number): Uni<FNode>;
function uni(value: THREE.Vector3): Uni<VNode>;
function uni(value: THREE.Vector4): Uni<V4Node>;
function uni(value: number | THREE.Vector3 | THREE.Vector4, type?: string): unknown {
  return (uniform as (v: unknown, t?: unknown) => unknown)(value, type);
}
type ComputeNodeT = unknown; // result of Fn(...)().compute(count); dispatched via renderer.compute

/**
 * Rotate a vec3 by Euler angles in XYZ order — the TSL mirror of
 * `THREE.Matrix4.makeRotationFromEuler` (so the GPU mesh tumble matches the CPU path in
 * meshMatrices.ts exactly). Used for both vertex positions and (for lit meshes) normals.
 */
function eulerRotateXYZ(v: LooseBuf, rx: LooseBuf, ry: LooseBuf, rz: LooseBuf): VNode {
  const a = cos(rx), b = sin(rx);
  const c = cos(ry), d = sin(ry);
  const e = cos(rz), f = sin(rz);
  const ae = a.mul(e), af = a.mul(f), be = b.mul(e), bf = b.mul(f);
  const m00 = c.mul(e),          m01 = c.mul(f).negate(),   m02 = d;
  const m10 = af.add(be.mul(d)), m11 = ae.sub(bf.mul(d)),   m12 = b.negate().mul(c);
  const m20 = bf.sub(ae.mul(d)), m21 = be.add(af.mul(d)),   m22 = a.mul(c);
  return vec3(
    m00.mul(v.x).add(m01.mul(v.y)).add(m02.mul(v.z)),
    m10.mul(v.x).add(m11.mul(v.y)).add(m12.mul(v.z)),
    m20.mul(v.x).add(m21.mul(v.y)).add(m22.mul(v.z)),
  );
}

interface GpuUniforms {
  dt: Uni<FNode>;
  time: Uni<FNode>;
  /** Constant acceleration vector (axis-neutral). Scalar/vector authoring is resolved on the
   *  JS side via resolveGravity; the kernel just adds this. Mirrors the CPU sim's `grav`. */
  gravityVec: Uni<VNode>;
  drag: Uni<FNode>;
  noiseStr: Uni<FNode>;
  noiseFreq: Uni<FNode>;
  noiseScroll: Uni<FNode>;
  shapeType: Uni<INode>;
  radiusInner: Uni<FNode>; // annulus inner radius (cone/sphere/circle/cylinder)
  radiusOuter: Uni<FNode>; // annulus outer radius
  coneAngle: Uni<FNode>;
  cylAxis: Uni<VNode>; // cylinder unit axis
  cylU: Uni<VNode>; // cylinder cross-section basis (perp to axis)
  cylV: Uni<VNode>;
  cylLength: Uni<FNode>; // cylinder full length along the axis
  boxInHalf: Uni<VNode>; // box shell inner half-extents (zero = solid)
  boxOutHalf: Uni<VNode>; // box outer half-extents
  boxShell: Uni<FNode>; // 1 = hollow frame, 0 = solid volume fill
  speedMin: Uni<FNode>;
  speedMax: Uni<FNode>;
  /** Runtime launch-speed multiplier (1 = authored). Live uniform, NOT uploaded
   *  from the def — set via setSpeedScale to throttle plume/trail length. */
  speedScale: Uni<FNode>;
  sizeMin: Uni<FNode>;
  sizeMax: Uni<FNode>;
  lifeMin: Uni<FNode>;
  lifeMax: Uni<FNode>;
  rotMin: Uni<FNode>;
  rotMax: Uni<FNode>;
  spinMin: Uni<FNode>;
  spinMax: Uni<FNode>;
  startColor: Uni<VNode>;
  startOpacity: Uni<FNode>;
  // force fields: per slot a vec4 (x,y,z,strength) + a type (0 directional, 1 point)
  forces: Uni<V4Node>[];
  forceTypes: Uni<FNode>[];
  // collision: mode + restitution, plus geometry for whichever shape is baked into the kernel
  collMode: Uni<INode>; // 0 none, 1 kill, 2 bounce
  bounce: Uni<FNode>;
  planeNormal: Uni<VNode>; // plane: unit normal
  planePoint: Uni<VNode>; // plane: a point on the plane
  collCenter: Uni<VNode>; // sphere/box/cylinder center
  collRadius: Uni<FNode>; // sphere/cylinder radius
  collHalf: Uni<VNode>; // box half-extents
  collAxis: Uni<VNode>; // cylinder unit axis
  collHalfLen: Uni<FNode>; // cylinder half-length
  // Emitter world matrix applied to every spawn (point for pos, direction for vel). Identity
  // in local mode (particles stay in the render group, which carries the matrix); set to the
  // emitter matrix in worldSpace mode (render group stays identity). See setTransform.
  emitterMatrix: LooseBuf;
}

interface GpuEntry {
  id: number;
  def: ParticleEffectDef;
  group: THREE.Group;
  mesh: THREE.Mesh | null;
  u: GpuUniforms;
  lut: OverLifeLUT | null;
  computeInit: ComputeNodeT | null;
  computeUpdate: ComputeNodeT | null;
  count: number;
  playing: boolean;
  inited: boolean;
  textureRef: string;
  texture: THREE.Texture | null;
  /** The renderer actually drawing this mesh, captured via onBeforeRender. Compute is
   *  dispatched against it so the buffers live on the same device that renders them
   *  (the editor has several renderers; a global "active renderer" would mismatch). */
  renderer: ComputeRenderer | null;
}

function makeUniforms(): GpuUniforms {
  return {
    dt: uni(0), time: uni(0),
    gravityVec: uni(new THREE.Vector3(0, 0, 0)), drag: uni(0),
    noiseStr: uni(0), noiseFreq: uni(1), noiseScroll: uni(1),
    shapeType: uni(0, 'int'), radiusInner: uni(0), radiusOuter: uni(1), coneAngle: uni(0.4),
    cylAxis: uni(new THREE.Vector3(0, 1, 0)), cylU: uni(new THREE.Vector3(1, 0, 0)),
    cylV: uni(new THREE.Vector3(0, 0, 1)), cylLength: uni(1),
    boxInHalf: uni(new THREE.Vector3(0, 0, 0)), boxOutHalf: uni(new THREE.Vector3(1, 1, 1)),
    boxShell: uni(0),
    speedMin: uni(0), speedMax: uni(0), speedScale: uni(1),
    sizeMin: uni(0), sizeMax: uni(0),
    lifeMin: uni(1), lifeMax: uni(1),
    rotMin: uni(0), rotMax: uni(0),
    spinMin: uni(0), spinMax: uni(0),
    startColor: uni(new THREE.Vector3(1, 1, 1)),
    startOpacity: uni(1),
    forces: Array.from({ length: MAX_GPU_FORCES }, () => uni(new THREE.Vector4(0, 0, 0, 0))),
    forceTypes: Array.from({ length: MAX_GPU_FORCES }, () => uni(0)),
    collMode: uni(0, 'int'), bounce: uni(0),
    planeNormal: uni(new THREE.Vector3(0, 1, 0)), planePoint: uni(new THREE.Vector3(0, 0, 0)),
    collCenter: uni(new THREE.Vector3(0, 0, 0)), collRadius: uni(1),
    collHalf: uni(new THREE.Vector3(0.5, 0.5, 0.5)),
    collAxis: uni(new THREE.Vector3(0, 1, 0)), collHalfLen: uni(0.5),
    emitterMatrix: (uniform as (v: unknown) => unknown)(new THREE.Matrix4()),
  };
}

function applyUniforms(u: GpuUniforms, def: ParticleEffectDef): void {
  const gv = resolveGravity(def.gravity, _grav);
  (u.gravityVec.value as THREE.Vector3).set(gv.x, gv.y, gv.z);
  u.drag.value = def.drag ?? 0;
  u.noiseStr.value = def.noise?.strength ?? 0;
  u.noiseFreq.value = def.noise?.frequency ?? 1;
  u.noiseScroll.value = def.noise?.scrollSpeed ?? 1;
  u.shapeType.value = SHAPE[def.shape.type] ?? 0;
  const rsh = resolveShape(def.shape);
  u.radiusInner.value = rsh.innerR;
  u.radiusOuter.value = rsh.outerR;
  u.coneAngle.value = rsh.angle;
  (u.cylAxis.value as THREE.Vector3).set(rsh.ax, rsh.ay, rsh.az);
  (u.cylU.value as THREE.Vector3).set(rsh.ux, rsh.uy, rsh.uz);
  (u.cylV.value as THREE.Vector3).set(rsh.vx, rsh.vy, rsh.vz);
  u.cylLength.value = rsh.length;
  (u.boxInHalf.value as THREE.Vector3).set(rsh.inHalf[0], rsh.inHalf[1], rsh.inHalf[2]);
  (u.boxOutHalf.value as THREE.Vector3).set(rsh.outHalf[0], rsh.outHalf[1], rsh.outHalf[2]);
  u.boxShell.value = rsh.boxShell ? 1 : 0;
  u.speedMin.value = def.startSpeed.min; u.speedMax.value = def.startSpeed.max;
  u.sizeMin.value = def.startSize.min; u.sizeMax.value = def.startSize.max;
  u.lifeMin.value = def.startLifetime.min; u.lifeMax.value = def.startLifetime.max;
  u.rotMin.value = (def.startRotation?.min ?? 0) * DEG2RAD;
  u.rotMax.value = (def.startRotation?.max ?? 0) * DEG2RAD;
  u.spinMin.value = (def.rotationSpeed?.min ?? 0) * DEG2RAD;
  u.spinMax.value = (def.rotationSpeed?.max ?? 0) * DEG2RAD;
  (u.startColor.value as THREE.Vector3).set(def.startColor.r, def.startColor.g, def.startColor.b);
  u.startOpacity.value = def.startOpacity ?? 1;
  // force fields (zero unused slots so they contribute nothing)
  const forces = def.forces ?? [];
  for (let k = 0; k < MAX_GPU_FORCES; k++) {
    const f = forces[k];
    (u.forces[k].value as THREE.Vector4).set(f?.x ?? 0, f?.y ?? 0, f?.z ?? 0, f?.strength ?? 0);
    u.forceTypes[k].value = f?.type === 'point' ? 1 : 0;
  }
  const coll = def.collision;
  u.collMode.value = coll && coll.mode !== 'none' ? COLL[coll.mode] : COLL.none;
  u.bounce.value = coll?.bounce ?? 0;
  if (coll && coll.mode !== 'none') {
    // Reuse the CPU resolver so plane normalization + legacy planeY migration match exactly.
    const rc = resolveCollider(coll);
    (u.planeNormal.value as THREE.Vector3).set(rc.nx, rc.ny, rc.nz);
    (u.planePoint.value as THREE.Vector3).set(rc.cx, rc.cy, rc.cz);
    (u.collCenter.value as THREE.Vector3).set(rc.cx, rc.cy, rc.cz);
    u.collRadius.value = rc.radius;
    (u.collHalf.value as THREE.Vector3).set(rc.hx, rc.hy, rc.hz);
    // cylinder reuses the resolved normal slot as its axis, and `hy` as the half-length.
    (u.collAxis.value as THREE.Vector3).set(rc.nx, rc.ny, rc.nz);
    u.collHalfLen.value = rc.hy;
  }
}

export class GpuComputeBackend implements IParticleBackend {
  private nextId = 1;
  private readonly entries = new Map<number, GpuEntry>();

  create(def: ParticleEffectDef): ParticleHandle {
    const id = this.nextId++;
    const group = new THREE.Group();
    group.name = `gpu-particles:${id}`;
    group.matrixAutoUpdate = false;
    const entry: GpuEntry = {
      id, def, group, mesh: null, u: makeUniforms(), lut: null,
      computeInit: null, computeUpdate: null, count: Math.max(1, def.maxParticles),
      playing: true, inited: false,
      textureRef: def.render.mode === 'mesh' ? '' : (def.render.texture ?? ''), texture: null, renderer: null,
    };
    this.build(entry, def);
    this.entries.set(id, entry);
    if (entry.textureRef && def.render.mode !== 'mesh') this.loadTextureFor(entry);
    return { id };
  }

  /** Allocate storage buffers, compute kernels, LUTs and the render mesh for `def`. */
  private build(entry: GpuEntry, def: ParticleEffectDef): void {
    if (entry.mesh) this.disposeMesh(entry.mesh);
    entry.lut?.dispose();

    const count = Math.max(1, def.maxParticles);
    entry.count = count;
    const u = entry.u;
    applyUniforms(u, def);

    // ── storage buffers ──
    // pos/meta are read by the render shader (via toAttribute); the rest are compute-only.
    // meta packs (age, life, size, rot) into one vec4 so render needs only 2 instanced
    // vertex attributes (pos + meta) — staying well under WebGPU's 8 vertex-buffer cap.
    const posBuf = instancedArray(count, 'vec3');
    const velBuf = instancedArray(count, 'vec3');
    const metaBuf = instancedArray(count, 'vec4'); // x=age, y=life, z=size, w=rot
    const spinBuf = instancedArray(count, 'float');

    // Per-invocation RNG. Each draw hashes a DISTINCT linear mix of instanceIndex + a salt
    // (+ time, so a slot's successive respawns differ). Critically, every hash argument
    // contains instanceIndex DIRECTLY — never another hash result: three's TSL collapses
    // hash(hash(...)) to a constant across invocations, which made all particles identical.
    const rndAt = (i: LooseBuf, salt: number) =>
      hash(i.toFloat().add(1.0).mul(1.6180339).add(u.time.mul(1.137)).add(float(salt * 2.399)));

    // ── spawn subroutine (shared by init + respawn); writes age=0 into meta ──
    const spawn = () => {
      const i = instanceIndex;
      const rnd = (salt: number) => rndAt(i, salt);

      const pos = vec3(0, 0, 0).toVar();
      const dir = vec3(0, 1, 0).toVar();

      // annulus radius (uniform area): r = sqrt(mix(in², out², u)). Reduces to out·sqrt(u)
      // when inner=0 and to exactly `out` when inner=out — TSL form of annulusRadius() in simSpec.ts.
      const inSq = u.radiusInner.mul(u.radiusInner);
      const outSq = u.radiusOuter.mul(u.radiusOuter);
      const annulusR = (salt: number) => mix(inSq, outSq, rnd(salt)).sqrt();

      If(u.shapeType.equal(int(SHAPE.cone)), () => {
        // Disc + launch cone in the shape's resolved basis (cylU, cylV ⟂ cylAxis), so the cone can
        // aim along an arbitrary `axis`. TSL mirror of the CPU `case 'cone'` in cpuSimulator.ts.
        const rad = annulusR(1);
        const a = rnd(2).mul(TAU);
        const c = cos(a).mul(rad), s = sin(a).mul(rad);
        const theta = u.coneAngle.mul(rnd(3));
        const phi = rnd(4).mul(TAU);
        const st = sin(theta);
        const pc = cos(phi).mul(st), ps = sin(phi).mul(st);
        pos.assign(u.cylU.mul(c).add(u.cylV.mul(s)));
        dir.assign(u.cylU.mul(pc).add(u.cylAxis.mul(cos(theta))).add(u.cylV.mul(ps)));
      }).ElseIf(u.shapeType.equal(int(SHAPE.sphere)), () => {
        const uu = rnd(1).mul(2).sub(1);
        const a = rnd(2).mul(TAU);
        const s = max(float(0), float(1).sub(uu.mul(uu))).sqrt();
        const d = vec3(s.mul(cos(a)), uu, s.mul(sin(a)));
        // uniform volume between two radii: r = cbrt(mix(in³, out³, u)) — sphereRadius() in simSpec.ts
        const inCube = u.radiusInner.mul(u.radiusInner).mul(u.radiusInner);
        const outCube = u.radiusOuter.mul(u.radiusOuter).mul(u.radiusOuter);
        const rad = mix(inCube, outCube, rnd(3)).pow(float(1 / 3));
        dir.assign(d);
        pos.assign(d.mul(rad));
      }).ElseIf(u.shapeType.equal(int(SHAPE.box)), () => {
        // solid fill (legacy) vs hollow frame, selected by the boxShell uniform.
        const solid = vec3(
          rnd(1).mul(2).sub(1).mul(u.boxOutHalf.x),
          rnd(2).mul(2).sub(1).mul(u.boxOutHalf.y),
          rnd(3).mul(2).sub(1).mul(u.boxOutHalf.z));
        // shell: a point on the surface of the box lerped between inner & outer half-extents.
        const f = rnd(4);
        const h = mix(u.boxInHalf, u.boxOutHalf, f);
        const k = int(floor(rnd(5).mul(3))); // pinned face axis (0,1,2)
        const sgn = select(rnd(6).lessThan(float(0.5)), float(-1), float(1));
        const free = vec3(rnd(7).mul(2).sub(1), rnd(8).mul(2).sub(1), rnd(9).mul(2).sub(1)).mul(h);
        const shell = vec3(
          select(k.equal(int(0)), sgn.mul(h.x), free.x),
          select(k.equal(int(1)), sgn.mul(h.y), free.y),
          select(k.equal(int(2)), sgn.mul(h.z), free.z));
        pos.assign(mix(solid, shell, u.boxShell));
      }).ElseIf(u.shapeType.equal(int(SHAPE.circle)), () => {
        const a = rnd(1).mul(TAU);
        const rad = annulusR(2);
        pos.assign(vec3(cos(a).mul(rad), float(0), sin(a).mul(rad)));
      }).ElseIf(u.shapeType.equal(int(SHAPE.cylinder)), () => {
        const rad = annulusR(1);
        const a = rnd(2).mul(TAU);
        const c = cos(a).mul(rad), s = sin(a).mul(rad);
        const hgt = rnd(3).mul(2).sub(1).mul(u.cylLength).mul(0.5);
        pos.assign(u.cylU.mul(c).add(u.cylV.mul(s)).add(u.cylAxis.mul(hgt)));
        dir.assign(u.cylAxis); // emit along the axis
      });

      const speed = mix(u.speedMin, u.speedMax, rnd(20)).mul(u.speedScale);
      const life = max(float(0.01), mix(u.lifeMin, u.lifeMax, rnd(21)));
      const size = mix(u.sizeMin, u.sizeMax, rnd(22));
      const rot = mix(u.rotMin, u.rotMax, rnd(23));
      // Bake the spawn through the emitter matrix (identity in local mode → no-op): position
      // as a point (w=1), velocity as a direction (w=0). Mirrors the CPU sim's worldSpace path.
      const wpos = u.emitterMatrix.mul(vec4(pos, float(1))).xyz;
      const wvel = u.emitterMatrix.mul(vec4(dir.mul(speed), float(0))).xyz;
      posBuf.element(i).assign(wpos);
      velBuf.element(i).assign(wvel);
      metaBuf.element(i).assign(vec4(float(0), life, size, rot));
      spinBuf.element(i).assign(mix(u.spinMin, u.spinMax, rnd(24)));
    };

    // ── init: spawn the whole pool with staggered ages so deaths spread over time ──
    entry.computeInit = Fn(() => {
      const i = instanceIndex;
      spawn();
      const m = metaBuf.element(i);
      metaBuf.element(i).assign(vec4(m.y.mul(rndAt(i, 50)), m.y, m.z, m.w));
    })().compute(count);

    // Force fields and collision are baked into the kernel only when the effect uses them,
    // so the common ambient case (galaxy/snow/dust) pays nothing for either.
    const hasForces = (def.forces?.length ?? 0) > 0;
    const hasCollision = !!def.collision && def.collision.mode !== 'none';
    const colliderShape = COLLIDER[def.collision?.shape ?? 'plane'];
    const colliderInvert = !!def.collision?.invert;

    // ── per-frame update: age, respawn-on-death, integrate (+ forces, + collision) ──
    entry.computeUpdate = Fn(() => {
      const i = instanceIndex;
      const m = metaBuf.element(i); // (age, life, size, rot)
      const age = m.x.add(u.dt);
      If(age.greaterThanEqual(m.y), () => {
        spawn();
      }).Else(() => {
        const pos = posBuf.element(i);
        const vel = velBuf.element(i);
        const f = u.noiseFreq;
        const tt = u.time.mul(u.noiseScroll);
        // curl-ish turbulence — TSL transcription of accumNoise() in simSpec.ts (canonical
        // formula + offsets live there; keep in lockstep). noiseStr scales to zero when off.
        const nx = sin(pos.y.mul(f).add(tt)).add(cos(pos.z.mul(f).sub(tt.mul(0.7))));
        const ny = sin(pos.z.mul(f).add(tt.mul(1.3))).add(cos(pos.x.mul(f).sub(tt)));
        const nz = sin(pos.x.mul(f).add(tt.mul(0.8))).add(cos(pos.y.mul(f).sub(tt.mul(1.1))));
        const acc = vec3(nx, ny, nz).mul(u.noiseStr).add(u.gravityVec).toVar();

        // External force fields (unrolled; inactive slots have strength 0). type 0 =
        // directional (dir·strength), 1 = point (unit vector toward xyz · strength; a
        // negative strength repels). TSL transcription of accumForce() in simSpec.ts
        // (the `max(len, 1e-4)` guard matches).
        if (hasForces) {
          for (let k = 0; k < MAX_GPU_FORCES; k++) {
            const fd = u.forces[k]; // vec4 (x, y, z, strength)
            const toP = fd.xyz.sub(pos);
            const len = toP.length().max(float(0.0001));
            const directional = fd.xyz.mul(fd.w);
            const point = toP.div(len).mul(fd.w);
            acc.assign(acc.add(mix(directional, point, u.forceTypes[k])));
          }
        }

        const drag = max(float(0), float(1).sub(u.drag.mul(u.dt))); // dragFactor() in simSpec.ts
        const newV = vel.add(acc.mul(u.dt)).mul(drag).toVar();
        const newPos = pos.add(newV.mul(u.dt)).toVar();
        const newRot = m.w.add(spinBuf.element(i).mul(u.dt));

        if (hasCollision) {
          // Collider geometry mirrors collide() in colliders.ts. Shape + invert are baked in
          // at build time, so only the active variant's math is emitted. Each branch produces
          // a hit flag, the surface-projected `corrected` position, and the reflected velocity
          // `reflV` (inbound normal component damped by restitution). `invert` flips the solid
          // region: solid = keep particles out, container = keep them in.
          const e1 = u.bounce.add(float(1));
          let hit, corrected, reflV;
          if (colliderShape === COLLIDER.sphere) {
            const delta = newPos.sub(u.collCenter);
            const dist = delta.length();
            hit = colliderInvert ? dist.greaterThan(u.collRadius) : dist.lessThan(u.collRadius);
            const dir = delta.div(dist.max(float(0.0001))); // center → particle
            corrected = u.collCenter.add(dir.mul(u.collRadius));
            const cn = colliderInvert ? dir.negate() : dir; // toward the allowed region
            reflV = newV.sub(cn.mul(newV.dot(cn).min(float(0)).mul(e1)));
          } else if (colliderShape === COLLIDER.box && colliderInvert) {
            // container box: clamp escapees back through the wall(s) they crossed (per-axis,
            // so a corner escape reflects on every violated axis at once)
            const lo = u.collCenter.sub(u.collHalf), hi = u.collCenter.add(u.collHalf);
            corrected = newPos.clamp(lo, hi);
            hit = corrected.distance(newPos).greaterThan(float(0));
            const fx = newPos.x.greaterThan(hi.x).and(newV.x.greaterThan(float(0))).or(newPos.x.lessThan(lo.x).and(newV.x.lessThan(float(0))));
            const fy = newPos.y.greaterThan(hi.y).and(newV.y.greaterThan(float(0))).or(newPos.y.lessThan(lo.y).and(newV.y.lessThan(float(0))));
            const fz = newPos.z.greaterThan(hi.z).and(newV.z.greaterThan(float(0))).or(newPos.z.lessThan(lo.z).and(newV.z.lessThan(float(0))));
            reflV = vec3(
              select(fx, newV.x.negate().mul(u.bounce), newV.x),
              select(fy, newV.y.negate().mul(u.bounce), newV.y),
              select(fz, newV.z.negate().mul(u.bounce), newV.z));
          } else if (colliderShape === COLLIDER.box) {
            // solid box: exit through the face of least penetration
            const local = newPos.sub(u.collCenter);
            const pen = u.collHalf.sub(abs(local)); // per-axis penetration depth
            hit = pen.x.greaterThan(float(0)).and(pen.y.greaterThan(float(0))).and(pen.z.greaterThan(float(0)));
            const sgn = sign(local);
            const xMin = pen.x.lessThanEqual(pen.y).and(pen.x.lessThanEqual(pen.z));
            const yMin = pen.y.lessThanEqual(pen.z).and(xMin.not());
            const cn = select(xMin, vec3(sgn.x, 0, 0), select(yMin, vec3(0, sgn.y, 0), vec3(0, 0, sgn.z)));
            corrected = select(xMin,
              vec3(u.collCenter.x.add(sgn.x.mul(u.collHalf.x)), newPos.y, newPos.z),
              select(yMin,
                vec3(newPos.x, u.collCenter.y.add(sgn.y.mul(u.collHalf.y)), newPos.z),
                vec3(newPos.x, newPos.y, u.collCenter.z.add(sgn.z.mul(u.collHalf.z)))));
            reflV = newV.sub(cn.mul(newV.dot(cn).min(float(0)).mul(e1)));
          } else if (colliderShape === COLLIDER.cylinder && colliderInvert) {
            // container cylinder: clamp escapees back inside the radius + end caps, damping the
            // radial and/or axial velocity component they crossed on (mirrors collide()).
            const local = newPos.sub(u.collCenter);
            const axial = local.dot(u.collAxis);
            const radialVec = local.sub(u.collAxis.mul(axial));
            const rd = radialVec.length();
            const outR = rd.greaterThan(u.collRadius);
            const outA = abs(axial).greaterThan(u.collHalfLen);
            hit = outR.or(outA);
            const clampedAxial = axial.clamp(u.collHalfLen.negate(), u.collHalfLen);
            const radialScale = select(outR, u.collRadius.div(rd.max(float(0.0001))), float(1));
            corrected = u.collCenter.add(u.collAxis.mul(clampedAxial)).add(radialVec.mul(radialScale));
            const ru = radialVec.div(rd.max(float(0.0001)));
            const vrad = newV.dot(ru);
            const vReflR = newV.sub(ru.mul(select(outR, vrad.max(float(0)).mul(e1), float(0))));
            const vax = vReflR.dot(u.collAxis);
            const axViolated = outA.and(vax.mul(sign(axial)).greaterThan(float(0)));
            reflV = vReflR.sub(u.collAxis.mul(select(axViolated, vax.mul(e1), float(0))));
          } else if (colliderShape === COLLIDER.cylinder) {
            // solid cylinder: exit through the nearer surface (curved wall vs end cap)
            const local = newPos.sub(u.collCenter);
            const axial = local.dot(u.collAxis);
            const radialVec = local.sub(u.collAxis.mul(axial));
            const rd = radialVec.length();
            hit = rd.lessThan(u.collRadius).and(abs(axial).lessThan(u.collHalfLen));
            const penR = u.collRadius.sub(rd);
            const penA = u.collHalfLen.sub(abs(axial));
            const radialOut = penR.lessThanEqual(penA);
            const ru = radialVec.div(rd.max(float(0.0001)));
            const capN = u.collAxis.mul(sign(axial));
            const cn = select(radialOut, ru, capN); // outward normal toward the exterior
            corrected = select(radialOut,
              u.collCenter.add(u.collAxis.mul(axial)).add(ru.mul(u.collRadius)),
              u.collCenter.add(u.collAxis.mul(sign(axial).mul(u.collHalfLen))).add(radialVec));
            reflV = newV.sub(cn.mul(newV.dot(cn).min(float(0)).mul(e1)));
          } else { // plane half-space
            const d = newPos.sub(u.planePoint).dot(u.planeNormal);
            hit = colliderInvert ? d.greaterThan(float(0)) : d.lessThan(float(0));
            corrected = newPos.sub(u.planeNormal.mul(d)); // project onto the plane
            const cn = colliderInvert ? u.planeNormal.negate() : u.planeNormal;
            reflV = newV.sub(cn.mul(newV.dot(cn).min(float(0)).mul(e1)));
          }
          // kill → recycle the slot in place (keeps the pool full); bounce → snap to the
          // surface and apply the reflected velocity.
          const active = u.collMode.greaterThan(int(0)).and(hit);
          If(active.and(u.collMode.equal(int(COLL.kill))), () => {
            spawn();
          }).Else(() => {
            If(active, () => { // reached only for bounce mode (kill handled above)
              newPos.assign(corrected);
              newV.assign(reflV);
            });
            posBuf.element(i).assign(newPos);
            velBuf.element(i).assign(newV);
            metaBuf.element(i).assign(vec4(age, m.y, m.z, newRot));
          });
        } else {
          posBuf.element(i).assign(newPos);
          velBuf.element(i).assign(newV);
          metaBuf.element(i).assign(vec4(age, m.y, m.z, newRot));
        }
      });
    })().compute(count);

    // ── render: billboard (default) or instanced 3D primitive (mesh mode) ──
    entry.lut = createOverLifeLUT(def);
    entry.mesh = def.render.mode === 'mesh'
      ? this.buildMeshParticles(def, posBuf, metaBuf, u, entry.lut, count)
      : this.buildMesh(def, posBuf, metaBuf, u, entry.lut, entry.texture, count);
    // Capture the renderer that actually draws this mesh; compute is dispatched against it.
    entry.mesh.onBeforeRender = (renderer) => { entry.renderer = renderer as unknown as ComputeRenderer; };
    entry.group.add(entry.mesh);
    entry.inited = false;
  }

  private buildMesh(
    def: ParticleEffectDef,
    posBuf: LooseBuf, metaBuf: LooseBuf, u: GpuUniforms, lut: OverLifeLUT,
    tex: THREE.Texture | null, count: number,
  ): THREE.Mesh {
    // Instanced quad: `instanceCount` alone drives the per-instance draw (gl_InstanceID →
    // `instanceIndex`). Per-particle state is read from the storage buffers via
    // `.element(instanceIndex)` — a read-only storage binding, not a vertex attribute, so it
    // sidesteps WebGPU's 8 vertex-buffer cap and reads exactly what the compute pass wrote.
    // `aspect` (width/height) makes a non-square billboard; per-instance scale drives
    // the height, so the quad is (aspect × 1) — matches a non-square sprite-sheet cell.
    const aspect = def.render.aspect && def.render.aspect > 0 ? def.render.aspect : 1;
    const src = new THREE.PlaneGeometry(aspect, 1);
    // Anchor + offset baked into the quad (units of size; scaleNode multiplies later).
    const shiftX = def.render.offset?.[0] ?? 0;
    const shiftY = (def.render.anchor === 'bottom' ? 0.5 : 0) + (def.render.offset?.[1] ?? 0);
    if (shiftX !== 0 || shiftY !== 0) src.translate(shiftX, shiftY, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = src.index ? src.index.clone() : null;
    geo.setAttribute('position', src.attributes.position.clone());
    geo.setAttribute('uv', src.attributes.uv.clone());
    src.dispose();
    geo.instanceCount = count;

    const mat = new SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: def.render.blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    const meta = metaBuf.element(instanceIndex); // vec4 (age, life, size, rot)
    const t = meta.x.div(meta.y.max(float(0.0001))).clamp(0, 1);
    const scalar = texture(lut.scalarTex, vec2(t, 0.5)); // r=size g=opacity b=gradAlpha
    const colorTex = texture(lut.colorTex, vec2(t, 0.5)); // rgb=gradient color

    mat.positionNode = posBuf.element(instanceIndex);
    mat.scaleNode = meta.z.mul(scalar.r);
    mat.rotationNode = meta.w;

    let colorExpr = u.startColor.mul(colorTex.rgb);
    let opacityExpr = u.startOpacity.mul(scalar.g).mul(scalar.b);

    if (tex) {
      const tx = Math.max(1, Math.floor(def.render.tilesX ?? 1));
      const ty = Math.max(1, Math.floor(def.render.tilesY ?? 1));
      let sampleUv: ReturnType<typeof vec2> = uv();
      if (tx > 1 || ty > 1) {
        const tileCount = tx * ty;
        // Stable per-particle [0,1) phase for random-start: depends only on instanceIndex, so
        // it's constant across a particle's life (and its slot's successive respawns).
        const off = def.render.spriteRandomStart
          ? floor(hash(instanceIndex.toFloat().add(1.0).mul(78.233)).mul(tileCount))
          : undefined;
        const frame = spriteFrameNode(
          t, tileCount, def.render.spriteMode ?? 'once', def.render.spriteCycles ?? 1, off,
        );
        sampleUv = spriteSheetUv(frame, tx, ty);
      }
      // Flip V for bottom-origin (KTX2, flipY=false) textures so the sprite reads right-side up.
      sampleUv = orientSampleUv(sampleUv, tex.flipY === false);
      const ts = texture(tex, sampleUv);
      colorExpr = colorExpr.mul(ts.rgb);
      opacityExpr = opacityExpr.mul(ts.a);
    } else {
      opacityExpr = opacityExpr.mul(radialAlpha());
    }

    if (def.render.softParticles) opacityExpr = opacityExpr.mul(softParticleFade());

    mat.colorNode = colorExpr;
    mat.opacityNode = opacityExpr;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    if (def.render.renderOrder != null) mesh.renderOrder = def.render.renderOrder;
    return mesh;
  }

  /**
   * Mesh mode: instance a small 3D primitive driven by the same storage buffers as the
   * billboard path. `instanceCount` drives the draw; per-instance center/size/rotation come
   * from `.element(instanceIndex)` storage reads (no instanceMatrix → no vertex-buffer
   * pressure). The geometry's `positionLocal`/`normalLocal` are scaled, tumbled by the
   * single rotation scalar (3-axis, matching meshMatrices on the CPU path) and translated
   * to the particle center, fully replacing the default transform via `positionNode`.
   */
  private buildMeshParticles(
    def: ParticleEffectDef,
    posBuf: LooseBuf, metaBuf: LooseBuf, u: GpuUniforms, lut: OverLifeLUT, count: number,
  ): THREE.Mesh {
    const src = makeParticlePrimitiveGeometry(def.render.meshPrimitive);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = src.index ? src.index.clone() : null;
    geo.setAttribute('position', src.attributes.position.clone());
    if (src.attributes.normal) geo.setAttribute('normal', src.attributes.normal.clone());
    src.dispose();
    geo.instanceCount = count;

    const additive = def.render.blend === 'additive';
    const Mat = def.render.meshLit ? MeshStandardNodeMaterial : MeshBasicNodeMaterial;
    const mat = new Mat({
      transparent: true,
      depthWrite: !additive, // solid chunks write depth; additive glow doesn't
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    const meta = metaBuf.element(instanceIndex); // vec4 (age, life, size, rot)
    const center = posBuf.element(instanceIndex);
    const t = meta.x.div(meta.y.max(float(0.0001))).clamp(0, 1);
    const scalar = texture(lut.scalarTex, vec2(t, 0.5)); // r=size g=opacity b=gradAlpha
    const colorTex = texture(lut.colorTex, vec2(t, 0.5));
    const scale = meta.z.mul(scalar.r);
    const rot = meta.w;
    const rotate = (v: LooseBuf) => eulerRotateXYZ(v, rot, rot.mul(0.73), rot.mul(0.31));

    mat.positionNode = rotate(positionLocal.mul(scale)).add(center);
    if (def.render.meshLit) mat.normalNode = rotate(normalLocal).normalize();
    mat.colorNode = u.startColor.mul(colorTex.rgb);
    mat.opacityNode = u.startOpacity.mul(scalar.g).mul(scalar.b);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    if (def.render.renderOrder != null) mesh.renderOrder = def.render.renderOrder;
    return mesh;
  }

  private loadTextureFor(entry: GpuEntry): void {
    const ref = entry.textureRef;
    if (!ref) return;
    loadTexture3D(ref)
      .then((tex) => {
        // stale: the entry was disposed or its ref changed while we loaded. The texture
        // is shared + refcounted (texture-shader-font F3) — release our ref instead of
        // disposing, so a sibling emitter sharing the same sprite isn't torn out from under.
        if (!this.entries.has(entry.id) || entry.textureRef !== ref) { releaseTexture3D(tex); return; }
        releaseTexture3D(entry.texture); // release any prior texture this entry held before replacing
        entry.texture = tex;
        this.build(entry, entry.def); // rebuild render with the texture
      })
      .catch((e) => console.warn(`[gpu-particles] texture load failed: ${ref}`, e));
  }

  getObject3D(handle: ParticleHandle): THREE.Object3D {
    return this.req(handle).group;
  }

  update(handle: ParticleHandle, dt: number): void {
    const e = this.entries.get(handle.id);
    if (!e || !e.playing) return;
    // Advance the noise/sim clock EVERY frame, even before a renderer has been
    // captured (F1) — the CPU backend always steps its clock, so render-gating the
    // time as well as the dispatch made GPU time start from 0 only once the mesh
    // first drew, skewing noise advection vs an identical CPU effect. Clamp once and
    // advance time by the SAME clamped step (a raw `time += dt` would desync noise
    // advection from motion after a stall; shared MAX_SIM_DT ceiling with the CPU path).
    const cdt = clampSimDt(dt);
    e.u.dt.value = cdt;
    e.u.time.value += cdt;
    const r = e.renderer; // captured in onBeforeRender — the renderer drawing this mesh
    if (!r) return; // compute needs a renderer; dispatch waits a frame, but time already advanced
    if (!e.inited && e.computeInit) { r.compute(e.computeInit); e.inited = true; }
    if (e.computeUpdate) r.compute(e.computeUpdate);
  }

  setTransform(handle: ParticleHandle, matrix: THREE.Matrix4): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    if (e.def.worldSpace) {
      // Spawns are baked into world space via the emitter-matrix uniform — keep the render
      // group at identity so already-born particles ignore subsequent emitter movement.
      e.group.matrix.identity();
      (e.u.emitterMatrix.value as THREE.Matrix4).copy(matrix);
    } else {
      e.group.matrix.copy(matrix);
      (e.u.emitterMatrix.value as THREE.Matrix4).identity();
    }
    e.group.matrixWorldNeedsUpdate = true;
  }

  setDef(handle: ParticleHandle, def: ParticleEffectDef): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    const isMesh = def.render.mode === 'mesh';
    const newTexRef = isMesh ? '' : (def.render.texture ?? ''); // mesh mode is untextured
    const texChanged = newTexRef !== e.textureRef;
    // hasForces/hasCollision are baked into the compute kernel, so their PRESENCE flipping
    // needs a rebuild; force values and kill↔bounce are plain uniforms (no rebuild).
    const hadForces = (e.def.forces?.length ?? 0) > 0, wantForces = (def.forces?.length ?? 0) > 0;
    const hadColl = !!e.def.collision && e.def.collision.mode !== 'none';
    const wantColl = !!def.collision && def.collision.mode !== 'none';
    // The collider shape + invert flag are baked into the kernel (only their math is emitted),
    // so switching plane↔sphere↔box or solid↔container needs a rebuild; center/radius/extents
    // are plain uniforms (no rebuild).
    const shapeChanged = (e.def.collision?.shape ?? 'plane') !== (def.collision?.shape ?? 'plane')
      || !!e.def.collision?.invert !== !!def.collision?.invert;
    // Sprite-sheet playback (mode/cycles/random-start) is baked into the render shader on the
    // GPU path, so changing it needs a rebuild. (The CPU sim computes the frame live, so it
    // doesn't — hence this stays out of the shared renderStructuralKey.)
    const o = e.def.render, n = def.render;
    const spriteChanged =
      (o.spriteMode ?? 'once') !== (n.spriteMode ?? 'once') ||
      (o.spriteCycles ?? 1) !== (n.spriteCycles ?? 1) ||
      (o.spriteRandomStart ?? false) !== (n.spriteRandomStart ?? false);
    const structural =
      renderStructuralKey(def) !== renderStructuralKey(e.def) ||
      wantForces !== hadForces ||
      wantColl !== hadColl ||
      (wantColl && shapeChanged) ||
      spriteChanged ||
      texChanged;
    e.def = def;
    if (texChanged) { releaseTexture3D(e.texture); e.textureRef = newTexRef; e.texture = null; } // shared, refcounted (F3) — release
    if (structural) {
      this.build(e, def);
      if (texChanged && newTexRef) this.loadTextureFor(e);
    } else {
      applyUniforms(e.u, def);
      e.lut?.update(def);
    }
  }

  play(handle: ParticleHandle): void { const e = this.entries.get(handle.id); if (e) e.playing = true; }
  pause(handle: ParticleHandle): void { const e = this.entries.get(handle.id); if (e) e.playing = false; }

  setSpeedScale(handle: ParticleHandle, scale: number): void {
    const e = this.entries.get(handle.id);
    if (e) e.u.speedScale.value = scale;
  }

  restart(handle: ParticleHandle): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    e.u.time.value = 0;
    e.inited = false; // re-seed the pool on the next update
    e.playing = true;
  }

  seek(handle: ParticleHandle, seconds: number): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    const r = e.renderer;
    if (!r || !e.computeInit || !e.computeUpdate) return;
    // Step forward from the current sim clock (cheap for forward scrubs); only re-seed
    // the pool + resim from zero when seeking backward (or before the first init).
    // `u.time.value` is the GPU backend's running sim time (advanced each update,
    // zeroed on restart), so it plays the role CPU's `simTime` does — mirroring the
    // CPU seek's forward-step/rewind model so both backends produce the same state for
    // the same scrub sequence (F3), incl. past the shared SEEK_MAX_STEPS cap.
    if (!e.inited || seconds < e.u.time.value) {
      r.compute(e.computeInit);
      e.inited = true;
      e.u.time.value = 0;
    }
    e.u.dt.value = PREWARM_STEP;
    const steps = seekSteps(e.u.time.value, seconds);
    for (let s = 0; s < steps; s++) { e.u.time.value += PREWARM_STEP; r.compute(e.computeUpdate); }
  }

  dispose(handle: ParticleHandle): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    if (e.mesh) this.disposeMesh(e.mesh);
    e.lut?.dispose();
    releaseTexture3D(e.texture); e.texture = null; // shared, refcounted (F3) — release on teardown
    this.entries.delete(handle.id);
  }

  private disposeMesh(mesh: THREE.Mesh): void {
    // These are plain THREE.Mesh with an InstancedBufferGeometry (instancing is
    // driven by instanceCount + storage reads, not an instanceMatrix), so the
    // geometry + material disposes below are the real cleanup.
    mesh.parent?.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }

  private req(handle: ParticleHandle): GpuEntry {
    const e = this.entries.get(handle.id);
    if (!e) throw new Error(`[gpu-particles] unknown handle ${handle.id}`);
    return e;
  }
}
