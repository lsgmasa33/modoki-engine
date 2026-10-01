/** What becomes of a recorded statement about a component, decided by the trait registry alone (#1938 C-B, step 1).
 *
 *  The pure schema half of "is this record used?": is the component registered, is the field one it persists, is it a
 *  tag. Every site that answers one of these asks here, so the spawner, the fold's unused notes, the load's kept records
 *  and every template-vs-live diff cannot drift apart. (Whether a record's TARGET exists is the expansion's question, not
 *  this module's.)
 *
 *  The rule that carries the weight, Unity's "Missing (Mono Script)": a component this build has no trait for is not
 *  spawned, so its ABSENCE from a live member says nothing about what the instance states. A diff that read it as a
 *  removal wrote `removedTraits` for every unregistered component on every save, and Apply / Apply All deleted the
 *  component's data from the prefab asset (#1933 N1). And a removal the file DOES state of such a component cannot be
 *  restated by a capture that never sees the component, so it is kept as an unused record and written back. */

import { getTraitByName, type TraitMeta } from '../core/ecs/traitRegistry';
import { isPersistentTraitField } from '../core/ecs/traitSchema';

/** `unknown`: no trait of that name is registered in this build — renamed or deleted in code, or game code that has not
 *  loaded. Its data is kept wherever it is recorded, and it is never added, removed or diffed. */
export type ComponentFate = 'registered' | 'unknown';

export function componentFate(name: string): ComponentFate {
  return getTraitByName(name) ? 'registered' : 'unknown';
}

/** Whether a live member's lacking `name` can mean the instance removed it: only for a component this build spawns. */
export function absenceIsRemoval(name: string): boolean {
  return componentFate(name) === 'registered';
}

/** `applies`: the trait persists the field. `unknownField`: it does not (renamed or stale). `onTag`: a tag persists no
 *  field, so a field recorded on one (a component that became a tag) is unused data (#1933 L2), not nothing. */
export type FieldFate = 'applies' | 'unknownField' | 'onTag';

export function fieldFate(meta: Pick<TraitMeta, 'trait' | 'category'>, field: string): FieldFate {
  if (meta.category === 'tag') return 'onTag';
  return isPersistentTraitField(meta, field) ? 'applies' : 'unknownField';
}

/** A recorded removal (or its restore) of component `name`, where `takes` is whether the base the statement lands on
 *  gives it something to act on. Unused when the base does not, and always for a component this build does not register:
 *  the capture never sees that component, so only the kept record carries the statement to the next save. */
export function removalFate(takes: boolean, name: string): 'used' | 'unused' {
  return takes && componentFate(name) === 'registered' ? 'used' : 'unused';
}
