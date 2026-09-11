/**
 * Particle collider geometry — pure, allocation-free math shared by the CPU simulator and
 * the test suite. The GPU compute backend re-implements the identical math as a TSL kernel
 * (gpuComputeBackend.ts), so an effect collides the same way on either backend; keep the
 * two in lockstep when editing.
 *
 * A collider is one of three solid shapes (see {@link CollisionConfig}). `resolveCollider`
 * flattens the authoring config into a runtime form (normalized plane normal, half-extents,
 * legacy `planeY` migrated to a plane point). `collide` tests a candidate position+velocity:
 * on contact it writes the surface-projected position and the normal-reflected velocity, and
 * the caller applies them (bounce) or recycles the particle (kill).
 */

import { COLLIDER_SHAPES, COLLISION_MODES, type CollisionConfig, type ColliderShape, type CollisionMode } from './types';
import { warnVocabOnce } from '../core/warnVocab';

/**
 * Normalise an authored `collision.shape` to one this code actually implements.
 *
 * ⚠️ **ONE place, because the two backends must not disagree about a typo** (#993). An absent
 * shape has always meant `plane`, so an UNRECOGNISED one is treated the same way — warn once, then
 * plane. Owner decision, 2026-09-11 (recorded on #993), taken together with the Inspector picker
 * that keeps a new typo from being authored in the first place.
 *
 * It used to differ by backend, and neither answer was chosen: the GPU path produced `undefined`
 * silently, and this file fell through to **`box`** purely because box was the last branch of an
 * if/else chain. The same `.particle.json` collided differently on CPU and GPU — against this
 * module's own docblock, which says to keep the two in lockstep.
 */
export function resolveColliderShape(shape: string | undefined): ColliderShape {
  if (shape === undefined) return 'plane';
  if ((COLLIDER_SHAPES as readonly string[]).includes(shape)) return shape as ColliderShape;
  warnVocabOnce('particles', 'CollisionConfig.shape', shape, "treated as 'plane'");
  return 'plane';
}

/** Runtime form of a {@link CollisionConfig} — defaults filled, plane normal unit-length. */
export interface ResolvedCollider {
  shape: ColliderShape;
  /** plane: unit surface normal */
  nx: number; ny: number; nz: number;
  /** plane point (plane) or center (sphere/box) */
  cx: number; cy: number; cz: number;
  /** sphere radius */
  radius: number;
  /** box half-extents */
  hx: number; hy: number; hz: number;
  /** container mode: keep particles inside the shape (vs solid: keep them out) */
  invert: boolean;
}

/**
 * Normalise an authored `collision.mode` to one both backends implement.
 *
 * ⚠️ The twin of {@link resolveColliderShape}, and it exists for the identical reason (#993
 * review). Fixing `shape` alone left `mode` one screen away in the same function still splitting
 * the backends: for `mode: "bounse"` the GPU mapped to `COLL.none` and its kernel's
 * `collMode.greaterThan(0)` made the whole collision block inert — particles pass through — while
 * the CPU sim asked only `mode !== 'none'` and then special-cased `'kill'`, so the SAME file
 * bounced. `none` is the fallback because it is what the GPU path already warned it was doing,
 * and because it is what an absent `collision` means.
 */
export function resolveCollisionMode(mode: string | undefined): CollisionMode {
  if (mode === undefined) return 'none';
  if ((COLLISION_MODES as readonly string[]).includes(mode)) return mode as CollisionMode;
  warnVocabOnce('particles', 'CollisionConfig.mode', mode, "treated as 'none'");
  return 'none';
}

export function resolveCollider(c: CollisionConfig): ResolvedCollider {
  const shape = resolveColliderShape(c.shape);
  // `nx/ny/nz` is the plane surface normal, or the cylinder axis — both unit-length.
  const n = shape === 'cylinder' ? (c.axis ?? [0, 1, 0]) : (c.planeNormal ?? [0, 1, 0]);
  const nlen = Math.hypot(n[0], n[1], n[2]) || 1;
  // plane is anchored by planePoint (legacy `planeY` → (0, planeY, 0)); sphere/box/cylinder by center.
  const p = shape === 'plane'
    ? (c.planePoint ?? [0, c.planeY ?? 0, 0])
    : (c.center ?? [0, 0, 0]);
  return {
    shape,
    nx: n[0] / nlen, ny: n[1] / nlen, nz: n[2] / nlen,
    cx: p[0], cy: p[1], cz: p[2],
    radius: c.radius ?? 1,
    // hy doubles as the cylinder half-length (along the axis); hx/hz unused for cylinder.
    hx: (c.width ?? 1) / 2, hy: (c.height ?? 1) / 2, hz: (c.depth ?? 1) / 2,
    invert: c.invert ?? false,
  };
}

/** Reusable result of {@link collide} — a scratch object avoids per-particle allocation. */
export interface CollisionHit {
  /** surface-projected (pushed-out) position */
  x: number; y: number; z: number;
  /** velocity with its inbound normal component reflected/damped by the restitution */
  vx: number; vy: number; vz: number;
}

/**
 * Test a candidate position/velocity against a solid collider. Returns `true` on contact
 * and fills `out` with the surface-projected position + reflected velocity; returns `false`
 * (leaving `out` untouched) when the particle is in free space. `restitution` is the
 * fraction of inbound normal velocity retained (0 = stop dead, 1 = perfectly elastic).
 *
 * Reflection touches only the inbound normal component: `v' = v − (1+e)·min(v·n, 0)·n`,
 * where `n` points toward the allowed region. The `min(…, 0)` guard means a particle
 * already moving away from the surface (e.g. just pushed out last step) isn't re-reflected.
 *
 * `rc.invert` flips the solid region: a solid sphere/box keeps particles out (hit when
 * inside), a container keeps them in (hit when outside).
 */
export function collide(
  rc: ResolvedCollider,
  x: number, y: number, z: number,
  vx: number, vy: number, vz: number,
  restitution: number,
  out: CollisionHit,
): boolean {
  const e = restitution;
  // Container box is the one shape that can be violated on several axes at once (a corner
  // escape), so it gets per-axis clamping instead of the single-normal reflection below.
  if (rc.shape === 'box' && rc.invert) {
    const lx = x - rc.cx, ly = y - rc.cy, lz = z - rc.cz;
    if (Math.abs(lx) <= rc.hx && Math.abs(ly) <= rc.hy && Math.abs(lz) <= rc.hz) return false;
    out.x = x; out.y = y; out.z = z; out.vx = vx; out.vy = vy; out.vz = vz;
    if (lx > rc.hx) { out.x = rc.cx + rc.hx; if (vx > 0) out.vx = -e * vx; }
    else if (lx < -rc.hx) { out.x = rc.cx - rc.hx; if (vx < 0) out.vx = -e * vx; }
    if (ly > rc.hy) { out.y = rc.cy + rc.hy; if (vy > 0) out.vy = -e * vy; }
    else if (ly < -rc.hy) { out.y = rc.cy - rc.hy; if (vy < 0) out.vy = -e * vy; }
    if (lz > rc.hz) { out.z = rc.cz + rc.hz; if (vz > 0) out.vz = -e * vz; }
    else if (lz < -rc.hz) { out.z = rc.cz - rc.hz; if (vz < 0) out.vz = -e * vz; }
    return true;
  }
  // Cylinder: decompose the point into an axial scalar (along the unit axis nx/ny/nz) and a
  // radial vector (the perpendicular remainder). `hy` is the half-length, `radius` the
  // cross-section radius. Like the container box it can violate two constraints at once (the
  // curved wall + an end cap), so it gets its own block rather than the single-normal path.
  if (rc.shape === 'cylinder') {
    const lx = x - rc.cx, ly = y - rc.cy, lz = z - rc.cz;
    const axial = lx * rc.nx + ly * rc.ny + lz * rc.nz;
    const rxv = lx - axial * rc.nx, ryv = ly - axial * rc.ny, rzv = lz - axial * rc.nz;
    const rd = Math.hypot(rxv, ryv, rzv);
    if (rc.invert) { // container: forbidden when outside the radius OR past an end cap
      if (rd <= rc.radius && Math.abs(axial) <= rc.hy) return false;
      const clampedAxial = Math.max(-rc.hy, Math.min(rc.hy, axial));
      const radialScale = rd > rc.radius ? rc.radius / rd : 1;
      out.x = rc.cx + clampedAxial * rc.nx + rxv * radialScale;
      out.y = rc.cy + clampedAxial * rc.ny + ryv * radialScale;
      out.z = rc.cz + clampedAxial * rc.nz + rzv * radialScale;
      out.vx = vx; out.vy = vy; out.vz = vz;
      if (rd > rc.radius) { // damp the outward radial velocity
        const inv = 1 / rd;
        const ux = rxv * inv, uy = ryv * inv, uz = rzv * inv;
        const vrad = out.vx * ux + out.vy * uy + out.vz * uz;
        if (vrad > 0) { const j = (1 + e) * vrad; out.vx -= j * ux; out.vy -= j * uy; out.vz -= j * uz; }
      }
      if (Math.abs(axial) > rc.hy) { // damp the velocity heading out a cap
        const vax = out.vx * rc.nx + out.vy * rc.ny + out.vz * rc.nz;
        if (vax * Math.sign(axial) > 0) { const j = (1 + e) * vax; out.vx -= j * rc.nx; out.vy -= j * rc.ny; out.vz -= j * rc.nz; }
      }
      return true;
    }
    // solid: forbidden when strictly inside; exit through the nearer surface
    if (rd >= rc.radius || Math.abs(axial) >= rc.hy) return false;
    const penR = rc.radius - rd; // distance to the curved wall
    const penA = rc.hy - Math.abs(axial); // distance to the nearer cap
    let nx: number, ny: number, nz: number; // outward normal (toward the allowed exterior)
    if (penR <= penA && rd > 1e-6) {
      const inv = 1 / rd;
      nx = rxv * inv; ny = ryv * inv; nz = rzv * inv;
      out.x = rc.cx + axial * rc.nx + nx * rc.radius;
      out.y = rc.cy + axial * rc.ny + ny * rc.radius;
      out.z = rc.cz + axial * rc.nz + nz * rc.radius;
    } else {
      const s = axial < 0 ? -1 : 1;
      nx = rc.nx * s; ny = rc.ny * s; nz = rc.nz * s;
      out.x = rc.cx + s * rc.hy * rc.nx + rxv;
      out.y = rc.cy + s * rc.hy * rc.ny + ryv;
      out.z = rc.cz + s * rc.hy * rc.nz + rzv;
    }
    const vn = vx * nx + vy * ny + vz * nz;
    const j = (1 + e) * Math.min(vn, 0);
    out.vx = vx - j * nx; out.vy = vy - j * ny; out.vz = vz - j * nz;
    return true;
  }
  let nx: number, ny: number, nz: number; // surface normal pointing toward the allowed region
  if (rc.shape === 'plane') {
    const d = (x - rc.cx) * rc.nx + (y - rc.cy) * rc.ny + (z - rc.cz) * rc.nz;
    const forbidden = rc.invert ? d > 0 : d < 0;
    if (!forbidden) return false;
    const s = rc.invert ? -1 : 1;
    nx = rc.nx * s; ny = rc.ny * s; nz = rc.nz * s;
    out.x = x - d * rc.nx; out.y = y - d * rc.ny; out.z = z - d * rc.nz; // project onto the plane
  } else if (rc.shape === 'sphere') {
    const dx = x - rc.cx, dy = y - rc.cy, dz = z - rc.cz;
    const dist = Math.hypot(dx, dy, dz);
    const forbidden = rc.invert ? dist > rc.radius : dist < rc.radius;
    if (!forbidden) return false;
    let ux: number, uy: number, uz: number; // unit vector from center to the particle
    if (dist > 1e-6) { ux = dx / dist; uy = dy / dist; uz = dz / dist; }
    else { ux = 0; uy = 1; uz = 0; } // dead center → arbitrary up
    out.x = rc.cx + ux * rc.radius; out.y = rc.cy + uy * rc.radius; out.z = rc.cz + uz * rc.radius;
    const s = rc.invert ? -1 : 1; // container → normal points inward
    nx = ux * s; ny = uy * s; nz = uz * s;
  } else { // solid box (axis-aligned)
    // ⚠️ KEEP this check even though `resolveColliderShape` makes an unrecognised STRING
    // unreachable here (#993 review). What it does not cover is a shape ADDED to
    // `COLLIDER_SHAPES` whose CPU math nobody wrote: the GPU's table is typed
    // `Record<ColliderShape, number>` so that case fails to COMPILE there, but this is an
    // if/else chain and would silently run solid-box math. Removing this line is what made
    // that silent — and the accept-side test (`for (const shape of COLLIDER_SHAPES)`) would
    // pass for the new member too.
    if (rc.shape !== 'box') {
      warnVocabOnce('particles', 'CollisionConfig.shape', rc.shape, "has no CPU collider math — treated as 'box'");
    }
    const lx = x - rc.cx, ly = y - rc.cy, lz = z - rc.cz;
    const px = rc.hx - Math.abs(lx);
    const py = rc.hy - Math.abs(ly);
    const pz = rc.hz - Math.abs(lz);
    if (px <= 0 || py <= 0 || pz <= 0) return false; // outside on at least one axis
    // exit along the axis of least penetration (shallowest push-out)
    if (px <= py && px <= pz) {
      const s = lx < 0 ? -1 : 1; nx = s; ny = 0; nz = 0;
      out.x = rc.cx + s * rc.hx; out.y = y; out.z = z;
    } else if (py <= pz) {
      const s = ly < 0 ? -1 : 1; nx = 0; ny = s; nz = 0;
      out.x = x; out.y = rc.cy + s * rc.hy; out.z = z;
    } else {
      const s = lz < 0 ? -1 : 1; nx = 0; ny = 0; nz = s;
      out.x = x; out.y = y; out.z = rc.cz + s * rc.hz;
    }
  }
  const vn = vx * nx + vy * ny + vz * nz;
  const j = (1 + e) * Math.min(vn, 0);
  out.vx = vx - j * nx; out.vy = vy - j * ny; out.vz = vz - j * nz;
  return true;
}
