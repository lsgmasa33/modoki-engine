/** The ONE refusal for restructuring a prefab instance (#1869, owner ruling "refuse, like Unity").
 *
 *  Unity: "you cannot reparent a GameObject that is part of a Prefab" (2019.4 Manual, Instance Overrides). The removal
 *  half of that sentence was lifted in 2022.2 (U6); the reparent half never was, and since 2022.3 even a reorder of a
 *  prefab's children is not an override. The editor's dialog says "Cannot restructure Prefab instance", and offers Prefab
 *  Mode or Unpack. So an object the PREFAB supplies does not move and is not reordered:
 *  - a MEMBER (linked to a live root that is not itself), at any depth — a nested prefab's objects included;
 *  - an OWNED nested root (a nested instance a template row expanded), while something owns it or it hangs under an
 *    instance root;
 *  - a template-added KEYED node: an added-GameObject override the prefab itself carries (its key is declared by the
 *    document of an instance root above it) — a plain node, or a template REFERENCE node's root (a nested prefab the
 *    outer prefab added, stored like a scene instance but keyed). A keyed node no ancestor's document declares is the
 *    edited prefab's OWN added node in prefab edit, or a node whose declaring prefab is gone: nobody supplies it, so it
 *    moves.
 *  `supplierOf` names the instance root that supplies each. A member of a root that is not live, and an owned root nothing
 *  owns that hangs under no instance root, link to nothing a save could write them into, so nobody supplies them
 *  (`detachRefusal`'s rule).
 *  Objects the SCENE added (the plus badge), stored instance roots and plain entities move and reorder freely — and take
 *  their subtree with them, which must keep every supplied object inside its instance: its supplier moves along, or the
 *  subtree lands under it (only a file written by the pre-#1869 editor can put one under a scene-added node: a `moved`
 *  entry, #1437, which still loads and saves).
 *
 *  Asked by every route that moves or reorders an existing entity — `reparentEntity` / `planReparent` (the Hierarchy
 *  drag and sort, folder moves, cut → paste, the agent `reparent-entity` and a `parentId` field write),
 *  `moveEntityToScene`, the Hierarchy's sibling drop (`siblingDropRefusal`) and a `sortOrder` field write — before
 *  anything is written, as `detachRefusal` and `prefabEditRefusal` are. A refused gesture pushes no entry. */

import { getAllEntities, findEntity, readTraitData, subtreeIds } from '../../runtime/core/ecs/entityUtils';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { frameDocReader, worldIdentityParents } from '../../runtime/core/ecs/identityParents';
import { templateKeyOf } from '../../runtime/core/templateIdentity';
import { isOwnedRoot, type MemberPi } from '../../runtime/core/assetRefRules';
import { templateKeysOf, type TemplateKeyDoc } from '../../runtime/loaders/templateKeyRecovery';

export const RESTRUCTURE_REFUSAL_TEXT = "Can't restructure a prefab instance: open the prefab to edit it, or unpack it first.";

type Pi = { source?: string; rootInstanceId?: number; parentLocalId?: number };

/** What the gesture does to `id`: move it under `parentId` (0 = the top level), and/or give it a new place among its
 *  siblings (`reorder`). `move`: it moves even when the parent stays — a scene move carries it into another file. */
export interface RestructureGesture { id: number; parentId: number; reorder?: boolean; move?: boolean }

/** `RESTRUCTURE_REFUSAL_TEXT` when the gesture restructures a prefab instance, else null. A move to the parent it already
 *  has with no reorder moves nothing, and is not refused. */
export function restructureRefusal(g: RestructureGesture): string | null {
  const q = query();
  if (!q) return null;
  const reparent = !!g.move || q.parentOf(g.id) !== g.parentId;
  if (!reparent && !g.reorder) return null;
  if (supplierOf(g.id, q)) return RESTRUCTURE_REFUSAL_TEXT;
  if (!reparent) return null;
  // The mover is free; what it carries must stay inside its instance. Each supplied object in the moving subtree keeps its
  // supplier either inside the moving subtree or above where the subtree lands — a scene-added node holding a member a
  // pre-#1869 file moved under it can still move within that instance. A scene move leaves no ancestor behind.
  const moving = new Set(subtreeIds(getAllEntities(), g.id));
  const landsUnder = (root: number) => {
    const seen = new Set<number>();
    for (let cur = g.parentId; cur && !seen.has(cur); cur = q.parentOf(cur)) { if (cur === root) return true; seen.add(cur); }
    return false;
  };
  for (const id of moving) {
    if (id === g.id) continue;
    const frame = supplierOf(id, q);
    if (frame && !moving.has(frame) && (g.move || !landsUnder(frame))) return RESTRUCTURE_REFUSAL_TEXT;
  }
  return null;
}

/** A field write that gives an entity a new `EntityAttributes.sortOrder` is a reorder (the Inspector's input, an agent's
 *  set-traits): refused for any of `ids` the prefab supplies, when `value` changes its place. */
export function reorderWriteRefusal(ids: readonly number[], trait: string, field: string, value: unknown): string | null {
  if (trait !== 'EntityAttributes' || field !== 'sortOrder') return null;
  const ea = getTraitByName('EntityAttributes');
  if (!ea) return null;
  for (const id of ids) {
    const cur = readTraitData(id, ea) as { parentId?: number; sortOrder?: number } | null;
    if (!cur || cur.sortOrder === value) continue;
    const refused = restructureRefusal({ id, parentId: Number(cur.parentId ?? 0), reorder: true });
    if (refused) return refused;
  }
  return null;
}

/** Create Prefab from entity `id`: refused when it is part of a prefab instance but not its outermost root (#1792,
 *  #1869) — Unity's `SaveAsPrefabAsset` throws "Can't save part of a Prefab instance as a Prefab" unless the object is
 *  its own outermost instance root (UnityCsReference `PrefabUtility.cs`, `SaveAsPrefabAssetArgumentCheck`). Making one
 *  of the prefab's own objects the root of a new prefab restructures the instance, and a Revert of the row it left then
 *  respawned it beside the new root on one guid. A stored root, a node the scene added and a plain entity are refused
 *  nothing here. Asked by `createPrefabFromEntity` (the Hierarchy and the Assets drop) and the agent `prefab create`. */
export function partOfInstanceRefusal(id: number): string | null {
  return isSuppliedByPrefab(id) ? PART_OF_INSTANCE_TEXT : null;
}
export const PART_OF_INSTANCE_TEXT = "Can't save part of a prefab instance as a prefab: create it from the instance root, or unpack the instance first.";
/** Create Prefab of a RESOURCE entity (#1873 L2): a world singleton (Physics2D, Input…) is not a node in the authored tree
 *  (#1248), and tagged as an instance, every placed copy of the prefab is a second singleton. One text for the Hierarchy's
 *  greyed item, `createPrefabFromEntity` and the agent `prefab create` (which is that function). */
export const RESOURCE_PREFAB_TEXT = "A resource entity is a world singleton, so it can't be saved as a prefab: every instance of it would be a second copy of that singleton.";

/** Whether the prefab supplies entity `id` (see the module doc). */
export function isSuppliedByPrefab(id: number): boolean {
  return suppliedByPrefabChecker()(id);
}

/** {@link isSuppliedByPrefab} for a batch asked against ONE unchanged world (the Hierarchy's renumber, per sibling; the
 *  fuzzer's draw filter): the identity parents an owned root's owner needs are built once for the batch, not per call —
 *  a build is a whole-world walk, and per sibling it cost 440x on a 60-sibling drop in a 7k-entity scene (close-out
 *  re-review). Not kept across batches: some writes change the resolver's input without moving the structure version
 *  (`worldIdentityParents`' scope notes them), so a longer-lived answer could go stale. */
export function suppliedByPrefabChecker(): (id: number) => boolean {
  const q = query();
  return (id) => !!q && supplierOf(id, q) !== 0;
}

/** The OUTERMOST instance root above `id`, or `id` itself when it is one: up the suppliers (a member's root, an owned
 *  root's owner, the root that declares a keyed node) until an instance root the prefab does not supply — a top-level
 *  instance, or one the scene added inside another. 0 when none can be told. `detachRefusal` names it. */
export function outermostPrefabRoot(id: number): number {
  const q = query();
  if (!q) return 0;
  const seen = new Set<number>();
  for (let cur = id; cur && !seen.has(cur);) {
    seen.add(cur);
    const next = supplierOf(cur, q);
    if (!next) return q.piOf(cur)?.rootInstanceId === cur ? cur : 0;
    cur = next;
  }
  return 0;
}

interface Query {
  piOf(id: number): Pi | null;
  parentOf(id: number): number;
  /** Built on first need: only an owned root's owner asks it. */
  identity(): ReturnType<typeof worldIdentityParents>;
  /** The frame documents, built on first need (a keyed node's declarer): its first lookup walks the world too. */
  readDoc(): ReturnType<typeof frameDocReader>;
}
function query(): Query | null {
  const ea = getTraitByName('EntityAttributes');
  const pi = getTraitByName('PrefabInstance');
  if (!ea || !pi) return null;
  let identity: ReturnType<typeof worldIdentityParents> | undefined;
  let readDoc: ReturnType<typeof frameDocReader> | undefined;
  return {
    piOf: (id) => readTraitData(id, pi) as Pi | null,
    parentOf: (id) => Number((readTraitData(id, ea) as { parentId?: number } | null)?.parentId ?? 0),
    identity: () => (identity ??= worldIdentityParents(getCurrentWorld())),
    readDoc: () => (readDoc ??= frameDocReader(getCurrentWorld())),
  };
}

/** The instance root that SUPPLIES entity `id`, or 0 when no prefab does:
 *  - a member: its root, while that root is live — one that is not links to nothing a save could write it into
 *    (`detachRefusal`'s rule);
 *  - an owned nested root: its owner (identity, `ownerOf`), else the nearest instance root it hangs under; with neither,
 *    it links to nothing either, and nobody supplies it;
 *  - a KEYED node, a plain one or a template reference node's stored root: the nearest instance root above it whose
 *    document declares its key. A keyed node none declares is the edited prefab's own added node in prefab edit, or one
 *    whose declaring prefab is gone. */
function supplierOf(id: number, q: Query): number {
  const p = q.piOf(id);
  const root = p?.rootInstanceId ?? 0;
  if (root && root !== id) return findEntity(root) ? root : 0;
  if (root === id && isOwnedRoot(p as MemberPi, id)) return q.identity().ownerOf(id) || nearestRootAbove(id, q);
  const key = templateKeyOf(findEntity(id));
  return key ? keyDeclarer(id, key, q) : 0;
}

function nearestRootAbove(id: number, q: Query): number {
  const seen = new Set<number>([id]);
  for (let cur = q.parentOf(id); cur && !seen.has(cur); cur = q.parentOf(cur)) {
    seen.add(cur);
    if (q.piOf(cur)?.rootInstanceId === cur) return cur;
  }
  return 0;
}

/** The instance root on `id`'s live parent chain expanded from a document declaring `key`, or 0. The document is the
 *  one the world recorded that frame as expanded from (`frameDocReader`), which a trashed prefab keeps (#1834). */
function keyDeclarer(id: number, key: string, q: Query): number {
  const readDoc = q.readDoc();
  const seen = new Set<number>([id]);
  for (let cur = q.parentOf(id); cur && !seen.has(cur); cur = q.parentOf(cur)) {
    seen.add(cur);
    const p = q.piOf(cur);
    if (!p?.source || p.rootInstanceId !== cur) continue;
    const doc = readDoc(p.source, cur);
    if (doc && templateKeysOf(doc as TemplateKeyDoc).includes(key)) return cur;
  }
  return 0;
}
