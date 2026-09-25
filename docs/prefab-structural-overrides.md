# Prefab Structural Overrides (design)

**Status:** implemented (capture + round-trip + recursive Apply dialog), including
**reference-style added nodes** — a user-added *nested prefab instance* round-trips
under its exact parent member (see [Nested-instance additions](#nested-instance-additions-reference-nodes)).
Tests: `tests/editor/captureInstanceStructure.test.ts`,
`tests/editor/applyStructureRoundTrip.test.ts`,
`tests/editor/userDraggedNestedSerialize.test.ts`,
`tests/runtime/userAddedNestedExpand.test.ts`.
**Goal:** let an instance diverge **structurally** from its prefab source — add
and remove child entities (including whole nested prefab instances), and remove
components (traits) — have those changes survive save/reload, surface them
**recursively** in the *Apply to Prefab* dialog, and push them back into the
`.prefab.json` on apply.

See also: [Prefabs](./prefabs.md) · [Scene Loading](./scene-loading.md) · [Visual Editor](./editor.md)

## Scope — the four structural cases

| | Add | Remove |
|---|---|---|
| **Child entity** | **new** — `added` list | **new** — `removed` list |
| **Component (trait)** | already works — captured as an *added-trait override* in `overrides` (`getOverrideValues` in `prefab.ts`) | **new** — `removedTraits` map |

Adding a component to an instance already round-trips (whole-trait override) and
already appears in the Apply dialog as that trait's fields. The three **new**
cases — added entity, removed entity, removed component — are what this design
adds. They share one capture pass and one apply pass.

## Problem

The override system today is **value-only**. It records, per prefab `localId`,
which trait *fields* differ from the source (`captureInstanceOverrides` →
`Record<localId, Record<trait, Record<field, value>>>`). It has no concept of an
entity that the prefab doesn't contain, or a prefab entity the instance deleted.

Concretely, when you add a child to an instance and hit **Apply to Prefab**,
nothing happens, because the new child falls through every stage:

| Stage | File / fn | Why the added child is invisible |
|---|---|---|
| Capture | `prefab.ts` `captureInstanceOverrides` | Walks members by `PrefabInstance.rootInstanceId`. A freshly-created child has **no `PrefabInstance` trait** (`createEntityWithUndo` spawns only `EntityAttributes`+`Transform`), so it's never visited. |
| Diff | `prefab.ts` `getOverrideValues` | `prefab.entities.find(e => e.localId === id)` is `undefined` for a localId the prefab lacks → returns `{}`. |
| Dialog | `ApplyPrefabDialog.tsx` | Renders only entities from that same member walk (and skips tags). Nothing to check off. |
| Apply | `prefab.ts` `applyToPrefabSelective` | Overlays values onto `newPrefab.entities.find(...)`; it can't **insert** an entity. |

There is also a **silent round-trip bug** independent of *Apply*: an added child
*is* serialized today (it isn't in `prefabChildIds` since it has no
`PrefabInstance` trait — `serialize.ts`'s `serializeScene`), but with `EntityAttributes.parentId`
set to the **save-time ECS id** of a prefab member. On reload the prefab
re-instantiates with **fresh** ECS ids, so that `parentId` dangles and the child
orphans (floats to root or vanishes). So added children don't survive a reload
even before *Apply* enters the picture. **This design fixes that too** — it is
the foundation the *Apply* path builds on.

## Approach: detect structure, don't tag

Two ways to recognize an added child:

- **(A) Tag on creation** — stamp a `PrefabInstance` on every entity dropped
  under an instance. Rejected: it requires hooking *every* path that can parent
  an entity into an instance (create, duplicate, paste, drag-reparent) and
  inventing a non-colliding `localId` for entities the prefab's BFS scheme never
  assigned.
- **(B) Detect at capture time** — *chosen*. Don't tag anything. At capture,
  walk the **`EntityAttributes.parentId` subtree** under the instance root and
  classify each entity:
  - has `PrefabInstance` with this `rootInstanceId` → an existing **member**
    (current value-diff path), keyed by its `localId`;
  - otherwise → an **added** entity (captured whole).

  The instance "boundary" is the subtree rooted at the instance root. A nested
  *different* prefab instance dropped inside (its own `rootInstanceId`) is a
  special added case — see [Edge cases](#edge-cases).

(B) keeps all instance-creation code untouched and localizes the new logic to
capture / serialize / load / dialog.

**Removals** are the complement: the set of prefab `localId`s **not present**
among the instance's live members. Computed by diffing `prefab.entities`'
localIds against the localIds the member walk actually found.

## Data model

`PrefabFile` / `PrefabEntity` are **unchanged**. The new state lives only on the
instance, in two new sibling fields on `SerializedEntity` (next to the existing
`overrides`), so old scenes load unchanged and the value-diff path is untouched:

```ts
interface SerializedEntity {
  // ...existing...
  overrides?: Record<number, Record<string, Record<string, unknown>>>; // value diffs + added-trait (unchanged)
  added?:   AddedEntity[];           // NEW — subtrees the instance adds
  removed?: number[];                // NEW — prefab localIds the instance deletes
  removedTraits?: Record<number, string[]>; // NEW — localId → trait names the instance deleted
}

/** A subtree the instance adds, anchored to an existing parent. Nested adds are
 *  expressed by `children`, so parentId is implicit in the tree shape. */
interface AddedEntity {
  /** Anchor: the prefab localId this subtree's root hangs under (rootLocalId for
   *  the instance root). An added subtree never anchors to another added entity —
   *  that case is just nesting via `children`. */
  parentLocalId: number;
  guid: string;                                       // EntityAttributes.guid, stable identity ('' in a prefab file)
  key?: string;                                       // template-local identity, in a prefab file only (#1387)
  name: string;
  traits: Record<string, Record<string, unknown> | boolean>;  // full snapshot, like a prefab entity
  children: AddedEntity[];                            // nested adds (parentLocalId omitted/ignored)

  // ── Reference node (present only when this added node is itself a user-added
  //    NESTED prefab instance). `prefab` makes the node EXPAND the child prefab at
  //    the anchor instead of spawning `traits`/`children`; the child's diffs ride
  //    in the fields below. See "Nested-instance additions". ──
  prefab?: string;                                    // child prefab GUID ⇒ reference node
  overrides?: Record<number, Record<string, Record<string, unknown>>>;
  added?: AddedEntity[];                              // the nested instance's OWN added (recursive)
  removed?: number[];
  removedTraits?: Record<number, string[]>;
  nestedOverrides?: Record<string, Record<number, Record<string, Record<string, unknown>>>>;
}
```

Notes:

- **GUID refs only**, same invariant as everywhere else (asset fields carry
  GUIDs). Added subtrees feed `collectResourceRefs` so their meshes/materials are
  acquired at load (see [Resources](#resources)).
- `removed` stores only the **top** removed localId of a removed subtree; its
  prefab descendants cascade on apply/refresh. If a later prefab edit drops that
  localId, the entry is moot and is discarded on reconcile.

## Capture

Add a companion to `captureInstanceOverrides` (leave that one alone so the
value-diff path and its tests don't churn):

```ts
// prefab.ts
function captureInstanceStructure(rootInstanceId, prefab):
  { added: AddedEntity[]; removed: number[];
    removedTraits: Record<number, string[]>;
    consumedEcsIds: Set<number> }   // ecs ids folded into `added`, for the serialize skip set
```

Algorithm:

1. Build `memberByEcsId` and `localIdByEcsId` from the member walk
   (`PrefabInstance.rootInstanceId === root`), and the `parentId` child map for
   the whole world.
2. **removed** = `prefab.entities.localId  \  {localIds the walk found}`, reduced
   to top-most (drop a localId whose prefab-parent is also removed).
3. **removedTraits** — for each surviving member, the prefab entity's trait names
   the live entity no longer has (skip `PrefabInstance`). The complement —
   traits the live entity has that the prefab lacks — is already captured as an
   added-trait override by `captureInstanceOverrides`, so additions need no work
   here.
4. **added** = DFS from the instance root over `parentId` children. When a child
   is **not** a member, classify it (`nestedRootKind`):
   - an ordinary entity → snapshot it (all traits via the trait registry, like
     `serializePrefab` does — parentId omitted, it's structural), recurse into *its*
     children to fill `AddedEntity.children`, anchor with `parentLocalId = localId of
     its (member) parent`;
   - an **owned** nested instance (a self-rooted `PrefabInstance` that expanded from
     THIS prefab's definition — it **claimed** one of the prefab's `prefab` rows, see
     [Which instance is a row's own](#which-instance-is-a-rows-own-expansion)) →
     **skip** (it round-trips via the prefab row / `nestedOverrides`);
   - a **user-added** nested instance (self-rooted `PrefabInstance` that claimed no
     row) → capture as a **reference node** (`captureInstanceReference`),
     storing its source + overrides/structure. See below.
   Don't recurse into members.

## Serialize round-trip

In `serializeScene` (`serialize.ts`), for a prefab root that captured cleanly:

- keep writing `overrides` (unchanged);
- also call `captureInstanceStructure` and write `added` / `removed` when
  non-empty;
- **stop emitting added children as top-level scene entities.** Today they leak
  out as orphan-prone standalone entities. Mark every entity in a captured
  `added` subtree as "consumed" (by ECS id) and skip it in the main entity loop,
  exactly as `prefabChildIds` already skips members.

`collectResourceRefs` must also walk `added[].traits` (and nested `children`, plus
a reference node's `prefab` + its own `added`) so an added mesh/material/texture/
nested-prefab is acquired — otherwise the instance loads but the added child renders
nothing. The editor `collectResourceRefs` (serialize.ts) **delegates** to the
runtime `collectResourceRefsFromEntities` (loadSceneFile.ts) — one shared
implementation rather than two that can drift.

## Load / re-expand

In `loadSceneFile.ts`, after `instantiatePrefabIntoWorld` spawns the prefab and
`applyOverridesByLocalToEcs` replays value diffs:

1. **Entity removals** — for each `removed` localId, delete the corresponding
   spawned entity **and its prefab descendants** (resolve localId → ECS id from
   the instantiation's `localToEcs`, then cascade by ECS `parentId` through
   `collectSubtreeIds`, the walk the editor's `deleteEntities` shares). The map alone
   is not enough: it reaches a nested row's ROOT but not that nested instance's own
   members, which used to survive naming a dead parent (#1247).

   ⚠️ **The cascade is sound only because both instantiators spawn their first pass
   PARENTLESS** (runtime `instantiatePrefabIntoWorld`, editor `instantiatePrefab`).
   The second pass reads each row's parent from the file entry. A nested row's own
   `removed` is applied *during* the outer first pass. If the outer rows spawned so
   far still held the file's parentId (a localId), a cascade would destroy any of them
   whose raw parent number equals a removed member's ECS id. That was measured with a
   fresh id (5) and a recycled one (1).
   #1222 landed that cascade once and reverted it, and the runtime then fell back to
   deleting exactly the mapped ids. So **a live `parentId` is always an ECS id or 0**,
   the same rule scene load follows for scene entities. Don't reintroduce a raw
   localId there. Covered by `structuralApplyParity.test.ts` § #1247.

   The rule covers raw localIds only. A **dangling** `parentId` is not covered.
   `destroyEntity` does not cascade, so a child whose parent was destroyed on its own
   keeps the dead id. koota recycles indices last-in-first-out, so a removed member
   can reclaim that index, and the cascade then destroys the orphan too. The editor's
   `deleteEntities` has always done this.
   The orphan was already mis-parented under whichever entity reclaimed the index. The
   defect is the non-cascading destroy, not the cascade. It matters only at runtime,
   e.g. a gameplay `spawnPrefabInstance` into a world where something was destroyed
   without its children.
2. **Component removals** — for each `removedTraits[localId]`, resolve localId →
   ECS id and remove each named trait from the spawned entity.
3. **Additions** — for each `AddedEntity`, resolve `parentLocalId → ECS id`, then
   spawn the subtree (depth-first, parent before child), restoring its `guid` and
   setting `parentId` to the resolved ECS parent. Added entities are **not**
   tagged with `PrefabInstance` — on the next capture they're re-detected
   structurally, which keeps save/reload idempotent.

Order matters: removals first (so an added child can't anchor to a localId that's
about to be deleted — if it does, that's a malformed scene; log and skip).

## Apply to Prefab

### Dialog (`ApplyPrefabDialog.tsx`) — recursive

The field-diff walk (`collectInstanceOverrideFields`, `editor/scene/prefabOverrideKeys.ts` — moved
out of the dialog file so the `modoki_prefab {prefabAction:'overrides'}` agent op can build the
same key set without a dialog to render into) gains two node kinds beside the field-diff nodes:

- **Added** — one node per `AddedEntity`, rendered **recursively** (subtree with
  its `children`), each row labeled *added*. One checkbox per added subtree root
  (children ride along; finer granularity is a later refinement).
- **Removed** — one node per `removed` localId, labeled *removed (deletes from
  prefab base — affects all instances)*, so the destructive semantics are
  explicit.

Selection keys extend beyond `"<member>.trait.field"` — `<member>` being the member's `nodeGuid`, or
its `localId` for a pre-v5 template (#1468 Phase 4, § Member identity below):

- `"+added.<guid>"` — push this added subtree into the prefab base.
- `"-removed.<member>"` — delete this entity from the prefab base.
- `"-trait.<member>.<traitName>"` — delete this component from the prefab base
  (rendered as a *removed: TraitName* row under the member's node).
- `"+trait.<member>.<tag>"` — add this TAG to the prefab base (#1491). A tag has no fields, so no
  field key can carry it. The capture holds an added tag as `{Tag: {}}`, and the field walk used to
  drop that entry for having no fields. The scene save kept the tag, but no surface listed it, and
  Apply skipped a tag key with no `skipped` entry. `collectInstanceOverrideTree` is the one walk that
  yields both field nodes and added tags, for the dialog and the agent op alike. An added COMPONENT
  still rides field keys, because Apply seeds its whole bag from them. A tag key Apply cannot write
  is named in `skipped`, and so is a tag spelled as a field key.

### Write (`applyToPrefabSelective`)

Operate on the deep-cloned `newPrefab`:

- **Add** — assign fresh localIds by continuing the BFS counter
  (`max(existing localId) + 1`, incrementing per node), set the subtree root's
  `EntityAttributes.parentId` (as a localId) to its `parentLocalId`, nested
  children point at their parent's freshly-minted localId, **clear `guid`**
  (prefab entities are templates — mirrors `serializePrefab`). Append to
  `newPrefab.entities`. Existing localIds are **never renumbered** (other
  instances reference them by localId in their overrides).
- **Remove entity** — drop the entity entry for that localId **and its prefab
  descendants** from `newPrefab.entities`. Leaves a gap in the localId sequence;
  that's fine — localIds must be *stable*, not contiguous.
- **Remove component** — delete the named trait from
  `newPrefab.entities[localId].traits`.
- **A row's POSE** is read and written by `rowPoseRead`/`rowPoseWrite` (#1490), because a reference
  row (`prefab: <child>`) does not hold it in its own traits. Both loaders place a nested root from the
  child prefab's root row, overlaid by the row's `overrides[<child rootLocalId>].Transform`, and neither
  reads the reference row's `traits`. Every writer of a reference row puts only `EntityAttributes`
  there. A plain row keeps its pose in `traits.Transform`. An Apply that wrote a moved nested root's
  pose into `row.traits.Transform` placed the root in every instance without posing it. The removal
  branch, which carries a kept row's pose through the rows it removes, read `row.traits.Transform` and
  so carried nothing for a reference row.
- **Every pose Apply writes into ANOTHER document's override is a layer** (`layerPose`): the reference
  row's own root pose, and a nested member moved out of its instance (`~moved.<rows>:<member>`, into
  `overrides` or `nestedOverrides`). The layer holds only what differs from its BASE, the pose the
  documents below give the member: the member's own row, under whatever the rows in between set
  (`resolveEffectivePrefabOverride`). A field that now equals the base is dropped. Writing the full
  TRS froze the lower documents' later edits in the row. It also lost scene edits while the save still
  subtracted every field a row's override holds by KEY (#1498, since fixed): a scene edit to any of
  those fields was dropped.
- **Rotation is one orientation, not three fields** (`sameOrientation`, transformSpace.ts). Euler
  components are coupled, and a decomposed pose comes back in another spelling of the same rotation:
  `ry: π` becomes `(-π, ~0, -π)`. A per-field diff then pinned an equal rotation, or dropped `ry ≈ 0`
  from a row that turned its instance around, which let a later child edit turn it. `layerPose`
  writes all three components or none. The removal branch keeps the row's own spelling when the carry
  did not change the orientation. A root with no Transform on either side (a UI root) gets none.
  So a row that rotates its member at all holds all three components. The save reads that the same way
  (`subtractChainOverrides`, #1498). The scene's rotation comes off only when its orientation EQUALS the
  row's, and is otherwise written as all three; scale is compared per field.
  **One exception, for a RE-SPELLED pose** (`sameRotationScale`, the linear part as one matrix). A mirror's
  sign is coupled to rotation too, so a decomposition (a move out and back) returns `sz: -1` as `sx: -1`
  turned π about y. The capture holds only the MARKED components, so the marked fields over the row no
  longer rebuild the pose on screen. Then, and only then, all six are decided together: dropped if the pose
  equals the row's, written whole from the live Transform if not. (Close-out review: per component, a
  mirrored member moved out and back saved `sz: 1` alone and lost its mirror. Second review: widening
  EVERY time pinned axes the scene never touched, such as the row's own turn or mirror, and on a rebuild
  an old row's scale over a refreshed one.) `sameRotationScale` judges each column at its own scale, so a
  large scale on one axis does not hide a change on another.
  (Before #1498 the save subtracted by key, and an edit to ANY rotation component of such a member was
  dropped.)

The live instance's applied **added** entities are deleted from the live world
before refresh (so the re-instantiated prefab member replaces them rather than
duplicating); non-applied additions are re-captured and re-spawned by the
refresh, so nothing is lost. See [Refresh reconciliation](#refresh-reconciliation).

Then `writePrefabFile` + `refreshAllInstances`. After refresh, applied additions
are now base members (re-detected as members, not adds) and applied removals are
gone from the base, so both drop out of the instance's structural override set on
the next capture — the same self-clearing behavior the value-diff path already
relies on.

## Refresh reconciliation

`refreshInstances` already does *capture(old) → destroy → re-instantiate(new) →
re-apply*. Extend the captured blob to include `{ added, removed }` and have the
re-apply step run the same **load/re-expand** logic above against the new tree.
Reconcile against `newPrefab`:

- a `removed` localId absent from `newPrefab` → discard (already gone);
- an `added` subtree whose `parentLocalId` is absent from `newPrefab` (the
  prefab deleted that anchor) → re-anchor to the instance root and `log()` the
  reparent, rather than dropping the user's entity silently.

## Nested-instance additions (reference nodes)

A *user-added nested prefab instance* — a prefab dragged from Assets under a member
of another instance — is captured as a **reference `AddedEntity`** (`prefab` set)
rather than a flat trait snapshot. This preserves its exact parent placement across
save/reload (it was previously dropped, then briefly re-anchored to the scene root):

- **Owned vs user-added.** `captureInstanceStructure` distinguishes the two via
  `nestedRootKind`, which reads a per-row **claim** — see
  [Which instance is a row's own](#which-instance-is-a-rows-own-expansion).
- **Capture.** `captureInstanceReference(nestedRoot, source, childPrefab)` yields the
  node's `overrides` + `added`/`removed`/`removedTraits`; the nested instance's whole
  live id set is folded into `consumedEcsIds` so serialize skips it.
- **Serialize.** `serializeScene` files it under the owning top-level instance's
  `added`, anchored at the member's localId (not as a standalone scene entry).
- **Expand on load.** `applyStructureByRootInstance` (editor) /
  `applyStructureByLocalToEcs` (runtime) detect `node.prefab` and **expand the child
  prefab** as a nested instance under the anchor — `instantiatePrefab(child, anchor)`
  / `instantiatePrefabIntoWorld(world, child, anchor, …)` — replaying its
  overrides/structure. The spawned root keeps `parentLocalId 0`, so the next capture
  re-detects it as user-added — idempotent, because an unstamped instance is never
  taken for a row (#1367; see [the partition](#which-instance-is-a-rows-own-expansion)).
- **Its own nested rows.** The node is the outermost layer for everything under it, so it
  carries that interior's scene edits itself: `nestedOverrides` and `nestedStructure`,
  path-keyed from the node's own prefab, written by the same `captureNestedChannels` walk a
  top-level entry uses (#1369). Before that, an edit inside the row expansion of a dragged-in
  prefab was captured by nothing and came back on reload. Both expansion paths forward both
  channels (`spawnNestedInstance` in the loader and in the editor).
- **Rebuilds.** `rebuildInstance` re-spawns the node whole from the captured structure, so its
  live re-apply (`captureNestedInstanceOverrides`) skips every instance whose chain passes
  through a user-added root. It used to visit them too and apply their structure a second
  time — one Bolt became two on every rebuild.

  **What the re-apply of an OWNED nested instance states (#1386, #1401, #1383).** The fresh expansion
  already applies everything the outer prefab's row chain authors, so the capture is the live instance
  **minus that chain**. The chain comes from the document the live tree was expanded FROM, which is
  `rebuildInstance`'s `baseline` (a refresh passes its old file). Only the scene's own edit is left:
  - **values** are dropped when they EQUAL the chain's value (`subtractChainOverrides`), rotation as one
    orientation and a re-spelled pose as one linear part (above). A scene that changed a row-set field keeps its change. Since #1498 the
    save (`captureNestedSceneDelta`) makes the SAME subtraction: it used to drop every field the row sets
    by KEY, so a scene edit to a row-set field read as the row's own and was lost on save.
    ⚠️ **The save compares against the CACHED chain, not `baseline`, and that is sound only because of
    the refresh ORDER.** A rebuild reaches the save's capture through one path, a user-added reference node
    inside the rebuilt instance (`captureNestedRef` → `captureNestedChannels`). That node's frames are
    instances of the refreshed source, so the refresh has rebuilt them before the outer capture reads them
    (`refreshInstances` runs deepest first; `rebaseStaleInstances` rebuilds a frame only after every stale
    frame its teardown reaches, #1499). Refreshed the other way
    round, the outer capture read the node's OLD row value against the new row, restated it, and froze
    the old value (#1401's shape): `tests/editor/nestedRowFieldSave.test.ts` pins it.
    ⚠️ **The same compare makes a SAVE of a stale frame pin its old values.** If the cache holds a newer
    version of a row than the one the live frame was expanded from, and a scene save runs before
    `rebaseStaleInstances` rebuilds it, the capture reads the frame's old row values against the new row.
    By value they differ, so they are written into the scene and override the new row on reload. (By key,
    before #1498, they were dropped and the new row healed the instance.) This is not reachable today:
    every path that moves the cache ahead of the live tree rebuilds before a save can run. That covers
    Apply (its refresh), Apply's undo (`refreshBaseInstances`), the prefab-edit save, and the reload hook
    (`adoptWorldReloadedFromDisk` → `rebaseStaleInstances`). A new path that writes the cache without
    that refresh would open it. (Traced by the #1498 close-out's third review; a scratch test drove the
    mechanism with the rebase skipped.)
    The chain's member tokens are first resolved by `baseTokenResolver` from the nested root: its own
    frame, with `^` climbing to the instance whose row expanded it. The loader applies every value in
    that frame, whichever layer authored it. A reference node's payload is in its own instance's frame
    and is left whole, as `rebaseAddedTokens` leaves it; a template writes it tokenized in that frame
    (#1538). The live side holds
    guids, so an unresolved `@member:` token never compared equal and froze the old target. A trait
    the chain ADDS is captured whole, schema defaults included, so an unauthored field equal to its
    default counts as the chain's too.
  - **`removed` / `removedTraits`** lose the chain's own entries.
  - **`added` nodes** are matched to the chain by **template key**: the live marker, or
    `recoverTemplateKey` once a round trip dropped it. A key-less legacy node matches by the durable
    guid it carried. An unchanged match is dropped: the fresh copy owns it, so a template edit
    reaches it. An EDITED match is kept, and the re-apply deletes the fresh copy first and restores
    the key marker on the survivor. Restating these nodes spawned every row-authored node twice.
  - ⚠️ **A template node the scene DELETED still comes back.** With no live node there is nothing to
    match, and "deleted here" cannot be told from "added by the refresh" without the old live key set.
    A template node the scene MOVED below another added node also duplicates. Only nodes directly
    under a member are matched, so its fresh copy returns at the template anchor beside the moved
    one. A save and reload gives one, because the scene's `nestedStructure` owns the interior. Both
    predate this subtraction.
  - A nested instance whose `parentLocalId` climb does **not reach the outer root** (it stops at a
    plain `added` node) gets no capture. The outer structure already carries it as a reference node.
    Its partial chain used to address the real row's expansion and write its overrides there. This is
    latent from the editor: reparent unpacks, and duplicating clears the stamp.

  #1401 is latent the same way. Apply is the only rebuild from a CHANGED document, and it adds or
  removes whole rows, so the `baseline` hand-off in `refreshInstances` has no editor flow to test.
  `tests/editor/rebuildNestedReapply.test.ts` drives it at `rebuildInstance`.
- **Resources.** `collectResourceRefsFromEntities` surfaces `added[].prefab` and
  recurses a reference node's own `added`, so `SceneManager` acquires the child
  prefab (and its transitive refs) at load.
- **Apply to Prefab.** `insertAddedSubtree` writes a reference node as a nested
  **row** in the owner's `.prefab.json`, so promoting it matches how `serializePrefab`
  writes nested rows, and the node's `nestedOverrides` + `nestedStructure` become the row's own
  (#1381). (It also raises `version` to `PREFAB_FORMAT_VERSION`, which since
  #379 every writer stamps unconditionally — the bump is no longer a signal that the file
  gained nesting.)
- **Recursion.** Because `captureInstanceReference` calls `captureInstanceStructure`,
  a user-added instance nested inside another is captured (and expanded) recursively.
  `serializePrefab`'s nested-row loop skips an instance already folded into a parent
  reference node (`skip.has(e.id)`), so it is never double-emitted. It equally skips every
  **owned** nested instance inside a row, at any depth (`captureNestedChannels`'
  `ownedMemberEcsIds`) — the row re-expands them. They once got a second reference row at the
  prefab root, so a Create Prefab over a held instance wrote its owned INNER twice and the tagger
  re-stamped it onto the wrong row (#1382).

## The scene's structural channel into a nested instance (`nestedStructure`)

A scene could always override a nested instance's **values** by row path (`nestedOverrides`), but
until #1358 it had no channel for that instance's **structure**. `serializeScene` ran
`captureInstanceStructure` only for TOP-LEVEL instances; a row's own expansion got a per-field value
delta and nothing else. So a member deleted inside it came back on the next load, and a member
dragged out of it existed at **both** places — two entities holding one guid.

`nestedStructure` is the sibling slot, on a scene entry, on an added reference node (#1369) and on a
prefab nested row (#1381) — see *Three carriers* below — keyed by the same path grammar
(`nestedPathKey`):

```ts
nestedStructure?: Record<string /* "4", "4.7" */, {
  added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>;
}>
```

- **Once the scene addresses a path it OWNS the interior** — all three lists come from the slot, and
  an absent one reads as **empty**, not as "fall back to the row". Per-field fallback makes *"the
  row's own list no longer applies"* unrepresentable: deleting the last member of a row-authored
  `added` wrote `{"4": {}}`, the loader fell back to the row, and the member came back on reload
  (with the save alternating between the two shapes forever).
- **Skipped only when both sides are empty** — the live interior AND what the prefab chain applies.
  That absence is what lets a member added to the inner prefab later still reach an untouched
  instance. For the **legacy slot** a row that authors its own structure is therefore always restated
  by the scene, which follows from the previous point.
- **Scene v16 member rows state only what DIFFERS from the chain (#1511).** A member row is per
  member and per channel, and an absent field falls back to the chain (`foldMemberRowChannels`), so
  whole-frame ownership is not needed there. `moveChannelsOntoRows` writes a member's `removed`,
  `removedTraits` or `added` only when it differs from the chain's baseline for that member.
  Restating every member the chain touched pinned a template row's added nodes, removed members and
  removed traits on a no-op save, so a later template change to them never reached the scene.
  `added` compares the way the rebuild does (`frameAddedDiff` → `diffFrameAdded`, the rebuild's
  `subtractChainStructure` for a list that falls back): the plain live capture, matched by template
  key, with the chain's member tokens resolved. A reference
  node's live capture carries identity a template node does not: member rows' `guid`/`name`, and a
  display `name` no spawn applies. `withoutLiveIdentity` drops that identity before the compare.
  It also drops the node's own `traits` and `children` from both sides (#1536). No spawn reads
  them: `applyStructureCore` hands a reference node to `spawnNestedInstance` before its trait loop,
  and the root's pose rides in `overrides`. The live capture always writes them empty, so a
  hand- or agent-written template node that stated either was restated on every save.
  Without that, every template reference node read as edited, and the REBUILD respawned it from the
  capture too, so a refresh never delivered a template change to one. It keeps a member's `guid`
  only when a LIVE member holds it and does not derive it from the node's root. That is an identity
  no reload reproduces: an earlier save stored it, or a Refresh kept it live, before the template
  re-parented the member. Keeping it keeps the node edited, so scene refs into the member survive.
  An orphan row's guid (the template dropped the member) names nothing live, so it goes; kept, it
  pinned the node forever. It also fills a `nestedStructure` slot's absent lists with empty ones,
  as the loader reads them.
  ⚠️ **Some template node shapes still read as edited, and a save still pins them**, as every
  reference node was pinned before #1511:
  - an **all-empty** slot. The live capture omits a path whose interior and chain are both empty,
    and the slot cannot be dropped to match: an absent slot falls back to the row, while an empty
    one overrides it;
  - a slot holding **`added` nodes**. The slot is compared raw, and its nodes are not run through
    this normalisation.
  The cost is one member-path walk per reference node per save or rebuild. A close-out
  measurement put it at ~4-5 ms per node at 3.3k entities, about +15% on a save with 40 of them.
  Since v17 (#1516) a template's added nodes and removed traits are stated node by node and trait by
  trait instead — see "A template-added node's edits are stored on its own row" below. A frame
  that falls back to the legacy slot (a member no row can key, or an unrowed move) keeps the
  restate rule above. Scenes saved before #1511 keep their pins wherever the template has changed
  since. A pin that still equals the template drops out on the next save.
  ⚠️ The first cut instead compared the live capture against the file-authored baseline and wrote
  only the differing fields. Those two documents are **not comparable** — `snapshotAddedTraits`
  compacts schema-default fields (and until #1377 carried a live `parentId`), the baseline is whatever the prefab
  file holds — so "equal" was unreachable for any row with authored structure: the slot was written
  on a no-op save, baking a live ECS id into the scene file and freezing the instance, which is the
  one thing the gate existed to prevent.
- **Scene format v14.** Purely additive, so `migrateV13toV14` only stamps. The bump is still
  required: Scene's disposition is REFUSE, so an older build must refuse a v14 document rather than
  read it, ignore the key it does not know, and drop it on the next save — the exact loss this fixes.

⚠️ **THREE resource-ref walkers must know about this slot, and they are in three files.** An
`added[]` node inside `nestedStructure` carries `prefab` and trait asset refs exactly like a
top-level one, so a walker that misses it produces a ref the BUILD cannot see: the asset is dropped
from the production bundle and it fails only once shipped (#53's class). Extending one and not the
others is invisible to a round-trip test, because the refs resolve fine from a warm editor cache.

| walker | file | what it feeds |
|---|---|---|
| `assertNoPathRefs` + the `flag*` scanner | `editor/scene/serialize.ts` | the scene's `resources[]`, and the literal-path tripwire |
| `collectResourceRefsFromEntities` | `runtime/loaders/loadSceneFile.ts` | `SceneManager` at load |
| `walkCarrier` | `plugins/asset-tree-shaker.ts` | the production build |

The third one is the expensive one to miss, and its own docblock asserts parity with the second: for
a document with no `resources[]` an unqueued ref reaches `vite-asset-scanner`'s guid check and
**fails the build** on legitimate authoring.

⚠️ **Three carriers — a scene entry, a reference node, and a prefab ROW (#1381).** Each is the
outermost layer for its own paths *within its document*, and a path steps only through nested ROWS.
Where two meet during expansion the outer one wins **per path, whole** — never element-wise, for the
same un-delete reason as above — and `resolveEffectivePrefabStructure` descends the rows' slots
path-keyed exactly as `resolveEffectivePrefabOverride` does, so a scene's baseline includes what an
intermediate row already did to the interior. Since prefab v6 (#1533) each carrier is a separate
LAYER that also holds member rows, and the loaders fold the layers one after another — see "A prefab
row states its nested frames per member" below.

The row carrier is written two ways, both **with a writer**, which is the order CLAUDE.md requires
for an authored field:
- **Promotion** (Apply to Prefab, `insertAddedSubtree`) re-captures a reference node's channels from its
  live instance through the row writer (`captureRowChannels`, #1533), at every depth: a reference node
  under a promoted plain node reaches the same branch through the recursion (#1538).
- **A prefab-edit save / Create Prefab** (`serializePrefab` → `planPrefabRows`) **captures** each
  row's channels from its live expansion with the same `captureNestedChannels` walk the other two
  carriers use. Captured, not passed through: `buildPrefabEditScene` forwards both channels onto the
  row's scene entry, so the edit world IS the expansion, and an edit made inside a row's nested row
  in the prefab editor must replace the file's value rather than be overwritten by it.
  Since prefab v6 (#1533) that capture is then split member by member onto the row's `members`,
  and only a frame that cannot be split stays in the slot — see "A prefab row states its nested
  frames per member" below.
  ⚠️ **The row writer does NOT use the scene's "restate when the baseline is non-empty" rule**
  (`omitUnchanged`). A path whose live interior equals what the inner prefab chain already applies
  is omitted. Otherwise a no-op save of the outer prefab pins the inner prefab's own authored
  structure into the outer file, and a later edit to the inner prefab stops reaching every instance
  of the outer one. The compare that #1358 rejected for scenes is sound here, because file-authored
  `added` nodes come from the same compacting capture, and #1377 stopped capturing the live
  `parentId`. The compare (`sameStructure`) is over content: `added`/`removed` are sets, and a
  file bag is run through the capture's own compaction (`compactAddedTraitData`), so hand-ordered
  lists and legacy full bags compare equal too. A mismatch still writes the path verbatim, which is
  the safe direction.
  An owned nested instance whose prefab is uncached still re-expands from its owner's row, so it and
  everything under it are skipped. Anything added inside it is dropped with a warning, following the
  `captureNestedRef` precedent; every caller warms the cache first (#1295).

⚠️ **A reference node written into a TEMPLATE is a row carrier, not a scene one (#1538).** The carrier
is the reference node, but the rule follows the DOCUMENT: in a prefab file it is written by the row
writer — see "A template reference node is written by the row writer" below. A reference node in a
scene keeps the scene's rule (#1358).

⚠️ **Why the channels are not folded into the row at promotion instead.** A reference node's
`nestedStructure` is keyed by paths inside ITS OWN prefab, so no key ever targets a row the promoted
(outer) prefab owns — its direct lists already land in the row's `added`/`removed`. The only fold
possible would write into the inner prefab's file, changing every instance of it.

**No `PREFAB_FORMAT_VERSION` bump was made for the row slot (#1381), and that reasoning has since
expired.** At the time, nothing read the prefab version at all, so a bump protected nothing: an older
build loaded the file, ignored the field and dropped it on its next save. #1468 then added the WRITE
gate (`plugins/prefabWriteGuard.ts`: an older build opens a newer prefab but refuses to save over
it), so a bump now does protect a new field. v6 (#1533) takes one for `members`. The slot itself
predates the gate and was never bumped for.

History: the row slot was declared during #1358 and removed because nothing wrote it, and the
descend in `resolveEffectivePrefabStructure` was removed as dead for the same reason. Both came back
in #1381 with their producers; before that, promotion dropped the slot and a prefab-edit save lost a
row's file-authored `nestedOverrides` too.

**One walk, `captureNestedChannels(source, ownedNested)`** (`editor/scene/prefab.ts`), produces both
channels for all three carriers. It descends top-down through the row partition at every level
(`captureInstanceStructure(…).ownedNested`). It replaced a bottom-up walk in `serializeScene` that
resolved each owned instance UP to a top-level root, which was why a chain through a reference node
resolved to nothing. Paths are written sorted, so key order does not depend on ECS ids.

⚠️ **`onInstantiatePrefab` carries it as its LAST argument**, not beside `nestedOverrides` where it
belongs logically. Those arguments are positional and five implementors read them by position
(`SceneManager` plus four test harnesses), so inserting would silently shift `rootGuid` and
`rootEditorFolder` in any implementor not updated in the same change. Threading the recursion alone
is not enough — the save looks correct while nothing applies it.

## Which instance is a row's own expansion

A nested-prefab row expands to **exactly one** instance, so "owned" is a property of the
*row*, not a test you can run on a node in isolation. `captureInstanceStructure` therefore
**partitions**: it assigns each row at most one claimant and treats every other instance at
that anchor as independent (#1354).

- **Candidates** are the self-rooted `PrefabInstance`s directly under a member of this
  instance — the only place a row of this prefab can expand. Sorted by ecsId, so the
  assignment is deterministic rather than dependent on world-query order.
- **The claim** — a candidate whose `PrefabInstance.parentLocalId` names a row *at its own
  anchor* claims that row (first by ecsId when two carry the same stamp). Only an instance that OWNS the
  candidate's root may take it, under any anchor (#1484). Two frames meet at a nested root, and each hangs
  rows under it. When both documents nest the same prefab at the same localId, either root matches the
  other's row by anchor, stamp and source. Claimed by the wrong instance, a row read present while its own
  root was gone, and deleting it was never saved.
- Everything unclaimed is `'userAdded'` and rides as a reference node — **including every
  unstamped instance.** Every path that expands a row stamps it: the loader
  (`instantiatePrefabIntoWorld`), the editor's `instantiatePrefab`, and Create Prefab's tag.
  So a live unstamped instance is never a row's expansion. It is one the user dragged in, a
  duplicate, or an unlinked root. That premise is pinned by a test (#1367).

Two consumers must read that one claim map rather than re-deriving it, and both did
re-derive it before #1354:

- **`nestedRowPresent`**, which decides whether a row goes into `removed[]`. Before, it
  ran its own `(source, stamp)` scan, so a row could be reported present while the
  classifier had already given it to someone else.
- **`captureNestedChannels`**, which writes the nested channels for exactly the instances in
  `ownedNested`. Until #1369 `serializeScene` found owned instances with its own
  `parentLocalId > 0` test and needed a reconcile block to line that up with the partition.
  Without the reconcile, an instance both of them disowned was written **nowhere**. Walking the
  partition itself removed the second answer, and the block went with it.

Present means CLAIMED: `nestedRowPresent` is strict. A row nobody claims is written into
`removed[]` even when an unstamped instance of its prefab sits at the anchor, because that
instance is written separately, as a reference node.

**The row domain includes the owned roots (`instanceRowDomain`, #1484, #1481).** "Which live entity is row
L of this document" is answered in one place: the members by `localId`, plus the nested roots this
instance owns by the row that claimed them. Three captures once built it from members alone. Under a
nested row under a nested row, or a plain row under one, the parent row is a nested ROOT. A members-only
lookup cannot see it, so:

- `nestedRowPresent` read the parent as gone, and a deleted nested row was never written as removed.
- The Transform mark-gate in `captureInstanceOverrides` resolved no home for a member under a nested row,
  read it as moved, and froze every Transform field a re-imported base had changed.
- The gate never asked whether the frame ROOT moved, because an owned root's row is its OWNER's.
  `ownedRootMoved` now asks that frame. Without it a moved owned root's compensated pose, which
  `markCompensatedTransform` deliberately leaves unmarked, was dropped on save. The same root's Transform
  must then be subtracted from its ROW by VALUE, not by key: the spaceship's rows set each flame's
  position, so a moved flame reloaded at its row's position (found by the live check,
  `games/space-console`). #1481 made that one case by value. Since #1498 every field is, with the row's
  member tokens resolved first (they would never equal a live guid otherwise, #1386).

**A row of another frame is not ours (`foreignRow`, #1484).** Those same shapes hang the outer frame's row
under the inner instance's root. So the inner instance's structure capture skips it, rather than
writing it as its own `added` (which spawned it twice on reload). The inner instance's rebuild (an Apply
or Revert on the inner source) parks it, as it parks a moved-in member, rather than tearing down a row
its re-expansion cannot respawn. A parked owned root is destroyed after all when its own frame is torn
down by the same rebuild: the rebuild's `frameOf` answers an owned root's OWNER whether or not it moved.
In a prefab-edit world the rebuild also parks the edited document's own rows (their sentinel guids),
which the capture already skips (`editRow`). And the structure re-apply (`applyStructureByRootInstance`)
maps a nested row through the same row domain, so a removed nested row under a nested row stays removed
through a Revert or Apply of the outer instance.

The domain's world-wide half (every instance's members, owned roots by owner, and identity children) is
built once per identity resolver (`worldRowIndex`). A save builds that resolver once per structure
version, so each instance costs its own size. Built per call, a 1200-entity save measured 70% slower.

**Duplicating an owned nested root produces an independent instance, saved separately**
(owner ruling, 2026-09-18). `clearOwnedNestedStampFromSnapshot` clears the copy's row stamp
at both duplicate seams, so the copy is independent by intent rather than because the source
happened to claim the row first — and, because it cannot then form a same-stamp pair, the
double-write that a non-claiming *stamped* candidate would otherwise produce stays
unreachable.

**Why there is no pass for an unstamped instance (#1367).** There used to be one, for "legacy"
data. It let an unstamped instance claim a free row, and presence was kept lenient wherever one sat
at a row's anchor, so that a wrong claim could not send a row into `removed[]`. Together those
reversed the user's own edits. A user-added instance under a member whose row of the same prefab
had been deleted was taken to BE that row. A no-op save then dropped the addition (no reference
node) and the row's `removed` (lenient presence): the row came back and the instance was gone.

The two halves only work as a pair, which is why both went in one change. Dropping the pass alone
would write a legacy expansion as a reference node while its row ALSO still expanded, giving two
instances. Strict presence writes the row as removed, so a legacy unstamped expansion round-trips
as one instance with its own guid, and its deep edits ride on the reference node's channels.

The issue's proposed discriminator, the derived-vs-stored root guid, adds nothing: a nested
root's derived guid is itself computed from this stamp (`memberStepId`).

## Moved members (#1437)

A prefab member moved to another parent **inside its outermost instance** stays linked, and the move
is saved (owner rulings, #1437: (a) same frame, (b) across frames — under a scene-added node, into a
nested instance's member, out of a nested instance into its outer one). Moved OUT of the outermost
instance, a member is unpacked, while an owned nested instance stays an instance of its own prefab
(#1447). The rule for that case is in docs/scene-loading.md § the #1355 note. `reparentEntity` decides
by `outermostInstanceRoot`, before the parent write (`planMoveUnlinks`, #1445).

## Member identity is STORED, not derived (scene v16, #1468)

**A prefab instance's entry carries a `members` map: the member's minted identity → the guid it has.**
Before v16 a member's guid was only ever *derived* from where the member sat, so any structural change
to the template silently re-pointed or dropped every stored reference to it — and a freed `localId` is
REUSED, so a stale key could name a *different* member rather than nothing at all. Derivation is now
the FALLBACK, for a member no row names.

| | |
|---|---|
| the row | `SceneMemberRow` (`runtime/loaders/loadSceneFile.ts`) — `guid`, `name`, `parent` (a move, below), and the member's EDITS: `traits`, `removedTraits`, `removed`, `added` (Phase 4, below) |
| the key | a `/`-joined chain of minted node guids, ONE per instance FRAME, flat within a frame |
| who decides the key | `memberRowKeysIn` (`runtime/core/ecs/memberRows.ts`) — one spelling, used by the save AND the load |
| the writer | `captureInstanceMembers` (`editor/scene/prefab.ts`) for identity; `moveChannelsOntoRows` for the edits — on the entry and on a reference node |
| the reader | `applyStoredMemberRows` (the guids), before `deriveInstanceMemberGuids`; `applyStructureCore` queues the moves; `foldMemberRowChannels` (`runtime/loaders/prefabOverrides.ts`) folds the edits in |

**The frame chain follows IDENTITY, not the ECS tree.** A member's frame is the instance it BELONGS to
(`PrefabInstance.rootInstanceId`; for an owned nested root, the instance of its *identity* parent),
wherever it has been dragged to. Reading it off the ECS parent chain breaks the flat key in both
directions: a member moved beside its frame gets re-keyed and loses its stored guid, and a member of
ANOTHER instance sitting in this subtree gets keyed as one of ours — the state that could not be
written down under path-addressing and can under identity-addressing.

**A row exists only where the TEMPLATE minted a `nodeGuid`** (prefab v5). A member of a pre-v5 template
gets none and derives as it always did. Keying such a row by `localId` instead looks like graceful
degradation and is the opposite: the prefab's first re-save mints guids for every row, so every
localId-keyed row in every scene would orphan at once. Two consequences worth knowing:

- **the repo's prefab corpus IS v5** — migrated once by `engine/scripts/migrate-prefabs-v5.mjs`
  (line surgery, so the ten hand-written files keep their layout) and pinned by
  `engine/tests/architecture/prefabCorpusNodeGuids.test.ts` on the guid, not the version number. So
  every scene gains rows on its first save under this build. A pre-v5 template — every prefab the
  released editor wrote, so every project outside this repo until its prefabs are re-saved — still has
  none, and a move inside such an instance is written to the legacy `moved` map instead (below);
- **`stampDerivedMemberGuids` could not be retired** (#1468 tried): it still closes #1461's window for
  the members rows do not cover. Both it and `promoteOwnedRoots` now SKIP a keyed member, because the
  window they close is "the reload will derive a different guid" and a row means it will not.

**What happens when identity breaks.** A row naming a node the template no longer declares is kept and
logged once, by name — never silently dropped (R2). It is asked of the DOCUMENT, so a member the
instance merely REMOVED keeps its row silently, and a template that could not be READ produces no
claim either way. A pinned guid that collides with one another member derives loses the pin, loudly,
and derives instead — the derived set is internally collision-free, so a collision can only ever be a
pin meeting a derivation.

### A move is stored on the member's row (Phase 3)

**`SceneMemberRow.parent` is the guid of the parent a member was moved to — a DIFF against its own
frame's template, not "the live parent, always".** A template that re-parents a member must move it in
every instance that has not moved it itself (R4), and an unconditional `parent` would pin it at the old
place for ever. `memberRowParents` computes the diff from the DOCUMENT; a row parent that is gone
(removed or unpacked) counts as moved, and a template that cannot be read makes no claim. The Transform
mark-gate in `captureInstanceOverrides` asks the same function, so the gate and the save cannot disagree.

- **The scene-format `moved` map is LEGACY, not gone** (`SceneEntityEntry`, `AddedEntity`,
  `NestedStructureDelta`). It is WRITTEN only for the moves no row can carry — a member of a pre-v5
  template, or one with no durable guid (`InstanceStructure.unrowed`) — and READ always, because a file
  from before Phase 3 has its moves nowhere else. A row wins where both move one member, and a keyed
  member's move is never duplicated into the map, so a v5 instance's file migrates on its first save. `nestedStructure[path].moved` collapsed onto the rows
  (`descendMemberRows` drops one leading key component per frame).
- **`InstanceStructureData.moved` survives as an INTERNAL transport** — the editor's *"moves that still
  apply"*, reduced by a Revert, which the carried rows cannot answer. A rebuild therefore carries
  identity but NOT `parent`: re-asserting the carried rows put a reverted move straight back.
- **Promotion keeps a keyed member's guid** (R7), and an unpack undone after a rebuild RELINKS — both
  follow from identity no longer changing under a member.
- **A rebuild carries a REFERENCE node's rows too (#1482).** A user-added instance inside the rebuilt
  one is its own row-writing root, so the outer carry (`captureInstanceMembers` →
  `restoreInstanceMembers`) never reaches its members. Its rows ride on the node itself in the captured
  structure, and the rebuild pins them from there, before the derive. It uses
  `collectReferenceNodeRows`, the same collector the loader uses, so where such rows can sit is written
  once. Until then those members re-derived, and an outer row's `parent` naming one of them dropped the
  move for good.
- **Promoting a reference node reads a pre-v5 move in its FRAME (#1480).** A legacy `moved` localId
  means something only in the frame it was written for. `promoteReferenceMoves` looks it up through
  `memberRowsIn`'s (frame, localId in that frame) index: the node's own frame for `node.moved`, and for
  `nestedStructure[path].moved` the owned root that path walks to. Before, it matched an owned root's
  `parentLocalId` at any depth (never triggered: spawn order found the right one), and it never read the
  nested maps, so a pre-v5 move inside the node's nested row was lost.
- **`PrefabInstance.homeParent`/`homeSteps` outlived Phase 3 and went in Phase 6.** Stored rows retired
  only their derivation role; the other two (which instance owns a moved owned nested root, and the
  template position prefab FILES name members by) now come from the document and an owner link — see
  "Identity does not move" below.

### A member's edits are stored on its row (Phase 4)

**A member's overrides, removed traits, its own removal and the subtrees added under it are written on
its ROW, addressed by minted identity — so they survive a template that renumbers its localIds.** Before
Phase 4 they were keyed by `localId`, a position in the template: a re-save that renumbered (re-import,
Replace, the Skin Editor's update, a deleted-then-added sibling — the design record lists five paths)
handed every edit to whichever member inherited the number, with nothing to say it had happened.

- **One rule, at every seam: a localId means something only together with the document it was read
  from.** The editor's in-memory maps stay localId-keyed — within one document that is a perfectly good
  address, and the capture functions also write prefab TEMPLATES, whose format is frozen. What changed
  is every place a localId used to cross from one document to another: the scene file (rows), a rebuild
  handed a different `baseline` (`localIdTranslation` in `rebuildInstance`), and the Apply/Revert keys
  (below).
- **The loader translates, the writer moves.** `foldMemberRowChannels` turns a frame's direct rows into
  that frame's localIds against its CURRENT document and folds them over the legacy channels before
  anything is applied; `moveChannelsOntoRows` moves off the captured channels everything a row can key.
- **Per member, per channel, a row field that is PRESENT replaces the lower layer's value.** `traits`
  merges field by field; `removed: false`, `removedTraits: []` and `added: []` are real statements —
  they are how a scene un-does, member by member, what an outer PREFAB layer did inside a nested frame,
  which the legacy `nestedStructure[path]` could only say by restating the frame's whole list.
- **An owned nested root's row is FORWARDED into its expansion** as that frame's `rootRow`: its
  interior edits must merge under the nested expansion's own lower layer. Only `removed` (deleting the
  whole instance) stays in the frame above.
- **A removed member's row has no `guid`** — it is not live. R2 already leaves it alone: its node is
  still in the template.
- **The localId channels are LEGACY, not gone** — the same shape as `moved` in Phase 3. Always read,
  and written for what no row can key: the instance ROOT's own edits (it has no row; it IS the entry),
  a pre-v5 template's members (every prefab the released editor wrote), and a member with no durable
  guid. A nested frame's STRUCTURE moves all-or-nothing: the legacy slot is a replace statement, and
  half of it on rows would be one statement in two places.
- **Rows are written only in the scene FILE form** (`StructureCaptureOpts.rows`, set by
  `serializeScene` alone). Every other capture — a rebuild, Apply, Revert — is an in-memory transport
  whose reference-node spawn reads the localId channels against the same document.
- **Every reader of a scene's channels reads the rows too** — the resource preload, the save-time path
  guard, the build's tree-shaker, a duplicate's guid remint, validation, the member-path walk, and the
  loader's collection of a reference node's rows (a node hanging under a member now rides on that
  member's row). Missing one drops an asset from the build or a guid from a reload with nothing
  erroring.
- **Residual:** a nested instance inside a PREFAB FILE keeps localId keys — the prefab format is frozen
  and a reference row has no `members`. A renumber of that inner prefab still misplaces those edits.
- **Residual, pre-existing (#1483):** a live instance expanded from an OLDER document than the editor's
  cache (a kept base carried across a prefab reload, a deferred reload) is captured against the wrong
  rows. Keys deliberately come from the cached document so they agree with that capture — a key naming
  the member by its own identity was tried and made Revert move an edit onto another member. The hot
  reload closes it by REBUILDING every such frame from its own record, nested frames included (#1493):
  `prefabs.md` § "A capture reads the document the frame was EXPANDED from".

**Apply/Revert keys name a member by `nodeGuid`** (`editor/scene/overrideKeyGrammar.ts`): keys are the
one editor address that crosses CALLS — an agent lists them with `modoki_prefab overrides` and acts on
them later — so a template change in between used to redirect a key silently. The member part is the
`nodeGuid`, or the `localId` for a pre-v5 template. Both spellings are accepted everywhere: Apply and
Revert turn what they are handed into the localId form against the document in hand, a key naming a
member the document no longer has names nothing (never a guess at who holds its number now) — Apply
reports it as skipped, in the caller's own spelling like every skipped key; Revert drops it, and the
agent op refuses it before either runs. `canonicalOverrideKey` makes two spellings of one key compare equal, which is
what the agent op validates with.

The decisions, the eight reconciliation rules and the measurements are in the design record below. Tests: `engine/tests/editor/sceneMemberRows.test.ts`
(the round trip and R1-R8), `sceneMemberRowGestures.test.ts` (the gestures),
`engine/tests/framework/memberRowKeys.test.ts` (which members are keyed, and which are not);
Phase 4's `sceneMemberRowChannels.test.ts` (the loader), `sceneMemberRowWriter.test.ts` (the writer, the
rebuild translation and the keys, every case against a RENUMBERED template) and
`sceneMemberRowReaders.test.ts` (the readers).

**Identity does not move.** A member's guid is derived from its row PATH (`deriveMemberGuid(anchor,
path)`), so a moved member must keep deriving from where it was, and the member paths prefab files name
members by must not change either. Every identity walk — `deriveInstanceMemberGuids`, `memberPathIndex`,
`planCopyGuids`, `baseTokenResolver`, the template tokenizer, the structure capture, `planMoveUnlinks` —
asks one resolver where an entity's walk steps from (`runtime/core/ecs/identityParents.ts`, #1468 Phase
6). The resolver reads the answer from the DOCUMENT the frame was expanded from: it takes the member's row
and climbs its `parentId`s to the first row with a live member in the same frame. Each row on the way that
is gone (deleted, or unpacked so it is no longer a member) adds its localId as a step, because a reload
expands the removed row until the member is derived through it. An ORPHAN row (parent 0, or naming no row)
ends where the loader hangs one. That is the stored root's own parent, or nothing for a nested frame.

- **Which document.** The loader records, per world, the document each frame ROOT was expanded from
  (keyed by the packed entity, #868), plus each source's latest. The editor records its own expansions
  and Create Prefab's tag, and registers its prefab cache as a fallback. Under that is the runtime
  prefab cache, which the loader registers, so a device still reads a document for a frame whose root
  record a flat respawn lost. The root record comes first because Apply to Prefab rebuilds a source's
  instances one at a time. Until an instance's turn, its live tree still follows the OLD document. A
  first cut that read the source's latest there made that instance's unmoved members read as moved.
  Records of dead roots are swept each time the map doubles, since every runtime spawn adds one.
- **A save builds the resolver ONCE** (`openIdentityScope` in `serializeScene`). It reuses it for as long
  as the structure version stands still. Built per instance and per capture step instead, it cost a
  3000-entity save 30%.
- **A document that does not expand the row is not walked.** An owned root walks its owner's document only
  from the row that expanded it. A dropped or renumbered row names some other member at that number,
  and walking it gave the root that member's guid. Such a root keeps its live parent.
- **The owner of an owned nested root** is the one fact the document cannot give. Two instances of one
  prefab inside one outermost instance share every row and every document. So a moved owned root
  carries `PrefabInstance.ownerGuid`, the guid of the frame whose row expanded it. It is written
  (`linkOwnerBeforeMove`) where a move happens, while the root still hangs at its row. The resolver
  trusts it unless the owner's document contradicts it. An unmoved one needs none; its owner is read
  from where it hangs. A MEMBER parent is in one frame. A nested ROOT parent offers two: its own
  frame, when the row hangs under that document's root, and its owner, when the row hangs under that
  nested row. That second shape is a nested row under a nested row, which the prefab-edit save writes.
  The document picks between them, and where both sides are minted the row must be the one that
  expanded it (`parentNodeGuid`). Promotion and tagging clear the link.
- **The frame step (`FRAME_STEP`, `@`, #1484).** A row of the outer frame that hangs under a nested ROOT
  (a nested row, or a plain row, under a nested row) has that root as its identity parent, and so do the
  inner document's own rows. Both step by a localId, from two different documents. So when the inner
  prefab also nests the same prefab at the same row number under its own root, the two paths were
  identical and the two roots derived one guid. The resolver now leads `extra` with `@` whenever the
  identity parent is a nested root standing for a row of the entity's own frame. It is not a gone row:
  `moved`, the claim key and a prefab move's "back home" check skip it (`isFrameStep`), and the template
  tokenizer writes it for a written row under a written nested root, so a token names the path the reload
  derives. The FILE-side walk (`memberPathRecords` in `memberPaths.ts`, which Apply's "names nothing now"
  filter, the guid remaps and the scene-duplicate remint all read) takes it too, for a row whose parent row
  is a nested row. Without it an Apply of a move inside such a row reported success and wrote nothing
  (close-out review). No path without the shape changes. The corpus has none, and every scene saved since v16 stores
  these guids on its rows. ⚠️ Residual: a pre-v5 document (no `nodeGuid`s) holding the shape still
  cannot pick the owner between the two frames. The prefab-edit save writes v5, so an authored shape
  always has them.
- Until Phase 6 all of this was REMEMBERED on the member at move time, in `PrefabInstance.homeParent`
  (the row parent it left) and `homeSteps` (steps through homes since deleted). `rehomeDependents`
  re-pointed a home whenever it died. The home was always the template parent, so every walk gets the
  answer it got before, now from a source that cannot go stale behind it. There is one deliberate
  difference. A member whose template parent is a nested row that was DELETED used to keep the dead
  root's guid as its home, so it fell back to its live parent. It now steps past that row, which is what
  a reload derives. Since scene v16 a keyed member's guid is STORED on its row anyway, so only a member
  no row covers can see the difference.

**A created instance's members are stamped at tag time (#1461).** `moved`'s value is a member's live
guid, and so is a ref into a member — both are written on the assumption that a member's live guid is
the one the reload derives. **Create Prefab used to break that assumption and nothing else did.** It
turns a LIVE tree into an instance (`tagEntityTreeAsInstance`) while `serializePrefab` writes `guid: ''`
on every row, so the members kept the random guids they had as plain entities and the reload derived
different ones. Everything written in that window — until the first save+reload — named a guid that
would never exist again: the reported case was a member moved inside the new instance, lost on reload
with the loader warning `moved member "X": its parent <guid> is gone`; a ref INTO a member and an owned
NESTED instance's members failed the same way, unreported. The load-time pass cannot repair it, because
it fills EMPTY guids only.

So the tag ends by giving every member the guid the reload will derive
(`stampDerivedMemberGuids`, `runtime/core/ecs/memberHome.ts`) and carrying every ref onto it through
`applyGuidRemap` — `promoteOwnedRoots` (#1447) run in the other direction, sharing its walk, its
stored-root skip and its inverse. The ANCHOR keeps its guid (and must be durable: deriving from a
runtime guid, #1210, would bake identities the next reload cannot reproduce, so both callers mint with
`entityRef`→`ensureGuid` BEFORE tagging). A STORED root inside the tree keeps its guid too — it is the
anchor its own members derive from, and they are below this walk's floor. The tag returns the rename;
`unstampMemberGuids` reverses it for Create Prefab's undo.

⚠️ **Tagging records the NEW document at the root, and clears `ownerGuid`.** That is part of the fix
rather than housekeeping. A tag captures the tree AS IT STANDS, with every member at its row in the NEW
prefab, so a member that had been moved under the previous prefab must be read against the new document
and not the old one. Left stale, the stamp derives it from a path the reload does not walk and repoints
every ref onto a guid nothing will mint (close-out review F1). Until Phase 6 it was a stale
`homeParent`: `applyTag` names every field of `PrefabInstance` because koota's setter is a partial
merge. Now it would be a stale document, so a frame root's record answers only for the source it was
recorded under.

⚠️ **The rename is not a new identity change** — the reload performed it already, silently and with no
ref repair at all. This makes it eager and repaired. **`+added.<guid>` is NOT affected** (measured, and
pinned by a negative control): an added node's identity is its own durable guid and the loader spawns it
verbatim. **Not covered:** refs from OTHER FILES on disk to an entity that becomes a member — their guid
already changed at every reload before this, and repairing them needs `planMemberPathRepair` as Apply
does. Tests: `engine/tests/editor/createPrefabMemberIdentity.test.ts` (the round trips),
`stampDerivedMemberGuids.test.ts` (the walk's floor and ceiling),
`agentPrefabCreateUndo.test.ts` (undo, and the #1272 premise this fix removed).

⚠️ **Scene v16 narrowed all of this to the members it still applies to** — see § *Member identity is
STORED, not derived* above. Where the template minted identity, the save states each member's guid and
the load pins it, so the stamp skips those members and nothing is re-identified at all: a created
instance's members keep the guids they had as plain entities, and every ref keeps naming them. What
remains is a member of a PRE-v5 template, for which the window is exactly as described here.

**Save and load.** The save writes `moved: {rowLocalId: newParentGuid}` on the instance's entry, in a
`nestedStructure` slot, or on a reference node (scene v15, which a v14 reader refuses). The loader
expands the member at its row, derives every guid, and only then moves it (the per-World after-derive
queue, drained at the end of `deriveInstanceMemberGuids`). A removed row holding a moved member stays
until the drain, so the member derives through it first. Rebuild, delete, duplicate, revert and undo
each keep the home pair: a member of another instance moved in is parked and put back, a moved-out
member of a torn-down instance is torn down with it, and a delete detaches members whose instance goes.

**A member's guid is never an anchor.** `deriveInstanceMemberGuids` used to anchor on the nearest
ancestor with ANY guid. At load no member has one, so the walk reached the instance's anchor; a later
pass did not. Rebuilding an owned nested instance found the outer members' derived guids and anchored
there, so every member of the rebuild re-derived guids a reload does not reproduce. Measured with
nothing moved: Slot's guid changed on a rebuild of its MidRoot. That predated #1437, and applying a
move made it bite, because Apply rebuilds owned nested instances routinely. A member (linked to
another root, or an owned nested root) is now always walked through.

**Apply** (`applyToPrefabSelective`, key `~moved.<rowLocalId>`) writes the move where the prefab can
say it, and always takes the member's live Transform with it (its pose relative to the new parent):
- **The new parent is a row of the same frame**, or a plain node promoted by the same apply: the row
  is RE-PARENTED. That changes the member's path, so its guid and every guid below it change, in every
  instance. The references follow, in three places:
  - live: `liveMemberGuidRemap` pairs old and new paths per live instance, the rebuild translates what
    it looks up by guid, and `remapWorldGuidRefs` rewrites every trait value afterwards;
  - the prefab's own `@member:` tokens (`rewritePrefabMemberTokens`, runtime/loaders/memberPaths.ts);
  - every OTHER file: `/api/prefab-member-paths` runs `planMemberPathRepair` — scene guids through
    `memberGuidRemap`, prefab tokens through the token rewrite — over every file naming the prefab,
    transitively. A file an asset view holds unsaved is left and named (`ApplyResult.fileRepair`);
    undo and redo run it back from the document the files were last repaired for.
  Paths pair by IDENTITY (`memberPathRecords`: a localId per frame), so a row that goes from orphaned
  (parentId 0, hung off the instance's parent) to row-parented is followed across anchors.
- **The new parent is a member of a NESTED instance** (ruling (i): Handle → Lock/Bolt writes
  Door.prefab only), or a nested instance's root: the prefab gets its own `moved` entry,
  `"<member path>": "@member:<target path>"`. The row keeps its parent, so no guid changes. Hanging a
  row under a nested root instead would give it the path of the nested prefab's own row with that
  localId, and the two would derive one guid (review F1).
- **The new parent was added in the scene**: skipped with that reason unless the same apply promotes it.
- **A member of a NESTED instance moved out of it** (Lock's Bolt under Door's Frame): its own prefab cannot
  name the parent, so applied on the nested instance it is skipped, with a pointer outward. The OUTER
  instance offers it instead (owner, #1437 option B), as `~moved.<nested row chain>:<localId>`
  (`nestedFrameMoves`): Apply writes the outer prefab's own `moved` entry, by path, and the member's pose as
  an override on the nested row; the nested prefab is untouched and no guid moves. A move INSIDE the nested
  instance is not offered outward — its own prefab records it. Revert rebuilds without it (`nestedMoves.drop`
  on what the rebuild captures of the nested instance) and its undo sets it back. While a rebuild captures
  nested instances, an enclosing instance's move base is read from the document it was EXPANDED from
  (`expandedFrom`): read from the cache's newer copy during a refresh, a member not yet moved looked moved
  back, and the capture cancelled the move being applied. The Apply dialog toasts every skip and every file left unrepaired
  (`applyOutcomeNotice`).

**A prefab's own moves** (prefab v4, `PrefabFile.moved`) are queued by `queuePrefabMoves` as BASE moves
and resolved in the drain against the declaring instance's root. One move per member wins: an
instance's own over any prefab's, and a prefab nesting the instance (queued later) over the nested
prefab's. The capture compares against that base, so an instance at its prefab's target records
nothing, and one moved back to its row records the move back. The base climbs the ENCLOSING instances'
documents too (`prefabMoveTargets`), or a nested copy read its outer prefab's move as its own and saved it
in every instance (review F4). The moved-Transform exemption from the override mark gate applies only away
from the base, or every instance would pin its pose. Create Prefab / prefab-edit save (`serializePrefab` →
`templateMoves`) writes the new prefab's own map for every nested member not under the parent the prefab
would otherwise give it, and for a ROW sitting under a nested member: that row is written under the row it
derives from (`rowParentsFor` — its home, the prefab-edit hint, or the nearest row ancestor), never with
parent 0. Prefab-edit SHOWS the prefab's own moves (`applyEditWorldMoves`), and a nested row's edit-scene
entry carries its sentinel as its stored guid so its members are found by the guids `editGuidAt` gives
them; the nested capture never takes an edited prefab's row (`isPrefabEditRowGuid`) as its own addition.
Applying a `-removed` row stops the cascade at a moved member and lifts its row to the nearest surviving row
(a re-parent, so the ref repair follows), and drops a prefab move that names nothing any more. Promoting a user-added
instance carries its interior moves the same way, and deletes its members that were moved out of its
subtree, which the refresh respawns.

A prefab's move of a nested member survives everything that rebuilds the nested instance alone (an
apply or revert on it): `rebuildInstance` re-queues the moves of the documents around it
(`enclosingFrames`). Once an outer prefab places a member, only the outer instance can move it again —
back home included, which removes the entry; the nested instance's own Apply points outward. A row lifted
past removed rows is carried through their poses, so it stays where it was in every instance.

**Not covered.** An older build ignores a prefab's `moved` (the version is a writer-only stamp), so
such a member sits at its row there. A prefab move whose member no longer exists — the nested prefab
dropped that row — is skipped silently on load; the entry is cleaned up the next time the prefab that
holds it is applied. A row lifted past removed rows without a `Transform` of its own gets no carried pose,
and a carried pose under a non-uniformly scaled, rotated removed row is the nearest TRS, not exact. A ref into a node promoted by Apply still stays a guid, as
before. Tests: `engine/tests/editor/duplicateCarriesRefs.test.ts` (the #1437 describes),
`engine/tests/plugins/remintPrefabMemberRefs.test.ts` (memberGuidRemap, the token rewrite and
planMemberPathRepair against the loader), `engine/tests/plugins/prefabMemberPathsRoute.test.ts`.

### A template-added node's edits are stored on its own row (scene v17, #1516)

**A scene's edit to one node that a template row added is stored as that node's own row, holding only
what the scene changed — so the template keeps owning everything else about it and about its siblings.**
In v16 a member row's `added` was ONE statement for the whole list under a member, and it replaced the
chain's list (`foldMemberRowChannels`). So the first edit to any of those nodes made the save write them
all, and every untouched sibling was pinned: a later template change to it never reached the scene.
`removedTraits` had the same shape — a scene removing one more trait pinned every trait the chain removed.

- **Owner rule (2026-09-24): overwrites win, and a template change reaches every part the scene did not
  overwrite.** v17 delivers it at field granularity for template-added nodes. Option A (a keyed merge of
  whole edited nodes) was the smaller format and was rejected for this: under A, a scene that moved a
  lamp would still miss a later colour change to it.
- **The shapes.** A template-added plain node inside a nested frame gets a NODE row keyed
  `<frame chain>/a+<key>` — the frame's member-row key plus the node's template key LAST
  (`formatNodeRowKey`; `a+` is told from a guid by the `+`, never by the leading `a`). It carries
  `traits` (only the differing fields, merged over the node's; a trait the node lacks is added),
  `traitRemovals` (`true` drops a trait), `own` (the scene's children of that node, appended) and
  `removed: true`. A member row gains `own` — the scene's nodes under the member, APPENDED where `added`
  replaces — and `traitRemovals`, per-trait statements over the chain's list (`false` restores a trait
  the chain removed, the trait twin of `removed: false`). `added` and `removedTraits` keep their exact v16
  meaning: always read, written only as the fallback below.
- **Save: `diffFrameAdded` (`nodeRowDiff.ts`), live capture against the chain's nodes.** Matched by
  template key, children included (`liveTemplateKeys(…, deep)`). A field one side omits reads as its
  schema default — the live capture drops default-valued fields, a template bag may state them. That
  is also why no compaction step is needed: an earlier draft compacted both bags, and mutation showed it
  changed nothing. The #1511 note above records why comparing against the raw file bag failed; the
  default rule is what makes the two comparable.
- ⚠️ **A template node matches only under its OWN parent** — the member the chain anchors it to, or the
  template node whose `children` hold it. **Re-parenting a template-added node unlinks it (owner,
  2026-09-24)**: it is written as the scene's own node where it now sits, and the template's copy as
  `removed`, so only that node stops following the template, never its siblings. The owner's reason: the
  node belongs to the OUTER prefab, and a drag under an inner prefab's member moves it into another
  prefab. The same holds under a sibling template node — there is deliberately no `parent` channel on a
  node row.
- **Fallback to the v16 whole list** for a member whose list cannot be stated node by node: a chain node
  there with no key (a file from before keys), a key used twice in the frame, or an EDITED template
  REFERENCE node — its interior is a frame of its own and has no node-row address yet. That member's
  list is pinned exactly as in v16, and nothing else is.
- **Where the loader places a chain node is where the diff looks for it.** A node whose anchor row the
  inner document no longer has is re-anchored to the frame root, as `applyStructureCore` does; a node
  whose anchor is not LIVE (the scene deleted that member, or any member above it — `removed` lists only
  the top-most) went with it and gets no statement (`chainNodesAsPlaced`). Without the first, a no-op
  save read the loader's re-anchor as a re-parent and unlinked the node; without the second, a member
  below a deleted one read as live-but-changed, and the frame fell back to the pinning whole slot
  (close-out review F3/F4).
- **The template drops a node the scene edited (fork 2, owner):** the node vanishes with it. Its row is
  an orphan, warned and KEPT across saves by R2 exactly as a member row is, judged against the keys the
  template adds in THAT frame (`templateFrameKeys` — per frame, because a prefab-editor re-parent keeps a
  node's key, and a template-wide set read a node moved into another row's frame as still backed). So a
  template that brings the node back brings the edit back. A Refresh keeps the same rule, for member rows
  and node rows alike — see R2 below. The Refresh finds a template REFERENCE node's root by its key too, so a scene deletion of one survives
  it (re-review R3b).
- **A scene-deleted template node stays deleted** even if the template later edits it (fork 3).
- **Refresh.** The rebuild runs the same diff against the baseline (`captureNestedInstanceOverridesIn`,
  shared deps `nodeDiffDeps`), lets the fresh expansion spawn the NEW template's nodes, and patches each
  node row onto its fresh node (`applyNodeRowsLive`). So a Refresh delivers a template change to the
  unedited fields of an edited node, and honours a deletion — both gaps before v17. Only a fallback
  member keeps the #1386 whole-node replace.
- **Every walker of a row's nodes reads `memberRowNodes(row)`** — `added` plus `own`: the runtime ref
  collector, the reference-node and added-row collectors, the member-path walks and anchors, the build's
  tree-shaker (a miss drops the asset from the build, #53), a duplicate's remint, the serializer's path
  flags. Node rows ride the same loops. `sceneMemberRowReaders.test.ts` puts the only copy of a ref on
  each channel.
- **Not covered:** field-level edits inside a template
  reference node; per-field Apply/Revert of a node row; a template node anchored at an owned NESTED
  row's localId (the loader puts it under that row's root, the capture attributes it to the inner frame, so
  the diff reads it as re-parented — seen only in a hand-authored fixture, no writer known to produce it). **A scene saved before v17 is not un-pinned by
  resaving it:** the v16 list is read as the scene's state, so every field of a pinned node that has since
  drifted from the template is restated on that node's row and stays pinned. Only fields still equal to
  the template, and nodes still equal throughout, go back to the template.

### A prefab row states its nested frames per member (prefab v6, #1533)

**The prefab-side twin of the section above.** A prefab's nested ROW carried a nested frame's
structure only as the whole `nestedStructure[path]` slot, and the prefab-edit save wrote the frame's
full lists whenever anything in it differed from the chain. So an outer prefab that changed ONE thing
in a nested frame restated everything the inner prefabs put there, and a later edit to the inner prefab
stopped reaching the outer one. The first repro: MID's row removes `Leaf`, OUTER adds one node beside
it, and after MID restores `Leaf`, OUTER still hides it.

- **The shape: the scene's member rows, on the row.** A nested row gains `members`, keyed from its own
  expansion with the scene's grammar (`/<frame chain>/<nodeGuid>`, node rows `…/a+<key>`), holding the
  same structural channels: `removed`, `traitRemovals`, `own`, node rows' `traits`/`traitRemovals`/`own`/
  `removed`, and the fallback `added`/`removedTraits`. It holds **no identity** (`guid`, `name`,
  `parent`), because a template never carries per-instance identity (#1293). Values stay in
  `nestedOverrides`, which was per field already. The writer uses it for NESTED frames only: the row's
  direct `added`/`removed`/`removedTraits` are its own statements over template members and never pinned
  anything.
- **One writer.** Both writers of a row's channels share `captureRowChannels`: a prefab-edit save or
  Create Prefab (`planPrefabRows`), and Apply's promotion of a reference node. The promotion used to copy
  the node's whole scene-form slot onto the new row, which was the pin by another route (close-out review
  F2). The helper hands the row's captured `nestedStructure` to the scene writer's own split
  (`moveChannelsOntoRows`, `template: true`), so the two carriers cannot disagree about what counts as
  an edit. Template mode changes two things. Every KEYED member may carry a row: the scene's
  durable-guid gate exists because a scene row states a guid, and a template row states none. And
  nodes are written in template form, found by the template key the capture stamped on the live
  entity (`templateFormOf`), where the scene writer finds its nodes by guid. `serializePrefab` then
  tokenizes each row in the frame it applies in (`tokenizeRowMembers`). A frame the split cannot state
  member by member stays whole in the slot and keeps #1381's no-op rule, exactly as a scene's
  fallback frame does.
- **Layers, not a merge (`descendStructureLayers` / `foldStructureLayers`, `prefabOverrides.ts`).**
  Both spawners, the baseline resolver and the prefab-edit world read the same helpers. Structure now
  reaches a frame as a list of LAYERS, innermost first: the row that expands the frame, then each
  enclosing row, then the scene entry or reference node. Each layer is folded over the result of the
  one inside it.
  - **Why the rows cannot be merged:** a member row's `added` states the member's whole list, and that
    list already contains what the layers inside it appended through `own`. Merging two layers' rows
    key by key would spawn those nodes twice.
  - **Why the slots are kept apart as well:** a slot owns its frame whole, and it was captured from a
    live interior that already showed every layer inside it. So at that frame the rows of the inner
    layers are dropped (`foldFrom`). What they say about the frames BELOW still applies, because a slot
    owns one frame. That covers their deeper rows, and also a nested ROOT's row, whose interior half
    (`own`, `traitRemovals`) is forwarded even from a dropped layer. Missing the second part lost a
    prefab row's additions under a nested root whenever a scene slot sat one frame up (review F1). Once there are two
    row layers, a merged slot map cannot say which layer a slot came from, and without that the loader
    would re-apply a row's deletion over a scene slot that un-deleted the member.
- **The scene over a row.** `resolveEffectivePrefabStructure` folds the row layers along the path, so
  a scene's baseline includes what the prefab rows state and an untouched scene writes nothing for them.
  A scene row that un-deletes what a prefab row deleted is folded after it, and wins.
- **The prefab-edit world** forwards a row's `members` onto the scene entry it builds, rebasing member
  tokens at the depth of the frame each row applies in (`byRowDepth`). Only the documents can tell
  whether a key's last component names a member or a nested root. A row the load could not match is
  kept (R2, under the edit world's stored root guid), and `captureRowChannels` writes it back out,
  as the scene writer does (review F3). It does that under an edit-world sentinel ONLY. Under a scene
  root (Create Prefab, Apply's promotion) the kept rows are scene rows, with member guids and nodes
  carrying scene guids, and in a template every instance would spawn them with one guid (#1293,
  re-review).
- **Readers.** Two walkers already read `members` on ANY carrier: the build's tree-shaker
  (`walkCarrier`) and the duplicate remint (`asset-fs-ops`). The runtime collector does too, and
  `SceneManager` runs it over a cached prefab's entities. `templateKeysOf` (the key heal's candidates)
  and `memberPaths` (ref remaps across moves) were extended. The member-path walk unions a row's rows
  with the ones handed down, because over-generating is harmless there.
- **Format: prefab v6.** Following the owner's ruling on #1468 (option B), an older build OPENS a v6
  prefab normally and shows the inner template through for rowed frames. The write gate stops it
  saving over the file, which would drop the rows. No migration: the committed corpus had no row using
  the slot (scan 2026-09-25: 105 tracked prefabs, 118 nested rows, every one v5 with a `nodeGuid` on
  every row. An earlier count of 250 prefabs / 441 rows, 145 of them pre-v5, walked the untracked build
  copies under `dist/`, `ios/` and `android/` too).
- **Not covered:**
  - A frame through a pre-v5 inner prefab (no `nodeGuid`) cannot be keyed, so it stays on the pinning
    slot, as on the scene side. No tracked prefab is pre-v5 today; one from an older project would be.
  - `memberPaths` does not walk the `own` children of a template NODE row. A ref to one is not
    followed across a move.
  - Apply's promotion does not tokenize, so a row node holding a ref to a member keeps the live guid,
    as the promoted slot always did.
  - Everything the v17 section above lists as not covered also applies here.

### A template reference node is written by the row writer (#1538)

**The third carrier, brought to the row's rules.** A reference node a prefab TEMPLATE authors — an
`added` node carrying `prefab`, in a row's `added`, a slot's or a member row's — was written by
`captureNestedRef` with the scene's rule, and so had none of what the row writer had gained:
- no `omitUnchanged` (#1381): every non-empty frame was restated, so an untouched save pinned the inner
  prefab's own statements (MID's row removes `Leaf`; OUTER2 saved untouched; MID restores `Leaf`; OUTER2
  still hid it);
- no member rows (#1533): an edit anywhere in the node's frames restated the whole frame;
- no tokenization (#1352): `templateTokenizer` leaves a reference node whole, so a member ref inside it
  was written as the edit world's live guid and named nothing in any instance.

What changed:
- **One writer.** In template form `captureNestedRef` hands the node to `finishTemplateReferenceNode`:
  `captureRowChannels` (deferred compare), then the step `serializePrefab` runs for a row, extracted as
  `finishRowChannels` — tokenize each payload in the frame it applies in, THEN drop an unchanged slot,
  tokenize `nestedOverrides` and `members`. It runs over a tokenizer rooted at the node's OWN frame
  (`templateTokenizer(…, ownFrame)`), indexed with `memberPathIndex`, which is what the loader resolves
  against. At capture time rather than deferred to `serializePrefab`: node identity is lost before then
  (`templateFormOf` and `chainNodesAsPlaced` copy nodes), and the comparers below need the file's bytes.
  A token may step only through a key some file declares, and both template writers now ask that of
  what they WRITE and the prefabs it nests (`declaredTemplateKeys`) — never of every cached document:
  prefab-edit keeps the OLD copy of the file being saved in the cache until the write lands, so a key it
  declared in a slot the save drops stayed "declared", and the token through it named nothing on reload.
  ⚠️ That makes the written value a guid, and **the ref still dangles in the one case that reaches it**: a
  legacy key-less node an old file's slot re-stated under a key. The edit world spawned it from the slot,
  so its guid derives through that key; the dropped slot then lets the reload spawn it with its own legacy
  guid. Writing the right value needs the baseline node's identity, which the no-op compare does not
  hand back. Narrow (an old-writer file over a pre-v5 inner prefab's legacy node) and not a regression —
  the token it replaced named nothing too.
- **The node consumes the nested instances it owns.** Like a row (#1382), a template reference node
  re-expands every owned nested instance inside it, so its capture counts them as consumed. It did not,
  before #1538 too: `planPrefabRows` took MID's own INNER, inside the node, for a free-standing nested
  instance and wrote it again as a row at the prefab root, so every instance spawned a duplicate.
- **The node is its own token frame.** The loaders open a token scope at a reference node's top
  instantiate call and never resolve a `^` out of it (`loadSceneFile.ts`, `if (!t || t.up) return
  token`), so the writer never climbs out either: `enclosing(root)` is 0. A ref from inside the node to a
  member of the prefab AROUND it therefore stays a guid — the one case not covered, since it needs the
  loader to resolve across the call: #1541 (observed: the edit world's placeholder guid is saved, and
  names nothing in any instance).
- **Member rows on a template node — owner's decision (2026-09-25).** #1293 kept `members` off template
  nodes for two reasons: a member row stated a per-instance guid, and the frozen format had no rows. A
  template-form row keys by `nodeGuid` paths and carries no guid (the #1533 rows already do this on a
  prefab row), and v6 has rows. So a template reference node carries them. **No kept orphan rows go
  back out for it**, and that is a real loss, not only a safe default: R2's store is keyed by a stored
  root guid, which a template reference root does not have. So a row whose member the inner prefab
  dropped is erased by the next save of the outer prefab, and the edit does not come back when the
  member does. A prefab row keeps it. #1542. Nor does a template node state a MOVE: a member re-parented
  inside it in the prefab editor reloads under its template parent (#1543: a template capture records
  no moves, and a template row carries no `parent`).
- **The comparers ask both forms (`sameAddedNode`).** `nodeDiffDeps.sameReference` (the scene and row
  writers' node diff) and `subtractChainStructure` (the rebuild, and `ownInstanceStructure`) matched a
  live node's scene-form capture to the chain's node. A node the template writer wrote omits and
  tokenizes where the live capture restates and holds guids, so every such node read as EDITED — pinned
  again by the next scene save and respawned by every rebuild. A chain node holding a template reference
  node is now also compared against the live node written as a template would write it (read-only: a
  key is read or recovered, never minted or stamped, or a scene-authored node would be taken for a
  template-added one). Either form matching is unchanged, so an older file still compares as it did. A
  live node carrying instance identity (a member guid the scene stored, a member it moved — on a row,
  or in a nested slot's `moved` where no row can key the member) is edited whatever the template form
  says: that form has no place for it.
  ⚠️ **The second compare costs a template capture per reference node.** It runs only when the
  scene-form compare differs, which is every untouched template reference node written by the template
  writer. Measured by the close-out review: 60 such instances in a 2481-entity scene, one save 2308 ms →
  3002 ms (about 12 ms per node, growing with world size: the tokenizer indexes the whole world). No
  tracked scene has one today.
- **Readers.** The runtime loader already folded a reference node's `members`. The editor's own spawn
  passed them only as re-parent statements; it now folds the node's slots and rows as the outermost
  layer, as the loader does. The #1506 enclosing layer folds them at the node's frame and seeds them into
  the chain below it. `templateKeysOf` walks them. The prefab-edit world's token rewrite leaves a
  reference node whole (`editWorldRefs`), since a `^` inside it climbs only to the node's root. Apply's
  promotion re-captures at every depth (above). The tree-shaker, the remint, `memberPaths` and the
  resource collector already read `members` on any carrier.
- **Format.** No bump: v6 had not shipped, and no tracked prefab holds a template reference node (scan
  2026-09-25).
- **Tests:** `engine/tests/editor/templateReferenceNodeRows.test.ts`, one per symptom and per reader,
  each mutation-checked.

### The #1468 design record — why identity is stored this way

The design, the decisions and the rules behind scene v16 and prefab v5. The plan that carried them
(#1468's member-identity plan) was folded in here and deleted as its last two follow-ups (#1480,
#1484) closed. Its handover notes, per-phase checklists and review transcripts are in git
(`git log --all -- '*prefab-member-identity-plan.md'`). Code comments cite the labels below
(**D1**-**D4**, **R1**-**R8**) as *"#1468 design record"*.

**The bar** (owner, 2026-09-22): *"I want to make sure we implement this right, because I don't want to
do another restructure for prefabs and nested prefabs."* A second restructure of this subsystem is the
failure to avoid, more than lateness and more than an imperfect first cut.

**The problem.** A member had no stored identity: its guid was derived at load as
`deriveMemberGuid(anchor, path)`. That is not arbitrary, because a TEMPLATE cannot store member guids
without every instance sharing them (#1387). The arithmetic had one spelling. The fragility was the
ANCESTOR WALK around it, mirrored three times (the load-time derive, the file-side prediction
`memberPathRecords`, the live-subtree prediction `planCopyGuids`) under a *"change all three"* comment.
Five more sites answered *"which member is this?"* by re-deriving and comparing, and each failed silently
when the equality did not hold. The payoff that justified a format bump was unifying the key space, not
only preserving identity. No open issue beyond #1468 needed it; it was preventive.

**Rejected, with reasons, so they are not re-proposed:**
- **Warn, don't fix.** Dragging a member out of an instance already unpacks it (a plain entity keeps
  its guid), so the only everyday way to lose identity was Create Prefab, and a warning naming the files
  that would dangle was a real option. Rejected by the owner's bar.
- **Store the guid in the existing `overrides` channel** (no format bump). It inherits the dead end's
  first fault exactly: `remintSceneEntityGuids` is a KNOWN-FIELD walk and does not read guids there. Its
  one real advantage was REVERSIBILITY (no bump, nothing spent), which is what D2 answers.
- **The dead end: a bare per-instance `memberGuids` map**, written where the live guid differs from the
  derivation. It was prototyped and worked (tag `proof/1468-guid-map`). It was still wrong, twice: the
  remint walk could not see a novel field, so a duplicate copied pinned identities verbatim into two
  files (the #1293 hazard); and "live guid differs from derivation" is the classifier
  `copyIdentity.ts` records as wrong in both directions (#1338 review). Rows make the first fault a
  one-line addition to the remint walk. Only D3 closes the second.

**The root cause: `localId` is POSITIONAL, and five production paths renumber it.** `planPrefabRows`'
positional branch numbers rows by BFS position whenever `preserveLocalIds` is absent, and only prefab
edit passes it. The five: rigged model re-import (a name match that misses on a bone rename), the Skin
Editor's update, Create Prefab → Replace, Assets → Import Model, and the agent's `modoki_prefab create`
over an existing path. `prefabSerializeCallSites.test.ts` now makes every writer declare where its file
guid comes from. Two hazards break the same key without renumbering anything: a freed number is REUSED
(the allocation ceiling is the max over surviving rows), and a re-parented row changes a path without
changing an id. **"Reused" is the argument that decided the node guid:** a stale number silently names a
DIFFERENT node, and nothing can detect that; a minted guid is never recycled, so a stale one can only
dangle, and R2 makes a dangle loud.

**The node guid (prefab v5), stored ALONGSIDE `localId`** (owner ruling: in scope for this work, not a
future ticket; alongside, not replacing). `localId` keeps its jobs as the array key and the numeric
`parentId` wiring; removing it would rewrite ~165 references and every authored prefab to delete a
field that becomes inert rather than wrong. Two parts, and neither is enough alone: identity is MINTED
and stored (`nodeGuidsFor`, at the write and nowhere else, never on read), and re-association across a
REGENERATION is content-derived (`riggedEntityIdentity` carries the node guid forward on a rigged
re-import). ⚠️ **Nothing survives a DCC rename**: the GLB carries no modoki guid, so a renamed bone misses
whatever it carries. The goal is containment: one orphaned row and a log line, not a silently re-pointed
subtree. Minting also needs no seed change, because derivation still reads `localId`s, so no derived
guid moved.

**D1 — the row key is FLAT: one identity component per instance FRAME, not an ancestor chain** (owner,
2026-09-22). A template re-parent re-keys nothing (the most common template edit there is), and a broken
identity orphans ONE row instead of every descendant's. `memberPathRecords` already separated a path from
an identity, and #1437 already paired two documents by identity, so the key consumes existing machinery.
Accepted costs: size (below); resolving a member's actual position takes a lookup; and ⚠️ **an illegal
state becomes REPRESENTABLE**. Under path addressing, *"a member of X living outside X"* could not be
written down, because no route leaves the frame. Under identity addressing it is well-formed and wrong,
so the invariant is enforced by code: R8.

**D2 — the rows carry the collapsed channels FROM THE START** (owner, option (b)). One scene format
change, not two: the later phases (`parent`, then the edits) became caller migrations onto slots v16
already declared. The alternative was proving the later phase on paper and gating the bump on the proof.
It was rejected because paper reasoning about this subsystem had failed three times. ⚠️ Accepted cost:
the irreversible phase and the riskiest phase are the same phase.

**D3 — a duplicate rebuilds every row's guid, unconditionally.** Closed by elimination rather than
ruled: *inherit* is #1293 (two files naming one entity, which the owner ruled against), and anything
between inherit and rebuild is the rejected live-value classifier. The decision is by STRUCTURE ("this
is a member row"), so `copyIdentity.ts`'s rule stands.

**D4 — prefabs got a format gate, AND a lost identity is loud** (owner: both, not either). This
**reverses #365**, which chose a writer-only stamp on purpose; `docs/format-versioning.md` records the
reversal. An older build saving a v5 prefab would drop every node guid while keeping the file guid, so
instances stay linked to a document whose identity was erased. Disposition (owner, 2026-09-23):
**refuse to SAVE, not to load**. Only the editor ever writes a prefab, so a save-side refusal covers the
whole hazard and costs the runtime nothing. The gate is one-directional, `version > PREFAB_FORMAT_VERSION`,
⚠️ **never `!==`**: every authored prefab was behind the constant when this was decided, so `!==` would
have refused all 105 of them on first load. It is server-side at the byte-writing seam
(`plugins/prefabWriteGuard.ts`, at `/api/write-file` and the watcher's `writeAssetGuid`), because a
census found 17 write paths: 4 went through `writePrefabFile` and 8 through the client wrapper. The gate is prevention and R2 is
detection. They fail in different directions, and a gate that is itself wrong fails silently again, so
do not drop R2 as redundant. R2 is also the only protection for a shipped game on an older engine
reading a newer prefab, because nothing there saves.

**The reconciliation rules:**
- **R1 — the storage key is not the matching key.** A row is STORED under its identity key (D1) and
  MATCHED to a template member by identity. The PATH spelling (`.`-joined steps, `|`-joined frames) still
  exists and still derives the fallback guid; the two must not be collapsed.
- **R2 — a row with no template member** is kept across saves and logged once, by name, and never
  silently dropped (a silent drop is #1468 reproduced). A member the instance REMOVED is still in the
  template, so its row is not an orphan. This is why rows keep `name` (owner, 2026-09-23): an orphan's
  template member is gone, so only the row can name it in the log.
  **A rebuild (Refresh, Apply, Revert, and each one's undo) leaves the kept store exactly as a reload
  of the same scene would (#1535)**, because it is the other route a template change reaches an open
  scene by. It used to keep only half: a row's guid, and the node rows of a frame it captured. So a
  template that dropped a member and brought it back lost the scene's edit to it in the editor, at any
  depth, while the file still held it. And a Refresh that DROPPED a member threw its row away, where a
  reload keeps it for the template edit to be undone. `captureRowsForSettle` reads, before the teardown,
  what a save would write for every frame the teardown destroys. It reads against the document the tree
  was built from, not the cache's new one. After the re-apply it asks the loader's own orphan test
  (`rowBackedTest`, one spelling for both) of the new template:
  - a row it no longer backs is kept, minus any `added`/`own` node the re-apply RE-HOMED. An addition
    whose anchor is gone moves to the instance root live (the Refresh reconciliation rule), and is saved
    there. Kept in the row too, a restore of the member spawned it a second time, with the same guid.
    ⚠️ This is the one place a Refresh and a reload still differ: a reload leaves such a node inside the
    orphan row (gone until the member returns), while a Refresh keeps it at the root;
  - a kept row it backs again is replayed onto its target and leaves the store (`replayRowsLive`: the
    loader's fold, outside in, then node rows, then guids and moves). Left in, a save would re-emit it
    over a later live edit;
  - the rest stay.

  The replay folds over an empty lower layer, where the loader folds over the chain's. So a trait the
  row keeps that the CHAIN removed is added back from the target's template row: named by a `false` in
  `traitRemovals`, or left out of a v16 `removedTraits` list. For an owned nested root, that is its child
  document's root row. ⚠️ **Not replayed live:** a kept `removed: false`. The chain has already cut the
  member from the fresh expansion, so there is nothing to apply it to. The row stays kept, the save
  writes it, and it applies on the next load.

  The store must be CURRENT for this to be safe, since a replay acts on whatever holds the key. So every
  load resets it for every instance root and reference node it loads, an entry with no rows included (it
  keeps none). The save capture is skipped only for a rebuild onto the SAME document with nothing kept
  (a Revert, an undo's direct rebuild). A cheaper "can any row become unbacked" test is a second copy of
  `rowBackedTest`: the first try compared only the changed document, missed a nested row's `prefab`
  ref, and lost an edit.
  ⚠️ A restored trait comes from the raw template row. Its member tokens are not rebased, the legacy
  migrations are not run, and an inner layer's field override on it is not applied, until a reload.
- **R3 — a template member with no row** derives, as before, and gets a row on the next save. This is
  the v15 → v16 migration path and the normal state of every older scene. No warning.
- **R4 — a template re-parent** is not a reconciliation case under D1: nothing re-keys. It is also why
  `parent` is a DIFF, not the live parent (above).
- **R5 — a renumbered `localId`** is survived by the node guid; where that also breaks, R2 applies.
- **R6 — a duplicate** rebuilds every row's guid (D3).
- **R7 — promoting an owned nested root** relocates its rows to the new entry and PRESERVES the guids.
  ⚠️ A deliberate divergence from the QA-measured contract, which recorded the members as re-derived.
- **R8 — frame containment.** A row's `parent` must resolve inside the row's own frame. A move INSIDE an
  instance is a re-parent that keeps the link; a move OUT of it is an unpack. Enforced by code because
  the encoding no longer enforces it. `memberRowsIn` follows IDENTITY, not the ECS parent chain, and that
  one choice enforces R8 on the save and keeps a member moved beside its frame from being re-keyed.
  Dragging out a nested ROOT is neither: it is a promotion (R7).

**The row shape.** `members` is a MAP keyed by identity, not an array of rows carrying a `key`. Every
other structural channel is already an identity-keyed map, a map is 17 B/row smaller, and a duplicate
key is unrepresentable. A key component is a node guid iff `isGuid(component)`, ⚠️ **never judged by its
first letter**: a guid can start with `a`, and `a+<key>` / `ar` / `a0` are disjoint from a guid by the
`+` and by length. `nestedOverrides` and `nestedStructure` needed no slot on the row: they existed only
because a member two frames down had no address, and the frame-chained key gives it one. **A row exists
only where the template minted a `nodeGuid`.** That prunes on a FORMAT capability of the template, not
on a live value, so it is not the rejected classifier. Keying a pre-v5 member's row by `localId` instead
would orphan every such row the moment that prefab is re-saved and minted, and it is the positional
address that repoints.

**The cost, measured on the corpus with GUID keys (2026-09-23):** 1 042 rows over 29 instances in 13 of
71 scenes; the shipped shape adds **+56%** overall and **+293%** (78 KB) to `alien-animal`, whose 516
rows are almost all bones that nothing addresses by guid. The identity itself is 61% of that and no
encoding avoids it. The cheaper bare `key → guid` map (+33%) is ruled out by D2, since a row with no
object has nowhere to hold the channels. Every measured row sat at frame depth 1, so a nested frame's
per-row cost (a 73-character key) is unmeasured, not zero.

**What shaped the later phases:**
- **Finding A:** the instance ROOT has no row (it IS the entry), so its overrides stay on the entry.
- **Finding B, and the Phase 4 ruling (owner, option B):** the `localId` key space could not be
  deleted, because the population is pre-v5. Every prefab the released editor wrote has no `nodeGuid`,
  and every v15 scene stores its edits only by `localId`. This repo's corpus was migrated
  (`migrate-prefabs-v5.mjs`, pinned by `prefabCorpusNodeGuids.test.ts` on the guid rather than the
  version). A user's corpus cannot be. So the `localId` channels are LEGACY: always read, and written
  only for what no row can key. Option B also moved the editor's own cross-call addressing (the
  Apply/Revert keys, `modoki_prefab`) onto identity. Its real gain over rows-in-files-only is the KEY
  grammar: an agent lists keys, a reload renumbers underneath it, and a numeric key then names another
  member. (The first rationale given for it, a rebuild across a renumbering template, named a path
  nothing takes today; it was corrected the same day.)
- **No corpus rewrite for scenes.** Files move to the current version when someone saves them, as they
  always have; rewriting scenes would make every older clone refuse them. The starter template's scene
  is the one exception, so the scaffolder does not emit a migrating scene. Prefabs were rewritten
  because a prefab has no refuse hazard (the gate refuses only a NEWER file).
- **The home fields had three roles, and stored rows retired only one** (measured by neutralising them:
  1 test red for derivation, 40 for the other two). Ownership of a moved owned nested root and the
  template position prefab files name members by now come from the document and `ownerGuid` (Phase 6,
  "Identity does not move" above).
- **One step grammar and one anchor classifier** (Phase 1: `parseStep`/`memberPathSteps` and
  `isStoredRoot`/`isOwnedRoot`/`isDerivedMember`/`entityStep` in `runtime/core/assetRefRules.ts`, guarded
  by `memberStepGrammarIsShared.test.ts`). ⚠️ The file-side walk (`memberPathRecords`) takes the grammar
  but NOT the classifier: it walks prefab DOCUMENTS, which have no `PrefabInstance`, and its equivalent
  test is "this node carries its own guid". One function over both would need a fake `rootInstanceId`.
  `planCopyGuids` asks a different question under a similar name and is deliberately not a caller of
  `isDerivedMember`. ⚠️ `parseSteps('')` is `[0]` and `memberPathSteps('')` is `[]`. Do not collapse
  them: derived guids are persisted and frozen, and an empty segment has always seeded `'0'`.
- **The prefab-edit sentinel was NOT retired.** Prefab edit still smuggles a `localId` through
  `EntityAttributes.guid` (`__prefab-edit-local-…`). Retiring it needs every document to carry a
  `nodeGuid`, and a pre-v5 prefab opened for editing has none, so it would have meant shipping both
  mechanisms. It works; it is not a defect. Prefab edit keeps derivation as its SOLE identity: there is
  no scene entry to hold rows, and the document being edited is the one the rows would be about.
- ⚠️ **OTA:** a bundle built with this engine carries v16 scenes, but the sub-game gate is
  `ENGINE_API_VERSION` exact-equality, which a scene format bump does not move. An older host registers
  such a sub-game and then refuses its scenes at load.

**Lessons the work paid for, kept because they generalise:** a design bullet that reads as feasible is
not feasible until someone reads what the code does (revision 2's Phase 1 was not). Three wrong facts
entered the plan from reviews, and a one-line grep caught what two review passes missed. Across the
close-outs, the best findings were not in the mechanisms. They were places where the author had
asserted completeness ("every per-instance identity is dropped here"; "a test asserts the writer omits
them") from the shape of a change rather than from the thing it described.

## What each hierarchy action does

Measured headlessly with the real editor functions (`reparentEntity`, `deleteEntitiesWithUndo`, `serializeScene`
→ `loadSceneFile`, `applyToPrefabSelective`). The fixture is `Outer` (`OuterRoot → Panel → {Button, nested Inner}`)
and `Inner` (`InnerRoot → {Leaf, Leaf2}`), with a second `Outer` instance to confirm Apply reaches it. Every
row round-trips through save + reload.

| Action | The dragged thing afterwards | Apply on the outer instance | Apply on the nested instance |
|---|---|---|---|
| Create / drag a plain entity under an outer member | plain, an `added` node | becomes an Outer member | — |
| Create / drag a plain entity under a nested member | plain, in `nestedStructure` | nothing to apply | becomes an **Inner** member (every Inner) |
| Drag an outer member out of the instance | unpacked; the instance records it `removed` | removed from Outer | — |
| Drag a member to another parent inside the instance | stays linked, its row records `parent` | re-parents the row | — |
| Drop a user-added instance's root under its own member | that member is unpacked (#1450); the instance stays linked under it | — | — |
| Drag a nested member into the outer instance | stays linked | Outer records the move (`moved` map) | refused, pointing outward |
| Drag an outer member into the nested instance | stays linked | Outer records the move | — |
| Drag a nested member out of everything | unpacked | nothing to apply | removed from Inner |
| **Drag a nested instance out of everything** | **stays an Inner instance** (#1447); Outer records the row `removed` | removes the row | — |
| Drag a nested instance to another outer member | stays linked | re-parents the row | — |
| Delete an outer member / the nested instance / a nested member | — | removes it from Outer / removes the row / nothing | — / — / removes it from Inner |
| Drag a prefab instance into the outer instance | stays linked, a reference node | becomes a nested row | — |
| Drag a prefab instance under a nested member | stays linked | nothing to apply | becomes a nested row of Inner |
| Drag a member into ANOTHER instance | unpacked (#1445): the old instance records it `removed`, the new one saves it as `added` | — | — |
| Drag an instance into an instance of the SAME prefab | allowed, a reference node (#1436) | **refused**, with a reason: a prefab cannot contain itself (#1446) | — |

A linked member is written by its **frame**'s save: the first promoted root on its ownership chain, or else
the stored root (top-level or user-added) that chain reaches. A frame is saved from its root down. So after
EVERY reparent (`planMoveUnlinks`), a linked member is unpacked in exactly the two shapes the save cannot
write: it sits ABOVE its frame, or the outermost instance it sits inside differs from its frame's. Written
nowhere, both it and the instance vanished on reload. A member merely BESIDE its frame inside the same
outermost instance is an ordinary #1437 move and stays linked.

This is also the rule for a move that stays INSIDE the instance (#1450, owner ruling 2026-09-19: unpack, not
refuse as a cycle). Drag a user-added instance's member beside its root, then drop the root under that member:
the member unpacks into a plain entity, saved as the outer instance's `added` node, and the instance hangs
under it. An **owned** nested root is not a frame, because its members are saved by the stored root above it.
So an owned root dropped under its own member keeps that member linked. The same holds two levels down (a
`Mid` dropped under a member of the `Inner` its row expanded), and both reload as moves. The frame was once
only a PROMOTED root, and only the leave path checked it.

**An owned root the save cannot write is PROMOTED, never unpacked** (#1447's rule, #1450 close-out review).
Drop a stored `Mid` under the `Inner` its own row expanded, and that `Inner` now sits above its frame. It
becomes a standalone instance, and it is the frame its own members are judged against after that. The first
version put the owned root through the member path and unpacked it. `Inner`'s `Leaf`, moved beside it, then
named a plain entity as its root, and the save dropped it.

**Verdicts are settled one at a time**, re-judging everything after each. This is because one verdict can flip
another:
- A promotion changes the frame for everything owned below it.
- An unpack can leave whatever hangs below it outside every instance.

The second review measured three failures when the loop instead acted on the whole list in storage order:
- A member under an unpacked member stayed linked, and the save dropped it.
- An owned root under an unpacked member stayed owned, and it reloaded under new guids.
- With `Inner` ahead of its `Mid` in the entity list, both were promoted, which cut `Inner` off `Mid`'s row for
  good.

Each pass acts on an entity whose verdict nothing else pending can flip: nothing unwritable sits above it in
the tree, and nothing unwritable sits on its ownership chain. Failing that, it acts on the shallowest entity
that has no unwritable owned root on its chain, so an owner is still settled before the roots it owns. (The
plain shallowest pick promoted an `Inner` ahead of its `Mid`.) Promotions and unpacks only ever grow, so the
loop ends.

A third way to be unwritable (close-out review 3): the entity's live parent is being unpacked, and the
entity has not moved (it sits at its row). Take a move inside the instance, which changes no outermost
instance: an owned root under the unpacked member used to reload as a stored root under new guids, and a
member there reloaded as a plain entity while the editor still showed it linked. (Until Phase 6 this read
"has no recorded home". "Not moved" is the same set, now read from the document.)

**The loader applies moves against the tree they describe** (#1452). The recorded moves (row `parent`s, and a
prefab's own `moved`) describe the tree
after all of them, so a member moved under a member that was its row descendant (Button up to the root, then
Panel under Button) passes through a cycle that exists only halfway. `drainAfterDerive` lets a move whose
target still sits inside the member wait until the others land. Only a move that is still waiting once
nothing else can move is refused, with the "inside it; left at its row" warning. Applied in order, Panel's
move was refused and it reloaded at its row. The drain mixes the prefab's own moves with the instance's, and
the same shape can be split across the two: Button's move is the prefab's and Panel's is the instance's. The
wait covers that case as well.

**Ending a moved member's frame promotes or unlinks it, never re-homes it past the owner (#1451, #1453).** A
surviving member whose template parent is deleted needs nothing: the resolver steps past the gone row. (Until
Phase 6, `rehomeDependents` re-pointed its home.) The climb never passes the FRAME root, and that frame dies
with it. `detachOrphanedMembers` then promotes an owned nested root to a stored one, renaming its members to the
guids a reload derives (the #1447 contract), and unlinks anything else. It promotes when the root's OWNER dies:
its owner link when it was moved, else its live parent's frame. A nested root that rode out inside a moved
member of its owner was never moved itself. Keying on a home left it linked to a dead frame, so its members
re-derived new guids on reload and a ref to one dangled.

A frame also ends WITHOUT a delete, when a Detach Prefab or an unpack-on-leave strips `PrefabInstance` off it, and
the same step applies. Every frame-ending path calls it as **`endFrames(gone)`** (`memberHome.ts`), before the
strip, because the owner walk reads the links being stripped. The callers are `deleteEntities`,
`detachPrefabInstance` and `reparentEntity`'s `applyDetach`. Detach and unpack used to run only the re-homing
half (`rehomeDependents`, deleted in Phase 6), so a member moved OUT of the detached subtree kept its link to a
frame that no longer existed. The save wrote it nowhere, and it vanished on reload (#1453). There were two shapes. One was a nested
root moved beside its detached owner, left owned by a plain entity. The other was a plain member moved beside it,
left linked to a plain root. Now Detach Prefab turns the first into a standalone instance, which is the #1447 rule,
and unlinks the second where it stands. The unpack-on-leave runs `endFrames` too, so that every frame-ending
path has one shape. Before #1450, `planLeaveInstance` could strip an owned ROOT while a member of it stayed linked.
Since #1450, `planMoveUnlinks` sends every root to `promote`, never `strip`, so that orphan step currently has
nothing to catch there. `detachPrefabInstance` returns `{ links, orphans }`, and `reattachPrefabInstance` relinks the orphans
(`relinkDetachedMembers`) before it re-adds the links, because a promotion's member rename has to be reversed
before any guid ref resolves. A redo re-detaches, and that is deterministic (the same promotions and the same
renames), so the first snapshot still undoes it.

**No generic trait edit touches `PrefabInstance` (#1454, owner chose to refuse).** It is a prefab LINK, not a
component. It is made by instantiating a prefab and cut only by Detach Prefab, which ends the frame as above. The
Inspector used to offer it a remove button, and the agent's `mutate_scene removeTrait` accepted it. Both cut the
link without `endFrames`, so the members moved out of the instance vanished on reload. Removing it from one
member also left that member's row expanding beside it on reload. So one policy, `traitEditPolicy.ts`
(`traitRemoveRefusal` / `traitWriteRefusal`), now refuses to add, remove or write it on every generic path, and
names Detach Prefab in the refusal. It also holds the core traits that can never be removed (Transform,
EntityAttributes). The paths are: the Inspector remove button, the Add Component picker,
`add`/`removeTraitFromEntitiesWithUndo` (the seam every editor caller goes through), the agent live
`apply-scene-ops`, the file-direct `sceneMutate`, and the device `set-traits`. A per-member "unlink" command was
considered and declined; dragging a member out of its instance already unpacks it (#1447). Not covered:
`applyStructureCore`'s `removedTraits` at load, which the capture side never writes for `PrefabInstance`.
Before the fix, the walk stepped through an OWNED root. A nested root moved beside its owner (Mid's `InnerRoot`
under Panel), with the owner then deleted, was re-pointed into the grandparent frame. That frame records no move
for it, and the one that did died with the owner, so the save wrote only `removed` and the nested root and its
members vanished on reload.

**Across scenes it is still refused.** A move to another scene file (`moveEntityToScene`) refuses anything that
would split an instance (`instance-member`, docs/scene-loading.md), an owned nested root included, where the
same drag inside one scene keeps it linked. Extending promotion to scene moves is not done.

An edit inside a nested instance is applied to the nested prefab's own file, so every instance of it everywhere
updates (owner, 2026-09-19). The outer instance's Apply offers nothing for it.

## Edge cases

- **Reordering** prefab children is *not* a structural change — it's an
  `EntityAttributes.sortOrder` value diff, already captured by the existing
  per-field path. No new work; called out so it isn't re-implemented.
- **Nested prefab instance** dropped inside an instance (its own `rootInstanceId`)
  is now captured as a **reference node** (`AddedEntity.prefab` + its
  overrides/structure), not an opaque trait snapshot — see
  [Nested-instance additions](#nested-instance-additions-reference-nodes). It
  round-trips under its exact parent member with full override fidelity.
- **Removing an added entity** (add then delete, never saved) is a no-op — it was
  never a member and never persisted.
- **Removing a member that has overrides** — the member is gone, so its value
  overrides have no target; `applyOverridesByLocalToEcs` already skips missing
  localIds. `removed` simply ensures it's deleted post-instantiate.

## Tests (`packages/modoki/tests/editor/`)

- `captureInstanceStructure`: add one child → one `AddedEntity` anchored to the
  right `parentLocalId`; nested add → populated `children`; delete a member →
  `removed:[localId]`; delete a member with prefab kids → only the top localId.
- Serialize round-trip: a scene with an added child + a removal serializes, and
  re-loading reproduces the same live tree (added present & parented, removed
  absent). Guards the orphan bug directly.
- `applyToPrefabSelective`: applying `+added` inserts entities with fresh
  localIds and correct localId-parent links and clears guids; applying `-removed`
  drops the entity + descendants; existing localIds unchanged.
- Refresh reconciliation: prefab edit that removes an add's anchor re-anchors to
  root; prefab edit that removes an already-removed localId discards the entry.

## Implementation order

1. **Capture + serialize + load** (round-trip) — fixes the orphan bug, lands the
   data model and tests. No UI yet; added children survive reload on the instance.
2. **Dialog + apply** — recursive `added`/`removed` nodes, new selection keys,
   insert/delete in `applyToPrefabSelective`, refresh reconciliation.

Each step is independently shippable and testable; step 2 depends on step 1's
capture format.

## Files touched

- `packages/modoki/src/editor/scene/prefab.ts` — `captureInstanceStructure`,
  apply-side insert/delete, refresh reconcile.
- `packages/modoki/src/editor/scene/serialize.ts` — write `added`/`removed`,
  skip consumed added entities, scan added subtrees in `collectResourceRefs`.
- `packages/modoki/src/runtime/loaders/loadSceneFile.ts` — re-expand additions,
  apply removals.
- `packages/modoki/src/editor/panels/ApplyPrefabDialog.tsx` — recursive
  added/removed nodes + selection keys.
- `packages/modoki/src/editor/scene/prefabOverrideKeys.ts` — the shared key-format
  helpers + override-key walk, consumed by both the dialog and the
  `modoki_prefab {prefabAction:'overrides'|'apply'|'revert'}` agent op.
- `packages/modoki/tests/editor/` — new structural-override tests.
