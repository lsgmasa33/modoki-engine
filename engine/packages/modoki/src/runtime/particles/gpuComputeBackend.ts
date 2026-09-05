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
import { resolveTiles, renderBuildKey, renderQuadKey, clampSimDt, PREWARM_STEP, seekSteps, MAX_GPU_FORCES, TEXTURE_WAIT_BUDGET_MS, type IParticleBackend, type ParticleEffectDef, type ParticleHandle, type EmitterShapeType } from './types';
import { resolveCollider } from './colliders';
import { resolveShape } from './emitterShapes';
import { resolveGravity, type Vec3 } from './simSpec';
import { createOverLifeLUT, type OverLifeLUT } from './gpuLut';
import { poolRevealDue } from './gpuPoolReveal';
import { makeParticlePrimitiveGeometry } from './meshParticles';
import { orientSampleUv, radialAlpha, softParticleFade, spriteFrameNode, spriteSheetUv } from './billboardTsl';
import { resolveQuadShift, computeQuadCorners, applyQuadInPlace } from './spriteBillboard';
import { textureProvider } from '../core/textureProvider';
import { rawNow } from '../core/clock';
import { warnVocabOnce } from '../core/warnVocab';

function loadTexture3D(ref: string, opts?: { flipY?: boolean }): Promise<THREE.Texture> {
  const p = textureProvider.get();
  return p ? p.loadTexture3D(ref, opts) : Promise.reject(new Error('textureProvider not wired'));
}
function releaseTexture3D(tex: THREE.Texture | null | undefined): void {
  textureProvider.get()?.releaseTexture3D(tex);
}



/** The one WebGPU queue method this backend needs, declared structurally so the file does not
 *  depend on `@webgpu/types` being in the lib set. */
interface GPUQueueLike { onSubmittedWorkDone(): Promise<void> }

/** Minimal view of the renderer used to dispatch compute passes. */
interface ComputeRenderer { compute(node: unknown): void; }

/** The four per-particle storage buffers a pool owns, held so they can be FREED (#717).
 *  Before this they were locals in `build()`, reachable only from the TSL closures that
 *  captured them — so `dispose()` ran cleanly, reported success, and freed none of them. */
interface PoolBuffers { pos: LooseBuf; vel: LooseBuf; meta: LooseBuf; spin: LooseBuf }

/**
 * Reuse an existing pool buffer, or mint a fresh one — preserving the EXACT type the fresh
 * branch infers. Not cosmetic: the TSL kernel below is written against these types, and both
 * obvious spellings break it.
 *  - A bare ternary widens to a UNION (`StorageBufferNode<'vec3'> | StorageBufferNode<'uvec4'>`,
 *    since `ReturnType<typeof instancedArray>` defaults to uvec4 — the "one wrong instantiation"
 *    `LooseBuf`'s comment describes), and every `.element(i)` overload stops matching.
 *  - Annotating them `LooseBuf`/`any` instead collapses inference DOWNSTREAM: the first typed
 *    call an `any` flows into re-types it (`sign(local)` -> `Node<'float'>`), so `sgn.y`/`sgn.z`
 *    stop resolving inside the box-collision branch.
 * This keeps the pre-#717 inferred types identical, so the kernel is untouched by the fix.
 */
function reuseOrMake<T>(reuse: boolean, prev: LooseBuf, make: () => T): T {
  return reuse ? (prev as T) : make();
}

/**
 * Free the GPU storage behind one `instancedArray` node.
 *
 * ⚠️ **three r0.184 exposes NO public API for this, and that is the whole reason #717 existed.**
 * `instancedArray(count, type)` returns a `StorageBufferNode` whose `.value` is a
 * `StorageInstancedBufferAttribute`. The only route to `GPUBuffer.destroy()` is
 * `Attributes.delete(attr)` -> `backend.destroyAttribute(attr)` -> `attributeUtils.destroyAttribute`
 * (`three/src/renderers/common/Attributes.js`), and `Renderer` has no `attributes` getter — the
 * field is private `_attributes`. So this reaches a private field on purpose.
 *
 * Why the obvious alternatives do NOT work, each checked in three's source rather than assumed:
 *  - `mesh.geometry.dispose()` cannot reach them. `Geometries.initGeometry`'s `onDispose` deletes
 *    only `renderObject.getAttributes()` and the index; these are STORAGE bindings, never geometry
 *    attributes (`buildMesh` sets only position/uv/index).
 *  - `computeNode.dispose()` cannot reach them either. `Renderer.compute()` registers a dispose
 *    listener that drops the PIPELINE, the bind groups and the node cache — `Bindings.deleteForCompute`
 *    calls `backend.deleteBindGroupData`, which frees the binding, not the buffer behind it.
 *
 * Guarded at every hop and never throws: `_attributes` is three-internal and has moved before, and
 * a failure here must degrade to "the buffer is not freed", never to a broken teardown.
 * If a future three release adds a public free, replace the body — the call sites stay.
 */
function freeStorageBuffer(renderer: ComputeRenderer | null, buf: LooseBuf): void {
  const attr = (buf as { value?: unknown } | null | undefined)?.value;
  if (!attr || !renderer) return;
  const attrs = (renderer as unknown as { _attributes?: { delete(a: unknown): unknown } })._attributes;
  // ⚠️ SAY SO when the reach stops working. Without this the failure mode is the EXACT defect this
  // function exists to fix, one level up: a three upgrade renames or `#`-privatises `_attributes`,
  // every free silently becomes a no-op, `verify` stays green (the unit test supplies `_attributes`
  // by construction, so it cannot catch this), and nothing in the logs changes. The public
  // cross-check is `renderer.info.memory.storageAttributes` — the counter the #717 arms used.
  if (!attrs) {
    warnVocabOnce('particles', 'renderer._attributes', 'missing',
      'GPU particle storage buffers CANNOT be freed on this three version (#717) — check renderer.info.memory.storageAttributes for unbounded growth');
    return;
  }
  try { attrs.delete(attr); } catch { /* never let a teardown fail on a three-internal shape change */ }
}

/** Free all four of a pool's storage buffers. No-op when the pool was never drawn (renderer
 *  null) — nothing was uploaded, so there is nothing on the GPU to release. */
function freePoolBuffers(renderer: ComputeRenderer | null, bufs: PoolBuffers | null): void {
  if (!bufs) return;
  freeStorageBuffer(renderer, bufs.pos);
  freeStorageBuffer(renderer, bufs.vel);
  freeStorageBuffer(renderer, bufs.meta);
  freeStorageBuffer(renderer, bufs.spin);
}

/** Dispose a ComputeNode, dropping its compute pipeline + bind groups.
 *  `Renderer.compute()` wires the listener that does this (`Renderer.js`, the `dispose` closure
 *  registered on first dispatch), so a node that was never dispatched simply has no listener and
 *  this is inert — which is why it is safe to call unconditionally. */
function disposeComputeNode(node: ComputeNodeT | null): void {
  try { (node as { dispose?: () => void } | null)?.dispose?.(); }
  catch { /* teardown must not fail on a node three never registered */ }
}

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

// Storage-buffer nodes are consumed via `.element(instanceIndex)` in both the compute kernels
// and the render builder — a storage BINDING, not a vertex attribute. (This said `.toAttribute()`
// until #717; that reading is what makes the buffers look like something `geometry.dispose()`
// would free, and it does not.)
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
  /** The pool's four storage buffers (#717). Held on the entry so `dispose()` and the rebuild
   *  path can FREE them — nothing else can reach them, since the TSL closures that read them
   *  are the only other reference. Null until the first `build()`. */
  bufs: PoolBuffers | null;
  count: number;
  playing: boolean;
  inited: boolean;
  /** Has the pool been made visible yet? Separate from `inited` on purpose — the reveal must
   *  happen a FULL FRAME after the init dispatch, never in the same `update()`. See update(). */
  revealed: boolean;
  /** update() calls since the init dispatch — the FALLBACK gate (see REVEAL_DELAY_FRAMES). */
  framesSinceInit: number;
  /** Bumped by every `build()`. An `onSubmittedWorkDone` promise captures the value it was armed
   *  with and reveals only if it still matches — otherwise a promise armed for a DISCARDED pool
   *  would reveal the fresh one that replaced it, early and against unfilled buffers. */
  readyToken: number;
  textureRef: string;
  texture: THREE.Texture | null;
  /** Waiting for a declared sprite to arrive, with the pool held at 0 instances meanwhile (#338
   *  reopen). The CPU backends have had this since the first #338 pass; THIS ONE DID NOT, and it
   *  is the worst place to be missing it: a 40k `fillPool` effect revealed before its sprite draws
   *  40,000 radial soft-circles additively — measured at mean frame luma 241/255 on
   *  `demos/particle-demo`'s Nebula, i.e. the full-screen white wash the issue reports. */
  awaitingTexture: boolean;
  /** `rawNow()` past which the pool is revealed untextured — see TEXTURE_WAIT_BUDGET_MS. */
  textureDeadline: number;
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
  if (!(def.shape.type in SHAPE)) warnVocabOnce('particles', 'EmitterShape.type', def.shape.type, "treated as 'point'");
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
      computeInit: null, computeUpdate: null, bufs: null, count: Math.max(1, def.maxParticles),
      playing: true, inited: false, revealed: false, framesSinceInit: 0, readyToken: 0,
      textureRef: def.render.mode === 'mesh' ? '' : (def.render.texture ?? ''), texture: null, renderer: null,
      awaitingTexture: false, textureDeadline: 0,
    };
    this.build(entry, def);
    this.entries.set(id, entry);
    if (entry.textureRef && def.render.mode !== 'mesh') {
      // Arm the wait BEFORE starting the load: a warm texture resolves on a microtask, so the
      // rebuild lands before anything is drawn and the pool is never actually seen held back.
      entry.awaitingTexture = true;
      entry.textureDeadline = rawNow() + TEXTURE_WAIT_BUDGET_MS;
      this.loadTextureFor(entry);
    }
    return { id };
  }

  /** Allocate storage buffers, compute kernels, LUTs and the render mesh for `def`. */
  private build(entry: GpuEntry, def: ParticleEffectDef): void {
    // Captured, not disposed, here — see the "free what this rebuild superseded" block below,
    // which frees the old mesh (and LUT) LAST, after the replacements are built and assigned.
    const prevMesh = entry.mesh;
    const prevLut = entry.lut;

    const count = Math.max(1, def.maxParticles);
    // Captured BEFORE `entry.count` is overwritten — the reuse decision is "is the new count the
    // same as the one the existing buffers were sized for?", which is unanswerable afterwards.
    const prevBufs = entry.bufs;
    const prevInit = entry.computeInit;
    const prevUpdate = entry.computeUpdate;
    // REUSE rather than reallocate when the pool size is unchanged (#717). This is the common
    // case by a wide margin and it is what makes the editor cheap: `maxParticles` is only ONE
    // field of `renderBuildKey`, so every blend / tiles / sprite-mode / texture change also
    // lands here with an identical `count` (aspect/anchor/offset changes no longer reach
    // `build()` at all — see `renderQuadKey` and the in-place applier in `setDef`, #769).
    // Measured on `games/3d-test` before this change: 12 blend toggles at 15k particles
    // allocated 48 storage buffers totalling 9.36 MB, none of it ever freed.
    // Safe because a rebuild re-inits the pool regardless — `entry.inited = false` below makes
    // `ensurePoolReady` dispatch `computeInit`, which respawns every slot, so no stale
    // particle state survives into the new definition.
    const reuseBufs = prevBufs !== null && entry.count === count;
    entry.count = count;
    const u = entry.u;
    applyUniforms(u, def);

    // ── storage buffers ──
    // pos/meta are read by the render shader (via `.element(instanceIndex)`); the rest are
    // compute-only. All four are storage bindings — see the note on `freeStorageBuffer`.
    // meta packs (age, life, size, rot) into one vec4 so render needs only 2 instanced
    // vertex attributes (pos + meta) — staying well under WebGPU's 8 vertex-buffer cap.
    const posBuf = reuseOrMake(reuseBufs, prevBufs?.pos, () => instancedArray(count, 'vec3'));
    const velBuf = reuseOrMake(reuseBufs, prevBufs?.vel, () => instancedArray(count, 'vec3'));
    const metaBuf = reuseOrMake(reuseBufs, prevBufs?.meta, () => instancedArray(count, 'vec4')); // x=age, y=life, z=size, w=rot
    const spinBuf = reuseOrMake(reuseBufs, prevBufs?.spin, () => instancedArray(count, 'float'));
    entry.bufs = { pos: posBuf, vel: velBuf, meta: metaBuf, spin: spinBuf };

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
    // ⚠️ DRAW NOTHING until the pool is ready — see `ensurePoolReady` / `gpuPoolReveal.ts` (#338).
    // The renderer is obtainable only from `onBeforeRender`, i.e. from a DRAW, so the first draw
    // necessarily precedes the first dispatch. Drawing `count` instances there renders them
    // against buffers `computeInit` has not filled, which on a 40k pool is a full-screen white
    // wash for the station's opening frames.
    //
    // ⚠️ Do NOT re-attribute this to the over-life LUT. That theory was tested on-device and
    // DISPROVED (probe: the LUTs are resident by the reveal draw), as were "the init dispatch was
    // skipped" (zeros give meta.z = 0 -> scaleNode = 0 -> nothing drawn, not white) and "one frame
    // boundary is enough" (measured: still flashed). The measurements that survive live in
    // `gpuPoolReveal.ts`; an earlier version of THIS comment carried the LUT story with a
    // different set of numbers, which is precisely how a ruled-out theory gets re-investigated.
    //
    // instanceCount 0 still issues the draw, so `onBeforeRender` DOES fire and the renderer is
    // still captured — verified live before relying on it; without that this would deadlock
    // (never drawn -> never captured -> never inited -> never drawn).
    (entry.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
    entry.revealed = false;
    entry.framesSinceInit = 0;
    entry.readyToken++;

    // ── free what this rebuild superseded (#717) ──
    // LAST, deliberately — after the replacements are built and assigned, never before.
    // `Pipelines.delete` decrements `usedTimes` and releases the compute PROGRAM when it hits
    // zero, so disposing the old nodes first would drop a program the new (byte-identical, when
    // nothing structural changed) kernel is about to ask for, forcing a needless recompile.
    // Note the ordering only mitigates: `pipelines.has(computeNode)` is populated at DISPATCH
    // time, not here, so the new nodes are not registered yet either way — this costs nothing
    // and is the correct discipline.
    // `disposeMesh` belongs in this set too (#769): its material carries a render pipeline with
    // the exact same `usedTimes` bookkeeping, so disposing the OLD mesh before the new one is
    // built and assigned risks dropping a pipeline the replacement (byte-identical, when nothing
    // render-relevant changed) is about to ask for — the same needless recompile as the compute
    // nodes. As with those, the ordering only mitigates: a render pipeline is registered in
    // `Pipelines.getForRender` at DRAW time, not at mesh construction, so the new mesh has not
    // acquired the pipeline yet either way when the old one is disposed here — this costs nothing
    // and is the correct discipline, but it does not by itself keep `usedTimes` off zero.
    disposeComputeNode(prevInit);
    disposeComputeNode(prevUpdate);
    if (prevMesh) this.disposeMesh(prevMesh);
    prevLut?.dispose();
    // Only when the pool was actually reallocated. On the reuse path `prevBufs` IS `entry.bufs`
    // and freeing it would destroy the buffers the new kernel just captured.
    if (!reuseBufs) freePoolBuffers(entry.renderer, prevBufs);
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
    // `aspect` (width/height) makes a non-square billboard; per-instance scale drives the
    // height, so the quad is (aspect × 1) — matches a non-square sprite-sheet cell. index/uv
    // come from a throwaway PlaneGeometry (invariant under aspect/anchor/offset); position is
    // built from computeQuadCorners so this build and applyQuadInPlace's in-place rewrite
    // (setDef, on a bare aspect/anchor/offset change) derive the same 12 floats (#769).
    const { aspect, shiftX, shiftY } = resolveQuadShift(def.render);
    const src = new THREE.PlaneGeometry(aspect, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = src.index ? src.index.clone() : null;
    geo.setAttribute('position', new THREE.BufferAttribute(computeQuadCorners(aspect, shiftX, shiftY), 3));
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
      const tx = resolveTiles(def.render.tilesX);
      const ty = resolveTiles(def.render.tilesY);
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
        if (!this.entries.has(entry.id) || entry.textureRef !== ref) {
          releaseTexture3D(tex);
          // ⚠️ Stop waiting on the way out — the CPU twin's #338 close-out F1, which applies
          // verbatim here now that this path can hold a pool back: `setDef` swapping to an empty
          // or mesh-mode ref starts NO replacement load, so returning silently would leave the
          // pool at 0 instances with nothing left that could ever reveal it.
          if (this.entries.has(entry.id)) entry.awaitingTexture = false;
          return;
        }
        releaseTexture3D(entry.texture); // release any prior texture this entry held before replacing
        entry.texture = tex;
        entry.awaitingTexture = false;
        this.build(entry, entry.def); // rebuild render with the texture (re-hides; re-reveals when ready)
      })
      .catch((e) => {
        entry.awaitingTexture = false; // a dead sprite must not hide the pool forever
        console.warn(`[gpu-particles] texture load failed: ${ref}`, e);
      });
  }

  getObject3D(handle: ParticleHandle): THREE.Object3D {
    return this.req(handle).group;
  }

  /** Dispatch `computeInit` and, once enough frames have passed, REVEAL the pool.
   *
   *  ⚠️ Deliberately callable while PAUSED, and called before `update()`'s play gate (#338
   *  review). Readiness is reachable only from here, so gating it on `playing` stranded a pool
   *  that was rebuilt while paused: `ParticleEditor` stops driving `update()` when paused
   *  (`ParticleEditor.tsx`'s rAF loop), and a structural edit there calls `build()`, which
   *  re-hides. The preview then stayed EMPTY until the user pressed Play, with no reason to
   *  connect the two. Readiness is about the buffers being drawable, not about time advancing —
   *  the gate counts calls, not simulated seconds, so a paused (dt = 0) driver still converges. */
  private ensurePoolReady(e: GpuEntry): void {
    const r = e.renderer; // captured in onBeforeRender — the renderer drawing this mesh
    if (!r) return; // compute needs a renderer; the dispatch waits for the first draw
    if (!e.inited && e.computeInit) {
      // Upload the over-life LUTs explicitly rather than leaving it to the first draw: the mesh
      // renders 0 instances until revealed below, so there is no draw to trigger a lazy upload.
      // `initTexture` throws if the backend is not initialized — it is here by construction (we
      // only hold a renderer because it already drew), so a throw means something we did not
      // model; swallow it rather than tearing down a frame, since the reveal below is what
      // actually protects the picture.
      const ri = r as unknown as { initTexture?: (t: THREE.Texture) => void };
      if (e.lut && typeof ri.initTexture === 'function') {
        try { ri.initTexture(e.lut.scalarTex); ri.initTexture(e.lut.colorTex); } catch { /* not fatal — see above */ }
      }
      r.compute(e.computeInit);
      e.inited = true;
      this.revealWhenGpuWorkDone(e);
      return; // ⚠️ never reveal in the same call that dispatched — see gpuPoolReveal.ts
    }
    // The texture deadline is spent here, alongside the readiness gate and BEFORE `update()`'s
    // play gate, for the same reason: a paused pool must still converge (the Particle Editor
    // pumps `update(h, 0)`), and reveal has no other source.
    if (e.awaitingTexture && rawNow() >= e.textureDeadline) e.awaitingTexture = false;
    if (e.inited && !e.revealed && poolRevealDue(++e.framesSinceInit)) this.revealPool(e);
  }

  /** Ask the GPU to tell us when the init dispatch has actually COMPLETED, and reveal then.
   *
   *  This is the readiness SIGNAL the frame counter was standing in for, and it is why
   *  `REVEAL_DELAY_FRAMES` is a fallback rather than the mechanism. `finishCompute` submits each
   *  compute group's own command buffer immediately (three r184 `WebGPUBackend.js`), so a
   *  `queue.onSubmittedWorkDone()` taken right after `compute()` returns covers our dispatch: it
   *  resolves once the work submitted so far has finished on the device. Revealing there cannot be
   *  too early by construction, and it self-tunes across GPUs instead of encoding one device's
   *  pipeline depth as a number.
   *
   *  ⚠️ Why the frame count STAYS as a backstop rather than being deleted: this reaches through
   *  `backend.device`, which only exists on the native WebGPU backend — the WebGL fallback has no
   *  such queue — and a lost device or a browser without `onSubmittedWorkDone` would otherwise
   *  leave the pool hidden forever. Capability-checked, and the counter still runs underneath.
   *
   *  ⚠️ The token compare is load-bearing, and note it does NOT depend on the buffers being fresh.
   *  Since #717 `build()` REUSES the storage buffers when `count` is unchanged, so the replacement
   *  pool can occupy the very same buffers; what makes the old promise stale is that `build()`
   *  re-inits and re-hides, not that it reallocated. A promise armed for the pool that was just
   *  discarded must not reveal the one that replaced it — that
   *  would draw full instance count against buffers whose own dispatch has not landed, i.e. the
   *  exact defect this file exists to prevent, reintroduced through a stale closure. */
  private revealWhenGpuWorkDone(e: GpuEntry): void {
    const q = (e.renderer as unknown as { backend?: { device?: { queue?: GPUQueueLike } } })?.backend?.device?.queue;
    if (!q || typeof q.onSubmittedWorkDone !== 'function') return; // WebGL / no device — the counter covers it
    const token = e.readyToken;
    q.onSubmittedWorkDone().then(() => {
      if (this.entries.get(e.id) !== e || e.readyToken !== token) return; // disposed, or a newer pool owns the mesh
      this.revealPool(e);
    }).catch(() => { /* device lost — the frame counter still reveals */ });
  }

  /** Make the pool drawable. Guarded together so `revealed` can never latch true on an entry
   *  whose mesh is missing (which would leave it permanently hidden AND permanently "revealed").
   *
   *  ⚠️ TWO conditions, not one: the buffers must be filled AND the declared sprite must have
   *  settled. Both callers can arrive first — `revealWhenGpuWorkDone` fires once, so this returning
   *  early there would strand the pool if that were the only path; it is not, because
   *  `ensurePoolReady`'s frame counter keeps re-trying every `update()` once `poolRevealDue` is
   *  true, and clears `awaitingTexture` itself at the deadline. */
  private revealPool(e: GpuEntry): void {
    if (!e.mesh || e.awaitingTexture) return;
    (e.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = e.count;
    e.revealed = true;
  }

  update(handle: ParticleHandle, dt: number): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    this.ensurePoolReady(e); // BEFORE the play gate — see ensurePoolReady
    if (!e.playing) return;
    // Advance the noise/sim clock EVERY frame, even before a renderer has been
    // captured (F1) — the CPU backend always steps its clock, so render-gating the
    // time as well as the dispatch made GPU time start from 0 only once the mesh
    // first drew, skewing noise advection vs an identical CPU effect. Clamp once and
    // advance time by the SAME clamped step (a raw `time += dt` would desync noise
    // advection from motion after a stall; shared MAX_SIM_DT ceiling with the CPU path).
    const cdt = clampSimDt(dt);
    e.u.dt.value = cdt;
    e.u.time.value += cdt;
    const r = e.renderer;
    if (!r) return; // no renderer yet — the clock advanced above, the dispatch waits for a draw
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
    // doesn't — hence this stays out of the shared renderBuildKey.)
    const o = e.def.render, n = def.render;
    const spriteChanged =
      (o.spriteMode ?? 'once') !== (n.spriteMode ?? 'once') ||
      (o.spriteCycles ?? 1) !== (n.spriteCycles ?? 1) ||
      (o.spriteRandomStart ?? false) !== (n.spriteRandomStart ?? false);
    const structural =
      renderBuildKey(def) !== renderBuildKey(e.def) ||
      wantForces !== hadForces ||
      wantColl !== hadColl ||
      (wantColl && shapeChanged) ||
      spriteChanged ||
      texChanged;
    // Compared against the OLD def, before it's overwritten below — a bare aspect/anchor/
    // offset edit is applied to the existing quad in place (#769), never a rebuild.
    const quadChanged = !structural && renderQuadKey(def) !== renderQuadKey(e.def);
    e.def = def;
    if (texChanged) { releaseTexture3D(e.texture); e.textureRef = newTexRef; e.texture = null; } // shared, refcounted (F3) — release
    if (structural) {
      this.build(e, def);
      if (texChanged && newTexRef) {
        // Re-arm the hidden-wait for the NEW sprite, exactly as create() does — otherwise a live
        // texture swap in the Particle Editor reveals the rebuilt pool untextured for a frame.
        e.awaitingTexture = true;
        e.textureDeadline = rawNow() + TEXTURE_WAIT_BUDGET_MS;
        this.loadTextureFor(e);
      } else if (texChanged) {
        e.awaitingTexture = false; // swapped to mesh mode / no sprite — nothing left to wait for
      }
      // ⚠️ `else if (texChanged)`, NOT a bare `else`. `structural` is true for a dozen non-texture
      // reasons (maxParticles, blend, forces, collider shape…), so a bare else cleared the wait on
      // ANY structural edit — including one made while the ORIGINAL sprite was still in flight,
      // which reveals the untextured pool and is precisely the white wash this gate exists to
      // prevent, reintroduced through the sweep that added it. Leaving the flag alone here is
      // correct: `build()` above re-used the (still null) texture, so the wait is still owed.
    } else {
      applyUniforms(e.u, def);
      e.lut?.update(def);
      // Mesh mode reads none of the quad-key fields (buildMeshParticles never touches
      // aspect/anchor/offset) — a change there is a no-op, not a rebuild.
      if (quadChanged && def.render.mode !== 'mesh' && e.mesh) {
        if (!applyQuadInPlace(e.mesh.geometry, def.render)) this.build(e, def); // shape guard failed — refuse a partial write
      }
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
    // ⚠️ Do NOT reveal here, and the reason is the one thing #338 actually MEASURED. An earlier
    // version did, justified as "a seek steps the buffers itself, so they are valid by
    // construction" — inference, and it contradicts the disproved-theory list in
    // `gpuPoolReveal.ts` two files away: a ONE-frame boundary between dispatch and draw still
    // flashed on both devices, and this path has a ZERO-frame one (`seekSteps(0, ~0)` can be 0,
    // so nothing at all separates the `computeInit` above from the next draw at full instance
    // count). Instead, restart the countdown and let `ensurePoolReady` reveal: the Particle
    // Editor pumps `update(h, 0)` while paused, so a scrub converges in REVEAL_DELAY_FRAMES
    // frames (~50 ms) — imperceptible, and it cannot flash.
    if (!e.revealed) e.framesSinceInit = 0;
  }

  dispose(handle: ParticleHandle): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    if (e.mesh) this.disposeMesh(e.mesh);
    e.lut?.dispose();
    releaseTexture3D(e.texture); e.texture = null; // shared, refcounted (F3) — release on teardown
    // The four storage buffers + both compute kernels (#717). Nothing else frees these: they are
    // storage bindings, so neither `disposeMesh`'s geometry.dispose() nor the material dispose
    // reaches them, and before this an emitter that spawned and despawned leaked
    // count*13*4 bytes of GPU storage permanently (13, not 11 — WebGPU pads each vec3 to 16 B).
    disposeComputeNode(e.computeInit); e.computeInit = null;
    disposeComputeNode(e.computeUpdate); e.computeUpdate = null;
    freePoolBuffers(e.renderer, e.bufs); e.bufs = null;
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
