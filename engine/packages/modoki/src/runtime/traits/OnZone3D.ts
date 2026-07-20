import { trait } from 'koota';

/** Declarative `Zone3D` trigger reaction — the no-code path on top of the `Zone3DEvents`
 *  manager. Put this on the SAME entity as a `Zone3D`: when a `ZoneOccupant` entity enters
 *  or leaves the zone volume, the zone-trigger system dispatches the named UIAction, passing
 *  the OTHER (occupant) entity as `ctx.target` and `{ self, other, phase }` in `ctx.params`.
 *
 *  A zone is a PURE geometric containment test — NO physics colliders or `RigidBody3D` needed.
 *  It fires for any entity tagged `ZoneOccupant` whose world position is inside the `Zone3D`
 *  volume (position = centre; scale → volume by `Zone3D.shape`). The dispatch is pipeline-safe
 *  (`dispatchGameAction` — never throws on a missing handler, inert unless the sim is running),
 *  so an unwired action name is a warning, not a frame-aborting crash. Leave a field empty to
 *  react to only the other phase.
 *
 *  For richer reactions (arbitrary game state, filtering, cross-entity logic) skip this trait
 *  and subscribe to the `zone3DEvents` manager directly in code. */
export const OnZone3D = trait({
  /** UIAction dispatched when a ZoneOccupant ENTERS this zone. */
  onEnter: '' as string,
  /** UIAction dispatched when a ZoneOccupant EXITS this zone. */
  onExit: '' as string,
});
