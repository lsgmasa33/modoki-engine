/** Pure 2D affine-skinning math for the `.rig2d.json` runtime (`skin2DSystem`).
 *
 *  A 2×3 affine matrix `Mat2D` maps a point (x,y) → (a·x + c·y + e, b·x + d·y + f):
 *
 *      | a  c  e |     | x |     | a·x + c·y + e |
 *      | b  d  f |  ·  | y |  =  | b·x + d·y + f |
 *      | 0  0  1 |     | 1 |     |       1       |
 *
 *  Everything here is deterministic (only `Math.cos`/`Math.sin`/arithmetic — no
 *  wall-clock, no RNG) so the skinning fits the verification harness and the
 *  determinism guard. Angles are RADIANS, matching `Transform.rz` at runtime.
 *
 *  No imports — this module is unit-tested in isolation (`rig2dMath.test.ts`) and
 *  consumed by both `skin2DSystem` (deform) and the rig loader (inverse-bind). */

export interface Mat2D {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

/** The identity affine — leaves every point unchanged. */
export function identity2D(): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

/** Compose a local affine from a TRS tuple: translate (x,y), rotate `rot`
 *  (radians), scale (sx,sy). Order is T · R · S — scale first, then rotate, then
 *  translate — matching how `Transform` composes a node's local matrix. */
export function compose2D(x: number, y: number, rot: number, sx: number, sy: number): Mat2D {
  const cos = Math.cos(rot), sin = Math.sin(rot);
  // R·S: rotation applied to the axis-scaled basis.
  return {
    a: cos * sx, b: sin * sx,
    c: -sin * sy, d: cos * sy,
    e: x, f: y,
  };
}

/** Matrix product `m1 · m2` — the result applies m2 to a point FIRST, then m1
 *  (so `mul(parent, child)` yields the child's parent-relative matrix). */
export function mul2D(m1: Mat2D, m2: Mat2D): Mat2D {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

/** Invert an affine. Returns the identity if the matrix is (near-)singular
 *  (degenerate zero-scale bind pose) rather than emitting NaNs downstream. */
export function invert2D(m: Mat2D): Mat2D {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0 || !Number.isFinite(det)) return identity2D();
  const inv = 1 / det;
  const ia = m.d * inv, ib = -m.b * inv, ic = -m.c * inv, id = m.a * inv;
  return {
    a: ia, b: ib, c: ic, d: id,
    e: -(ia * m.e + ic * m.f),
    f: -(ib * m.e + id * m.f),
  };
}

/** Strip the SCALE from an affine, keeping its rotation + translation (each 2×2 basis
 *  column renormalized to unit length). Implements Spine's `noScale` bone-inherit mode:
 *  a bone composed as `removeScale2D(parentWorld) · childLocal` ignores the parent's
 *  scale, so an animated breathing-scale on an ancestor doesn't cascade to it. A zero-
 *  length column is left untouched (degenerate — avoids div-by-zero / NaN). */
export function removeScale2D(m: Mat2D): Mat2D {
  const sx = Math.hypot(m.a, m.b) || 1;
  const sy = Math.hypot(m.c, m.d) || 1;
  return { a: m.a / sx, b: m.b / sx, c: m.c / sy, d: m.d / sy, e: m.e, f: m.f };
}

/** Apply an affine to a point, writing into `out` (packed [x,y]) at offset `o`. */
export function apply2D(m: Mat2D, x: number, y: number, out: Float32Array, o: number): void {
  out[o] = m.a * x + m.c * y + m.e;
  out[o + 1] = m.b * x + m.d * y + m.f;
}

/** A bone's bind-pose spec (local TRS relative to its parent; `parent` = -1 for a
 *  root bone, whose local is relative to the rig origin / texture space). */
export interface BindBone {
  parent: number; x: number; y: number; rot: number;
}

/** Derive each bone's bind-pose rig-origin ("root-local") matrix and its inverse,
 *  by composing local matrices up the parent chain. Robust to any bone ordering
 *  (memoized with a cycle guard), though parents-before-children is conventional.
 *  The inverse-bind is what turns a live pose into a skinning matrix:
 *  `skinMatrix[b] = rootLocalNow[b] · invBind[b]` (identity at bind). */
export function deriveBindMatrices(bones: readonly BindBone[]): { rootLocal: Mat2D[]; invBind: Mat2D[] } {
  const n = bones.length;
  const local = bones.map((b) => compose2D(b.x, b.y, b.rot, 1, 1));
  const rootLocal: (Mat2D | undefined)[] = new Array(n);
  const resolve = (i: number, seen: Set<number>): Mat2D => {
    const cached = rootLocal[i];
    if (cached) return cached;
    const p = bones[i].parent;
    const m = (p >= 0 && p < n && !seen.has(p))
      ? mul2D(resolve(p, new Set(seen).add(i)), local[i])
      : local[i];
    rootLocal[i] = m;
    return m;
  };
  for (let i = 0; i < n; i++) resolve(i, new Set([i]));
  const rl = rootLocal as Mat2D[];
  return { rootLocal: rl, invBind: rl.map(invert2D) };
}

/** Linear-blend-skin one vertex against up to 4 bone skinning matrices.
 *
 *  `skinMats[boneIdx]` is `rootLocalNow[bone] · invBind[bone]`. The skinned
 *  position is the weighted sum of the bind vertex pushed through each influencing
 *  bone's skinning matrix. Weights are assumed normalized (unused slots weight 0).
 *  Writes the packed [x,y] result into `out` at offset `o`. */
export function skinVertex2D(
  vx: number, vy: number,
  idx: ArrayLike<number>, // packed 4-per-vertex bone indices (Uint32Array or number[])
  wgt: ArrayLike<number>, // packed 4-per-vertex weights (Float32Array or number[])
  base: number,           // start offset into idx/wgt for this vertex (× 4)
  skinMats: readonly Mat2D[],
  out: Float32Array, o: number,
): void {
  let ox = 0, oy = 0;
  for (let i = 0; i < 4; i++) {
    const w = wgt[base + i];
    if (w === 0) continue;
    const m = skinMats[idx[base + i]];
    if (!m) continue;
    ox += w * (m.a * vx + m.c * vy + m.e);
    oy += w * (m.b * vx + m.d * vy + m.f);
  }
  out[o] = ox;
  out[o + 1] = oy;
}
