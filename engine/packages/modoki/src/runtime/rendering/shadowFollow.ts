/** Pure math for recentring a directional light's shadow ortho box on the view each frame.
 *  Kept free of THREE so the anti-shimmer snap (the whole reason this exists as its own module)
 *  is unit-testable without a renderer.
 *
 *  Why recentre at all: a directional shadow camera anchored at the light's authored position
 *  covers a FIXED patch of ground. Measured in demos/forest-camp: the Sun at (5,10,4) with
 *  shadowCameraSize 16 puts the box's footprint around (7.8, 12.5) while the player walks near
 *  (5.6, -0.5) — the player sits at -0.873 in shadow-camera NDC while standing still, and 9m of
 *  walking north puts it outside the box entirely (shadow vanishes). Recentring on the view each
 *  frame keeps the box under the subject instead of wherever the light happened to be authored.
 *
 *  Why the snap: naively recentring on the raw camera-forward point makes the shadow's edge crawl
 *  every frame — each sub-texel shift of the ortho box re-rasterizes the depth map slightly
 *  differently, so a static shadow edge visibly shimmers as the camera moves. Snapping the centre
 *  to whole shadow-texel increments IN THE LIGHT'S OWN view basis (not world axes) makes every
 *  snapped centre land on the same texel grid the depth map already sampled, so the shadow only
 *  moves in whole-texel jumps — imperceptible at shadow-map resolution.
 */

type Vec3 = { x: number; y: number; z: number };

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Snap a shadow-box centre to whole shadow-texel increments in the light's own view basis. */
export function snapShadowCenter(opts: {
  focus: Vec3;      // the point the box should centre on
  lightDir: Vec3;    // light -> target, need not be normalized
  size: number;      // shadowCameraSize (ortho half-extent)
  mapSize: number;   // shadow map resolution in px
}): Vec3 {
  const { focus, lightDir, size, mapSize } = opts;

  // A degenerate size or map can't define a texel grid — return the raw focus unsnapped
  // rather than divide by zero.
  if (size <= 0 || mapSize <= 0) return focus;

  const forward = normalize(lightDir);
  // This basis MUST match the one THREE rasterizes the shadow map in, or the snap lands on a
  // different grid than the depth map uses and prevents nothing. THREE builds it in
  // `Matrix4.lookAt` as `x = normalize(up × z)` with `z = eye - target = -forward`, which is
  // exactly `normalize(forward × up)` — so the ordinary path agrees by construction.
  //
  // The degenerate swap has to agree too, and it is the easy thing to get wrong: THREE only
  // branches on `_x.lengthSq() === 0`, an EXACT zero. Testing `|forward.y| > 0.99` instead
  // fires across an ~8° band around the zenith where THREE has NOT swapped, putting the two
  // bases in genuinely different planes (not merely flipped) — the snap silently stops working
  // for a near-noon sun, and worse, a light animated across the threshold makes the box jump
  // discontinuously, which is a louder artifact than the shimmer this exists to prevent. So
  // branch on the same quantity THREE does: the cross product actually being degenerate.
  const worldUp: Vec3 = { x: 0, y: 1, z: 0 };
  const rightRaw = cross(forward, worldUp);
  const degenerate = rightRaw.x * rightRaw.x + rightRaw.y * rightRaw.y + rightRaw.z * rightRaw.z < 1e-12;
  const right = normalize(degenerate ? cross(forward, { x: 0, y: 0, z: 1 }) : rightRaw);
  const trueUp = cross(right, forward);

  const texel = (2 * size) / mapSize;
  const rightComp = dot(focus, right);
  const upComp = dot(focus, trueUp);
  const fwdComp = dot(focus, forward);
  const snappedRight = Math.round(rightComp / texel) * texel;
  const snappedUp = Math.round(upComp / texel) * texel;

  // Rebuild the point from the snapped in-plane components plus the untouched depth
  // component — depth along the light axis doesn't affect which texel a sample lands in.
  return {
    x: right.x * snappedRight + trueUp.x * snappedUp + forward.x * fwdComp,
    y: right.y * snappedRight + trueUp.y * snappedUp + forward.y * fwdComp,
    z: right.z * snappedRight + trueUp.z * snappedUp + forward.z * fwdComp,
  };
}

/** Where the runtime camera is looking, as a ground point — the closest honest stand-in for a
 *  look-at, since the engine has no camera look-at/target concept (a camera is just a Transform;
 *  a follow target like forest-camp's lives in game code the renderer cannot see). */
export function viewGroundFocus(opts: {
  camPos: Vec3;
  camForward: Vec3;  // need not be normalized
  groundY: number;
  maxDistance: number;
}): Vec3 {
  const { camPos, camForward, groundY, maxDistance } = opts;
  const fwd = normalize(camForward);

  // Ray-plane intersection: camPos.y + t*fwd.y = groundY  =>  t = (groundY - camPos.y) / fwd.y.
  // A camera level with (or looking away from) the ground plane makes fwd.y near zero or gives
  // a negative t — neither is a usable ground hit, so fall back to a bounded forward point
  // rather than putting the box at infinity (or behind the camera).
  if (Math.abs(fwd.y) > 1e-6) {
    const t = (groundY - camPos.y) / fwd.y;
    if (t > 0) {
      const clamped = Math.min(t, maxDistance);
      return {
        x: camPos.x + fwd.x * clamped,
        y: camPos.y + fwd.y * clamped,
        z: camPos.z + fwd.z * clamped,
      };
    }
  }

  return {
    x: camPos.x + fwd.x * maxDistance,
    y: camPos.y + fwd.y * maxDistance,
    z: camPos.z + fwd.z * maxDistance,
  };
}
