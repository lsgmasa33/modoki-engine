# Scene Loading

A scene is a single `*.scene.json` file — positively identified by that suffix, like every
other JSON asset kind (issue #54) — that is the **sole source of truth** for what exists in
the world. (A plain `.json` under a `scenes/` dir is still accepted as a LEGACY fallback, for
an externally-authored project or an already-published demo snapshot predating the suffix.)
Scenes load asynchronously into an isolated staging world, then swap in atomically so no
system ever observes a half-built scene.

See also: [Architecture](./architecture.md) · [Prefabs](./prefabs.md) · [Visual Editor](./editor.md)

## Two-world architecture

There is **no singleton world**. `runtime/core/ecs/worldRegistry.ts` owns the active
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
`runtime/core/ecs/world.ts` re-exports these and adds entity-index helpers
(`spawnEntity`, `destroyEntity`, `registerEntity`, `findEntityById`,
`unregisterEntity`, `findEntityByGuid`, `guidOf`) — the guid lookup is load-bearing for resolving a guid-form `parentId` /
`rootInstanceId` on load (see "Entity-id stability on disk" below).

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

The current scene file version is **12** (`SceneFile.version`), stamped from
`SCENE_FORMAT_VERSION` in `runtime/version.ts`; the `SceneFile` interface is
defined in `editor/scene/serialize.ts`:

```ts
interface SceneFile {
  id: string;             // stable UUID, written once, survives renames/moves
  version: number;        // stamped from SCENE_FORMAT_VERSION (currently 12)
  createdAt: string;      // preserved across saves, not regenerated — see "Entity-id
                           // stability on disk" below
  baseScene?: string;     // v10+: guid of a base scene this scene extends — see
                           // "Base scenes" below
  resources: ResourceRef[];
  entities: SerializedEntity[];
}
```

`SerializedEntity.id` is now optional and, since v12, never written — see "Entity-id
stability on disk" below.

### Only NON-DEFAULT trait fields are written

A trait field still holding its koota schema default is **omitted** from the file
(`isTraitDefault` in `serialize.ts`); the loader rebuilds it, because it constructs each
trait as `meta.trait(partialData)` and koota fills every absent key from the same schema.
So the round trip is lossless, and a file records only what was actually *authored*.

The point is that **defaults stay live**. Writing every field out freezes a scene at the
defaults of the day it was saved, so a later change to a trait default silently stops
reaching it — a semantic change, not diff noise. (Owner's decision to omit, 2026-07-31.)

The repo-wide legacy-scene migration this decision had held up **was carried out on
2026-08-04** — see "Re-saving legacy scenes" below.

Three deliberate limits:

- **Scalars only.** A non-scalar default (array/object) in an SoA schema is one shared
  instance handed to every entity, so "equals the default" is not safely decidable — a deep
  compare would drop a live array that merely happens to match, and an identity compare
  would drop one the entity is *aliasing*. Non-scalars are always written.
- **AoS traits are exempt wholesale** — their `schema` is a *factory*, so there is no
  default to compare against.
- **`parentId` and every other `FieldHint.entityId` field are always written**, since a
  later pass rewrites them as GUIDs. Omitting them would only move them to the end of the
  object — pure diff noise.

A trait whose fields are *all* default still serializes, as `{}`: the trait's **presence**
is meaningful. Consumers that read a scene file directly need the defaults to compute an
effective value — they are published per field on `GET /api/trait-schema`, and so through
the `modoki_list_traits` MCP tool.

Note this is a *serializer* rule, not a format version: it changes what a save writes, not
what a load accepts, so no migration is involved and older fully-populated files keep
loading unchanged. It applies to scene files only — prefab files go through a separate
path in `prefab.ts` and still write every field.

**Which fields persist is decided by the koota `.schema`, never by `meta.fields`.**
`meta.fields` is the *Inspector's* curated list: a persistent field owned by a custom
Inspector section is deliberately absent from it (`Animator.clips`/`clip`,
`SpriteAnimator.clip`, `AudioSource.clips`, `UIElement.flexWrap`,
`EntityAttributes.editorFolder`, `Time.timeScale`, …). Every persistence path therefore
reads through `readTraitDataFull` and gates stored fields with `traitDefinesField`
(both in `runtime/core/ecs/entityUtils.ts`) — the scene serializer, `serializePrefab`,
`captureInstanceOverrides`, and both override-apply paths. `meta.fields` is consulted
only for the `runtimeOnly` flag (which fields to *drop*). Getting this wrong is silent
data loss, not a warning: the prefab paths once used `meta.fields` and a load→save
erased a populated `Animator.clips` bank. Same lesson as the persistent-snapshot field
union below.

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
`collectSceneResourceRefs` unions the stored array with a fresh
`collectResourceRefsFromEntities` call, and dedupes.

**The corollary is the one that bites: the safety net is only as good as the WALKER.**
Both halves of that union come from the same function, so a ref *it* cannot see is missing
from both — and no re-save can repair it, because the re-save calls the same walker. Two such
blind spots were found and fixed in Aug 2026, and neither showed up as a build failure (the
tree-shaker walks entities independently, so shipping was never affected):

- **Asset GUIDs on GAME-defined traits** (#123) — the walk was driven by `REF_FIELDS_BY_TRAIT`,
  an engine-only registry with no registration API. Now also swept generically: a GUID that
  resolves in the asset manifest *is* an asset ref, which needs no per-game registration and
  matches what the tree-shaker already does ([build.md](build.md) § "Assets the build cannot see").
- **Refs introduced by a prefab-instance OVERRIDE** — `overrides`, `nestedOverrides`, and the
  same two on a reference-style `added` node. Ordinary editor work ("instantiate, then swap this
  instance's mesh") produced a ref nothing collected: `games/space-console/Station.scene.json`
  had **31** override-only `Renderable3D.mesh`/`.material` GUIDs, both acquiring types, so they
  were neither preloaded nor scene-refcounted at runtime.

It follows that **a save REGENERATES `resources` rather than preserving it** —
`serializeScene` discards the loaded array and rebuilds from the entities. So a file
whose array was written by an older, less complete walk gets *upgraded* on its first
save, and the array can grow without anything being wrong (issue #17 saw 2 → 3+ on
`material-instance-demo.json`). The walk is deterministic — same entities, same array,
same order (`resourceRefsStability.test.ts` pins this, including dedupe of a ref two
entities share) — so the second save produces the same bytes as the first.

**Consequence for anything comparing a scene before and after a save:** normalize by
saving once first, or compare `resources` as a set rather than as a byte range. Treating
the growth as churn to eliminate is the wrong reading — the newer array is a superset,
and `resources` is regenerated by design.

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
- `migrateV9toV10` — no-op passthrough; adds the optional top-level `baseScene` ref
  (base scenes, below) — older files simply have none
- `migrateV10toV11` — no-op passthrough; changes HOW `PrefabInstance.rootInstanceId`
  (and any future `FieldHint.entityId`-flagged field) is *written* — a GUID instead of
  a raw ecs id — not the shape of the data (see "Entity-id stability on disk")
- `migrateV11toV12` — no-op passthrough; `serializeScene` stops writing the per-entity
  `id` field entirely. This is the terminal step — it stamps `data.version =
  SCENE_FORMAT_VERSION`, so bumping the constant without chaining a new migration
  can't silently mislabel a freshly-migrated file as under-versioned

### Re-saving legacy scenes (the sha-churn migration)

A scene committed before the migrations above stays on disk in its old, verbose shape until
something re-saves it — the loader migrates in memory, so nothing forces the issue. The cost is
**sha churn**: the first incidental save rewrites the whole file (compaction, the `id` drop, the
`rootInstanceId` GUID rewrite, a rebuilt `resources`), and a one-line edit arrives as a
700-line diff that no reviewer can read.

Carried out repo-wide on **2026-08-04**: 48 scenes across 20 projects. The pass **converges** —
re-saving an already-migrated scene is byte-identical, verified across *fresh editor processes*
(not merely within one session, which would not have proven the `rootInstanceId` GUID is
persisted rather than re-minted per launch).

Tooling, for the next time a serializer change makes the committed files stale:

```bash
engine/scripts/resave-scenes.sh games/sling demos/forest-camp   # load -> save every scene
node engine/scripts/check-scene-churn.mjs games/sling demos/forest-camp   # REVIEW GATE
```

The check script is not optional. `save-all` persists the **live world**, so the pass is only
safe where loading a scene is side-effect-free, and two projects proved it is not.

**You no longer have to run the sweep to LEARN that a manifest has drifted** (#135, which was
found by accident during an unrelated prefab pass, on a tree that had been swept 2 days earlier).
`engine/tests/assets/sceneResourceManifest.test.ts` compares every committed scene's stored
`resources` against the live collector, by `(type, path)` and in BOTH directions — so a MISSING
entry and a stale/mistyped one both fail `npm test`. The sweep is still what FIXES it; the test is
what notices. Two things to know before reading a failure there:
- It is blind to #123's class by construction — it compares the file against the same walker, so a
  ref the walker cannot see is missing from both sides and looks like agreement.
- Sub-sprite GUIDs live in the parent texture's `.meta.json` `sprites[]`, not as any file's own
  `id`, and an unsliced 2D/UI texture also owns an auto `deriveGuid('sprite:' + guid)`. A manifest
  populated without those makes the collector skip real refs, which surfaces as a false STALE on a
  correct entry — measured on `games/space-invader`, and the reason that test mirrors the scanner.

It compares the `resources` manifest by **identity**, and for any dropped ref scans the new scene
body to answer the question a human used to be asked to answer by hand — a drop that is *still
referenced* is reported as `⚠️ REGRESSION` and exits non-zero. It previously compared only the
manifest's LENGTH, which is silent on a 1-for-1 swap: the space-invader re-save below swapped a
legacy page-texture GUID for the sprite GUID the scene actually references, and the gate reported
"0 semantic changes". A count is the one property a dropped ref can preserve while still being a drop.

- **`games/chess` — was excluded (#124), now fixed on both halves.** Its game code spawns on
  load; the save baked ~70 runtime entities (move highlights, rank/file labels, pieces) plus a
  live progress-bar value into `chess.scene.json`. The **spawn** half is fixed by the `Transient`
  tag at the spawn site; the **mutation** half by `pauseWhileStopped` on its two store→ECS
  projections (both rules below). Verified live in an editor on `games/chess`: 83 entities in,
  83 out, and **zero** changed values on any field present in both files — the whole remaining
  diff is default-field elision from the format migration (version 9 → 12), which is what a
  re-save is FOR. `games/llm-test` hit only the mutation half and is fixed the same way.

  Worth knowing before trusting a diff on this class: the file diff **understated** it. With the
  guard temporarily removed, the save-time warning named **8** authored fields being written
  (status text, both overlay/error visibilities, the new-game + move-counter visibilities, and
  the progress bar/percent at 448 writes each) — six of which happened to match their authored
  values, so no diff could ever have shown them. A quiet diff means the values agreed, not that
  nothing wrote.
- **`games/space-invader` — was excluded (#123), now fixed and swept.** The `resources` rebuild
  *dropped* a still-referenced asset, because the ref lives on a game-specific trait
  (`SpaceInvaderAssets.catvaderAnim`) and `collectResourceRefsFromEntities` walked refs from
  `REF_FIELDS_BY_TRAIT` — a closed, engine-only map with no registration API, so a game trait's
  asset field was structurally invisible to it. Fixed by a generic sweep: a GUID that resolves in
  the asset manifest **is** an asset ref, so no game registers anything. A *growing* manifest is
  normally a fix — the pass added genuinely-referenced assets missing from several scenes.

  Note what a shrinking manifest does and does not cost, because #123 was filed on a stronger
  claim that does not hold: the build tree-shaker walks scene **entities** and never reads this
  manifest (measured — a web build from a manifest with both refs deleted still shipped them), so
  this is *not* an "asset the build cannot see". Nor is a stale FILE the problem, per the union
  above. What cost anything was the walker's blind spot, described there.

**The scaffolder template must stay canonical, and is guarded.** Migrating the existing scenes
fixes the past; `engine/templates/starter` fixes the future, because it seeds every project made
by `scaffold-project.mjs` and the editor's File → New Project. It was stamped `"version": 12`
while still holding v11-era per-entity `id` fields, so every project ever scaffolded from it
started life needing a re-save. Regenerate it the same way it was fixed — scaffold a throwaway
project, re-save it through the editor, copy the scene back (the scaffolder re-mints the GUIDs
on each use, so the committed ones are only placeholders).

`engine/tests/assets/sceneFormatCanonical.test.ts` now fails on any scene — template included —
that carries the legacy markers, with the two known exceptions baselined against #123/#124.
Note what it does **not** do: it checks markers, not byte-exactness. A true check would
re-serialize and diff, which needs the trait schemas and a world; `check-scene-churn.mjs` is
what verifies a real re-save. It also parses `entities[].traits` rather than scanning text,
because prefab `added[]` subtrees legitimately carry full trait data (defaults and blank refs
included) and a text scan flags an already-migrated scene as legacy.

**Prefabs needed their own route (#125), and are now swept too** — see "Re-saving legacy
prefabs" below.

### Re-saving legacy prefabs (#125)

`resave-scenes.sh` drives `load-scene` → `save-all`, and there is no prefab equivalent: a prefab
is only re-serialized as a *side effect* of editing it. The only path that does that is
prefab-edit mode (open a `.prefab.json` in isolation, save, exit — see
[prefabs.md](./prefabs.md) § "Prefab edit mode"), and until now it was reachable only from the
UI (double-click a prefab → Cmd+S), so there was no scripted equivalent of the scene sweep.

**Made reachable as agent ops.** `openPrefabForEditing` / `savePrefabEdit` / a new
`exitPrefabEditing` (`editor/scene/prefabEdit.ts`) are exposed through the `prefab` agent op /
`modoki_prefab` MCP tool as `prefabAction: 'edit-open' | 'edit-save' | 'edit-exit'` (tool
catalog: [debug-tools-mcp.md](./debug-tools-mcp.md)). `edit-open` swaps the world exactly as
`load-scene` does — it refuses on unsaved work and takes `force` — and additionally **saves the
current scene** on the way in; that is pre-existing `prefabEdit.ts` behaviour, kept deliberately,
because it is what makes the return trip's reload-from-disk non-destructive.
`modoki_save_all` refuses outright while the editor is in prefab-edit mode; `edit-save` is the
save for that world.

**`engine/scripts/resave-prefabs.sh`** is the prefab sibling of `resave-scenes.sh`. Per project it
launches this clone's editor, enumerates prefabs from `/api/scan-assets`, then runs
edit-open → edit-save → edit-exit on each. Like the scene sweep it **refuses `games/chess` and
`games/llm-test`** (the #124 exclusion) — entering prefab-edit saves the current scene, and those
two games' code mutates authored state on load. Review with
**`node engine/scripts/check-prefab-churn.mjs <same projects>`**, a semantic diff keyed by
localId (a prefab has no entity GUIDs) reporting entities/traits/values gained or lost and any
change to a nested-instance row's structure; it exits non-zero on a re-minted prefab `id` or a
flattened nested instance.

```bash
engine/scripts/resave-prefabs.sh games/sling demos/forest-camp   # edit-open -> edit-save -> edit-exit every prefab
node engine/scripts/check-prefab-churn.mjs games/sling demos/forest-camp   # REVIEW GATE
```

**Two real bugs in `serializePrefab` were found by that review gate** — the reason this sweep is
not just a reformat. Both are documented as format invariants in [prefabs.md](./prefabs.md) §
"localId stability": a re-save was renumbering localIds positionally, silently repointing or
dropping every scene override on a prefab authored with a gap (measured on sling's
`FieldCorner`: `drip` went localId 4 → 2); and it was overwriting the prefab's `name` with its
root entity's name (measured: `cover-enemy.prefab.json` and `green-enemy.prefab.json` both became
"Enemy"). Both are fixed — see prefabs.md for the mechanism.

**Result:** all 69 prefabs across 9 projects were swept — **18 rewritten, 0 semantic changes**
reported by the churn check, verified idempotent (a second full pass over `games/sling` was
byte-identical to the first). The 51 unchanged were already on the current format.

**Correcting a premise from the paragraph above:** the prefab writer does **not** compact the way
the scene writer does. `serializePrefab` reads each trait's full persisted schema
(`readTraitDataFull`) and writes every field, so a re-save can *add* default-valued fields rather
than drop blank ones — that is why only 18 of 69 prefabs changed, and why this pass made two
blank `Renderable2D.material` refs *appear* (now pinned in
`engine/tests/assets/authoredAssetRefs.test.ts`) instead of the shrink the scene pass caused. The
scene and prefab writers genuinely differ; don't reason about one from the other.

## Entity-id stability on disk

The scene file carries **no live ecs id** at all, and a no-op Save All is a true no-op
— getting there took the three v10–v12 migrations above.

**The mental model.** `EntityAttributes.parentId` was already a **guid** on disk (only
a legacy pre-guid file carries a numeric one). `PrefabInstance.rootInstanceId` was the
last numeric on-disk entity reference, and it went to disk as the entity's **live ecs
id** — a koota allocation slot, i.e. whatever the loader happened to hand that entity
*this session*. Once both are guids, nothing on disk references the per-entity `id`
field, so `serializeScene` stops writing it.

Instead, **both independent parsers of the scene-file format** each backfill a
synthesized id for their own single-call internal bookkeeping — the entity's array
index, skipping any index already claimed by an explicit `id` elsewhere in the file
(a genuinely mixed file — some entries id'd, some not — is unusual but not impossible,
e.g. hand-edited or partially migrated):

| Parser | Backfill | Used for |
|---|---|---|
| `runtime/loaders/loadSceneFile.ts` (`assignSyntheticEntityIds`) | called once right after the migration chain, before anything else reads `entry.id` | `idMap`, `spawnedByEntryId`, `onEntitySpawned`'s `oldId` |
| `runtime/scene/sceneMutate.ts` (`assignSyntheticEntityIds` + `stripBackfilledEntityIds`) | called before `applyOps`, stripped again right before writing the file back | its internal entity graph, `EntityRef.id` lookups, `nextId()`'s minting |

The shim is **duplicated, not shared** — `sceneMutate.ts` is deliberately standalone
and dependency-free so it runs identically in Node and the browser. Neither
synthesized id is ever persisted or compared across loads. `sceneMutate.ts`'s copy
strips its backfilled ids again before writing — otherwise a single `setTrait` through
`/api/scene-mutate` would silently reintroduce an `id` on **every** entity in an
id-less file, the exact diff noise this whole mechanism exists to remove, just via a
different write path than Save All. (An entity `addEntity` genuinely adds keeps its
real id — it mints one via `nextId()` *after* the backfill ran, so it was never in the
backfilled set.)

The **carry snapshot is untouched** by any of this: it keeps setting real ecs ids,
because `onEntitySpawned` hands `SceneManager` genuine old→new ecs-id pairs that the
override-mark re-seed and the id remap below both depend on. The scene *file* and the
carry *snapshot* are two different things that briefly wore the same `SceneData` type —
the file's id churn existed entirely because it had borrowed the snapshot's
representation.

### `FieldHint.entityId` — the registry mechanism

A trait field that holds a **live entity id** declares it in the trait registry
(`runtime/core/ecs/traitRegistry.ts`):

```ts
entityId?: { onMissing: 'root' | 'stripTrait' };
```

Declared fields today (`engine/app/ecs/registerTraits.ts`):

| Field | `onMissing` | Why |
|---|---|---|
| `EntityAttributes.parentId` | `'root'` (write the schema default, silent) | An orphan is a legitimate partial-load outcome; `sceneValidation` already warns at author time |
| `PrefabInstance.rootInstanceId` | `'stripTrait'` + loud warn | Neither `0` nor a stale value is safe — both poison instance-membership lookups |

Driven generically off the registry, on both sides:

- **Write** — `serializeScene` maps every `entityId`-hinted field through `guidForId`
  (`editor/scene/serialize.ts`), so a future such field is guid-ified automatically —
  not a name-check on `rootInstanceId`.
- **Read** — one registry-driven loop in `loadSceneFile.ts` replaced two hand-written
  remap blocks. `resolveEntityIdField` is dual-mode: a **string** resolves via
  `findEntityByGuid`, a **number** via the legacy/carry `idMap`. Every `entityId`-hinted
  field is also **zeroed at spawn time** — spawning a guid string into a numeric koota
  SoA field writes `NaN` before the remap pass can fix it.

**Gotcha — a prefab-instance root's own guid lives at `entry.guid` (top-level), not
inside its serialized `EntityAttributes`** (`serialize.ts`: "Prefab roots write only
their stable guid here — never as an override"). A root's `rootInstanceId` is a
*self*-reference (it equals its own guid), so on load, pass 1 used to spawn the
placeholder with `EntityAttributes.guid` still empty — nothing in the live world yet
carried that guid — and pass 2's `resolveEntityIdField` self-lookup always missed,
stripping `PrefabInstance` and logging `"no live counterpart in this load"` on
**every** load, harmlessly (a fresh load's placeholder gets destroyed and
re-instantiated correctly regardless) but noisily, and — on a base-scene **carry**,
which spawns flat with no re-instantiation step — for real. Fixed by stamping
`entry.guid` into the `EntityAttributes` trait args at spawn time (pass 1) whenever
the entry carries one and doesn't already set it, so the placeholder is
self-discoverable exactly like any other entity. `sceneValidation.ts`'s field-type
check needed the matching fix: it carved out `EntityAttributes.parentId` accepting a
string (serialized) or number (live schema) but never extended that carve-out to
`PrefabInstance.rootInstanceId`, so a valid guid-form file loudly failed the "unknown
trait/field" schema check whenever the connected editor's live registry pushed the
schema over the agent bridge.

This closed a real bug class: `PrefabInstance.rootInstanceId` going stale across a
respawn because nobody remembered to add it to a hand-maintained remap list (it now
lives structurally in the registry instead). The guard against a *third* such field
regressing the same way is opt-**out**, not opt-in:
`engine/tests/editor/registerTraits.test.ts` walks every registered trait's koota
schema for `/Id$/`-shaped numeric fields and fails unless the field is declared
`entityId` or carries an explicit allowlist entry with a reason
(`PrefabInstance.localId`/`parentLocalId` — prefab-LOCAL ids, not ecs ids, are the
allowlisted case).

> The **runtime** representation did not change: `parentId` and `rootInstanceId` stay
> numeric ecs ids in the live world. Making them guids at runtime was analysed and
> rejected — `transformPropagationSystem` rebuilds a `Map<number,number>` every frame,
> guids are lazily minted, and duplicate guids would make the *hierarchy* ambiguous
> rather than just lookups. This is a **disk-form change only**; translation stays at
> the load seam.

### Why it mattered, and the regression gate

A scene saved after a base-scene **carry** (a level swap that keeps a shared base
loaded — see "Base scenes" below) used to produce a completely different file than the
same scene saved after a **cold** load — different ids throughout, different entity
order, and a regenerated `createdAt` — with zero actual edits. Two further fixes closed
that:

- **`createdAt` and the scene's own `id` are preserved** — both are facts about the
  ASSET, not the format, so a save (or a version migration) must carry them forward.
  Both come from `SceneManager`'s per-scene `loadedScenes` bookkeeping, captured at load
  time from the raw parsed JSON; a fresh id + stamp only for a scene that was never
  loaded (`newScene()`).

  The primary is looked up **by path**, a named base **by guid** (which its caller already
  has). Keying the primary by guid was circular — it needed the id it was computing — and
  the id itself used to come from a reverse path lookup in the global asset manifest
  (`getGuidForPath(path) ?? newGuid()`). That misses whenever `registerAsset` re-registers
  the same guid under a different path string, since it evicts the stale `pathToGuid` entry
  — an ordinary manifest rescan is enough. A miss **mints**, which silently dangles every
  reference to the scene: measured on `tropical-island.json`, whose `project.config.json`
  entry and a unit test both named the old guid (2026-07-30). The manifest lookup survives
  only as a fallback for a serialize with no live load behind it.

  Gate: `engine/packages/modoki/tests/editor/sceneIdStability.test.ts` — including a v9→v12
  migration that must change *only* the format, and a reproduction of the manifest eviction.
- **Entity order for a carried scene now matches a cold load** — the carry snapshot's
  respawn order used to be its subtree-descent (BFS) order;
  `snapshotPersistentEntities` now sorts its entries by ecs id, which on a cold load
  *is* file order. (Parent-before-child is not required: `loadSceneFile` spawns
  everything in pass 1 and resolves `parentId` in pass 2.)

The regression gate is `engine/packages/modoki/tests/editor/scenePathIndependence.test.ts`:
with real `sceneManager.loadScene` + real `serializeScene`, a scene's serialized output
— entities, `rootInstanceId`s, `id` and `createdAt` — must be **identical** whether it
arrived via a cold chain load or a carried swap, for the base and the primary alike,
and repeated cycles must be deterministic.

> **"A no-op Save All produces an empty `git diff`" is a FALSE PASS** and must never be
> used as the test on its own. `saveAll` only writes **dirty** scenes, so a clean base
> is skipped entirely and the empty diff means *not written*. Assert the file was
> actually written (mtime/hash), or — better — call `serializeScene` and compare the
> RESULT, which needs no write at all.

## Base scenes (nestable, cross-scene persistence)

A scene may declare a **base scene** — `baseScene: "<guid>"` at the top level. The base
loads **additively into the same world**, before the primary, and **survives a swap to
another scene that shares it**. Shared rig and session state (Time, camera, lights,
UI, physics config) is authored **once** in the base; a level file becomes only what is
actually per-level.

The problem it solves is concrete: sling's `Lvl-0001.json` and `Lvl-0002.json` were
byte-identical except `FieldSource.level`/`.wave` — ~38 duplicated entities per file,
and no state (not even `Time.elapsed`) carried across the swap. Base scenes dissolve
that identity problem rather than papering over it: there is exactly one Time entity,
defined in one file.

> A koota world can **never** survive a swap — `SceneManager.loadScene` always builds a
> fresh `createWorld()` and `destroy()`s the old one (koota caps at 16 worlds). So "the
> base survives" is implemented as **snapshot-and-carry**: the kept scenes' entities are
> serialized out of the dying world and respawned into the staging world, NOT re-read
> from file. Re-reading would reset `Time.elapsed` to its authored value, defeating the
> feature. This is the generalization of `snapshotPersistentEntities` (see
> [Persistent entities](#persistent-entities) below) — the two mechanisms coexist: base
> scene = "shared rig authored once", `Persistent` = "*this* entity survives a load".

### Chain resolution

`runtime/scene/sceneChain.ts` (`resolveSceneChain(startPath, fetchSceneMeta)`) walks
`baseScene` refs upward and returns `{ chain, warnings }`:

- **Nesting is allowed** (engine-base → game-base → level).
- **A `visited` Set of scene guids** handles cycles *and* diamonds — two bases sharing
  a base is a normal case once nesting exists, and loading it twice is the bug; a plain
  depth counter doesn't cover that.
- **Order is root-most base FIRST, primary LAST** — so a level's own entities win, and
  "everything not from the primary is base-origin" reads correctly in the editor.
- **A depth cap** (`MAX_CHAIN_DEPTH`, mirroring `NavigationManager.MAX_HISTORY`) is a
  runaway backstop.
- **Cycles, dangling refs and the cap all WARN and DEGRADE, never throw** — the walk
  stops and returns whatever resolved.

On each load `SceneManager` diffs the chains by scene guid: `kept = old ∩ new`
(carried), `toLoad = new \ kept` (spawned from file, in chain order), `toDrop = old \
new` (torn down, resources released per scene id) — the same set-intersection the
resource refcount already does. **Unload is therefore declarative**:
`loadScene(levelB)` already expresses it, and there is deliberately no
`unloadScene()` — a targeted unload would destroy entities with no notification seam
for games holding module-level entity refs, and it would break the atomic two-world
swap.

### Provenance — `EntityAttributes.sourceScene`

Every entity a **base** scene spawns is stamped with that scene's guid in
`EntityAttributes.sourceScene` (registered `{ type:'string', hidden:true,
runtimeOnly:true }`). It rides through the world swap for free, unlike an id-keyed side
map.

> **LOAD-BEARING: empty `sourceScene` means "belongs to the primary scene", not
> "belongs to nothing".** Otherwise every entity a human creates in the editor would
> silently fail to save.

Two consumers:

- **Save filtering** — `serializeScene` excludes any entity (and its subtree) whose
  `sourceScene` is "foreign" to the scene being saved, mirroring the existing
  `Transient` exclusion. A level's file therefore never absorbs base rig, and a
  non-chained scene's save is byte-identical to pre-base-scene behaviour.
- **Editor grouping/ghosting** — `EntityInfo.sourceScene` (`runtime/core/ecs/entityUtils.ts`)
  drives the Hierarchy's scene groups and the ghost styling.

### Editor authoring surface

- **Set the ref** — `editor/panels/assetViews/SceneAssetView.tsx`: select a scene in
  Assets, set its base via an `AssetRefField` with an inline cycle warning. It writes
  through `POST /api/scene-mutate`'s `setBaseScene` op (see "Scene-file mutation ops"
  below), **not** the generic whole-file asset-write path — a scene file is also what
  the live world serializes into, so a blind write from React state could race a
  Play/Stop snapshot or an agent's concurrent mutate.
- **Hierarchy scene groups** — `editor/panels/Hierarchy.tsx` (grouping helper in
  `hierarchyFolders.ts`): base scenes render as collapsed-by-default "🔗 Base" header
  rows above the primary content, with a dirty dot when that base has unsaved edits. A
  scene with no base collapses to exactly one group, so a non-chained Hierarchy renders
  exactly as before.
- **Base entities are editable IN PLACE, not read-only.** The original design was
  "ghost — fields disabled, edit by opening the base scene"; the owner reversed it, so
  ghosting survives as a *visual* provenance marker plus an explicit Lock/Unlock
  affordance in the Inspector. Edits are staged in the live world and routed to the
  **base's own file** on save: `saveAll` walks `getLoadedScenes()` and writes every
  dirty scene in the chain via `serializeScene({ scene })`. Cmd+S silently writes the
  base too — owner-confirmed, with the dirty dot + per-file reporting as the
  non-optional visibility half.
- **Promote / demote** — drag a Hierarchy row across a scene-group boundary to move
  which scene FILE authors an entity: `moveEntityToScene` /
  `promoteEntityToScene` / `demoteEntityToScene` (`editor/undo/entityActions.ts`)
  re-stamp the whole subtree's `sourceScene` as one staged undo action (files change on
  the next save, not on the drop). `editor/scene/sceneMoveScan.ts` is the advisory
  pre-flight: it scans sibling scenes for guid collisions and names every scene a
  demote would strip the entity from. Guids are **preserved, never rekeyed** on a move
  — `entityRef` trait fields address entities by guid across the chain, so a rekey
  would silently break live refs. A demote that removes shared rig from sibling levels
  is **allowed with a confirm**, not refused — that blast radius is the understood
  semantic.

### Two guards that keep this safe

- **No cross-scene parenting.** A level entity parented under a base entity breaks save
  provenance (filtering keys off an entity's OWN `sourceScene`, not its parent's) and
  teardown. `reparentEntity` hard-rejects it — the one interactive path both
  `modoki_reparent_entity` and the Hierarchy drag go through — and `SceneManager` warns
  at load time after the staging world is fully populated. Promote/demote *changes*
  `sourceScene`, so it satisfies the guard rather than relaxing it.
- **Duplicate guids across the chain.** `filterDuplicateChainGuids`
  (`SceneManager.ts`) drops a root (and its subtree) whose guid a chain scene already
  spawned, warning loudly. Chain order means the **first scene to spawn a guid keeps
  it**. This is a transitional safety net for bases extracted by copy-and-thin (sling's
  two levels shared all 38 guids), not a statement about precedence.

### Gotchas

- **A carried prefab instance loses its EDITOR bookkeeping** (Apply-to-Prefab,
  structural overrides) across a swap that keeps its base loaded — the carry flattens
  the instance structure and never calls `instantiatePrefabIntoWorld`. Documented,
  accepted; the **runtime trait data is unaffected**, and `SceneManager` warns so it is
  never silent — but only at the moment a carry actually happens (a base already known
  to contain a prefab instance shows up in that load's `keptBaseGuids`), not on every
  fresh load. A base with a prefab instance loading for the first time, or reloading
  fresh (not carried), is silent — the loss only occurs on the carry itself. (Authored
  *override values* on carried instances DO survive — the mark set is captured off the
  old world and re-seeded per entity through the old→new id map.)
- **The Time/Input singleton fallback must run AFTER the carry respawn.** A level whose
  Time lives in its base has no Time of its own, so a fallback running first spawns a
  phantom fresh Time and the carried one lands on top of it — two Time entities, which
  is a live bug (`getTime` is `queryFirst` while `timeSystem` is
  `query().updateEach`, so every read gets an arbitrary winner and `setJournalTick`
  fires twice a frame).
- **The materialized Time singleton is tagged `Transient`, so it is never saved.** It has
  to exist in the world (systems reading delta are no-ops without it) but it was never
  authored, so writing it back would GROW whatever scene is saved next by one entity —
  measured on `ui-focus-demo.json`, 9 → 10, a direct counter-example to "a no-op save is a
  no-op". It was not even confined to the primary: serialize's foreign-entity filter skips
  any entity without `EntityAttributes`, and this one has none, so it landed in a shared
  **base** just as readily.

  A scene may still **author** its own Time — hosting the resource in a shared base scene
  is a supported setup, and it is why `timeScale` is deliberately not marked `runtimeOnly`.
  A Time that came from a file carries no `Transient` tag and serializes normally.
  **Provenance is the only workable discriminator**: an authored Time sitting at the
  default `timeScale` is byte-identical to the materialized one, so no value-based rule
  could tell them apart without deleting the authored one. (`Input` needs no tag — it is
  simply not in the trait registry.) Gate:
  `engine/packages/modoki/tests/editor/timeResourceProvenance.test.ts`.
- **An entity SPAWNED BY A SYSTEM is tagged `Transient` at the spawn site, so it is never
  saved** (#124). Same provenance principle as the Time singleton, generalized: `spawnEntity`
  (`runtime/core/ecs/world.ts` — the one sanctioned `world.spawn`, enforced by an ESLint ban
  everywhere else) adds the tag when `inSystemTick()` is true, a flag `runPipeline` sets around
  its system loop in a `try/finally`. Every load-time spawn — scene load, GLB import,
  `SceneManager`, the headless harness — runs OUTSIDE that window and is unaffected.

  Why it is needed at all: `runPipeline` skips a system only when its priority is **below**
  `TRANSFORM` (200), so a `PROJECTION`-tier (300) system runs in the *stopped* editor. A game
  that syncs its board there (`games/chess`) therefore spawned ~70 entities — pieces,
  highlights, rank labels — into a scene nobody was playing, and `save-all` wrote them out as
  authored content. Deliberate gap: the flag is synchronous, so a spawn in an async
  continuation a system merely *started* is not tagged. That errs toward saving rather than
  silently dropping an entity, which is the safe direction for a data-loss-shaped bug.

- **A projection that mirrors RUNTIME state onto AUTHORED entities must declare
  `pauseWhileStopped`** (#124, second half). Transience covers what a system *spawns*; it cannot
  reach an entity the human authored and a system merely *mutates*. Measured on chess after the
  spawn fix, the whole remaining load→save diff was `ProgressBarFill.UIElement.width 100 -> 3`
  and `ProgressPercent.UIElement.text "100%" -> "3%"` — both genuinely authored entities.

  The chain, which is worth following once because none of it is local: a scene-scoped manager's
  `init()` runs on scene **load** (`initSceneManagersFor`, with no run-mode gate), so opening
  chess in a stopped editor starts the LLM model download; the download drives
  `chessStore.loadProgress`; `chessStateProjection` mirrors that onto the authored progress bar;
  Cmd+S writes it out. Gating the *download* is not available as a fix — Play does not reload the
  scene (`playMode.ts` snapshots in place), so a manager that skips init while stopped never
  initializes in the editor at all.

  So the seam is the projection: `registerProjection(name, store, fn, priority,
  { pauseWhileStopped: true })` holds it while `!isSimRunning()`. **The hold happens in the
  wrapper, before the dirty flag is cleared** — deliberately, and this is the part to preserve if
  the code is ever rearranged. An early `return` inside the sync function instead would consume
  the flag, so state accumulated while stopped would never project: if the store went quiet
  before Play (the download finished), the first frame of Play would show authored values rather
  than live ones. Default is `false`, because a projection normally *should* run while stopped —
  that is what makes an inspector/gizmo edit reflect immediately. Opted in today:
  `games/chess` (state + chat) and `games/llm-test` (state + chat). Gate:
  `engine/packages/modoki/tests/runtime/projection.test.ts`.

  **The class stays open by design, so a save warns instead.** Nothing stops the next game from
  driving an authored entity from a stopped-mode system, and the alternative — serializing the
  last *loaded* values instead of the live world — was declined because its failure mode is
  silently discarding a real edit, which is worse than the bug it fixes. Instead `writeTraitField`
  records any write landing on a non-`Transient` entity while `inSystemTick() && !isSimRunning()`
  (`runtime/core/ecs/authoredWrites.ts`), and `saveAll` emits one grouped warning naming
  `entity.trait.field` for what it just wrote to disk. Warn-only: it never suppresses a write or
  refuses a save, because the engine cannot tell a rogue mirror from an intended one.

  **What the warning does NOT reach**, stated so nobody reads a silent save as proof: it hooks
  `writeTraitField`, so a system writing through koota's `entity.set(Trait, {…})` directly
  bypasses it. Not fixable in the engine — `set` is koota's API, not a funnel. No game hits it
  today (every `entity.set` under `games/**`/`demos/**` sits in a system below `TRANSFORM`, which
  is skipped while stopped), but a future one could. Conversely, mutating the object from
  `entity.get(Trait)` in place is not a write at all — **koota returns a copy** — so that pattern
  needs no coverage; it silently does nothing, which is its own bug when a game means it as one.
- **Override marks are WORLD-scoped, not per-`loadSceneFile`-call.** A chain loads N
  scene files into ONE staging world, so a per-call `clearAllOverrideMarks()` has the
  primary wipe the marks the base just seeded — on *every* chain load, carry or not.
  `loadSceneFile` takes `clearMarks` (default `true`, so every other caller is
  unchanged); `SceneManager` clears once per staging world and passes `false` for its
  chain and carry calls.
- **Editing a base file on disk while a level is open** does not hot-reload by guid
  alone (a base's guid doesn't change when its file does). `agentBridge` matches the
  changed path against every `getLoadedScenes()` entry and reloads via
  `loadScene(current, { forceReloadBases: [changedGuid] })`, which forces that base out
  of `kept` into toDrop+toLoad so it re-fetches instead of being carried.
- **Play → Stop restores authored base state by guid**, skipping `runtimeOnly` fields —
  so `Time.elapsed` keeps its carried value while a drifted `Transform` reverts.
  Without this, Play → Stop → Cmd+S would bake play-mode drift into shared rig. This is
  also why dirt is recorded from **authored edits** (`editor/scene/sceneDirty.ts`) and
  never inferred by diffing the world against the file.

**Key files:** `runtime/scene/sceneChain.ts` (`resolveSceneChain`) ·
`runtime/scene/SceneManager.ts` (chain load, carry, `loadedScenes`) ·
`editor/scene/serialize.ts` (`serializeScene({ scene })`, multi-scene `saveAll`) ·
`editor/scene/sceneDirty.ts` · `editor/panels/assetViews/SceneAssetView.tsx` ·
`editor/panels/Hierarchy.tsx` · `editor/scene/sceneMoveScan.ts`.

## SceneManager API

`runtime/scene/SceneManager.ts` exposes the singleton `sceneManager`. The core
call is:

```ts
await sceneManager.loadScene(path, {
  onProgress?: (loaded, total) => void,
  signal?: AbortSignal,
  preloaded?: SceneData,           // caller-supplied data instead of a fetch
  gameId?: string,                 // explicit game switch (see managers-and-systems.md)
  forceReloadBases?: string[],     // guids to pull OUT of `kept` even though they'd
                                    // otherwise carry — the base-file hot-reload primitive
});
```

### A missing scene arrives as `200 OK` HTML, not a 404

The dev server answers an unknown path with its SPA fallback — `index.html`, status **200**, so
`res.ok` is `true` and nothing in the fetch path can tell it apart from a real hit. A bare
`res.json()` on that body throws `SyntaxError: Unexpected token '<', "<!doctype "…`, which reads as
a *corrupt scene* when the truth is *no scene at this path* (#91).

So **every asset-JSON fetch in `runtime/**` goes through `parseAssetJson`**
(`runtime/loaders/assetFetch.ts`) rather than `res.json()` — scene, base-chain hop, mesh, material,
prefab, asset manifest, shader manifest, font metrics, timeline, particle, clip, animset, rig2d,
sprite-anim. It reads the body as text, recognises the fallback, and throws
`no asset at <path> — the dev server answered with index.html…`.

**Enforced by `engine/tests/architecture/assetJsonGuard.test.ts`**, not by convention. The helper
was introduced with six loaders converted and the remaining eight call sites simply stayed as they
were — which is what #91 turned out to be. `timelineCache.ts` is the sharpest illustration: it
*imported* `parseAssetJson`, used it in `getTimeline`, and left `loadTimelineNow` three functions
below parsing raw. A rule that holds for the function that was audited and not the one beside it is
a coincidence, not a rule. The guard's allowlist has exactly one entry — `runtime/ota/otaClient.ts`,
which fetches a remote OTA server rather than the dev server, so there is no SPA fallback to mistake
for an asset — and a second test keeps that allowlist from rotting into a silent hole.

Two consequences worth knowing:

- **Test doubles must have `text()`.** A hand-rolled `{ ok: true, json: async () => body }` is not a
  `Response` — a real one always has `text()`. Wrap fetch stubs in `completeResponse`
  (`tests/stubs/assetResponse.ts`), which derives `text()` from `json()`.
- **A missed boot candidate is a `warn`, not an `error`.** The editor boots by walking a candidate
  list (override → remembered last-scene → `config.scenePath`), so a miss on the first candidate is
  a normal step of a healthy boot. `loadScene(path, gameId, { probing: true })` downgrades the miss
  to `warn`; `loadFirstScene` raises a single `error` naming every candidate only if they ALL miss.
  This matters beyond tidiness: `smoke-packaged.sh` and `assert-app-renders.sh` fail on **any**
  renderer console error, so a stale remembered scene path used to be able to fail a packaging gate
  for a reason unrelated to the commit under test.

`loadScene` flow — a scene may declare `baseScene`, so this is a **chain** load, not a
single-scene one (see [Base scenes](#base-scenes-nestable-cross-scene-persistence)):

1. **Cancel in-flight load** — aborts the previous preload and releases its
   acquired resources (cancel-and-replace; only one preload runs at a time).
2. **Resolve the chain** (`resolveSceneChain`) and diff it against the currently loaded
   chain: `kept` (carried), `toLoad` (spawned from file), `toDrop` (torn down).
3. **Allocate** a fresh `SceneId` per `toLoad` entry + one `AbortController`.
4. **Fetch + migrate** each `toLoad` scene's JSON.
5. **Acquire all resources in parallel** (`Promise.all`) for every `toLoad` scene,
   iteratively expanding nested prefab resources first.
6. **Carry** — snapshot every kept-base and `Persistent`-tagged entity out of the dying
   world (`snapshotPersistentEntities`), THEN **spawn** every `toLoad` scene (root-most
   base first, primary last) plus the carried snapshot into the staging world via
   `loadSceneFile` (dormant — no active system touches them). The Time/Input singleton
   fallback runs last, after the carry — see the base-scenes gotchas.
7. **`beforeSwapHooks`** run (`registerBeforeSwap`) — e.g. renderer shader
   pre-warm via `compileAsync` to kill the first-frame stutter. Failures are
   logged and swallowed.
8. **Rebuild `loadedScenes`**, THEN **atomic swap** — `setCurrentWorld(staging)` fires
   `onWorldSwap`, which editor panels read `loadedScenes` from, so the rebuild must
   happen first or a base's Hierarchy label falls back to its raw guid. Then
   `releaseAllForScene(id)` for every `toDrop` scene id drops its refcounts; then
   `oldWorld.destroy()` frees the koota slot.
9. **Scene callbacks** (`registerSceneCallback`) fire for dynamic spawning.

On **failure or abort**, the staging world is destroyed and its resources released —
the current scene (and its whole chain) is left completely untouched.

**Reads:** `getCurrent()` returns the **primary** (unchanged signature —
`NavigationManager`'s back-stack depends on it). `getLoadedScenes()` returns
`Map<SceneId, { path, guid, role: 'primary' | 'base', baseScene?, createdAt? }>` — every
scene currently in the chain, primary included. **Mutation is exactly one entry point**:
`loadScene(path)` = "make this primary, resolve its chain, diff". There is deliberately
no `unloadScene()` — see [Base scenes](#base-scenes-nestable-cross-scene-persistence).

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
   (`snapshotPersistentEntities`) — this is also the mechanism
   [base scenes](#base-scenes-nestable-cross-scene-persistence) generalize: the same
   function additionally snapshots any root whose `sourceScene` is a KEPT base guid, so
   one snapshot call covers `Persistent` entities and a carried base's entities
   together. Entries come back sorted by ecs id (not snapshot/insertion order) so a
   carried scene's later save matches what a cold load would have produced.
2. Acquires the resources those snapshots reference under the new `sceneId`, so
   they survive the post-swap release even if the new scene doesn't list them.
3. Drops any scene-file root whose `EntityAttributes.guid` matches a persistent
   guid (`filterPersistentDuplicates`) — the live persistent entity shadows the
   file copy, preventing duplicates.
4. Respawns the snapshots into the staging world (tagged `version:
   SCENE_FORMAT_VERSION`, currently 12, so migrations don't needlessly re-run).

Each snapshotted field is the union of the trait's koota `.schema` keys and its
registered `meta.fields` keys (not `meta.fields` alone, which is a curated Inspector
subset) — otherwise a field absent from the Inspector's curated set (e.g.
`Time.timeScale`) would silently reset to its schema default across every swap.

> Persistent entities must be **ECS-pure** — trait data only. Anything held in a
> closure, an in-flight tween, or a Web Audio node is lost on swap, since that
> state isn't in traits. Keep side-effecting singletons in services keyed by
> trait data.

## Scene validation (warn-but-load)

`runtime/loaders/sceneValidation.ts` (`validateSceneData(data, schema?)`) is a
**pure, dependency-light** validator — it imports only the predicate helpers
from `runtime/core/assetRefRules.ts` (which have zero imports) and `isSizeInert`
from `runtime/ui/anchorLayout.ts` (whose only import is a type), so it runs
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

Findings come from four passes:

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
4. **Cross-trait semantic checks** (schema-independent) — a trait value that is
   well-formed on its own but can never take effect given a SIBLING trait. Today
   that is `UIElement.width`/`height` on an axis the entity's `UIAnchor`
   stretches: the offsets size that axis and overwrite the authored value, so it
   is stored, displayed, and inert (the rule itself lives in
   [ui-system.md](./ui-system.md); the shared predicate is `isSizeInert`).

   This pass is where a **noise budget** matters most, because unlike the passes
   above it flags data that is not malformed. Two values are excluded as neutral:
   `0` (the unset default every `UIElement` carries) and `100%` ("fill the
   parent", which agrees with what stretch does and is what the editor writes for
   a stretched element). Measured before narrowing it: without those exclusions
   the check fired **102 times across `games/` + `demos/` against 3 real
   findings** — a ratio that trains people to ignore the channel. A new check
   here should be held to the same bar. Known limit: `100%` is let through even
   under insetting offsets, where the true extent is smaller; tightening that
   needs viewport math the validator does not have.

   **Three places it can be authored, and each reports from a different entry point** — the trap
   is one rule but the *attribution* differs, which is why there is no single pass for it:

   | Shape | Reported by |
   |---|---|
   | A plain scene entity carrying both traits | this pass, against the scene |
   | A prefab instance's scene-side `overrides` | this pass, against the scene |
   | **Inside the `.prefab.json` itself** | `validatePrefabData` — *not* this pass |

   The third is separate on purpose. A size authored in the prefab file belongs to the prefab and
   every instance inherits it, so reporting it from the scene side would name the wrong file
   (`main.json` for a value in `thing.prefab.json`) and then repeat it per instance — one bad
   prefab in 6 scenes at 4 instances each is 24 warnings for a single mistake. It is reported
   instead at prefab **write** time (Apply-to-Prefab / Save-as-Prefab, via
   `warnInertPrefabSizes`), which reaches the person who just authored it, and by a repo-wide
   guard (`engine/tests/assets/prefabInertSize.test.ts`) that also covers prefabs written by hand
   or by an agent — which no editor hook can see. `GET /api/validate-prefab?path=…` exposes the
   same check so an agent editing prefab JSON can verify its own edit. All four share the one
   `inertSizeWarnings` predicate, so the rule and its noise budget cannot drift between them.

   The write-time hook deliberately does NOT live in `writePrefabFile`: that is also the undo/redo
   restore path (`installPrefabSnapshot`), and warning there would fire while someone *reverts*
   the value.

   The same check also covers a **prefab instance's overridden fields**, which
   live in the serialized entity's sibling `overrides` object (keyed by prefab
   `localId` → trait → field), not in `traits` — so it needs the `.prefab.json`
   the instance's `PrefabInstance.source` points at to see an anchor or size that
   comes from the prefab rather than the override itself. Because
   `validateSceneData` stays I/O-free, that lookup is an optional third
   `getPrefab` parameter the CALLER injects (the dev-server routes read the file
   off disk; the browser hot-reload path reads the runtime's already-loaded
   prefab cache). Omitted, or the prefab can't be resolved, the check simply
   stays silent on that instance — a conservative false negative, never a wrong
   claim.

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

Five ops. The first four resolve an existing entity by `EntityRef` (`id` | `name` |
`guid`, at least one; an ambiguous `name` match is an error — disambiguate with
`id`/`guid`). `EntityRef.id` and `addEntity`'s minted id are the module's OWN internal
numeric addressing, synthesized on parse for a file that carries none (see "Entity-id
stability on disk" above) — they never round-trip to disk as-is.

- **`setTrait`** — merges `fields` into the trait (spread over any existing
  data); no `fields` = tag presence. Re-tagging or a no-op merge does **not**
  count as `changed`.
- **`removeTrait`** — refuses the core traits `Transform` / `EntityAttributes`;
  removing an absent trait is a silent no-op, not an error.
- **`addEntity`** — allocates the next free numeric id (real, not synthesized — it
  persists) and ensures `EntityAttributes` carries a stable `guid` + `name` +
  `parentId` so the entity round-trips through load/save + selection-restore.
- **`removeEntity`** — deletes the entity plus its whole subtree (children found
  by `parentId`, GUID or legacy numeric).
- **`setBaseScene`** — sets or clears a scene's top-level `baseScene` ref (see
  [Base scenes](#base-scenes-nestable-cross-scene-persistence)); what
  `SceneAssetView`'s Inspector field writes through.

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
