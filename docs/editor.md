# Visual Editor

modoki ships a **Unity-like visual editor** for authoring scenes, prefabs, materials,
and ECS-driven UI. It is **development-only** — it is not bundled into production game
builds.

The editor ships as an **Electron desktop app** (`engine/electron/`, electron-builder +
`autoUpdate` self-update) — this is the host you actually distribute and debug. The same
renderer also runs in a plain browser tab over Vite HMR at `http://localhost:5173/#/editor`,
which stays useful as a fast renderer-iteration loop. Both load the identical editor
renderer over the same backend (`editorBackendRouter`, served by the Vite dev server in the
browser and by the Electron main process in the desktop app), so they behave the same; only
the Electron host exposes the Electron-only surfaces (main-process logs, IPC, native file
dialogs, `autoUpdate`, packaging). See [Architecture](./architecture.md) and the debug-tools
notes in the repo `CLAUDE.md` (modoki MCP vs chrome-devtools MCP).

The editor operates directly on the live ECS world: it reads and writes
`getCurrentWorld()`, the same systems run, and React panels are fed by projections.
There is no separate editor data model to keep in sync with the runtime.

> **Scope note:** the shipped surfaces are the Electron desktop editor and the browser
> tab (same renderer, same backend router). A VS Code extension and a Tauri-wrapped desktop
> build were considered but **not** pursued (Electron won the desktop path) — everything
> below describes that shared editor.

Related: [Architecture](./architecture.md) · [Scene Loading](./scene-loading.md) ·
[Prefabs](./prefabs.md) · [Materials & Textures](./textures.md) · [UI System](./ui-system.md)

---

## Shell & layout

`editor/EditorApp.tsx` is the shell. It uses **`flexlayout-react`** for dockable,
resizable, Unity-style tabbed panels. The default layout is Hierarchy (left), a
Scene/Game/Console/Assets column (center), and Inspector (right).

Layout state is persisted two ways:

- **Working state** auto-saves (debounced) to `localStorage` under `editor-layout`.
- **Named layouts** are written as `<name>.layout.json` files under
  `<project>/.modoki/layouts` via the backend's `/api/layout` POST endpoint
  (listed via `/api/layouts` GET) (File → *Save Layout As…* / *Load Layout…*). The tracked file path is stored in
  `localStorage` so the association survives a reload.

On startup `loadInitialModel()` prefers the tracked file, then the localStorage mirror,
then the built-in default layout. *Reset Layout* clears both and reloads (live
Three.js/Pixi viewports don't tear down cleanly on an in-place model swap).

The menu bar (`File` / `Edit` / `View`, plus host-injected menus) is rendered by
`components/MenuBar`. Keyboard: `Cmd/Ctrl+S` → Save All, `Cmd/Ctrl+Z` → undo,
`Cmd/Ctrl+Shift+Z` → redo.

### `createEditor()` — host configuration

`editor/createEditor.tsx` is the factory the host (a game) calls to configure the
editor. It registers the game config, model postprocessors, and game-specific traits,
and stashes custom panels, the Game View component, extra menus, and an optional
**Project Settings** schema for `EditorApp` to pick up. It also kicks off scene loading:
the manifest loads immediately, but the actual scene load awaits `rendererReady` (so
`KTX2Loader.detectSupport` has run before any `loadAsync`). Critically, the `React.lazy`
import of `EditorApp` is **not** gated on `sceneReady` — `sceneReady` itself awaits
`rendererReady`, which only fires once `SceneView` (inside `EditorApp`) mounts its
renderer, so gating would deadlock. See [Scene Loading](./scene-loading.md).

---

## Panels

Panels live in `editor/panels/`:

- **Hierarchy** (`Hierarchy.tsx`) — the entity tree. Supports drag-to-reparent and
  drag-to-reorder, and dropping a prefab from Assets to instantiate it. Prefab-instance
  entities (those with the `PrefabInstance` trait) are tinted and badged with a blue
  **`P`** marker.
- **Inspector** (`Inspector.tsx`) — live trait editing for the selected entity or asset.
  Traits are grouped into collapsible `Section`s; fields use typed widgets —
  `NumberField`, `ColorField`, and a generic `ParamField` for material/shader params.
  Edits write straight to the ECS world and push undo entries. It also hosts asset
  inspectors (e.g. the Texture inspector that drives the import pipeline).
- **SceneView** (`SceneView.tsx`) — the authoring viewport (3D and UI modes, below).
- **Game** (the **GameView**, injected via `createEditor`) — the live game preview.
- **Assets** (`Assets.tsx`) — the project asset browser. Context-menu *Re-import* on a
  single asset, or *Re-import all* (recursive, per-folder + root) to regenerate
  converted texture/model variants via `/api/reimport`. See
  [Materials & Textures](./textures.md). The bottom of the panel hosts a **Scripts**
  view (`ScriptTree.tsx`) — a lightweight collapsible tree of the project's source
  (`game.ts`, `runtime/**`, writable) plus a read-only **Engine** source root, fed by
  `GET /api/scripts/tree`. Scripts deliberately bypass the asset pipeline (no
  GUID/`.meta.json`). Modoki has **no in-app code editor** — clicking a script *reveals*
  it in the OS file manager (`/api/reveal-in-finder`) so you edit it in your own editor
  (VS Code, …) and drive it with your own Claude Code (see
  [connect-claude-code](./connect-claude-code.md)).
- **Console** (`Console.tsx`) — captured log output with a per-level filter (persisted in
  the panel's layout config) plus a live text filter, live FPS/entity-count stats, and a
  detail pane for the selected line's message + stack. Rows are **virtualized**
  (`consoleVirtualization.ts` `computeVisibleRange`/`clampScrollTop`, uniform row height) so
  a large log volume stays cheap. The interception itself lives in `consoleCapture.ts`,
  installed at the **very start** of editor launch (from `createEditor`, before any lazy
  panel loads) so nothing fired during early init is missed: it patches
  `console.log/warn/error` and listens for `window` `error` + `unhandledrejection`, into a
  1000-entry ring. Stacks are formatted **lazily** (only when a `warn`/`error` row is
  expanded); `log`-level entries carry no stack.
- **ModelPreview** (`ModelPreview.tsx`) — an embeddable mini 3D viewer used by the Model
  inspector. It owns its own `WebGLRenderer`, orbit controls, and lights, with a toolbar
  for LOD-level switch, wireframe toggle, and camera reset; it disposes everything on
  unmount.

Dialogs/modals mounted by the shell include `ApplyPrefabDialog`,
`ProjectSettingsDialog`, and the import/build progress modals. Each panel is wrapped in a
`PanelErrorBoundary` so one panel crashing doesn't take down the editor.

---

## Trait registry & the auto-generated Inspector

Every ECS trait the editor can show is described by a **`TraitMeta`** in the trait registry
(`runtime/ecs/traitRegistry.ts`). A game registers its traits once (engine traits via
`engine/app/ecs/registerTraits.ts`'s `registerAllTraits()`; game traits from the game's own
`setup.ts`), and from that metadata the editor **auto-generates the Inspector, serializes
generically, and discovers entities** — there is no hand-written Inspector form per trait.

`TraitMeta` carries `name`, the koota `trait`, a structural `category`
(`'component' | 'resource' | 'tag'`), a `fields` map of per-field `FieldHint`s, an optional
`role` (e.g. `'camera'`), a `priority` (lower renders first; default 100), and a
`componentCategory` UI grouping for the Inspector "Add Component" menu (`Transform`,
`Rendering`, `Lighting`, `Camera`, `UI`, `Animation`, `Physics`, `Gameplay`, `Misc`) with a
fixed `COMPONENT_CATEGORY_ORDER` shared with the Hierarchy "Type ▾" filter so the two never
drift.

Each field's `FieldHint` drives one Inspector widget — and the same hints drive the
Animation Editor's property picker and the scene validator:

- **`type`** — `number | string | boolean | color | enum | entityRef | bindings | materialOverrides`.
- **enum options** — a static `options: string[]`, or a **dynamic `optionsSource`**
  resolved at render time: `'uiActions'` (registered UIAction names, global),
  `'animationClips'` (clip names from this entity's `SkinnedModel`), `'skeletonBones'`
  (bones from this entity's `BoneAttachment.target`), or `'physicsLayers'`. It stays a
  string so the field schema is JSON/structured-clone-safe when pushed to the validator.
- **layout** — `group` renders sibling fields as a Vec2/Vec3 (e.g. Transform's `x/y/z` → a
  Position row) with an optional per-field `label`; `section` / `sectionDefaultOpen` /
  `sectionDivider` fold fields into a collapsible sub-section within the trait.
- **`showWhen: Record<string,string[]>`** — the field is visible only when a named sibling
  field's value is in the list (conditional fields).
- **transforms** — `display:'degrees'` converts radians↔degrees on read/write (Transform
  rotation); `alphaField` folds a sibling `0..1` number into a color picker's A slider and
  hides its standalone row; `multiline` renders a string as a textarea; `accept` lists
  drag-drop file extensions; plus `step/min/max`, `tooltip`, `readOnly`.
- **`runtimeOnly`** — a field the trait's system recomputes every frame (e.g.
  `Time.elapsed/frame`); **excluded from serialization** so a save never bakes a transient
  snapshot or churns the file. Independent of `readOnly` (a field can be read-only in the
  Inspector yet still authored and persisted).

`registerTrait()` is keyed by the koota `Trait` object but also indexed `byName`; on
re-registration — a script hot-reload re-imports a trait module and produces a **new**
`Trait` object with the **same** name — it evicts the prior object first, so
`getAllTraits()` never accumulates a stale duplicate that would corrupt serialization, the
persistent-entity snapshot, or the Inspector. `inferFields(trait)` is a public helper that
derives basic hints from a koota schema's default values; it has no internal callers
(registration always supplies explicit `fields`) and exists for downstream tooling.

---

## SceneView modes

`SceneView` has a mode toggle (persisted to `localStorage` under
`editor:sceneViewMode`):

- **3D mode** — a Three.js viewport with an orbit camera. Object transforms use
  Three.js's **`TransformControls`** (translate / rotate / scale), with `OrbitControls`
  disabled while a gizmo handle is dragging. Selection is a raycast on pointer-down.
- **UI mode** — a **device-sized DOM preview**: the real `UIRenderer` is rendered over a
  letterboxed device frame, and clicking an element selects its entity (`UIRenderer`'s
  `onSelectEntity` → `selectEntity`). UI elements are manipulated with a **custom**
  gizmo overlay — `UIResizeOverlay.tsx` (`UIResizeOverlay`) for `UIElement`/`UIAnchor` entities
  and `Gizmo2D.ts` for 2D canvas content — supporting move/resize handles in device
  space. (The custom gizmo here is for the DOM/2D layer; the 3D layer uses Three.js
  `TransformControls`.)

The gizmo mode (`translate | rotate | scale`) and space (`world | local`) live in
`editorStore` and are shared by both modes via a toolbar.

3D rendering in SceneView shares sync logic with the runtime via
`runtime/rendering/scene3DSync.ts` (`syncRenderables` — the exported entry point; it
composes the module-private `syncMaterial`/`applyTransform` helpers internally),
so the editor and the shipped runtime stay visually identical. UI mode reuses
`anchorLayout.ts`'s `resolveAnchorRect` — see [UI System](./ui-system.md).

### Object picking

Pointer-down selection is a **pure hit-test** in `editor/panels/picking.ts`, deliberately
free of ECS/DOM access so it's unit-testable headlessly (the caller gathers candidates and
passes plain values in):

- **`pick3D(ndcX, ndcY, camera, entries)`** — a Three.js `Raycaster` from normalized device
  coords through the camera. A GLB model is a `THREE.LOD`/group whose raycast hit is a
  nested child mesh, so it walks **up** from the hit object to the first ancestor that
  matches a tracked entity; `entries` order is the tie-break (SceneView lists meshes before
  gizmos).
- **`pick2D(px, py, candidates)`** — the topmost 2D entity whose pivot-shifted AABB contains
  the point; "topmost" = highest paint `order` (last painted, visually on top), with ties
  (or candidates lacking an order) falling back to closest box-center.

UI mode picking is DOM-native — the `UIRenderer` reports the clicked element's entity via
`onSelectEntity`.

### 3D collider outline overlay

When a `Collider3D` entity is selected in 3D mode, SceneView draws a **green wireframe**
(`0x2ecc71` `LineSegments`) of the collider shape, built by the pure builder
`runtime/rendering/colliderOutline3D.ts` (`colliderWireframeGeometry` +
`colliderOutlineSig3D` change-detection, rebuilt only when the shape/dims signature
changes). Primitive shapes (`box`/`sphere`/`cylinder`/`cone`/`capsule`) are built at their
**absolute** collider dims and follow the entity's world position + rotation but **not**
`Transform.scale` (colliders are unscaled world units); mesh shapes (`convex`/`trimesh`)
edge the resolved mesh geometry and **do** bake world scale. Only the selected entity's wire
is kept; it's disposed on deselect or a switch to UI mode. For the 2D collider
**vertex-editing** overlay (the "Points" toolbar mode) see [physics-2d.md](./physics-2d.md).

---

## GameView

The **Game** tab renders the host-supplied GameView component: a live preview of the
running game with selectable **device presets**. Unlike SceneView, it composites all
three rendering layers — `3d` (Three.js), `2d` (PixiJS), and `ui` (the DOM
`UIRenderer`) — exactly as they appear on device. See [Architecture](./architecture.md)
for the layer model.

---

## Play / Stop / Pause

The editor drives a global three-state play mode (`runtime/systems/playState.ts`:
`'stopped' | 'playing' | 'paused'`). The **shipped** game defaults to `'playing'` so its
systems run with zero setup; the **editor** opens every scene `'stopped'`. `isSimRunning()`
(true only while playing) gates the TIME / GAME / ANIMATION pipeline stages and UI-action
dispatch — so a stopped scene sits still, clicking a UI button does nothing, and Cmd+S
serializes clean authored data. Transform propagation and projections still run, so editor
edits reflect immediately.

The Play/Stop controller (`editor/scene/playMode.ts`) implements Unity-style
enter-play / revert-on-stop:

- **Play** (`enterPlay`) snapshots the live world **in memory** with the same
  `serializeScene()` the save path uses — deliberately **without** `assignGuids`, so Play
  never writes authored data — records the scene path and the current undo depth (the
  "barrier"), then flips to `'playing'`. Resuming from Pause does **not** re-snapshot.
- **Pause** (`pausePlay`) freezes the sim but keeps the mutated play world.
- **Stop** (`stopPlay`) reverts by reloading that snapshot through `SceneManager`
  (`preloaded:` — no disk fetch; resources reused via the scene refcount), discarding every
  play-mode mutation, then `truncateUndoTo(barrier)` drops the during-play edits.
  **Pre-play undo history survives** the world rebuild because undo actions resolve their
  targets by stable GUID. A guard skips the revert if the active scene changed since Play
  (the snapshot is for a different scene).

This is what makes binding-driven `isVisible` (and any other system that writes ECS state at
runtime) safe: those writes only ever happen while playing, and Stop throws them away before
they reach disk. Transitions emit `!play`/`!pause`/`!stop` to the editor journal (see
[percept-plan](./percept-plan.md)).

## Selection restore across world swaps

koota entity ids are scoped to their owning world, so a `SceneManager` world swap (scene
load, prefab edit, a Stop-revert) invalidates the selected id.
`editor/store/selectionRestore.ts` subscribes to `onWorldSwap` and re-attaches the whole
selection set (plus the primary) into the new world: the **fast path** looks up each
entity's `EntityAttributes.guid` (one pass per world, no name ambiguity); the **fallback**,
for entities lacking a guid, matches by name + ancestor path. Anything unresolved is
cleared. This is the same GUID-keyed mechanism that lets a Stop-revert preserve the user's
selection.

## Asset editors

Several assets get a dedicated editor. They share one architecture: **the live def is the
single source of truth in `editorStore`**, so edits push to the **global** undo stack
(shared with Hierarchy/Inspector/SceneView) and apply even when the panel is unfocused;
consecutive same-field edits **coalesce** into one undo entry within a ~500 ms window; and
persistence is a **debounced `/api/write-file`** (~400 ms) that also re-seeds the relevant
runtime cache so any live entity referencing the asset updates next frame.

### Animation Editor

`editor/panels/AnimationEditor.tsx` — a Unity-style keyframe timeline for `.anim.json`
clips. Top: a transport toolbar (play/stop, record, prev/next frame, add-key ◆+,
break-tangents, copy/paste/duplicate keys, frame-rate, duration, loop). Left: the
animated-property `TrackList` with **Add Property**. Right: a **Dopesheet** or **Curves**
view sharing one horizontal zoom/pan viewport (wheel zooms toward the cursor, right-drag
pans).

- **Binding** — a clip binds to an **Animator** root entity; track paths are relative to
  that root. The root is discovered by scanning for the Animator whose `clips` BANK
  references the open clip (`resolveAnimatorRootForClip`, shared by the Assets double-click
  and the panel's re-bind recovery — matching against `Animator.clip`, the active-clip NAME,
  never matched a GUID). A clip nobody references yet opens **unbound**: the warning bar's
  **Bind to Entity…** button lists every entity in the scene, and picking one adds the
  `Animator` component (when missing) pre-populated with the clip, as ONE undo entry
  (`editor/animation/bindAnimator.ts` — a bound root with an empty bank would be the same
  "animation data not assigned" dead end). Re-binding an already-banked clip only moves the
  editor's root pointer — no duplicate entry.
- **"Bound" means the entity still CARRIES an Animator**, not just that a pointer exists. The
  root is a plain entity pointer (persisted across sessions as a guid in
  `animation/lastAnimationClip.ts`), so removing the component — undo, Inspector — used to
  leave the panel bound to an entity with no Animator: warning bar hidden, Bind button
  unreachable, and a live scrub preview for a clip that would never play at runtime. Both the
  session restore and the panel re-validate the trait and fall back to UNBOUND. The panel
  only drops a root that RESOLVES and lacks the trait — an unresolvable id is the transient
  mid-scene-swap state, and clearing there would flash the warning on every hot-reload.
- Editing a trait field **while recording** keys the clip at the playhead (the record hook in
  `animation/recording.ts`); editing an entity **not** under the Animator root warns and is
  dropped rather than silently lost.
- **Preview envelope + ⏹ Exit Preview** — a scrub or ▶ preview opens a snapshot session
  (`editor/scene/timelinePreview.ts`, shared with the Timeline panel) and sets run-mode
  `scrub`/`preview`. **Cmd+S is refused for the whole envelope** — the pose writes authored traits,
  so a save would bake it. **⏹ Exit Preview** reverts to the authored snapshot, re-resolves the
  Animator root (the reload reassigns entity ids) and returns to `stopped`, which re-enables saving;
  unmount / clip-switch do the same. Without it the panel wedged saves with no way out but closing
  the tab. Caveat: poses made OUTSIDE the envelope (MCP `set_playhead`, a clip edit's re-pose) open
  no session, so Exit reverts only to the envelope's start — see Phase 3 of
  `docs/plans/preview-mode-refactor.md`.
- **Live pose** — scrubbing and preview playback pose the bound entities every frame via the
  shared runtime samplers `applyClipAtTime` + `applyClipDeform` (so a scrubbed clip previews
  skeletal/cloth deformation exactly as it plays), then fire the dirty listeners so the
  viewport redraws.
- **Dopesheet** (`animation/DopesheetView.tsx`) — SVG ruler + draggable playhead + one row
  of diamond keys per track. Click / shift-click / marquee to select; drag any selected
  diamond to move the whole selection in time (frame-snapped, spacing preserved);
  double-click empty row space to add a key, a diamond to delete it.
- **Curves** (`animation/CurvesView.tsx`) — a value graph of the numeric tracks (sampled
  from `evalTrack` so it matches playback), with draggable key dots and in/out bezier
  **tangent handles**. Right-click a key for tangent presets — **Auto (smooth) / Linear /
  Constant (stepped) / Free (broken)**. The value axis auto-fits (or manual Ctrl-wheel zoom
  / right-drag pan) and freezes for the duration of a drag to avoid re-tessellating every
  curve each frame.

Both views also register **interaction handles** (`registerHandleProvider`) so an agent can
query and drag keys/tangents by id — see the Enact tooling in the repo `CLAUDE.md`.

### Particle Editor

`editor/panels/ParticleEditor.tsx` — a dockable authoring surface for `.particle.json`
effects. Left: a **live WebGPU preview** viewport (`makeWebGPURenderer` + `OrbitControls`, a
grid ground plus an optional opaque floor for soft-particle depth) driving the real
`particleBackend`. Right: property sections (emission / shape / start / over-life / render)
with sub-widgets including a `CurveEditor` (over-life curves) and `GradientEditor` (color
ramps). Top: play / pause / restart / scrub. Every edit calls `backend.setDef` immediately
and seeds the shared particle cache, so a `ParticleEmitter` entity referencing the same
asset in GameView updates too.

### Sprite Editor

`editor/panels/SpriteEditor.tsx` — Unity-style **sprite slicing** for a texture in
"multiple" mode, opened as a modal from the Texture Inspector. It shows the source image on
a zoom/pan canvas with editable slice rects, seeded three ways: a **grid** (by count or by
cell size, with offset/padding), **auto-detect by alpha islands** (threshold slider), or
**hand-drawn** rects (create / move / resize via 8 handles / pivot / rename / delete). It
persists `sprites[]` + `spriteSheet` (and the `spriteGrid` / `spriteAlphaThreshold`
controls) into the texture's `.meta.json`, and live-registers each slice as a `'sprite'`
manifest entry so it can be referenced from `Renderable2D.sprite`. One undo step captures
the full slice set **and** the slicing parameters. See [Materials & Textures](./textures.md).

### SpriteAnim Editor

`editor/panels/SpriteAnimEditor.tsx` — a dockable editor for `.spriteanim.json` assets (a
reusable named set of **flipbook clips**). Left: a live flipbook preview of the active clip.
Right: the clip list + per-clip **fps / mode / cycles** + ordered **frame** rows (sprite
picker, reorder, remove). Each edit re-seeds the shared `spriteAnimCache` so any live
`SpriteAnimator` referencing the asset updates next frame. The "active clip" is local panel
state — the asset is just the clip set (the runtime active clip lives on the
`SpriteAnimator` trait). See [2D skinning](./2d-skinning.md) for the related skin editor.

### Material inspector & preview

The Material inspector (`editor/panels/assetViews/MaterialAssetView.tsx`) edits a `.mat.json`
file: a shader-kind dropdown plus one auto-dispatched **`ParamField`** widget per shader
param — texture ref / color / bool / float / vecN, chosen from the shader schema (a
multi-select shows a non-committal "mixed" placeholder that broadcasts on pick). Unlike the
coalescing asset editors above, each discrete edit persists synchronously via
`persistAssetEdit` (against the file **and** the material cache) and pushes its own undo
entry. Alongside it, `MaterialPreview.tsx` renders the material on a **lit IBL sphere**
(built with the engine's own `buildPreviewMaterial` inside the shared `Preview3DShell`),
rebuilt on any field change so a color/roughness tweak reflects live. The **Mesh**
inspector (`MeshAssetView.tsx`) uses the same shell: `MeshPreview.tsx` loads the shared
mesh template from `meshTemplateCache`, clones the geometry onto a neutral
`MeshStandardMaterial`, and renders it through `Preview3DShell` above the geometry stats —
a single-`.mesh.json` preview distinct from the whole-GLB `ModelPreview`.

## Electron host

The distributed editor is an Electron desktop app (`engine/electron/`). The **main process**
(`main.ts`) hosts the real editor backend (HTTP on `127.0.0.1`) and bridges the renderer to
it over IPC: filesystem/exec routes are served directly, live-ECS ops are forwarded to the
renderer and awaited (`requestRenderer`, backing `/api/scene-state`), the renderer pushes
its trait schema back so validate/mutate can type-check, and a chokidar watcher pushes
hot-reload notifications. The renderer's shell + the open project's code/assets are served by
a **main-owned Vite server** in **both** dev and packaged builds ("run Vite in prod") — only
`/api` is main-hosted. When packaged, `REPO_ROOT` points at `<Resources>/app.asar.unpacked`
(electron-builder `asarUnpack`s `engine/**` + `node_modules/**` to real files because Vite
can't run inside the asar archive).

**Open Project / New Project** (`projects.ts`, `newProject.ts`) drive the workspace: a native
folder picker plus a persisted recent-projects list feed the application menu; opening a
folder **re-roots the backend** to it (`setProject` rebinds the Vite server and runs
`vendorEnginePlugins` + `healNativeConfig`), and New Project scaffolds the starter template
(the same token substitution + fresh-GUID minting as the `scaffold-project.mjs` CLI). Full
build/packaging + self-update detail is in [build.md](./build.md); the overall process model
is in [architecture.md](./architecture.md).

---

## ECS as the source of truth

The editor never holds a parallel scene representation. Panels read and write the live
world (`getCurrentWorld()`); ECS systems run while the editor is open; and React panels
are driven by **projections** (e.g. the UI tree projection, the entity-tree refresh in
Hierarchy) plus the Zustand `editorStore` (`editor/store/editorStore.ts`), which tracks
selection (`selectedEntityId` / `selectedAsset`), gizmo mode/space, GameView size, and
progress-modal state. Saving serializes the world back to `*.scene.json` /
`*.prefab.json` — see [Scene Loading](./scene-loading.md) and [Prefabs](./prefabs.md).

---

## Undo / redo

The command stack lives in `editor/undo/undoManager.ts`. Both `undo()` and `redo()`
are **async** and return `Promise<boolean>`:

```ts
export async function undo(): Promise<boolean> { … }
export async function redo(): Promise<boolean> { … }
```

An `UndoAction`'s `undo`/`redo` may return `void | Promise<void>` — some actions are
async (e.g. prefab instantiation that loads a `*.prefab.json`). **Callers and tests must
`await`** `undo()` / `redo()`; the manager sets an `_executing` guard while running an
action so re-entrant pushes are dropped.

**Selection changes push individual undo entries** — intentionally. `editorStore`'s
`selectEntity` / `selectAsset` call `pushSelectionChange()` so each selection step is
its own visible undo entry. **Do not coalesce selection entries**; the design goal is
that pressing undo walks back through exactly the steps the user took, including what was
selected at each one.

The undo stack is capped at 200 entries (oldest dropped, warned once per session).

---

## Quick reference

| Concern | Where |
| --- | --- |
| Editor shell / docking / layouts | `editor/EditorApp.tsx` |
| Host configuration factory | `editor/createEditor.tsx` |
| Editor state (selection, gizmo) | `editor/store/editorStore.ts` |
| Panels | `editor/panels/` (Hierarchy, Inspector, SceneView, Assets, Console, ModelPreview) |
| Trait registry / Inspector field hints | `runtime/ecs/traitRegistry.ts`, `engine/app/ecs/registerTraits.ts` |
| 3D gizmo | Three.js `TransformControls` (in `SceneView.tsx`) |
| UI / 2D gizmo | `editor/panels/UIResizeOverlay.tsx`, `Gizmo2D.ts` |
| Object picking (3D/2D hit-test) | `editor/panels/picking.ts` |
| 3D collider outline | `runtime/rendering/colliderOutline3D.ts` |
| Play / Stop / Pause | `editor/scene/playMode.ts`, `runtime/systems/playState.ts` |
| Selection restore on world swap | `editor/store/selectionRestore.ts` |
| Console capture | `editor/consoleCapture.ts`, `editor/panels/Console.tsx` |
| Asset editors | `editor/panels/{AnimationEditor,ParticleEditor,SpriteEditor,SpriteAnimEditor}.tsx` |
| Material inspector / preview | `editor/panels/assetViews/MaterialAssetView.tsx`, `editor/panels/MaterialPreview.tsx` |
| Undo / redo | `editor/undo/undoManager.ts` |
| Keyboard shortcuts / focus scope | `editor/input/` — see [editor-input.md](./editor-input.md) |
| Shared 3D sync | `runtime/rendering/scene3DSync.ts` |
| Electron host / Open+New Project | `engine/electron/{main,projects,newProject}.ts` |
