import { trait } from 'koota';

/** Declarative collision/sensor reaction — the no-code path (B) on top of the
 *  `Physics2DEvents` manager (C). Put this on the SAME entity as a `Collider2D`
 *  (e.g. a Sensor Zone): when that collider begins/ends overlap with another,
 *  the physics system dispatches the named UIAction, passing the OTHER entity as
 *  `ctx.target` and `{ self, other, phase }` in `ctx.params`.
 *
 *  REQUIRES a `RigidBody2D` on the same entity (or a rigidbody ancestor). A lone
 *  `Collider2D` with no body creates no Rapier collider and fires no events — for a
 *  static sensor zone use a `RigidBody2D({ bodyType: 'static' })`. (The physics system
 *  warns once about such an orphan collider.)
 *
 *  Works for both sensors (`Collider2D.isSensor`) and solid contacts. The dispatch
 *  is pipeline-safe (`dispatchGameAction` — never throws on a missing handler, and
 *  is inert unless the sim is running), so an unwired action name is a warning, not
 *  a frame-aborting crash. Leave a field empty to react only to the other phase.
 *
 *  For richer reactions (arbitrary game state, filtering, cross-entity logic) skip
 *  this trait and subscribe to the `physics2DEvents` manager directly in code. */
export const OnCollision2D = trait({
  /** UIAction dispatched when another collider ENTERS this one (overlap begins). */
  onEnter: '' as string,
  /** UIAction dispatched when another collider EXITS this one (overlap ends). */
  onExit: '' as string,
});
