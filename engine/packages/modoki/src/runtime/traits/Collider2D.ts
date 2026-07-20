import { trait } from 'koota';

/** Collider shape. `circle`/`box`/`capsule` are primitives; `polygon` is the convex
 *  hull of `points` (valid on any body); `polyline` is a static OPEN edge chain built from
 *  `points` (concave terrain/walls — no interior mass, so use on static bodies);
 *  `concave` decomposes `points` into convex pieces (poly-decomp) → a compound of
 *  convex-hull colliders, so a DYNAMIC body can have a genuine concave solid shape. */
export type ColliderShape2D = 'circle' | 'box' | 'capsule' | 'polygon' | 'polyline' | 'concave';

/** The *shape/material* half of a 2D physics entity. REQUIRES a `RigidBody2D` on the same
 *  entity OR a rigidbody ancestor (then adopted as a compound collider). A lone `Collider2D`
 *  with neither creates no Rapier collider and fires no events (the physics system warns
 *  once); for a static wall/sensor pair it with `RigidBody2D({ bodyType: 'static' })`.
 *  Dimensions are in WORLD UNITS (same space as Transform/Renderable2D), converted
 *  to Rapier meters via `Physics2D.pixelsPerMeter`. Collider dims do NOT currently
 *  scale with Transform.scale (Phase 1) — size the collider directly.
 *
 *  `collisionGroups`/`collisionMask` are 16-bit membership/filter bitmasks: two
 *  colliders interact only if each one's group is in the other's mask. */
export const Collider2D = trait({
  shape: 'box' as ColliderShape2D,
  /** circle/capsule radius, world units. For a capsule this radius is ALSO the
   *  hemispherical cap radius, which adds to the capsule's total height (see halfH). */
  radius: 50 as number,
  /** box half-extents, world units. NOTE the capsule asymmetry: for a box, halfH is
   *  the exact vertical half-extent; for a CAPSULE, halfH is the segment half-height
   *  (distance between the two cap centers), EXCLUDING the caps — so a capsule's true
   *  vertical half-extent is `halfH + radius`. To match a sprite of pixel-half-height
   *  H, use `halfH = H - radius`. */
  halfW: 50 as number,
  halfH: 50 as number,
  /** polygon/polyline point list — inline JSON in WORLD UNITS: `[[x,y],…]` or flat
   *  `[x,y,x,y,…]`. polygon/concave need >=3 points; polyline needs >=2 (open edge chain). */
  points: '' as string,
  density: 1 as number,
  friction: 0.5 as number,
  restitution: 0 as number,
  /** Sensor/trigger — detects overlap and emits `sensor` events, but applies no
   *  solver response (objects pass through). */
  isSensor: false as boolean,
  /** Named collision layer (project-defined; default 'Default'). Drives membership +
   *  filter from the project's collision matrix. Set empty ('') to author raw
   *  `collisionGroups`/`collisionMask` directly instead. See `physicsLayers.ts`. */
  physicsLayer: 'Default' as string,
  /** Raw 16-bit membership/filter bitmasks — used verbatim only when `physicsLayer`
   *  is empty or unknown (advanced escape hatch); otherwise the layer + matrix win. */
  collisionGroups: 0xffff as number,
  collisionMask: 0xffff as number,
});
