# Scene Loading

A scene is a single plain `.json` file under a `scenes/` dir (not `.scene.json`)
that is the **sole source of truth** for what exists in the world. Scenes load asynchronously into an isolated staging
world, then swap in atomically so no system ever observes a half-built scene.

See also: [Architecture](./architecture.md) · [Prefabs](./prefabs.md) · [Visual Editor](./editor.md)

## Two-world architecture

There is **no singleton world**. `runtime/ecs/worldRegistry.ts` owns the active
koota `World` and exposes:

- `getCurrentWorld()` — the active "main" world (created lazily on first call).
- `setCurrentWorld(next)` — atomically promotes `next` to active and fires swap
  listeners.
- `onWorldSwap(fn)` — subscribe to `(newWorld, oldWorld)` swap events; returns
  an unsubscribe function.
- `getEntityIndex(world)` — per-world `Map<number, Entity>` index, stored in a
  `WeakMap<World, …>` so a dropped world's index is GC'd with it.

Consumers must call `getCurrentWorld()` **inside** callbacks/functions, never
capture it at module load — otherwise a swap wouldn't take effect for them.
`runtime/ecs/world.ts` re-exports these and adds entity-index helpers
(`registerEntity`, `findEntityById`, `unregisterEntity`).

During a load, `SceneManager` builds a fresh staging world with koota's
`createWorld()`, populates it in isolation (no system runs against it because
it isn't active), then calls `setCurrentWorld()` to flip it in one statement.
Renderers (`Scene3D`, `Scene2D`, and the `useUIEntities` selector) subscribe to
`onWorldSwap` to flush their per-world caches the moment the swap happens.

> koota caps total worlds at 16. `SceneManager` calls `oldWorld.destroy()`
> after each swap to free the slot; without it the engine breaks after ~16 swaps.

## Resource cache with refcounting

`runtime/loaders/meshTemplateCache.ts` is a content cache keyed by the resolved
path, with per-resource ownership tracked as `Set<SceneId>`. Each resource kind
has typed acquire/release functions that take `(sceneId, ref)` where `ref` is a
**GUID** (resolved to a path via the asset manifest). References are GUID-only:
an internal asset path (e.g. `/games/x/foo.mesh.json`) is rejected by
`resolveRef` with a loud `console.error` and resolves to `undefined`, so a
stale/wrong ref fails visibly instead of silently loading. Genuinely external
resources (`http(s)://`, `data:`, `blob:` URLs) are not manifest assets and pass
through unchanged. See `runtime/loaders/assetManifest.ts` (`resolveRef`,
`isInternalAssetPath`, `isExternalUrl`).

| Resource | Acquire | Owns |
|----------|---------|------|
| `.glb` model | `acquireModel` / `releaseModel` | mesh templates (geometry + material) |
| `.mesh.json` | `acquireMesh` / `releaseMesh` | metadata; transitively acquires its model + material |
| `.mat.json` | `acquireMaterial` / `releaseMaterial` | one `THREE.Material` + its texture |
| `.prefab.json` | `acquirePrefab` / `releasePrefab` | parsed prefab JSON |
| HDR environment | `acquireEnvironment` / `releaseEnvironment` | `THREE.DataTexture` (IBL) |

`acquire*` adds the `sceneId` to the resource's owner set (kicking off the load
on first owner); `release*` removes it and disposes the GPU resource only when
the set becomes empty. Because ownership is a **set of scene ids**, two scenes
can SHARE the same resource — neither disposes it while the other still holds it.

Acquisition is **transitive**: acquiring a `.mesh.json` also acquires its
underlying `.glb` and any `.mat.json` it references (and a model with baked LODs
acquires each LOD GLB). All transitive dependencies are tracked under the same
`sceneId`, so a single `releaseAllForScene(sceneId)` tears the whole graph down.

`releaseAllForScene()` runs **after** the swap so a shared resource's refcount
only drops to zero once no remaining scene owns it.

## Scene manifest format

The current scene file version is **9** (`SceneFile.version`), stamped from
`SCENE_FORMAT_VERSION` in `runtime/version.ts`; the `SceneFile` interface is
defined in `editor/scene/serialize.ts`:

```ts
interface SceneFile {
  id: string;             // stable UUID, written once, survives renames/moves
  version: number;        // stamped from SCENE_FORMAT_VERSION (currently 9)
  createdAt: string;
  resources: ResourceRef[];
  entities: SerializedEntity[];
}
```

A `ResourceRef` has `{ type, path, loader?, postprocessor? }` where `type` is one
of `model | riggedModel | mesh | material | texture | prefab | font | environment | particle | animation`.
`collectResourceRefsFromEntities()` (runtime, in `loadSceneFile.ts`) walks every
entity for the asset fields it references — including structural `added` subtrees
and reference-node `prefab` GUIDs — and emits a sorted, deduped ref list. The
editor's `collectResourceRefs()` (serialize.ts) **delegates** to it, so there is a
single ref-walking implementation rather than two that can drift.

`resources` is a hint, not the authority: at load time `SceneManager` re-walks
the entities (and every referenced prefab's nested entities, iteratively) so a
stale manifest missing an entry — e.g. an HDR added after first serialization —
still preloads everything and avoids first-view pop-in.

### Migrations

Migrations chain in `loadSceneFile.ts` and run before any entity spawns:

- `migrateSceneData` — v3→v4 (move text fields `UIStyle`→`UIText`, strip
  `Transform` from UI entities)
- `migrateV4toV5` — merge `UIStyle`/`UIText`/`UIContent` into `UIElement`, drop
  `elementType`
- `migrateV5toV6` — derive the `resources` array by walking entities for older
  scenes
- `migrateV6toV7` — `Renderable2D.size` → `width` + `height`
- `migrateV7toV8` — move `Persistent.guid` → `EntityAttributes.guid`; `Persistent`
  becomes a bare marker tag
- `migrateV8toV9` — rename renderable traits' per-renderer `isActive` → `isVisible`
  (splitting it from the entity on/off `EntityAttributes.isActive`), walking traits
  plus prefab override/added/nestedOverride subtrees

## SceneManager API

`runtime/scene/SceneManager.ts` exposes the singleton `sceneManager`. The core
call is:

```ts
await sceneManager.loadScene(path, {
  onProgress?: (loaded, total) => void,
  signal?: AbortSignal,
});
```

`loadScene` flow:

1. **Cancel in-flight load** — aborts the previous preload and releases its
   acquired resources (cancel-and-replace; only one preload runs at a time).
2. **Allocate** a fresh `SceneId` + `AbortController`.
3. **Fetch + migrate** the scene JSON.
4. **Acquire all resources in parallel** (`Promise.all`), iteratively expanding
   nested prefab resources first.
5. **Spawn entities** into the staging world via `loadSceneFile` (dormant — no
   active system touches them).
6. **`beforeSwapHooks`** run (`registerBeforeSwap`) — e.g. renderer shader
   pre-warm via `compileAsync` to kill the first-frame stutter. Failures are
   logged and swallowed.
7. **Atomic swap** — `setCurrentWorld(staging)` fires `onWorldSwap`; then
   `releaseAllForScene(oldSceneId)` drops the old scene's refcounts; then
   `oldWorld.destroy()` frees the koota slot.
8. **Scene callbacks** (`registerSceneCallback`) fire for dynamic spawning.

Conceptually each scene moves through the states `loading → ready → active →
unloading` (`getCurrent()` reports the active scene, `getNext()` the preloading
one). On **failure or abort**, the staging world is destroyed and its resources
released — the current scene is left completely untouched.

The editor wrapper `loadScene()` in `editor/scene/serialize.ts` delegates to
`sceneManager.loadScene`, then tracks the scene path and swaps to **this
scene's own** per-scene undo history (`swapHistory(scenePath)` — empty on first
visit, restored when you return to a previously-open scene), rather than
dropping undo globally.
`unloadAll()` and `resetForTesting()` exist for shutdown + deterministic tests.

## Persistent entities

`runtime/traits/Persistent.ts` is a **marker trait** (no fields). It tells
`SceneManager` to carry a root entity across a scene swap. Use
`markPersistent(entity, guid?)`:

- Assigns a UUID to `EntityAttributes.guid` if the entity lacks one (explicit
  `guid` arg wins; returns the final guid).
- Enforces **root-only**: throws if `parentId !== 0` or the entity has no
  `EntityAttributes`. Children come along with their root automatically.

Because koota entity handles encode their owning world, a persistent entity
**cannot be moved** between worlds — it is **serialized and respawned** into the
staging world. `SceneManager`:

1. Snapshots persistent root subtrees from the current world
   (`snapshotPersistentEntities`).
2. Acquires the resources those snapshots reference under the new `sceneId`, so
   they survive the post-swap release even if the new scene doesn't list them.
3. Drops any scene-file root whose `EntityAttributes.guid` matches a persistent
   guid (`filterPersistentDuplicates`) — the live persistent entity shadows the
   file copy, preventing duplicates.
4. Respawns the snapshots into the staging world (tagged `version:
   SCENE_FORMAT_VERSION`, currently 9, so migrations don't needlessly re-run).

> Persistent entities must be **ECS-pure** — trait data only. Anything held in a
> closure, an in-flight tween, or a Web Audio node is lost on swap, since that
> state isn't in traits. Keep side-effecting singletons in services keyed by
> trait data.

## Scene validation (warn-but-load)

`runtime/scene/sceneValidation.ts` (`validateSceneData(data, schema?)`) is a
**pure, dependency-light** validator — it imports only the predicate helpers
from `runtime/loaders/assetRefRules.ts` (which have zero imports), so it runs
unchanged in the browser AND in Node (the dev server). It **never throws and
never blocks**: it returns `{ warnings: string[], schemaApplied: boolean }` and
the loader always continues. The design is deliberately forgiving — a single
typo surfaces a precise per-field message instead of blanking the whole view.

Three consumers push findings through different channels:

- The **hot-reload handler** (`app/debug/agentBridge.ts`) validates the freshly
  fetched scene against `buildSceneSchema()` *before* handing it to
  `loadScene`, and `console.warn`s each finding (prefixed `[agentBridge]`).
- **`GET /api/validate-scene?path=`** returns the findings plus
  `schemaApplied` / `schemaAvailable` in the HTTP response.
- **`POST /api/scene-mutate`** appends a post-apply validation pass to the op
  warnings (see the next section).

The two dev-server endpoints are surfaced as MCP tools — see
[Debug Tools (MCP)](./debug-tools-mcp.md) for the `curl`/tool surface rather than
duplicating it here.

**The trait schema is optional.** Structural + asset-reference checks always
run; trait/field **type** checks only run when a schema is supplied
(`schemaApplied` reflects this). The schema is the live koota trait registry the
renderer pushes over the HMR socket (R→M `buildSceneSchema()`), so a headless
Node call with no browser connected still catches the common mistakes but skips
type checks (`schemaAvailable:false`). A `TraitSchema` is `{ category:
'component'|'resource'|'tag', fields: Record<name, { type?, options? }> }`; a
field whose `type` is omitted is *known* (won't be flagged as unknown) but is not
type-checked — used for object/array fields the registry can't confidently type.

Findings come from three passes:

1. **Schema-dependent trait/field checks** — unknown trait, unknown field, type
   mismatch (`number`/`string`/`boolean`/`color`/`enum`/`entityRef`/`bindings`/`materialOverrides`),
   and enum value not in `options`. Tag traits must serialize as `true`;
   component/resource as a field object. The `bindings` type deep-checks
   `UIAction` shape (`event` ∈ click/change/submit, `kind` ∈ set/call, required
   sub-fields per kind).
2. **Asset-reference rule** (schema-independent) — every field in
   `REF_FIELDS_BY_TRAIT` (e.g. `Renderable3D.mesh`/`.material`, `ModelSource.glbPath`,
   `Environment.hdrPath`, `ParticleEmitter.effect`) must be a **GUID** or an
   external URL. An internal asset path (`/games/x/foo.mesh.json`) gets the
   specific "references must be a GUID (use the asset's id / .meta.json sidecar)"
   message; anything else gets "is not a GUID or URL". The primitive sprite
   keywords `circle`/`square`/`triangle` are exempt on `Renderable2D.sprite`.
3. **Structural / referential-integrity pass** (schema-independent) — duplicate
   entity ids, self- or dangling `parentId` (matched as a GUID *or* a legacy
   numeric file id; `''`/`0` = root), dangling `UIAction.bindings[].target`
   entity refs, and a `PrefabInstance` whose `source` is its own guid
   (self-recursion).

`REF_FIELDS_BY_TRAIT` is the **single source of truth for scalar ref fields** —
`editor/scene/serialize.ts` imports it for its save-time guard and the build
tree-shaker's keep-walk (`plugins/asset-tree-shaker.ts`) walks it, so a new ref
field added there is covered everywhere. Non-scalar refs (`UIElement.fontFamily`
= a CSS family name; `AnimationLibrary.animSets` = a guid array) are intentionally
excluded and handled explicitly. The predicates themselves live in
`runtime/loaders/assetRefRules.ts`: `isGuid` (UUID-v4 shape), `isExternalUrl`
(`http(s):`/`data:`/`blob:`), `isInternalAssetPath` (leading `/` + a managed
asset extension).

## Scene-file mutation ops

`runtime/scene/sceneMutate.ts` (`applyOps(scene, ops, mint?)`) is the validated,
**pure** way to edit the on-disk scene JSON — an agent (or tooling) mutates
through typed ops instead of hand-editing raw JSON, then the dev-server watcher +
hot-reload reflect the change. GUID minting is injected (`mint`, defaults to
`newGuid`) so it is side-effect-free and unit-tests without a live world; it runs
identically in Node and the browser. It **mutates `scene` in place and also
returns it** inside `ApplyResult { scene, changed, errors, warnings }`.

Four ops, all resolving an existing entity by `EntityRef` (`id` | `name` |
`guid`, at least one; an ambiguous `name` match is an error — disambiguate with
`id`/`guid`):

- **`setTrait`** — merges `fields` into the trait (spread over any existing
  data); no `fields` = tag presence. Re-tagging or a no-op merge does **not**
  count as `changed`.
- **`removeTrait`** — refuses the core traits `Transform` / `EntityAttributes`;
  removing an absent trait is a silent no-op, not an error.
- **`addEntity`** — allocates the next free numeric id and ensures
  `EntityAttributes` carries a stable `guid` + `name` + `parentId` so the entity
  round-trips through load/save + selection-restore.
- **`removeEntity`** — deletes the entity plus its whole subtree (children found
  by `parentId`, GUID or legacy numeric).

`errors` are **hard** (entity not found, malformed op) — those ops are skipped;
the caller decides whether to still write (the `/api/scene-mutate` endpoint only
persists when `changed > 0`, so a typo leaves the file untouched). `warnings` are
**soft** — the op applied but the result is suspect: `addEntity` under a
non-existent parent (orphan), or a surviving `UIAction.target` left dangling by a
`removeEntity`. Neither blocks the write; the agent reads them to self-correct.

**Prefab-instance roots are special.** A `setTrait`/`removeTrait` on a
prefab-instance root routes into `overrides[rootLocalId]`, **not** the top-level
`traits` map — the loader takes an instance's traits from the prefab and silently
ignores top-level trait edits on the node. (This was the bug where
`setTrait Transform` on an instance applied scale but not position.) The
`traitWriteContainer` helper creates the override bucket on demand.

The `/api/scene-mutate` endpoint (dev server, MCP-wrapped) runs `applyOps` then a
post-apply `validateSceneData` pass and returns both sets of warnings; it also
**refuses while the editor is Playing/Paused** (a Stop reverts to the Play-press
snapshot and would discard the edit). It does *not* echo the scene back by
default (`returnScene:true` opts in) — to verify an edit, read the live world via
`/api/scene-state`. Full endpoint/tool surface: [Debug Tools (MCP)](./debug-tools-mcp.md).
