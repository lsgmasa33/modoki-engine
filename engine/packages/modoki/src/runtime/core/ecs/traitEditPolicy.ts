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

/** Why a generic write of `trait.field` to `value` is refused, or null when it is allowed (#1757).
 *
 *  `EntityAttributes.sourceScene` names the scene FILE that saves the entity. Changing it is a scene move, and a
 *  scene move re-stamps the whole subtree, marks both files dirty and refuses to split a prefab instance across two
 *  files (`moveEntityToScene`). A field write did none of that: it stamped one entity, left its children and
 *  instance rows in the old file, and could name a scene that is not loaded, so the entity was saved into no file.
 *  A write of the value the entity already has changes nothing and passes (`current`), so a read → write round
 *  trip still works. The file-direct path passes `current` as the file's own value, which is always '' there:
 *  a scene file never stores a stamp, the loader sets it from which file it read. */
export function fieldWriteRefusal(trait: string, field: string, value: unknown, current: unknown): string | null {
  if (trait !== 'EntityAttributes' || field !== 'sourceScene') return null;
  // Only a STRING equal to the current stamp passes: `null`/`0`/`false` read as '' downstream but would be stored.
  if (typeof value === 'string' && value === ((current as string) || '')) return null;
  return 'EntityAttributes.sourceScene is which scene file saves the entity, and it changes only by a scene move, '
    + 'which carries the whole subtree with it: reparent-entity with moveToScene: true under a parent in that scene '
    + '(or, in the editor, drag the entity onto that scene\'s group in the Hierarchy)';
}
