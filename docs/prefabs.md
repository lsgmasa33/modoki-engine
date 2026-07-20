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

## Core operations (`editor/scene/prefab.ts`)

- **`serializePrefab(selectedEntityId, existingId?)`** — collects the selected
  tree (`collectTree`, BFS), assigns `localId`s, snapshots each trait, remaps
  parent links to localIds, and rewrites asset path refs to GUIDs. Pass
  `existingId` to preserve a prefab's UUID on re-save.
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
- The breadcrumb **Back** button reloads the originating scene, which
  re-instantiates every instance of the just-saved prefab.
- Right-click → **Instantiate** still adds a copy to the current scene (the old
  double-click behavior).

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
