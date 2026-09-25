import { trait } from 'koota';

/** Marks an entity as part of a prefab instance.
 *  Every entity spawned from a prefab gets this trait. */
export const PrefabInstance = trait({
  /** Path to the source prefab file (e.g. "prefabs/boat.prefab.json") */
  source: '',
  /** Which localId this entity maps to in the prefab (root entity gets rootLocalId) */
  localId: 0,
  /** The MINTED identity of the prefab row this member expanded from (`PrefabEntity.nodeGuid`, #1468),
   *  in the frame of `source` — not a scene guid, and not unique across two sibling instances of the
   *  same prefab, which expand the same template nodes.
   *
   *  It rides alongside `localId` rather than replacing it: `localId` stays the document's array key
   *  and `EntityAttributes.parentId` wiring. What it adds is that it is never POSITIONAL and never
   *  REUSED — `planPrefabRows` hands a freed localId to a different node on the next save, which
   *  silently REPOINTS a stored key rather than dangling it — the cost `serializePrefab`'s
   *  `preserveLocalIds` docblock spells out. A dangling key can be noticed; a repointed one cannot.
   *
   *  '' means the row carried none — a prefab written before v5, or a live tree that never came from
   *  a prefab. A save mints one; nothing else may, because a reader that minted would hand two
   *  readers of the same file two different identities for one node. */
  nodeGuid: '',
  /** ECS ID of the root entity of this prefab instance (all children share this) */
  rootInstanceId: 0,
  /** For a NESTED instance: the localId of the nested-prefab row in the immediate
   *  parent prefab that produced this instance (0 for a top-level instance). It
   *  addresses the instance so a scene can store/re-apply per-instance overrides on
   *  a prefab's internal nested instances (e.g. a ship's engine flames). */
  parentLocalId: 0,
  /** The MINTED identity of that same nested-prefab row (`parentLocalId`'s twin, #1468) — *which row
   *  of the OUTER document produced me*, in the outer document's frame.
   *
   *  A nested instance root is the one node whose `nodeGuid` answers the wrong question: that field
   *  holds its identity in the CHILD document, because that is the document it expanded from. So a
   *  re-save of the OUTER prefab had nothing to carry and minted a fresh identity for the nested row
   *  every time, dangling every scene key naming anything inside that expansion. `nodeGuidsFor` reads
   *  this field; the three places that stamp `parentLocalId` stamp this beside it.
   *
   *  '' = a top-level instance, a user-ADDED nested instance (no outer row produced it, so there is no
   *  identity to carry and a fresh one is correct), or an outer document written before prefab v5. */
  parentNodeGuid: '',
  /** For an OWNED nested root only: the guid of the frame root whose row expanded it — which instance it
   *  belongs to (#1468 Phase 6). Written when the root is MOVED, because after a move its live parent no
   *  longer says so, and two instances of one prefab inside one outermost instance share every row and
   *  every document. '' = not moved (its live parent's frame is its owner), or not an owned root. Read
   *  through `core/ecs/identityParents.ts`, which checks it against the owner's document before trusting
   *  it. It replaced `homeParent`/`homeSteps`: where a member's template puts it is now READ from the
   *  document, and this is the one fact the document cannot give. */
  ownerGuid: '',
});
