# Prefabs

A **prefab** is a reusable entity sub-tree — a mini-scene — saved as a
`.prefab.json` file. A prefab *instance* in a scene references its source and
stores only the fields it overrides, so editing the prefab (and reloading)
updates every instance.

See also: [Architecture](./architecture.md) · [Scene Loading](./scene-loading.md) · [Visual Editor](./editor.md)

## Concept

When you "Save as Prefab" on a selected entity, its whole descendant subtree is
written to a `.prefab.json` with stable per-entity `localId`s (1-based, BFS
order, root = 1). Dropping that prefab into a scene spawns a fresh copy of the
subtree and tags every spawned entity with a `PrefabInstance` trait. The scene
file then stores just the instance root plus its overrides — not the children.

## PrefabInstance trait

`runtime/traits/PrefabInstance.ts` marks every entity spawned from a prefab:

```ts
const PrefabInstance = trait({
  source: '',          // path/GUID of the source .prefab.json
  localId: 0,          // which localId this entity is within the prefab (root = rootLocalId)
  rootInstanceId: 0,   // ECS id of the instance root (shared by all entities in the instance)
  parentLocalId: 0,    // for a NESTED instance: localId of the nested-prefab row in the immediate parent (0 for top-level)
});
```

`rootInstanceId` ties an entire instance together: editor operations
(override capture, apply-to-prefab, instance refresh) query all entities sharing
a given `rootInstanceId`.

## Prefab file format

Defined by `PrefabFile` in `editor/scene/prefab.ts`:

```ts
interface PrefabFile {
  id?: string;          // stable UUID, written once, survives renames/moves
  version: 1 | 2;
  name: string;
  rootLocalId: number;  // localId of the root entity (1)
  entities: PrefabEntity[];
}

interface PrefabEntity {
  localId: number;
  name: string;
  traits: Record<string, Record<string, unknown> | boolean>;
}
```

Each `PrefabEntity` stores its traits with `EntityAttributes.parentId` remapped
from ECS ids to `localId`s. `serializePrefab()` clears `EntityAttributes.guid`
on every prefab entity — a prefab is a template, so per-instance identity is
assigned on the live entity at instantiation, not baked into the file (otherwise
every instance would start with the same stale guid). The same holds for an `added` node inside a
nested row: it carries a template `key` instead of a guid, and each instance derives the guid from
that key (#1387). A ref from one member to another is written as a member token
(`@member:<path>`) and resolved per instance (#1352). Both are in [scene-loading.md](scene-loading.md)
§ "Guid uniqueness is a PER-FILE rule", "Template identity". The prefab file never carries
`PrefabInstance` traits; those are added programmatically on spawn.

## localId stability — an external address space

A prefab's `localId`s are not an implementation detail: they are the address space a **scene's**
`overrides` / `removed` / `removedTraits` are keyed in (see "Scene-instance format" below). A
re-save must therefore never renumber a surviving member — doing so silently repoints or drops
every override on every instance of that prefab.

The address space outlives the file, so the blast radius is wider than the scene JSON. Every
consumer below resolves a member BY localId, and each is a place a renumber goes wrong quietly:

- **`runtime/loaders/loadSceneFile.ts`** — matches each prefab member to its scene row on load.
- **`runtime/scene/sceneMutate.ts`** — writes a mutation into `overrides[localId]`.
- **`runtime/scene/transformSpace.ts`** — reads a prefab-instance ancestor's Transform out of
  `overrides[localId]` rather than its `traits`.
- **`editor/panels/ApplyPrefabDialog.tsx`** — pairs a live instance entity to its template row.
- The live **`PrefabInstance.localId`** trait, which carries the id on every spawned entity.
- **`editor/scene/prefab.ts`'s `tagEntityTreeAsInstance`** — stamps that trait after a Create
  Prefab, so it must assign the SAME ids the file just got.

⚠️ **That last one had its own numbering and they disagreed (#1278).** `serializePrefab` collapses
a nested instance below the root to one reference row and drops its members from the numbering;
`tagEntityTreeAsInstance` numbered the full `collectTree`. So after Create Prefab on a tree holding
a nested instance, every member ordered after it was live-tagged one higher than its row — and
because BFS visits a nested instance's members *last*, the divergence only appears when a surviving
entity sits deeper than the dropped ones (`R → A, Hull(instance), B → C`: `C` is row 5 and was
tagged 6). `captureInstanceOverrides` on the next save then paired each live entity with the wrong
row and wrote overrides under an id denoting a different member, silently.

The first fix had tagging mirror the written file row-by-row, and **close-out review found that
still wrong** — it inferred membership from the hierarchy, and "every descendant of a nested root"
is wrong in both directions:

- An **owned** grand-nested instance (`parentLocalId > 0`) is *not* dropped by the serializer.
  `captureInstanceStructure`'s `captureChild` returns `null` for those, so they never enter
  `consumedEcsIds`, and being self-rooted they are not members either — they get a reference row
  of their own. Skipping it shifted every later row by one, and the entity whose row went missing
  was left with **no `PrefabInstance` at all**.
- `memberEcsIds` is a **world-wide query on `rootInstanceId`**, not a subtree walk, so a member
  reparented out of its instance is dropped while sitting outside the subtree.

So the inference is gone. **`planPrefabRows` owns the decision and both `serializePrefab` and
`tagEntityTreeAsInstance` call it.** **Anything that needs a member's localId calls the planner;
nothing re-derives it.**

⚠️ **One decision procedure is NOT one answer, and this is the part that is easy to get wrong
twice.** The callers must also feed it the same inputs, at the same time, and they do neither for
free:

- **Different arguments.** The planner takes `preserveLocalIds` and `existingId`; tagging passes
  neither. Safe today only because the paths that preserve (prefab-edit re-save) never tag and the
  paths that tag never preserve — pinned by
  `engine/tests/architecture/prefabTagNeverPreservesLocalIds.test.ts`, because a prefab-edit "save
  and relink" would reintroduce #1278 silently.
- **Different times.** `serializePrefab` plans, then the caller **`await`s the file write** — on a
  Replace that await contains the `confirmReplace` **dialog**, an unbounded wait during which MCP
  ops and the file-watcher's scene reload keep running. Tagging then plans again over world and
  prefab-cache state that may have moved. So tagging takes the written `PrefabFile` and checks its
  plan against it (`planMatchesFile`), and **refuses to tag on a mismatch**. That degradation is
  chosen deliberately: an *untagged* entity round-trips as an `added` node and loses nothing,
  whereas an entity tagged with a localId the file has no row for is written to **neither** the
  scene entry (serialize drops it as a prefab child) **nor** the overrides — it is simply gone on
  the next load.

A nested row is not retagged onto the new prefab: it keeps its link to its own child prefab and
receives only `parentLocalId`, exactly as `instantiatePrefabIntoWorld` does on reload, and its
members are left alone. **The invariant to hold on to is that the live world after Create Prefab
equals the world after a save + reload** — that is the only bar that catches this class. Holding it
meant splitting capture from strip: `detachPrefabInstance(root, { strip: false })` snapshots for
undo without severing links the tagging deliberately will not restore.

⚠️ **Dropping the strip means the tag write must name every field.** koota's generated setter is a
**partial merge** (`if ('k' in value) store.k[i] = value.k`), so an omitted field silently keeps its
previous value — which the old strip-then-add had reset. A surviving `parentLocalId` makes
`serialize.ts` classify the row as an *owned* nested instance (`parentIsMember && parentLocalId`),
which writes **no scene entry for it at all**, and the freshly created prefab link is gone on the
next reload.

`serializePrefab`'s default numbering (no `opts`) is **positional** (`i + 1` over the BFS-ordered
tree) — correct for "create a prefab from an entity", where there is no prior numbering to
honour, but wrong for re-saving an existing file authored with a gap (a member deleted earlier
compacts every id after it on the next save). Measured on sling's `FieldCorner.prefab.json`:
`drip` moved localId 4 → 2.

**`serializePrefab(selectedEntityId, existingId, opts)` takes two options that fix this for a
re-save:**
- **`preserveLocalIds: Map<ecsId, localId>`** — every surviving member keeps the id it already
  had; a member with no entry (added during the edit) is allocated **above the highest preserved
  id**, never into a freed gap.
- **`name: string`** — keep this as the file's `name` instead of defaulting to the root entity's
  name (see "renaming the root" below).

Prefab-edit mode is the only caller that supplies `preserveLocalIds`. It is **not** the only path
that re-serializes an existing file — there are **six** writers, and the census that keeps them
honest is `tests/architecture/prefabSerializeCallSites.test.ts`, which fails when a seventh appears
without saying where its file guid comes from:

| Path | File guid | localId behaviour | Node identity (v5) |
|---|---|---|---|
| **prefab-edit save** (`savePrefabEdit`) | the open session's own | **preserved** — the mechanism below | **carried**, via `preserveNodeGuids` from the baseline document |
| **rigged model re-import** (`ModelAssetView`) | `classifyExistingPrefabId` | preserved by a *different* mechanism: serialize positionally, then `mergeRiggedPrefab` matches bones by NAME so their localIds stay stable and user-added children stay attached | **carried** by that same content match |
| **2D skin rig write** (`skinPrefab.ts`) | `classifyExistingPrefabId` | **renumbered** — the subtree is rebuilt from `rigDef.bones`, so ids follow the rig definition, not the file | **minted** — a rig subtree has no correspondence to the old rows |
| **`prefab` agent op, `create` over an existing path** | `classifyExistingPrefabId` (throws on an unreadable file) | **renumbered** — it replaces the template with a scene entity tree, which is the intent | **carried** when the live tree is an instance of THIS prefab, else minted |
| **Assets panel → Import Model** | `classifyExistingPrefabId` | **renumbered** — a fresh GLB tree | **minted** |
| **Create Prefab → Replace** (`assetOps.ts`) | supplied later, by `writeNewAssetDocument`'s `build(guid, kept)` | **renumbered** | **minted**, even when the live tree is an instance of the prefab being replaced — the draft is serialized before the destination, and therefore the kept guid, is known |

The renumbering rows are the same hazard this section describes, left as-is because they
*regenerate* a template from a source of truth rather than round-tripping the authored file.

⚠️ **What prefab v5 changes about that hazard, and what it does not** (#1468). Every row now carries
a minted `nodeGuid` beside its `localId`. It does not stop the renumbering — `localId` is still the
document's array key and still positional. What it removes is the *silent* failure: a freed localId
is REUSED, so a stored key naming it comes back pointing at a **different member**, plausibly and
with nothing to report it. A minted guid is never recycled, so the same key can only ever **dangle**,
and a dangling key is something a reader can detect. Identity is carried where a real correspondence
exists (the table above) and minted where none does — minting is the honest answer there, not a
fallback.

⚠️ **And a dangling key is now detected rather than merely detectable.** Scene v16 stores each
member's guid in the instance's entry, keyed by that `nodeGuid`, so a key the template no longer
declares is reported by name on load and kept in case the template edit is undone. That is the other
half of the argument for minting: without a reader that notices, "can only dangle" is a property
nobody observes. See `docs/prefab-structural-overrides.md` § *Member identity is STORED, not
derived*.

⚠️ **A NESTED reference row's identity lives in `PrefabInstance.parentNodeGuid`, not `nodeGuid`.**
The live entity for such a row is the CHILD instance's root, whose `nodeGuid` is its identity in the
child document — so the outer document's identity for that row rides beside `parentLocalId`, in the
guid twin of it. Without that field a re-save of the outer prefab minted a fresh identity for the
nested row every time, and every scene key naming anything inside that expansion dangled.

The preserving mechanism, in `prefabEdit.ts`:

- **Sentinel guids carry the file's numbering through the edit world.** The loader reassigns ECS
  ids densely on load, so by the time the synthetic edit world exists the file's own numbering is
  already lost (measured: `FieldCorner`'s localId-4 `drip` loads as ecsId 2).
  `buildPrefabEditScene` stamps `EntityAttributes.guid` on every member — the root gets
  `PREFAB_EDIT_ROOT_GUID` (`__prefab_edit_root__`), every other member gets
  `PREFAB_EDIT_LOCAL_GUID_PREFIX` + its original localId (`__prefab_edit_local__7`) — and
  `savePrefabEdit` reads them back via `collectPreservedLocalIds` before calling
  `serializePrefab`. Riding on `guid` is safe because `serializePrefab` clears
  `EntityAttributes.guid` on every row it writes (a template carries no per-instance identity),
  so the sentinel can never reach the file.
- **`savePrefabEdit` REFUSES to save — rather than falling back to renumbering — when the opened
  file is no longer in the editor's prefab cache** (`getCachedPrefabSync` returns null). That
  cache is where the previous numbering and name come from; silently renumbering instead would
  break every scene override keyed to this prefab.
- **`rootLocalId` is the root's assigned id**, not a hardcoded `1` — with a preserve map it keeps
  whatever the file already used, and every `parentId: <root>` in the entity rows is remapped
  through the same table.

**Behaviour change worth knowing:** because `name` now comes from the previously-opened file
rather than the root entity, **renaming the root entity in prefab-edit no longer renames the
prefab asset.** It used to, by accident — `serializePrefab` defaulted `name` to `tree[0].name`,
which is why `cover-enemy.prefab.json` and `green-enemy.prefab.json` both became "Enemy" on a
re-save (their root entity is literally named "Enemy"). Rename the asset itself (file rename /
Assets panel) to rename a prefab going forward.

## Scene-instance format — how overrides are marked

In the scene file a whole instance collapses to **one entry** — an ordinary
`SerializedEntity` (`editor/scene/serialize.ts`) detected by the presence of its
`prefab` field, the prefab ref plus its deltas, never the expanded children (no
`type` discriminator):

```jsonc
{
  "prefab": "062bd887-…",                 // source .prefab.json GUID
  "overrides": { "3": { "Transform": { "px": 4.2 } } },  // localId → trait → field → value
  "removed": [7],                          // prefab-member localIds this instance deleted
  "removedTraits": { "5": ["Light"] },     // localId → trait names deleted from a member
  "members": {                             // v16: member identity → its row (#1468)
    "/5b2e…": { "guid": "0d7a…", "name": "Button", "parent": "9f1c…",  // `parent` only when moved (#1437)
                "traits": { "Transform": { "px": 4.2 } } },           // its overrides (Phase 4)
    "/77a0…": { "removed": true }          // a member this instance deleted — no guid, it is not live
  }
}
```

⚠️ **Since #1468 Phase 4 the localId channels above are the LEGACY spelling.** A member whose template
minted it an identity (prefab v5) has its edits on its `members` row instead — `traits`,
`removedTraits`, `removed`, `added` — so they follow the member through a template renumber. The
localId channels are still read, and still written for the instance ROOT's own edits and for a member
no row can key (a pre-v5 template's). The rule and the reasons:
[prefab-structural-overrides.md § A member's edits are stored on its row](./prefab-structural-overrides.md#a-members-edits-are-stored-on-its-row-phase-4).

A prefab FILE can carry a `moved` map of its own (v4, #1437): `"<member path>": "@member:<path>"`,
for a member it places under a parent no row relation can express. Both halves are member paths in
the prefab's frame. See [prefab-structural-overrides.md § Moved members](./prefab-structural-overrides.md#moved-members-1437).
A template REFERENCE node carries the same map for its own frame, as `templateMoved` (v7, #1543):
[§ A move inside a template reference node](./prefab-structural-overrides.md#a-move-inside-a-template-reference-node-1543-prefab-v7).

The marking is **presence-based, not a flag**: a field is "overridden" purely by
appearing in `overrides` (`localId → traitName → field → value`), and it stores **only
changed fields** (float compares use a `1e-6` tolerance). Anything absent is inherited
live from the prefab, so editing the prefab updates every instance that didn't override
that field. `removed` lists deleted members (descendants cascade — only the top-most is
stored); `removedTraits` lists per-member trait deletions. A nested (`v2`) instance also
gets `nestedOverrides`, keyed by a `path` of nested-row localIds, holding only what the
scene uniquely changed on top of what the nested row already overrides. On load,
`instantiatePrefabIntoWorld` re-expands the children and re-applies these deltas via
`applyOverridesByLocalToEcs`; the round-trip is covered in
[prefab-structural-overrides.md](./prefab-structural-overrides.md).

**Which fields an override may carry is decided by the trait's koota SCHEMA, never by
`meta.fields`** (`runtime/core/ecs/traitSchema.ts` — `isPersistentTraitField`).
`meta.fields` is the Inspector-rendering list: a field is in it because the generic
renderer should draw a row for it. A field can persist and still be absent from it —
`Animator.clips`/`clip` (the custom `AnimatorClipsSection` owns them),
`EntityAttributes.editorFolder` (no row at all). All three override paths — capture
(`captureInstanceOverrides`), the editor apply (`applyOverridesByRootInstance`), and the
loader apply (`applyOverridesByLocalToEcs`) — used to treat `field in meta.fields` as
"does this field persist", which lost data twice over: the loader **dropped** such a
field instead of applying it (and so never seeded its override mark), and capture never
**read** it, so the next save deleted it from the file. Measured on `skinned-test.scene.json`: a load→save removed a populated
`Animator.clips` bank naming a real clip guid. A field the schema does not declare is
still ignored — that is the genuinely renamed/retired case. Capture additionally skips
`runtimeOnly` fields at the READ, mirroring `serializeScene`, so live read-back
(`Animator.activeClip`, a crossfade's progress) can never be frozen into a file.

The same predicate governs **`applyToPrefabSelective`** ("Apply to Prefab"), which had the
bug in the write direction: it skipped such a field and reported success, so applying a
`clips` override changed nothing. Because it now admits AoS object/array fields
(`AnimationLibrary.animSets`) that the old gate excluded, it **deep-copies** the live bag
before writing — `readTraitDataFull` returns live references, and storing one would alias
the cached template to one instance, so editing that instance would rewrite the template.
`engine/tests/editor/traitPersistencePredicateGuard.test.ts` fails the build if any of
these files goes back to testing `field in meta.fields`.

**Writing a TEMPLATE excludes two things a scene keeps** (`isTemplateExcludedField`, shared
by `serializePrefab` and `applyToPrefabSelective`): `runtimeOnly` read-back, and the
scene-only fields in `SCENE_ONLY_TEMPLATE_FIELDS` — today just
`EntityAttributes.editorFolder`, the Hierarchy grouping tag. A template inheriting a folder
would file every future instance under one author's folder. Note the asymmetry is
deliberate: **capture into a SCENE keeps `editorFolder`** (a foldered instance must stay
foldered — that is what the field is for); only templates drop it. It is now excluded
BY NAME, where it used to be excluded as accidental collateral of the `meta.fields` gate
that was also losing `Animator.clips`.

## Core operations (`editor/scene/prefab.ts`)

- **`serializePrefab(selectedEntityId, existingId?, opts?)`** — collects the selected
  tree (`collectTree`, BFS), assigns `localId`s, snapshots each trait, remaps
  parent links to localIds, and rewrites asset path refs to GUIDs. Pass
  `existingId` to preserve a prefab's UUID on re-save. `opts.preserveLocalIds` /
  `opts.name` keep a re-save from renumbering members or renaming the file — see
  "localId stability" above.
- **`instantiatePrefab(prefab, parentId?)`** — editor-side spawn into the current
  world: spawns entities, remaps `parentId`s, adds the `PrefabInstance` trait,
  sets `rootInstanceId`, returns the root ECS id. `setPrefabSource(rootEcsId,
  source)` then stamps the `source` path on the instance. It is **synchronous**, so
  any nested (`v2`) child must already be cached — a nested row whose child file is
  not in the cache is silently skipped.
- **`instantiatePrefabAsync(prefab, parentId?)`** — the preload-safe wrapper:
  `await preloadNestedPrefabs(prefab)` then `instantiatePrefab`. **Every UI
  instantiate path** (Assets, Hierarchy drag-drop, Inspector) uses this so the
  preload contract can't be forgotten (forgetting it drops nested children).
- **`instantiatePrefabIntoWorld(world, prefab, parentId?, rootTransform?,
  source?, overrides?)`** — the runtime equivalent (in `loadSceneFile.ts`): spawns
  into an explicit world (used by `SceneManager` against the staging world),
  applies a root transform, and applies per-localId overrides via
  `applyOverridesByLocalToEcs`.
- **`captureInstanceOverrides(rootInstanceId, prefab)`** — walks every entity in
  an instance and returns `{ localId → { traitName → { field → value } } }` for
  fields that differ from the source (float comparison uses a `1e-6` tolerance;
  `parentId` and tag traits are skipped). `getOverrideValues` /`getOverrides`
  back it.
- **`getPrefabSource(source)` / `setPrefabCache(source, prefab)`** — fetch (and
  cache) a prefab file by GUID or path. The cache lets the serialize loop and the
  Inspector read override diffs synchronously. (The runtime resource cache uses
  its own `getCachedPrefab()` in `meshTemplateCache.ts`.)
- **`applyToPrefab` / `applyToPrefabSelective`** — write live overrides back into
  the source file and refresh sibling instances.

### Apply takes what it applied OUT of the source instance's overrides (#1469)

Apply refreshes **every** instance of the source, the one it was applied from included: each is
captured against the OLD document, rebuilt from the new one, and has its capture re-applied. A match
with the new base is **not** what drops an applied field from the source instance. The field is still
override-MARKED (`overrideMarks.ts`), and the capture keeps a marked field that differs from the old
base. The rebuild then re-applies it through `applyOverridesByRootInstance`, which re-seeds the mark.
The result was an override whose value equalled the base. It was invisible in the override list
(a value diff), it was saved into the scene, and it **pinned** that instance: a later template edit
to the field reached every instance except the one the author had applied from. An applied MOVE
pinned the moved member's Transform the same way, because a moved member's Transform is captured
without a mark.

So `applyToPrefabSelective` records every `localId.Trait.field` it copies from the instance into a
row: an applied field, every field of a component it seeds whole, and the Transform an applied move
writes. `refreshInstances` subtracts that set from **that one instance's** capture before its
rebuild (`subtractFieldOverrides`, which Revert uses for the fields it reverts). Other instances keep
their own overrides of the same field. Tests: `engine/tests/editor/applyLeavesNoSourceOverride.test.ts`.

**…except a field an ENCLOSING row shadows (#1492, owner ruling b, 2026-09-24).** The rule is one
predicate (`appliedFieldsToDrop`): **an applied field keeps its override only if dropping it would change
the value the instance resolves to.** A nested instance resolves to its template UNDER the rows enclosing
it (`enclosingRowOverrides`: every row from the stored root down, resolved outside-in, tokens resolved).
So when the outer prefab's row sets the applied field to another value, the source keeps it. Dropped, the
instance would show the row's value, not the one the author just applied. Every other applied field is
subtracted as above, including on a nested instance whose rows do not set it. It is not a second #1469:
it changes what the instance shows, and it adds no pinning, because the row had pinned the field already.
It must be an ordinary override, and three surfaces make it one by reading the same resolved base:
- **the override list** (`collectInstanceOverrideTree`) diffs a nested instance against its template
  under its rows. Against the bare template, the kept value (equal to it now) was not listed, and a value
  the outer row sets was listed as the instance's own override;
- **Revert** puts back the ROW's value for a field a row sets, not the template's. The rebuild re-expands
  from the template alone and carries the row's values only as captured (marked) overrides, and the one
  reverted is subtracted from those;
- **the save** keeps it, since #1498 compares a nested field with the row by value.

**The resolved base is the enclosing layer WHOLE (#1506).** `enclosingLayer` answers what the layers
enclosing an instance author on it: field overrides AND structure lists. `enclosingRowOverrides` is its
field half, with tokens resolved. The layer can be one of two things:
- **a row frame**: every row from the top down, as above, plus `resolveEffectivePrefabStructure` of the
  same chain;
- **a reference node that a prefab TEMPLATE authored** (a keyed `added` node with `prefab`, in a row of the
  frame it hangs in): the node's own channels (`overrides`, `added`, `removed`, `removedTraits`, `moved`,
  with its `members` folded as the loader folds them — a template node carries template-form rows since
  #1538). A chain of rows UNDER such a node starts from the node's `nestedOverrides`/`nestedStructure`
  and its `members` (the seed arguments of the `resolveEffective…` walkers).
  The node is found by template key (`templateReferenceNode`), using the marker first and the
  guid-derived recovery if the marker was lost. A node the SCENE added has no enclosing layer: the scene
  writes it as that instance's own.

Before this, only the rows' fields counted. A row's structure was listed as the nested instance's own,
and **Apply of the listed keys wrote it into the child template**: an outer row's removed trait was
stripped from every instance of the child prefab. A row-authored reference node read as a stored root, so
its node-set fields were listed as its own, and Revert took them to the template's value.

The listing (the agent op and the dialog both) now diffs structure through `ownInstanceStructure`: the
capture minus the layer's lists, with the rebuild's own subtraction (`subtractChainStructure`, `added`
nodes matched by template key). Apply and Revert also **refuse** a layer-authored structural key that a
caller still holds (`layerAuthoredStructureKeys`). Apply reports it in `skipped`, and Revert warns. A
revert of one put an outer row's removal back, or DELETED its added node, and neither is what the
instance shows with nothing of its own. An `added` node the layer authored is never the instance's own, **even once the scene has
edited it**. The subtraction keeps an edited node whole for the rebuild to respawn, but listed, Apply
copied it into the child prefab, and every other instance of the enclosing prefab then showed it twice.
Its edits are the scene's, and the save keeps them.

A reference node inside a plain added node's `children` is found too (#1513). The frame is the one the
first MEMBER above it belongs to, since a plain node carries no `PrefabInstance`, and the key is looked
for through the layer's `children`. A reference node in another reference node's `added`, under one of
that node's members, needs neither: that member's frame is the outer node's instance, whose layer is the
outer node's `added`.

Limits:
- A template node the scene moved out of the frame that authored it reads as having no template node. Its
  identity parent is its live parent, since no row expanded it (`identityParents.ts`), so the climb reaches
  another frame, or none, whose layer does not hold its key.
- **A scene edit to a node the layer added has no key on any surface**, so it can be neither applied nor
  reverted to the row's version. It is saved and reloads as edited. Before #1506 it was listed, but Revert
  deleted the node, which was no better.
- A save leaves the node to the template unless the scene changed it (#1511), so Revert's target lasts
  past a save. Once the scene edits the node, the member's whole `added` list is saved. A node whose
  template carries an all-empty `nestedStructure` slot, or one holding `added` nodes, is still saved
  as edited. See
  [prefab-structural-overrides.md](prefab-structural-overrides.md).

The #1490 half: after Apply of a MOVED nested root, the pose is in the reference row's overrides, so the
save's by-value subtraction drops it from the source. A later edit to that row pose moves the instance.
Tests: `engine/tests/editor/nestedRowFieldSave.test.ts`.

### Undoing an Apply

An Apply changes two things: the prefab file, and every live instance of it. So its undo
(`applyPrefabUndo.ts`) puts back both. It installs the prefab snapshot, then reloads the live world from
the `serializeScene` snapshot taken on that side of the Apply. Only the scene snapshot tells the
applied instance (an override again after the undo) apart from the ones that merely inherited the
value (back to the old base). Neither a rebase nor a rebuild from the prefab's document can recover that.

**The snapshot is reloaded under the key of the world the undo belongs to when it RUNS**
(`currentSceneKey()`, the key Stop's restore uses), not under a path captured at the Apply (#1575):
- **a scene's path**: reloaded there, the editor's path and base re-synced, and saved;
- **the prefab-edit world's synthetic path**: reloaded there, not saved (#1573, § Prefab edit mode);
- **an untitled scene** (`null`): reloaded under `''`, as `restoreAuthoredSnapshot` reloads one on
  Stop. Nothing is fetched, the world is not marked as a loaded scene, the editor's path stays null
  (so Save still asks where), and nothing is saved. `replaceWorldContent`, which builds an untitled
  world, cannot do this: its populate callback is synchronous, and a prefab instance needs the async
  loader.

Before #1575 an untitled scene matched neither captured path, so only the file came back. The other
instances kept the applied value, the applied one lost its override, and a later Save As wrote that as
an override on each. Reading the key at undo time also covers an untitled scene saved with **Save As**
after the Apply. That save sets the editor's path but keeps the undo history, so the Apply entry is
still undone, now under a real path.

**The reload happens only if that world is still live.** The file install and the member-path repair
before it are awaited. A scene load, an Exit from prefab edit, or a Create Scene can land in that
window. The reload is skipped in any of three cases, and only the file is restored, with a warning:
- the key changed;
- the world object changed (checked for every key);
- a scene load is still in flight (`isSceneLoadInFlight()`, or `sceneManager.getNext()`).

The world is compared for every key because a scene load swaps the world first. It sets the path and
the history only in its tail, after awaiting the scene managers, so for that window the key still
reads as the old scene's. Every untitled world shares the key `null`, which is why the world check was
first written for that case. A skipped restore also skips `rederiveBaseInstances`, which would
otherwise rebuild the prefab's base instances in whatever world is live. **And the step throws.** It
applied only half, the file and not the world, so the undo manager drops it with a loud report
(#310's policy, [editor.md](editor.md) § A throwing undo/redo closure). The entry is never left on a
redo stack as though undone. Where the history has already swapped, the manager would drop it anyway
(§ A step that awaits across a scene switch). Otherwise its redo would load this snapshot under the
new scene's key and save it there.

⚠️ **These are guards at the step, not a fix for the race.** Nothing serializes an undo against the
user opening a scene, creating one, entering or leaving prefab edit, or pressing Play. Four windows
are still open and tracked together in #1579:
- Play pressed during the install;
- a base the incoming scene keeps, whose instance keeps the applied build;
- a load's tail discarding the outgoing history that the throw marked dirty;
- a pending load that then fails, leaving the file at "before" and the instances at "after".

The proposed fix is for the world-switch entry points to await `whenUndoIdle()`, which would make
every one of these guards defence in depth.

Tests: `engine/tests/editor/untitledApplyUndo.test.ts` (each rule above mutation-checked),
`prefabEditApplyUndo.test.ts`, `applyPrefabDirtiesBase.test.ts`.

### A capture reads the document the frame was EXPANDED from (#1483)

A localId means something only together with the document it was read from. Every capture
(`captureInstanceOverrides`, `captureInstanceStructure`, the override keys, Apply, Revert) diffs a
member's `PrefabInstance.localId` against the editor's CACHED copy of its source. So the invariant
is: **a live frame is expanded from the document currently in the editor cache.** Apply keeps it by
refreshing every instance, and its undo/redo keep it through `refreshBaseInstances` (#1431).

The hot reload broke it for a **kept base scene**. `SceneManager` carries a base with unsaved edits
across the swap FLAT (`snapshotPersistentEntities`), so its instances keep the old document's
numbering. Meanwhile `refreshPrefabSourceForPath` has already put the new document in the cache.
After a renumbering write (a `git checkout`, a hand edit), each member was compared with another
member's row: false overrides, and Apply wrote one member's value into another's row. Three pieces:

- **Every respawn keeps the record.** `identityParents.ts` records, per frame ROOT, the document it
  was expanded from (`noteFrameDoc`). A flat respawn is a new entity, and the record keyed by the old
  one does not reach it. The base-scene carry re-records it on the respawned root (`noteFrameRootDoc`,
  root only: the new world did not expand that source, so its per-source "latest" record is not
  touched). `EntitySnapshot.frameDoc` does the same for duplicate, paste and delete-undo. A copy keeps
  it too, because it was built from the same document. Without that, a respawned instance was
  invisible to both guards below.
- **The reload rebuilds stale carried instances.** `adoptWorldReloadedFromDisk` (the editor's
  hot-reload hook, now awaited by `agentBridge.ts`) calls `rebaseStaleInstances()`. That runs the
  refresh Apply uses on every instance FRAME root, stored or owned nested (#1493), whose recorded
  document differs from the cache (by content), inner frames first (see below). Kept bases are not the only carried roots: a `Persistent` root is carried
  whatever scene owns it. Everything the reload re-expanded from disk compares equal and is left
  alone. A world replaced while the nested prefabs load rebuilds nothing. A reload that is deferred
  (Play, a preview envelope) rebuilds when it finally runs, because the record, not a remembered
  baseline, says what each frame was built from.
- **Every refresh captures a root against ITS document.** `refreshInstances` (Apply's fan-out, its
  undo/redo, the rebase) uses each root's own record as the capture baseline, and falls back to the
  caller's `oldPrefab` only when there is no record. `rebuildInstance` translates from that baseline by
  `nodeGuid` (`localIdTranslation`). Before the close-out review, an Apply on one instance rebuilt a
  stale nested frame in ANOTHER against the cached rows and moved its edits onto other members, for
  good. A root whose stale frame is only NESTED is skipped, with a warning. The fan-out runs **deepest
  first**: an instance the author dropped inside another instance of the same source is captured by
  the outer rebuild through `captureNestedRef`, which reads the CACHED document. Outer first, it read
  the not-yet-refreshed inner against the new rows, so a node the Apply had just promoted was saved as
  removed. That predates #1483; the second close-out review found it.
- **Apply's undo/redo rebuilds the applied base instance FIRST** (`rederiveBaseInstances`,
  `applyPrefabUndo.ts`), then re-derives the other base instances, then re-selects by guid. The
  applied instance can sit inside another base instance, whose refresh captures it through
  `captureNestedRef` against the cache, so it must already be built from the restored prefab. Before
  the third review, the enclosing instance read it as a stale nested frame, was skipped, and kept the
  member the undo had taken away. The snapshot restore also rebases the `Persistent` roots its scene
  load carries flat, before it saves.
- **Leaving prefab-edit mode re-reads the edited prefab.** `refreshPrefabSourceForPath` skips the
  prefab open in prefab-edit mode, so after an exit without saving, the editor's copy could be older
  than the file the scene had just loaded from. Every instance of it was then refused, and a later
  rebase rebuilt carried ones back to the old template. `exitPrefabEditing` re-reads it once the
  editor is closed, then rebases, because a `Persistent` root is carried through prefab-edit mode and
  back, so a SAVED edit reaches it only there.
- **Apply and Revert refuse whatever is left** (`framesBuiltFromOtherRows`): any frame of the
  instance, nested ones included, whose recorded document does not hold the same rows as the cache:
  the same localIds, each naming the same `nodeGuid` where both carry one (`rowsMeanTheSame`). Both
  directions matter. A row the cache GAINED is not harmless: `captureInstanceStructure` reads every
  row with no live member as one the instance REMOVED, so it becomes a false removal on the next save
  or Revert. A round of this close-out narrowed the check to let gained rows through, on the evidence
  of a fixture (`duplicateCarriesRefs.test.ts`, #1437 P3-a) whose reload expanded the old document
  under a cache holding the new one, a split production never makes. The second review drove the
  false removal, and the fixture now resets its cache. Only row identity is compared, not content: a
  template whose values changed is still captured on the right rows (the mark gate), and refusing on
  content would block Apply over any byte difference between two copies of one file.

**A stale NESTED frame is rebuilt by ITSELF (#1493), never through its outer instance.** The nested
captures read the cached CHILD document: a rebuild's (`captureNestedInstanceOverridesIn`) and a save's
(`captureNestedChannels`). So rebuilding the OUTER instance would carry a stale nested frame's edits
onto the wrong rows. Rebuilding the nested root on its own does not have that problem, because its own
capture reads its own record, like any other root's. That is also what Apply's fan-out already did to a
nested root of the source it applied. The rebase lists every frame root and rebuilds a frame only once
no other stale frame is left in what its teardown destroys (#1499), so by the time an outer frame is
rebuilt, every frame its capture reads is current. The issue's own proposal, which
was to teach the outer nested capture to read each nested frame's record and translate its re-apply, was
not needed. Before this, a nested frame was only detected. The rebase skipped it, and a dirty kept base
was carried stale through every reload until it was saved. The save then wrote its edits onto other
members: a nested member the scene had deleted came back on reload, and the member now holding its old
number was deleted instead (OBSERVED, the "…so the SAVE" test below).

**A rebuild carries what its teardown reaches OUTSIDE its live subtree (#1499).** The teardown
(`rebuildTeardown`) reaches by identity, so it also destroys things outside the rebuilt root's live
subtree: whatever the frame owns that was moved elsewhere in the instance (#1437), a member of a
user-added reference node moved out of that node, and every frame under those. Before #1499 the capture
and the respawn did not match it, and each mismatch was a defect:
- **The nested capture walked LIVE children** (`captureNestedInstanceOverridesIn`). A frame owned here but
  moved out was destroyed and re-expanded at its row with its edits lost. The capture now takes its frames
  from the teardown's own set, so the two cannot disagree.
- **The respawn restored two of an owned root's three identity fields.** `parentLocalId` and
  `parentNodeGuid` came back, but not `ownerGuid`, the link a move writes (`linkOwnerBeforeMove`). An owned
  root moved under the OUTER frame and rebuilt on its own then read its owner off where it hung, read as
  user-added, and the save wrote its row `removed` plus a scene-added reference node. (Moved under a member
  of its own owner frame, where it hung happened to name the right owner.)
- **The unpark and reverse-case walks took whole subtrees without the park test.** So something not ours
  under a member they took, such as an outer member moved in under a moved-out frame, was destroyed with
  nothing to respawn it. All three walks now share one `take`. (The unpark itself runs inside the
  teardown's fixpoint since #1493's third review: run once, ahead of it, a member of a frame that joined the
  teardown only later survived beside its own respawn, its link stripped.)

**What keeps the rebase safe is ORDER, not a skip.** The #1493 close-out skipped every frame whose
rebuild reached outside its subtree (`rebuildReachesOutside`), because each shape above lost edits. The
skip also kept the loop safe: every rebuild destroyed only deeper, already-processed entries. An earlier
draft argued "a stored root owns nothing outside its subtree", and that was false. Moving a member unlinks
it only when it leaves the OUTERMOST instance, and when the review drove the gap, a recycled id was rebuilt
as the wrong prefab. With the rebuild fixed, the skip is gone. What replaced it:
- **Teardown order.** A frame is rebuilt only once no other stale frame is left in its teardown set.
  Deepest-by-live-depth was right only while every frame hung inside its owner's subtree, and a
  moved-out frame can sit shallower than its owner. The case that shows it: P and Q both gain a member, and
  QR is moved under OR. By depth, the P frame went first, and its capture read the stale QR against Q's new
  rows, so the gained member read as REMOVED by the scene.
- **A teardown-shaped refusal.** `framesBuiltFromOtherRows` judges the frames a rebuild of the instance
  tears down, not its live subtree. So `refreshInstances`, Apply and Revert all refuse an instance whose
  teardown holds a frame built from other rows. (The close-out review drove the gap: at first only the
  refresh judged the teardown, and a Revert on the P frame captured a stale moved-out Q frame against the
  cache, then saved the member the cache had gained as REMOVED.) The rebase then clears it.
- **A per-entry re-check** (the id is still a root of the same source, holding the document collected).
  ⚠️ It is traced, not driven: the order never lets a rebuild destroy a pending entry.

What still refuses: `refreshInstances` skips a root whose teardown holds a stale frame, and Apply/Revert
refuse an instance holding one. That now happens only while the cache has moved and no rebase has run:
a direct cache write, or the window before the reload hook finishes. A reload clears it. The refusal reaches the Apply
dialog's Revert as a toast and the agent op as `prefab revert refused`, because Revert's own `null`
cannot carry a reason. A runtime (Transient) frame is never judged: no capture reads it, and nothing
would rebuild it to clear a refusal.

⚠️ **The save does not rebase for itself.** `serializeScene` is also the Play and timeline-preview
snapshot and the before/after capture of Apply's undo, and a rebuild respawns entities, so it must not
run inside them. A save is safe because every path that moves the cache under live instances brings
those instances current first. The hot reload, leaving prefab-edit mode and Apply's undo call the rebase.
Apply's fan-out refreshes each instance of the source from that instance's own record. NOT CHECKED: the cache writers that
do not rebase, which are Create Prefab's Replace and its undo (`assetOps.ts`), the skin-rig prefab
update (`skinPrefab.ts`) and the model regenerate (`ModelAssetView.tsx`), when other live instances of
the prefab they rewrite exist. That applies to top frames and nested frames alike.

⚠️ **Wrong fix, reverted (#1468 Phase 4):** making the listed keys name members by their own live
`nodeGuid` made it worse. The key then disagreed with the capture it named, and Revert moved A's
override onto B. A key cannot be more right than the capture it names, so the fix has to make the
capture right. Tests: `engine/tests/editor/sceneMemberRowWriter.test.ts` § "a live frame built from
another version of its template", and `engine/packages/modoki/tests/editor/carryFrameRootDoc.test.ts`.

## Scene serialization integration

In `editor/scene/serialize.ts`, a `SerializedEntity` carries two prefab fields:

```ts
prefab?: string;                                              // source path/GUID (on the instance root)
overrides?: Record<number, Record<string, Record<string, unknown>>>;  // localId → trait → field → value
```

During `serializeScene()`:

- **Prefab child entities are skipped** — only the instance root is written
  (children are re-instantiated from the source on load). Children are detected
  via `PrefabInstance.rootInstanceId !== ownId`.
- On the root, `captureInstanceOverrides()` produces the per-localId `overrides`
  map; only changed fields are stored. The root also keeps any "structural
  additions" — traits the prefab source doesn't define on the root (e.g. a
  user-added `Rotate3D`).

On load, `loadSceneFile.ts` detects the `PrefabInstance` (or `prefab`) field and
delegates re-instantiation to the `onInstantiatePrefab` hook. `SceneManager`'s
implementation spawns from the refcounted prefab cache into the staging world,
re-applies the root's extra traits, and replays the `overrides` map per localId.
Override tracking is per-localId, so edits to a sub-entity (not just the root)
survive a reload.

## ⚠️ A prefab EDIT replaces the runtime cache entry — it used to empty it (#1308)

**An editor write of a prefab a scene owns now puts the written bytes straight into the runtime
cache.** Before #1308 it DELETED the entry, and only a scene load put it back, so every
synchronous runtime reader silently read nothing for the rest of the session.

The mechanism:

- A prefab write goes through `setPrefabCache()` / `writePrefabFile()`
  (`editor/scene/prefab.ts`), which calls `replaceCachedPrefab(source, prefab)`
  (`runtime/loaders/meshTemplateCache.ts`).
  - **If a scene owns the prefab**, it seats a JSON copy of the written bytes. The copy is run
    through the same load-path migration `fetchPrefab` applies. The #863 key token is still bumped,
    so an in-flight fetch of the pre-write bytes is refused.
  - **If nothing owns it**, it evicts as before. Seating an entry nothing owns would leave a row
    that no `releaseAllForScene` ever drops.
  - A delete (`setPrefabCache(src, null)`) still evicts.
- **Why this matters:** an eviction left the scene's owner hold intact and the bytes gone.
  `acquirePrefab` is the only thing that refills the cache, and outside games that preload
  deliberately, only `SceneManager`'s scene load calls it. The readers stranded by that:
  - the `UIEntries` pool: its stride went to 0, every slot parked, and the view went blank (#1308);
  - timeline scrub and control-track spawns;
  - a nested row inside any runtime spawn.
- **Every replace or evict bumps a per-key content revision** (`getPrefabRevision`). A runtime
  spawner compares it to tell that its live instances were built from OLD bytes.
  - `EntryPrefabProvider.revision` is a `guid@revision` list over the entry prefab and every
    prefab it nests. It is a list, not a sum: a sum let a removed nested row cancel the parent's
    bump, so the pool kept stale rows.
  - `entriesSystem` releases and rebuilds a view's whole pool when that signature changes. The
    rebuild keeps the view's per-frame scroll baseline; a fresh 0 there, on a rebuild first seen
    by a scroll-event drive, ballooned the pool to its raise cap.
  - ⚠️ **A rebuild does not re-target keyboard/gamepad focus.** The focused row is destroyed
    before the focus capture runs. Focus usually survives anyway, because the respawned row in
    the same slot gets the same seeded guids, and `uiFocusSystem` finds it again. It can land
    on a DIFFERENT entry when the Apply arrives mid-scroll: the rebuilt drive starts with minimum
    overscan, so the window origin moves. It falls back to the scope's autoFocus when the edit
    removed the focused member. Both need an editor Apply during Play; read from code, not
    observed.
  - This is needed because the Apply refresh skips Transient subtrees on purpose (§ Authoring
    scope, #1301), so nothing else would rebuild pooled rows.

**Paths that write an in-use prefab without reloading.** Since #1308 all of these keep the cache
warm:
- **Apply to Prefab** on a scene instance: `applyToPrefabWithUndo` → `writePrefabFile`.
- **`modoki_prefab action:'apply'`** (and `'create'`).
- Create Prefab → Replace, and the skin-prefab writes (both through `setPrefabCache`).

Paths that also reload:
- Prefab-EDIT mode reloads on exit (`exitPrefabEditing` → `loadScene(target)`).
- Undo/redo of an Apply reloads (`restoreSnapshot` → `loadScene`), under the key of the world the
  undo belongs to when it runs (`currentSceneKey()`): the scene's path, the prefab-edit world's
  synthetic path (#1573), or `''` for an untitled scene (#1575). See § Undoing an Apply.

**An external `.prefab.json` write** (a hand edit, `git checkout`) goes through the scene hot
reload. `handleSceneChanged` evicts and then reloads (#1169, [editor-hmr.md](editor-hmr.md)), and
that path is unchanged: the reload is what refills the cache there.

**Game code still owns two cases.** Instances a game spawned at runtime keep the art they were
built with: the cache is warm again, but nothing re-spawns them. And a prefab that really is
missing still reads `undefined`. So the guidance below (re-acquire on a miss; remember what each
instance was built FROM) still applies, and the incidents below are the pre-#1308 shape of the
failure.

**What this looks like in a game.** Court's guard flag falls back to drawn primitives when its
prefab is uncached, so after an Apply-to-Prefab the flags already planted keep the real art while
every new one draws a placeholder, and the board stays mixed until a scene load. Fixed there by
recording the art each instance was spawned with, retiring on a mismatch, and asking for the
prefab back through `requestPrefab` on a miss (`syncFlags`, `games/court/runtime/systems.ts`).

**Measured on Court's tray badge, 2026-08-19** — the wholesale version of the same failure. With
the prefab cached, a board build gives the authored instance (`Coin` ×6, `CountBadge`, `CountBanner`,
`InfoBadge`, `ChipRow`). Invalidate, then rebuild the board with **no** scene reload, and every one
of those drops to **0**, replaced by the pre-#171 code-spawned set (`TrayIcon_<piece>`,
`TrayCountBanner_<piece>`, `InfoBadge_<piece>` …). The tray silently reverts to the old art and
the constant layout — `refreshBadgeLayout` and the instantiation are two separate consumers of the
same cache and both fall back.

**If you spawn prefab instances at runtime, handle the miss on purpose.** Two things, and the
first alone is not enough:

1. **Re-acquire on a cache miss — call `requestPrefab(<your owner sentinel>, guid, { world })`**
   (`@modoki/engine/runtime`, #1376) wherever you would have read `getCachedPrefab`. It returns the
   cached document or null, and on a miss it asks for the prefab back. Call it every time you need
   the prefab (every frame is fine). **Do not hand-write this latch.** Seven spawners across four
   projects did, from an earlier version of this section, and every copy was wrong in at least one
   of the three ways below. The helper exists so the next spawner cannot repeat them:
   - **In-flight dedup, released on EVERY settle.** Without it a per-frame caller refetches every
     frame (#1373).
   - **A bounded give-up budget, per world, refunded on a hit, and never spent on an outage
     (#1397).** `acquirePrefab` on an unresolvable guid **RESOLVES**, with the cache still empty
     (measured 2026-08-19). It still never rejects. What changed is that `fetchPrefab` now
     classifies its failures: it remembers a 404 or a bad file until the prefab is invalidated,
     and backs off a 5xx or a dropped connection. `requestPrefab` refunds an attempt that ended
     transiently. So the three attempts are spent only on a prefab that is not coming, and an
     outage retries on the shared backoff (1 s doubling to 10 min) instead of giving the prefab up.
     The rule: [architecture.md](architecture.md) § "A load failure is classified before it is
     remembered". Before #1397 a 404, a 5xx and an offline blip looked identical here. Re-arming only on success (`.finally(() => { if
     (getCachedPrefab(ref)) rearm; })`, the shape this section used to prescribe) reads every
     transient failure as a deletion and disables the prefab for the session (#1359). Re-arming
     unconditionally refetches a deleted guid forever. A `.catch` re-arm (or a `.catch` warning,
     #1375) is dead code. Three attempts per world, then it stops. ⚠️ **"Per world" is an EDITOR
     safety net:** a built game never swaps its world, so there the give-up lasts the session.
     That is accepted because this is a recovery path. The scene load already acquired the prefab.
     It is a real change for `games/court`, whose hand-written guards were cleared on every board
     build. That gave a missing prefab one more try per level, forever. A per-frame caller (the
     flag layer, the win confetti, the debug-menu preview) now spends its three tries in about
     three fetch round-trips and stops until the next Play. Since #1397 that is true of a prefab that
     is NOT THERE; an outage backs off and does not spend the tries. A preview of a prefab that gave up
     stays parked, and the tap looks dead until then.
   - **The hit test and the re-arm test are ONE predicate.** The default is "has at least one
     entity", since an entity-less document spawns nothing. A caller whose miss test is stricter
     passes it as `isHit`: Court's tray badge passes its layout parse, because a cached document
     that does not parse is as useless there as a missing one. A re-arm on bare truthiness accepts
     such a document, releases the guard and refetches forever (#1359). A caller that reports an
     unspawnable document separately passes `isHit: () => true` (forest-camp's
     `arrow-spawn-failed`).
   ⚠️ **The re-acquire is async, so the action that found the miss still fails — record it.** The
   shot, spawn or build that hit the empty cache cannot wait for the fetch, and dropping it silently
   makes it read as a dead control. `demos/forest-camp` journals `archery.shot-refused` with
   `reason: 'arrow-prefab-not-cached'` for exactly this window (#996).
   ⚠️ **The miss itself is not the useful signal; the give-up is.** A miss is also what a healthy
   cold cache looks like one frame before it fills. So `requestPrefab` stays silent through the
   miss and journals **`prefab/unavailable`** (`warn`, payload `{prefab, owner, attempts}`) once,
   when the budget is spent and the prefab still has not arrived. That is also the only way a
   failed PRELOAD is ever seen, because `acquirePrefab` never rejects. Where the refused action is
   a *player* action, record it anyway, as forest-camp does, because the player really did lose
   something.
   **What stays on `acquirePrefab`:** a preload that AWAITS a batch (a scene load, sling's
   bootstrap `Promise.all`) is not a latch. `engine/tests/architecture/prefabRequestSites.test.ts`
   fails when a game or demo calls `acquirePrefab(` outside its short list of such sites.
2. **Remember what each live instance was built FROM**, and retire instances whose source no
   longer matches. ⚠️ **Key that record on the prefab's REVISION, not only its guid**
   (`${guid}@${getPrefabRevision(guid)}`). An editor Apply replaces the entry in place, so the guid
   never changes; Court's flag layer keys `art` this way so that an edit made during Play still
   retires every planted flag (`syncFlags`). Without this, the window between the invalidation and the re-acquire leaves a
   mixed population that never converges, because "this cell already has an instance" is true and
   says nothing about which art that instance wears.

Court's tray badge has now been audited (#262) — see the measurement above.

⚠️ **Acquiring under your own owner sentinel means RELEASING it too.** `acquirePrefab(<sentinel>,
guid)` adds that sentinel to the prefab's owner set, so the scene's own `releaseAllForScene` can
never evict it and the prefab outlives the game. Drop the holds wholesale when the game
unregisters — `releaseAllForScene(<sentinel>)`, not `releasePrefab` per guid, because a per-guid
release leaks anything the acquire pulled in transitively (`games/sling` records this at its own
call site, and `games/court` had to add it after missing it).

## Mesh sharing

Instances are cheap: they reuse the cached mesh **template** geometry and
material rather than re-parsing the GLB — `new THREE.Mesh(template.geometry,
template.material)`. The resource cache `acquirePrefab(sceneId, ref)` refcounts
the prefab source itself, and the meshes it references resolve through the same
shared template cache as everything else (see
[Scene Loading → Resource cache](./scene-loading.md#resource-cache-with-refcounting)).

## Editor UX & current limits

**Done:**

- The Hierarchy marks prefab instances with a `[P]` indicator and a subtle blue
  tint.
- Prefabs appear in the Assets panel and can be **dragged into the Hierarchy**
  to instantiate.
- Override capture works per-localId (including sub-entities), and
  `applyToPrefab` / `applyToPrefabSelective` push live overrides back to the
  source file, refreshing sibling instances.
- **Structural overrides** — an instance can add child entities, delete prefab
  members, and remove components; these survive save/reload and are pushed back
  recursively via the *Apply to Prefab* dialog. See
  [Prefab Structural Overrides](./prefab-structural-overrides.md).
- **Inspector override highlighting** — fields that differ from the prefab source
  are flagged in the Inspector (blue accent), driven by `getOverrides` and
  recomputed on each ECS edit.
- **User-added nested instances** — a prefab dragged under another instance's
  member round-trips under its EXACT parent member. It is captured as a *reference*
  `added` node (an `AddedEntity` carrying the child `prefab` GUID + its
  overrides/structure) on the owning top-level instance, and re-expands under the
  same member on load. Apply-to-Prefab promotes it to a nested row in the owner's
  `.prefab.json`.

## Prefab edit mode

**Double-clicking a prefab** in the Assets panel opens it *alone* in the Scene
viewport (Unity-style isolation) — `editor/scene/prefabEdit.ts`. Under the hood
`openPrefabForEditing()` synthesizes an in-memory scene from the prefab's
entities plus throwaway scaffolding (a directional + ambient light and a default
HDR environment, all named `__PrefabEdit*`) so the prefab is visible, and loads
it through `SceneManager.loadScene(path, { preloaded })`. A breadcrumb in the
SceneView toolbar (`← <scene> › 🧩 <prefab>`) marks edit mode; the scene name
shows there in normal mode too.

- **Cmd+S** routes to `savePrefabEdit()`, which serializes the prefab subtree
  back to its `.prefab.json` (the `__PrefabEdit*` scaffolds are excluded — they
  aren't descendants of the root, located via a sentinel `EntityAttributes.guid`).
- **It refuses while the run mode is not `stopped`** — the prefab twin of `saveScene`'s transience
  guard, and for the same reason doubled: it serializes out of the LIVE world, so a save during a
  scrub/preview envelope or during Play bakes a posed rig or a spawned prefab into the file, and
  every scene instantiating it inherits them. The guard lives inside `savePrefabEdit`, not in its
  callers, so the agent op (`prefabAction:'edit-save'`) inherits it — it had no such guard while the
  check sat in the Cmd+S handler alone. **Cmd+S does not need you to exit preview first**:
  `runSaveAll` puts a live envelope down before saving and picks it back up after (docs/editor.md
  § Animation Editor), so the guard is already satisfied by the time it runs. Stopping Play is still
  on you, and the agent op refuses in every non-stopped mode.
  Parked ASSET docs still flush in that state, because a `.particle.json` the panel owns is
  authored data in every run mode — see [mcp-persistence.md](./mcp-persistence.md) § 5.
- The breadcrumb **Back** button reloads the originating scene, which
  re-instantiates every instance of the just-saved prefab.
- Right-click → **Instantiate** still adds a copy to the current scene (the old
  double-click behavior).
- **Re-saving preserves the file's `localId` numbering and `name`** — see "localId
  stability" above; this is what makes prefab-edit safe to drive as a scripted
  round-trip rather than only a human UI action.
- **Undoing an Apply made here reloads this world from its scene snapshot** (#1573). The
  Inspector offers Apply on a nested instance whose source is not the prefab being edited, and the
  agent `apply` op reaches it too. Apply's undo restores the world from the `serializeScene`
  snapshot it took on each side. The scene branch reloads that snapshot at the scene path, and this
  world's scene path is `null`, so before #1573 only the applied prefab's file came back. The
  applied instance lost its edit, every other instance of that prefab in this world kept the
  applied state, and the next save wrote that state as an override on each of them. The same
  snapshot is now reloaded at the world's synthetic path (`prefabEditWorldPath()`), without the
  save: the Apply never wrote the edited prefab, and Cmd+S still does.
  - ⚠️ **Not a rebuild from the edited prefab's document**, which the first fix tried. A template
    document carries no live guid, so everything added in the session came back under a new one.
    Every later undo entry addressing it by guid silently missed. A new entity that inherited a
    deleted row's localId sentinel was saved with that row's durable nodeGuid. The scene snapshot
    keeps live guids, as it does in scene mode.
  - It does not carry template keys (a scene never writes `key`), and the reload does not re-mark
    them either: the loader recovers keys only from documents instantiated into the world, and the
    edited prefab never is in its own edit world. The editor's `recoverTemplateKey` recovers each
    from the node's guid against the whole prefab cache when a save or apply next reads it. A key a
    file holds therefore survives the undo, and one only ever minted in memory does not.
  - It reloads only if that world is still the live one. The file install before it is awaited, and
    an Exit landing in that window would otherwise have the synthetic world loaded under the real
    scene's path, where `saveScene` writes it into the scene file.
  - ⚠️ **A rebase is not a substitute either.** It rebuilds the applied instance with the overrides
    it holds against the applied document, which are none, so the edit being undone is lost from
    the prefab AND the instance.
  - `prefabEditApplyUndo.test.ts` mutation-checks each of these. The untitled-scene case is
    § Undoing an Apply (#1575).

**Reachable headlessly.** `openPrefabForEditing` / `savePrefabEdit` / `exitPrefabEditing` are
exposed as the `prefab` agent op / `modoki_prefab` MCP tool's `prefabAction: 'edit-open' |
'edit-save' | 'edit-exit'` — full tool contract (params, refusals, minimal call) in
[debug-tools-mcp.md](./debug-tools-mcp.md)'s generated tool catalog. `edit-open` swaps the world
exactly as `load-scene` does (refuses on unsaved work, takes `discardUnsaved`) and additionally saves the
current scene on the way in, deliberately, so the return trip's reload-from-disk is
non-destructive. In prefab-edit mode `modoki_save_all` writes any parked work (asset docs, base-scene
refs, import settings) and then refuses the scene half, because `edit-save` is the save for that
world.
`edit-exit` refuses the same way while the prefab world holds unsaved edits, because its reload of
the return scene discards that world (#1424). Before that fix it answered `ok:true` over an unsaved
delete, with the undo stack gone. `edit-save` first, or pass `discardUnsaved:true` to drop them
deliberately. Inside prefab-edit mode the refusal's remedy is split by cause: `edit-save` for the
prefab-world edits, `save_all` for parked work (`edit-save` does not write parked work). The human
"Back to scene" button asks through the #1419 modal ([editor.md](./editor.md) § "The unsaved-work
gate"). That modal counts only the world edits, because parked work survives the swap, while the
agent refusal also counts parked work, as every agent world swap does.

**Editing the template from an agent (#1254).** The prefab-edit world has no scene file. Prefab-edit
sets the editor's scene path to `null`, so a normal save cannot target a real file. That world is
therefore addressed by its synthetic handle, `/__prefab-edit__/<prefab guid>`, which
`modoki_get_editor_state` reports as `prefabEditWorld` only while that world is loaded AND its edit
session is open (`prefabSessionWorldPath(editingPrefab)`: the world and the session must name the same
prefab). An exit whose return-scene reload fails, or that has no scene to return to, clears the session
but leaves the world loaded. Nothing can persist an edit there (`edit-save` needs the session, and
`save_all` refuses the prefab world), so that world is deliberately not reported as editable.
- `modoki_mutate_scene` and `modoki_set_transform` with `path` **omitted** target it.
- `/api/scene-mutate` treats that handle as **LIVE-ONLY**. It applies through `apply-scene-ops` only
  when the renderer reports that exact world, and otherwise refuses: 409, or 400 for `setBaseScene`.
  It never falls back to a file write, because the template reaches disk only through `edit-save`.
- A stale handle therefore cannot edit whatever world happens to be live. That covers a handle left
  over after `edit-exit` (including the failed-reload exit above) and a handle for a different prefab.
- **Parent new entities UNDER the prefab root.** `edit-save` serializes only the root's subtree
  (`serializePrefab` → `collectTree(rootId)`), so an `addEntity` with `parentId: 0` succeeds live and
  is silently absent from the saved file.
- **Prefer `space: 'local'`.** A 2D template's root is re-parented under the editor-only
  `__PrefabEditStage` scaffold, so a `'world'` transform converts against the stage offset and
  `edit-save` bakes that offset into the template.
- The live entity tools (`create_entity`, `duplicate_entity`, `delete_entities`, `reparent_entity`)
  never needed a path, and work unchanged.
- `modoki_validate_scene` does not apply here: it validates files, so use `modoki_validate_prefab`
  on the `.prefab.json`.

This is what
`engine/scripts/resave-prefabs.sh` drives to bulk-migrate prefabs to the current serializer
format — see [scene-loading.md](./scene-loading.md) § "Re-saving legacy prefabs".

## Nested prefabs (v2)

A prefab may **contain other prefab instances** at any depth. A nested instance
is stored in the parent prefab file as a single *reference row* — one
`PrefabEntity` carrying the child `prefab` GUID plus its own
`overrides`/`added`/`removed`/`removedTraits` — mirroring how a scene stores an
instance. The child's members are **not** listed; they expand from the child
file at load.

Every file this serializer writes carries `PREFAB_FORMAT_VERSION` (**6** since #1533, **5** from #1468; this
paragraph said **2** until #1468, which is the drift a hardcoded number in prose always ends in —
read `runtime/core/version.ts`, which is where the constant lives now and which lists what each
version added). It used to be derived from
the document's content (`nestedRefs.size > 0 ? 2 : 1`, so flat prefabs stayed at 1),
and that rule was replaced in #379 because it could **decrease**: deleting a prefab's
last nested instance rewrote `2` back to `1`, which is not something a format version
may do. v1 and v2 share the same shape — the nested fields are optional — so a v1 file
still loads unchanged and no migration exists or is needed.

⚠️ **THE WRITE PATH NOW READS IT — that REVERSES what the rest of this section says, and the
reversal is deliberate (#1468, owner 2026-09-23).** A server-side gate
(`engine/plugins/prefabWriteGuard.ts`, wired into `/api/write-file` and the asset scanner's
`writeAssetGuid`) refuses to OVERWRITE a `.prefab.json` stamped **newer** than this build writes,
with a 409. Four client-side writers refuse earlier so the refusal lands before the live world has
been mutated, and `migrate-assets.mjs` / `migrate-anchor-zindex.mjs` carry their own copies because
they have no server between them and the bytes. Every comparison is `version > CURRENT`, never
`!==`: the authored corpus is entirely BELOW the constant, so an exact-match gate would refuse all
of it. What forced the reversal was v5 adding a field an older build destroys irrecoverably — a
minted `nodeGuid` per row, which cannot be re-derived because re-minting produces different guids.
Disposition and the wording it replaced: `docs/format-versioning.md` § 3.

**The LOADING path still does not read it**, and everything below remains true of loading.
`fetchPrefab` (`runtime/loaders/meshTemplateCache.ts`)
fetches, parses and caches; there is no version comparison anywhere between the
file and a spawned instance, and `getCachedPrefab` is a map lookup. The field is
a marker for the SERIALIZER, and no consumer acts on it. (It used to record
*whether the file nests*; since #379 it records only *which serializer wrote it*.)

Say so plainly, because the gap where this sentence used to be is what produced
the defect: #344 read a version marker with no stated consumer, inferred that an
unexpected value must gate loading, and that inference was then written as fact
into a commit message, two game docs, a guard test and three issues (#363, #364,
#365) before anybody observed it. Two independent measurements killed it —
`games/space-console`'s nested spaceship prefab spawns byte-identically at 1 and
at 2 across all three of its scenes, and Court's flat level tile at `version: 2`
renders its full pooled 25-tile grid with no console warning.

⚠️ **Those two measurements can no longer be repeated from the repo as it stands.**
#379 migrated every tracked prefab to 2, so there is no flat-vs-nested or 1-vs-2
contrast left on disk to re-run them against. They are recorded here as the evidence
that settled #344 — reproduce them by hand-editing a copy, not by looking for a v1
file. `version` is
now guarded by **nothing**: `prefabFormatVersion.test.ts` was deleted (owner,
2026-08-27) rather than narrowed to "2 only on a prefab that really nests
another". The narrowed rule was written and green, and the reason it went is
worth keeping — the mistake it caught is one both measurements had just proved
**harmless**, so it was a red gate with no failure mode behind it, on a field no
code reads.

**What emptied #344's grid is therefore still unidentified — and there is very
likely nothing to find.** `ec48f2586`, the commit reported as broken, was checked
out and the editor booted COLD against it: the selector rendered 100 tiles and
100 visible numbers, and nothing on the prefab-loading path has changed since. So
the symptom does not belong to any committed tree. The file is also
byte-identical across the "broken" and "fixed" commits apart from that one
number, so the A/B was confounded — most likely by the prefab cache, which
serves the doc it read at scene load: restructure a `.prefab.json` under a live
editor and instances keep spawning from the OLD copy until something forces a
re-read. **If a pooled view renders empty, restart the editor before believing
the file.**

- **`rootInstanceId` semantics are unchanged**: it is the ECS id of the
  *innermost* instance root an entity belongs to. Nesting is expressed purely
  through `EntityAttributes.parentId` — the inner instance's root hangs under an
  outer member, but inner members carry the inner root's `rootInstanceId`.
- **Instantiation** (`instantiatePrefab` editor / `instantiatePrefabIntoWorld`
  runtime) recurses on a `prefab` row, expanding the child from cache, applying
  its overrides/structure, and parenting its root to the outer member. The outer
  pass sets `rootInstanceId` only on its *own* members so inner ids aren't
  stomped.
- **Cycle safety** is two-layered: `wouldCreateCycle` rejects a *save* that would
  nest a prefab inside one of its own descendants (A → B → A) — a prefab-edit save,
  Create Prefab's Replace, and Apply's promotion of an added node (`addedNestsPrefab`,
  #1446: it used to write the row, which expanded to nothing, so the user's instance
  vanished on the refresh). Both read every prefab a file EXPANDS (`expandedPrefabRefs`:
  rows, and the reference nodes rows add, in `added` or `nestedStructure`), never trait
  data — a spawner trait's `prefab` field is not nesting. A SCENE may hold such a nesting; only a file may not. A `_stack` of
  prefab GUIDs in the instantiate path is the backstop (an on-disk cycle can never
  hang the loader). Because a prefab can never transitively contain itself,
  refreshing every instance of one source is order-independent.
- **Apply-to-prefab refresh preserves placement**: `refreshInstances` tears down
  and re-instantiates each instance under its *original* parent, so a nested
  instance (or any instance parented to a non-root entity) is not detached to the
  scene root.
- **Serialization** (`serializePrefab`) writes a nested instance below the
  selection root as a reference row via `captureInstanceReference` and excludes
  its members from the flat output. The selection root itself is never collapsed.
- **Resource acquisition** is transitive: `SceneManager` walks each fetched
  prefab for nested `prefab` refs and acquires them under the scene id.
- **Caching — and it cuts BOTH ways, which is the part that bit (#1284).** The editor's
  `prefabCache` is read *synchronously* by code on both sides of the nesting, and every
  one of those readers treats "not in the cache" as "not a prefab":
  - **instantiate** — `instantiatePrefab` skips a nested row whose child is not cached
    (it warns). `instantiatePrefabAsync` exists so UI entry points cannot get this wrong.
  - **serialize + capture** — `planPrefabRows` **flattens** a held nested instance into
    copies, `captureNestedRef` drops a user-added nested subtree from `added[]`, and
    `captureNestedInstanceOverrides` / `reapplyNestedInstanceOverrides` lose a nested
    instance's per-copy overrides across a rebuild *with no warning at all*.

  ⚠️ **There are two warmers, and they answer different questions.**
  `preloadNestedPrefabs(prefabFile)` walks a prefab FILE's reference rows;
  `preloadNestedPrefabsForSubtree(entityId)` walks the LIVE tree. **The sync readers above
  all walk the live tree**, so the file walk alone leaves anything live-but-not-in-the-file
  cold — and an ordinary scene load leaves the *whole* cache cold, because the loader fills
  the RUNTIME cache (`meshTemplateCache`), not this one.

  That gap is what #1284 was: Create Prefab warmed nothing, so on a freshly-loaded scene it
  silently wrote copies instead of a reference, and the author found out weeks later when
  editing the child prefab moved nothing. The rebuild paths warmed from the file, so they
  lost only *user-added* nested instances — the same defect at a smaller amplitude.

  **Serializing a live tree therefore means `await preloadNestedPrefabsForSubtree(id)`
  first**, and `serializePrefab` stays synchronous so the obligation sits with the caller
  who can actually await. The scene save does the same thing its own way — `serialize.ts`
  collects every live instance source and awaits `getPrefabSource` over the set before its
  capture loop — which is why a scene save has never lost nesting to a cold cache.

  The live walk does **not** recurse into each fetched file's rows, deliberately:
  `collectTree` is a full descendant walk and every nested root is its own
  `PrefabInstance`, so depth is already covered. A recursion was written and removed —
  with both present, neither could be shown to fail, which is the shape of a line that is
  load-bearing only in appearance.

  Guarded two ways: `coldPrefabCacheWarming.test.ts` (behaviour, starting from a cold
  cache — note every OTHER nested test calls `setPrefabCache` by hand and so only ever
  exercised the warm path) and `prefabCacheWarm.test.ts` (the swap warm and the instantiate
  helper — the two mechanisms that make the cache populated by construction).

  ⚠️ **Every entry point that reaches one of these readers now warms — including the undo/redo
  closures.** Those were deferred three times as "synchronous closures that can never await",
  and that was simply false: `UndoAction.undo/redo` are typed `(): void | Promise<void>`,
  `undoManager`'s `runStep` does `await run()`, and the comment beside its in-flight mutex says
  an action's undo/redo may await, *"e.g. prefab instantiate redo"*. A wrong premise survived
  three passes because each one restated it instead of checking the type.

  Each closure that warms then **re-resolves its `entityRef`**: a cold source makes the warm do
  real I/O, and `entityRef` exists in those files precisely because a raw ecs id goes stale
  across a world rebuild (Play→Stop, a watcher reload).


  ⚠️ **The cache is now populated BY CONSTRUCTION, and the per-call-site warms are belt-and-braces
  rather than the mechanism** (#1295). Two things make it so, and they are what to keep working if
  this ever regresses:
  - **`instantiatePrefabInstance`** — every path that spawns a prefab from an asset path caches it
    under the ref the new instance actually CARRIES. `setPrefabSource` resolves a path to a GUID
    whenever the manifest can, and nothing used to cache under that guid, so a prefab dropped in
    mid-session was unreachable however warm the scene load had been.
  - **`installEditorPrefabCacheWarm`** — a `beforeSwap` hook (the loader awaits it, so the swap
    cannot complete half-warm) that takes each prefab from the RUNTIME cache the loader has already
    filled. A `Map.get` plus a `Map.set`; it only fetches for a source the runtime cache cannot key.

  ⚠️ **"By construction" is NOT universal, and the exceptions are why the per-call-site warms stay.**
  Three spawners put a live instance into the CURRENT world *after* the swap, so the beforeSwap hook
  structurally cannot reach them: the timeline scrub preview and its control-track edge
  (`runtime/timeline/timelineSystem.ts`), and the UIEntries scroll pool
  (`runtime/loaders/entryPrefabProvider.ts` → `runtime/ui/entriesSystem.ts`). All three go through
  `spawnPrefabInstance`, which writes a non-empty `source`, and none goes through
  `instantiatePrefabInstance`. A game spawning a prefab from `onSceneReady` is the same shape.

  ⚠️ **Those three spawners are deliberately NOT made to seed the editor cache** (#1301). Seeding
  would make the sync readers read them *correctly*, and reading them at all is the defect: every
  instance those three create is `Transient`, and a `Transient` instance is not authoring input.
  The rule in § Authoring scope (end of this file) is what closes that hole — at the reader rather
  than at the spawner.

  The ~15 `await preloadNestedPrefabsForSubtree(...)` calls are therefore deliberately KEPT: each
  is a `Map.has` once warm, the failure they guard against is SILENT, and the paragraph above does
  not cover everything. They are the cheap half of the defence; the census that policed them was
  the expensive half, and only that was removed. ⚠️ Nothing now detects their removal — that was
  the census's one uncovered job, recorded here rather than left implicit.

  ⚠️ **Do not trust a census that anchors on ONE reader — this paragraph shipped a wrong count
  three times doing exactly that.** The sync reads are not three; in `prefab.ts` alone there are
  **seven** (`planPrefabRows`, `instantiatePrefab`, `wouldCreateCycle`, `captureNestedRef`,
  `applyStructureByRootInstance`, and two inside the nested-override capture/replay pair), plus
  `Inspector.tsx` and the prefab-edit save. They are reached by different call chains, so a sweep
  anchored on `captureInstanceStructure` cannot see the one that reaches `planPrefabRows` through
  `tagEntityTreeAsInstance` — which is how `assetOps`' async redo survived a manual sweep AND an
  adversarial review. A source census used to pin three anchors separately for that reason; it was
  **deleted** once the cache became populated by construction (see below), because it needed a new
  anchor per reader and that treadmill was its own maintenance defect.

  ⚠️ **`applyToPrefab` is the one worth remembering**, because it shows what the cold read
  actually costs. It captures the structure and uses the result to BUILD the key set it hands
  to `applyToPrefabSelective`, so a cold miss did not merely hide a row — it silently dropped
  a hand-added nested subtree from an action whose entire promise is "apply all of it". It was
  found by a source census on its first run, having been missed by both a manual sweep and an
  adversarial review — which is the argument for the construction-level fix below rather than for
  keeping the census.

  ⚠️ **One behaviour change worth knowing, because warming changes what a GUARD can see.**
  `planPrefabRows` runs `wouldCreateCycle` BEFORE the cache lookup, and that guard returns
  `false` on a miss — so a cold cache made it blind. With the tree warmed it now has the data
  to refuse: `modoki_prefab create` over an EXISTING path, on an entity holding an instance of
  a prefab that nests the target guid, used to flatten-and-succeed and now fails the op with
  `could not serialize prefab from entity N`. That is the guard working, but it is a new
  refusal rather than a silent mis-save.
- **A prefab's effective ROOT, without spawning** (#1031): `effectivePrefabRootTraits`
  in `runtime/loaders/prefabOverrides.ts` answers "what traits would a spawned
  instance's root carry?" — for code that must not spawn: the `UIEntries` pool
  provider (`rootSize`, `rootAuthoredUI`, `isCached`) and the scene validator's
  entry-prefab pass. It mirrors `instantiatePrefabIntoWorld` step for step:
  - the root is `rootLocalId ?? 1` — **not** "the first row", which the provider and
    the validator used to fall back to and the spawner never did;
  - a **nested-instance root row** resolves to the CHILD prefab's root, with the row's
    `overrides` merged UNDER whatever an outer layer addresses at that row (outer
    wins), its `nestedOverrides` threaded on, and its `removedTraits` applied in the
    child. The row's own `traits` are not part of the answer — the spawner reads
    only `parentId` there;
  - the outer layer's `overrides` for the root fold on after that, then its
    `removedTraits` — the spawner's order (overrides, then structure);
  - no root would spawn (an uncached child, no row at the root localId, a cycle)
    → `null`, and the provider reports the prefab **not cached**, because
    `spawnInstance` would return 0.

  **Any member, not just the root:** `effectivePrefabMemberTraits(prefab, localId, …)`
  is the general form (the root is `localId = rootLocalId ?? 1`). The validator's
  instance-override pass uses it to read the base `UIElement`/`UIAnchor` a scene
  override lands on — a nested member's base is its child prefab's root, which the
  pass could not see while it read raw rows.

  ⚠️ **Why a separate module rather than a helper in `loadSceneFile.ts`:** the
  validator runs in the Node Vite plugin with no trait registry, imports nothing that
  calls `trait({...})`, and is itself imported by `loadSceneFile.ts`. So the override
  helpers (`mergeOverrideMaps`, `descendNestedOverrides`, `mergeNestedOverridePaths`)
  and the per-trait fold (`foldTraitOverride`, which the spawner's
  `applyOverridesByLocalToEcs` now calls too) live there, re-exported from
  `loadSceneFile.ts`. The two override RULES are **injected**: `acceptField` (which
  fields count) and `traitKind` (what a name is — the spawner ADDS a known trait an
  override names even when no field of it is accepted, a tag as a tag, and skips a
  name it does not know). The provider passes the registry's answers; the validator
  rebuilds both from its `SceneSchema`, which is stricter than the spawner for AoS
  traits (it lists their factory fields, the spawner accepts any) — neither pass reads
  one. The merge ORDER is control flow in the spawner and cannot be shared, so
  `tests/runtime/prefabOverrides.test.ts` spawns every fixture through the real
  spawner and requires field-by-field agreement.

  Before #1031 both callers read the root row's own `traits`, so a nested-instance
  root reported a 0 size and no authored `UIElement`, silencing every pooled-row
  authoring warning. **Latent, and not a shape the editor writes** — no prefab in
  `games/` or `demos/` has a nested-instance root, and the prefab serializer never
  collapses the selection root into a reference row (`editor/scene/prefab.ts`), so it
  arises only from hand- or agent-written JSON. That is why it was fixed by
  construction rather than observed. Its cycle guard is keyed on each level's `id` AND the ref it was reached
  by, registered once on entry: a first draft registered the child's ref in the
  parent before recursing, and since a real prefab's `id` IS that ref, every nested
  child resolved to `null` as a self-cycle.

**Not yet done — stated honestly:**

- **A dedicated Prefabs category in Assets** — prefabs currently show alongside
  other assets rather than in their own section.
- **Live propagation to instances in the current scene** — saving a prefab (edit
  mode or *Apply to Prefab*) re-instantiates instances on the next scene
  reload / on returning from edit mode, not in place for an unrelated already-open
  scene. `refreshInstances` handles apply-to-prefab within the same world.
- **Structural edits on an OWNED nested instance** — adding/removing entities on a
  prefab's *own* internal nested instance (one that expanded from the prefab
  definition) still only round-trips field overrides via `nestedOverrides`, not
  structural diffs. (A *user-added* nested instance, by contrast, round-trips fully
  via reference `added` nodes.)
- **Live override on a specific nested copy across an outer apply-refresh** — if
  you override a field on the nested child of one live instance and then *apply to
  the outer prefab*, that ad-hoc override is not re-captured onto the rebuilt
  nested copy (outer override capture is scoped to the outer instance's own
  members). Overrides authored in the outer prefab file's nested row, and edits
  made in the child's own edit session, both survive normally.


## Authoring scope — a runtime instance is not authoring input

**Rule: a reader that treats the LIVE TREE as authoring input asks one shared predicate,
`collectTransientSubtreeIds` / `filterAuthoringVisible` (`editor/scene/authoringScope.ts`).**
A `Transient` entity — a UIEntries pooled row, a timeline scrub or control-track spawn, anything a
system spawned inside a tick — is a live artifact, and its subtree goes with it.

| Reader | What it does | Before #1301/#1306 |
|---|---|---|
| `serializeScene` | writes the scene file | hand-rolled copy of the walk |
| `captureInstanceStructure` | diffs an instance against its prefab | hand-rolled copy (added by #1295's review) |
| `collectInstanceRoots` | Apply-to-Prefab's fan-out to every instance | **never asked** |
| `serializePrefab` -> `collectTree` | Create Prefab | **never asked** |

The two misses look unrelated at the symptom level — one saves a scene, one writes a prefab file —
which is exactly why two hand-rolled copies were not enough. What each one did:

- **`collectInstanceRoots`** handed a pooled/scrub instance to `refreshInstances` -> `rebuildInstance`,
  which carried the durable guid and `source` forward but **not the tag**. The rebuilt root was an
  ordinary serializable entity, so the next save wrote a preview artifact into the authored scene —
  defeating the guarantee `spawnPrefabInstance` sets `Transient` for. `rebuildInstance` now carries
  it over the respawn as well, on the same reasoning that already carries the guid: transience
  belongs to the identity, not to the id.
- **`serializePrefab`** wrote them into the new `.prefab.json` as ordinary authored members. It now
  **reports** what it left out (a toast on both human entry points through one shared wording, a
  `warnings` entry on the agent op) rather than quietly producing a smaller prefab.

  ⚠️ **The unit of exclusion is a generated REGION, not a tagged entity** — a region being a tagged
  subtree whose top's parent is not tagged. Create Prefab excludes every region that STARTS inside
  the selection, except one starting at the selection root itself, which is the deliberate "bake
  this". Both simpler rules are wrong, and both were written before this one:
  - *"drop every tagged entity in the selection"* destroys the bake case, because in production
    **every** member of a region carries the tag (`spawnEntity` tags whatever is spawned inside a
    system tick), not just its top — so baking a pooled row would write a one-entity prefab.
  - *"skip filtering whenever the selection sits anywhere inside a region"* re-opens this very
    issue: an unrelated region deeper in the selection is then written into the file as an authored
    member **and** tagged as an instance member, silently, with the report suppressed. Measured by
    the close-out re-review on a `PooledRow → Middle → InnerPooled` tree.

  The count is scoped to the selection for the same reason the exclusion is: a world-wide tally made
  every Create Prefab in a pooled scene warn about entities it had not dropped, which is the alarm
  that makes the true report unreadable.

⚠️ **Create Prefab reads the world TWICE, and both reads go through `authoringEntitiesFor`.**
`serializePrefab` writes the file; `tagEntityTreeAsInstance` then re-walks the tree and re-runs
`planPrefabRows` to convert it into a live instance — and **refuses to tag at all** when its plan
does not match the file (`planMatchesFile`, a bare `return`). So a selection rule applied to one
read and not the other does not produce a wrong prefab, it produces a prefab asset with **no
instance in the scene and nothing logged**. This is the second instance of that shape: #1278 was
the first (a held nested instance gave the two reads different localId spaces). `planMatchesFile`
is the backstop; the two reads agreeing at the source is the fix.

⚠️ **The subtree is the load-bearing half, not the tag.** Only the ROOT of a generated subtree is
tagged (`spawnPrefabInstance` tags the instance root; members spawned outside a system tick are not).
A reader that filters on `has(Transient)` alone keeps the members and drops their parent — an
orphaned half-subtree, which is worse than not filtering at all.

⚠️ **This is NOT a Play-mode concern, and reading it as one is why both misses looked unreachable.**
`runPipeline` skips a system only below `TRANSFORM` (200), and the UIEntries pool sits at 270 so a
paused list keeps recycling: measured on `games/scroll-demo`, a **stopped** editor holds 16 pooled
entities out of 36, including 8 live prefab-instance roots that match `collectInstanceRoots`' filter
exactly. A scrub envelope also reports `playState: 'stopped'` (#1122/#1148), which is what lets an
authoring mutation through in the first place. Play-mode spawns, by contrast, never survive Stop —
`playMode.ts` reloads the snapshot and discards them.

⚠️ **What actually applies the tag is the SYSTEM TICK, not the spawner — and that is load-bearing.**
`spawnPrefabInstance` tags only when `forceTransient` is passed or the run-mode is not `stopped`
(`loadSceneFile.ts`), and the timeline scrub is the only caller passing `forceTransient`. The
UIEntries pool's rows and the control-track edge's spawns are tagged because `spawnEntity` tags
**everything spawned inside a system tick** (`core/ecs/world.ts`), and `entriesSystem` spawns from
inside its own tick deliberately. So: move the pool's growth out of the tick — to a DOM handler, a
React effect, a deferred callback — and every reader above goes quiet with no test failing. The
pool's docblock already says it must spawn inside the tick; this is the other half of why.

⚠️ **Therefore "a runtime spawn is `Transient`" is NOT universal, and a game's own spawn is the
gap.** A game spawning a prefab from `onSceneReady` while stopped, outside a tick, gets **no tag** —
so `collectInstanceRoots` still fans out to it and Create Prefab still bakes it in.
`games/sling/runtime/field/rebuildField.ts` adds the tag by hand, which is evidence the hole is
known and nothing makes it structural. Fixing that means changing where the tag comes from, not
adding a fifth reader-side check (found by #1301's close-out review, F8; not filed).

⚠️ **The predicate lives in its own module, not on `entityUtils`.** Most editor tests mock
`entityUtils` with an explicit object literal, so an export added there arrives `undefined` in every
one of them — the guard would be silently absent in all 284 files while they all stayed green.
