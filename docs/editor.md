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

A named layout is project-local (`.modoki/layouts` is gitignored) — to move a layout to
another project/machine or share it, both directions go through a portable
`<name>.layout.json` FILE (not the project store): *Load Layout…* → *Load from file…*
imports one (parsed, guarded by `isLayoutJson`, then written into the project store under
its derived base name), and both *Save Layout As…* and *Load Layout…* have an *Export to
file…* action that downloads the current/selected layout via a `Blob` + `<a download>`
click (`downloadLayoutJson`, `sanitizeExportFileName` in `editor/utils/layoutNames.ts`).
There is no top-level menu item for export — it's reached through those two modals.

The menu bar (`File` / `Edit` / `View`, plus host-injected menus) is rendered by
`components/MenuBar`. Keyboard: `Cmd/Ctrl+S` → Save All, `Cmd/Ctrl+Z` → undo,
`Cmd/Ctrl+Shift+Z` → redo.

### `createEditor()` — host configuration

`editor/createEditor.tsx` is the factory the host (a game) calls to configure the
editor. It registers the game config, model postprocessors, and game-specific traits,
and stashes custom panels, the Game View component, extra menus, and an optional
**Project Settings** schema for `EditorApp` to pick up. It also kicks off scene loading:
the manifest loads immediately, and the scene load itself no longer waits on any 3D
viewport or renderer existing — a layout with no Scene/Game panel open loads the scene
just fine (see [Scene Loading](./scene-loading.md)). A separate, non-blocking
renderer-health **watchdog** runs alongside it: it reports a definitive renderer-init
failure fast, and warns if no viewport ever begins renderer creation — but only for a
project that actually renders 3D (`build.modules.render3d`, resolved via
`/api/build-modules` since `'auto'` can only be resolved server-side); a 2D/UI-only
project gets no such warning. Suppression covers all three firing points (the 12s
no-viewport message, the 15s soft nudge, the 120s hard cap) and **lifts the moment a
viewport does begin** — a 2D project on which the user opens a Scene panel anyway gets
normal renderer-health reporting. A definitive renderer-init FAILURE is never suppressed:
a viewport that tried and threw is a real error whatever `render3d` says.

### Project Settings — the save contract

`ProjectSettingsDialog` edits the schema `createEditor()` registered; it `GET`s
`/api/project-settings` and `POST`s back. Two rules govern that route
(`editorBackendRouter.ts`), and both exist because breaking them silently corrupted real
projects:

- **The body is a PATCH, deep-merged onto the file ON DISK.** A section you omit is left as
  the file had it — absence never means "reset to default". This matters because the dialog
  posts the *whole* object while `modoki_project_settings action=set` and OtaKeysDialog's
  "sync public key" post a *single* section. The route used to merge onto
  `DEFAULT_PROJECT_CONFIG` instead (`mergeProjectConfig` is the **load-time** resolver, not a
  write-time merge), so every partial caller reset app identity to
  `com.modokiengine.prototype` and blanked `appleTeamId`. Keep the two merges separate:
  `deepMergeConfigPatch` writes, `mergeProjectConfig` reads.
- **`project.config.json` stays MINIMAL** — it records only what the project *chose*;
  everything else resolves from the defaults at load. A save persists
  `pruneProjectConfig(resolved, preEditFile, defaults)`, which keeps a key iff it differs
  from its default **or** was already in the file, and preserves the file's key order so a
  no-op save is a no-op diff. Writing the *resolved* config instead is what once handed an
  internal game `webBucket: "gs://modoki-www-site/demo"`. Note prune measures "already
  recorded" against the **pre-edit** file: pass the patched one and every key is trivially
  present, nothing prunes, and the bug returns for full-object saves.
- **Reading COERCES a bad string-union value; writing ROUND-TRIPS it.** `mergeProjectConfig`
  falls an out-of-union value back to the default and warns, for EVERY string-union field in
  the config — not just `rendering.web.sizeMode` / the three/pixi `backend`s (#39) — so the
  engine renders something a consumer actually handles. But the route resolves with
  `{ coerceUnions: false }`, because the resolved config is what
  gets written. With coercion on, pressing Apply on an unrelated section would silently
  normalize a field the author never touched. That is not a harmless heal: `sizeMode:
  "portrait"` is what revealed `games/sling` was *meant* to be portrait (issue #25) —
  rewriting it to `free` would have erased the only evidence of intent and left a file that
  merely looked correct. The out-of-union value is caught instead by a test over every
  committed `project.config.json`, and reported to the human as `configWarnings` (below).
- **Load coerces; the BUILD REFUSES.** Coercing keeps a typo'd project openable — you cannot fix
  a config you cannot open — but the build is the last moment before the value ships, so there it
  is fatal (`projectConfigUnionErrors`, `plugins/load-project-config.ts`, wired into both SSE
  build gates). It is a SEPARATE pass on the raw file, deliberately: `validateBuildConfig` sees
  the already-RESOLVED config, where the bad value has been coerced away and is no longer there
  to complain about. Not wired into the settings-save route, which round-trips out-of-union
  values on purpose (`coerceUnions:false`).
- **A vocabulary is declared ONCE, in `engine/project-config.ts`.** Each string union is an
  exported `as const` tuple (`ORIENTATIONS`, `TONE_MAPPINGS`, `WEB_DEPLOY_MODES`, …) that both
  the validator and the Project Settings dropdowns read — the dialog used to restate all ten
  option lists by hand, so the two could silently disagree. Label-carrying selects pair the
  tuple with a `Record<T, string>` label map, which makes adding a member without a label a
  compile error; for the fields still typed as narrow unions, widening the tuple without
  widening the `ProjectConfig` type is a compile error too. **Add a union member in one place
  and the build tells you the other places.**

Two refusals, both surfaced in the dialog as a red banner (the dialog stays open with the
draft intact, so the offending value can be fixed in place):

| Refusal | Why |
|---|---|
| A `null` anywhere in the patch → 400 naming the dot-paths | No config field is nullable. Persisting it poisons a typed field; dropping it would report success for an edit that did nothing. Use `""` / `false` / `0` to clear. |
| The config file exists but is not valid JSON → 400 | The raw read is the base a patch merges onto, so the loaders' forgiving "treat as defaults" fallback would replace a hand-edited file with just the section being saved. Reading stays forgiving; **writing refuses**. |

**The GET says when it fell back**, because the two halves of that last row disagree on
purpose and the gap was visible to a human. Reading a malformed config is forgiving while
writing refuses — each right alone, but together they put the dialog in a state where every
field was a plausible-looking lie: measured on `games/sling`, a one-character JSON typo made
Bundle ID read `com.modokiengine.prototype` and App name "Puzzle Prototype" — the identity
that project retired — with nothing on screen saying so, and the truth reachable only by
pressing Apply. The save refusal bounds the damage to *display*; it does not prevent someone
reading those fields, believing them, and acting on them.

So GET also returns `configErrors: [{file, message}]` (from `readProjectConfigParseErrors`),
**omitted entirely** when both files parse — the healthy response is unchanged. The dialog
shows it as a banner and makes the form inert; tab switching stays live, since reading around
is fine and editing a lie is not. Two rules that are easy to get wrong:

- **The banner names the FILE, not the screen.** `project.config.json` and `project.user.json`
  define different fields, so only the latter failing leaves app identity perfectly real —
  claiming "these are all defaults" there would be the same overclaim the banner exists to
  fix. (Editing is still disabled wholesale, because one Apply writes both.)
- **`configErrors` is a diagnostic, not a section.** The POST drops it before the
  unknown-section check, since the dialog posts back the whole object it loaded.

**`configWarnings` is the same diagnostic one notch down** — the file *parsed*, but a field
holds a value no consumer handles, so the resolved config substituted a default
(`projectConfigIssues`, same union table as the coercion). It exists because coercing traded
one invisible problem for another: before it, `sizeMode: "portrait"` showed as an unmatched
**blank** in the dropdown — odd enough to notice; after it, the dropdown reads "Free" and
looks perfectly correct while the file still says `portrait`, and the write path deliberately
keeps the file's word, so the two disagree indefinitely. Differences from `configErrors`:
editing stays **enabled** (the rest of the values are the project's real ones, and the repair
is usually to pick the right entry in the very dropdown being warned about), the banner states
that saving other settings will *not* rewrite the value, and it is suppressed when
`project.config.json` itself failed to parse — that resolves to *pure* defaults, so blaming a
specific field would be a lie. A malformed `project.user.json` does **not** suppress it.

`validateBuildConfig` still runs against the **resolved** config, so a partial patch cannot
smuggle a shell metacharacter past a rule by omitting the field next to it. Nothing is
written on any refusal. Caveat: `postprocessors` is a map, so a patch can add or update an
entry but never delete one; and unknown *top-level* keys are dropped by `mergeProjectConfig`'s
explicit key list (unknown keys nested inside a declared section survive).

---

## Panels

### A new dropdown in editor chrome must be DOM, not a native `<select>` (#149)

A native `<select>` renders its popup in a separate OS layer that `sendInputEvent` cannot reach —
`docs/debug-tools-mcp.md` already lists it among the things trusted input needs an opener tool to
work around. So a `<select>` added to editor chrome is a control **neither the agent surface nor the
Playwright specs can open**, and since the agent owns live verification of this surface (nobody else
drives it), that means it ships unverified.

Build the affordance out of ordinary DOM instead: a `role="combobox"` button plus a `role="listbox"`
of `role="option"` rows, closing on Escape and outside-click, each row carrying a stable
`data-testid` to aim at. The AI panel's device picker (`DeviceConnectSection.tsx`) is the worked
example — it looks and behaves like a pull-down and is fully drivable by `modoki_tap {selector}`.

This applies to NEW chrome. The existing `<select>`s (Inspector enum fields, device presets) are not
worth a sweep on their own; convert one when you are already changing it and it blocks a check.

### Where a panel's LOGIC belongs (and what is tested)

A panel `.tsx` holds JSX, hooks and imperative wiring. **Its decisions belong in a
plain `.ts` module beside it, and that module is where the tests go** — never a jsdom
mount of the panel, which asserts the mock. The split is three layers: the `.tsx`
keeps the DOM wiring, the `.ts` holds the decision as a pure function, and one e2e
spec covers the real browser gesture.

Measured (2026-08-04, `npm run coverage`): editor `.ts` is **79.8%** line-covered against
editor `.tsx` at **12.9%**. Six large panels are at literal 0% — `SceneView` (2,304 lines),
`Assets` (781), `AnimationEditor` (469), `EditorApp` (393 — 451 before #126),
`ParticleEditor` (317), `TimelineEditor` (258). That gap is the strategy working, not
failing: extraction moves decisions somewhere testable and leaves the JSX behind.

The three that are *not* at zero — `SkinCanvas` 6.2%, `SkinEditor` 7.25%, `SpriteEditor`
7.63% — are the ones whose already-pure helpers were exported and tested in place (see
below). Exporting from a `.tsx` raises that `.tsx`'s own number; extracting *out* of one
does not. Neither figure is a target.

Extracted decision modules:

| module | what it decides |
|---|---|
| `panels/assetListing.ts` | Assets filtering, sprite/type grouping, the visible-order walk that drives keyboard nav |
| `panels/assetKeyCommands.ts` | every Assets keystroke → a command (platform-dependent delete chord, type-ahead) |
| `panels/assetSelection.ts` | Assets click + drag selection policy |
| `panels/assetOps.ts` | import/re-import planning, the delete sidecar rule, rename validation |
| `panels/skinParts.ts` | rig part geometry + `bboxCenter` |
| `scene/marqueeSelect.ts` | SceneView 2D box-selection: threshold, enclosure, selection merge |
| `scene/pickSelection.ts` | the shared 2D + 3D viewport pick rule |
| `scene/multiTransform.ts` | group-transform math, incl. which Transform fields each gizmo mode writes |
| `utils/layoutStore.ts` | layout persistence — the restore precedence ladder, corrupt-layout self-heal, stale-tab retitling, the Load-Layout ordering rule |
| `utils/layoutNames.ts` | layout name sanitising + the reserved autosave name |

All are unit-tested, but "has a test file" is not "is covered": `assetOps.ts` sits at 56%
(the rest is `/api/*` IO wrappers) and `skinParts.ts` at 58% (4 exports no test executes).
Check `npm run coverage` rather than the presence of a test file.

Some panel logic is **already pure and at module scope but not exported**, so nothing
can import it and nothing tests it (SkinCanvas's skinning math, SpriteEditor's slice
geometry). Exporting it is the cheapest coverage in the editor: no refactor, so no
behaviour risk. Prefer it over restructuring a component.

**Two traps this work hit, both worth knowing before you add a panel helper:**

1. **Duplicated private helpers — and deleting the original is NOT enough.** `.rig2d.json`
   bone coercion existed in **four** places: `SkinEditor`, `SkinCanvas`, `scene/skinPrefab.ts`,
   and inline in `runtime/skinning/rig2dTypes.ts`. The first pass unified two and declared
   the class closed; a body-identity sweep found the rest, and the runtime's copy had
   **already diverged** (it coerced numerically and preserved `noScale`; the editor's three
   did neither). Testing one copy while others survive is the failure mode that makes this
   work negative-value. So: look for a twin before writing a panel-local helper, put the one
   copy in the layer that **owns the format** rather than in an editor-local module, and
   **sweep the whole layer before claiming a duplication is resolved** — a scan for identical
   top-level function bodies across `editor/**` takes a minute. (Same shape, different empty
   case: `centerOfVerts`/`centerOf` → `skinParts.bboxCenter`, where the divergence was
   meaningful and was preserved at the call sites instead of flattened.)
2. **Not every panel yields to extraction.** SceneView is ~2,300 lines of *event
   orchestration* — state spanning `pointerdown`/`move`/`up`, `stopPropagation`,
   imperative renderer calls — and three seams moved only seven executable lines out
   of it, where a similar effort on `Assets.tsx` moved 76. Extracting orchestration
   re-expresses control flow, which is where behaviour quietly changes. "Honestly
   untestable without an integration harness" is an acceptable answer for parts of
   SceneView and `EditorApp.tsx`.

**The `EditorApp.tsx` verdict (#126), for the record — it was NOT "no".** The plan expected
the editor shell to be the hardest case and allowed the phase to end in a written decline.
It did not need to. `EditorApp.tsx` sat at 0/451 lines, but ~58 of those were the
**layout-persistence block: already pure, already at module scope, merely unexported** — the
cheap category, not the SceneView one. Moved verbatim to `utils/layoutStore.ts` (34 tests,
100% covered), which is the same move `utils/layoutNames.ts` made earlier for the same reason.
The measurement that settles the argument: those two modules sit at 100% while the `.tsx` they
came out of sits at 0.

Two signature changes were needed and both are dependency injection, not redesign:
`panelLabel(id, customPanels)` takes the custom-panel list instead of calling
`getCustomPanels()` (importing `createEditor` into `utils/` would drag the whole editor back
in, defeating the move), and `resetLayout` split into a testable `clearStoredLayout()` plus the
`window.location.reload()` that stays in the component.

**What genuinely remains untestable there is the other ~393 lines, and the reason is
structural**: they are one 650-line React component plus six modal components — 34 hooks, the
menu tree built from live callbacks, the Electron OS-menu bridge, project open/close, HMR-epoch
wiring. There is no decision in it that is separable from the hook that owns its state; every
candidate is orchestration, which is the Phase-2 shape. That part needs an integration harness,
and one e2e spec is the honest coverage for it — which the suite already has.

**The transferable lesson**: before declaring a `.tsx` untestable, grep it for module-scope
`function`/`const` declarations that take no hooks. "Most Electron-entangled panel in the
editor" was true of `EditorApp.tsx` as a whole and false of a seventh of it, and the plan's
prediction was made from the file's reputation rather than from reading it.

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
  [Materials & Textures](./textures.md). Right-clicking a folder (folder view), a
  category header (category view), or empty background in either view opens a **Create**
  menu (New Folder, Create Scene/Material/Animation/Animset/Sprite Animation/2D Rig/
  Particle/Atlas, …) driven by the **creatable-asset registry**
  (`editor/panels/creatableAssets.ts`): `registerCreatableAsset({ id, label, ext,
  defaultName, assetType, body, onCreated, … })` adds an entry (idempotent by `id`);
  `getCreatableAssets()` — read live at menu-open time — supplies the menu. Engine
  built-ins register once via `registerBuiltinCreatableAssets()`
  (`editor/panels/builtinCreatableAssets.ts`, called from `createEditor()`); a game adds
  its own from `GameDefinition.registerEditorBindings` (see the Editor Panels section
  below and `games/sling/editor/creatables.ts`, which contributes "Create Level" /
  "Create Wave"). The bottom of the panel hosts a **Scripts**
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

#### Multi-select gizmo

When more than one entity is selected, the gizmo transforms the whole group together — Unity
conventions, in **both** the 3D (`TransformControls`) and 2D (Canvas `Gizmo2D`) viewports. The
group math is a single pure module, `editor/scene/multiTransform.ts` (headless-unit-tested in
`tests/editor/multiTransform.test.ts`), so the two viewports drive identical logic.

- **Two toggles.** Local/Global (`gizmoSpace`, shortcut **X**) sets the axis orientation.
  Pivot/Center (`gizmoPivot`, shortcut **Z**, dimmed for single-select) sets **where the single
  rotate/scale pivot sits** — `center` = the selection centroid; `pivot` = the active
  (last-selected) entity's origin. **Both modes rotate/scale the group RIGIDLY around that one
  point** (the member at the pivot stays put, the rest orbit/spread) — there is no "spin each in
  place" mode; the pure math takes no pivot-mode flag, only the pivot *position* differs. Move
  translates every member by the same delta either way. Default is **Pivot + Global** (Unity's).
- **Descendant filtering** (`filterOutDescendants`) drops a selected child of a selected parent so
  each transform is applied once (the child rides its parent).
- **3D** attaches `TransformControls` to an empty pivot *proxy* parked at the pivot; the drag delta
  (`pivotNow · pivotStart⁻¹`) is applied to every member's world matrix, then converted back to each
  local `Transform` via `worldToLocalTransform`. **Rotate/scale write POSITION as well as
  rotation/scale** — the group orbit/spread moves member positions (unlike a single-entity gizmo).
- **2D** drives a *virtual* gizmo at the pivot to derive the drag's world delta, then applies it
  around the pivot via `applyGroupTransform2D`. Center frames the whole selection; Pivot draws a
  normal single-entity-sized box on the active entity. The pivot point, its orientation, and the
  framing box are resolved by the pure `resolveGroupPivot2D` (`multiTransform.ts`, unit-tested) —
  Local space orients the group gizmo's axes by the active member's world `rz` (mirroring the 3D
  proxy's `groupProxy.rotation`); a fix, since it originally shipped hardcoded to world-aligned
  regardless of the Local/Global toggle. Pivot mode falls back to Center framing when the active
  entity isn't actually part of the group (filtered out as a descendant, or a different canvas).
- **Marquee** — Shift + left-drag on empty space draws a rubber-band box that ADDS every enclosed
  entity to the selection (plain left-drag still orbits/pans; orbit is suppressed only for the
  shift-drag). Both viewports. Shift/Ctrl-click also add/toggle, mirroring the Hierarchy panel.
- **Undo** — one group drag is a single batched step (`buildGroupTransformUndoAction`) covering
  every member. Because undo/redo write traits via a direct `entity.set` (no dirty broadcast), the
  2D overlay AND the Pixi content are both explicitly re-woken on undo (`subscribeUndo` →
  `mark2DDirty` + `editorMarkScene2DDirty`), else a reverted 2D transform shows stale until refocus.
- **Selection state was already array-based** (`selectedEntityIds` + primary `selectedEntityId`) —
  this feature was purely SceneView-viewport wiring; the store, Inspector, Hierarchy, and selection
  undo already supported multi-select.

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

### 3D collider outline overlay + collider-only mode

When a `Collider3D` entity is selected in 3D mode, SceneView draws a **green wireframe**
(`0x2ecc71` `LineSegments`) of the collider shape, built by the pure builder
`runtime/rendering/colliderOutline3D.ts` (`colliderWireframeGeometry` +
`colliderOutlineSig3D` change-detection, rebuilt only when the shape/dims signature
changes). The toolbar's **View ▾ → Colliders** checkbox (`ViewOptionsMenu.tsx`) additionally
outlines EVERY `Collider3D` in **purple** (`0x9b59b6`) and hides regular mesh rendering
entirely (`shouldHideMeshesForColliderMode`, `sceneViewMath.ts`) — a collider-only debug view.
Primitive shapes (`box`/`sphere`/`cylinder`/`cone`/`capsule`) are built at their absolute
collider dims, then the wire's `.scale` is set by `colliderWorldScale3D` to MATCH how
`physics3DSystem`'s `makeColliderDesc` scales the live Rapier collider — box per-axis;
sphere/capsule/cylinder/cone by mean radius (they can't represent a non-uniform scale as an
ellipsoid) — so a scaled floor/wall's wireframe reads at its true simulated size instead of a
fixed unscaled box. Mesh shapes (`convex`/`trimesh`) edge the resolved mesh geometry, which
already bakes world scale, so their wire scale is taken directly from world scale. Only the
selected entity's wire is kept outside collider-only mode; wires are disposed on deselect
(or all of them, on a switch to UI mode). For the 2D SceneView's own collider-only mode
(**View ▾ → Colliders**, hides sprites instead of meshes) and the 2D collider
**vertex-editing** overlay (the "Points" toolbar mode), see [physics-2d.md](./physics-2d.md).

---

## GameView

The **Game** tab renders the host-supplied GameView component: a live preview of the
running game with selectable **device presets**. Unlike SceneView, it composites all
three rendering layers — `3d` (Three.js), `2d` (PixiJS), and `ui` (the DOM
`UIRenderer`) — exactly as they appear on device. See [Architecture](./architecture.md)
for the layer model.

---

## Play / Stop / Pause

The editor drives a global three-state play mode (`runtime/core/playState.ts`:
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
[debug-tools-mcp.md](./debug-tools-mcp.md) "Percept").

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

### The asset Inspector — two rules that have each failed three times

The Inspector's asset view (`Inspector.tsx`) is the door to everything above: it renders a
per-kind branch, and for any kind it does not recognise it prints "No actions for `<type>`
assets". Both halves of that sentence have gone wrong repeatedly, in ways nothing failed on,
so both are now enforced rather than remembered.

**1. Every `AssetType` gets an action.** The recognised-kinds list used to be a string array
written inline in the JSX, kept in step with the branches above it by hand. It drifted three
times — `video` and `timeline` each shipped a working backend and editor with no Inspector
entry at all, and `shader` drifted the other way, rendering `ShaderAssetView` *and* a cheerful
"No actions for shader assets" underneath it. Every instance was found by a human reading the
type union, never by a test. So `AssetType` is now **derived from the runtime `ASSET_TYPES`
array** (`runtime/loaders/assetManifest.ts`) — making the set enumerable is the whole point —
and the list lives in `assetViews/assetActions.ts` as `ASSET_TYPES_WITH_ACTIONS`, beside the
views where a unit test can import it without mounting a panel.
`packages/modoki/tests/editor/assetInspectorCoverage.test.ts` pins the two against each other
**in both directions**; only one direction shows up as an empty panel, which is exactly why
the shader case survived a sweep that was looking for empty panels.

**2. A preset `<select>` must splice in the value it is bound to.** An HTML `<select>` whose
`value` matches none of its `<option>`s does not render empty and does not warn — it displays
its **first** option. A `.meta.json` holding a legal but non-preset number therefore renders
as a *different* setting than the asset has, with nothing in the UI to say so (measured:
`video.quality: 24`, an ordinary CRF, displaying as "18 — near-lossless"). Wrap the list in
**`withCurrentValue(list, boundValue)`** (`assetViews/importSettingOptions.ts`), which splices
the bound value in and keeps it editable — the tempting alternative, snapping to the nearest
preset, silently rewrites an authored file. Skip the splice only while a multi-select is
showing its "mixed" placeholder, where there is no single value to be honest about.

The second rule is guarded **statically**, and the reason is worth keeping: the helper was
already written, correct and unit-tested when the fix was declared done against the two views
that had been reported. A close-out sweep then found **seven** more unspliced numeric selects
— atlas page size, model texture max-size and UASTC level, three font controls, and a *second*
UASTC select in the very file the fix had just edited. Testing a helper proves nothing about
its call sites, and the call sites are where every instance of this bug has lived. So
`tests/architecture/importSettingSelectsSpliced.test.ts` requires every option-producing
`.map()` under `assetViews/**` to either splice or name itself in a documented exemption list
(the exemptions are all string-valued or dynamically-built lists).

Complementary, not redundant: `tests/assets/importSettingsOptions.test.ts` separately asserts
every import-setting **default** appears in its own option list. Splicing can never reveal a
bad default — a spliced default looks perfectly correct in the dropdown.

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
- **Architecture** — the edit logic is pure functions in `animation/recording.ts` /
  `animation/clipEdits.ts` (`planPaste`, `extractKeyBlock`, `applyBreakUnify`,
  `remapSelectionAfterRemoval/Reorder/Delete`, `groupSelection`), not component closures —
  keeps `AnimationEditor.tsx` a thin store-wiring shell and makes the edit logic unit-testable
  without mounting the panel. `trackKey(t)` (`path|trait|field`) is the single source of truth
  for track identity, exported from `recording.ts` and used everywhere a copy/paste/React-key
  needs to match a track. `useTimelineViewport` owns the shared X-axis wheel-zoom/right-drag-pan
  plumbing for Dopesheet + Curves. The playhead subscription is isolated to a small memoized
  overlay leaf so the 60fps scrub/preview loop doesn't re-render the whole panel.

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

Both the recents list and the folder picker's starting directory are scoped **per editor
identity** (`recentsScope` — install path when packaged, repo root in dev; set once at startup
via `setRecentsScope`), not shared machine-wide: each dev clone (see the Clones section in the
root `CLAUDE.md`) gets its own recents file AND remembers its own last-used Open/New Project
folder (`pickProjectFolder`/`pickNewProjectFolder` pass `defaultPath` from, and persist to, a
`<identity-hash>-last-folders.json` next to the scoped recents file). This exists because the
OS-native picker's own "last folder" memory is keyed by app bundle id, which several unpackaged
dev clones share — without this, opening a project in one clone would silently seed the starting
folder for a sibling clone's picker.

### Launching into a named scene (`--scene`)

The editor remembers the last scene per project, and until #43 nothing could override it at
launch — a project could be forced (`launch-editor.sh games/sling`, or `MODOKI_PROJECT`), a
scene could not. The only lever was renderer-side `localStorage`, which a launching process
cannot write. That made "launch and look" depend on the launcher's history rather than on the
command, and cost an agent an extra round trip plus a window where measurements came from the
wrong scene.

```bash
engine/scripts/launch-editor.sh games/sling --scene Level-0002          # by NAME
engine/scripts/launch-editor.sh games/sling --scene assets/scenes/x.json # by PATH
```

`--scene=<v>` works too, and the flag may sit anywhere in the arg list — it is stripped before
the bare project-dir positional is read. A **valueless** `--scene` exits 2 with a message; it
used to reach `shift 2` with one arg left, which under `set -e` killed the launcher with no
output at all. The value crosses launcher → Electron main as **`MODOKI_SCENE`** (env, because
that hop is a spawn — same carrier as `MODOKI_PROJECT`), and main serves it to the renderer at
**`GET /api/boot-scene`**. Deliberately not a field on `/api/identity`: that route is the
"which editor am I talking to?" diagnostic, and a boot instruction is not a fact about identity.

Four decisions worth knowing, because each has a wrong-looking alternative:

- **Precedence mirrors the project's**: override → stored last-scene → `config.scenePath`. The
  override is *prepended to* the candidate list, never substituted for it, so it inherits
  `loadFirstScene`'s existing 404 self-heal — a typo degrades to the remembered scene instead
  of booting a blank world.
- **A name or a path.** `resolveSceneCandidates` speaks paths, but `--scene Level-0002` is what
  gets typed. A value containing `/` or ending `.json` is used as-is; anything else is matched
  case-insensitively against the manifest's scene basenames. **An ambiguous name is refused**,
  not first-matched — the same rule `{name}` entity addressing follows — and both the no-match
  and ambiguous cases `console.warn` with the available scenes before falling through.
- **It does NOT overwrite the remembered scene.** A one-off agent launch must not change where
  the human's next bare launch lands, so the `localStorage` write is skipped when the override
  supplied the loaded scene. If the override *missed* and boot fell through, the normal write
  still happens. A later manual scene load by the human persists as usual.
- **Sticky, not one-shot.** `/api/boot-scene` keeps answering for the process lifetime, so a
  Fast-Refresh/HMR reload stays in the overridden scene rather than silently snapping back.
  "This editor instance was launched into X" is the predictable reading.

### Port selection (and why a free-looking port may not be)

Two ports are chosen at startup, on different contracts. The **backend** port is the MCP
target, so an explicit `MODOKI_BACKEND_PORT` **fails loudly** when taken rather than drifting
to one no MCP client could find (E6); without it the port is sticky — last-bound, then 5179,
then a deterministic scan. The **Vite** port is only a preference and falls back to an
ephemeral one, which is what lets a second editor start at all.

**Per-clone lanes.** Several clones share one machine (see the Clones section in the root
`CLAUDE.md`), so `launch-editor.sh` derives both other ports from the pinned backend —
Vite `5173 + (backend − 5179)`, CDP `9222 + (backend − 5179)`. One anchor, no extra flags,
and no two clones aiming at the same port. Without it every clone *preferred* 5173, only the
first to launch got it, and the rest landed on unpredictable ephemeral ports — which also made
the documented `localhost:5173/#/editor` true for exactly one clone.

The launcher passes this as **`MODOKI_VITE_PORT`**, which seeds the preference and keeps the
ephemeral fallback. That is deliberately *not* `MODOKI_DEV_URL`: setting `MODOKI_DEV_URL` makes
main skip `findFreePort` entirely and pin that exact origin, so a clash there is fatal. Use it
only when you mean "this exact server". Because the derived port can still lose a race, the
launch banner reports the port Vite ACTUALLY bound, flagging the difference
(`Editor page: … (wanted 5173 — it was taken)`) rather than echoing what it asked for.

Deciding "is this port free" is subtler than it looks, and getting it wrong is how one clone
ends up serving another clone's project. Node sets `SO_REUSEADDR` on every `net.Server`, and
that lets a bind succeed *alongside* an existing bind on a different address — so a single
probe is not a free/busy oracle. Measured (rows = who holds the port, columns = what a probe
reports):

| held | probe `0.0.0.0` | probe `127.0.0.1` | probe `::1` |
|---|---|---|---|
| `0.0.0.0` | EADDRINUSE | free | free |
| `127.0.0.1` | free | EADDRINUSE | free |
| `::` | EADDRINUSE | free | free |
| `::1` | free | free | EADDRINUSE |

**There is no single address that sees every clash.** `findFreePort` therefore probes all of
them (`PROBE_HOSTS`, `devServer.ts`) and calls a port free only when every probe agrees; a
non-`EADDRINUSE` error (no IPv6 stack, a sandbox refusing the wildcard) counts as *no evidence*
rather than a clash. Probing only loopback — the pre-#67 behaviour — is blind to a sibling
clone's `vite --host 0.0.0.0`; probing only the wildcard would be blind to our own
`--host 127.0.0.1` Vite, the more common clash.

**Test harnesses derive theirs the same way.** Anything that binds a fixed port assumes it is
the only clone on the machine, so the e2e suite and the packaged harnesses all derive from the
repo path through the one implementation in `engine/scripts/clonePort.mjs` (a `.mjs` with a
`.d.mts` sidecar so the TypeScript Playwright config and the bash harnesses share an algorithm
rather than keeping two copies of the hash):

| Harness | Block | Override |
|---|---|---|
| Playwright e2e (`playwright.config.ts`) | 38173 + 0..199 | `MODOKI_E2E_PORT` |
| `smoke-packaged.sh` | 38600 + 0..199 | `SMOKE_BACKEND_PORT` |
| `assert-app-renders.sh` | 38900 + 0..199 | `RENDER_BACKEND_PORT` |

Keep the blocks wide. A tight range is the tempting simplification and it is wrong: 10 slots was
tried for the packaged harnesses and immediately mapped two real clones to the same port
(birthday problem — ~30% for four clones in ten slots), which is a per-clone scheme that isn't.
`assert-app-renders.sh` previously hardcoded **5179**, the main clone's own editor backend port,
so it could not run while your editor was up.

A correct probe still isn't proof of ownership, so there is a second guard: `waitForServer`
re-checks that our own Vite child is alive **after** a positive reachability probe. Reachable
only means *something* answered — and if our Vite has meanwhile exited on a `--strictPort`
clash, that something is a foreign server. Adopting it used to surface much later as a baffling
"the dev server can't serve code outside its allowed roots" naming a path that plainly exists,
because the roots being enforced belonged to the *other* clone. It now fails immediately and
says so.

### The launch log — who started which editor

`launch-editor.sh` appends every launch to **`~/.modoki/editor-launches.log`**
(`MODOKI_LAUNCH_LOG` overrides). It lives outside the repo on purpose: the question it answers
is a *cross-clone* one — "whose editor is on this port?", "who is holding 5173?" — and a
per-clone log cannot see the sibling that caused the collision.

```
2026-08-01T04:03:41Z  START  modoki (main)  pid=83473
  cmd:   engine/scripts/launch-editor.sh games/court
  want:  backend=5179 vite=5173 cdp=9222
  ready: backend=5179 vite=65018 cdp=9222  page=http://127.0.0.1:65018/#/editor
2026-08-01T04:04:06Z  EXIT   modoki (main)  pid=83473
```

Three things make it worth reading rather than just writing:

- **`cmd:` is reproducible.** The shell does not preserve a caller's `VAR=x cmd` prefix, so the
  line is rebuilt from a snapshot taken *before* the launcher exports its own derived values —
  only pins you actually typed appear, so it can be copy-pasted.
- **`want:` and `ready:` are separate** because the Vite port is a preference, not a pin. Above,
  5173 was taken by a sibling clone and the editor landed on 65018; a log that recorded only the
  request would send you to an editor that isn't there.
- **A `START` with no `EXIT` means that editor is still up — or leaked.** A background waiter
  outlives the launcher to write the `EXIT` line, so the pairing is the liveness signal.

Logging is best-effort throughout: it must never take down a launch.

### Stopping an editor

`npm run editor:stop` (`engine/scripts/stop-editor.sh`) is the counterpart to the launcher. It
SIGTERMs this clone's Electron main process first — the editor owns the Vite it spawned and
stops it on quit, so quitting the app is what produces a clean teardown *and* lets the launch
log's background waiter write its `EXIT` line. A straggler Vite is swept only if the editor died
uncleanly. Every match is anchored to this repo's absolute paths, so a sibling clone's editor is
never touched (#69); the matcher itself is shared with the launcher in
`engine/scripts/lib/repo-reap.sh`.

Two things that look like they should stop an editor and do not (#129):

- **`npm run dev:stop`** is for a standalone `npm run dev`. It used to kill the editor's Vite as
  well — leaving the app window up with a dead dev server behind it, which presents as *"the game
  is broken"* rather than *"something was stopped"*, and once cost a debugging session chasing a
  phantom game bug. It now identifies an editor-owned Vite by the `--configLoader runner` flag
  `devServer.ts` passes, skips it, and says so. (Guarded by
  `engine/tests/architecture/devStopEditorCarveOut.test.ts`, because that flag exists for a
  packaging reason and nothing else would notice if it went away.)
- **`POST <backend>/api/exit`** 404s. `/api/exit` is a *Vite dev-server* route, so it answers on
  the Vite port (5175), not on the backend port that `MODOKI_BACKEND` and the launch banner
  advertise — aiming it at the port you were told to use cannot work.

### UI Zoom (VS Code–style)

App-wide UI zoom via Electron `webContents` zoom (`engine/electron/zoom.ts`) — Cmd/Ctrl+wheel
anywhere in the editor, Cmd/Ctrl+`=`/`-`/`0`, and native **View → Zoom In/Out/Actual Size** menu
items (`projects.ts`'s `viewRoleTail`), all routed through one controller so wheel/menu/accelerator
stay in sync. `factor = 1.2^level`, step 0.5, clamped to level ∈ [−3, +4] (matches VS Code). The
level persists per editor identity (`userData/ui-prefs.json`) and restores on `did-finish-load`. A
capture-phase Ctrl/Cmd+wheel forwarder in `EditorApp.tsx` (`editor/input/zoomWheel.ts`) pre-empts
panels that also consume modified wheel (SceneView camera dolly, the Animation Curve Editor's
value-axis zoom) via a `data-modki-wheel-zoom` opt-out marker, so UI zoom and panel-local zoom don't
double-fire.

Zoom changes the DOM's zoomed-CSS coordinate space, which mattered for trusted input — see
[debug-tools-mcp.md](./debug-tools-mcp.md) for the coordinate-space contract and
[input.md](./input.md) for the presentation-invariant gameplay-input split it also motivated.

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
| Multi-select group-gizmo math (3D + 2D) | `editor/scene/multiTransform.ts` |
| Object picking (3D/2D hit-test) | `editor/panels/picking.ts` |
| 3D collider outline | `runtime/rendering/colliderOutline3D.ts` |
| Play / Stop / Pause | `editor/scene/playMode.ts`, `runtime/core/playState.ts` |
| Selection restore on world swap | `editor/store/selectionRestore.ts` |
| Console capture | `editor/consoleCapture.ts`, `editor/panels/Console.tsx` |
| Asset editors | `editor/panels/{AnimationEditor,ParticleEditor,SpriteEditor,SpriteAnimEditor}.tsx` |
| Material inspector / preview | `editor/panels/assetViews/MaterialAssetView.tsx`, `editor/panels/MaterialPreview.tsx` |
| Undo / redo | `editor/undo/undoManager.ts` |
| Keyboard shortcuts / focus scope | `editor/input/` — see [editor-input.md](./editor-input.md) |
| Shared 3D sync | `runtime/rendering/scene3DSync.ts` |
| Electron host / Open+New Project | `engine/electron/{main,projects,newProject}.ts` |
