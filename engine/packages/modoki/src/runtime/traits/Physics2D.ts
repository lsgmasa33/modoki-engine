import { trait } from 'koota';

/** Singleton 2D physics world config (one per scene, like `Time`). If absent, the
 *  physics system falls back to these same defaults, so dropping a `RigidBody2D`
 *  "just works" without authoring a Physics2D entity.
 *
 *  `gravityX`/`gravityY` are a physical acceleration in **m/s²** (NOT world units) —
 *  independent of `pixelsPerMeter` — with +Y pointing DOWN (screen frame). The
 *  system flips Y when handing gravity to Rapier's Y-up world.
 *
 *  `pixelsPerMeter` is the scale between world units and Rapier meters. Default 100
 *  (a 100-unit body = 1 m) keeps bodies in the solver's happy 0.1–10 m range.
 *  Changing it rebuilds nothing mid-run — existing collider sizes are baked at
 *  creation, so change it before Play (Phase 1). */
export const Physics2D = trait({
  gravityX: 0 as number,
  gravityY: 9.81 as number,
  pixelsPerMeter: 100 as number,
});
