/** decomposeTrs — `Matrix4` → TRS that still tells the truth when the matrix is SINGULAR.
 *
 *  `THREE.Matrix4.decompose()` gives up on a singular matrix and returns a LIE rather than an
 *  error (three r184, `src/math/Matrix4.js`):
 *
 *  ```js
 *  const det = this.determinant();
 *  if ( det === 0 ) { scale.set( 1, 1, 1 ); quaternion.identity(); return this; }
 *  ```
 *
 *  A `Transform` scale of exactly 0 on ANY axis, anywhere in the parent chain, makes the composed
 *  world matrix singular — so the entity you asked to be invisible comes back at **identity scale
 *  and identity rotation**. That is the loudest failure available: it renders at FULL size, the
 *  parent chain's scale disappears from the composition, and any rotation is silently dropped too.
 *  It is also invisible to the ECS — the local trait reads back `0` exactly, so only the pixels are
 *  wrong (#258, measured on `games/court`'s guard flag: a child at `sx = 0` under a `0.53` parent
 *  drew ~2x WIDER than the same child at `sx = 0.907`).
 *
 *  Scaling to zero is the natural idiom for "hidden" / "not yet grown" / "collapsed", and it is
 *  exactly what a keyframe clip keys when something grows from nothing — so this is a supported
 *  authoring value, not a degenerate input to reject.
 *
 *  **What this does instead**, when and only when `determinant() === 0`:
 *   - **scale** comes from the basis COLUMN LENGTHS — the same quantity three uses on its
 *     non-singular path, and the one that stays correct through a zero;
 *   - **rotation** is rebuilt by filling each degenerate column with the cross product of the
 *     survivors, so a mesh flattened on ONE axis (still visible, still needing its orientation)
 *     keeps the pose it was authored with.
 *
 *  **No epsilon.** Only exact singularity takes the second path; `0.001` composes correctly
 *  through three today and must keep composing identically. A threshold here would silently
 *  reinterpret small-but-real scales, which is a worse bug than the one being fixed.
 *
 *  **What is still lost at a zero, inherently** (a TRS triple cannot carry it, so no
 *  implementation could):
 *   - the SIGN of the scale — `det === 0` carries no orientation information at all, so every
 *     axis comes back non-negative. (Three has the same limitation in reverse on its normal
 *     path: it can only park a reflection on X.)
 *   - the rotation ABOUT a surviving axis when two axes are zero — the pose is a line, and its
 *     roll is unconstrained. An arbitrary orthonormal completion is chosen so the result is a
 *     valid quaternion rather than garbage.
 *   - the rotation entirely when the matrix is singular with NO zero-length column — that is a
 *     sheared/coplanar basis, which no orthonormal frame represents, so rotation falls back to
 *     identity as three does. ⚠️ Do NOT read that as "only the rotation is approximate": the
 *     scale MAGNITUDES come back right, but the reconstructed transform's ACTION ON SPACE can be
 *     qualitatively different, not merely imprecise. Measured — columns (1,0,0)/(0,1,0)/(1,1,0)
 *     are coplanar with det 0, and the reconstruction sends local +Z to (0,0,1.414) where the
 *     real matrix sends it to (1,1,0): a full 90° apart, extruded where the original is flat.
 *     No fix inside this format exists, because a TRS triple cannot represent shear AT ALL —
 *     which is exactly why the authoring path REFUSES a collapsed parent (`collapsedParentAxes`)
 *     rather than trusting a number that comes back from here.
 *
 *  PERF: the non-singular path costs one extra `determinant()` (~30 mults) over calling
 *  `decompose` directly. It is paid per composed child per pass, and every caller sits behind
 *  work that already dwarfs it (a 4x4 multiply is 64 mults, and `decompose` computes the same
 *  determinant again internally). `transformPropagationSystem`'s change-detection short-circuit
 *  means a frozen scene pays nothing at all. Delegating to the library on the common path is
 *  worth more than saving that: a hand-rolled copy of three's normal decomposition would be free
 *  to drift from it on the next upgrade, and this file exists precisely because a silent
 *  divergence between what the math says and what the renderer draws is expensive to find.
 *
 *  L0 CORE, beside the two halves of the world-transform contract that need it most
 *  (`transformPropagationSystem` = cached push, `worldTransform` = on-demand pull). */

import * as THREE from 'three';

const _c0 = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();
const _basis = new THREE.Matrix4();

/** Write into `out` a unit vector perpendicular to `v` (which must be unit-length). Crosses `v`
 *  with whichever world axis it is LEAST aligned to, so the cross is never near-degenerate.
 *  Which perpendicular it picks is arbitrary on purpose — the caller only reaches here when the
 *  rotation about `v` is genuinely unconstrained. */
function perpendicularTo(v: THREE.Vector3, out: THREE.Vector3): void {
  const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
  if (ax <= ay && ax <= az) out.set(1, 0, 0);
  else if (ay <= az) out.set(0, 1, 0);
  else out.set(0, 0, 1);
  out.cross(v).normalize();
}

/** Decompose `m` into `position`/`quaternion`/`scale`, staying correct when `m` is singular.
 *  Drop-in for `m.decompose(position, quaternion, scale)` — identical output whenever the matrix
 *  is invertible; see this module's header for what changes when it is not, and for what a TRS
 *  triple cannot represent either way. */
export function decomposeTrs(
  m: THREE.Matrix4,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  scale: THREE.Vector3,
): void {
  // `-0 !== 0` is false, so a negative zero determinant takes the singular path too.
  if (m.determinant() !== 0) {
    m.decompose(position, quaternion, scale);
    return;
  }

  const te = m.elements;
  position.set(te[12], te[13], te[14]);
  _c0.set(te[0], te[1], te[2]);
  _c1.set(te[4], te[5], te[6]);
  _c2.set(te[8], te[9], te[10]);
  const sx = _c0.length(), sy = _c1.length(), sz = _c2.length();
  scale.set(sx, sy, sz);

  const zeros = (sx === 0 ? 1 : 0) + (sy === 0 ? 1 : 0) + (sz === 0 ? 1 : 0);
  if (zeros === 0 || zeros === 3) {
    // 3 zeros: nothing survives to orient by. 0 zeros: singular with every column present means
    // the columns are parallel/coplanar (shear), which no orthonormal basis represents. Scale is
    // already recovered above in both cases — only the rotation is unrecoverable.
    quaternion.identity();
    return;
  }

  if (sx !== 0) _c0.divideScalar(sx);
  if (sy !== 0) _c1.divideScalar(sy);
  if (sz !== 0) _c2.divideScalar(sz);

  // Fill the degenerate columns. Each cross is written in the RIGHT-HANDED cyclic order
  // (x = y×z, y = z×x, z = x×y), so the reconstructed basis is a rotation and never a reflection.
  if (zeros === 2) {
    // One surviving axis; complete it arbitrarily but orthonormally.
    if (sx !== 0) { perpendicularTo(_c0, _c1); _c2.crossVectors(_c0, _c1); }
    else if (sy !== 0) { perpendicularTo(_c1, _c2); _c0.crossVectors(_c1, _c2); }
    else { perpendicularTo(_c2, _c0); _c1.crossVectors(_c2, _c0); }
  } else {
    // Exactly one degenerate axis — the case a flattened-but-visible mesh hits. The two
    // survivors pin the missing one down EXACTLY when they are orthogonal, which is every
    // ordinary rig/parent chain. When they are not (a non-uniformly-scaled ancestor applied to
    // a rotated child, i.e. shear), the reconstruction is approximate — measured ~17° off on a
    // deliberately sheared basis. That is not a defect introduced here: three's own decompose
    // is off by the same amount on the same matrix with a tiny non-zero third axis, so this
    // continues its behaviour across the singularity rather than diverging at it.
    if (sx === 0) _c0.crossVectors(_c1, _c2);
    else if (sy === 0) _c1.crossVectors(_c2, _c0);
    else _c2.crossVectors(_c0, _c1);
  }

  quaternion.setFromRotationMatrix(_basis.makeBasis(_c0, _c1, _c2));
}
