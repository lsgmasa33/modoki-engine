/** Pure placement math for a `Mask2D`'s clip rect (#449 review round 2, Fix 1).
 *
 *  Split out of `Scene2D.tsx`'s `syncMaskSlots` for one reason: it is the ONE piece of that
 *  function that can be unit-tested without a Pixi/DOM environment, and it shipped WRONG once —
 *  invisibly, because the bug is invisible under uniform scale or zero rotation, which is every
 *  case a normal manual check or a live smoke test happens to exercise.
 *
 *  `transformPropagationSystem` composes a child's world transform as `T · R · S`: a local offset
 *  is first scaled, THEN rotated, THEN translated. Pixi maps a mask Sprite/Graphics's own local
 *  geometry into world space the same way. The broken version computed `S · (R · offset)` —
 *  scaling AFTER rotating — which puts the rect's CENTRE in a different space than its CORNERS.
 *
 *  ⚠️ Measured case that exposed it: mask entity `rz = π/2, sx = 1, sy = 2`, offset `(100, 0)`.
 *  The engine's own child-propagation math lands at world `(0, 100)`. The broken formula gave
 *  `(0, 200)` — double. It only bites when `rz ≠ 0` AND the scale is non-uniform, so it passed
 *  every live check run against it. */
export function maskOffsetWorld(
  offsetX: number, offsetY: number,
  rz: number, sx: number, sy: number,
  compX: number, compY: number,
): { ox: number; oy: number } {
  const cos = Math.cos(rz), sin = Math.sin(rz);
  // Scale FIRST (S · offset) …
  const sxo = offsetX * sx * compX;
  const syo = offsetY * sy * compY;
  // … then rotate (R · (S · offset)), matching transformPropagationSystem's T·R·S.
  return { ox: sxo * cos - syo * sin, oy: sxo * sin + syo * cos };
}
