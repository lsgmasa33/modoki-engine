/** cameraFraming — pure camera-fit math for the CameraFrame trait.
 *
 *  Given an oriented framing box (8 world corners) and a camera basis, compute
 *  where to put the camera so the box fits the viewport for a chosen mode +
 *  margins. Renderer-agnostic and side-effect-free so it can be unit-tested
 *  headlessly; Scene3D feeds it the live camera basis + aspect and applies the
 *  result to the Three cameras.
 *
 *  Key geometric fact that makes this cheap: translating a camera ALONG its own
 *  forward axis changes only the depth (forward) coordinate of a point in view
 *  space, never its lateral (right/up) coordinates. So the lateral extents are
 *  distance-independent, and the perspective fit distance has a closed form —
 *  no iterative dolly/binary-search needed. Lateral RECENTER (honoring
 *  asymmetric margins) is a second translation along right/up.
 */

import * as THREE from 'three';

export type FrameMode = 'contain' | 'fitWidth' | 'fitHeight';
export type FrameAnchorV = 'off' | 'bottom' | 'center' | 'top';
export type FrameAnchorH = 'off' | 'left' | 'center' | 'right';

export interface FrameMargins {
  /** Viewport-fraction padding per edge (0..~0.45). Asymmetric margins shift the
   *  framed content (e.g. bump `top` to reserve space for a HUD) — only honored
   *  when `autoAim` recenters; otherwise they shrink the fit symmetrically. */
  top: number; bottom: number; left: number; right: number;
}

export interface FrameFitInput {
  /** 8 world-space corners of the (possibly Y-rotated) framing box. */
  corners: THREE.Vector3[];
  /** Box center in world space. */
  center: THREE.Vector3;
  /** Orthonormal camera basis (unit vectors). `forward` = look direction. */
  right: THREE.Vector3; up: THREE.Vector3; forward: THREE.Vector3;
  /** Vertical field of view in RADIANS (perspective only). */
  fovV: number;
  /** Viewport aspect = width / height. */
  aspect: number;
  mode: FrameMode;
  margins: FrameMargins;
  /** true → orthographic (returns orthoSize); false → perspective (returns distance). */
  ortho: boolean;
  /** true → camera owns lateral position, recentering the box into the margined
   *  sub-rect. false → keep the authored lateral position; dolly for size only. */
  autoAim: boolean;
  /** Authored camera world position — used to preserve lateral offset when
   *  `autoAim` is false. */
  authoredPos: THREE.Vector3;
  /** Camera near plane — the box is kept at least this far in front. */
  near: number;
  /** Vertical edge anchor: pin a chosen box edge/center to `anchorPosV` of the viewport,
   *  overriding the mode/margin vertical centering. 'off' = today's behavior. */
  anchorV: FrameAnchorV;
  /** Viewport fraction (0 bottom, 1 top) where the anchored edge lands. */
  anchorPosV: number;
  /** Horizontal edge anchor: left/right twin of `anchorV` (overrides horizontal centering). */
  anchorH: FrameAnchorH;
  /** Viewport fraction (0 left, 1 right) where the horizontal anchored edge lands. */
  anchorPosH: number;
}

export interface FrameFitResult {
  /** Final camera world position to apply. */
  position: THREE.Vector3;
  /** Orthographic half-height (only meaningful when `ortho` is true). */
  orthoSize: number;
}

const _o = new THREE.Vector3();

/** Compute the camera fit for a framing box. Pure — allocates a fresh result. */
export function computeFrameFit(input: FrameFitInput): FrameFitResult {
  const { corners, center, right, up, forward, fovV, aspect, mode, margins, ortho, autoAim, authoredPos, near, anchorV, anchorPosV, anchorH, anchorPosH } = input;

  // Usable viewport fraction per axis after margins (clamped to a sane floor so a
  // pathological margin can't divide by ~0 and fling the camera to infinity).
  const fracV = Math.max(0.05, 1 - margins.top - margins.bottom);
  const fracH = Math.max(0.05, 1 - margins.left - margins.right);

  const tanV = Math.tan(fovV / 2);
  const tanH = tanV * aspect;

  // Lateral camera offset from the box center along right/up. autoAim recenters
  // the camera on the box (offset 0); otherwise the camera keeps its AUTHORED
  // lateral position, and the fit MUST measure each corner's extent from the
  // camera's optical axis (xv−offR, yv−offU), not the box center. Omitting this
  // under-fits (clips the box) whenever the authored camera isn't aimed exactly
  // through the box center.
  _o.copy(authoredPos).sub(center);
  const offR = autoAim ? 0 : _o.dot(right);
  const offU = autoAim ? 0 : _o.dot(up);

  // View-space extents relative to the CAMERA AXIS (distance-independent).
  //   xv = lateral-right, yv = lateral-up, zv = forward (toward look dir).
  // For ortho, size keys off the max lateral extents (depth-independent). For
  // perspective, the fit distance is PER-CORNER (a near corner with a large
  // lateral extent binds harder than a far one) so we accumulate the required
  // distance corner-by-corner rather than pairing max|lateral| with one depth.
  let maxAbsX = 0, maxAbsY = 0;
  let minZ = Infinity;
  let needDistH = -Infinity, needDistW = -Infinity;
  for (const c of corners) {
    _o.copy(c).sub(center);
    const xv = _o.dot(right) - offR;
    const yv = _o.dot(up) - offU;
    const zv = _o.dot(forward);
    const ax = Math.abs(xv), ay = Math.abs(yv);
    if (ax > maxAbsX) maxAbsX = ax;
    if (ay > maxAbsY) maxAbsY = ay;
    if (zv < minZ) minZ = zv;
    // Per-corner perspective distance: at distance D the frustum half-height at
    // this corner's depth (D + zv) is (D + zv)·tanV; the corner must sit within
    // fracV of it → |yv| ≤ fracV·tanV·(D + zv) → D ≥ |yv|/(fracV·tanV) − zv.
    const dH = ay / (fracV * tanV) - zv;
    const dW = ax / (fracH * tanH) - zv;
    if (dH > needDistH) needDistH = dH;
    if (dW > needDistW) needDistW = dW;
  }

  let orthoSize = 0;
  let distance = 0;

  if (ortho) {
    // Orthographic: size is set by half-height; depth doesn't affect size.
    // NDC_y = yv / orthoSize ; must fit within fracV → orthoSize ≥ |yv|/fracV.
    // NDC_x = xv / (orthoSize·aspect) ; → orthoSize ≥ |xv|/(fracH·aspect).
    const needH = maxAbsY / fracV;                // vertical constraint
    const needW = maxAbsX / (fracH * aspect);     // horizontal constraint
    if (mode === 'fitHeight') orthoSize = needH;
    else if (mode === 'fitWidth') orthoSize = needW;
    else orthoSize = Math.max(needH, needW);      // contain
    orthoSize = Math.max(orthoSize, 1e-4);
    // Pull the camera back far enough that the whole box is in front of `near`.
    // Depth from camera to a corner = distance + zv; nearest corner ≥ near.
    distance = near - minZ + 0.01;
  } else {
    if (mode === 'fitHeight') distance = needDistH;
    else if (mode === 'fitWidth') distance = needDistW;
    else distance = Math.max(needDistH, needDistW); // contain
    // Ensure the nearest corner clears the near plane.
    distance = Math.max(distance, near - minZ + 0.01);
  }

  // ── Camera position ────────────────────────────────────────────────
  // Split into a lateral (right) and vertical (up) offset from the box center, so the
  // vertical edge-anchor can OVERRIDE just the up component while the horizontal keeps
  // autoAim/authored behavior. Base sits back along -forward by `distance`.
  let rightOff: number, upOff: number;
  if (autoAim) {
    // Recenter the box into the margined sub-rect (NDC up = +y). A bigger `top` margin
    // pushes content DOWN (negative NDC y); bigger `left` pushes it RIGHT (+x).
    const cx = margins.left - margins.right;
    const cy = margins.bottom - margins.top;
    // World units per NDC at the box-center depth. Ortho: constant. Perspective:
    // scales with depth (= distance, since center zv≈0 baseline).
    const halfW = ortho ? orthoSize * aspect : distance * tanH;
    const halfH = ortho ? orthoSize : distance * tanV;
    // Moving the camera +right by s shifts content -x in NDC → to push content to
    // +cx, move the camera by -cx·halfW along right (and likewise up).
    rightOff = -cx * halfW;
    upOff = -cy * halfH;
  } else {
    // Preserve the authored lateral position (offR/offU computed above).
    rightOff = offR;
    upOff = offU;
  }

  // Vertical edge-anchor: pin the chosen box edge (or its center) to `anchorPosV` of the
  // viewport, overriding upOff. Camera pos = center − forward·distance + up·U + right·R,
  // so a corner's NDC_y = (yv − U)/(depth·tanV) (ortho: /orthoSize). To pin a corner at
  // targetNDC, U = yv − targetNDC·depth·tanV. For the BOTTOM edge we take the smallest
  // such U over all corners (that corner lands on the line; every other ends up ABOVE it);
  // for TOP, the largest. 'center' pins the box's geometric center (yv=0, depth=distance).
  if (anchorV && anchorV !== 'off') {
    const targetNDC = (anchorPosV ?? 0.5) * 2 - 1; // 0..1 → −1 (bottom) .. +1 (top)
    if (anchorV === 'center') {
      upOff = ortho ? -targetNDC * orthoSize : -targetNDC * distance * tanV;
    } else {
      let ext = anchorV === 'bottom' ? Infinity : -Infinity;
      for (const c of corners) {
        _o.copy(c).sub(center);
        const yv = _o.dot(up);
        const u = ortho
          ? yv - targetNDC * orthoSize
          : yv - targetNDC * (_o.dot(forward) + distance) * tanV;
        if (anchorV === 'bottom') { if (u < ext) ext = u; }
        else if (u > ext) ext = u;
      }
      upOff = ext;
    }
  }

  // Horizontal edge-anchor — the left/right mirror of the vertical block, overriding
  // rightOff. NDC_x = (xv − R)/(depth·tanH) (ortho: /(orthoSize·aspect)).
  if (anchorH && anchorH !== 'off') {
    const targetNDC = (anchorPosH ?? 0.5) * 2 - 1; // 0..1 → −1 (left) .. +1 (right)
    if (anchorH === 'center') {
      rightOff = ortho ? -targetNDC * orthoSize * aspect : -targetNDC * distance * tanH;
    } else {
      let ext = anchorH === 'left' ? Infinity : -Infinity;
      for (const c of corners) {
        _o.copy(c).sub(center);
        const xv = _o.dot(right);
        const r = ortho
          ? xv - targetNDC * orthoSize * aspect
          : xv - targetNDC * (_o.dot(forward) + distance) * tanH;
        if (anchorH === 'left') { if (r < ext) ext = r; }
        else if (r > ext) ext = r;
      }
      rightOff = ext;
    }
  }

  const position = new THREE.Vector3().copy(center)
    .addScaledVector(forward, -distance)
    .addScaledVector(right, rightOff)
    .addScaledVector(up, upOff);

  return { position, orthoSize };
}

/** Easing for a camera-frame blend. Pure; t clamped to [0,1]. Unknown name →
 *  linear. Keep the names in sync with the CameraFrame.blendEase enum. */
export function ease(name: string, t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  switch (name) {
    case 'quadIn': return x * x;
    case 'quadOut': return 1 - (1 - x) * (1 - x);
    case 'quadInOut': return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case 'cubicInOut': return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    default: return x; // 'linear'
  }
}

/** Build the 8 world corners + center of a unit box (±0.5) transformed by a world
 *  matrix (position · Y-rotation · scale). The CameraFrame box entity's Transform
 *  scale IS the box size, matching a `Renderable3DPrimitive` box of size 1. */
export function boxCornersFromMatrix(m: THREE.Matrix4): { center: THREE.Vector3; corners: THREE.Vector3[] } {
  const corners: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    corners.push(new THREE.Vector3(
      i & 1 ? 0.5 : -0.5,
      i & 2 ? 0.5 : -0.5,
      i & 4 ? 0.5 : -0.5,
    ).applyMatrix4(m));
  }
  const center = new THREE.Vector3().setFromMatrixPosition(m);
  return { center, corners };
}
