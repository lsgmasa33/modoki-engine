import { trait } from 'koota';

/** Collider shape. Primitives (`box`/`sphere`/`capsule`/`cylinder`/`cone`) are analytic and
 *  dynamic-safe; `capsule`/`cylinder`/`cone` extend along their LOCAL +Y axis (Rapier convention).
 *  Mesh-derived shapes read the geometry of this entity's `Renderable3D` mesh (baked at the
 *  entity's Transform.scale, mesh-local frame):
 *   - `convex`  — convex hull of the mesh (dynamic-safe; the shape a solid prop should use).
 *   - `trimesh` — the raw triangle mesh (exact, concave, but STATIC only — no interior, so a
 *                 dynamic body gets no solid response; use for level/terrain geometry). */
export type ColliderShape3D = 'box' | 'sphere' | 'capsule' | 'cylinder' | 'cone' | 'convex' | 'trimesh';

/** The *shape/material* half of a 3D physics entity. REQUIRES a `RigidBody3D` on the
 *  same entity OR a rigidbody ancestor (then adopted as a compound collider at its local
 *  Transform offset). A lone `Collider3D` with neither creates no Rapier collider and
 *  fires no events (the physics system warns once); for a static wall/sensor pair it with
 *  `RigidBody3D({ bodyType: 'static' })`.
 *
 *  Dimensions are in WORLD UNITS (same space as Transform), converted to Rapier meters
 *  via `Physics3D.unitsPerMeter` (default 1 → world units already are meters). Collider
 *  dims do NOT scale with Transform.scale (Phase 1) — size the collider directly.
 *
 *  `collisionGroups`/`collisionMask` are 16-bit membership/filter bitmasks: two colliders
 *  interact only if each one's group is in the other's mask. */
export const Collider3D = trait({
  shape: 'box' as ColliderShape3D,
  /** For `convex`/`trimesh` shapes: an optional SEPARATE collision-mesh GUID (a `.mesh.json`,
   *  e.g. a low-poly proxy generated in the editor). Empty ('') = derive the collider from THIS
   *  entity's own `Renderable3D` mesh (the default). Lets a heavy render mesh use a cheaper
   *  collision mesh, or a collision-only entity carry geometry no renderer references. */
  mesh: '' as string,
  /** sphere/capsule/cylinder/cone radius, world units. For a capsule this radius is ALSO
   *  the hemispherical cap radius, which adds to the capsule's total height (see halfHeight). */
  radius: 0.5 as number,
  /** box half-extents on X/Y/Z, world units (cuboid takes half the full size per axis). */
  halfW: 0.5 as number,
  halfH: 0.5 as number,
  halfD: 0.5 as number,
  /** capsule/cylinder/cone segment half-height along local +Y, world units. NOTE the
   *  capsule asymmetry: for a capsule `halfHeight` is the distance between the two cap
   *  centers, EXCLUDING the caps — so a capsule's true vertical half-extent is
   *  `halfHeight + radius`. Cylinder/cone: `halfHeight` is the exact half-extent. */
  halfHeight: 0.5 as number,
  density: 1 as number,
  friction: 0.5 as number,
  restitution: 0 as number,
  /** Sensor/trigger — detects overlap and emits `sensor` events, but applies no
   *  solver response (objects pass through). */
  isSensor: false as boolean,
  /** Named collision layer (project-defined; default 'Default'). Drives membership +
   *  filter from the project's collision matrix. Set empty ('') to author raw
   *  `collisionGroups`/`collisionMask` directly instead. Shared with the 2D matrix. */
  physicsLayer: 'Default' as string,
  /** Raw 16-bit membership/filter bitmasks — used verbatim only when `physicsLayer`
   *  is empty or unknown (advanced escape hatch); otherwise the layer + matrix win. */
  collisionGroups: 0xffff as number,
  collisionMask: 0xffff as number,
});
