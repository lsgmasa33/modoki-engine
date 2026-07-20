import { trait } from 'koota';

/** Marks an entity as part of a prefab instance.
 *  Every entity spawned from a prefab gets this trait. */
export const PrefabInstance = trait({
  /** Path to the source prefab file (e.g. "prefabs/boat.prefab.json") */
  source: '',
  /** Which localId this entity maps to in the prefab (root entity gets rootLocalId) */
  localId: 0,
  /** ECS ID of the root entity of this prefab instance (all children share this) */
  rootInstanceId: 0,
  /** For a NESTED instance: the localId of the nested-prefab row in the immediate
   *  parent prefab that produced this instance (0 for a top-level instance). It
   *  addresses the instance so a scene can store/re-apply per-instance overrides on
   *  a prefab's internal nested instances (e.g. a ship's engine flames). */
  parentLocalId: 0,
});
