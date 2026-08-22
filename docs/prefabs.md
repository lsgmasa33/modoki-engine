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
every instance would start with the same stale guid). The prefab file never
carries `PrefabInstance` traits; those are added programmatically on spawn.

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

Prefab-edit mode is the only caller that supplies them today. It is **not** the only path that
re-serializes an existing file, so the other three are worth knowing:

| Path | Passes `existingId` | localId behaviour |
|---|---|---|
| **prefab-edit save** (`savePrefabEdit`) | yes | **preserved** — the mechanism below |
| **rigged model re-import** (`ModelAssetView`) | yes | preserved by a *different* mechanism: serialize positionally, then `mergeRiggedPrefab` matches bones by NAME so their localIds stay stable and user-added children stay attached |
| **2D skin rig write** (`skinPrefab.ts`) | yes | **renumbered** — the subtree is rebuilt from `rigDef.bones`, so ids follow the rig definition, not the file |
| **`prefab` agent op, `create` over an existing path** | yes (`resolveExistingPrefabId`) | **renumbered** — it replaces the template with a scene entity tree, which is the intent |

The last two are the same hazard this section describes, left as-is because both *regenerate* a
template from a source of truth rather than round-tripping the authored file. Overrides keyed to
a prefab written by either path can still be repointed by a structural change to its source.

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
  "removedTraits": { "5": ["Light"] }      // localId → trait names deleted from a member
}
```

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

## ⚠️ A prefab EDIT empties the runtime cache, and nothing refills it

**Saving a prefab in the editor drops it out of the runtime cache, and only a SCENE LOAD puts it
back.** A game that spawns prefab instances at runtime therefore stops being able to, silently,
for the rest of the session — the symptom is whatever that game does when the prefab is missing.

The mechanism, verified in a running editor (2026-08-19):

- A prefab write goes through `setPrefabCache()` / `writePrefabFile()`
  (`editor/scene/prefab.ts`), which calls `invalidatePrefab(source)` — deleting the entry from
  the **runtime** `prefabCache` in `runtime/loaders/meshTemplateCache.ts`.
- `acquirePrefab` is the only thing that refills it, and it is called from just two kinds of
  place: `SceneManager` during a scene load, and games that preload deliberately
  (`games/sling`, `demos/forest-camp`, each with its own owner-id sentinel).
- So after such a write, `getCachedPrefab()` returns `undefined` until the next scene load.
  **Nothing warns.**

⚠️ **WHICH writes actually strand it — this matters, and an earlier draft of this section got it
wrong.** The invalidate's own comment states the intended contract ("so the NEXT scene load
re-reads the new file"), and **prefab-EDIT MODE honours it**: `exitPrefabEditing` calls
`loadScene(target)`, which re-acquires. So the open-edit-save-exit loop is safe, and
`games/court/art.md`'s claim that the tray "picks the new offsets up when you leave edit mode"
is **correct for that workflow**.

The paths that invalidate an in-use prefab and do **not** reload are:
- **Apply to Prefab** on a scene instance — `applyToPrefabWithUndo` → `writePrefabFile`, live-only.
- **`modoki_prefab action:'apply'`** (and `'create'`), the agent surface for the same op.

Creating a NEW prefab from an entity (`assetOps.ts`) also invalidates, but only its own
freshly-minted guid, which nothing is using yet — harmless.

⚠️ **There is NO file-watcher path.** Editing a `.prefab.json` on disk does not invalidate
anything, so the runtime keeps serving the OLD prefab until a scene load — a staleness problem,
not a fallback one, and the opposite failure to the above.

**What this looks like in a game.** Court's guard flag falls back to drawn primitives when its
prefab is uncached, so after an Apply-to-Prefab the flags already planted keep the real art while
every new one draws a placeholder, and the board stays mixed until a scene load. Fixed there by
recording the art each instance was spawned with, retiring on a mismatch, and asking for the
prefab back once on a miss (`syncFlags`, `games/court/runtime/systems.ts`).

**Measured on Court's tray badge, 2026-08-19** — the wholesale version of the same failure. With
the prefab cached, a board build gives the authored instance (`Coin` ×6, `CountBadge`, `CountBanner`,
`InfoBadge`, `ChipRow`). Invalidate, then rebuild the board with **no** scene reload, and every one
of those drops to **0**, replaced by the pre-#171 code-spawned set (`TrayIcon_<piece>`,
`TrayCountBanner_<piece>`, `InfoBadge_<piece>` …). The tray silently reverts to the old art and
the constant layout — `refreshBadgeLayout` and the instantiation are two separate consumers of the
same cache and both fall back.

**If you spawn prefab instances at runtime, handle the miss on purpose.** Two things, and the
first alone is not enough:

1. **Re-acquire on a cache miss** — `void acquirePrefab(<your owner sentinel>, guid)`, guarded so
   it fires once per guid rather than every frame.
   ⚠️ **Re-arm that guard on the fetch POPULATING the cache — never in a `.catch`.** Measured
   2026-08-19: `acquirePrefab` on an unresolvable guid **RESOLVES**, with the cache still empty —
   `fetchPrefab` swallows `!res.ok` and parse errors and never rejects. So a `.catch(() => rearm)`
   is dead code, and a guard that is never re-armed heals only the FIRST invalidation: a second
   Apply-to-Prefab in the same session stays broken. Re-arming unconditionally is the opposite
   trap, refetching a genuinely-missing prefab every frame forever. `.finally(() => { if
   (getCachedPrefab(ref)) rearm; })` is the shape that does neither.
   ⚠️ Whether you are exposed depends on **what else clears your guard**: `games/court` clears its
   on every board build, so it was safe either way; `games/sling` clears its only on unregister and
   `demos/forest-camp` only on world swap — and an Apply-to-Prefab is neither.
2. **Remember what each live instance was built FROM**, and retire instances whose source no
   longer matches. Without this, the window between the invalidation and the re-acquire leaves a
   mixed population that never converges, because "this cell already has an instance" is true and
   says nothing about which art that instance wears.

Court's tray badge has now been audited (#262) — see the measurement above.

⚠️ **Acquiring under your own owner sentinel means RELEASING it too.** `acquirePrefab(<sentinel>,
guid)` adds that sentinel to the prefab's owner set, so the scene's own `releaseAllForScene` can
never evict it and the prefab outlives the game. Drop the holds wholesale when the game
unregisters — `releaseAllForScene(<sentinel>)`, not `releasePrefab` per guid, because a per-guid
release leaks anything the acquire pulled in transitively (`games/sling` records this at its own
call site, and `games/court` had to add it after missing it). Two other games still spawn prefabs
at runtime without the re-acquire half: #265.

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

**Reachable headlessly.** `openPrefabForEditing` / `savePrefabEdit` / `exitPrefabEditing` are
exposed as the `prefab` agent op / `modoki_prefab` MCP tool's `prefabAction: 'edit-open' |
'edit-save' | 'edit-exit'` — full tool contract (params, refusals, minimal call) in
[debug-tools-mcp.md](./debug-tools-mcp.md)'s generated tool catalog. `edit-open` swaps the world
exactly as `load-scene` does (refuses on unsaved work, takes `discardUnsaved`) and additionally saves the
current scene on the way in, deliberately, so the return trip's reload-from-disk is
non-destructive; `modoki_save_all` refuses outright while in prefab-edit mode. This is what
`engine/scripts/resave-prefabs.sh` drives to bulk-migrate prefabs to the current serializer
format — see [scene-loading.md](./scene-loading.md) § "Re-saving legacy prefabs".

## Nested prefabs (v2)

A prefab may **contain other prefab instances** at any depth. A nested instance
is stored in the parent prefab file as a single *reference row* — one
`PrefabEntity` carrying the child `prefab` GUID plus its own
`overrides`/`added`/`removed`/`removedTraits` — mirroring how a scene stores an
instance. The child's members are **not** listed; they expand from the child
file at load. Files that contain a nested row are written as `version: 2` (flat
prefabs stay `version: 1`; the nested fields are optional, so a v1 file is a
valid v2 file — no migration).

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
  nest a prefab inside one of its own descendants (A → B → A), and a `_stack` of
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
- **Caching:** the editor's sync instantiate reads nested children from the
  editor `prefabCache`; async entry points call `preloadNestedPrefabs()` first so
  they're present (also why edit-mode save references rather than flattens).

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
