import { trait } from 'koota';

/** Declarative `Zone2D` trigger reaction — the no-code path on top of the `Zone2DEvents`
 *  manager, the 2D twin of `OnZone3D`. Put this on the SAME entity as a `Zone2D`: when a
 *  `ZoneOccupant` entity enters or leaves the zone area, the zone-trigger system dispatches
 *  the named UIAction, passing the OTHER (occupant) entity as `ctx.target` and
 *  `{ self, other, phase }` in `ctx.params`.
 *
 *  A zone is a PURE geometric containment test — NO physics colliders or `RigidBody2D` needed.
 *  The dispatch is pipeline-safe (`dispatchGameAction`), so an unwired action name is a warning,
 *  not a crash. Leave a field empty to react to only the other phase. For richer reactions,
 *  subscribe to the `zone2DEvents` manager directly in code. */
export const OnZone2D = trait({
  /** UIAction dispatched when a ZoneOccupant ENTERS this zone. */
  onEnter: '' as string,
  /** UIAction dispatched when a ZoneOccupant EXITS this zone. */
  onExit: '' as string,
});
