# Editor hot reload (HMR) — what applies, what reloads, what can't

**Why this doc exists:** a stale editor doesn't just annoy — it makes **measurement lie**. Every
Percept read (`get_scene_state`, `journal`, `get_editor_state`) is only as trustworthy as the module
graph behind it, and the failure mode used to be **silent**. It cost two sessions: a correct sling
ramp fix was re-diagnosed and nearly reverted because the editor served the pre-fix build, and a
focus-scope fix measured four times as "not working" while the modules were stale.

Related: [editor-input.md](./editor-input.md) (the keymap contract), [debug-tools-mcp.md](./debug-tools-mcp.md)
(observe-don't-infer).

## The rules

| You edit | What happens |
|---|---|
| `games/<id>/**.ts`, `games/<id>/game.ts` (game **code**) | **Full page reload** — the only thing that can apply it |
| `games/<id>/runtime/assets/**` (scenes, prefabs, `.mat.json`, …) | No page reload; the **world** reloads via `modoki:scene-changed` |
| A shader **body** — `<name>.glsl` / `<name>.wgsl` | Same as above: remapped to its sibling `<name>.shader.json` and broadcast as `kind:'shader'` (#857) |
| `games/<id>/tests/**`, `project.config.json` | Nothing (they don't affect the running editor) |
| `editor/input/{keymap,focusScope,dispatcher}.ts`, `editor/createEditor.tsx` | **Full page reload** (registry can't survive a swap) |
| `runtime/rendering/npr/**` | **Full page reload** (TSL nodes bake into compiled WGSL) |
| Any other engine/editor source | Normal React Fast Refresh |

⚠️ **"The world reloads" does not mean every cached ASSET is re-read.** Per-kind invalidation on an
external write lives in `ASSET_CACHE_INVALIDATORS` (`engine/app/debug/agentBridge.ts`) —
animation, timeline, particle, spriteanim, rig2d, animset, material, shader, mesh. **`prefab` is
deliberately NOT in it** — that branch also runs during Play, and evicting a prefab mid-Play breaks the
runtime's synchronous `getCachedPrefab` spawns. A `.prefab.json` change falls through to the scene
hot-reload instead, and `handleSceneChanged` evicts **both** prefab caches immediately before that
reload (#1169): the runtime one is evicted (`invalidatePrefab`), and the editor's own copy is
**re-read in place** (`refreshPrefabSourceForPath`, installed through `setPrefabSourceRefresher`) —
it is the base the serializer diffs instances against. Refresh only the runtime cache and an instance
is rebuilt from the new prefab while the next save diffs it against the old one, keeping a trait or
entity the new prefab added as an override. ⚠️ Re-read, never merely deleted: that copy has
synchronous readers that treat a miss as "not a prefab", and in prefab-edit mode no reload follows to
refill it — a delete made the next prefab-edit save inline a nested prefab and report success
(caught in review, before it shipped). For the same reason an unreadable file (a half-typed hand edit)
keeps the old entry, and an entry replaced while the re-read was in flight (an Apply-to-Prefab) is
not overwritten. The prefab OPEN in prefab-edit mode keeps its copy: its edit world still holds the
old content, so an external rewrite of that one file is still overwritten by its next save, exactly as
before #1169 — "disk wins" does not reach that mode, because no reload shows the new file there. The eviction is load-bearing: a scene load acquires before it releases, so without it
the new scene id finds the entry still owned by the old id, `fetchPrefab` returns on the cache hit, and
the reload re-instantiates the OLD prefab — observed live on `games/skin-test` with the eviction
removed: the log said "hot-reloaded scene (prefab change …)" and the head bone kept its pre-write
scale. `load_scene` on the path already open still behaves that old way (it is an explicit load, not a
watcher event), and swapping to a different scene and back re-reads the prefab only if that other
scene does NOT also use it. **Verify any disk edit by querying the live spawned entity, never by
re-reading the file you wrote.**

**A reload over unsaved edits discards them (disk wins) and drops their undo history with them**, then
makes the reloaded world the clean baseline (#1409). The exception is a base scene the reload KEEPS:
its edits survive live and so does its dirty flag (#1417). The rule and why:
[scene-loading.md § Per-scene undo history](scene-loading.md#per-scene-undo-history).

**`mesh` (`.mesh.json`, #1380) needs more than an eviction, and it is the one kind here that is not an
`ASSET_SCHEMA_TYPE`.** Nothing agent-side writes one and it is never parked, so the only external
writer is a plain file edit — which is why #842's "schema type ⊆ live-reload kind" check could not
see it (`liveReloadKinds.test.ts` now enumerates the classifier's whole JSON table instead), and a
changed `model`/`mesh` binding rendered until the next scene swap. (The file's `material` field is
not a live fallback, by the owner's choice on #1385: a GLB entity with an empty `Renderable3D.material`
renders the engine default, and the importer copies the file's material onto the entity at spawn. So
a `material`-only edit changes nothing on screen and announces nothing. And a GLB entity whose
`Renderable3D.mesh` is swapped keeps the default too — the swap re-runs the material bind.) Two mechanisms make it work:
- **Stale-while-revalidate, not evict.** `invalidateMeshAsset` keeps the cached definition serving
  while it re-reads the file, and swaps only once the new definition AND its model templates are
  loaded. An eager evict made `resolveMeshTemplate` return nothing for the refetch's duration — during
  Play a mesh collider was rebuilt with no geometry — and did it even for a byte-identical write. A
  failed re-read (a half-typed hand edit) keeps the old entry, #1169's prefab rule.
- **A renderer teardown.** `scene3DSync` caches each entity's built object keyed on the
  `Renderable3D.mesh` **ref string**, which the edit does not change, so swapping the definition alone
  redraws nothing. The swap is preceded by a `'mesh'` asset-invalidation event — only when the binding
  actually changed — and `attachInvalidationListener` tears down every entity whose ref resolves to
  that path. The Inspector's `MeshAssetView`/`MeshPreview` re-read on the same event, which is
  why an UNCACHED (never loaded, or failed) entry still announces one: a panel showing a broken
  file must re-read when it is fixed.

The editor's own write (`modelImport`) is `markEditorWrite`-suppressed, so it calls
`invalidateMeshAsset` itself, **after** the write. A model the edited file newly names loads unowned
until the next swap — the render-path-resolver case `acquireMesh` already documents.

### A reload the editor cannot take right now is DEFERRED, not dropped

During Play/Pause and inside a scrub/preview envelope, `sceneReloadSuppressedReason()` blocks the
scene/prefab hot reload — a reload there rebuilds the world the run's snapshot belongs to, and inside
an envelope it tears the preview down mid-pose. It also blocks while the editor is stopped but a
world-replacement token is held (below): a reload then would supersede the scene open, restore or
save cycle that holds it. Until #1164 the blocked change was simply **dropped**:
Stop/Exit restored the pre-write snapshot, the world sat behind the file on disk with nothing saying
so, and the next Cmd+S wrote that stale world over the external change (a hand edit, a `git checkout`).

Now the blocked change is recorded (keyed by path, logged as "scene hot-reload deferred") and
`replaySuppressedSceneReloads` replays it through the same `handleSceneChanged` a live change takes, so
it gets exactly the treatment it would have had one frame after Stop. **Disk wins** — including over
unsaved edits the restored snapshot carried, which is what a stopped-mode external write already does
(owner's call, 2026-09-13).

Three things about the replay are load-bearing:

- **It fires on "authoring settled", not on the run-mode edge** (`editor/scene/authoringSettle.ts`).
  `stopPlay` flips to `stopped` BEFORE its snapshot restore loads, and the editor's `loadScene` flips
  before a scene open loads. A replay keyed on the edge starts its load under theirs and SceneManager
  supersedes one with the other — the replay is lost again, or it reloads the old scene over the one
  being opened. So `stopPlay`, `endTimelinePreviewSession`, the `loadScene` wrapper and Cmd+S's
  suspend → save → resume cycle inside an envelope (`saveCommand.ts`) each hold a world-replacement
  token, taken synchronously before any mode change, and settle fires only once the count is zero
  while `canEdit()` holds. A new path that swaps the world after flipping the mode needs a token too.
- **It checks suppression twice** — before the handler's `fetch` of the scene file and again after
  it, because a Play press, an envelope or a scene open can begin inside that await. A change that
  finds itself suppressed late is deferred again, with the prefabs it was carrying.
- **It runs its reloads one at a time.** Fired together they supersede each other, and the winner does
  not carry the loser's options: a base-scene reload needs `forceReloadBases`, a prefab reload does
  not, so a prefab reload winning leaves the base stale. Measured live on the first, fired-together
  version (the scene replay logged "superseded"). A run batches every write made during it, so the
  mix is far likelier than in a live watcher batch, which still has that race.
- **Prefab changes collapse to one reload**: the last one replays last and evicts the others at
  the same moment. Nothing is evicted up front, so a replay suppressed part-way never leaves a
  prefab evicted during Play.

Known gaps, left on purpose (found in the #1164 close-out review, none reproduced):

- **World swaps that take no token** — `openPrefabForEditing`, `applyPrefabUndo` and the runtime
  `load-scene` op call `sceneManager.loadScene` directly, so a live reload can still supersede them.
  That race predates #1164; the tokens cover the paths that flip the run mode.
- **A token that is never released** (a load that hangs past every abort checkpoint) now defers every
  live hot reload while stopped, and the pending set has no editor or MCP surface — only the warning in
  the console says so.
- **A deleted prefab** keeps its editor-side copy when the manifest drops the path before the watcher
  event lands (`getGuidForPath` no longer resolves the GUID key).

### A shader is TWO files, and only one of them used to be watched

A shader is authored as a `.shader.json` descriptor plus a sibling `.glsl`/`.wgsl` carrying the
source — and the source is the file an author actually iterates on (`ShaderAssetView`'s own help
text points at it). Until #857 the watcher gated its entire broadcast on `extname === '.json'`, so
editing the body produced **no event at all**: the compiled program stayed cached until a scene swap,
and the editor could be running a shader that no file on disk contained.

A body write is now remapped to its sibling descriptor before classification, and broadcast as that
descriptor's `kind:'shader'`. Three consequences worth knowing:

- **The body is still not a manifest asset.** No GUID, no manifest entry, no `LiveReloadKind` of its
  own — `assetTypeClassifier` excludes `.wgsl`/`.glsl` on purpose ("shader SOURCE … not a
  GUID-referenced runtime asset"), and the remap is what lets that stay true.
- **A body with no sibling descriptor broadcasts nothing.** That is deliberate, not a gap.
- **Editing `foo.glsl` and `foo.wgsl` within one 150 ms debounce produces ONE broadcast**, because
  the pending map is keyed by the descriptor's URL path.
- **A body edit does NOT discard an unsaved parked edit on the descriptor.** The broadcast carries
  `viaSibling`, and `dropParkedWriteFor` runs only for a direct write to the descriptor itself.
  Without that distinction the remap makes the two indistinguishable, and the drop's own premise
  ("the file on disk is now authoritative") is false when only a sibling changed — you would
  declare a uniform in the Shader Inspector, save the `.wgsl` you added it to, and lose the
  declaration. A direct write to the descriptor anywhere in the same debounce window still wins,
  because the flag collapses by AND.

⚠️ **There are TWO watchers, and they must not drift.** The Vite dev server has one and the Electron
main process has an independent twin (`engine/electron/assetBackend.ts`) — the default editor
surface, and what the `modoki` MCP drives. They have now drifted four times, each time through
whatever line the previous fix left duplicated: the classifier, then the extension gate itself. Both
route through one shared `pathToClassifyForChange`, and
`engine/tests/architecture/liveReloadKinds.test.ts` enumerates watcher implementations and fails any
that re-tests the extension itself. If you add a third watcher, it is swept in automatically.

## Why game code needs a reload

Vite **does** watch and recompile `games/<id>/**.ts` — this was long assumed otherwise. Measured via
CDP `Network.webSocketFrameReceived`: the update propagates up the static `virtual:modoki-games`
chain to `/app/App.tsx`, which is a Fast Refresh boundary and **self-accepts**, so nothing reloads.
Meanwhile the running editor got its game from a **separate** `@vite-ignore` dynamic import
(`app/projectGames.ts`, called once from `app/editor/setup.ts`) whose URL never changes — so ESM
keeps serving the cached instance forever. The new code is compiled, served, and never asked for.

Re-registering in place was evaluated and rejected — five things cannot be re-applied:

1. `registerAll()` is a guarded one-shot (`app/ecs/register.ts`).
2. `createEditor` returns a **new** component; `App.tsx` already resolved the old one via `React.lazy`.
3. `registerDebugCommand` is a plain array push — it duplicates on every re-run.
4. Engine systems register as a **top-level import side effect** (`app/ecs/pipeline.ts`).
5. `App.tsx`'s `GAMES` comes from the **baked** `virtual:modoki-games` — a different module instance
   than the editor's.

Also: `g.registerSystems()` is a silent no-op on a second call (games guard on a module-level
`registered` flag), and `registerSystem(name, fn, prio)` without re-passing `opts.actions` silently
unregisters every UIAction the previous registration owned. A full reload sidesteps all of it, and
matches what Open Project already does (`electron/main.ts` → `reloadIgnoringCache()`).

**Unsaved work: the reload wins, but never silently.** There is no `beforeunload` guard anywhere, so
the reload really does destroy unsaved work — and "unsaved work" is not only the live scene: an
Inspector edit parked in the dirty-asset registry (a material/particle/anim/timeline doc), a pending
`baseScene` ref, or a parked `.meta.json` import-setting edit are all just as gone, because the
registries holding them are renderer memory, not disk. That is the deliberate choice — a stale editor
is the worse failure — but the loss is always announced, and named for what it actually is:

- **Nothing dirty** → reload immediately.
- **Something dirty** → a **5s countdown banner** naming the actual cause(s) — e.g. "reloading in
  Ns; unsaved scene changes will be LOST", or "…; 2 unsaved asset edits will be LOST" when the only
  pending work is a parked material/particle edit and the scene itself is clean — with **Reload
  now** and **Cancel**. Doing nothing takes the loss.
- **After** such a reload → an info banner plus `discardedUnsavedEdits: true` in `get_editor_state`
  and a `!hmr.discarded-unsaved` editor-journal event **whose payload carries the cause**, so a
  post-hoc journal read can tell which kind of work was lost. The discard happens on a page that is
  about to die, so it is carried across the reload in `sessionStorage` — otherwise it could never be
  reported.
- **Cancel** → `staleGameCode: true` and a persistent "Running STALE game code" banner. This is the
  one state where measurements silently lie, so it stays loud.

**The cause set is ENUMERATED, not hand-listed (#850).** `app/debug/hmrStaleness.ts`'s `DirtyProbe`
returns whatever `unsavedChangeCauses()` (`editor/scene/serialize.ts`) reports — a `Record<string,
boolean | string[]>` — and the message builder (`describeCauses`) walks that object rather than
naming a fixed set of keys. Before #850 the module hand-wrote "unsaved scene changes" in every
message, which was already wrong once #831/#845 added asset, base-scene, and import-setting causes
that can be dirty while the scene itself is perfectly clean. So a SIXTH cause added to
`unsavedChangeCauses()` shows up in the banner/console/journal with **no edit to
`hmrStaleness.ts`** — a cause without a hand-authored entry in its `CAUSE_LABELS` map still renders,
humanized from its key name, rather than being silently dropped.

**If you are an agent, you are usually the cause**: your write to a game `.ts` is what triggers the
countdown, and the human may not be at the screen for it. Check `get_editor_state.unsavedChanges`
*before* editing game code and say so.

Implementation: `plugins/vite-asset-scanner.ts` (`isGameCodeFile` + `handleHotUpdate`) →
`modoki:game-code-changed` → `app/debug/hmrStaleness.ts`.

## The Fast Refresh trap: `[]`-deps effects do NOT re-run

Measured across one HMR cycle of a panel:

| | before | after |
|---|---|---|
| module re-evaluated | 3 | **4** |
| component re-rendered | 2 | **4** |
| `[]`-deps effect re-ran | 2 | **2** |

So a panel that registers into a module-level registry from a `[]` effect keeps its **original**
registration forever. Handler *bodies* still update (they're reached through a ref that every render
refreshes), which is why this looks like it works — what goes stale is registration **structure**:
adding a binding, or changing its `keys`/`when`.

**If you add a registry-writing effect, key it on `useHmrEpoch()`** (`editor/input/hmrEpoch.ts`),
which ticks on every hot update and is a frozen `0` in production — so `[epoch]` is exactly today's
`[]` in the packaged editor. All eight keymap registrars already do this.

## Registries that force a reload instead

`keymap.ts` was measured forking into **two live registries**: after an edit the new instance held 24
app bindings and **zero** panel bindings, while the window dispatcher kept resolving against the old
instance. `invalidate()` (the NPR precedent) is not enough there — the importers are panel
*components*, which are valid refresh boundaries and absorb the propagation. Those four modules use
`import.meta.hot.accept(() => location.reload())` instead. They are stable files, rarely edited.

**Most module-level state does NOT need this.** A 50-agent audit found 341 module-level bindings,
claimed 153 as risky, and only **6** survived adversarial verification. The reason most are safe is
worth knowing: Vite propagates an update through the whole importer chain to the nearest
self-accepting boundary, so a registry and its writers are almost always recreated **together**. The
broken shape is narrow — a registry in a non-boundary module whose writers are `[]`-deps effects
inside components that *are* boundaries. Don't add `import.meta.hot` handling on suspicion; establish
that shape first.

## Measured: no editor registry subscription needs `hmrEpoch` (#312)

Panel effects that subscribe to a module-level listener `Set` with `[]` deps are exactly the broken
shape above, so they were **measured rather than patched**. Every one is safe, and none needed a
change. The reason has nothing to do with the effect's deps.

The unit of measurement is the **registry module**, not the site — a fresh `Set` can only appear if
that module is re-evaluated while the subscriber survives. Touching each one:

| Registry module | Touched → | Subscribing sites |
|---|---|---|
| `runtime/core/ecs/worldRegistry.ts` (`onWorldSwap`, via the `ecs/world.ts` re-export) | **page reload** | `SceneView.tsx` :356 :2470 :3592 · `Hierarchy.tsx` :603 :625 :743 · `TimelineEditor.tsx` :563 |
| `runtime/core/renderDirty.ts` (`addDirtyListener`, re-exported unchanged from `entityUtils.ts`) | **not independently re-measured** — moved out of `entityUtils.ts` (side-effect-free extraction, matching `uiDirty.ts`'s own split off `uiTreeStore.ts`); touching `renderDirty.ts` alone now resets this Set, touching `entityUtils.ts` alone may no longer | `Console.tsx` :63 · `Hierarchy.tsx` :742 · `SceneView.tsx` :2468 |
| `runtime/core/ecs/entityUtils.ts` (`onStructureDirty`, `onStructureDirtyCoalesced`) | **page reload** | `SceneView.tsx` :2469 |
| `runtime/core/uiDirty.ts` (`onEditorDirty`, via `runtime/ui/uiTreeStore`) | **page reload** | `inspectorFields.tsx` :23 · `Inspector.tsx` :1633 · `UIFocusGraphOverlay.tsx` :143 · `UIResizeOverlay.tsx` :267 |
| `runtime/core/activeRenderer.ts` (`onRendererLost`) | **page reload** | `SceneView.tsx` :4736 |
| `runtime/core/playState.ts` (`onPlayStateChange`) | **page reload** | `SceneView.tsx` :2471 |
| `runtime/rendering/text/textDirty.ts` (`onTextDirty`) | **page reload** | `SceneView.tsx` :2472 |
| `runtime/rendering/materialDirty.ts` (`onMaterial3DDirty`) | **page reload** | `SceneView.tsx` :2478 |
| `editor/animation/poseClip.ts` (`onPoseEnvelopeExited`) | **page reload** | `AnimationEditor.tsx` :439 — see below |
| *control:* `editor/panels/Console.tsx` | `hmr update` | — |

A full reload rebuilds the registry **and** its subscribers together, so the stale-`Set` fork cannot
happen. **The control is the load-bearing row**: without one module that genuinely stops at a
boundary, "page reload everywhere" is indistinguishable from a probe that cannot see the difference.

**Re-running the sweep** (the site list above is a snapshot; this query is not):

```bash
cd engine/packages/modoki/src
grep -rn --include='*.tsx' -E "useEffect\(\(\) => on[A-Z]" editor      # inline-return form
grep -rn --include='*.tsx' -E "(=|return|\[)\s*on[A-Z][A-Za-z]*\(" editor | grep -vE "\bon[A-Z][a-z]*="
```

Then, per registry module, in a running editor: stamp `window.__hmrProbe` via `modoki_eval`, append
a comment to the module, re-read the probe. Gone (and `performance.timeOrigin` advanced) → full
reload, site is safe. **Surviving → the update stopped at a component, and that site needs
`useHmrEpoch()`.** The vite log (`page reload …` vs `hmr update …`) agrees but is not sufficient
alone — read the probe.

**`poseClip.ts` is the row to understand, because it is why #312 was filed.** It is imported by
`AnimationEditor.tsx`, a component Fast Refresh accepts — the textbook broken shape. It still
full-reloads, because **`editor/index.ts` imports it too**, and that barrel is a non-component
module with no accepting boundary above it. Vite full-reloads when *any* propagation path fails to
find one. The barrel re-exports nearly the whole editor surface, so almost every editor and
`runtime/core` module inherits a non-accepting path to the root — **that is what makes this bug
class unreachable in practice**, and it is why the keymap registries needed an explicit
`location.reload()` while these do not (they are reached only through component importers).

So #312's premise that the hazard "just bit for real" is **wrong**: the `useHmrEpoch()` key added to
`AnimationEditor` in `9c6215f35` is harmless and costs nothing in a shipped build, but it was never
load-bearing. Do not read it as evidence the hazard fired.

⚠️ **This verdict is a property of the import graph, not of the effects.** It would stop holding if
a registry module's only importers became components — so re-measure with the query above after a
refactor that narrows one, rather than trusting this table.

## Unrecoverable Fast Refresh

Changing **hook order** (adding/removing a hook) throws *"Rendered more hooks than during the
previous render"* inside Fast Refresh and takes down mounted panels via their error boundaries. This
is inherent to React, so `app/debug/hmrStaleness.ts` **detects and reloads** rather than trying to
prevent it — once only, guarded by a `sessionStorage` key so a crash that reproduces on boot cannot
loop. If you see the reload happen twice, the edit has a real defect; it is not an HMR artifact.

## Checking whether an editor is stale

`get_editor_state` reports `hmrUpdates` (hot updates since boot; absent means zero),
`staleGameCode: true` (a game-code reload was cancelled — this editor runs the OLD build), and
`discardedUnsavedEdits: true` (this page load dropped unsaved work — scene, asset, base-scene, or
import-setting edits, whichever was pending — to pick up new game code).
Silence on all three means the running build is the one that booted and nothing was lost.

Plugin changes (`engine/plugins/**`) are **not** hot-reloadable at all — restart the editor
(`npm run editor:dev`) after pulling or editing them.

## This applies to the PACKAGED editor too

Easy to get backwards, and the code comments originally did. The packaged editor **spawns a real
Vite dev server and loads its origin** (`electron/devServer.ts`: *"the packaged app == the dev app
(one Vite origin)"*), so `import.meta.hot` is **defined** there and everything on this page — the
game-code reload, the countdown, the epoch, the crash recovery — is live for DMG users. That is
deliberate: the packaged editor is a real authoring environment where people edit game code.

What genuinely has no HMR is a shipped **game** build (web/native/playable): `__MODOKI_EDITOR__` is
false, so `main.tsx` never imports `hmrStaleness` at all, and `useHmrEpoch()` is a frozen `0` making
`[epoch]` identical to `[]`.

**Known scope limit:** the four `accept(() => location.reload())` modules and the hook-order recovery
reload do **not** run the unsaved-work countdown — they reload immediately. They live in the engine
package, which cannot import the app-shell guard. In practice they fire only when you are editing
those specific engine files, not while authoring a scene.
