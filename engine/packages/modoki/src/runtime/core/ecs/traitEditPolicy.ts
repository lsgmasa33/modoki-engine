/** Which traits the GENERIC trait edits refuse, and why — one list for every path that adds, removes or writes a
 *  trait by name: the Inspector's remove button and Add Component, the editor's add/remove undo helpers, the
 *  agent's live `mutate_scene` and the file-direct `sceneMutate` (setTrait, removeTrait, and the traits of an
 *  addEntity), and the device `liveMutate` (#1454).
 *
 *  - Core traits every entity needs cannot be removed; dropping one corrupts the entity.
 *  - `PrefabInstance` is a prefab LINK, not a component. It is made by instantiating a prefab and cut by Detach
 *    Prefab, which ends the whole instance's frame (`endFrames`, #1453). Removed directly, it left the members
 *    moved out of that instance linked to a frame that no longer existed, so the save wrote them nowhere and they
 *    vanished on reload. Removed from one member, that member's row still expanded on reload beside it. Added or
 *    written by hand, it names a root and a row nothing derived. So no generic path touches it at all. */

const CORE_TRAITS: ReadonlySet<string> = new Set(['Transform', 'EntityAttributes']);

const PREFAB_LINK = 'PrefabInstance';
const LINK_REFUSAL =
  `'${PREFAB_LINK}' is a prefab link, not a component: instantiate a prefab to make one, and use Detach Prefab ` +
  `(Hierarchy → Detach Prefab, or modoki_prefab {action: 'detach'}) to cut it — that unlinks the whole instance, ` +
  'including members moved out of it (#1454)';

/** Why `name` cannot be removed by a generic trait edit, or null when it can. */
export function traitRemoveRefusal(name: string): string | null {
  if (CORE_TRAITS.has(name)) return `cannot remove core trait '${name}'`;
  if (name === PREFAB_LINK) return LINK_REFUSAL;
  return null;
}

/** Why `name` cannot be added, or have its fields written, by a generic trait edit, or null when it can. */
export function traitWriteRefusal(name: string): string | null {
  return name === PREFAB_LINK ? LINK_REFUSAL : null;
}
