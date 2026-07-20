/**
 * Canonical particle-simulation formulas — the single source of truth for the per-particle
 * integration step (curl-ish noise, external force fields, linear drag) and the spawn-radius
 * sampling, shared between the CPU simulator (`cpuSimulator.ts`) and the GPU compute kernel
 * (`gpuComputeBackend.ts`).
 *
 * WHY THIS MODULE EXISTS (engine-review runtime-particles F9): the integration math is
 * inherently mirrored across two languages — plain JS in the CPU sim, TSL nodes in the GPU
 * kernel — and TSL can't run headless, so there is no automatic parity test. The fix is the
 * pattern already used for the sprite-frame index (`spriteFrameIndex` ↔ `spriteFrameNode`) and
 * the seek step count (`seekSteps`): keep ONE documented, unit-tested scalar reference here that
 * the CPU sim actually CALLS, and write the TSL kernel as a *visible line-by-line transcription*
 * of these formulas. A future edit to the noise/drag/force math changes it here (caught by the
 * unit tests + every CPU consumer), and the GPU kernel's matching block is updated in lockstep.
 *
 * The functions are pure, allocation-light (they mutate a caller-owned {@link Vec3} accumulator,
 * matching the simulator's struct-of-arrays, no-GC style). Collision geometry lives in
 * `colliders.ts`; emitter-shape *resolution* in `emitterShapes.ts`; the radius samplers below are
 * the per-particle scalar half of that shape math (the GPU uploads the resolved form + samples
 * with these same formulas).
 *
 * ── Canonical formulas (CPU here ↔ TSL in gpuComputeBackend.computeUpdate) ───────────────────
 *
 *  noise   curl-ish turbulence, scrolled by `t = time · scrollSpeed`, frequency `f`:
 *            ax = sin(y·f + t)        + cos(z·f − t·0.7)
 *            ay = sin(z·f + t·1.3)    + cos(x·f − t)
 *            az = sin(x·f + t·0.8)    + cos(y·f − t·1.1)
 *          scaled by `strength`. (Not a true divergence-free curl — a cheap pseudo-curl whose
 *          asymmetric phase offsets read as swirling. Both backends MUST use identical offsets.)
 *
 *  forces  each field accumulates onto acceleration:
 *            directional → dir·strength
 *            point       → normalize(center − p)·strength   (negative strength repels)
 *          (GPU encodes the two as `mix(directional, point, type)` with type∈{0,1} and a tiny
 *          `max(len, 1e-4)` guard; the scalar below mirrors that guard.)
 *
 *  drag    linear, semi-implicit: v ← v·max(0, 1 − drag·dt). Clamped at 0 so a large
 *          `drag·dt` can't flip the velocity sign.
 *
 *  integrate  v ← (v + a·dt)·dragK ;  p ← p + v·dt   (drag applied AFTER the accel add, so a
 *             particle with no acceleration still decays — matches the GPU's `vel.add(acc·dt)·drag`).
 *
 *  spawn radius  disc/annulus: r = sqrt(mix(in², out², u))  (uniform area density)
 *                sphere shell:  r = cbrt(mix(in³, out³, u))  (uniform volume density)
 *                — both reduce to the legacy solid fill when inner=0 and to a thin shell at
 *                inner=outer. (Documented for spawn in emitterShapes.ts; the samplers live here.)
 */

import type { ForceField } from './types';

/** A mutable 3-vector used as an allocation-free accumulator. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Authored gravity: legacy scalar (downward `-Y` magnitude) OR an explicit `[x,y,z]`
 *  acceleration vector. See {@link resolveGravity}. */
export type GravityInput = number | [number, number, number] | undefined;

/**
 * Resolve authored gravity into a constant acceleration vector, written into `out` (no alloc).
 *
 * Two forms, one meaning:
 * - **scalar `g`** (legacy) → `(0, -g, 0)`: a downward pull of magnitude `g` along `-Y`. Pre-vector
 *   3D effects authored a number, so this keeps them pixel-identical.
 * - **vector `[x,y,z]`** → applied **as-is** (axis-neutral). This is what makes Option B work: a 2D
 *   effect authors `[0, +G, 0]` to fall toward screen-down (+Y in PixiJS) with NO render-side Y flip,
 *   and `[0, -G, 0]` to rise (smoke buoyancy). 3D keeps `[0, -g, 0]`.
 *
 * `undefined` → zero. Both the CPU sim and the GPU compute backend call this so a scalar and its
 * migrated vector integrate identically on either backend.
 */
export function resolveGravity(g: GravityInput, out: Vec3): Vec3 {
  if (Array.isArray(g)) {
    out.x = g[0]; out.y = g[1]; out.z = g[2];
  } else if (typeof g === 'number') {
    out.x = 0; out.y = -g; out.z = 0;
  } else {
    out.x = 0; out.y = 0; out.z = 0;
  }
  return out;
}

/**
 * Accumulate the curl-ish noise acceleration into `acc` (in place). `t = time · scrollSpeed`,
 * `f` = frequency, `strength` scales the whole contribution (0 = no-op, so callers can skip the
 * call entirely when strength is 0). GPU mirror: the `nx/ny/nz` block in `computeUpdate`.
 */
export function accumNoise(
  acc: Vec3, px: number, py: number, pz: number, f: number, t: number, strength: number,
): void {
  acc.x += (Math.sin(py * f + t) + Math.cos(pz * f - t * 0.7)) * strength;
  acc.y += (Math.sin(pz * f + t * 1.3) + Math.cos(px * f - t)) * strength;
  acc.z += (Math.sin(px * f + t * 0.8) + Math.cos(py * f - t * 1.1)) * strength;
}

/**
 * Accumulate one force field's acceleration into `acc` (in place). `directional` adds
 * `dir·strength`; `point` adds the unit vector toward `(f.x,f.y,f.z)` scaled by `strength`
 * (negative strength repels). The `|d|` divisor is guarded by `max(len, 1e-4)` so a particle
 * sitting exactly on a point source stays finite — the GPU kernel uses the same epsilon.
 */
export function accumForce(acc: Vec3, px: number, py: number, pz: number, f: ForceField): void {
  if (f.type === 'directional') {
    acc.x += f.x * f.strength;
    acc.y += f.y * f.strength;
    acc.z += f.z * f.strength;
  } else {
    const dx = f.x - px, dy = f.y - py, dz = f.z - pz;
    const len = Math.max(Math.hypot(dx, dy, dz), 1e-4);
    acc.x += (dx / len) * f.strength;
    acc.y += (dy / len) * f.strength;
    acc.z += (dz / len) * f.strength;
  }
}

/**
 * Linear-drag multiplier for one step: `max(0, 1 − drag·dt)`. Clamped so a large `drag·dt`
 * damps to a full stop instead of reversing velocity. Apply to velocity AFTER the accel add.
 * GPU mirror: `max(float(0), float(1).sub(u.drag.mul(u.dt)))`.
 */
export function dragFactor(drag: number, dt: number): number {
  return Math.max(0, 1 - drag * dt);
}

/**
 * Disc/annulus spawn radius with uniform area density: `sqrt(mix(in², out², u))` for `u ∈ [0,1)`.
 * Reduces to `out·sqrt(u)` when `inner = 0` and to exactly `outer` when `inner = outer`.
 * GPU mirror: the cone/circle/cylinder cross-section radius in the spawn kernel.
 */
export function annulusRadius(innerR: number, outerR: number, u: number): number {
  const i2 = innerR * innerR;
  return Math.sqrt(i2 + (outerR * outerR - i2) * u);
}

/**
 * Sphere-shell spawn radius with uniform volume density: `cbrt(mix(in³, out³, u))` for
 * `u ∈ [0,1)`. Reduces to `out·cbrt(u)` when `inner = 0` and to `outer` when `inner = outer`.
 * GPU mirror: the sphere radius in the spawn kernel.
 */
export function sphereRadius(innerR: number, outerR: number, u: number): number {
  const i3 = innerR * innerR * innerR;
  const o3 = outerR * outerR * outerR;
  return Math.cbrt(i3 + (o3 - i3) * u);
}
