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
| **Component (trait)** | already works — captured as an *added-trait override* in `overrides` (`getOverrideValues` `prefab.ts:314`) | **new** — `removedTraits` map |

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
| Capture | `prefab.ts` `captureInstanceOverrides` (`:360`) | Walks members by `PrefabInstance.rootInstanceId`. A freshly-created child has **no `PrefabInstance` trait** (`createEntityWithUndo` spawns only `EntityAttributes`+`Transform`), so it's never visited. |
| Diff | `prefab.ts` `getOverrideValues` (`:302`) | `prefab.entities.find(e => e.localId === id)` is `undefined` for a localId the prefab lacks → returns `{}`. |
| Dialog | `ApplyPrefabDialog.tsx` `buildTree` (`:50`) | Renders only entities from that same member walk (and skips tags at `:67`). Nothing to check off. |
| Apply | `prefab.ts` `applyToPrefabSelective` (`:577`) | Overlays values onto `newPrefab.entities.find(...)`; it can't **insert** an entity. |

There is also a **silent round-trip bug** independent of *Apply*: an added child
*is* serialized today (it isn't in `prefabChildIds` since it has no
`PrefabInstance` trait — `serialize.ts:71`), but with `EntityAttributes.parentId`
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
  guid: string;                                       // EntityAttributes.guid, stable identity
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
     THIS prefab's definition — its `parentLocalId` is set, or it matches a prefab
     `prefab` row) → **skip** (it round-trips via the prefab row / `nestedOverrides`);
   - a **user-added** nested instance (self-rooted `PrefabInstance`, `parentLocalId`
     0, no matching prefab row) → capture as a **reference node** (`captureInstanceReference`),
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
   the instantiation's `localToEcs`, then cascade by `parentId`).
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

`buildTree` gains two node kinds beside the existing field-diff nodes:

- **Added** — one node per `AddedEntity`, rendered **recursively** (subtree with
  its `children`), each row labeled *added*. One checkbox per added subtree root
  (children ride along; finer granularity is a later refinement).
- **Removed** — one node per `removed` localId, labeled *removed (deletes from
  prefab base — affects all instances)*, so the destructive semantics are
  explicit.

Selection keys extend beyond `"localId.trait.field"`:

- `"+added.<guid>"` — push this added subtree into the prefab base.
- `"-removed.<localId>"` — delete this entity from the prefab base.
- `"-trait.<localId>.<traitName>"` — delete this component from the prefab base
  (rendered as a *removed: TraitName* row under the member's node).

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
  `nestedRootKind`: a nested instance with `PrefabInstance.parentLocalId > 0` (or
  whose `(anchor member, source)` matches one of the parent prefab's own `prefab`
  rows) is **owned** and skipped; otherwise it's **user-added** and captured.
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
  re-detects it as user-added (idempotent round-trip).
- **Resources.** `collectResourceRefsFromEntities` surfaces `added[].prefab` and
  recurses a reference node's own `added`, so `SceneManager` acquires the child
  prefab (and its transitive refs) at load.
- **Apply to Prefab.** `insertAddedSubtree` writes a reference node as a nested
  **row** in the owner's `.prefab.json` (bumping it to `version: 2`), so promoting it
  matches how `serializePrefab` writes nested rows.
- **Recursion.** Because `captureInstanceReference` calls `captureInstanceStructure`,
  a user-added instance nested inside another is captured (and expanded) recursively.
  `serializePrefab`'s nested-row loop skips an instance already folded into a parent
  reference node (`skip.has(e.id)`), so it is never double-emitted.

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
- `packages/modoki/tests/editor/` — new structural-override tests.
