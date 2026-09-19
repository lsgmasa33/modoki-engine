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
  - **values** are dropped when they EQUAL the chain's value. A scene that changed a row-set field
    keeps its change, which the key-presence rule `captureNestedSceneDelta` uses for saving would lose.
    The chain's member tokens are first resolved by `baseTokenResolver` from the nested root: its own
    frame, with `^` climbing to the instance whose row expanded it. The loader applies every value in
    that frame, whichever layer authored it. A reference node's payload is in its own instance's frame
    and is left whole, as `rebaseAddedTokens` leaves it. The live side holds
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
  instance. A row that authors its own structure is therefore always restated by the scene; that
  asymmetry is deliberate and follows from the previous point.
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
Where two meet during expansion the outer one wins **per path, whole** (`mergeNestedStructurePaths`
— never element-wise, for the same un-delete reason as above), and `resolveEffectivePrefabStructure`
descends the rows' slots path-keyed exactly as `resolveEffectivePrefabOverride` does, so a scene's
baseline includes what an intermediate row already did to the interior.

The row carrier is written two ways, both **with a writer**, which is the order CLAUDE.md requires
for an authored field:
- **Promotion** (Apply to Prefab, `insertAddedSubtree`) copies a reference node's slot into the row.
- **A prefab-edit save / Create Prefab** (`serializePrefab` → `planPrefabRows`) **captures** each
  row's channels from its live expansion with the same `captureNestedChannels` walk the other two
  carriers use. Captured, not passed through: `buildPrefabEditScene` forwards both channels onto the
  row's scene entry, so the edit world IS the expansion, and an edit made inside a row's nested row
  in the prefab editor must replace the file's value rather than be overwritten by it.
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

⚠️ **Why the channels are not folded into the row at promotion instead.** A reference node's
`nestedStructure` is keyed by paths inside ITS OWN prefab, so no key ever targets a row the promoted
(outer) prefab owns — its direct lists already land in the row's `added`/`removed`. The only fold
possible would write into the inner prefab's file, changing every instance of it.

**No `PREFAB_FORMAT_VERSION` bump for the row slot, deliberately.** Unlike a scene (v14, REFUSE),
nothing on the prefab loading path reads the version at all (see `PREFAB_FORMAT_VERSION`'s docblock),
so a bump would protect nothing: an older build still loads the file, ignores the field and would
drop it on its next save. That is the same exposure every optional prefab field has had since v1.

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
  anchor* claims that row (first by ecsId when two carry the same stamp).
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
by `outermostInstanceRoot`, before the parent write (`planLeaveInstance`, #1445).

**Identity does not move.** A member's guid is derived from its row PATH (`deriveMemberGuid(anchor,
path)`), so a moved member must keep deriving from where it was. `PrefabInstance.homeParent` holds the
guid of the row parent it left, and `homeSteps` the steps through homes that were since deleted or
unpacked (`runtime/core/ecs/memberHome.ts`). Every identity walk — `deriveInstanceMemberGuids`,
`memberPathIndex`, `planCopyGuids`, `baseTokenResolver`, the template tokenizer — steps from the home
(`identityParentId`, `homeStepsOf`). Moved back to its row parent, the stamp is cleared.

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
| Drag a member to another parent inside the instance | stays linked, a `moved` entry | re-parents the row | — |
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

When a leave promotes a nested instance, a linked member of it is unpacked in exactly the two shapes the save
cannot write (`planLeaveInstance`): it sits ABOVE its frame (the first promoted root on its ownership chain), or
the outermost instance it sits inside differs from its frame's. A standalone instance is saved from its root
down, so such a member was written nowhere and both vanished on reload. A member merely BESIDE its frame inside
the same outermost instance is an ordinary #1437 move and stays linked.
The same shape reached by a move that does NOT leave the instance is #1450.

**Deleting a moved member's owner promotes or unlinks it, never re-homes it past the owner (#1451).** A delete
re-points a surviving member whose home goes to that home's own identity parent (`rehomeDependents`). That walk
stops at any instance ROOT, stored or owned: a home is a member of the dependent's own frame, so a root home is
the frame's root, and the frame dies with it. `detachOrphanedMembers` then promotes an owned nested root to a
stored one, renaming its members to the guids a reload derives (the #1447 contract), and unlinks anything else.
It promotes when the root's OWNER dies, meaning the frame of its identity parent, and not only when its home dies. A
nested root that rode out inside a moved member of its owner has no home, and keying on the home left it linked to
a dead frame; its members then re-derived new guids on reload and a ref to one dangled. Detach Prefab and
unpack strip a frame without this step, so a member moved out of the stripped subtree is still lost there (#1453).
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
