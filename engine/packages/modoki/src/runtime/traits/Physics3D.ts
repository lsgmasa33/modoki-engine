import { trait } from 'koota';

/** Singleton 3D physics world config (one per scene, like `Time`). If absent, the
 *  physics system falls back to these same defaults, so dropping a `RigidBody3D`
 *  "just works" without authoring a Physics3D entity.
 *
 *  `gravityX/Y/Z` are a physical acceleration in **m/s²** (NOT world units) —
 *  independent of `unitsPerMeter` — in the Three.js frame (+Y up). Unlike the 2D
 *  world there is NO axis flip: "down" is negative Y, so the default is (0, -9.81, 0),
 *  handed straight to Rapier's Y-up world.
 *
 *  `unitsPerMeter` is the scale between world units and Rapier meters. Default 1 (3D
 *  world units already are meters, keeping bodies in the solver's happy 0.1–10 m range).
 *  Existing collider sizes are baked at creation, so change it before Play (Phase 1). */
export const Physics3D = trait({
  gravityX: 0 as number,
  gravityY: -9.81 as number,
  gravityZ: 0 as number,
  unitsPerMeter: 1 as number,
});
