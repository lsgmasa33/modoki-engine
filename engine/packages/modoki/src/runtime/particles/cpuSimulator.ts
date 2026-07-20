/**
 * CPU particle simulation — pure (no THREE, no GPU). Emits, integrates, ages, and
 * recycles particles in a dense struct-of-arrays pool (swap-remove on death), writing
 * per-particle render data directly into caller-provided instance buffers (zero-copy).
 *
 * Deterministic given a fixed RNG seed, so it can be unit-tested without a renderer.
 * A future GPU-compute backend would replace this with a TSL compute pass behind the
 * same IParticleBackend contract — this module is intentionally renderer-agnostic.
 */

import { spriteFrameIndex, type ParticleEffectDef, type RGB } from './types';
import { makeRng, randRange, sampleCurve, sampleGradientAlpha, sampleGradientColor } from './curves';
import { resolveCollider, collide, type CollisionHit } from './colliders';
import { resolveShape, samplePolyline, type ResolvedShape } from './emitterShapes';
import { accumNoise, accumForce, dragFactor, annulusRadius, sphereRadius, resolveGravity, type Vec3 } from './simSpec';

/** Instance buffers the simulator writes into each step (owned by the renderer). */
export interface ParticleOutputs {
  offsets: Float32Array; // maxParticles * 3
  scales: Float32Array; // maxParticles
  colors: Float32Array; // maxParticles * 3 (premultiplied not applied; color only)
  opacities: Float32Array; // maxParticles
  rotations: Float32Array; // maxParticles (radians)
  frames: Float32Array; // maxParticles (sprite-sheet frame index)
}

/**
 * Line-segment buffers for the optional trail renderer. Each alive particle contributes
 * `(segments-1)` line segments = `(segments-1)*2` vertices. Color carries the per-vertex
 * fade (RGB tapers to the tail), so additive blending reads it as an alpha fade.
 */
export interface TrailOutputs {
  positions: Float32Array; // maxParticles * (segments-1) * 2 * 3
  colors: Float32Array; // maxParticles * (segments-1) * 2 * 3
}

const DEG2RAD = Math.PI / 180;

export class CpuParticleSim {
  private def: ParticleEffectDef;
  private rshape: ResolvedShape;
  private readonly max: number;
  private readonly out: ParticleOutputs;
  private readonly rng: () => number;

  // SoA pool (first `count` entries are alive)
  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private size0: Float32Array;
  private rot: Float32Array;
  private rotVel: Float32Array;
  private frameSeed: Float32Array; // per-particle [0,1) phase for sprite random-start

  private count = 0;
  private time = 0; // seconds since play/restart
  private firstStep = true; // first step since start/reset — closed lower bound so a t=0 burst fires
  private emitAcc = 0; // fractional emission accumulator
  private scratch: RGB = { r: 1, g: 1, b: 1 };
  private polyScratch = { x: 0, y: 0 }; // reused polyline spawn-point (no GC per particle)
  private accel: Vec3 = { x: 0, y: 0, z: 0 }; // reused acceleration accumulator (no GC per particle)
  private grav: Vec3 = { x: 0, y: 0, z: 0 }; // reused gravity vector (resolved once per step)
  private collHit: CollisionHit = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };

  // World-space emission: when on, particles are baked into world space at birth using the
  // emitter's current matrix (set each frame by the backend) and thereafter ignore emitter
  // movement. When off (local), particles stay in emitter space and follow it (the backend
  // applies the matrix to the render group instead). Kept as a flat column-major 16-float
  // matrix so this module stays THREE-free / unit-testable.
  private worldSpace: boolean;
  private readonly emit = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  // Runtime multiplier on each new particle's launch speed (1 = authored). Driven per-frame
  // by the backend from ParticleEmitter.speedScale. Only affects NEW spawns, so a change
  // ramps in over ~one lifetime — exactly the feel of an engine throttling up/down.
  private speedScale = 1;

  // Continuous full-pool emission: keep every slot alive, ignoring rate/bursts. The pool
  // is filled once (staggered ages) then maintained by respawning particles in place on
  // death. This mirrors the GPU compute backend, so an effect looks the same on either.
  private fillPool: boolean;
  private prewarmed = false;

  // Trail: per-particle position history (oldest at index 0, newest at seg-1), swapped on kill.
  private readonly trailEnabled: boolean;
  private readonly trailSeg: number;
  private readonly trailOut: TrailOutputs | null;
  private trailHist: Float32Array; // max * trailSeg * 3

  // Sub-emitter lifecycle events for the current step, only collected when the def
  // declares a matching trigger. Each event is a flat [x,y,z, vx,vy,vz] sextet in the
  // emitter's local space; the backend drains these after step() to trigger child bursts.
  readonly birthEvents: number[] = [];
  readonly deathEvents: number[] = [];
  private recordBirths = false;
  private recordDeaths = false;

  constructor(def: ParticleEffectDef, out: ParticleOutputs, seed = 1337, trailOut?: TrailOutputs) {
    this.def = def;
    this.rshape = resolveShape(def.shape);
    this.max = def.maxParticles;
    this.out = out;
    this.rng = makeRng(seed);
    this.fillPool = !!def.emission.fillPool;
    this.worldSpace = !!def.worldSpace;
    this.recordBirths = !!def.subEmitters?.some((s) => s.trigger === 'birth');
    this.recordDeaths = !!def.subEmitters?.some((s) => s.trigger === 'death');
    this.trailEnabled = !!def.trail?.enabled;
    this.trailSeg = Math.max(2, def.trail?.segments ?? 8);
    this.trailOut = trailOut ?? null;
    this.trailHist = this.trailEnabled ? new Float32Array(this.max * this.trailSeg * 3) : new Float32Array(0);
    this.px = new Float32Array(this.max);
    this.py = new Float32Array(this.max);
    this.pz = new Float32Array(this.max);
    this.vx = new Float32Array(this.max);
    this.vy = new Float32Array(this.max);
    this.vz = new Float32Array(this.max);
    this.age = new Float32Array(this.max);
    this.life = new Float32Array(this.max);
    this.size0 = new Float32Array(this.max);
    this.rot = new Float32Array(this.max);
    this.rotVel = new Float32Array(this.max);
    this.frameSeed = new Float32Array(this.max);
  }

  /** Live particle count (== instanceCount to draw). */
  get aliveCount(): number {
    return this.count;
  }

  /** Hot-swap behavior params (keeps live particles; maxParticles is assumed stable). */
  setDef(def: ParticleEffectDef): void {
    this.def = def;
    this.rshape = resolveShape(def.shape);
    this.fillPool = !!def.emission.fillPool;
    this.worldSpace = !!def.worldSpace;
    this.recordBirths = !!def.subEmitters?.some((s) => s.trigger === 'birth');
    this.recordDeaths = !!def.subEmitters?.some((s) => s.trigger === 'death');
  }

  /** Runtime launch-speed multiplier applied to new spawns (1 = authored). */
  setSpeedScale(scale: number): void {
    this.speedScale = scale;
  }

  /**
   * Set the emitter's current world matrix (column-major 16 floats, e.g. THREE.Matrix4
   * `.elements`). Only consulted when `worldSpace` is on — new spawns are baked into world
   * space through it. The backend keeps the render group at identity in that mode.
   */
  setEmitterMatrix(m: ArrayLike<number>): void {
    for (let i = 0; i < 16; i++) this.emit[i] = m[i];
  }

  reset(): void {
    this.count = 0;
    this.time = 0;
    this.firstStep = true;
    this.emitAcc = 0;
    this.prewarmed = false;
    this.birthEvents.length = 0;
    this.deathEvents.length = 0;
  }

  /**
   * Spawn a single particle at a given local position with extra velocity added on top
   * of the shape-sampled launch velocity. Used by the backend to drive sub-emitter
   * bursts at a parent particle's birth/death position (with optional inherited velocity).
   */
  /** Spawn one particle at the given origin/velocity. Returns `false` if the pool was
   *  full (the particle was dropped) so callers can surface burst truncation. */
  injectAt(x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): boolean {
    return this.spawnOne(x, y, z, vx, vy, vz);
  }

  private spawnOne(originX = 0, originY = 0, originZ = 0, addVx = 0, addVy = 0, addVz = 0): boolean {
    if (this.count >= this.max) return false;
    this.initParticle(this.count++, originX, originY, originZ, addVx, addVy, addVz);
    return true;
  }

  /**
   * (Re)initialize particle slot `i` in place: shape-sample its position/direction and
   * roll its start values. Does NOT touch `count` — the caller manages the live range
   * (append via spawnOne, fill via prewarmFull, recycle in place for fillPool).
   */
  private initParticle(i: number, originX = 0, originY = 0, originZ = 0, addVx = 0, addVy = 0, addVz = 0): void {
    const def = this.def;
    const rng = this.rng;

    // ---- spawn position + direction by emitter shape ----
    let ox = 0, oy = 0, oz = 0; // position
    let dx = 0, dy = 1, dz = 0; // unit direction
    const shape = def.shape;
    const rs = this.rshape;
    // annulus radius with uniform area density: r = sqrt(mix(in², out², u)) — canonical form in
    // simSpec.ts (annulusRadius), mirrored by the GPU spawn kernel.
    const annulusR = () => annulusRadius(rs.innerR, rs.outerR, rng());
    switch (shape.type) {
      case 'cone': {
        // Spawn disc + launch cone are built in the shape's resolved basis (u, v ⟂ axis), so the
        // cone can point along an arbitrary `axis` (default (0,1,0)). For the default axis this is
        // the legacy behavior up to an azimuthal relabel (uniform random `a`/`phi` → statistically
        // identical). 2D up-cones set axis (0,-1,0) to spray toward screen-up (PixiJS +Y is down).
        const rad = annulusR();
        const a = rng() * Math.PI * 2;
        const c = Math.cos(a) * rad, s = Math.sin(a) * rad;
        ox = rs.ux * c + rs.vx * s; oy = rs.uy * c + rs.vy * s; oz = rs.uz * c + rs.vz * s;
        const theta = rs.angle * rng();
        const phi = rng() * Math.PI * 2;
        const st = Math.sin(theta), ct = Math.cos(theta);
        const pc = Math.cos(phi) * st, ps = Math.sin(phi) * st;
        dx = rs.ux * pc + rs.ax * ct + rs.vx * ps;
        dy = rs.uy * pc + rs.ay * ct + rs.vy * ps;
        dz = rs.uz * pc + rs.az * ct + rs.vz * ps;
        break;
      }
      case 'sphere': {
        // random direction on unit sphere
        const u = rng() * 2 - 1;
        const a = rng() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        dx = s * Math.cos(a); dy = u; dz = s * Math.sin(a);
        // uniform volume density between two radii: r = cbrt(mix(in³, out³, u)) — simSpec.ts.
        const rad = sphereRadius(rs.innerR, rs.outerR, rng());
        ox = dx * rad; oy = dy * rad; oz = dz * rad;
        break;
      }
      case 'circle': {
        const a = rng() * Math.PI * 2;
        const rad = annulusR();
        ox = Math.cos(a) * rad; oz = Math.sin(a) * rad; oy = 0;
        dx = 0; dy = 1; dz = 0;
        break;
      }
      case 'cylinder': {
        // point in the annular cross-section, placed in the (u,v) plane, offset along the axis
        const rad = annulusR();
        const a = rng() * Math.PI * 2;
        const c = Math.cos(a) * rad, s = Math.sin(a) * rad;
        const h = (rng() * 2 - 1) * rs.length * 0.5;
        ox = c * rs.ux + s * rs.vx + h * rs.ax;
        oy = c * rs.uy + s * rs.vy + h * rs.ay;
        oz = c * rs.uz + s * rs.vz + h * rs.az;
        dx = rs.ax; dy = rs.ay; dz = rs.az; // emit along the axis
        break;
      }
      case 'box': {
        if (rs.boxShell) {
          // hollow frame: a point on the surface of the box interpolated between inner & outer
          const f = rng();
          const hx = rs.inHalf[0] + (rs.outHalf[0] - rs.inHalf[0]) * f;
          const hy = rs.inHalf[1] + (rs.outHalf[1] - rs.inHalf[1]) * f;
          const hz = rs.inHalf[2] + (rs.outHalf[2] - rs.inHalf[2]) * f;
          const k = Math.floor(rng() * 3); // which face axis is pinned to the surface
          const sgn = rng() < 0.5 ? -1 : 1;
          ox = k === 0 ? sgn * hx : (rng() * 2 - 1) * hx;
          oy = k === 1 ? sgn * hy : (rng() * 2 - 1) * hy;
          oz = k === 2 ? sgn * hz : (rng() * 2 - 1) * hz;
        } else {
          // solid volume (legacy): uniform fill of the outer half-extents
          ox = (rng() * 2 - 1) * rs.outHalf[0];
          oy = (rng() * 2 - 1) * rs.outHalf[1];
          oz = (rng() * 2 - 1) * rs.outHalf[2];
        }
        dx = 0; dy = 1; dz = 0;
        break;
      }
      case 'polyline': {
        // 2D: spawn uniformly by arc length along the local-XY chain; z=0. Emit along the shape's
        // resolved axis (default (0,1,0)) — position (in the XY plane) and emit direction are
        // separate concerns. 2D "spray up along a line" sets axis (0,-1,0) (PixiJS +Y is down).
        samplePolyline(rs, rng(), this.polyScratch);
        ox = this.polyScratch.x; oy = this.polyScratch.y; oz = 0;
        dx = rs.ax; dy = rs.ay; dz = rs.az;
        break;
      }
      case 'point':
      default:
        ox = 0; oy = 0; oz = 0; dx = 0; dy = 1; dz = 0;
        break;
    }

    const speed = randRange(def.startSpeed, rng) * this.speedScale;
    ox += originX; oy += originY; oz += originZ;
    let svx = dx * speed + addVx, svy = dy * speed + addVy, svz = dz * speed + addVz;
    // World-space: bake the spawn pose through the emitter matrix at birth (position as a
    // point, velocity as a direction) so particles live in world space and don't follow the
    // emitter afterward. The trail-history seed + birth event below then carry world coords.
    if (this.worldSpace) {
      const m = this.emit;
      const wx = m[0] * ox + m[4] * oy + m[8] * oz + m[12];
      const wy = m[1] * ox + m[5] * oy + m[9] * oz + m[13];
      const wz = m[2] * ox + m[6] * oy + m[10] * oz + m[14];
      const rvx = m[0] * svx + m[4] * svy + m[8] * svz;
      const rvy = m[1] * svx + m[5] * svy + m[9] * svz;
      const rvz = m[2] * svx + m[6] * svy + m[10] * svz;
      ox = wx; oy = wy; oz = wz; svx = rvx; svy = rvy; svz = rvz;
    }
    this.px[i] = ox; this.py[i] = oy; this.pz[i] = oz;
    this.vx[i] = svx; this.vy[i] = svy; this.vz[i] = svz;
    this.age[i] = 0;
    this.life[i] = Math.max(0.01, randRange(def.startLifetime, rng));
    this.size0[i] = randRange(def.startSize, rng);
    this.rot[i] = def.startRotation ? randRange(def.startRotation, rng) * DEG2RAD : 0;
    this.rotVel[i] = def.rotationSpeed ? randRange(def.rotationSpeed, rng) * DEG2RAD : 0;
    this.frameSeed[i] = rng();

    // Seed the trail history with the spawn point so a fresh particle has no streak.
    if (this.trailEnabled) {
      const seg = this.trailSeg;
      const base = i * seg * 3;
      for (let s = 0; s < seg; s++) {
        this.trailHist[base + s * 3] = ox;
        this.trailHist[base + s * 3 + 1] = oy;
        this.trailHist[base + s * 3 + 2] = oz;
      }
    }

    // Record a birth event for sub-emitters (position + launch velocity).
    if (this.recordBirths) {
      this.birthEvents.push(ox, oy, oz, this.vx[i], this.vy[i], this.vz[i]);
    }
  }

  private kill(i: number): void {
    // Record a death event before the swap overwrites this slot.
    if (this.recordDeaths) {
      this.deathEvents.push(this.px[i], this.py[i], this.pz[i], this.vx[i], this.vy[i], this.vz[i]);
    }
    const last = --this.count;
    if (i !== last) {
      this.px[i] = this.px[last]; this.py[i] = this.py[last]; this.pz[i] = this.pz[last];
      this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last]; this.vz[i] = this.vz[last];
      this.age[i] = this.age[last]; this.life[i] = this.life[last]; this.size0[i] = this.size0[last];
      this.rot[i] = this.rot[last]; this.rotVel[i] = this.rotVel[last];
      this.frameSeed[i] = this.frameSeed[last];
      if (this.trailEnabled) {
        const blk = this.trailSeg * 3;
        this.trailHist.copyWithin(i * blk, last * blk, last * blk + blk);
      }
    }
  }

  /**
   * Fill the entire pool at once with staggered ages so deaths (and thus respawns) spread
   * evenly over time rather than pulsing. Used by continuous full-pool emission; mirrors
   * the GPU backend's staggered init. Particles sit at their spawn position (not pre-
   * integrated), matching the GPU path exactly.
   */
  private prewarmFull(): void {
    this.count = this.max;
    for (let i = 0; i < this.max; i++) {
      this.initParticle(i);
      this.age[i] = this.life[i] * this.rng();
    }
    // The initial fill shouldn't fire a giant one-frame burst of birth sub-emitters.
    this.birthEvents.length = 0;
  }

  /** Advance the simulation by `dt` seconds and write outputs. Returns alive count. */
  step(dt: number): number {
    if (dt < 0) dt = 0;
    const def = this.def;
    const prevTime = this.time;
    this.time += dt;

    // Sub-emitter events are per-step; clear last step's before (re)collecting.
    if (this.recordBirths) this.birthEvents.length = 0;
    if (this.recordDeaths) this.deathEvents.length = 0;

    // ---- emission ----
    if (this.fillPool) {
      // Continuous full-pool: fill once (staggered), then maintain via in-place respawn
      // in the integrate loop below. rateOverTime/bursts are intentionally ignored.
      if (!this.prewarmed) {
        this.prewarmFull();
        this.prewarmed = true;
      }
    } else {
      // One-shot (looping=false): emit only during the first [0,duration) window, then
      // stop — particles already alive drain out naturally. Looping effects emit forever.
      const emitting = def.looping || def.duration <= 0 || this.time < def.duration;
      if (emitting) {
        this.emitAcc += def.emission.rateOverTime * dt;
        while (this.emitAcc >= 1 && this.count < this.max) {
          this.spawnOne();
          this.emitAcc -= 1;
        }
        // Pool saturated: don't let the accumulator build a backlog (it would dump a
        // one-frame flood the moment slots free up). Keep at most one pending spawn.
        if (this.count >= this.max && this.emitAcc > 1) this.emitAcc = 1;
      }
      // bursts: looping refires each duration cycle; one-shot fires each burst once
      // (cycle = Infinity → a burst crosses exactly once over the lifetime). The interval is
      // normally half-open (localPrev, localNow] so a burst fires once as time passes it — but on
      // the FIRST step after start/reset the lower bound is CLOSED so a burst authored at exactly
      // the start time (the common `time: 0`) fires, instead of being skipped because
      // localPrev === b.time === 0. Without this, a t=0 burst never emits (and a control-track
      // particle RESTART, which reset()s to 0, would show nothing).
      if (def.emission.bursts) {
        const cycle = def.looping && def.duration > 0 ? def.duration : Infinity;
        const localPrev = prevTime % cycle;
        const localNow = this.time % cycle;
        const wrapped = localNow < localPrev;
        for (const b of def.emission.bursts) {
          const afterLow = this.firstStep ? b.time >= localPrev : b.time > localPrev;
          const crossed = wrapped
            ? b.time > localPrev || b.time <= localNow
            : afterLow && b.time <= localNow;
          if (crossed) for (let k = 0; k < b.count; k++) this.spawnOne();
        }
      }
    }
    this.firstStep = false;

    // ---- integrate + recycle ----
    // Resolve gravity once per step into a reused vector: scalar → (0,-g,0), vector applied as-is
    // (axis-neutral — see resolveGravity in simSpec.ts). Mirrored by the GPU kernel's gravityVec uniform.
    const grav = resolveGravity(def.gravity, this.grav);
    const drag = def.drag ?? 0;
    const noise = def.noise;
    const noiseF = noise?.frequency ?? 1;
    const noiseT = this.time * (noise?.scrollSpeed ?? 1);
    const forces = def.forces;
    const coll = def.collision;
    const rc = coll && coll.mode !== 'none' ? resolveCollider(coll) : null;
    const collHit = this.collHit;
    let i = 0;
    while (i < this.count) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        if (this.fillPool) {
          // Keep the pool full: respawn this slot in place instead of swap-removing it.
          if (this.recordDeaths) this.deathEvents.push(this.px[i], this.py[i], this.pz[i], this.vx[i], this.vy[i], this.vz[i]);
          this.initParticle(i); // fresh particle (age reset to 0) in the same slot
          i++;
          continue;
        }
        this.kill(i);
        continue; // index i now holds the swapped-in particle
      }
      const px = this.px[i], py = this.py[i], pz = this.pz[i];
      // acceleration: gravity + noise + force fields. Canonical formulas live in simSpec.ts;
      // the GPU kernel transcribes the same functions in TSL (see F9).
      const acc = this.accel;
      acc.x = grav.x; acc.y = grav.y; acc.z = grav.z;
      if (noise && noise.strength) accumNoise(acc, px, py, pz, noiseF, noiseT, noise.strength);
      if (forces) for (const f of forces) accumForce(acc, px, py, pz, f);
      // integrate velocity (+ optional linear drag)
      let vx = this.vx[i] + acc.x * dt, vy = this.vy[i] + acc.y * dt, vz = this.vz[i] + acc.z * dt;
      if (drag) { const k = dragFactor(drag, dt); vx *= k; vy *= k; vz *= k; }
      let nx = px + vx * dt, ny = py + vy * dt, nz = pz + vz * dt;
      // plane / sphere / box collision (shared geometry with the GPU kernel)
      if (rc && collide(rc, nx, ny, nz, vx, vy, vz, coll!.bounce, collHit)) {
        if (coll!.mode === 'kill') {
          if (this.fillPool) {
            // keep the pool full: recycle in place (mirrors the GPU backend), don't drain
            if (this.recordDeaths) this.deathEvents.push(this.px[i], this.py[i], this.pz[i], this.vx[i], this.vy[i], this.vz[i]);
            this.initParticle(i);
            i++;
            continue;
          }
          this.kill(i);
          continue;
        }
        nx = collHit.x; ny = collHit.y; nz = collHit.z;
        vx = collHit.vx; vy = collHit.vy; vz = collHit.vz;
      }
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
      this.px[i] = nx; this.py[i] = ny; this.pz[i] = nz;
      this.rot[i] += this.rotVel[i] * dt;
      // Trail: drop the oldest history point, append the new position at the head.
      if (this.trailEnabled) {
        const seg = this.trailSeg;
        const base = i * seg * 3;
        this.trailHist.copyWithin(base, base + 3, base + seg * 3);
        const head = base + (seg - 1) * 3;
        this.trailHist[head] = nx; this.trailHist[head + 1] = ny; this.trailHist[head + 2] = nz;
      }
      i++;
    }

    // ---- write render outputs for alive particles ----
    const { offsets, scales, colors, opacities, rotations, frames } = this.out;
    const baseColor = def.startColor;
    const baseOpacity = def.startOpacity ?? 1;
    const grad = def.colorOverLife;
    const sc = this.scratch;
    const r = def.render;
    const tileCount = Math.max(1, (r.tilesX ?? 1) * (r.tilesY ?? 1));
    const spriteMode = r.spriteMode ?? 'once';
    const spriteCycles = r.spriteCycles ?? 1;
    const randomStart = r.spriteRandomStart ?? false;
    // 2D align-to-velocity: face the sprite along its travel direction, with the spun/authored
    // `rot` added on top as an offset. Ignored by the 3D billboard backend (camera-facing).
    const alignVel = !!r.alignToVelocity;
    for (let j = 0; j < this.count; j++) {
      const t = this.age[j] / this.life[j];
      offsets[j * 3] = this.px[j];
      offsets[j * 3 + 1] = this.py[j];
      offsets[j * 3 + 2] = this.pz[j];
      scales[j] = this.size0[j] * sampleCurve(def.sizeOverLife, t);
      sampleGradientColor(grad, t, sc);
      colors[j * 3] = baseColor.r * sc.r;
      colors[j * 3 + 1] = baseColor.g * sc.g;
      colors[j * 3 + 2] = baseColor.b * sc.b;
      opacities[j] = baseOpacity * sampleGradientAlpha(grad, t) * sampleCurve(def.opacityOverLife, t);
      rotations[j] = alignVel ? Math.atan2(this.vy[j], this.vx[j]) + this.rot[j] : this.rot[j];
      const off = randomStart ? Math.floor(this.frameSeed[j] * tileCount) : 0;
      frames[j] = spriteFrameIndex(t, tileCount, spriteMode, spriteCycles, off);
    }

    // ---- write trail line segments (reuse each particle's head color × opacity) ----
    if (this.trailEnabled && this.trailOut) {
      const seg = this.trailSeg;
      const hist = this.trailHist;
      const { positions, colors: tcol } = this.trailOut;
      const vPer = (seg - 1) * 2; // vertices per particle
      for (let j = 0; j < this.count; j++) {
        const cr = colors[j * 3], cg = colors[j * 3 + 1], cb = colors[j * 3 + 2];
        const op = opacities[j];
        const hbase = j * seg * 3;
        const vbase = j * vPer * 3;
        for (let s = 0; s < seg - 1; s++) {
          const p0 = hbase + s * 3, p1 = hbase + (s + 1) * 3, o = vbase + s * 6;
          positions[o] = hist[p0]; positions[o + 1] = hist[p0 + 1]; positions[o + 2] = hist[p0 + 2];
          positions[o + 3] = hist[p1]; positions[o + 4] = hist[p1 + 1]; positions[o + 5] = hist[p1 + 2];
          // taper RGB from tail (faint) to head (full) — additive reads this as alpha
          const f0 = (s / (seg - 1)) * op, f1 = ((s + 1) / (seg - 1)) * op;
          tcol[o] = cr * f0; tcol[o + 1] = cg * f0; tcol[o + 2] = cb * f0;
          tcol[o + 3] = cr * f1; tcol[o + 4] = cg * f1; tcol[o + 5] = cb * f1;
        }
      }
    }
    return this.count;
  }
}
