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
resizable, Unity-style tabbed panels. The default layout is three columns: the
viewports on the left (Game above a Scene tabset that also hosts the Particle
Editor / Sprite Animation / 2D Skin editors, with Console/Animation/Timeline
beneath), then Hierarchy over Assets, then Inspector over AI. It is a capture of
the owner's working arrangement, so the retargeting asset editors are docked from
the start rather than opened on demand — they show a placeholder until something
is selected. They cost nothing at boot: FlexLayout's `tabEnableRenderOnDemand`
defaults to **true** and nothing overrides it, so a tab's component is not mounted
until its tab is first shown — only the visible tab of each tabset (Game, Scene,
Console, Hierarchy, Assets, Inspector, AI) mounts on load.

⚠️ That is what makes the column *weights* safe to read literally: they are 55/15/15
and do **not** sum to 100. FlexLayout normalizes a row's weights against their sum,
so the proportions are what matters, not the total. Don't "fix" them to 100 — that
would silently rescale the columns.

Layout state is persisted two ways:

- **Working state** auto-saves (debounced) BOTH to `localStorage` under `editor-layout`
  **and** to a reserved server-side layout named `autosave` — the recovery point the Load
  Layout dialog pins as *"Last session (auto-saved)"*.
- **Named layouts** are written as `<name>.layout.json` files under
  `<project>/.modoki/layouts` via the backend's `/api/layout` POST endpoint
  (listed via `/api/layouts` GET) (File → *Save Layout As…* / *Load Layout…*). The tracked file path is stored in
  `localStorage` so the association survives a reload.

On startup `loadInitialModel()` ranks **tracked file → autosave → localStorage mirror →
built-in default**. The autosave tier is easy to forget and is load-bearing: it sits ABOVE
the mirror, so clearing the two `localStorage` keys does not get you the default.

*Reset Layout* therefore does not work by deletion. It clears the two keys, arms a one-shot
`sessionStorage` marker (`editor-layout-reset`), and reloads; `loadInitialModel()` consults
that marker first and skips every restore tier for exactly that one **load** (live
Three.js/Pixi viewports don't tear down cleanly on an in-place model swap, hence the reload).
Deleting the autosave instead would destroy the recovery point, and doing nothing about it was
QA-EDITOR-0004: once any panel had moved, *Reset Layout* restored the very layout being reset.

⚠️ One-shot per **load**, not per call, and that distinction is load-bearing. `main.tsx` wraps
the app in `<StrictMode>`, so in dev React runs `EditorApp`'s init effect, discards it, and runs
it again — two `loadInitialModel()` calls per page load, and the SECOND is the one that renders.
A plain read-and-clear was consumed by the discarded first call, which put the bug straight back
in every `npm run dev` session. `takeLayoutResetFlag()` clears the marker on its first read but
keeps answering from a module-level memo for the rest of that load.

A named layout is project-local (`.modoki/layouts` is gitignored) — to move a layout to
another project/machine or share it, both directions go through a portable
`<name>.layout.json` FILE (not the project store): *Load Layout…* → *Load from file…*
imports one (parsed, guarded by `isLayoutJson`, then written into the project store under
its derived base name), and both *Save Layout As…* and *Load Layout…* have an *Export to
file…* action that downloads the current/selected layout via a `Blob` + `<a download>`
click (`downloadLayoutJson` in `editor/utils/layoutStore.ts`, `sanitizeExportFileName` in
`editor/utils/layoutNames.ts`).
There is no top-level menu item for export — it's reached through those two modals.

The menu bar (`File` / `Edit` / `View`, plus host-injected menus) is rendered by
`components/MenuBar`. Keyboard: `Cmd/Ctrl+S` → Save All, `Cmd/Ctrl+Z` → undo,
`Cmd/Ctrl+Shift+Z` → redo.

⚠️ **"Save Layout" covers only the panel ARRANGEMENT above — not other session options** (#399).
Toggles like Mute Audio, GameView's Show Colliders, SceneView's View ▾ menu (Grid/Colliders/
layers), the Particle Editor's ground-plane toggle, and particle preview, and the gizmo
mode/space/pivot, are separate `localStorage` keys (`editor:gizmoMode`, `editor:sceneViewOptions`,
`editor/rendering/gameViewPrefs.ts`'s `editor:gameViewMuted`/`editor:gameViewShowColliders`,
`editor/panels/particleEditorPrefs.ts`'s `editor:particleEditorShowFloor`, etc. — same
`editor:`-prefixed convention as `editorStore.ts`'s `CAM_GIZMO_LS_KEY`/`showFocusGraph`), each
read on mount and written on change, independent of the layout save/load flow. Adding a new
persistent editor-only toggle: follow that convention (a small `load*`/`save*` pair beside the
component, or an inline `localStorage.getItem`/`setItem` in a Zustand setter) rather than
folding it into layout JSON — layout is FlexLayout's `Model`, not a general prefs bag.

#### A View option that REMOVES content must announce itself (#1003)

**The rule: of SceneView's view options, three families remove viewport content rather than adding an
overlay — the 2D `colliders2DOnly` flag, the 3D `showColliders` flag, and the 3D/2D/UI layer chips.**
Two surfaces carry that for the **two collider flags**:

- **The `View ▾` badge NAMES what is on** — `View: Colliders`, not `View (1)` — via the pure
  `viewBadgeLabel()` in `editor/panels/ViewOptionsMenu.tsx` (two names, then `+N`). The naming rule
  is `namedBadgeLabel()` in `editor/panels/badgeLabel.ts`, which the Hierarchy/Assets **`Type ▾`**
  filter uses too (#1021) — same mechanism, second site: a filter hides tree rows, and `Type (2)`
  could not say which. That trigger names a selected type the menu has NO row for first (a persisted
  Assets filter can carry one across projects), since it is the one filter with no checkbox to untick.
  ⚠️ At the default 281px column a named `Type ▾` no longer fits beside the search field and drops to
  the toolbar's second row while a filter is on — measured live and accepted by the owner over moving
  the names to the footer.
- **A corner notice in the viewport** while content is hidden, from `hiddenContentNotice()` in
  `editor/scene/sceneViewMath.ts`. It is keyed to the SAME predicate the renderer gates on
  (`shouldHideMeshesForColliderMode`) so it can never claim content is hidden when it is not, and it
  names the shortcut, because that is what somebody staring at a blank viewport needs. When the scene
  has no colliders at all it says so outright, and a warn TOAST fires on the OFF→ON transition — that
  is the case where the viewport goes completely empty with nothing to inspect.

⚠️ **The LAYER CHIPS are NOT covered by either surface, and this section previously implied they
were.** `hiddenContentNotice` never fires for `show2D`/`show3D`/`showUI`, so turning the 2D layer off
empties the viewport with only the chip's own colour as the signal. They are milder — each chip is
individually labelled and lit, and none has a shortcut — but the gap is real and is stated here rather
than papered over. Extending the notice to them is unclaimed work.

⚠️ The badge names at most two options before collapsing to `+N`, so a `ViewOption` that removes
content sets **`notable: true`** and is named FIRST. Without it the cap ran in items order and
`colliders` is last in both menus — `View: FX, Focus +1` elided the one option the badge exists for.

⚠️ **Why a count was not merely unhelpful but empty:** in 3D, `View (1)` is the DEFAULT resting state,
because Grid is checked by default (`sceneViewPrefs.ts`). So the badge read identically whether the
content-hiding Colliders mode was on or off. And Grid-only vs Colliders-only are both "one option
active" — one viewport showing everything, one showing nothing, same string.

⚠️ **Collider-only mode is one unmodified keypress away (`C`) and it PERSISTS**, and both are
deliberate — the persistence is #399's, above. `C` is not gated on a scene HAVING colliders, on
purpose: a key that silently does nothing is its own trap, and with the notice on screen the mode
explains itself even in a scene with no colliders at all (the case where the viewport is completely
empty). Note the binding is armed by PANEL focus, not viewport focus — clicking the Scene tab is
enough (`input/keymap.ts`).

**What this cost, which is why it is a rule and not a nicety:** an empty authoring viewport is
indistinguishable from a broken one. It cost the owner a debugging session, and it cost the tracker a
wrong issue — #1000 was filed with *"one `Scene2DRenderer` dies permanently"* as its headline, because
the flag was on and nothing on screen said so.

#### Remembering an ASSET PATH is not the same as remembering a toggle (#473)

A toggle is a value. A remembered **path** is a reference into a project, and the editor's
`localStorage` is not project-scoped by nature: **one clone serves every project it opens from the
same origin** (the Vite port derives from the clone DIRECTORY, not the project —
`engine/scripts/editorPorts.mjs`), and asset URLs carry **no project segment** — a rig in
`games/skin-test` is served at `/assets/rigs/zombie.rig2d.json`, because a flat project's
`runtime/assets` maps to `/assets` (`findAssetRoots`, `plugins/vite-asset-scanner.ts`).

So a path remembered under project A is a *valid-looking* URL in project B, where it addresses B's
asset root, matches nothing, and takes the dev server's SPA fallback — `200 index.html`. That is
the mechanism behind **#460**: the human opened a rig in `skin-test`, opened a different project
next, and was told their `.rig2d.json` was **corrupt JSON** about a file that was present and
untouched. `editor-layout` is global too, so the Skin panel travels along and the load fires with
nothing rig-related having been clicked. (#460 fixed only the message — the honest text now names
the path; #473 is why the fetch happened at all.)

**Two guards, covering different failures. A remembered path that can SOURCE a node or a write
target needs the first; only a path that names an ASSET can have the second:**

| Guard | Covers | How |
|---|---|---|
| **Project-scoped key** | another project's path | `projectScopedKey(base)` → `<base>:<project>`, with `setEditorProjectScope(config.name)` injected in `createEditor` |
| **Manifest existence check** | THIS project's asset, since deleted/renamed/moved | `getGuidForPath(path)` at restore — **refuse, never delete** (below) |

⚠️ **The second guard does not apply to FOLDER paths** — `getGuidForPath` addresses assets, and a
folder is not one. `pendingFolders` gets an equivalent from the Assets panel's own reconcile
(`Assets.tsx`, on every scan); `currentFolder` has none, so within one project a folder deleted
since it was remembered is still the default write target and the next Import re-creates it via
`/api/write-file`. Known and accepted: the blast radius is one import landing in a folder that
reappears, versus gating panel state on an async scan. Say so rather than assuming the table
covers it.

The manifest check is not redundant: a scoped key cannot see a rig that was renamed under a live
editor — routine across a branch switch. It is the same refusal the `open-skin-editor` agent op
already makes; the restore path bypassed it by calling the store setter directly.

⚠️ **That check refuses; it must never DELETE the remembered entry** — the first cut of #473 did,
and it was wrong. `ensureManifestLoaded` swallows a failed fetch and returns `null`: it warns, boot
continues, and it clears its own memo so the next attempt retries. So a dev server restarting
mid-boot leaves EVERY path unresolvable for one launch, indistinguishable at this call site from a
genuinely deleted asset — and dropping there converts a transient, self-healing failure into
permanent loss of the human's memory, inside a loader written specifically to be recoverable.
Keeping a stale entry costs nothing once a miss is silent: nothing opens, nothing warns, it
re-checks for free next launch, and it starts working again if the asset comes back.

Current users: `panels/lastSkinRig.ts`, `animation/lastAnimationClip.ts`, and
`panels/assetFolderState.ts` (`expanded`, `pendingFolders`, `currentFolder` — its `typeFilter`
and `viewMode` stay global, being preferences rather than paths).

**Deliberately NOT scoped, and the distinction is the useful part — a SOURCE set versus a LOOKUP
set.** `pendingFolders` *sources* tree nodes, so a foreign entry becomes a clickable folder: that
is the whole defect. An expand/collapse set is only ever *consulted*, so a foreign entry matches
nothing and renders nothing. So `editor:scripts:expanded:v2` (`ScriptTree.tsx`) and the
`editor:hierarchy:*` sets (`Hierarchy.tsx`) stay global — cosmetic at worst. `engineExpanded`
stays global for a different reason: it holds `/modoki/assets` paths, and the engine's built-ins
are identical in every project by construction. Assets' own `expanded` was scoped anyway, for
consistency with the two path keys beside it in the same module rather than out of necessity.

Scenes solve the same problem separately and predate the helper (`lastSceneKey` in
`scene/serialize.ts`, plus a self-heal to `config.scenePath` — its comment names this exact leak),
which is precisely why the rig key should never have shipped global: **the fix already existed two
lines from the call site.**

⚠️ **The remembered folder is the one that WRITES.** `defaultTargetFolder` returns it whenever it
matches `ASSET_ROOT_RE` (`panels/assetRoots.ts`), and that regex tests a path's SHAPE, not its
existence — `/assets/rigs` is shaped identically in every project. Unscoped, browsing there in one
project made the next project's Import / paste / New Folder default there too, and
`/api/write-file` creates the directory on demand: it silently CREATED a folder the human never
opened. Worth stating because these are the instances of this leak that do not merely fail loudly.

`pendingFolders` is sharper still, and scoping `currentFolder` alone would not have closed it. It
holds folders created but not yet backed by any asset, and the Assets reconcile prunes only
entries the scan COVERS — so a folder carried in from another project is never pruned, renders as
a phantom node in this project's tree, and the moment the human clicks it and imports, the folder
becomes real. The node the user clicks is the vector, not the remembered target.

⚠️ **The scope value is `config.name`, a display name, not an identity.** Nothing enforces
uniqueness and an empty one collapses to `default`, so two projects sharing a name share a key.
The manifest check bounds the damage to "opens THIS project's file at that path" rather than the
#460 error, and `lastSceneKey` already carries the identical exposure — so this is a known limit,
not an open defect. Related accepted cost: entries are never pruned, so renaming a project orphans
its old ones (~100 bytes each).

⚠️ The clip memory looks like it was already safe because restore skips a mismatched `scenePath` —
it was not. Scene paths are flat too, so several projects share `/assets/scenes/main.scene.json`
and the guard passes; it is also skipped outright when the persisted `scenePath` is null.

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

### Menus, and how a host menu changes after boot

A host registers menus through `createEditor({extraMenus})`, and `EditorApp` renders them into the
in-window `MenuBar` **and** mirrors them into the OS application menu under Electron (a
serializable spec pushed over IPC, whose click ids relay back). An item may carry a `submenu`,
**one level deep** — deeper nesting is dropped by both renderers on purpose. Electron ignores a
click on a submenu parent, so anything that must stay actionable belongs INSIDE the submenu too;
that is why the Build menu repeats "Build now" there.

`createEditor()` runs once, so a menu whose labels depend on something discovered later cannot be
built at setup time. `setExtraMenus()` replaces the whole registry and bumps a version an external
store publishes; `EditorApp` subscribes to it, rebuilds the tree and re-pushes the Electron spec.
Whole-registry rather than a patch: the host owns the shape it registered, and a merge would make
"remove an item" unexpressible.

**An item's id carries its LABEL, not just its position** (`menuSpec.ts` — `Build#0#2:build-now`),
and that is what makes a rebuildable menu safe. Electron's `MenuItem` click closure captures the id
when the template is built, macOS keeps displaying an already-open menu after
`setApplicationMenu` replaces it, and the renderer swaps its action map immediately — so a click on
a stale item dispatches an OLD id into a NEW map. With purely positional ids that *resolves*, to
whatever now sits at that index: at boot the Build menu's iOS submenu is a single placeholder row,
so `Build#0#2` is "Build now"; ~2s later the device listing lands and index 2 is the third iPhone,
whose action picks that phone and starts a build to it. Including the label makes the stale id miss
instead, and the relay logs the miss rather than failing silently. The index stays in the id
because two rows can share a label — device names repeat.

### Build → picking the target device

`Build → iOS Device` / `Android Device` name the device they will build for, and their submenus
switch it (#170). Each row says what picking it means — a devicectl-reachable iPhone reads
"hands-free install", a pre-iOS-17 one "hands-free install (go-ios)" (#217), because that is the
consequence the old menu could not tell you and it is decided by `planIosInstall`'s three modes
(`'devicectl'` / `'go-ios'` / `'xcode-handoff'`), keyed off `iosDevicectlId`. Both rows now read
"hands-free" because both ARE hands-free — go-ios closed the gap where an older device used to read
"Xcode handoff, ⌘R" — and the tool name stays in the label so the two paths are still
distinguishable when one of them misbehaves: a devicectl install/launch failure and a go-ios
install/launch failure surface differently, and only the latter can fall further back to the Xcode
handoff (when go-ios itself isn't present or provisionable). Picking writes `user.device.*` into
the gitignored `project.user.json` through
the same `/api/project-settings` route Project Settings saves to, as a partial patch — so the two
surfaces can never disagree, and hand-typed values this menu does not offer survive.

**Picking a device also STARTS the build**, once the write has landed (a build against a target
that failed to save would go to the previous device while the menu claimed otherwise). That is the
motion the picker exists for — you open it to put this build on that phone, and a
select-then-confirm split makes the common case two trips through a menu. `Build now → <device>`
below it builds the CURRENT target without changing it.

The cost is that a single menu click starts something that **cannot be stopped**: the build
progress modal's only control dismisses its own UI, while the backend SSE build runs to
completion. Hence `Set target without building…`, which routes to Project Settings rather than
duplicating the device list — a second copy is where the two would drift apart, and both menu
renderers cap nesting at one level on purpose.

Three things the shape encodes:

- **The listing is fetched once after boot, never on the click path.** Its iOS half is two `xcrun`
  shell-outs (~1.6-2.9s uncached, 10s-cached server-side); Electron exposes no will-open event for
  an application menu, so the alternatives were a poll or a stale menu. Hence the explicit
  **Refresh devices** row.
- **A device another clone is debugging is annotated, not disabled.** The claim (#149) is the
  *debug lease*; installing a build does not need it, so `debugged by modoki-ai3` is information,
  not a refusal. Same for an `unauthorized` Android — that state is fixed ON THE PHONE, and
  blocking the pick would just send you back through the menu afterwards.
- **Android keeps an explicit "Default (first adb device)" row.** An empty `androidDeviceId` means
  "whatever adb picks", and a picker that could only set a concrete serial would quietly destroy
  that meaning.

A configured device the listing cannot see (unplugged, or hand-typed) still gets a checked
`— not attached` row rather than vanishing: it is what the next build would use, and a menu with
nothing checked would be lying about that. A listing that could not be READ says so separately
("Device list not loaded yet") — "no answer from the listing" and "no phone attached" have
different fixes, and the second sends you to check a cable that was never the problem.

**Two refusals guard the pick**, both pure and unit-tested (`buildRefusal`, `pickRefusal`):

- **A second concurrent build is refused — here, in front of the server's own slot.** `/api/build`
  does take a slot (#173's in-process one, plus #650's cross-process claim), but it refuses *after*
  the request is in flight, as a `FAILED:` build status: `runBuild` fires an SSE request per call.
  This refusal keeps the second build from ever being sent. ⚠️ Since #1270 the progress dialog is a
  modal that greys the whole menu while it is up, so from the menu this refusal is no longer
  reachable — the menu refuses first. It stays as the guard for a caller that is not the menu. Before every device row was a build this took a
  deliberate second trip through the menu; now "wrong phone — click the right one" is the natural
  gesture, and it would put two `xcodebuild`/gradle pipelines on one project dir, both reporting
  into the single shared `buildStatus`. A build that already FAILED does not count as running here.
  ⚠️ Its progress dialog is a modal, though, and a modal greys the whole menu until it is closed
  (#1270, [editor-input.md](./editor-input.md#modals-block-the-editor-underneath-them-1270)), so a
  retry from the menu takes one click on Close first.
- **A pick is refused while Project Settings is open.** `user.device.*` has two writers, and they
  write differently: this menu sends a partial patch, while the dialog snapshots the whole config
  when it OPENS and posts that snapshot on Save. So a pick made while it sits open is silently
  written back to the old device — even when the user only meant to edit the app name — and the
  menu then re-reads disk and quietly agrees with the stale value. A lost update nobody is told
  about is worse than a refusal naming the reason. ⚠️ Since #1270 Project Settings is a modal and
  the menu is greyed under it, so the menu refuses first, with the generic "close the open dialog"
  message rather than this one's specific reason; this refusal stays as the guard for a caller that
  is not the menu.

The pure row-building and both refusals are `engine/app/editor/buildTargetMenu.ts` (unit-tested
without a phone); the fetching, the patch POST and a generation guard against out-of-order
listings live in `engine/app/editor/setup.ts`.

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
  ⚠️ **A third rule since #821: a top-level SECTION the build does not know is carried
  through from the pre-edit file.** `mergeProjectConfig` returns a fixed literal naming
  only the sections in `DEFAULT_PROJECT_CONFIG`, so before this an unknown section never
  reached prune and an older editor **deleted a section a newer branch had added** — in a
  committed file, with six clones on different branches. Unknown keys *inside* a declared
  section were never affected (every section is spread, so they land in `resolved` and the
  already-in-the-file rule keeps them). The carry is **top-level only**, and deliberately
  does not recurse; `pruneProjectConfig`'s own docblock carries the reasoning, including a
  measurement showing the hazard its first draft cited does not currently exist.
  ⚠️ Consequence worth knowing: prune used to double as a scrubber of unrecognised
  top-level junk in the committed file, and no longer does — a stray key now survives Apply.
  ⚠️ **A default-valued field the file never carried is ABSENT, so every raw-JSON reader must
  resolve it** (the prune rule above keeps a default-valued key only when the file already had
  it). A project that enables OTA and leaves the bundle name at `shell` gets an `ota` block with
  no `bundleName` key — a valid config. A `.mjs` script cannot import `loadProjectConfig`, so it
  must map absent → default itself and refuse only a present-but-wrong-typed value. Decide per
  field by what the default MEANS: `bundleName`'s `'shell'` is a real value, while `publicKey`'s
  `''` means "unset" and must still refuse. A default duplicated into `.mjs` is acceptable only
  when a guard pins it to `DEFAULT_PROJECT_CONFIG` (`OTA_DEFAULT_BUNDLE_NAME`). And **build test
  fixtures through `mergeProjectConfig`/`pruneProjectConfig`, never by hand** — #582 added an
  absent-is-fatal check that passed review twice because every fixture hand-wrote the field, a
  shape the writer never emits; it would have died in the spawned CLI after the build had run
  (full incident: [ota-updates.md](./ota-updates.md) § "Gotchas").
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
- **The Scenes tab discovers scenes LIVE, not at boot.** Every other field's `options` are a
  static list the schema carries, built once during editor setup — for the scene list that made
  the dialog describe a project that no longer existed. Measured on `games/anim-bug`
  (QA-DLG-0005): a scene authored in the session (New Scene → Save As) was on disk and in the
  asset manifest — `modoki_list_assets {type:'scene'}` returned it — and the Scenes tab listed
  only the boot-time scene, with no error, until a relaunch, so it could not be added to the
  build list at all. `SceneListEditor.discoverScenes` now unions the boot-time `options` with
  the live manifest (`getAllAssets()`, the same source `list_assets` reads); the boot-time
  LABELS still win, since the host built them from the backend's own paths, and an empty
  manifest falls back to exactly the old list.

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

### Project Settings — what a FIELD carries beyond its input

Three affordances on the generic `FieldControl`, each added because the form could not answer a
question the person in front of it was actually asking.

- **`help` lives behind a hover `(i)`, never inline** (#408). It used to print as permanent grey
  text beside every label, and one of these strings — the Quality Tiers help in
  `engine/app/editor/setup.ts` — is a ~230-character paragraph sitting next to a checkbox. The
  `(i)` is the shared `Info` in `panels/fields.tsx`, which is also what the Tier matrix uses:
  ONE definition, because the editor has exactly one convention for "explanation behind a hover"
  and two copies would drift. It is a `<span>` inside a `Tooltip`, **not** a `title=` — Electron
  renders native title tooltips not at all (silently absent, not merely ugly), which is why
  every hover explanation in this editor goes through that component.

- **A `path` field whose value looks like an image shows a THUMBNAIL and its pixel size.** Keyed
  off the value's extension rather than a per-field opt-in (owner, 2026-08-29: "every path"), so
  a preview appears wherever one is meaningful and an eighth image field cannot be forgotten.
  The size is the point as much as the picture: three of these fields carry a hard requirement in
  their own help text ("square, >=1024px", "ideally 2732²") that the dialog previously could not
  check — you found out from a build, or from a blurry icon on a phone. Court's splash reads
  2048² against a 2732² recommendation, and that was invisible until the preview said so.

  The bytes come from **`GET /api/source-image`**, a new route, because these values point at
  build INPUTS (`games/court/art/…`) that no asset manifest lists and therefore no `assetUrl()`
  can reach. Its neighbour `/api/read-file` is utf-8 only — it would hand back a PNG as mojibake
  rather than fail. It reuses `resolveSourcePath`'s project-root gate (a preview is not a reason
  to widen a file-read gate) and allowlists image EXTENSIONS rather than sniffing, so "every path
  field previews" cannot become "every path field is readable over HTTP" — `user.keystore.storeFile`
  points at a signing key inside the project. The dialog fetches rather than pointing an `<img>` at
  the URL, so *file not found*, *outside the project* and *not a readable image* stay three
  distinguishable messages; `<img onError>` reports one indistinguishable failure for all three,
  and they have different fixes. An `iconSource` naming a file somebody has since renamed used to
  look identical to a correct one until the build failed.

- **A `path` field is a DROP TARGET, and the copy rule is the owner's** (2026-08-29): a dropped
  file is copied into the project — these values are committed, so an absolute path to one
  machine is dead on every other clone (#394) — **except one that is already inside the project**,
  which is referenced where it lies rather than duplicated beside itself. `POST /api/adopt-file`
  makes that call, and `relativiseUnderProject` returning a relative path IS the inside-the-project
  test, so the containment rule has one definition rather than a second copy that could disagree
  with the picker's.

  Deciding it needs the dropped file's SOURCE path, which a browser has not handed over since
  Electron 32 removed `File.path` — hence `getPathForFile` (Electron's `webUtils`) in
  `engine/electron/preload.ts`. It reads like a convenience and is not: with no path the question
  is unanswerable. A host without a preload gets `''` and the drop always copies, which is the
  safe direction — a redundant copy, never a dead reference. The renderer probes with the path
  alone first and uploads the bytes only when the backend asks (a 400), so the common in-project
  drop never base64s a 2732² splash. A re-drop of the same file is byte-compared and re-used
  rather than minting `icon-1.png`; a DIFFERENT file of the same name is suffixed, never
  overwritten (`planDroppedFileDest`, `plugins/backend/projectPaths.ts`).

  Drags out of the **Assets panel** land in the same route via `assetPath`, and take the reference
  branch whenever the asset root sits inside the project. When it does not, the route reads the
  file itself rather than demanding bytes the renderer never had — an asset drag carries no `File`,
  so the upload retry cannot fire and the editor would otherwise offer a drag that dead-ends.
  ⚠️ **That disk read is allowed for an `assetPath` ONLY, never for the client-supplied `abs`.**
  The two provenances are not equally trusted: the editor's own asset roots resolved the first,
  while the second is whatever the caller said. Reading from `abs` makes the route an arbitrary-file
  reader — `{abs: '~/.ssh/id_ed25519', name: 'x.png'}` copies that file to `art/x.png`, which
  `/api/source-image` then serves back under an extension it trusts, and leaves the contents in the
  project for a commit to pick up. (Written the wrong way first, during this feature's own
  close-out, while fixing the dead-end above — widening a read gate as a side effect of fixing
  something else is exactly the move the `/api/source-image` gate was careful to avoid.)

  ⚠️ **`<fieldset disabled>` does NOT stop a drop, and both of this dialog's inert states are
  built on it.** It disables form *controls* natively — which is exactly why the dialog uses it
  instead of threading a `disabled` prop through twelve `case`s — but a `drop` handler on a plain
  `<div>` is not a control. The per-field `disabledIf` wrapper also sets `pointerEvents:'none'` and
  is safe by accident; the whole-form one (`configErrors`, the config file that did not parse) does
  not, so a drop there copied a file into the project and edited a draft that Apply is disabled
  for. The field therefore checks its own input at drop time — **`el.matches(':disabled')`, never
  `el.disabled`**: the IDL property reflects the element's own attribute only and reads `false` for
  an input disabled by an ancestor fieldset, so the obvious spelling is a silent no-op. That is the
  same trap `tests/ui/projectSettingsDialog.test.tsx` recorded for its own assertions, and it was
  written wrong here first; a unit test of the decision cannot catch it, because the defect is
  entirely at the call site. The mount test in that file is the cover.

  ⚠️ **`copyFolder` is contained before it reaches a path join.** It is a client-supplied body
  field, and `planDroppedFileDest` sanitises only the *name* — so `copyFolder:
  '../../../Library/LaunchAgents'` wrote outside the project, while the neighbouring
  `/api/write-file` 403s the identical escape. Localhost is not a boundary here: the host parses a
  POST body regardless of Content-Type, so a page in a browser can issue a no-preflight
  cross-origin POST and never needs to read the reply, because the write is the payload.
  The containment is **lexical** — `path.resolve` does not follow symlinks, so a link inside the
  project pointing out would pass. That is the same strength as `/api/write-file`'s
  `resolveSourcePath` beside it, i.e. the convention here rather than something this route
  weakens, and no project in the repo contains such a link. Stated rather than left implied,
  because "contained" reads stronger than it is.

---

## Native file choosers — Save As and Browse… (#1440)

`chooseNewAssetPath` (Create Scene, Save Scene As, every "New X") asks `POST /api/save-dialog`, and
Project Settings' Browse… asks `POST /api/pick-path`. The router decides what each ANSWERS (an
asset-root URL; a project-relative path, #394); the host decides how the panel is SHOWN, through
`BackendContext.nativeChooser` (`engine/plugins/backend/nativeChooser.ts`):

- **Electron** injects `engine/electron/electronChooser.ts`: `showSaveDialog`/`showOpenDialog`
  through `mainDialog.ts`, parented to the editor window — a sheet. That is what makes ⌘V paste
  into the name field (the app's Edit menu reaches a panel this app owns), keeps the main process
  — which also serves the backend — running while the panel is up, and gives Windows a panel.
- **Anything else** (a browser tab on the Vite dev server) falls back to an async `osascript`
  chooser on macOS and `{unsupported}` elsewhere, which the renderer answers with its in-app prompt.
  ⚠️ ⌘V still does not paste there: the panel belongs to a faceless `osascript` process with no
  menu, and nothing in its argv can change that.

**While ANY native dialog is open, the app menu cannot act on the scene behind it.** A sheet this
app owns takes the app's MAIN-MENU key equivalents — that is how ⌘V reaches it — so the editor's own
items would fire through it too. Measured before the guard: with the save panel up, Edit ▸ Undo undid
a SCENE edit behind the sheet (keyboard ⌘Z undid neither the scene nor the typing). So
`engine/electron/mainDialog.ts` — the one door every main-process dialog goes through — counts open
dialogs (save/pick panels, the Open/New Project pickers, message boxes; a count because they can
overlap) and main rebuilds the menu with `installAppMenu`'s `nativeDialogOpen`: every editor item
disabled and stripped of its accelerator, New/Open Project and Reload disabled, and Edit's Undo/Redo
replaced by the standard `undo`/`redo` roles, which reach the panel's text field. Observed after: ⌘Z
and ⌘⇧Z undo and redo the typing, Edit ▸ Undo undoes the text, the scene is untouched, and the full
menu returns on Cancel. The same rule as the renderer's own modal gate (`RendererMenuSpec.modal`,
#1270), for a modal main owns.

**A failure is not a Cancel.** `{cancelled}` means the human pressed Cancel (Electron's `canceled`;
osascript's `-128` and nothing else). A panel that failed answers a 500 with the reason: the save
flow falls back to the in-app prompt, Browse… alerts. Before #1440 both routes ran
`execFileSync('osascript')` in every host, so the panel froze the Electron editor while it was open
(QA-PARTICLE-0011), ⌘V did nothing, and every failure read as Cancel.

**Where the save panel opens.** The caller's `defaultFolder` (an Assets-panel folder, or a kind's
own, e.g. scenes → `/assets/scenes`); with none, `firstRootDir()` = `defaultSaveRootDir`: the first
PROJECT asset root, never the engine's `/modoki/assets`. Until #1441 it was `assetRoots[0]`, which is
the engine root, so Create ▸ Particle (and every toolbar create with no `defaultFolder`) opened in
`engine/packages/modoki/src/runtime/assets/`, and the default name wrote there. macOS had hidden it:
osascript reopened at its remembered location, while Electron's panel honours the directory it is
given. Browse… passes no start folder, so its panel opens wherever the OS last left it.

**On Windows (#1441, observed 2026-09-19 on the `win` box, Electron editor, `games/anim-bug`):**
- The panel is the common Save dialog (`#32770`), owned by the editor. With "hide extensions for
  known types" on (the Windows default), the default `New Scene.scene.json` shows as
  `New Scene.scene`, and saving it unchanged writes `New Scene.scene.json`; a bare `Walk` becomes
  `Walk.spriteanim.json` through `ensureExt`, with no doubled extension either way.
- Saving over an existing file raises Windows' own "Confirm Save As … replace it?" (so
  `showOverwriteConfirmation` being Linux-only does not matter here), and that check folds case: an
  all-caps spelling of `…\SCENES\main.scene.json` was asked about, and the route answered
  `/assets/scenes/main.scene.json`.
- While the panel is up, the menu gate holds on Windows too: Edit shows the plain `undo`/`redo`
  roles, and Save All, Open Project, Reload and Project Settings are disabled. It comes back whole
  after Cancel and after Save.
- A path outside every asset root gets the in-app `alert`. It shows as a native message box titled
  "Electron".
- Browse… returns native `D:\…` paths. Inside the project they are stored project-relative with `/`;
  outside, `portablePath` rewrites `\` as `/`, because the SDK-path allowlist refuses a backslash
  (`D:\Downloads` for JAVA_HOME used to fail Apply as "invalid characters").
- ⚠️ **Driving the panel from a script:** `WM_SETTEXT` on the name field changes what it SHOWS but
  not what the panel returns (the default name was saved instead). `WM_CHAR` per character works.
  And never use `SendKeys`: a background process cannot take the foreground on Windows, so the
  keys go to whatever window has focus.

An agent never opens either panel — they are modal and only a human can answer one;
`modoki_create_registered_asset` takes an explicit path instead (#288).

## Asset editors and the move gate (#1362)

Seven asset editors, split by how they are mounted — and the split decides what a MOVE of the asset
does to them:

- **Five are dockable panels** (Particle, Animation, Timeline, SpriteAnim, Skin), bound by a store
  field and listed in `ASSET_EDITOR_BINDINGS_BY_FIELD`. `applyAssetPathMoves` **re-points** them
  through `remapEditingAssetPath`, so a move is invisible to them.
- **Two are modals owned by a path-keyed view** — the Sprite Editor and the 9-slice editor, rendered
  inside `<AssetInspector key={selectedAsset.path}>`. That key is deliberate: it remounts the view on
  an asset SWITCH so no per-asset document is reused across one (#891/#897), and it is what makes a
  texture *swap* safe (#1328, pinned by `editor-texture-modal-swap.spec.ts`).

A move/rename changes the same path, so it **unmounted those two modals and destroyed their unsaved
work**. Observed live, 2026-09-18: Sprite Editor open and re-sliced 4 → 8 slices, one
`modoki_move_asset`, and the modal was gone — no Save, no Cancel, no prompt, `openEditors` empty,
and `unsavedChanges` still **false**.

**A move of an asset a texture editor holds unsaved edits on is REFUSED** (owner, 2026-09-18). The
alternative — let the move through and re-point the modal — was rejected: `SpriteEditor` documents,
and leans on in several places, that its `path` never changes for a mounted instance (its meta-load
effect would reload from disk straight over the unsaved slices), and refusing keeps the rule the
owner set for these dialogs on 2026-08-18, quoted in both files — *Cancel and Save are the only
exits*. A move that survived it would be a third exit.

How it is wired, and why in that order:

- **`AssetEditorMount.dirty`**, published by both modals, is the **only** thing that knows. They park
  nothing in `dirtyAsset`/`pendingMeta`, so every gate that reads those registries is blind to them.
- The Sprite Editor compares a **digest of what a save would write**
  (`spriteSheetDigest`, a `.ts` module beside the panel), not the slice guid list: dragging a slice's
  edge changes its rect and keeps its guid, so a guid-keyed check reports clean for exactly the edit
  a human most likely just made. A successful save becomes the new baseline.
- **`openAssetEditor`** is a registry on the `resolve-unsaved` probe, so `/api/move-file` can refuse
  with `409 HELD_BY_ASSET_EDITOR`. It is deliberately **not** a `CAUSE_REGISTRY` row (it is not one
  of `unsavedChangeCauses()`' causes) and is excluded from `DiscardableRegistry` **by type** — a
  discard could only mean "throw the modal's work away", which is what the refusal prevents.
- ⚠️ It is also **not** in `DOCUMENT_UNSAVED_REGISTRIES`, which is what the stale-read disclosures
  (`/api/validate-prefab`, `/api/scene-mutate`) ask for. A dirty Sprite Editor does not make a prefab
  read stale, and on `scene-mutate` — which refuses on a hold — asking for everything would have
  blocked scene edits because a texture modal was open somewhere.
- **`setEditorMount` compares `dirty`.** It dedups on `{path, slices}` to keep `select-sprite-slice`
  from churning, and leaving `dirty` out of that comparison made the whole mechanism inert: the
  9-slice editor (no `slices`, and a path that never changes for a mounted instance) could never
  register a hold, and the Sprite Editor's hold decayed to "the guid list changed" — the very
  substitute the digest exists to replace. It looked like it worked because the live repro re-sliced
  4 → 8, one of the few edits that does change the guid list.
- **The refusal is `423`, not `409`.** `COLLISION_STATUS` is 409 and `undoFailure.ts` reads it as
  `userFixable`, so an undo refused by this gate toasted *"something already exists at the original
  path"* — false.
- **It refuses on `unknown` too**, not only on `held`. Acting only on `held` fails OPEN against the
  skew the probe exists to detect: a pre-#1362 renderer answers *"unknown registry — nothing was
  checked"*, and reading that as "nothing is held" destroys the work. `absent` proceeds — with no
  renderer there is no modal.
- The **backend** is the guard, because the agent route never goes through the Assets panel. The
  **four** human seams (F2/context rename, drag-into-folder, clipboard **cut**, folder rename) call
  `assetEditorHoldMessage()` only to say WHY, since `moveFileToStatus` keeps `{ok, status}` and
  discards the body. A **copy** is not gated — it leaves the held asset where it is.
- **`/api/delete-asset` shares the gate** (`heldAssetEditorRefusal`), because it is the same
  mechanism and worse — it destroys the modal's edits AND the file. It honours that route's own
  escapes (`rendererWrite`, `discardUnsaved:true`): an explicit discard is a caller accepting the
  loss, not the silent loss this refusal exists to stop.
- **A dirty editor shows up in `openEditors` as `{path, dirty:true}`.** Without that, the picture
  after the fix was the one that hid the bug: a 423 nothing on the MCP surface could corroborate,
  since `openAssetEditor` is not an `unsavedChangeCauses()` cause and `unsavedChanges` stays false.

⚠️ **The tier that matters is the ROUTE, and it is easy to leave untested.** The renderer-side
helpers (`dirtyAssetEditorHolds`, `assetEditorHoldMessage`, the digest) have unit tests, and with
those green the gate block could still be deleted whole with **every** suite passing —
`unsavedGateCoverage` included, because its `needed` for this route derives from a registry list that
cannot contain `openAssetEditor`. `engine/tests/plugins/moveFileRouter.test.ts` drives the route
itself; that is where a test of this gate belongs. Note also that the router has its **own** prefix
matcher, separate from the panel's, so the panel's unit test does not cover it.

`/api/move-file`'s exemption row in `unsavedGateCoverage.test.ts` is now **partial**: its argument
(gating a rename would be wrong, because the repair carries the work across) still holds for the four
document registries and does not extend to this one, where there is nothing to re-point.

## Panels

### Tab mounting LATCHES — "unselected" is not "unmounted" (#1015)

**THE FACT, and everything else in the repo links here rather than restating it:** FlexLayout
defers only a tab's **first** render. Once a tab has been rendered it keeps rendering after you
switch away, so *"FlexLayout mounts only the SELECTED tab"* is true **only of a tab that has never
been opened this session.**

Verified in `flexlayout-react`'s `Layout` renderer (`dist/index.js`). ⚠️ **Two methods there each
compute a local called `renderTab`, and only one of them governs MOUNTING** — `renderTabMoveables()`,
the sole creator of the `SizeTracker` portal, and `SizeTracker` is in turn the sole caller of
`layout.props.factory(node)`, which is what instantiates a panel:

```js
// renderTabMoveables() — the MOUNTING decision
const visible = selected || !child.isEnableRenderOnDemand();
const renderTab = child.isRendered() || visible && (rect.width > 0 && rect.height > 0);
if (renderTab) { /* …createPortal(<SizeTracker …/>, element, key)… */ child.setRendered(renderTab); }
```

`setRendered` has exactly **one** call site, and it is that one, inside `if (renderTab)` — so
`rendered` is only ever written `true`, and nothing anywhere resets it. The editor does not set
`tabEnableRenderOnDemand`, so FlexLayout's default (`true`) applies.

⚠️ **What latches is the tab NODE, not the tab's name.** `rendered` is initialised `false` in the
`TabNode` constructor, and CLOSING a tab removes the node — so a tab closed and re-added is a
*fresh* node that must be selected once again. "I opened it earlier this session" is therefore not
by itself a reason to believe a panel is mounted; `panelMounted` is.

⚠️ **Do not read the decision off `renderTabs()`.** Its `renderTab` is a *different* expression
(`child.isRendered() || selected || !child.isEnableRenderOnDemand()`), it calls no `setRendered`,
and what it renders is the `Tab` positioning element — not the panel.

⚠️ **Selection is not sufficient either.** The mounting condition also requires
`rect.width > 0 && rect.height > 0`, so a **selected tab in a zero-area tabset never mounts.**
That case is **not** the one `panelCollapsed` reports — it is the opposite one. `panelCollapsed` is
`panelMounted && <zero area>` (`describeGameView` in `engine/app/editor/agentEditorOps.ts`), so it
describes a panel that latched first and was squeezed flat afterwards; a tab first selected INTO a
zero-area tabset surfaces as `panelMounted: false` instead. Which is why "is it selected?" answers
neither direction of the question.

**So mountedness has exactly one source of truth: the panel publishes it from its own mount effect**
(`gameViewMounted`, and `editorMounts` for the asset editors — #1213), read back as `panelMounted` /
`openEditors`. It is **not** derivable
from `openPanels` — that is every tab NODE in the model with no selection test — and it is not
derivable from selection. ⚠️ Do not "simplify" `panelMounted` into either; #367 shipped the
`openPanels` version, which answered `mounted: true` for precisely the case the field exists to
catch.

**The practical advice everywhere is unchanged and still correct** — *open AND select the tab* —
because selecting an unmounted tab does mount it. Only the stated *reason* was wrong.

⚠️ **The scar is that this propagates.** #994's session read one of the unqualified copies, believed
it, and wrote the claim into an agent-facing refusal string and two normative docs before measuring
`gameView.panelMounted: false` alongside a live `game-3d` surface and having to retract. #1015 then
found seven more copies. A fact restated at N sites is a fact that gets corrected at one.

### A panel's load/write DECISION goes in a plain `.ts` beside it, not in the `.tsx`

Editor `.tsx` is not mounted in jsdom — that asserts the mock rather than the panel — so any logic
left inside a component is testable only by a source SCAN, which sees tokens and not behaviour.
Extract the decision and the `.tsx` keeps just the I/O and the render.

The worked examples are the batch views, and they are a matched pair on purpose:
`assetViews/materialBatchLoad.ts` (`.mat.json`, #886) and `assetViews/metaBatchLoad.ts`
(`.meta.json`, #903). Each exports the load outcome AND the write plan from one module, because the
two halves are a single decision: the loader's promise — *a member that could not be read is absent
from the map* — means nothing unless the writer honours absence, and in both issues the defect was
precisely that it did not.

⚠️ **What this buys, stated as a limit rather than a benefit.** The extracted module is tested for
behaviour; the panel is tested for DELEGATION. So a guard over the `.tsx` proves a decision is
wired, never that it renders somewhere reachable — and that gap is real: `SkinEditor` and
`TimelineEditor` both shipped a refusal banner *below* their own early return, where it could never
appear, and no scan could have caught it. That half needs the live editor.

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

### Find References (Assets row, Hierarchy row)

Right-click an asset in the Assets panel or an entity in the Hierarchy and pick **Find References**
to see everything that points at it — direct AND indirect (a texture reached only through
material to mesh reports the entities at the far end), with the field to edit named on each hop.

Two things about it that are easy to misread:
- **It reads files on disk, not the live world.** Unsaved scene edits are invisible to it, so wire
  something up, save, then ask. A "0 references" answer on an unsaved edit is the instrument being
  stale, not the truth.
- **It answers about ONE target — it is not a cleanup tool.** For "what can I delete?" use the
  Assets menu's **Clean Up Unused Assets**, which is strictly more complete: it reports a whole
  dead subtree where a per-target "nothing references this" only ever sees that subtree's entry
  point (measured on `games/sling`: 73 orphans against 38). Find References tells you what breaks
  if you delete THIS; the cleanup dialog tells you what is already dead.

The graph behind it is the asset tree-shaker's own walk, inverted — including the implicit
texture-to-derived-sprite edge that makes an ad-hoc search for "who uses this texture?" wrong rather
than merely incomplete. Mechanism, the measured numbers, and the traps:
[build.md](build.md) § "Find References — the same walk, inverted".

### Dropping an asset into a panel — accept what you act on, and refuse the rest VISIBLY

Two panels take an asset dragged out of the Assets panel, and each takes one kind:

| Target | Accepts | Because |
|---|---|---|
| **Hierarchy** | prefabs | It instantiates entities. Every other kind is a *reference* (mesh, material, texture, clip) with no entity shape of its own, so a drop has nothing to create. |
| **Skin editor parts list** | sprites + textures (or any `.png`/`.jpg`/`.webp`) | A part's source art is a sprite; a dropped texture is resolved to its derived whole-image sprite. |

Dropping onto the **SceneView viewport** does nothing at all, and that is a decision rather than a
gap — see `todo.md` § Deferred decisions.

⚠️ **A refusal has two halves, and shipping only one is its own bug** (#306). Until 2026-08-21 both
panels called `preventDefault()` on `dragover` for any `application/editor-asset` — because the MIME
type says nothing about the KIND — and then filtered on the real rule in the drop handler and bailed.
A texture got the copy cursor *and* the row highlight from the Hierarchy; a prefab got the copy
cursor *and* the blue outline from the parts list; both then did nothing, with no explanation. The
two halves now are:

1. **dragover does not `preventDefault()`** for a kind the panel will not act on. That is what
   paints the browser's no-drop cursor, suppresses the highlight, stops `drop` firing at all, and —
   the part that matters for QA — makes `modoki_dnd` fail with an honest `accepted:false` instead of
   returning `accepted:true, committed:false`, a shape `engine/app/debug/domDnd.ts` had to carry a
   heuristic warning about because it is indistinguishable from a drop that legitimately makes no
   edit. (`qa/cases/assets/assets-drag-drop-into-hierarchy.md` asserted the OLD result and was
   inverted in the same change.)
2. **the drag ghost says why** — `setDragGhostRefusal` in `editor/utils/dragGhost.ts` repaints the
   label already following the cursor (🚫, red, *"only prefabs can be dropped here"*). A bare
   no-drop cursor says "not here" without saying whether you missed the target or picked the wrong
   file, so each refusal names what WOULD work. That half is invisible to the agent tier — the
   ghost is torn down by `dragend` before a tool call returns — so it is pinned by unit tests, and
   a *silent* refusal would pass QA and still be a defect.

**The browser constraint that made this non-obvious**, and the reason a drop target cannot simply
apply its rule: **`dataTransfer.getData()` returns `''` during `dragover`** — the drag data store is
in *protected mode* until `drop`, exposing only `types`. Both panels accepted everything because at
decision time they genuinely had nothing to decide with. The answer is `getAssetDragInfo()`, reading
the payload the Assets panel stores module-side at dragstart (`setAssetDragPayload`, single
producer — verified by grep). A null result during an asset drag means a foreign or stale drag and
is refused, not waved through.

**Each rule has exactly one copy**, in `editor/panels/assetDropPolicy.ts`, called by both the
dragover handler and the drop handler. That matters more than the refusal text: the Skin editor's
drop handler had its own hand-written `isImage`, and a second copy of an accept test is precisely
how the affordance and the action drift apart again — invisibly, since the panel keeps working and
merely accepts a little more or less than it acts on. (`dragGhost.acceptMatchesAsset` makes the same
point for `data-accept` targets.) The panels only wire the policy in; it is pure and unit-tested,
per the editor `.ts`-carries-tests rule below.

`handlePrefabDrop`'s `type !== 'prefab'` bail is still load-bearing even though no human can reach
it, because `modoki_dnd` dispatches `drop` unconditionally and only *reports* what `accepted` was.

### A sprite ROW has no file — every selection-driven file action asks `isFileRow` (#1249, #1257)

When the Assets list is narrowed to sprites (the `sprite` chip, or a search matching a slice), each
sprite is a flat row whose path is `<texture>#<guid>` (`#default` for the whole-image sprite). No file
exists at that path, so a rename, move, delete, duplicate or copy of it 404s at best. Select All
reaches those rows, so **a file action must filter the selection, not trust it**, and every one asks
the same predicate in `panels/assetListing.ts`: `isFileRow`, through `fileActionTargets` (entries) or
`fileActionPaths` (paths — a selection Set, a drag payload). Callers today: delete/duplicate/copy
(#1249), F2 in `resolveAssetKey`, the context menu's target count, and the folder drop (#1257).

The count is the part a user sees: the menu derives `many` from it, so counting sprite rows made one
texture plus a few sprites read as a multi-selection and hid Rename, Instantiate, Re-import, Copy Path
and Find References for the one real file. `fileActionPaths` keeps a path with no listed entry (a
folder, an engine built-in) — what those mean stays the caller's call. **Not filtered, on purpose:**
the `application/editor-asset-paths` drag payload (the Skin editor's parts list takes sprites), the
Inspector's multi-selection, and the footer's "N selected". A new selection-driven file action goes
through the predicate rather than a local `type !== 'sprite'`.

### A panel that reads `getAllAssets()` must subscribe to `assetsVersion`

`getAllAssets()` reads the module-level manifest map, and React has no idea when that map
changes. An import or re-import repopulates it out of band — dev server rescans → the
`asset-manifest-updated` HMR event → `loadManifestJson(…, {prune:true})` in `createEditor()`
→ `refreshAssets()`, which bumps `assetsVersion` in the editor store. **A component that
calls `getAllAssets()` during render, or memoizes its result, and does not subscribe to
`assetsVersion` will keep showing the asset list as it stood at its last render** — and
nothing about that looks wrong on screen, because a stale list is a perfectly plausible one.

Two sites had it (#293): `AssetRefField`, which builds the SpritePicker's `assets` prop —
so a texture converted by the picker's own "Make 2D" button minted a new sprite that the
still-open picker could not see, making the button look broken — and `TimelineEditor`,
whose value pickers were memoized on the open-target nonce alone, so an audio file dropped
into Assets never reached the audio-cue picker until the panel was retargeted.

The exceptions are real and worth recognizing so this is not applied blindly: a function
called fresh on each open (`discoverScenes` in `SceneListEditor.tsx` — deliberately
unmemoized, documented as such) and a one-shot read at boot (`createEditor()`) need
nothing. The rule bites *memoized* or *render-time* reads inside a long-lived panel.

**`assetsVersion` tracks the asset PATH SET, not file contents.** `createEditor.tsx` only
bumps it when `assetSetSignature()` changes, and that signature is
`assets.map(a => a.path).sort().join('|')` — paths only, deliberately (see the function's own
header). So a same-path CONTENT change on disk (a re-import, a `git checkout`) bumps nothing,
and **a panel holding a parsed copy of a file's body cannot rely on `assetsVersion` to learn
that the file changed underneath it** — see the asset Inspector's fourth rule below for what
that gap costs a panel that also WRITES the whole file.

### A list built from `getAllAssets()` must be SORTED, not left in map order

`getAllAssets()` returns `guidToEntry` in **Map insertion order**, and `registerAsset`
re-registers an existing guid in place while appending a new one. So anything imported or
converted *during a session* goes to the END of any list derived from it — and jumps into
position on the next reload, because a fresh boot registers the manifest in scan order.

That reload is what makes this expensive: the list looks correctly ordered every time you
go looking, so nothing suggests an ordering rule is missing. It was reported as
*"I see it but it's at the end of list"* only after first reading as the asset being
missing from the picker entirely (#293 follow-up), and the reload that appeared to fix it
was really just re-sorting the entry back into place — which sent one session hunting a
manifest-propagation bug that did not exist.

Sorted as of that sweep: the **SpritePicker**'s texture groups (`sortGroupsByName` in
`spritePickerGroups.ts` — pure and unit-tested), the **shader** dropdown
(`shaderCatalog.ts`, built-ins keep their deliberate lead), the **scene** picker
(`SceneListEditor.discoverScenes`, with the host's boot options left in caller order), and
the **Timeline Editor**'s audio/prefab value pickers. `FontPicker` already sorted by family
— it is the one that shows the rule was known.

The test to apply to a new list: *would an asset created five minutes ago appear where the
user expects, without reloading?* Position must not depend on when the entry was registered.

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
| `panels/assetListing.ts` | Assets filtering, sprite/type grouping, the file-row predicate for file actions, the visible-order walk that drives keyboard nav |
| `panels/assetKeyCommands.ts` | every Assets keystroke → a command (platform-dependent delete chord, type-ahead) |
| `panels/assetSelection.ts` | Assets click + drag selection policy |
| `panels/assetOps.ts` | import/re-import planning, the delete sidecar rule, rename validation |
| `panels/skinParts.ts` | rig part list edits (add/remove/reorder/rename/visibility), part geometry (`uvToPosAffine`, `partAngle`, `bboxCenter`), and the selection remap that must agree with them |
| `scene/marqueeSelect.ts` | SceneView 2D box-selection: threshold, enclosure, selection merge |
| `scene/pickSelection.ts` | the shared 2D + 3D viewport pick rule |
| `scene/multiTransform.ts` | group-transform math, incl. which Transform fields each gizmo mode writes |
| `utils/layoutStore.ts` | layout persistence — the restore precedence ladder, corrupt-layout self-heal, stale-tab retitling, the Load-Layout ordering rule |
| `utils/layoutNames.ts` | layout name sanitising + the reserved autosave name |

All are unit-tested, but "has a test file" is not "is covered": `assetOps.ts` sits at 56%
(the rest is `/api/*` IO wrappers), and `skinParts.ts` sat at 58% with **five** exports no test
executed — the issue that recorded it (#163) said four, having counted by reading the issue rather
than the file. Check `npm run coverage`, and check it against the SOURCE, not against a list
someone wrote down: those five are covered now, and the way the miscount survived into a ticket is
the argument for measuring.

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
3. **A list edit and the selection index are ONE decision — give them one entry point.** A
   panel that edits a list (parts, tracks, slices) almost always keeps the selected item's
   INDEX in separate state, and the two must be remapped together. Split them and they drift,
   silently: `reorderPart` no-opped on an out-of-range index while its partner
   `reorderActiveIndex` returned the raw target, so a reorder that changed nothing could still
   move the selection (#163). Worse, the Parts ↑/↓ buttons called `movePart` and remapped
   **nothing** — moving the SELECTED part left `activeSkinPart` on its old slot, so the
   selection jumped to whatever swapped into it, and because `withActivePart(def,
   activeSkinPart)` backs tessellate / auto-weight / sprite-assign, the next edit wrote to the
   wrong part's mesh. The shape of the fix generalises: **one callback owns "edit the list AND
   move the selection"** (`SkinEditor.reorderParts`), every gesture routes through it, and any
   precondition the two halves share lives in ONE predicate they both call
   (`reorderIsNoop`) — never two copies that must be kept in step. A move-by-one is just a
   reorder, so the separate `movePart` helper was deleted rather than left beside the correct
   path as the easier thing to reach for.

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

**What genuinely remains untestable there is the other ~390 lines, and the reason is
structural**: they are one 650-line React component plus six modal components — 34 hooks, the
menu tree built from live callbacks, the Electron OS-menu bridge, project open/close, HMR-epoch
wiring. Most of it is orchestration, which is the Phase-2 shape: it needs an integration
harness, and one e2e spec is the honest coverage for it — which the suite already has.

⚠️ **"There is no decision left in it" was this paragraph's claim until 2026-09-10, and it was
wrong twice over** — once when written, and once as a rule of thumb. The `menu-action` relay
looked like pure orchestration (an IPC handler reading a ref) and had a real decision buried in
it: *what to do when the relayed id is not in the current action map*. It answered with a
`console.warn` the user cannot see, so a menu click did nothing and said nothing (#1032's
`family/refusal-not-surfaced` mechanism). Extracting `resolveMenuAction()` into `menuSpec.ts`
made the decision testable and the toast possible; the hook kept only the dispatch. **So the
lesson below generalises further than it was first stated: an orchestration site can still
CONTAIN a decision, and the giveaway is a branch whose two arms differ in what the user is
told.**

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
  GUID/`.meta.json`). Modoki has **no in-app code editor** — clicking a script *opens*
  it in whatever app owns the file type (`/api/open-file`), and **Alt-click** *reveals* it
  in the OS file manager (`/api/reveal-in-finder`) instead, so you edit it in your own editor
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
  unmount. It reloads on a re-import off the invalidation epoch — see "The asset Inspector"
  below, rule 3.

**The two standalone `WebGLRenderer`s must call `forceContextLoss()`** (#776).
`ModelPreview` and `previewScene` are the only editor surfaces that build a renderer directly
rather than through `makeWebGPURenderer` — and `WebGLRenderer.dispose()` frees programs and render
targets but does **not** release the underlying GL context; the browser reclaims it whenever it
feels like it. Both panels mount per asset click, and `ModelPreview`'s effect re-runs on `[hasLods]`
as well, so without the explicit call the live-context count climbs to the browser's ~16 cap and
"too many active WebGL contexts" blacks out the previews **and** the main SceneView. `previewScene`
had the call from the start; `ModelPreview` shipped without it for months, because the seam was
documented in two places (`gpuContextTracking.ts`'s header and `previewScene`'s own comment) and
guarded in none. It is guarded now, on comment-stripped source, by
`tests/architecture/glContextRelease.test.ts`. Both panels place the call just before `dispose()`,
but that ordering is convention, not a requirement — `dispose()` never touches the extensions
closure or `_gl`, so either order releases the context. The guard therefore checks that the call
exists, not where it sits. ⚠️ This does **not** apply to `WebGPURenderer`, which
has no such API — `makeWebGPURenderer` wraps its `dispose` instead, so every downstream disposer is
correct for free.

Dialogs/modals mounted by the shell include `ApplyPrefabDialog`,
`ProjectSettingsDialog`, and the import/build progress modals. Each panel is wrapped in a
`PanelErrorBoundary` so one panel crashing doesn't take down the editor.

**"Reload Panel" cannot fix every crash, and the boundary now says so instead of looping.** The
button really does unmount and remount the children, so a panel that died on transient state
recovers. What it cannot touch is a crash caused by the panel's PERSISTED tab config: the children
are still bound to the same FlexLayout tab-node object resident in the in-memory model, so the
initializer re-reads the same bad `node.getConfig()` and dies identically — and repairing the file
on disk changes nothing until the layout model is re-read. Measured with a non-iterable Console
`config.levels` (QA-EDITOR-0008): the data was fixed on disk, `Reload Panel` still re-crashed every
time, and only a full reload recovered — which the UI gave no hint of needing.

So the boundary counts its own retries. A crash arriving after a reset means the in-place path
failed for THIS crash, and only then does it add the explanation plus a **Reload Editor** button,
behind an in-place confirm (the reload discards unsaved scene edits, and `window.confirm` blocks
the renderer). A remount that SURVIVES clears the counter, so a panel that crashed, recovered, and
hit something unrelated later still gets its own cheap retry first.

---

## Trait registry & the auto-generated Inspector

Every ECS trait the editor can show is described by a **`TraitMeta`** in the trait registry
(`runtime/core/ecs/traitRegistry.ts`). A game registers its traits once (engine traits via
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

  ⚠️ **`hidden: true` is NOT a substitute — it hides the widget, and the serializer does not
  read it** (#406). `UIScrollView.viewportWidth/Height` + `contentWidth/Height` and
  `UIEntries.firstX/visibleX/poolSize/epoch` were hidden-only, so a `games/scroll-demo`
  re-save wrote the editor's own measured UI viewport (410x312) into three committed scenes as
  authored data. The two flags answer different questions — *may a human edit this?* vs *may
  this reach disk?* — and an engine-written field needs BOTH.
  `engine/tests/assets/runtimeOnlyFieldsOffDisk.test.ts` now fails on any committed scene or
  prefab carrying a `runtimeOnly` field, which catches the leak from the other side.

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

**The two modes draw the 3D layer through DIFFERENT cameras, and exactly one place picks which.**
3D mode renders through the editor orbit camera over the whole canvas; UI mode renders the 3D
layer through the **game** camera into a letterbox sized to the game aspect. `viewCamera()` /
`viewProjection()` in `SceneView.tsx` return that camera and draw rect, and everything that maps
between a client point and the scene reads them: the render loop, the click pick, the aim-rect
bounds provider (`modoki_tap`, `get_scene_state bounds`), the gizmo's published handles and its
pointer hit-test, and the marquee. The pure mapping is `viewportDrawRect` in
`scene/sceneViewMath.ts`, which `computeUIModeNDC` is defined through. Two consequences are easy
to miss:
- **three's `TransformControls` listens to the canvas itself.** It maps its own hover and press
  over the full canvas unless `gizmo.viewport` is set. The render loop sets it every frame from the
  same draw rect (`transformControlsViewport`: lower-left origin, `null` in 3D mode). Without that, a
  press in an empty letterbox bar grabbed a handle drawn elsewhere.
- **Outside the draw rect is "nothing here".** A ray at NDC beyond ±1 still hits geometry, so a
  click in a bar selected an entity the view does not show. The pick now returns nothing there.

The UI-mode letterbox aspect comes from the store's `gameRect`, and GameView is its only writer.
Its deferred ResizeObserver update is cancelled with the effect. Before that, a device → Free
switch inside one frame let the old device's frame land after Free's zero rect, and the SceneView
stayed letterboxed to a device no longer selected until the editor relaunched.

Scar (#1489): the render, the pick and the gizmo camera switched on the mode, but the bounds
provider kept the editor camera over the full canvas, and the gizmo pointer kept full-canvas NDC.
In UI mode `modoki_tap` aimed where the editor camera would draw an entity and asked a pick that
looks through the game camera. It was refused as OCCLUDED by whatever was behind, and passed or
failed by coincidence. It looked like state building up on one editor, and two things did build
up. The MODE is persisted, so an editor stays in `ui`. The stale `gameRect` above survived every
smoke run's device-preset case, which shifted what the coincidence landed on. Two more things worth
knowing:
- In UI mode `modoki_focus_entity` moves the editor camera, which the view does not draw through.
  It frames nothing you can see there, and the aim does not depend on it.
- The smoke's UC3 taps in both modes. Its UI pass frames something ELSE on purpose, because an
  aim that wrongly used the editor camera still passes while that camera happens to frame the target.

### ⚠️ The UI-mode measurement seam — THREE stacked coordinate spaces, and FOUR wrong fixes

`UIResizeOverlay`'s drag math has produced a shipped defect four times, each fix plausible, each
surviving a green `npm run verify` and a review, each caught only by putting a browser in front
of it. Read this before touching a measurement there.

**There are three spaces, not two:**

| Space | Read with | Blind to |
|---|---|---|
| Screen px | `getBoundingClientRect()` | nothing — it sees every transform |
| Layout px | `clientWidth`/`offsetWidth`, `getComputedStyle` padding/border | **every** transform |
| Frame-logical px | what `toLogicalDelta` produces | only the FRAME's transform is divided out |

⚠️ **And a fourth trap that is not a transform at all: the GAME panel's device frame carries a
1 px border, so its CLIENT box is 2 px narrower than the device it claims to preview** (found
measuring #1119's label budget, 2026-09-12). At the iPhone SE preset the frame lays out at
`offsetWidth: 375` with `box-sizing: border-box`, and every `%`-width UI root inside it therefore
resolves against **373**, not 375. **SceneView's frame has no such border**, so the two panels
measure the SAME entity about 0.5% apart — at scale `0.869333`, a full-width root reads `326.0`
(375 x 0.869333, exact) in SceneView and `324.261` (373 x 0.869333) in the Game panel. Neither is
wrong; they are previewing boxes of different widths.

Two consequences. **A live measurement checked against an authored `%` is off by 0.5% unless you
divide by the client width rather than the preset's name** — small enough to read as rounding, big
enough to sink a budget check sitting on a few px of headroom. And **the error does not exist on a
real device**, so a discrepancy this size between a panel measurement and a device one is expected
rather than a defect to chase.

Two separate transforms stack between the frame and an element. `SceneView` lays the preview
frame out at the logical device size and applies `transform: scale(uiScale)`; **and**
`applyRotationStyle` (`runtime/ui/anchorCss.ts`) emits a second `transform: scale(s)` on any node
whose `UIElement.scale !== 1`. A measurement is only correct if it names which of the three
spaces it is in and converts consistently. The first three failures were all one mistake — mixing
two spaces in a single expression; the fourth (below) was different — assuming a
`getBoundingClientRect()` ratio between two boxes equals a scale factor, which is true only when
nothing in the chain is rotated:

1. **Original** — `%` denominator was the parent's **border** box (`getBoundingClientRect`),
   where CSS resolves against the content or padding box. Wrong whenever the parent had padding.
2. **#651 B2's first fix** — subtracted layout-px padding/border from a screen-px rect, then
   multiplied by `1/uiScale`, dividing the padding term by `uiScale`. Correct only at
   `uiScale === 1`; error `S·|1−1/u|` — where `S` is the total padding+border subtracted from the
   screen-px rect (both edges combined, in layout px), the term the bug multiplied by `1/uiScale`
   alongside the screen rect when only the screen term should have been — so **break-even at
   exactly 0.5 and strictly worse below** it — and tablet/desktop presets letterboxed into a
   SceneView panel sit below 0.5 routinely. On a small parent the denominator clamped to 0 and the
   handle went silently dead.
3. **Its replacement** — used pure layout px (`clientWidth`) and so corrected the frame's
   transform but was blind to `UIElement.scale`. A `%` child of a scaled node overshot by that
   scale factor; `computedSize` additionally double-counted the element's *own* transform
   (measured: 83px round-tripped to 747px at `scale: 3`).
4. **That fix's own regression** — its `ancestorScaleRatio(screenSize, layoutSize, frameScaleAxis)`
   recovered the second transform as a ratio of a `getBoundingClientRect()` box to a layout size —
   correct only when nothing in the chain is rotated. `getBoundingClientRect()` on a rotated
   element returns its axis-aligned BOUNDING box, which is bigger than the element itself, so the
   ratio stopped being a scale factor the moment rotation entered the picture: measured (parent
   200×150, `scale: 1`, frame scaled 0.5) at `rotation: 15` the ratio came out `1.160/1.311` for
   what should be exactly `1/1`, and `0.750/1.333` at `rotation: 90` on the same non-square parent.
   A scene with no `UIElement.scale` at all — the case the original fix existed to leave alone —
   regressed the instant an author rotated anything.

**The resolution:** `decomposeScale`/`accumulateAncestorScale` (`uiResizeMath.ts`) read the
ancestor chain's CSS transform MATRIX directly instead of comparing two boxes. A `matrix(a,b,c,d,e,f)`
is the coefficient matrix whose columns are where the X/Y basis vectors land; rotation only changes
a column's DIRECTION, never its length, so `hypot` of a column recovers exactly that axis's scale
regardless of any rotation composed into the same transform. `UIResizeOverlay` walks from an
element's parent up through `.parentElement` to (excluding) the preview frame, decomposing and
compounding each ancestor's own transform. The result is exactly **1** when no ancestor between the
element and the frame carries a transform of its own — true whether that ancestor is unrotated,
PURELY rotated, or both rotated and scaled — which is the property that keeps every untransformed
case byte-identical, and (unlike item 4 above) is now asserted against a REAL browser-computed
transform, not inferred from a box ratio. A degenerate `scale: 0` — a legitimate authored value (a
pop-in clip's first keyframe) — falls back to 1 rather than propagate a zero into `%`'s denominator,
where it would otherwise turn a drag into a silent no-op. Layout boxes are then scaled into
frame-logical space by the result, and `deltaToUnit`/`computeResize`/`computeMoveOffsets` divide it
back out for every unit **except `%`** (the `%` path cancels, because its denominator carries the
same factor; `px` and `vw`/`vh`/`vmin`/`vmax` do not) — including an auto-sized `px` element's own
measured-size BASE, which needs that same division alongside `dx`/`dy` and was, until this fix, the
one place it was still missing.

⚠️ **Scope of "exact under rotation": the recovered SCALE FACTOR, not the whole resize.** This fix
makes `decomposeScale`/`accumulateAncestorScale`'s own return value exact under rotation — the
%-denominator and the `px`/auto-size divisions above are all correct now. It does NOT make dragging
a handle under a rotated ancestor geometrically correct: `toLogicalDelta` converts a screen-pixel
drag straight into a frame-logical delta and never projects it onto the element's own (rotated)
local axis, and the 8 resize handles are placed at fractions of the on-screen AABB rather than the
element's true corners. So a 45°-rotated ancestor still writes the FULL dragged px count into
`width`/`height` for a horizontal drag (matching `dx` directly) where the visually-intended change
is `dx · cos45° ≈ 0.707 · dx` — a 40px drag writes 40 layout px where the visual intent is ~28.3.
That is a real, separate, still-open gap this fix does not touch — decomposing the matrix fixed the
DENOMINATOR, not the DRAG AXIS.

**Why the gate never caught any of it, which is the part worth generalising:**
`uiResizeMath.test.ts` feeds hand-written numbers to pure functions — never the broken part, so
deleting the whole `getComputedStyle` block leaves it green. `UIResizeOverlay.test.tsx` never
enters `handlePointerDown` (its fixture has `parentId: 0`, so no parent element mounts), and jsdom
reports every rect as `0x0` and `''` for unset padding → `NaN` → `|| 0`, so the mismatch is
invisible there **by construction**. A pure-function test cannot see a units error at a DOM seam.
Failure 4 got past a pure-function test a DIFFERENT way: `ancestorScaleRatio` had its own unit
tests, and they passed — but every `(screenSize, layoutSize, frameScaleAxis)` triple they fed it
was hand-picked as if `screenSize = layoutSize / frameScaleAxis * trueScale`, an identity that only
holds without rotation, so the tests could not have failed even reading the wrong formula; only a
browser, computing `screenSize` itself from an actually-rotated element, could disagree with it.
Cover it with an e2e that drags at a non-1 `uiScale`, under a scaled ancestor, **and under a
ROTATED one** — all three exist now, and each caught a different one of the four failures.
Assert the unit is still `%`, or the test silently stops testing this path the moment a fixture
drifts to `px`.

⚠️ **The rotated case asserts the stored `%`, not the on-screen pixel round-trip the other two
use, and that difference is deliberate.** A rotated ancestor puts the child's own
`getBoundingClientRect()` into the paint chain as an AABB, and the drag axis is never projected
onto the element's local axis — so a pixel assertion there would pass or fail for reasons that
have nothing to do with the denominator under test. Asserting the written value isolates the one
thing the fixture exists to pin. A test that passes for the wrong reason is the failure mode this
whole section is about.

### The idle render gate — what re-arms it, and the edge that keeps being missed

The 3D viewport draws only while its dirty gate has frames left (`editor/panels/viewportDirtyGate.ts`
— a 60-frame / ~1s COUNTDOWN, not a boolean, because several async loaders in `scene3DSync` poll
"not ready, retry next frame" with no completion callback). Everything that can change the rendered
image therefore has to re-arm it, and `SceneView`'s subscription list is the whole set: trait writes,
structure changes, world swaps, play-state edges, dynamic-font glyph generation, the editor store,
OrbitControls, and — since QA-ASSET-0008 — **both edges of a model re-import**.

**Both edges, and the second is the one that gets forgotten.** An editor re-import calls
`invalidateModel`, which evicts the live meshes before the GPU geometry is disposed; that changes the
image at once. The REBUILD only happens on a frame that runs, and a GLB re-parse routinely takes
longer than the 1s grace — so re-arming on the invalidation alone still left a re-imported object
missing indefinitely (measured on `games/space-console`: 10s+, twice, recovering only when an
unrelated selection forced a frame). It reads as data loss, not as a stale frame. The completion edge
is `fireDirtyListeners()` (`runtime/core/renderDirty.ts`), called by **both** model caches —
`meshTemplateCache` for static templates and `riggedModelCache` for skinned prototypes. Wired into
only the first it would leave re-imported CHARACTERS broken while every static mesh recovered, which
is why both caches call it.

⚠️ **That completion edge used to travel on a PRIVATE channel, and that was #1363.** A dedicated
`modelLoadNotify.ts` / `onModelTemplatesLoaded` event existed for it, and the subscription list
above was its ONLY subscriber in the repo — so the QA-ASSET-0008 fix covered one render-on-demand
3D surface of two, and the **stopped GameView** (`Scene3D`, idle-gated since the T1 gate landed in
June 2026) never got the load edge at all. Its own docblock asserted "the continuously-rendering
GameView needs none of this", which was already false two months before it was written. Every other
async refill in `meshTemplateCache` — `fetchEnvironment`'s success path, the material refetch —
already called the shared `fireDirtyListeners()`, which is why none of them had the bug. The channel
is deleted; the reasoning now lives in `renderDirty.ts`'s header, with an explicit note not to
answer this edge with a private channel again.

MEASURED on `games/alien-animal`, stopped editor, Game panel visible, the GLB refill delayed past
the grace: **before**, the evict emptied the scene at t=1752 ms, the gate spent its ~1 s and the
surface stopped submitting at t=2751 ms, and 30 s later the scene still held 0 meshes with
`renderer.info.render.calls` frozen — one forced render restored it instantly, so the refilled model
had been sitting in the cache unused. **After**, the same run recovered unaided at t=10014 ms, the
moment the refill landed.

**UNDO/REDO was missing from that list entirely, and it is the sharpest case (2026-08-18).** Undo
reverts a transform through `gizmoUndo.ts`'s `apply`, a raw `en.set(trait, …)` — it does not go
through `writeTraitField`, so it fires NO dirty broadcast. The 2D gate has compensated for exactly
this since it was bitten (the `subscribeUndo` effect in `SceneView.tsx`); the 3D gate never got the
same wiring. So after an undo `scene3DSync` did not run, and the THREE object kept its PRE-undo
world matrix while the ECS Transform was already reverted — the next reader of render-side state
got the stale value for one call. That is `modoki_focus_entity` framing the camera at x:1807 for an
entity back at x:5 (QA-SVIEW-0003), a gizmo drag computing its base from the un-reverted position so
a second undo could not restore the original (QA-SVIEW-0001), and the projected gizmo aim-points
briefly reporting no handles. Calling either a SECOND time "fixed" it only because the first call
moved the camera and OrbitControls' own `change` armed the gate — which is why it read as
"stale for exactly one call" rather than as a dead viewport.

MEASURED, same camera pose either side, `games/anim-bug`, Sun dragged +260 px on the X gizmo then
undone: **before** the fix the scene-view screen rect stayed byte-identical to the DRAGGED reading
(x 172.528) and only snapped to the reverted x −53.722 when an unrelated selection change armed the
gate; **after**, the first read is already x −53.721. Note a `modoki_set_transform` + undo does NOT
reproduce it — that path goes through `mutate_scene`, which does fire the broadcast, so a repro has
to use the real gizmo drag.

**MaterialInstance was the same shape, found a different way (2026-08-18).** A `kind:'prop'` override
writes a plain NUMBER onto a per-entity THREE material clone — opacity, colour, roughness, a map
offset. No trait is written and no store changes, so **not one** of the sources above saw it and the
viewport kept showing the pre-change frame indefinitely. Every data-level check passes while only
the pixels are stale: `get_scene_state` reports the authored override and the clone genuinely
carries the new value. `runtime/rendering/materialDirty.ts` is the missing channel (the sibling of
`text/textDirty.ts`, and the 3D half of what `markEntity2DMaterialDirty` already did for Pixi);
`materialInstanceSystem` bumps it only on an ACTUAL value change or a clone rebind, so a
constant-source override costs one frame and a time/curve-driven one redraws every frame, which is
what it is asking for.

⚠️ **`modoki_capture_viewport` cannot detect any of this**, and believing otherwise is how the
MaterialInstance case was mis-diagnosed as "the override never reaches the render, even after a
FORCED render". It does not force a render, so on this viewport it returns the last drawn frame —
see [rendering.md](rendering.md) § "The measurement protocol" for the mechanism and what to use
instead. **This is the standing hazard for anything measured through this panel**, not a detail of
the MaterialInstance case.

The continuously-rendering GameView needs none of this, which is why the bug was viewport-specific —
and why "it works in the Game panel" is not evidence that a render-on-demand path is fine.

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
  every member. Undo/redo write traits via a direct `entity.set`, so the transform action's apply
  (`editor/scene/gizmoUndo.ts`) fires `fireDirtyListeners()` itself — without it the Game view kept
  the pre-undo position (#1141). The SceneView's 2D overlay and Pixi content are ALSO woken
  explicitly on any undo (`subscribeUndo` → `mark2DDirty` + `editorMarkScene2DDirty`), which covers
  undo entries that are not transform actions. The live drag follows the same rule: every direct
  write in `installScene2DInteraction` calls both `mark2DDirty()` and `fireDirtyListeners()`.
- **Undo labels name an entity through `entityDisplayName(id)`** (`entityUtils.ts`), which resolves
  the name exactly as the Hierarchy row does. An unnamed entity falls back to its GUID rather than a
  runtime id a hot-reload reassigns — the id only when there is no GUID or no live entity. Never read `.name` off a `findEntity` result: the name lives on the
  `EntityAttributes` trait, and `findEntity` infers `any`, so the read compiles and is always
  `undefined`. Every gizmo, 2D-drag and UI move/resize label read `Entity <id>` that way (#1138).
- **A canvas drag must CAPTURE the pointer, because it ends in its element's `pointerup`** (#1161, #1176).
  The single gizmo, group and Collider2D-vertex drags all listen on the Canvas2D's chrome canvas,
  and all three push their undo entry (with the unsaved flag, and for a gizmo or group drag a
  `!transform`; a vertex drag's is `Edit Collider2D.points`) only in that canvas's `pointerup`. Without capture, a release past the canvas edge, over the toolbar or over
  another panel goes to whatever is under the cursor: the entity has moved, nothing can undo it,
  and the drag ref stays live, so a later hover with NO button held keeps dragging.
  `bindDragPointerCapture` (`editor/panels/dragPointerCapture.ts`) captures on a press that claimed
  a drag, as the 3D gizmo always has. A lost capture for that same pointer while the drag is
  still live counts as the release. Per the spec that is the touch/pen `pointercancel` path, and it
  has not been observed live. A second pointer can neither steal the capture nor end the first
  drag. The UI-mode right-button pan binds it too: it commits nothing, but it stayed live the
  same way. ⚠️ Any new drag state added to `installScene2DInteraction` must join its `isDragging`
  predicate, or that drag is uncaptured again. The routing is jsdom-unreachable. The automated check is
  the e2e `editor-scene-multiselect.spec.ts` (a single gizmo drag released past the canvas edge), and
  QA-SVIEW-0011 covers all three drag kinds live.
  The Sprite and Nine-Slice slicer canvases bind the same helper through `useDragPointerCapture`
  (#1176). They used to END a drag on `onMouseLeave` instead, which does commit, but at the last
  in-canvas point, so an edge could never be overshot onto the sheet boundary. ⚠️ **Do not
  "restore" a leave handler as a safety net.** Under capture a leave cannot end a live drag anyway:
  measured on Electron, the sequence is `pointerup`, `lostpointercapture`, then
  `pointerout`/`pointerleave`. That is also why `SkinCanvas` and sling's editors, which capture on
  press, are unaffected by their own `onPointerLeave={onPointerUp}`. A press on a scroll viewport's
  own scrollbar still reaches its `pointerdown`, so the slicers skip it with `pressIsOnScrollbar`
  rather than capturing a scrollbar drag as an edit.
  **The game's `pointerSource` no longer shadows a panel's capture (#1182).** It listens on `window`.
  Until the editor installed a pointer ingestion scope, it captured the TARGET of any press that no
  handler had stopped, so the slicer's canvas held capture instead of the viewport. An outside
  release still worked with the Sprite Editor's `captureDrag` deleted (measured 2026-09-14), which made
  outcome-only checks of a panel's capture unfalsifiable. Now only a press inside the Game panel's
  play area reaches the game's sources ([editor-input.md](editor-input.md) § "The pointer ingestion
  scope"). QA-ASSET-0025 step 5c used to stub the canvas's `setPointerCapture` to work around this.
  The stub is gone (#1192): without it the step goes red when `captureDrag` is deleted (measured
  2026-09-14).
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
`onSelectEntity`. Two things about that are load-bearing and were each a shipped bug:

- **A click on a 2D canvas is decided on `pointerdown`, but can be UNDONE by the `click` that
  follows it** (#999/#1001). `installScene2DInteraction` selects the 2D entity on `pointerdown` and
  stops that event — but the browser dispatches a separate `click` for the same gesture, and a
  Canvas2D host is a LEAF in the UI tree, so `UINode` gives it neither an `onClick` nor pointer
  events. That click therefore bubbles PAST the host to the nearest ancestor UI node that does have
  a handler — in practice the UI root — which re-selects itself. Nothing logs, so the symptom reads
  as "2D is unpickable" rather than "picked, then overwritten". `UIEditorOverlay`'s arbiter arms its
  existing click-swallow (`overrodeClickRef`/`swallowGenRef`) on every pick-canvas `pointerdown` to
  shield the canvas's own selection; the canvas handler still owns the selection itself.
  ⚠️ The winner's own OPACITY is irrelevant to this path — it is simply the nearest ancestor with a
  handler. Reproduced in three games whose winners disagreed on opacity (wordweave's and court's
  painted nothing, chess's was opaque), which is why `isPaintOpaque` was a red herring in all three.
- **A genuine 2D miss is bounded by the canvas host.** `pickUnderlyingUIEntity` looks through the
  2D surfaces for a UI element beneath, and without a bound it escaped upward to the root the same
  way. `resolveHostBoundedPick` + `hostRelationOf` (`uiPreviewPick.ts`, pure + DOM adapter, so the
  rule is unit-testable — this is the § Panels rule about a `.tsx`'s decisions living in a `.ts`)
  substitute the host when the fall-through landed on an ANCESTOR of it. Owner ruling 2026-09-09: an
  empty-canvas click selects the canvas host. A descendant of the host — a UI child showing through
  a transparent canvas — and an unrelated subtree both keep their own answer, which is what leaves
  the Three.js and deselect fall-throughs intact.
  ⚠️ `hostRelationOf` asks whether the PICKED element contains the host, scoped to its own subtree,
  rather than looking the host up document-wide: the editor mounts the same UI host in BOTH the
  SceneView preview and the Game panel, so a document-wide lookup can answer with the other panel's
  copy.

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

A device preset carries its **safe-area insets** as well as its logical and physical
sizes, and the preview publishes them so UI insets exactly as it would on that phone —
`env(safe-area-inset-*)` is 0 on a desktop browser, so without this the preview cannot
show a notch bug at all. Always on, with the bands drawn over the frame. Mechanism, the
per-orientation data, and what is measured vs published:
[UI system](./ui-system.md) § "The editor simulates the safe area".

The toolbar's **● Record** plays a take for the gameplay recorder. Stopping it opens a render dialog,
and a non-modal progress card follows the render. The flow, and why the render is a backend job the
page polls: [Gameplay recorder](./gameplay-recorder.md) § "Rendering from the editor".

### Driving the preview screen from an agent (#367)

The selected device and orientation live in the **editor store** (`gameViewDevice` /
`gameViewOrientation`), not in GameView-local state, so `modoki_set_game_view_device` can set them —
the same lift `sceneViewMode` got, for the same reason: the device picker is a popup that trusted
input cannot operate. Before it, every layout check an agent ran measured whatever device the human
last left selected, and the per-device bug class (safe-area insets, panel-fit budgets) is precisely
the one that needs the device changed repeatedly to be checked at all. `modoki_game_view_devices`
lists the catalog; `modoki_get_editor_state` reports the current selection as `gameView`, so a
measurement can be attributed to a screen size.

Six things about that surface are load-bearing:

- **`gameViewDevice` + `gameViewOrientation` are the source of truth; `gameViewSize`,
  `gameViewSafeArea` and `gameRect` stay DERIVED** — GameView resolves them and publishes them
  downward for SceneView's preview frame. Writing them from the setter as well would give each two
  writers to keep in sync by hand.
- **An explicit `{logicalWidth, logicalHeight}` is carried as a synthetic preset named `Custom`**,
  so every `resolve*` helper and every GameView consumer handles it unbranched. `logicalW: 0` is
  reserved by `FREE_PRESET` for "fill the panel", so a zero dimension is refused rather than
  silently becoming Free.
- **Every inset quartet says where it came from — `safeAreaBasis`, per orientation (#786).**
  `'measured'` (a real device reported it), `'published'` (a vendor's per-model table),
  `'inferred'` (reasoned, or generalised from another device) or `'no-device'` (zeros by
  construction: `Custom`, `Free` and the aspect presets). Four bare zeros are indistinguishable from
  a measured "this screen has no notch", which is the mis-authoring `devicePresets.ts` warns about.
  It is DATA authored beside the numbers in `SafeAreaSet.basis`, not derived from the preset's name:
  the old name check reported every catalog row as `'preset'` — a reasoned Android-tablet zero and
  the iPhone SE's measured one alike — and missed that a `16:9` row has no device behind it either.
  ⚠️ The landscape half of every measured row is `'inferred'`: the apps that measured them are
  portrait-locked, so nothing rotated to check.
- **A `dpr` that cannot round-trip is refused, not rounded.** `physical` is stored as
  `round(logical × dpr)` and the read-back recovers dpr as `physical / logical`, so `{1, 1, dpr: 0.5}`
  used to be accepted and answer `dpr: 1` — a wrong answer stated authoritatively. The combination is
  now refused, naming the offending dimension. This is a round-trip guard, not a ban on fractional
  dpr — 2.5 on an even dimension passes. But a real phone is not the example to reach for: Pixel 9
  is 412×924 → 1080×2424, ~2.6214 wide and ~2.6234 tall, so it has **no single dpr** and
  `{412, 924, 2.62}` is refused. That is exactly why the catalog stores physical sizes explicitly
  rather than deriving them — pick such a screen by name.
- **The read-back reports `panelMounted`, and `panelSize` when the device is `Free`.** The derived
  values are written only by GameView's own effects, so with the Game tab unmounted the store's
  device changes and nothing derived moves — a complete iPhone 16 Pro read-back while SceneView's
  preview still shows the old size and zero insets. And `Free`, the default, has `logical: {0,0}`
  by construction, so the field the docs tell you to read before quoting a measurement answered 0×0
  in the most common case; `panelSize` carries the real one.
- **An explicit size defaults the orientation to portrait, so its numbers are literal.** Found
  against a live editor: orientation is sticky and presets are authored portrait and flipped, so
  `{logicalWidth: 640, logicalHeight: 480}` sent while the panel sat in landscape previewed
  **480×640**. The read-back said so honestly — never a false success — but "I asked for 640 wide
  and got 480" is a trap worth not setting. Passing `orientation` alongside a custom size still
  rotates it; that is an explicit request rather than a leftover.

Not persisted to localStorage, unlike `sceneViewMode`: this reset to `Free` on every mount before it
moved to the store, and a custom resolution silently restored days later is a measurement taken at a
size nobody chose.

### ⚠️ The preview is ~0.4% NARROWER than the preset it names — so it confirms a mechanism, never a sub-1% margin

**Measured 2026-09-10** (Court, #969's close-out), driving the editor at the `Galaxy S22` preset:
the Game panel's host box computed **358.468 x 778.472** for a preset that reports **360 x 780**.
That is **0.43% short on width** and 0.20% on height. The engine resolves viewport units against
that host box — it does not use CSS `vmin`/`vh`, it computes them and writes px — so **every
`vmin`/`vw`/`vh`-authored length in the preview is short by the same fraction.**

**The rule that follows, and it applies to every project, not just the one that found it:**

> An editor pass can confirm a **mechanism** — that a tap zone renders, that a row wraps where you
> think, that a value is read rather than ignored. It cannot confirm a **margin thinner than ~0.5%**,
> because the instrument's own error is that size. A measurement inside its own error bar is not
> evidence, however precise the number looks.

What this cost when it was not written down: #969 shipped two tap-target fixes whose margins were
0.24dp and 0.23pt — both well inside this error — and an editor pass would have appeared to confirm
or refute them at random. The margins were settled by arithmetic on the AUTHORED values instead, and
the live pass was used only for what it can actually decide: the pad renders, and three markers fit
per row. A margin that genuinely needs settling needs a real device (#973's `elementsFromPoint`
probe on hardware), not this panel.

⚠️ **The CAUSE is not diagnosed** — plausibly the host's fractional-zoom rounding (the editor window
runs a non-integer `zoomFactor`, and authored `px` lengths do come back divided by it), but that was
not confirmed, so do not repeat it as fact. The *size* of the discrepancy is measured; the *reason*
is open. If it is ever fixed, this rule relaxes rather than disappearing — re-measure before
trusting a tighter bound.

The measurement's own home, with the full numbers and the layout they were taken against, is
`games/court/tests/tapZoneClearance.test.ts`.

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

- **Play** (`enterPlay`) snapshots the live world **in memory** — the primary AND every base in
  the chain, through `editor/scene/authoredSnapshot.ts`, the same capture the preview session uses —
  deliberately **without** `assignGuids`, so Play never writes authored data. It records the scene
  key and the current undo depth (the "barrier"), then flips to `'playing'`. Resuming from Pause
  does **not** re-snapshot.
- **Pause** (`pausePlay`) freezes the sim but keeps the mutated play world.
- **Stop** (`stopPlay`) reverts by reloading that snapshot through `SceneManager`
  (`preloaded:` — no disk fetch; resources reused via the scene refcount), discarding every
  play-mode mutation, then `truncateUndoTo(barrier)` drops the during-play edits. The reload
  **carries** kept bases and the primary's `Persistent` roots instead of rebuilding them, so
  `restoreAuthoredSnapshot` replays their authored fields afterwards (#1547). ⚠️ A snapshot is
  SPARSE — the serializer omits every field at its trait default — so the replay fills schema
  defaults back in (skipping `runtimeOnly` and `entityId` fields); replaying only the keys present
  silently skipped every posed field whose authored value was the default. `EntityAttributes` is
  replayed too, minus its structural fields (`parentId`, `sortOrder`, `guid`, `sourceScene`,
  `editorFolder`) — skipping it wholesale left an activation-hidden Persistent HUD hidden after Stop.
  ⚠️ Only a PLAIN entity is schema-filled: what a prefab entry omits comes from its template, so it
  is replayed only as far as it states — a prefab root with no root overrides writes a bare
  `EntityAttributes {parentId}`, and filling that blanked the instance's name and forced it active.
  **Pre-play undo history survives** the world rebuild because undo actions resolve their
  targets by stable GUID. A guard skips the revert if the active scene changed since Play
  (the snapshot is for a different scene).

This is what makes binding-driven `isVisible` (and any other system that writes ECS state at
runtime) safe: those writes only ever happen while playing, and Stop throws them away before
they reach disk. Transitions emit `!play`/`!pause`/`!stop` to the editor journal (see
[debug-tools-mcp.md](./debug-tools-mcp.md) "Percept").

**The scrub/preview run-modes carry an OWNER, and taking it now NOTIFIES the panel that lost it
(#810).** `RunMode` is a single global that both the Timeline and Animation panels drive, so each
tags its transitions with an `owner` and `exitPreviewMode(owner)` refuses to tear down a mode a
different panel holds. That guard covers only the panel that never entered: once panel B enters
legitimately — an ordinary ruler drag — it owns the mode, and B's exit then returned the global to
`stopped` while A's preview rAF was still running and still mutating authored traits, because that
loop is keyed on `[playing, rootId]` and never consults `getRunMode()`. `registerModeOwnerDisplaced`
closes it: taking the mode tells the previous owner, which stops its own loop.

⚠️ Three traps live in that mechanism. **The notification must fire after the new mode is set** —
before it, TimelineEditor's `if (getRunMode() === 'preview')` cleanup clobbers the transition being
entered. But that ordering is **necessary, not sufficient**: it makes the guard decline only when the
new mode is `'scrub'`; a `'preview'` displacer passes it and steals the ownership back. What makes it
safe is that **no displacement callback re-enters a mode transition** — they only stop their own rAF.
Second, **a displaced panel must never clear `isPreviewPlaying` UNCONDITIONALLY** — it is one flag
BOTH panels read, so that stops the global preview rather than the panel. It drops the flag only
when IT started the run (`stopPreviewIfOwnedBy`, owner-strict), which is the half #1546 added: a
panel that stopped only its loop left its flag up, and the next re-render re-entered preview. Third, and the reason `previewOwner` exists: **both panels' preview effects fire on one ▶
press**, so each would take the mode from the other — and the Timeline always lands second (its entry
is behind an await), so it always won and always stopped the Animation panel's loop. Pressing ▶ in
the Animation panel played nothing at all. A panel now drives the preview only when it owns it.

⚠️ **There are TWO shared resources here, and checking ownership on one is not enough.** Besides the
`isPreviewPlaying` flag there is the preview **session** — `AnimationEditor` opens it through the
same `beginTimelinePreviewSession()` the Timeline uses. `TimelineEditor`'s unmount used to end that
session whoever owned it, and **ending it reloads the scene**
(`endTimelinePreviewSession` → `SceneManager.loadScene` → a world swap), which tore down the
Animation panel's live preview as a side effect of closing an idle tab — and the Timeline's own
`onWorldSwap` handler then saw that swap and cleared the flag too. Three passes fixed the flag
before anyone noticed the session, because every one of them reasoned about the flag. The store's
`closeTimelineEditor`/`closeAnimationEditor` are the same shape again: ownership decisions wearing a
store action's clothes.

**A pose opens a session, or it poses nothing (#1167).** `beginTimelinePreviewSession()` resolves
`true` only when a session is held, and every caller acts on `false` by posing nothing, starting no
▶ loop, and handing back the run mode it claimed. It resolves `false` in two cases:

- **A restore is still landing.** The ending session has already cleared its snapshot, so a begin
  there would serialize the still-posed world as the new "authored" snapshot, and the next Exit
  would restore a pose. The owner chose **refuse** over **wait** (2026-09-13). Waiting would have
  kept a drag's last position, but the pose that followed would aim at entity ids resolved before
  the swap. Refusing matches #1148, which already refuses every undo/redo for the same window. A
  scrub drag poses again on its next move once the restore has landed. **"A restore" means ANY
  authored restore, Stop's included (#1572)**: `authoredRestoreInFlight()`, next to the preview's
  own counter. Stop sets `stopped` before its restore, and the session's `onWorldSwap` abandon
  covers only a begin that seats before the swap. A scrub in the post-swap tail (managers disposing
  and initialising) snapshotted Persistent roots and kept bases still at their Play values, and
  that session's Exit or Cmd+S cycle wrote them back as authored. The same window refuses Play
  (`aSceneSwapIsHappening`) and undo/redo (`registerUndoRestoreBarrier`): `canEdit()` reads true
  there, so an undo wrote a Play-time value into the reloaded world with nothing left to revert it. One chain has its own
  restore: grabbing the playhead while ▶ plays reverts the forward run and then reopens a scrub
  session. That chain goes through `reopenPreviewAfterRestore`, which re-claims scrub, because a drag
  move refused during its restore handed the mode back and the reopen then posed under `stopped`. It
  poses at the latest playhead, and it reopens only while the gesture is live: ⏹ Exit, an asset
  switch, unmount and toolbar Stop cancel it (`cancelPreviewGestures`). An Exit during that restore
  used to be silently undone by the reopen.
- **The restore window reaches the other authored writers too.** Exit clears the session and sets
  `stopped` before the swap lands, so anything that only checks those would act on the posed world.
  Cmd+S waits for the restore (`whenPreviewRestoresLanded`) instead of writing the pose, every other
  writer refuses through `isWorldAuthored` (below), and Play treats a landing restore as a world
  swap (`aSceneSwapIsHappening`). A Stop pressed during that
  window waits for the restore and then returns to stopped. The exception is a Stop pressed while
  Play is starting up: it still goes to #470's queue, because Play's own preview restore produces
  the same state.
- **An Exit intervened** while the snapshot was serializing. A begin made after that Exit does not
  join the cancelled begin still serializing. It opens its own session, and the cancelled caller then
  also reads `true` ("a session is held"), because `false` would hand back the same owner's mode over
  the later claim.

Callers used to pose unconditionally after the begin. The one pose that asserts a session
(`applyPose`/`applyPoseAtTime`) only logged, while `poseAt` and the Timeline ▶ loop posed and fired
signals with nothing to revert. A thrown snapshot was an unhandled rejection with the mode pinned at
`scrub`. The Timeline's pose sites now go through `openPreviewSessionThen(owner, pose)`
(`editor/scene/openPreviewSession.ts`, unit-tested), and `poseClipAtTime` reports `refused`, which
the `pose-clip` agent op turns into a `REFUSED_BY_OP` "the preview is closing" instead of "applied 0
channels". Both ▶ loops start only after the session is held.

**Test it by the OWNER, not by the playhead.** With a timeline doc loaded the Timeline's own loop
advances `playheadTime` too, so "the playhead moved" passes under both the correct and the broken
behaviour — the vacuum this change's first test fell into. `previewModeOwner()` on the editor test
bridge exists for that: `playMode`'s `_modeOwner` is module state an E2E cannot reach through the
store. The seam is covered by `tests/e2e/editor-preview-panel-ownership.spec.ts`, which is
mutation-checked against the one-word change that reintroduces the bug and that all 3379 editor unit
tests missed. Full mechanism, and why this site needed a displacement
callback where its sibling `timelinePreview._saveHandler` needed a re-seating stack:
[rendering.md](./rendering.md) § "One fix, two twin globals".

**Stop pressed during Play's startup window is queued, not dropped (#470).** `enterPlay` awaits
several times (ending a Timeline preview session, `serializeScene()` for the primary and each base)
before the final `setPlayState('playing')`, and `getPlayState()` still reads `'stopped'` for that
whole window — so a Stop landing there used to hit `stopPlay`'s own `'stopped'` early-return and do
nothing, silently. `enterPlay` now sets an in-flight latch synchronously before its first await; a
Stop that arrives while it's set is queued instead of dropped, and `enterPlay`'s tail runs the real
`stopPlay()` revert once it reaches `'playing'`. A second `enterPlay()` arriving in that same window
is refused outright (returns without doing anything) rather than starting a concurrent snapshot —
two independent in-flight Plays could otherwise race their `finally` clears and leave the editor
`'playing'` with no snapshot left to revert.

**Every decline is RETURNED, not only warned (#1574).** `enterPlay` resolves to a `PlayOutcome`
(`started` · `resumed` · `already-playing` · `refused` with its `reason` · `stopped-during-startup`,
carrying the queued Stop's own `reverted` — including a restore that threw, which the tail logs and
folds in rather than rejecting the Play press)
and `stopPlay` to a `StopOutcome` (`reverted` true/false + `reason`, `queued`, `already-stopped`,
`preview-exited`). **Both surfaces read them, and print the same string.** The toolbar ▶/⏹, the
`mod+p` chord and the take recorder's ⏺ (a Play press, then a Stop press — the recorder adds its own
toast where it abandons a take, [gameplay-recorder.md](./gameplay-recorder.md)) go through `pressPlay`/`pressStop` (`editor/scene/playPressFeedback.ts`, #1577), which
raise a warn toast carrying the outcome's `message`/`reason` for a refused Play (except a
double-press, `already-starting`) and for any Play or Stop that ended without reverting — including a
Stop whose restore THREW, which under the old `void stopPlay()` was an unhandled rejection. Until
#1577 the toolbar discarded the outcome, so a correct refusal looked like a dead button. The agent
`play`/`stop` ops build their reply from the same outcomes — the reply table is in
[debug-tools-mcp.md](./debug-tools-mcp.md) § "Editor debugging — DEFAULT to Electron (modoki MCP)" (the Play/test bullet). A new early return in either
function needs its own outcome, or the agent reads it as success again.


### One envelope at a time, one exit, one owner, one "is it authored?" (#1546–#1550)

Phase 3 of [plans/preview-mode-refactor.md](plans/preview-mode-refactor.md). A review found every
remaining leak sat where two of the envelope's many pieces of state disagreed, so each rule below
makes ONE place answer a question several used to answer separately.

- **A preview session and Play never coexist.** `beginTimelinePreviewSession` refuses while Play runs,
  is paused, or is starting (`holdPreviewSessionsClosed`). A pose during Play goes straight into the
  Play world (`poseEnvelopeHeld`): Stop reverts it with everything else, and saving is refused until
  then. It used to open a session anyway — `enterScrubMode` no-ops in Play, the begin did not — and
  that session snapshotted the RUNNING world, outlived Stop, and later restored the Play world as
  authored (on ⏹ Exit, the Cmd+S cycle, or the next Play press).
- **Play, Stop and a scene load take the envelope down through one path.** `takeDownPreviewEnvelope`
  restores, cancels pending begins and grab chains, and drops the mode; the mode OWNER is released by
  a run-mode listener on every change out of scrub/preview, and the owner hears it as a displacement —
  so the panel stands down fully (loop, ▶ flag, recording). A scene load reaches it through
  `registerBeforeSceneLoad`, awaited inside the load's token BEFORE the load flips the mode — it used
  to drop the mode and leave the session to the swap, so a REFUSED or failed load stranded an
  owner-less session, and a successful one carried posed bases/Persistent roots across. A load that a
  newer one superseded while it waited returns `'superseded'` without reaching SceneManager.
  `openPrefabForEditing`, which swaps through SceneManager directly, runs the same takedown
  (`takeDownEnvelopeBeforeWorldSwap`) before its save and swap. Any OTHER world swap (a prefab undo's
  reload, a new scene) abandons the session without restoring (its snapshot belongs to the world that
  went away).
- **A session is seated only under a live mode claim, and leaving the claim cancels its begin
  (#1569).** Every teardown ends only a HELD session. A begin still serializing its snapshot therefore
  survived a timeline switch, the panel's unmount, a world swap or the Animation ⏹, and seated a
  session after the mode was back at `stopped`: a posed world, no owner, no ⏹ anywhere. The cancel
  now lives in the same run-mode listener as the owner release: any change OUT of scrub/preview
  calls `cancelPendingPreviewBegins()`, so no exit path has to remember it. A move within the
  envelope (scrub ⇄ preview, a pause freezing it) cancels nothing. That makes one rule for callers:
  **claim the mode before you begin.** Scrubs, `poseClipAtTime` and the Animation ▶ always did. The
  Timeline ▶ used to begin first and claim `preview` after the snapshot landed, so a teardown in that
  gap found the mode `stopped` and nothing to cancel. It now goes through `openPlaybackSession`,
  which claims a frozen `preview` first. A refused begin hands its claim back through
  `handBackPreviewClaim`, which skips the hand-back while a newer begin is live. Without that check, a
  cancelled click's refusal would drop a later click's claim, and the cancel would then lose that
  click's pose too.
- **One capture, one restore** (`editor/scene/authoredSnapshot.ts`): see Stop above. The preview
  restore had drifted from Play's — no base replay, and it keyed on the editor's file path, so ⏹ Exit
  inside prefab-edit reloaded under `''` and Cmd+S then opened Save As.
- **One "is the live world authored?"** (`editor/scene/authoredWorld.ts`). `saveScene` (and so Save
  All, agent `save-all`, Create Scene, the save before prefab-edit), `savePrefabEdit`, Apply to Prefab
  and Create Prefab all ask `whyWorldNotAuthored()`: the run mode, plus registered sources — a held
  session, a preview restore in flight, any authored restore in flight (Stop reads `stopped` while the
  Play world is still live). Apply to Prefab had no guard at all and wrote poses into shared
  templates. ⚠️ It is deliberately NOT the world-replacement token: the Cmd+S preview cycle holds that
  across its own save. A source that throws counts as posed — the write is refused, not waved through.
  A restore that THROWS is a source of its own until the next world swap: the envelope has ended and
  every counter has dropped, but the live world may still be the posed one. While it holds, a new
  preview session AND Play are refused too — either would snapshot that world as authored, and its
  own successful restore (a swap) would clear the guard and wave the pose through a save.
- **One owner field decides "is this envelope mine?"** Both panels read `getModeOwner()` through
  `onModeOwnerChange` (every write goes through one notifying setter — B taking scrub from A leaves
  the MODE unchanged, so a run-mode subscriber never hears it). The Timeline's ⏹, status text and
  Cmd+S handler key on `owner === 'timeline'` (it used to register for an Animation envelope, win the
  save, and strand the Animation ⏹); the Animation panel's `inPreview` is derived, not a `useState`
  that missed every exit it did not make. The decisions live in `openPreviewSession.ts`
  (`panelOwnsEnvelope`, `mayEndSharedSession`, `undoMayRepose`).
- **An asset undo does not open an envelope.** Clip/timeline undo+redo re-pose only into the panel's
  own held session, through a ref (a pose OPENS the envelope, so Cmd+Z after ⏹ Exit — or with the
  panel closed — used to re-enter scrub with no ⏹ anywhere).
- **Recording lives inside the envelope.** Switching record ON opens it, so every recorded value is
  preview-only and lives in the clip (Unity's record mode is a preview mode too). It used to open only
  after the first recorded write had landed, so that one value — and only that one — was saved into
  the scene. ⚠️ The guard is the INVARIANT, not a list of exits: the record hook runs AFTER the edit
  is written, so it keys only when the Animation panel already holds a live session
  (`ownsHeldSession`), and otherwise stops recording and says the edit stayed a normal scene edit. A
  first cut turned recording off at ⏹ and on displacement and missed four other ways to leave (an
  agent exit, a Timeline ⏹, Record pressed in Play or under a Timeline envelope). Record ON refuses at
  once when the envelope it opens is not the Animation panel's.
- **The Animation rebind finds the same entity by guid** before falling back to "the first Animator
  whose bank lists the clip", which picked none for a "+ New Animation" bind and the wrong one when
  two Animators share a clip.
- **The agent's live-world edits refuse an envelope** (#1552). `create-entity`, `duplicate-entity`,
  `delete-entities`, `reparent-entity` and `prefab` instantiate / detach / revert edited the
  snapshotted world, replied `ok`, and vanished on Exit. They ask `whyWorldNotAuthored()` like the disk
  writers. The exits follow which condition holds (`posedWorldExits`): inside an envelope, the exits
  `/api/scene-mutate` offers — one copy, `editor/scene/envelopeExits.ts`; a session still held after
  the mode left, Stop; a restore landing, retry; a FAILED restore, reload the scene. `prefab create`
  shares the refusal and, since it writes a FILE, refuses Play as well. `player-prefs-write` (not
  `flush`) refuses only while a session is HELD — that is the only thing that puts PlayerPrefs back
  (#1551). Play is exempt on purpose: editing the play world is how an agent drives a running game,
  and Stop discarding it is Play's contract, not a silent loss. Game agent tools are not gated.
- **Pause says it is paused.** Both panels pause through `freezePreviewIfOwnedBy` (`preview` +
  `advancing:false`, session still held). The Animation ▶ never froze the mode, so `get_editor_state`
  reported an advancing preview while it sat still (#1552). The helper declines when a scrub, an
  exit or another panel already changed the mode, which is what the Timeline's own inline guard did.

Still open, and why:
- signal/`OnSequence` actions fired by ▶ still run for real where the effect is not state the engine
  knows (`iap.buy`, `system.openUrl`, `engine.reload`, a game's own stores). The known stores — bus
  volumes, PlayerPrefs, the applied quality tier — are put back on every end (#1551,
  [timeline.md](timeline.md) § ▶ Preview);
- a takedown from OUTSIDE the panel (Play, Stop, a scene load) passes no rebind, so the Animation
  root is re-taken by NUMBER by `editorRefLiveness` — right while load order is deterministic, which
  it is for an unedited scene; only ⏹ Exit and Cmd+S rebind by guid;
- Record ON can briefly show lit with no envelope when its session begin is refused (⏺ pressed while
  a restore is still landing): the record hook's `ownsHeldSession` check stops it at the first edit —
  safe, but the notice comes after the edit rather than at the press;
- Cmd+S while recording saves the clip but refuses the scene half ("edited inside the preview"): the
  recorded edits bump the edit version like any in-envelope edit. Nothing is lost — exiting reverts
  exactly those preview-only values — but the message overstates it.

## Panel registrations in module-level slots — why the unguarded ones are safe (#811)

Several editor panels publish per-instance state into a module-level single slot and clear it on
effect cleanup. The class — *take path overwrites unconditionally, release path nulls without
re-seating a survivor* — and its two failure shapes are in
[rendering.md](./rendering.md) § "One fix, two twin globals" (#802, #810). This section records the
**editor-specific** half: which slots still lack the identity guard, and the invariants that make
that safe today rather than lucky.

`SceneView` registers three slots inside its one big viewport `useEffect`, and that effect's cleanup
releases all three with a bare clear:

| Slot | Declared in | Released by |
|---|---|---|
| `_pickBillboardInUI` | `editor/panels/SceneView.tsx`, module scope | direct assignment to `null` |
| `editorCamera` | `editor/scene/sceneViewBus.ts` | `setEditorViewportCamera(null)` |
| `ecsObjectsRegistry` | `editor/scene/sceneViewBus.ts` | `setEcsObjectsRegistry(null)` |

Their siblings in the same file — `setFocusEntityHandler` and `setViewportController` — DO return an
identity-guarded unregister (`if (slot === handler) slot = null`). That asymmetry is real and was
filed as #811.

**#811 was closed as not-reachable**, because the harm needs an ordering nothing can produce: the
OLD instance's cleanup running *after* a NEW instance has already registered. Four paths were
checked, and all four are shut:

- **Two SceneViews at once — impossible.** `dockPanel()` (`editor/panelDock.ts`) scans for an
  existing tab whose `getComponent()` matches the requested id and takes its focus branch —
  returning `'focused'` — instead of adding a second. `EditorApp`'s `PANELS` table maps `scene` to
  `SceneView` exactly once, and the Window menu / `showPanel` / the openByDefault auto-dock all go
  through `dockPanel`. Pinned by `tests/editor/panelDock.test.ts`,
  `it('focuses (never duplicates) when the tab already exists')`.

  ⚠️ **`dockPanel` is NOT the only add path, and a reader hardening it would be covering four
  fifths of nothing.** Five asset-editor panels — particle-editor, spriteanim-editor, skin-editor,
  animation-editor and timeline-editor — are docked by a direct `Actions.addNode` in `EditorApp`,
  each behind its **own hand-copied** "find an existing tab, else add" check rather than
  `dockPanel`'s. Six implementations of one rule. None of them can add a `scene` tab, so the
  conclusion above holds — but it holds because of `PANELS` and those six separate checks, not
  because one function owns the invariant.
- **A dock move does not remount.** FlexLayout renders each tab through a portal keyed
  `child.getId() + (child.isEnableWindowReMount() ? child.getWindowId() : '')`. Dragging a tab to
  another tabset changes its position in the model, not its id — so the key is stable and React
  keeps the component mounted. Hidden tabs stay mounted (CSS-hidden); they are not torn down.
- **StrictMode is on unconditionally** — `engine/app/main.tsx` wraps `<App/>` in `<StrictMode>` with
  no DEV gate — but its double-invoke is create → destroy → create on ONE instance. It never places
  a cleanup after a newer registration.
- **The async `setup()` cannot be overtaken.** The effect body is fire-and-forget (`void
  setup().catch(...)`) and the unmount cleanup sets `outerDisposed = true`, so a superseded run must
  bail. Each of `setup()`'s four awaits — the WebGPU renderer build, the retry backoff,
  `acquireRenderer`, and `setActiveRenderer` — is followed by an `outerDisposed` re-check; the one
  after `setActiveRenderer` is deliberate and carries its own comment (#254). After that last guard
  there is **no further await before the three registrations**, so a run past it assigns all three
  synchronously in one task.

⚠️ **What would flip this class live, all at once.** The safety is a property of the editor's panel
model, not of these call sites, so it is not local and it is not obvious:
- **Enabling popout / floating windows.** `enableWindowReMount` appears nowhere in the editor today;
  the moment it does, the portal key above gains `getWindowId()` and moving a panel between OS
  windows becomes a genuine remount. A guard test forbidding the flag was considered and rejected —
  it would block a legitimate feature instead of making it safe. This note is the precondition
  instead: **whoever enables popout owns guarding these slots first.**
- **A second `scene` tab**, or any panel id that also renders `SceneView`.
- **A throw partway through `setup()` — this WAS live, and is now fixed (#858).** The four
  arguments above are all about ordering *between* instances. They said nothing about a *single*
  instance failing mid-bring-up: `cleanup` was assigned last, so a throw after the first
  registration left `teardownViewport()`'s `fn?.()` releasing nothing and every slot registered so
  far dangling. An identity guard would not have helped — a release-side guard is inert when
  release never runs.

  SceneView now seeds `cleanup = scope.dispose` as `setup()`'s FIRST statement
  (`runtime/core/teardownScope.ts`) and pushes each release at the site that acquires it. **Scoped
  by one test — does the thing keep ACTING after the bring-up is gone?** On the scope: every
  module-level registration (the five slots, `onWorldSwap`, the render surface, the
  bounds/pick/handle providers, the invalidation listener, the dirty subscriptions, the frame
  callback), the renderer LEASE, the two loss listeners, and the six `window` input listeners plus
  the `document.body` marquee element. Still terminal-only, and deliberately: the scene graph and
  GPU objects, plus the listeners on the renderer's own canvas, which dies with it — a partial
  bring-up leaks those as memory and nothing else. Full rationale in
  [rendering.md](./rendering.md). **It was one of five sites with that shape** —
  `Scene3D`, `ParticleEditor`, `previewScene`/`Preview3DShell` and `ModelPreview` were the others,
  and the renderer LEASE leaked alongside the five slots. The class, the per-site table and what is
  and is not tested: [rendering.md](./rendering.md) § "The release path must exist before the first
  acquisition". Ordering is pinned by `tests/architecture/teardownScopeSeeding.test.ts`.

  ⚠️ This does NOT reopen #811, and **does not supply the identity guard** this section says the
  three unguarded slots still lack. The release pushed for the camera is `() =>
  setEditorViewportCamera(null)` — the same blind null-write the old closure did. A scope keys
  which RUN owns a release, not which registrant currently holds the slot, so in the popout
  scenario instance A's drain still nulls the camera instance B just set. The precondition stands
  unchanged: **whoever enables popout owns guarding these slots first.**

  ⚠️ One genuinely NEW path into the trap, small but real: those three blind slot-nulls now also run
  on a PARTIAL drain, where before they ran only when `setup()` completed.
- **Making the context-loss `rebuild` non-awaiting, or relaxing its coalescing.** `outerDisposed` is
  per-EFFECT, not per-`setup()`-RUN: a rebuild does not set it, so a superseded run has nothing to
  bail on. That is harmless today only because `rendererRecovery.ts` serialises rebuilds (`inFlight`)
  and its `rebuild` *awaits* `setup()` — so the safety the bullet above credits to SceneView's own
  guards is in fact owned by a different file. Whoever changes either owes a per-run epoch here
  first.

⚠️ **The obvious fix is wrong for `editorCamera`, and this is the trap worth carrying forward.**
It is registered TWICE — once when the orbit camera is built, and again from the viewport
controller's `toggleProjection`, with a *different* camera object each time (`activeEditorCam` swaps
perspective↔orthographic). So copying the sibling's value-identity guard would make the cleanup
refuse to clear after any toggle, leaving the slot dangling to a disposed camera for the rest of the
session — reintroducing exactly the defect the guard was added to prevent. A guard here has to key
on the **registrant** (the effect run / renderer lease), not on the value. `_pickBillboardInUI` and
`ecsObjectsRegistry` are each set once per run, so value-identity *would* work for them — which is
how a fix ends up carrying two shapes of one guard. Use owner-identity for all three, or none.

**Three more slots share the shape** and are unreachable for the same reasons, so they are recorded
here rather than as their own tickets — they would want one guard shape between them, not three:
`editor/animation/recording.ts`'s `hook` (`setRecordHook`, cleared by `AnimationEditor`'s effect
cleanup — that panel is a singleton too, but via its **own** duplicate check in `EditorApp`'s
auto-dock effect, not via `dockPanel`; see the ⚠️ above);
`runtime/input/inputSources.ts`'s `inputGate` (`setInputGate`, cleared in an `EditorApp` effect keyed
on `hmrEpoch`, whose re-runs React orders cleanup-then-effect); and `runtime/core/uiDirty.ts`'s
`_singleEditorCb` (`setEditorDirtyCallback`), which has no live caller at all — worth guarding
*before* it acquires one, since its take path drops a differing previous registrant silently.

For contrast, the guarded shapes already in the tree: `offscreenCapture.ts`'s
`unregisterSceneRenderer` (`if (current === fn)`, documented as protecting against React's
mount-before-unmount ordering), `editorJournal.ts`'s `closeActorLease` (compares the lease id), and
`materialBroker.ts`'s `registerRenderSurface` (a `Set` keyed on the object handle, safe by
construction).

⚠️ Cite these by SYMBOL, not by line (#686 / `docCitations.test.ts`). This section's first draft used
line numbers and the gate rejected all 37 of them — correctly, and pointedly: **#811's own body cited
a cleanup range that had already rotted by four lines** between filing and being picked up, which is
the whole argument for the rule.

## The unsaved-work gate — every human world swap asks first (#1419)

**Any human gesture that replaces the world or unloads the page awaits
`confirmDiscardUnsaved(action, scope)` (`scene/unsavedGate.ts`) before it acts.** If nothing that
gesture would destroy is unsaved, it proceeds silently. Otherwise it shows a **Save / Discard /
Cancel** modal listing what would be lost (owner's call: a modal, not a toast with undo and not
auto-save):
- **Save** runs `runSaveAll()`, then re-reads the causes. It proceeds only if nothing is left. A
  cancelled Save As on an untitled scene, a failed write, or a refused save (Play mode) all return
  without throwing, so trusting the save's own verdict would destroy exactly the work the human
  asked to keep.
- **Discard** proceeds.
- **Cancel**, Escape, or a backdrop click does nothing.
- **Enter** means Save, because it loses nothing.

It is the human twin of the agent ops' `guardUnsaved` (`agentEditorOps.ts`), and both read
`unsavedChangeCauses()`. **Before #1419 only the agent side existed.** An agent was refused and told
what `discardUnsaved` would drop. A human opening a scene from Assets lost the open scene's edits
without a word, and since #1409 the undo stack went with them.

**Scope is derived from the cause table, never listed** (a list here would be #972 again):
- **`'world-swap'`** counts only the causes the scene write carries (`writtenBy: 'scene-write'`,
  meaning the live primary world and the other loaded scenes). Parked asset docs, base-scene refs
  and import settings are path-keyed module state that **survives** a swap. A prompt about them
  before a scene open would warn about work nothing is about to lose.
- **`'page-unload'`** counts every cause.

| Gesture | Where it asks | Scope |
|---|---|---|
| Assets double-click on a scene, Inspector "Open Scene" | `openAssetInEditor` (both routes go through it) | world-swap |
| Assets → Create Scene | `Assets.tsx` `runCreate`, before the path picker (any `create` override replaces the world) | world-swap |
| Open a prefab for editing | `openPrefabForEditing`'s `confirmDiscard` option. It asks only about what is still dirty **after** the existing auto-save: an untitled scene or a failed save. The agent op passes no gate and refuses up front instead | world-swap |
| Prefab edit → "Back to scene" | `SceneView.tsx` `exitPrefabEdit` | world-swap |
| View → Reset Layout / Load Layout | `EditorApp.tsx` (both reload the page) | page-unload |
| AI panel → toggle renderer debugging (packaged: relaunches) | `AIPanel.tsx` `toggleCdp` | page-unload |
| Window close, quit, New / Open / Open Recent Project, View → Reload / Force Reload, update "Restart Now" | Electron main → `unsavedGateClient.ts` → the renderer's `answerUnsavedGateRequest`. "Restart Now" asks from `autoUpdate.ts` BEFORE `quitAndInstall` (on Windows the installer is spawned before the quit), and Cancel there means "Later". The install's own window close then passes the close handler (`isUpdateInstalling()`), so it is not asked twice | page-unload |

**The Electron half is two-phase, because one timeout cannot serve both jobs.** A human may take
minutes over the modal, but a **hung** renderer never answers. A gate that waited forever on a hung
renderer would make the window unclosable. So the renderer **acks** the moment the request lands,
and only the ack has a deadline:
- **no mounted editor → proceed at once.** Main asks only after the editor's first menu-structure
  push (`gateRendererReady`); a boot-error page or an editor still booting has nothing to lose,
  and asking it would add the ack wait to every Cmd+R.
- **no ack within 15s → proceed.** The deadline is long on purpose: a mounted editor that is slow
  to ack is BUSY (a scene load, a shader compile), not gone.
- **acked → wait for the human's answer with no deadline.**
- **the question can no longer be answered → proceed.** `releaseAll` runs on the window's
  `unresponsive` event, `render-process-gone`, `did-navigate` (a committed reload of any kind,
  including the HMR one), and `'closed'`/a project switch (`failPendingRenderer`). ⚠️ Not
  `did-start-navigation`: that also fires for navigations that never replace the document (one
  `will-navigate` blocks, a download, a 204), and clearing readiness there made the next quit skip
  the prompt — observed on Electron 43.2. The first
  cut released only on the last two. An HMR reload under an open modal then left the question
  pending forever, and every later close and quit was silently dropped (#1419 review).

Before asking, main restores, shows and focuses the window. The modal renders inside it, so a Dock
Quit on a minimized or hidden window would otherwise ask a question nobody can see.

The two View reload items are custom menu items rather than Electron's `reload`/`forceReload`
roles, because a role cannot ask. A startup-failure quit (`quitExitCode` set) skips the gate.

**One prompt at a time.** A second request while the modal is up is **refused, not queued**. For
example, a window close or a quit during an Assets-open prompt is dropped, and the human repeats it
after answering the modal already on screen. A Save that throws counts as "stay", with a toast.

**Deliberately not gated:**
- The HMR game-code reload. It has its own countdown banner with Cancel (#850); it is a code
  change, not a gesture, and a blocking modal there would stall the agent that wrote the code.
- Crash-recovery and error-boundary reloads, and the dev-only self-HMR reloads.
- Every agent op. They keep `discardUnsaved` and never see the modal. The agent ops that swap
  the world are `load_scene`, `new_scene`, and `modoki_prefab` `edit-open`/`edit-exit`; `edit-exit`
  gained its refusal in #1424.

**Known limits:**
- The **browser-hosted** editor (Chrome, no Electron) has no `beforeunload`, so closing its tab is
  still silent. A `beforeunload` cannot be added naively: under Electron it would silently block
  the reloads that main has already gated, and in the browser it would pop a native dialog over
  the HMR reload's own countdown.
- A scene load that **keeps** a dirty base scene carries its edits across the swap (#1417), but
  which bases the target keeps is only known once `SceneManager.loadScene` has read the target's
  base chain. So the gate still counts every dirty base (`dirtyScenes`) as lost. The result is at
  most one prompt more than needed, never one fewer.

**Adding a new world-replacing gesture:** await `confirmDiscardUnsaved('<verb phrase>', scope)`
before it acts, at the HUMAN entry point, not inside a function the agent ops share. The decision
is unit-tested in `tests/editor/unsavedGate.test.ts`, main's client in
`tests/electron/unsavedGateClient.test.ts`, and the live modal in
`tests/e2e/editor-unsaved-gate.spec.ts`.

## Selection restore across world swaps

koota entity ids are scoped to their owning world, so a `SceneManager` world swap (scene
load, prefab edit, a Stop-revert) invalidates the selected id.
`editor/store/selectionRestore.ts` subscribes to `onWorldSwap` and re-attaches the whole
selection set (plus the primary) into the new world: the **fast path** looks up each
entity's `EntityAttributes.guid` (one pass per world, no name ambiguity); the **fallback**,
for entities lacking a guid, matches by name + ancestor path. Anything unresolved is
cleared. This is the same GUID-keyed mechanism that lets a Stop-revert preserve the user's
selection.

### Inside one world: selection, collapse and the bound roots follow the ENTITY (#1221)

A swap is not the only thing that breaks an id. Inside a world koota recycles an index LIFO, so a
selected entity that is destroyed and replaced (a board rebuilt during Play, an agent's
delete-and-respawn) used to leave the **newcomer** selected — outline, gizmo and Inspector on an
entity nobody picked — and the same held for a collapsed Hierarchy row and the Animation/Timeline
panels' bound root. The rule this follows is in [engine-concepts.md](engine-concepts.md) § Entity
("What to hold").

- **`editor/store/heldEntity.ts`** holds a pointer as `{ id, packed, guid, world }` and resolves it:
  the same entity → unchanged; gone, and a live entity carries its guid → **follow** it (a Timeline
  scrub or Entries row respawn, an undo respawn — owner decision 2026-09-15); gone with a guid nothing
  carries yet → **parked** (hidden, asked again); gone without a guid → dropped.
- **`editor/store/editorRefLiveness.ts`** does that for `selectedEntityIds`/`selectedEntityId`,
  `animatorRootEntityId` and `directorRootEntityId`. The readers keep reading plain ids. It runs
  ⚠️ **synchronously on every structure change** — `unregisterEntity` fires that before `destroy()`,
  so the pointer is cleared before any spawn can take the index; a once-a-frame check would leave a
  frame in which a gizmo drag writes to the newcomer — **and again a frame later**, because a seeded
  prefab respawn writes its guid AFTER its spawn's structure event (that pass may rescan, so a guid
  written without `indexEntityGuid` is followed too). A store write from anywhere else re-captures and
  forgets a parked pointer; its own writes push no undo entry.
  ⚠️ **A world swap re-takes every pointer still held in the old world — one tick later** (a pointer
  already held or parked in the new world by then is kept). A hold
  belongs to one World; a root is otherwise re-taken only when its store VALUE changes, and the
  Timeline panel's re-resolve usually lands on the same number — so without the re-take both roots
  held the pre-Stop world forever and the newcomer came back after the first Stop. It waits a tick
  because `stepSimulation` swaps out and back inside one call: re-taking at the swap held the
  transient world's entities and a destroy there unbound the Animation panel. The price is a one-tick
  window after a real load in which a bound root's destroy-and-respawn is not caught.
  ⚠️ **While any durable guid is parked, the frame-later pass can rescan the world** once per frame
  in which `EntityAttributes` is added or written (`findEntityByGuid`'s gate; ~0.13 ms per 1k
  entities, [engine-concepts.md](engine-concepts.md) § Entity identity). Accepted: it is what lets a
  guid written without `indexEntityGuid` be followed.
- **Selection undo** (`editorStore.ts` `resolveSnap`) resolves a durable guid first, then a HOLD
  taken at capture when it belongs to the current world (undo history survives a CLEAN same-scene reload and
  A→B→A — a discarding one drops it, [scene-loading.md](scene-loading.md) #1409 — and another world's number means nothing here) — never the bare raw id, which re-selected whatever took a destroyed entity's index
  (the capture keeps durable guids only, so that reached every runtime spawn). A primary that is gone
  falls back to the last remaining member.
- **Hierarchy collapse** holds each id while it is in the set and re-resolves the holds before every
  tree rebuild (`holdCollapsed`/`reconcileCollapsed` in `hierarchyCollapse.ts`). A collapsed entity
  that is gone but has a DURABLE guid is parked, so an undo respawn comes back collapsed, and a parked
  guid is still persisted — otherwise a game system destroying a collapsed scene entity during Play
  re-saved the scene's collapse set without it, and Stop restored it expanded. ⚠️ The reconcile runs
  inside a `setCollapsed` updater and must stay PURE: React runs an updater twice in development and
  keeps the second result, and the first version wrote the holds from inside it — the newcomer stayed
  collapsed in the running editor with every unit test green (found by the live check).

### Hierarchy collapse restore — the swap must SCHEDULE its own restore (#839)

Expand/collapse is per-user view state, so it lives in `localStorage` keyed by scene path and by
`EntityAttributes.guid` (a runtime id does not survive the swap). The load/save pair and both
decisions live in `editor/panels/hierarchyCollapse.ts`; `Hierarchy.tsx` keeps only the wiring.

- **The panel restores from a SETTLED refresh, never from inside the `onWorldSwap` handler** —
  `getCurrentScenePath()` is still the pre-swap value at that instant, because `loadScene` writes
  it in its own tail after `sceneManager.loadScene` resolves (`scene/serialize.ts`). A restore run
  synchronously on the swap would key the new world's tree to the OLD scene's saved set. For the
  same reason the restore waits while **`aSceneSwapIsHappening()`** (`editor/scene/playMode.ts`)
  is true. ⚠️ Ask that, never "do the two scene paths agree" — every writer of the editor path
  other than `loadScene`'s tail leaves it diverged from `sceneManager` **indefinitely** (Save As,
  Assets → Create Scene, the boot restore), and so does a load that throws after the swap, so a
  path comparison is not "not settled yet" but "never settled" — it would shut the restore and the
  save gate for the rest of the session, which is #839 itself by another route. (Create Scene was
  in that list until #853; it now sets the editor path *before* its swap and clears
  `loadedScenes`, so it no longer diverges. Save As and the boot restore still do, which is why
  the rule stands.)
- **⚠️ But the swap handler must SCHEDULE that settled refresh itself.** It used to leave the job
  to `onStructureDirtyCoalesced`, which fires on `registerEntity` — and `loadSceneFile` registers
  the incoming scene's entities into the **staging** world *before* the swap, while `SceneManager`
  marks nothing structure-dirty after `setCurrentWorld`. So for any scene loaded after boot, no
  settled refresh ever followed the swap: collapse was neither restored nor saved for the rest of
  that scene, and the first entity the user created finally ran the restore and overwrote whatever
  they had collapsed. Structure-dirty is the late-spawn **backstop**, not the primary path.

⚠️ **The set is owned by a WORLD, not by a scene path.** The save gate and the restore trigger both
compare `getCurrentWorld()` against the world the set was restored for. Keying them on the *path*
looks equivalent and is not: `saveScene()` changes the path with **no swap and no structural
change** (`serialize.ts` — both the Save-As and known-path branches), so a path-keyed claim reads
"needs restore" after a plain **Save As** and the next structural change collapses the whole tree
and persists that over the user's arrangement. A world identity says the true thing — the ids are
still valid, only the file name moved — so the arrangement carries across and is saved under the
new path.

⚠️ **A world identity cannot see "same world, all-new content" — and one path used to produce
exactly that** (#853). `newScene()` deleted and respawned in place, so the owner still matched the
live world, `needsCollapseRestore` returned false, and no restore ran — while the save gate stayed
open, seeding the new scene's entry from the old scene's leftovers. That hole is closed **at the
source** rather than here: `newScene()` now replaces content through
`SceneManager.replaceWorldContent()`, so the swap is real and this machinery sees it like any other.
See [scene-loading.md](./scene-loading.md) § "Replacing every entity IS a world swap".

⚠️ **Keying the in-memory set by guid instead of runtime id would NOT have made this section
redundant**, and #853's body argues that it would — so the correction belongs here, where the next
reader will be. A guid-keyed stale entry is inert on *read*, which is real: nothing renders wrongly
collapsed. But the set would still hold the outgoing scene's guids, `shouldPersistCollapse` would
still be true, and the first toggle in the new scene would write those guids under the **new**
scene's path. That is not harmless: it consumes the "never seen" sentinel `computeRestoredCollapse`
depends on (a MISSING entry means collapse-all-by-default), so the new scene permanently loses that
default. Guid keying still needs a restore trigger that fires on this path — which is the defect —
so it is hardening, not a replacement for the ownership machinery.

`hierarchyCollapse.test.ts` pins the decisions; `e2e/editor-hierarchy-collapse.spec.ts` pins the
wiring, including the Save-As case and the Create Scene case (reverting either turns it red). The
mechanism class is written up in [async-lifetime.md](./async-lifetime.md).

### Revealing the selected row — a reveal is a REQUEST, not a changed value (#1156, #1143)

Both tree panels un-collapse whatever hides the selected row and scroll it into view when a
selection asks to be shown: a new lead from any source, or an explicit request. **Neither may
key that reveal on the selected VALUE alone.** Re-selecting the entity or asset that is already
selected changes no value, so an agent asking to reveal a row that a human has collapsed since
would get nothing back. That was measured on both panels: the same select again showed 0 rows;
clearing the selection first and then selecting showed 1.

- **Hierarchy** reveals on a changed lead, a collapse restore (`collapseEpoch`), or an explicit
  request: the store's `entityRevealRequest` counter, bumped by `requestEntityReveal()`. Only the
  writers that MEAN "select this" call it: the agent `set-selection` op (`agentEditorOps.ts`), a
  plain or Shift viewport pick (`applyPickSelection`, decided by `pickRequestsReveal` in
  `scene/pickSelection.ts`), a UI-preview pick and a Bone2D handle pick (both in `SceneView.tsx`).
  Undo/redo, a Cmd/Ctrl-click toggle, the delete folds and a hand collapse do not request, so
  **while the lead stays the same** they leave the tree as the user set it. Any write that MOVES
  the lead still reveals, whatever its source: undoing back to an entity under a collapsed parent
  re-opens it. The decision is `isRevealRequest` (`editor/panels/hierarchyFolders.ts`), and the
  scroll effect follows a reveal tick rather than every selection write.

  ⚠️ **The request cannot be inferred from the selection diff — two attempts proved it.** Keying on
  the `selectedEntityIds` array identity revealed on a Cmd-click that trimmed the set. A refinement
  ("a new array that drops no member is a request") revealed on UNDOING that trim, because undo
  restores the superset, and it never revealed a plain viewport click on the lead of a
  multi-selection, because `[4,3] → [3]` with lead 3 is exactly what a trim publishes. Both were
  found by the close-out reviews. A new selection writer that should reveal must call
  `requestEntityReveal()`; one that should not must leave it alone.
- **Assets** keys on the `selectedAsset` OBJECT identity through `createStoreSelectionTracker`
  (`editor/panels/assetReveal.ts`). The agent op creates a new object per call, so it reads as a
  request. The panel needs own-marks because its effect also re-syncs a LOCAL multi-select that
  its own publishes must not collapse. ⚠️ Because any new `selectedAsset` object is a request there,
  a writer that republished it on a timer or a structure refresh would undo a human's collapse; none
  does today.

`hierarchyFolders.test.ts` pins the decision. `hierarchyReveal.test.tsx` pins the wiring on both
sides: a same-id re-select with the request reveals and scrolls, and so does a pick on the lead of a
multi-selection. A Cmd-click trim, and the undo of one, neither re-open a manual collapse nor
scroll. The writers' side is pinned by `engine/tests/editor/setSelectionRevealRequest.test.ts` (the
agent op, through `runAgentOp`) and `pickSelection.test.ts` (`pickRequestsReveal`). The UI-preview
and bone-pick calls are one-liners in `SceneView.tsx` with no test.


## Asset editors

Several assets get a dedicated editor. They share one architecture: **the live def is the
single source of truth in `editorStore`**, so edits push to the **global** undo stack
(shared with Hierarchy/Inspector/SceneView) and apply even when the panel is unfocused;
consecutive same-field edits **coalesce** into one undo entry within a ~500 ms window; and an
edit is **PARKED in the dirty-asset registry**, with **Cmd+S** (Save All) as the only write.

⚠️ That last clause used to read "persistence is a debounced `/api/write-file` (~400 ms)", which
**#259 removed** — the panels no longer autosave. The flush goes through `/api/asset-write`, which
also re-seeds the relevant runtime cache so any live entity referencing the asset updates next
frame. See `useParkedAssetDoc`'s docblock for why dropping the debounce was a fix rather than a
simplification (its cleanup discarded the last ≤400 ms of edits on unmount).

#### A failed read yields NO document — never `{}`, never `defaultX()` (#886/#896)

**The invariant: an asset editor that cannot READ its document must hold nothing and disable
editing.** Not an empty object, not a typed empty shell, not the factory default. The panel's
editing surface is gated on that document (`{clip && …}`, or a `commit` that early-returns on a
null def), so refusing is enforced by construction rather than by a flag threaded through every
field — the shape `ParticleEditor` and `AtlasAssetView` already use.

**Why it is an invariant and not a judgement call.** These panels persist through `dirtyAssets` →
`/api/asset-write`, and a panel-origin flush sends `replace: true` — a FULL REPLACE that
deliberately skips that route's dropped-field guard. A fabricated document is therefore not "a
slightly wrong starting point"; it is the file's next contents. Five panels had it, with two
different consequences:

| Fabrication | Panels | What the flush destroyed |
|---|---|---|
| `defaultX(newGuid(), name)` | `AnimationEditor`, `TimelineEditor` | the document **and its GUID** — the fabrication carries an id, so `/api/asset-write`'s preservation branch (`!out.id && prevDoc?.id`) never fires and the file is replaced by one wearing a DIFFERENT id. The scanner's heal pass cannot flag it (the document looks complete), so every reference to the old guid dangles silently |
| `{}` / `{ clips: {} }` / an empty rig | `MaterialBatchView`, `SpriteAnimEditor`, `SkinEditor` | every field except `id`, which survives |

⚠️ **A MISSING file is not a failed read, and collapsing the two is the other way to get this
wrong.** For a genuinely absent file — a brand-new asset, or a stale ref — defaults ARE the correct
content, and refusing there makes the asset unauthorable. That distinction is why
`classifyAssetDocFetchFailure` (`editor/panels/assetDocLoad.ts`) returns a verdict rather than a
boolean, and it is why the fetch **must** go through `parseAssetJson`: Vite answers an unknown path
with `200 index.html`, so "absent" and "corrupt" arrive at the same `.catch` and a raw `r.json()`
cannot tell them apart. `MaterialBatchView` was exactly that caller and could not have classified
its own failure if it had wanted to.

⚠️ **"Did not come back" is not "is not there", and asking the wrong one of those reopens the whole
defect.** `parseAssetJson` throws `MissingAssetError` for EVERY non-ok status, so `isMissingAsset` is
true for a **500 on a file that exists** — and the first cut of this fix asked exactly that, which
left `AnimationEditor`/`TimelineEditor` fabricating `defaultX(newGuid())` over an unreadable file for
that entire error class. Two predicates, two questions:

| Predicate | True for | Ask it when |
|---|---|---|
| `isMissingAsset(e)` | the SPA fallback, and **any** non-ok status | you will show nothing (eight readers do this, and it is right for them) |
| `assetIsAbsent(e)` | a 404/410, or the SPA fallback | you will **substitute content** — write defaults, mint a GUID, treat the path as free |

The producer is not hypothetical: `plugins/backend/writeResult.ts` answers 500 when
`createReadStream` errors on a file `existsSync` has just confirmed — EMFILE under a scene-load
fan-out, EACCES, EBUSY on Windows — and `electron/backendServer.ts` adds a catch-all 500 on the same
call. Both substitution callers (`assetDocLoad.ts` and `scene/modelImportPersist.ts`, whose
`'absent'` verdict MINTS a GUID) ask `assetIsAbsent`; `modelImportPersist` had the same defect
pre-existing and was fixed in the same pass. An unknown status fails CLOSED — not absent — so a
mock that means 404 has to say so.

**Not a park-time guard, deliberately.** The `.meta.json` SIDECAR registry solves its half of this
class with a tag on the document, refused at the write seams (`scene/metaReadFallback.ts`, #880).
That shape is right there — 18 spread sites, no single load helper — and wrong here: the fabricated
document reaches the editor store and the live preview *before* any park, so a park-time refusal
would let a human keep editing a fabricated clip and only complain N edits later at Cmd+S. Each of
these panels has exactly one load effect, so the failure has a single place to be named.

Guarded by `tests/architecture/assetEditorRefusesUnreadableDoc.test.ts` (the corpus is DERIVED from
`useParkedAssetDoc(`, so a sixth editor is covered the day it is written). ⚠️ **That guard proves
the classifier is CALLED, not that both branches are handled** — the verdict's own two-sided
behaviour is `packages/modoki/tests/editor/assetDocLoad.test.ts`, and the batch view's
exclusion/write halves are `tests/editor/materialBatchLoad.test.ts`.

**Retrying a refused load is `reloadEditingAsset`, never `open<X>Editor` and never a local nonce.**
Both alternatives were shipped and both were wrong, in opposite directions — a local nonce re-runs
the load effect but cannot get past its `if (existing)` early return, so Retry adopts whatever
document happened to land in the store, with no further check; `open<X>Editor` does null the
document, but also clobbers `isPreviewPlaying`/
`previewOwner`/`playheadTime`, which are SHARED between the Animation and Timeline panels and which
`closeAnimationEditor`/`closeTimelineEditor` guard with `panelMayStopPreview` for that reason
(#810). **A re-read is not a re-open**, and the two open actions that reset preview state are
exactly the two whose close actions guard it. `reloadEditingAsset`'s docblock lists what each of the
five open actions actually resets — they differ, and the first version of that docblock generalised
from one of them and was false of three.

⚠️ **Nulling the document removes that early return; it does NOT guarantee a disk read** — and five
docblocks plus this section said it did until #896's fourth review. The next branch is
`pendingAssetDoc`, which adopts a PARKED document before any `fetch`, deliberately: a park is
unsaved work newer than the file, and re-reading over it is the destruction #831/#843 and
QA-CTX-0008 are about. Every agent op parks (`persistOrMarkDirty` is unconditional under manual
persistence) and so does a redo — the two cases the old wording named as what a re-read PREVENTS —
so "Retry re-reads the file" holds only when nothing is parked for that path. A refused panel's
instruction to the human must say so, or repairing the file and clicking Retry silently yields the
parked document instead, and Cmd+S then writes it over the repair.

⚠️ **A store-level test cannot see whether a PANEL is wired to it.** `reloadEditingAsset` had a
complete five-row table and a passing test while `ParticleEditor` was still on a local nonce — a
table can be complete and a panel still broken. The panel half is a source scan
(`tests/architecture/assetEditorRefusesUnreadableDoc.test.ts`), over the same corpus derived from
`useParkedAssetDoc(`, because the panels are `.tsx` and this repo does not mount those.

⚠️ **`SkinEditor`'s fallback is EMPTY by owner ruling (#423 item 2) and stays that way** — a
phantom `root` bone would claim content the file does not have. That ruling is about what is
DISPLAYED and is compatible with refusing (a refused load shows nothing either); what changed in
#896 is only that the empty rig is no longer SAVABLE, which is the thing the ruling was actually
guarding against.

#### The client write seam — one JSON body producer, one wrapper (#835)

The editor serialises scene/prefab/asset-document JSON **client-side** and POSTs the finished
string to `/api/write-file` — unlike `/api/asset-write`, which parks an OBJECT and lets the
server produce the bytes (`assetJsonBytes`, `editorBackendRouter.ts`). Before #835, every
`/api/write-file` JSON call site spelled out its own `JSON.stringify(x, null, 2)`, and none of
them appended the trailing newline the committed corpus (and `assetJsonBytes`) carries — 537
committed `.scene.json`/`.prefab.json` files lost it this way.

**`jsonFileBody`** (`editor/backend/editorBackend.ts`) is the client mirror of the server's
`assetJsonBytes` — the one place a JSON document's final bytes are composed. **`writeAssetFile`**
(same file) is the one write wrapper: it POSTs `content` to `/api/write-file` completely
unchanged, so a JSON caller must run `jsonFileBody(data)` first and a binary caller passes its
base64 string with `encoding:'base64'` — the function itself does not know or care which. Every
JSON call site now reads `writeAssetFile(path, jsonFileBody(data))`; the five near-identical
wrapper functions #835 replaced (`serialize.ts`'s `writeFileToServer`, this module's own prior
duplicate, a third copy in `modelImport.ts`, `writeAssetFileOrAbort`, and an inline `post` lambda
in `ModelAssetView.tsx`) are gone.

**Binary writes (base64) never touch `jsonFileBody`** — appending a newline to an
extracted PNG texture, or a converted GLB corrupts the asset. Two sites deliberately keep their
own raw `backendFetch('/api/write-file', …)` call rather than routing through `writeAssetFile`:
`scene/modelImport.ts` (its texture-extraction write only —
the material/mesh JSON writers in the same file DO route through the wrapper), and
`scene/convertToGLB.ts`. `tests/architecture/clientJsonWriteSeam.test.ts` enforces the split: no
file outside the wrapper reaches the route directly unless it is on that file's EXEMPT ledger,
scanned against the ROUTE STRING rather than the `JSON.stringify` pattern (which is exactly what
let four real call sites hide from the original bug report's grep).

`AtlasAssetView` is not on this seam at all — since #831 it parks an object through
`/api/asset-write` and the server produces the bytes, same as the debounced asset-editor
persistence below. It is the template for "hand the server an object" where that shape fits; the
five editors below stay on `/api/write-file` because each already had its own write plumbing this
commit chose not to restructure further.

⚠️ **A GAME's editor panels write asset documents too, and they reach the engine ONLY through the
public barrel** — a game is copied out of the repo, so it may not import
`editor/backend/editorBackend.ts` by a relative path (portability, #29). While the barrel exported
raw `backendFetch` and nothing else, the one definition of a document's bytes was unreachable from
the only place still spelling its own, and `games/sling/editor/{Level,Wave}Editor.tsx` duly
reproduced the pre-#835 shape — hand-rolled `JSON.stringify`, no trailing newline, all four of
their committed `.level`/`.wave` files churning on every save.

So **`jsonFileBody` and `writeAssetFile` are exported from `@modoki/engine/editor`**, and both
sling call sites go through them. The general rule: a helper that games must not bypass belongs on
the public barrel, or the export list itself becomes the reason the defect recurs outside the
engine.

#### The binding is a PATH, so every file move must update it (#186)

The five binding editors — Particle, SpriteAnim, Skin, Animation, Timeline — each hold
`editing<X>Asset`, and the debounced write above targets **that path**. So any operation
that moves or removes the file without telling the panel makes the next edit write to the
*old* location, and because a write SUCCEEDS, nothing reports it:

- **Delete** → the file you moved to the trash comes back on the next edit.
- **Rename / move** → the asset **forks**. Measured on `games/timeline-demo`: renaming a
  bound timeline and then editing it re-created the old file with the new content while the
  renamed file kept the old. Your edits go to a zombie; the renamed asset silently stops
  receiving them.

`panels/assetEditorBindings.ts` owns the repair, and the rule is **delete unbinds, move
repoints** — a moved asset survives (its GUID and `.meta.json` sidecar travel with it), so
the binding is repointed via `remapEditingAssetPath` rather than reopened: reopening
re-fetches from disk and would discard the in-memory doc, which after a rename is the newer
of the two.

⚠️ **"Binding" undersells what `applyAssetPathMoves` repairs.** It started as the five
`editing<X>Asset` fields and has grown every time something else turned out to be path-keyed:
the **parked writes** and their **`ifMatch` CAS baselines** (#259), the **flushed-record maps**,
**`currentFolder`** (#854) and the **Inspector selection** (#867). Anything else keyed by asset
path belongs here too, not at a call site — including `expanded` and `pendingFolders`, which were
remapped by hand at three of the thirteen sites until #867's own review pointed out that they were
never out of reach: `assetFolderState.ts` holds them at MODULE scope with exported setters (its
header says they **must not** go back into `useState`, #309), and this module already imported
`remapCurrentFolder` from that very file. `remapFolderSets` now runs in the seam with everything
else. What stayed at the call site is `commitFolderRename`'s `.add(newPath)` — keeping a renamed
folder open is a property of that gesture, not of the repair.

**⚠️ The call sites are NOT the contract any more (#867) — the MOVE carries the repair.**
This section used to read *"six call sites, and they are the whole contract"*, and both halves
of that were wrong by the time it was written: there are **13 direct call sites** (5 in
`Assets.tsx`, 8 in `assetUndo.ts`) plus `unbindDeletedAssetEditors` wrapping it for 4 more, and
enumerating them was never going to hold. Three sites failing the same way is a **missing seam**,
not a longer to-do list:

- **`modoki_move_asset` could not call the repair AT ALL.** The MCP server is a different
  *process* from the renderer. So `POST /api/move-file` — the one place a move actually happens —
  now calls the renderer back through `ctx.requestBrowser('apply-asset-path-moves', …)`, the same
  server→renderer RPC ~20 other routes use, already abstracted over Vite HMR and Electron IPC. It
  swallows a missing renderer on purpose: a CLI move has no in-memory state to repair.
- **A dragged FOLDER built an exact-path move**, so `applyMove` returned `undefined` for every
  descendant. `planFilesDropMoves` (`utils/assetPaths.ts`) is now the pure planner and sets
  `prefix` from whether the thing is a folder — asked of the tree per path, because a
  multi-selection drag carries ONE payload for many. `DropMove` carries `prefix` through undo and
  redo; reversing a prefix move is still a prefix move.
- **The route is the only party that can tell a folder from a file** on the agent path — the
  client passes two strings and they look identical. `statSync().isDirectory()`.

The panel still repairs synchronously when *it* is the mover, and that is not redundancy:
**ordering is load-bearing** — the registry must be repaired before the selection moves, because
`AtlasAssetView`'s load effect keys on the selected path for its CAS baseline. Applying a move
twice is a no-op (`applyMove` matches on `from`, and after the first pass nothing is at `from`),
so the route's call is a safe backstop for every caller that is not the panel.

Each undo/redo closure still gates its remap on the move actually succeeding: `/api/move-file`
409s when the destination exists, and repointing a binding at a path the file is *not* at is the
forking bug itself. A copy/paste is deliberately absent — it creates a new file and leaves the
original in place, so nothing bound has moved.

The sweep lesson that produced the old list — *"grep for the behaviour, not for one helper's
name"* — is what the seam retires. It was good advice for a repair wired to call sites, and it
still failed twice: the first version wired only `executeDeletion` and missed four, and a
follow-up sweep for `moveFileTo` missed `handleFilesDrop` because it uses the sibling helper
`moveFile`. **A repair you have to remember to call is one you will eventually not call.**

Folder matching is **segment-boundary**, not `startsWith`: renaming `/assets/anim` must not
capture `/assets/animations/…`. Adding a sixth binding editor means adding a row to
`ASSET_EDITOR_BINDINGS`; a panel that forgets it gets this bug back with no new symptom.

**Known gap, accepted:** `useDebouncedSave` cancels a pending write on unmount, so closing a
panel within ~400 ms of an edit drops that write. Because closing a tab keeps the binding
(below), the store holds the newer doc and the next edit re-saves it — the loss only
materializes across an editor restart.

#### Closing a panel KEEPS its binding, but drops the flags it owns

Deliberate, and the opposite of the delete case above: reopening an asset editor lands back
on what you were editing. (FlexLayout renders a tab lazily but keeps it mounted once shown,
so merely *switching* tabs never unmounts a panel — only a real close does.)

What a closed panel must **not** keep is state naming a live recorder or preview that no
longer exists. `AnimationEditor` already dropped the record HOOK on unmount but left
`isRecording` true, and `TimelineEditor` already tore down its preview SESSION but left
`isPreviewPlaying` true — a toolbar reading "recording" for a panel you closed, and
`get_editor_state` reporting it to agents as truth. Both now clear in the unmount cleanup
that was already there, with **empty deps** so dragging a tab between tabsets re-mounts with
the flags down rather than tearing out the binding.

#### Guard: an editor-store action with no caller is a dead feature

`tests/architecture/editorStoreActionsReachable.test.ts` fails when any function-typed
`EditorState` member is never called outside the store. This is the repo's dominant
"unreachable mechanism" shape (see [CLAUDE.md](../CLAUDE.md)) caught at the cheapest possible
place, because *"was this ever called?"* is statically answerable.

It exists because `skinWeightView`/`setSkinWeightView` had **zero** callers for their whole
life, so the SceneView weight view could not be turned on at all (#181 — the branch was
correct, the button simply did not exist). On its first run the guard found three more
(`closeAnimationEditor` / `closeTimelineEditor` / `closeParticleEditor`), which is how the
asset-binding bug above was found. The check is permissive on purpose — any reference
outside `editorStore.ts` counts, including from a test — and it excludes its own file from
the corpus, since naming an orphan in an allowlist would otherwise launder it.

### The asset Inspector — six rules that have each failed repeatedly

The Inspector's asset view (`Inspector.tsx`) is the door to everything above: it renders a
per-kind branch, and for any kind it does not recognise it prints "No actions for `<type>`
assets". Every one of the rules below went wrong in a way nothing failed on, so each is now
enforced rather than remembered.

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

**3. An asset preview keyed on the PATH cannot see a re-import (#294).** A re-import is
precisely the gesture that rewrites the bytes behind a path *without changing the path*, so a
`resetKey={path}` (or a `useEffect` on `[path]`) never fires and the panel keeps showing the
pre-reimport asset with nothing saying so — the shape of bug that makes someone re-do an
export three times believing it did not take. `MeshPreview` shipped that way; `MaterialPreview`
happened to escape it only because it is keyed on serialized `data` it receives as a prop, not
because anyone reasoned about re-imports.

The signal a path cannot carry is **`useAssetInvalidationEpoch(kind, matches?)`**
(`editor/panels/useAssetInvalidationEpoch.ts`), a counter over the re-import event the asset
caches fire; `useModelInvalidationEpoch()` is the model-only spelling of it. Fold it into the
`resetKey` (`MeshPreview`) or the effect deps (`MeshAssetView`). Two things about it are
load-bearing:

- **Cache-busting is a separate problem from re-rendering, and `ModelPreview` needs both.** It
  fetches the baked `.glb` over HTTP, so even a re-run effect would replay the browser's cached
  copy of an unchanged URL. `cacheBustReimport(url, epoch)` appends `?reimport=<n>` — with the
  `blob:`/`data:` carve-out `withCacheBust` makes for the same reason (a blob URL is matched by
  UUID, so a query suffix 404s the model). The engine's own `withCacheBust` still cannot serve
  here, but the reason narrowed in #1022: it keys on the manifest CONTENT HASH, and a re-bake of
  an unchanged source leaves that hash alone. (It used to be "PROD-and-content-hash only"; the
  PROD half is gone, so the bust now applies in the editor too — just not on the axis this needs.)
  `reimport=<n>` moves per re-import, which is exactly the axis that does.
- **The epoch coalesces on a trailing 250 ms timer, and that is not cosmetic.** ONE Import click
  fires `invalidateModel` for the same model **three** times — measured on `games/sling`'s
  `ramp_wedge`, 2 ms apart then 32 ms later (it invalidates before re-deriving templates, again
  around prefab regeneration, and once at the end). Uncoalesced, each bump costs a subscriber a
  full GLB refetch and re-parse, so the fix would buy correct pixels at 3x the work on exactly
  the large models where that hurts. Verified live: three invalidations, one refetch.

Prefer a **filtered** epoch (`targets` names the model plus its baked LOD siblings) wherever the
consumer knows its own model path, so an unrelated re-import does not refetch a multi-MB GLB.
`MeshPreview` cannot: mapping a `.mesh.json` back to its source model is only possible through
the very `meshAssetCache` entry the invalidation is about to delete, so it bumps unfiltered and
pays one cheap clone-from-cache rebuild.

**4. The same staleness in the sidecar-derived STATS (#303 + #304).** #294 fixed the previews;
the numbers beside them had the identical bug with a different trigger. `ModelAssetView` and
`TextureAssetView` re-read `/api/read-meta` on mount and after their OWN import button only, so
a re-import fired from the Assets panel's "Re-import all", a batch view, or the agent bridge
left every sidecar-sourced value showing pre-reimport data — source tris, LOD byte sizes, the
LOD count, texture variant sizes, and the `converted` / `hasCache` flags, which gate UI rather
than merely display it. Once #294 landed, the Model Inspector actively disagreed with itself:
fresh geometry in the preview, stale numbers beside it.

Fixed by **one shared event** rather than a second mechanism: `runtime/core/assetInvalidation.ts`
(L0, imports nothing, so any L3 cache can emit through it without a cycle) carries
`emitAssetInvalidated(kind, path, targets)` / `onAssetInvalidated(fn)`, and `invalidateModel`,
`invalidateTexture` and `invalidateAudio` all fire it **before** evicting. `onModelInvalidated`
survives as a `kind: 'model'` filter over it, so its renderer subscribers
(`scene3DSync`, `SceneView`) are untouched. The alternative — mirroring a texture-only listener
onto `invalidateTexture` — was rejected because `audioBufferCache` already documented itself as
mirroring `invalidateTexture`, making a third parallel one-off the default outcome.

The panel side is deliberately NOT a bare effect dep. The epoch cache-busts the `/api/read-meta`
URL through `cacheBustReimport`, so it is a value `loadMeta` genuinely reads: the sidecar is
rewritten **in place at an unchanged URL**, which is exactly the request a browser may replay
from cache. That also sidesteps the `exhaustive-deps` "unnecessary dependency" warning honestly,
instead of suppressing it or poking it with a tautology. The self-initiated import path reads
the sidecar twice as a result (once explicitly, once via the epoch) — one coalesced call
returning the same bytes.

Also corrected here: `invalidateTexture`'s doc comment claimed its callers "then reload the
active scene", which is why a listener was never thought necessary. None of its four call sites
reloads anything.

**5. The same sweep found the chain broken for AUDIO and HDR entirely, in three places.** The
server registers re-import handlers for **seven** types (texture, model, atlas, audio, video,
font, environment) and only two of them were ever evicted browser-side. Three independent gates
each hard-coded `model | texture`, so widening any ONE of them would have changed nothing:

1. `assetViews/reimport.ts` — the client path (Assets panel "Re-import all", batch views).
2. `/api/reimport` in `editorBackendRouter.ts` — filtered the items before pushing them to the
   renderer, so the MCP/curl path never even reported an audio or HDR bake.
3. the `invalidate-assets` agent op — branched on the same two types again.

And underneath all three, `invalidateAudio` was a **silent no-op for its only production
caller**: it resolved every ref through the manifest, and `resolveRef` rejects an internal asset
path, so the Audio Inspector's Apply button (which passes the path) evicted nothing. Re-encoding
a clip left the game playing the OLD decoded buffer, and re-importing an `.hdr` left the viewport
lit by the old environment, until an editor restart.

Now: the route forwards **every** baked type and the op is the single place that decides which
kinds hold a cache, so a new kind is one branch in one file. `font` is deliberately not one of
them — it refreshes through `onFontInvalidated` in `assetManifest`, a manifest-hash channel both
font caches already subscribe to — and `atlas`/`video` hold no engine-side cache at all (atlas
frames are read off the manifest; a video streams from its URL). A test in
`tests/plugins/reimportNotify.test.ts` asserted the OLD filter, on the stated grounds that a clip
is "not a GPU cache the renderer keys by path"; `audioBufferCache` is keyed by path, so that
premise was simply false and the test was defending the bug.

**6. A panel that writes the WHOLE document must prove it still has the whole document.**
`AtlasAssetView` builds the entire `.atlas.json` from a copy it read when the panel opened.
Nothing tells it the file changed underneath — `assetsVersion` is keyed on paths, not content
(see § "A panel that reads `getAllAssets()` must subscribe to `assetsVersion`" above), and
`atlas` is not a `SceneChangedKind`, so the watcher's `dropParkedWriteFor` never fires for it
either. A `.atlas.json` altered on disk while the panel is open (a `git checkout` under a live
editor, which CLAUDE.md names as a real hazard) was silently reverted by the next padding nudge,
with nothing erroring (#439).

The guarantee is a **compare-and-swap**, and it now travels with the parked write. The panel
hashes what it loaded into `baselineHash`, parks it alongside the document as
`DirtyAsset.ifMatch`, and `flushDirtyAssets` sends it as `POST /api/asset-write`'s optional
`ifMatch` precondition (a sha256 hex of the expected current content). The server compares
against the file's actual current hash and only then writes — synchronously, with no `await`
between the compare and the write (`ifMatchRefusal`, shared with `/api/write-file`), so there is
no gap for a second write to land in. A mismatch, or the file not existing, 409s with no write.
`ifMatch` is optional and absent means an unconditional write, unchanged for every other caller.

⚠️ **#831 made this window LONGER, not shorter, which is why the CAS survived the change.** The
panel used to write on every control interaction, so the read-to-write gap was one keystroke; it
now parks and Cmd+S is the write, so the gap is however long the human takes to save. What did
NOT survive is `createAtlasWriteQueue`: it existed (#469 review finding 1) to stop this panel's
own overlapping writes self-inflicting a 409 on each other, and parking is synchronous and
last-write-wins in a `Map`, so there are no concurrent writes left to serialize. That claim is
asserted rather than argued — `tests/editor/atlasParksNotWrites.test.ts` drives N rapid edits and
pins ONE pending write, the LAST document, the ORIGINAL baseline, and zero network calls.

**A conflict is now a fork the human resolves, not a discard.** The old flow dropped the losing
edit and reloaded from disk, which was proportionate when the edit was one control change; after
#831 a conflict lands on a set of unsaved edits, so discarding them silently would be the larger
data loss. `flushDirtyAssets` leaves the entry parked and records why (`getAssetFlushError`), and
the banner offers both exits explicitly — **Discard & reload** (`discardDirtyAssets`) or
**Overwrite on save** (`clearAssetIfMatch`, which drops the precondition). The CAS exists to
prevent a SILENT overwrite; a deliberate one is the human's call.

History, so the shape is not re-derived: #439's original fix did the compare client-side — read,
compare, then write as two separate calls — which closed the `git checkout` race but left a
narrower one open between two rapid edits; #469 moved the compare-and-write into one atomic
server-side operation on `/api/write-file`; #831 moved the whole write onto the registry, so the
precondition moved to `/api/asset-write` with it and the client-side queue went away.

⚠️ **A record keyed by a PATH must follow the path when the file moves (#854).** The registry is
four path-keyed maps — `dirty`, `lastFlushed`, `lastFlushedHash`, `flushErrors` — and a rename
originally repaired one of them, incompletely. `applyMovesToParkedAssets` re-parked a moved entry
with `markAssetDirty(to, doc.type, doc.data, doc.origin)` and no fifth argument, so `data` and
`origin` survived the move and **`ifMatch` did not**. That turned the compare-and-swap off for the
rest of the session, silently and with no banner: the panel re-seeds `baselineHash` from
`peekDirtyAsset(path)?.ifMatch` on its parked-doc branch, which was now `undefined`. Park an atlas
edit, rename the `.atlas.json`, and the `git checkout` hazard this whole section exists to close was
back — on the one view whose ONLY protection is the CAS, which is exactly the argument used to
justify not giving `atlas` a `LiveReloadKind`.

Two things made it survive review. `markAssetDirty` documents that an omitted `ifMatch` **preserves**
whatever the destination key already carried, which is correct for all six same-path re-park callers
(`adoptParkedDoc`, the agent ops, `useParkedAssetDoc`) — `applyMovesToParkedAssets` is the only
CROSS-path re-park in the tree, and it is the one place where "preserve what is at this key" and
"carry what came from the other key" are different answers. And the suite already pinned
`origin` surviving a move, which reads as coverage of the tuple; it was one field short.

The fix threads `doc.ifMatch` through, which is sound because a rename does not change bytes
(`/api/move-file` is a `renameSync`), so the hash captured at `from` still describes the file at
`to` — including a case-only rename on a case-insensitive FS, where the inode is the same entry.

Two ordering invariants hold this together, both load-bearing and neither obvious:

- **`remapFlushedAssetRecords` runs BEFORE the discard loop.** `discardDirtyAssets` calls
  `forgetFlushedHash`, which is right for an edit being DISCARDED and wrong for a file merely
  MOVING; remapping first makes that call a no-op and the record survives at `to`. This is also the
  only repair that reaches a path with NO parked write — `applyMovesToParkedAssets`' own loop
  iterates `getDirtyAssetPaths()`, so it structurally cannot see one, and those entries were
  stranded forever under a filename that no longer existed.
- **`applyAssetPathMoves` runs BEFORE `selectAsset`** in the Assets panel's rename. `selectAsset` is
  what re-points the Inspector, and `AtlasAssetView`'s load effect is keyed on that path — it reads
  the parked entry to recover its baseline. Repairing the registry first means the panel cannot
  observe a half-repaired state. This was never a live bug: both calls are synchronous, so React's
  automatic batching guarantees no render interleaves. The order is structural so the invariant does
  not rest on that.

`flushErrors` is deliberately NOT remapped: an errored path is always a dirty path, and a dirty path
that moves is discarded (which clears its error), so it has no orphan case.

⚠️ **The repair is wired to CALL SITES, not to the move — so it covers the Assets-panel rename and
not every way a file moves.** This is the honest scope, and an earlier draft of this section (and of
`liveReloadKinds.test.ts`'s atlas exemption) asserted the opposite as settled fact. `applyAssetPathMoves`
is client-side, and every caller has to remember to call it with the right arguments:

- **`modoki_move_asset`** POSTs `/api/move-file` and nothing else. It runs **out of process**, so it
  cannot call the repair at all — the fix has to push a move notification to the renderer, or move
  the repair server-side. A parked atlas edit survives as a park keyed to a dead path; Cmd+S then
  409s against a file that no longer exists, and the only forward exit recreates it at the old path.
- **A dragged FOLDER** sets `isFolder: true` in the drag payload and `handleFilesDrop` never reads
  it, so it builds an exact-path move with no `prefix`. Nothing under the folder is repaired —
  `applyMove` returns `undefined` for every child.
- **Inspector SELECTION** is re-pointed by `handleRename` alone; the cut/paste, drag-drop and
  undo/redo move paths leave it aimed at the old path, and nothing self-heals when a selected path
  vanishes from a refreshed listing.

One mechanism — *the client repairs a move per call site instead of the move carrying its own
repair* — so it wants one fix across all three, not three patches. Tracked as #867.

⚠️ **The remap's own trap, found by reviewing the fix.** `remapFlushedAssetRecords` first
snapshotted each map's KEYS and then read each VALUE live inside the walk — so a chained move
`[A→B, B→C]` set `B` to A's record, read that back on the second hop, carried it to `C` and deleted
`B`. One record destroyed, the other misattributed. Its comment claimed plan-then-apply prevented
exactly that, which snapshotting keys alone does not buy.

⚠️ **Snapshotting ENTRIES is not the fix either, and that was the first prescription.** With key
AND value captured up front, the second hop's DELETE of `B` still lands after the first hop's WRITE
to `B`, so `B` ends up empty rather than holding A's record — the same bug wearing a different
symptom. It takes the full two-phase shape `applyMovesToParkedAssets` already uses one layer up:
plan every `(from, to, value)` triple, delete every source key, THEN set every destination. No
caller passes a chained move today, so this pins the shape rather than a live bug — which is
precisely why it survived a green gate and four mutation checks aimed at other lines.

⚠️ **Why this panel and not its siblings — and the answer is narrower than it first looks.** An
earlier version of this section said the other views were covered because "their types are all
`SceneChangedKind`s, so an external change drops their parked write through
`dropParkedWriteFor`". **That is false for two of them.** `material` and `shader` are absent from
`LiveReloadKind`/`SceneChangedKind` (`vite-asset-scanner.ts`, `agentBridge.ts`) and
`classifySceneChange` has no case for either, so `MaterialAssetView`, `ShaderAssetView` and
`MaterialBatchView` park whole documents with **no** baseline and **no** watcher drop — #439's
defect on three more views. That is **#842**, whose fix is to derive the watcher classification
from `ASSET_SCHEMA_TYPES` rather than to give each view its own baseline. So the honest scoping is:
the atlas carries a compare-and-swap because it needs one INDEPENDENTLY of #842, not because it is
the only view at risk. See [mcp-persistence.md](./mcp-persistence.md) § "5. The dirty-asset
registry — the ONE path from an asset edit to disk".

**But parking is not itself the protection — that was always a second mechanism, and #842 showed
it can be silently absent.** A parked write is only dropped as stale by `dropParkedWriteFor`
(`engine/app/debug/agentBridge.ts`), which fires ONLY off a `modoki:scene-changed` broadcast,
which fires ONLY when the changed file's type has a `LiveReloadKind`
(`classifySceneChange`, `engine/plugins/vite-asset-scanner.ts`). `material` and `shader` had no
`LiveReloadKind` at all until #842, so `MaterialAssetView`/`MaterialBatchView`/`ShaderAssetView`
parked their edits with **no staleness protection whatsoever** in that window — an external
change to the same `.mat.json`/`.shader.json` (an agent's `write_asset`, a `git checkout`)
would never be noticed, and the stale parked edit would win at the next Cmd+S.

So there are now **two independent mechanisms guarding the same hazard**, and a reader should not
conflate them: `AtlasAssetView` alone parks WITH the compare-and-swap `ifMatch` precondition
(#439/#469, above; #831 added the park) — its protection is checked server-side at write time.
Every OTHER Inspector asset surface — the five panels and the four views — parks WITHOUT one and
relies on watcher-driven park-drop instead, which is checked at edit time but depends entirely on
the kind being watched. **The rule to take away: absent a compare-and-swap, parking a write
protects it only if the file's kind carries a `LiveReloadKind` — adding a type to the parkable set
with neither silently removes the guarantee**, exactly as it did here for two full types across an
entire release window.

⚠️ Still uncovered by either mechanism: `.meta.json` sidecars are invisible to `detectType`
(`vite-asset-scanner.ts`, the `relPath.endsWith('.meta.json')` branch) — see #845. **So a sidecar
gets a THIRD mechanism rather than either of these two: an explicit gate that asks the renderer
before the write** (#872/#882). The watcher-driven park-drop that protects `modoki_write_asset`
cannot fire for a sidecar, and `/api/write-meta` sends no `ifMatch` of its own, so neither of the
two mechanisms above was ever going to reach it. Read side, CAS half and write side are all closed
now (#872/#871/#874/#882); the gate, why it must not fail open, and the three routes it covers are
in [mcp-persistence.md](./mcp-persistence.md) § 5.

⚠️ **And being watched is not the same as being invalidated WELL.** Adding a kind to
`LiveReloadKind` makes the broadcast fire; what the matching `ASSET_CACHE_INVALIDATORS` entry then
does with the path it is handed is a separate question, and `invalidateShader` answered it by
throwing the path away and clearing every compiled 2D material program (#852). Rule and the two
traps that come with it (an unresolved key is UNKNOWN, not absent; fire the waiters you evict):
[mcp-persistence.md](./mcp-persistence.md) § "Wiring a kind into the table is only HALF the job".

Why it stayed invisible: `AtlasAssetView`'s own header notes the page preview "refreshes after a
Re-pack via the watcher's manifest broadcast" — and it does. **Derived** data (the `.meta.json`
pages/frames block, surfaced through the manifest) refreshed correctly, while the **authored**
source document did not. A panel that visibly updates is the worst place to hide a stale read.
(#439's sibling #430, on the failed-READ half of the same panel, has no separate write-up here —
it shipped with code + tests + one QA case only.)

⚠️ **A BOM defeated three of `/api/asset-write`'s guards at once** (found 2026-09-07 while moving
the atlas write onto that route). `prevText` was read as `readFileSync(abs, 'utf-8')`, BOM
included, and `JSON.parse` rejects that — so the format-version classifier called the file corrupt
and **refused every write to it forever** (`400 could not be classified (unparsable)`), `prevDoc`
fell to `null` so the dropped-field guard passed anything, and id preservation was skipped, which
lets the scanner's heal mint a fresh GUID and dangle every reference to the old one. Type-agnostic
and pre-existing: a Windows-authored `.mat.json` hits it identically, which is CLAUDE.md's
recurring Windows class surfacing on a Mac-only gate. Fixed by reading through `stripUtf8Bom`, the
same helper the `ifMatch` hash already used to agree with the browser's `Response.text()`.

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
- **Preview envelope + ⏹ Exit Preview** — a scrub, a ▶ preview, **or any clip edit** (every path
  that poses; see `pose` in `AnimationEditor.tsx`) opens a snapshot session
  (`editor/scene/timelinePreview.ts`, shared with the Timeline panel) and sets run-mode
  `scrub`/`preview`. The pose writes authored traits, so a scene save inside the envelope would bake
  it — which is exactly what happened before the clip-edit path opened one.
- **An asset-doc edit must not dirty the SCENE.** Every undo entry a panel pushes for a
  `.anim/.particle/.timeline/.spriteanim/.rig2d/.mat/.shader/.animset` edit carries
  `_isFileDirect: true` (`editor/undo/undoManager.ts`), so it does not bump the scene's
  edit-version — its unsaved state is the dirty-asset registry's job, or (for the Inspector's
  asset views) already on disk. A falsely-dirty scene is not cosmetic: it self-blocks the
  file-direct agent routes, makes `modoki_build` refuse, and makes Cmd+S interrupt a preview to
  rewrite a scene nothing changed. The agent twins have set it since S2.27; the panels did not
  until this was found by the Cmd+S work.
- **Cmd+S inside the envelope does not refuse; it works.** Three outcomes, in the order the save
  checks them (`editor/scene/saveCommand.ts`):
  - nothing needs an authored world — the scene is clean AND this is not a prefab-edit world (the
    common case while authoring a clip) → **only the parked asset docs are flushed**, the preview is
    left alone. No reload, no flicker, and no rewrite of a scene file that did not change.
  - the scene was CHANGED inside the envelope → **the scene save is refused**, and the toast says
    why. Exiting would restore the snapshot and revert those edits; a save must not destroy work to
    make itself possible.
  - otherwise → **exit → save → resume** at the same playhead (`PreviewSaveHandler`), so the save
    serializes authored data and the animator keeps their frame. Costs one world reload; if the
    owning panel closed mid-save, the toast says "preview ended" rather than resuming into it. **⏹ Exit Preview** reverts to the authored snapshot, re-resolves the
  Animator root (the reload reassigns entity ids) and returns to `stopped`, which re-enables saving;
  unmount / clip-switch do the same. Without it the panel wedged saves with no way out but closing
  the tab. (The old caveat — "poses made OUTSIDE the envelope open no session" — is retired: a clip
  edit's re-pose now opens one like any other pose, and MCP `set_playhead` moves the playhead VALUE
  without posing at all, answering `posed:false`.)
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

⚠️ **Exactly ONE view is mounted, and they do not publish the same handles** — `curves:key:*`
and the tangent handles `curves:tan:in|out:*` (kind `'tangent'`) exist in Curves ALONE. So which
view is showing decides what `modoki_handles` can see at all, and the default is Dopesheet:
`modoki_handles editor=curves` comes back empty until the view is switched, which reads as *"this
clip has no tangents"* rather than *"you are looking at the wrong view"*. The choice therefore
lives in the **editor store** (`animationViewMode`), not in `AnimationEditor` local state, so it is
agent-drivable — `modoki_set_animation_view_mode {mode}` sets it and `modoki_get_editor_state` reports
it back (#369). Same move, and the same reason, as `sceneViewMode` gating the Collider2D handles.
Setting it does not open, reload, or reset a clip; `modoki_open_animation_editor` does (it clears
the loaded document and resets the playhead to 0), which is why the view is a separate call rather
than a parameter on the open.

⚠️ **The view is NECESSARY BUT NOT SUFFICIENT for the tangent handles, and that second gate cost
this fix a wrong verdict.** `CurvesView` publishes `curves:tan:*` for the **active track only**
(`if (ti !== s.activeTi) return`), and `activeTi` falls back to the sole visible curve — so with no
track selected it resolves *only* when the clip has exactly one numeric track. Measured on a live
editor: `fade-in.anim.json` (1 numeric track) gave 2 keyframe + **2 tangent** handles after the
switch; `dialog-pop.anim.json` (2 numeric tracks), same view, nothing selected, gave 5 keyframe +
**0 tangent**. The first measurement was taken as proof the fix worked, and it passes under both
"curves is enough" and "curves plus a one-track clip is enough" — a reminder that a perturbation
has to be able to come out the other way. Selecting a track is therefore part of the agent route:
the `TrackList` rows carry `data-ui-id="animation.trackList.row.<i>"` with
`data-ui-state="selected"` on the active one, so `modoki_handles {editor:'chrome', kind:'row'}`
lists them and `modoki_tap_handle` picks one. They are **tagged rather than lifted into the store**
on purpose — a tap runs `onSelect`, the same path a human takes (entity selection included), where
an op writing a store field would have to reimplement it and could drift.

`modoki_get_editor_state` reports both gates under `animationView`: `panelMounted` (an Animation
tab that exists in the layout but was never SELECTED does not mount — FlexLayout renders tabs on
demand — and then *neither* view publishes handles) and, in curves, the active-track caveat. A
`kind:'tangent'` list is also legitimately empty on the first key (no in-tangent), the last key (no
out-tangent), a stepped key, and any non-numeric track, which is never drawn at all. Lifting it also means the view now survives the panel being
unmounted/reselected within a session; it is deliberately NOT persisted across launches.
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

**Saving is manual, in this panel and the four other asset editors** (Animation, Timeline, Skin,
SpriteAnim). An edit parks its document in the dirty-asset registry and **Cmd+S writes it**; the
status text next to the asset name says `Unsaved ●` or `Saved ✓`, and there is no Save button
because Save All is the one save. They autosaved on a 400 ms debounce until #259 — see
[mcp-persistence.md](./mcp-persistence.md) § 5 for what that cost and why the registry is now the
single path from an asset edit to disk.

### Sprite Editor

`editor/panels/SpriteEditor.tsx` — Unity-style **sprite slicing** for a texture in
"multiple" mode, opened as a modal from the Texture Inspector. It shows the source image on
a zoom/pan canvas with editable slice rects, seeded three ways: a **grid** (by count or by
cell size, with offset/padding), **auto-detect by alpha islands** (threshold slider), or
**hand-drawn** rects (create / move / resize via 8 handles / pivot / rename / delete). It
persists `sprites[]` + `spriteSheet` (and the `spriteGrid` / `spriteAlphaThreshold`
controls) into the texture's `.meta.json`, and live-registers each slice as a `'sprite'`
manifest entry so it can be referenced from `Renderable2D.sprite`. One undo step captures
the full slice set **and** the slicing parameters. Its fields commit on EVERY keystroke, so a
run of them coalesces into that one step via `panels/coalescedEdit.ts` — opened on the first
change and closed by an idle timer or by anything else that touches the history, **never by a
focus event**, which does not fire in an unfocused window (#244; the class, and how to test it,
is in [editor input](./editor-input.md)). See [Materials & Textures](./textures.md).

**A resize moves each edge the grabbed handle OWNS by the pointer's travel since the press, clamped
to the sheet** (`resizeSliceRect` in `panels/sliceDrag.ts`; the Nine-Slice guides use
`dragNineSliceGuide` beside it) (#1176). It used to set the rect from the pointer's ABSOLUTE
position against the opposite handle's point, which failed twice on an edge-to-edge sheet
(`catvader_1`, 252×392, measured):
- a side handle drove the axis it does not own: `e`'s opposite point is the mid-left edge, so a
  horizontal `e` drag gave `{y: 195, h: 1}`;
- a corner snapped to wherever the press landed, and every error pointed up-left. A far-edge
  handle is published 0.72 CSS px inside its canvas (`clampHandleToOwner`), `MouseEvent.clientY`
  is an integer, and Enact rounded its intermediate moves. So a purely horizontal `se` drag
  shaved a bottom-row slice's height, `392 → 389`.
Travel makes all of that irrelevant, because a drag that did not move on an axis cannot change it.
The clamp is widened to include where the value started (`clampFrom`). A slice already partly
outside the sheet (after a texture is re-imported smaller, or a W typed past it, since the rect
fields do not clamp) or Nine-Slice insets loaded unclamped from a meta that no longer fits therefore
move inward by the pointer's travel, and a drag outward leaves them where they started. A plain clamp snapped them inside on the first
jitter: a nudged `{x:1100, w:8}` became `{x:1008, w:100}`. The body's move drag (`moveSliceRect`)
follows the same rule.
The canvases read POINTER events (fractional) and keep the drag alive past the canvas (the capture
bullet under SceneView above). The `move` drag always carried its grab offset. Live coverage:
QA-ASSET-0025 steps 5 and 5b.

> **A `.meta.json` write REPLACES the file — every writer must read-modify-write.**
> `/api/write-meta` → `writeMetaSidecar` → `writeJsonAtomic(sidecarPath, committed)`: no merge with
> what is on disk, deliberately (it also has to split the local-only cache keys out into
> `.meta.local.json`). So a writer that posts a fragment destroys everything else in the sidecar.
> Both **postprocessor** controls did exactly that — `Inspector.tsx`'s single-asset dropdown and
> `ModelBatchView`'s batch one, each posting a bare `{version: 1, postprocessor}`. On a real model
> (`demos/forest-camp/.../char_Ranger.glb.meta.json`, keys `version, id, rig, generated,
> modelCache`) picking a postprocessor left `{version: 1, postprocessor}`, losing the asset's
> **stable GUID** — so every scene and mesh ref to it dangles and the next scan mints a new one,
> which re-importing cannot repair — plus the `generated` cleanup list (orphaning its derived
> meshes/materials), the `rig` block and the LOD `modelCache`, and downgrading `version` 2 → 1.
> The batch view did it to every selected model per click. Both now merge into the sidecar they
> loaded, like every other writer already did. A literal that does NOT spread is legal only when
> it authors a COMPLETE sidecar including `id` (the model-import path in `ModelAssetView`);
> `engine/tests/editor/metaMergeNotClobber.test.ts` encodes exactly that rule. Found by the
> close-out sweep of the 9-slice work, not by a report — the post succeeds, the UI updates, and
> the damage sits in a file nobody re-reads until much later.

> **`version` is the sidecar's FORMAT version, and `writeMetaSidecar` owns it — writers must not
> supply one** (#734). The pattern every versioned document in the repo follows, and the decision
> table it belongs to, is [format-versioning.md](./format-versioning.md). It says how the `.meta.json` document is laid out, not anything about the
> asset it describes. Every write THROUGH `writeMetaSidecar` stamps `SIDECAR_FORMAT_VERSION`
> (`plugins/meta-sidecar.ts`), so a caller that passes `version` is ignored; a caller that omits it
> is correct.
>
> ⚠️ **`writeAssetGuid` is not the only writer outside `writeMetaSidecar`** — the complete list of
> four is `writeAssetGuid` (writes via `vite-asset-scanner.ts`'s own `writeJsonAtomic`), the two
> `.meta.json` generator scripts (`gen-white-hdr.mjs`, `gen-skinned-test-models.mjs`), and
> `tools-scratch/spine-import.mjs`. None of them inherit `writeMetaSidecar`'s stamp or its refusal
> automatically. **Calling
> `assertSidecarWritable` alone is NOT sufficient** — a writer that refuses but never stamps
> `SIDECAR_FORMAT_VERSION` still leaves an unstamped document behind, which is the same downgrade
> risk (#734) wearing a different face. The actual rule for a writer outside `writeMetaSidecar`:
> it must BOTH stamp `SIDECAR_FORMAT_VERSION` and, if it can overwrite an existing sidecar, call
> `assertSidecarWritable` (or an equivalent refusal) first. Every known sidecar writer overwrites
> an EXISTING file — `gen-white-hdr.mjs` and `gen-skinned-test-models.mjs` both rewrite a tracked
> `.meta.json` on every run (reading the old one first to preserve `id`) — so all of them owe both
> halves.
>
> It was written by 14 sites and **read by nothing** until #734, and ten of those sites stamped a
> literal `2` over whatever was already on disk — so a sidecar written by a build with a newer
> format was silently downgraded in place. That is not hypothetical: the postprocessor incident
> above downgraded `version` 2 → 1 alongside the GUID loss. The stakes are the sidecar's contents —
> the stable GUID every scene and mesh ref resolves through, the Texture-Inspector import settings,
> and the Sprite Editor's hand-drawn slices with their own per-slice GUIDs. **None of it is
> regenerable**, so "just reimport it" was never a recovery story: a reimport regenerates the files
> listed under `generated`, not the authored state beside them.
>
> ⚠️ **A too-new sidecar makes the write REFUSE, loudly.** `writeMetaSidecar` throws when the
> on-disk `version` is strictly greater than this build's, writing neither the committed sidecar nor
> `.meta.local.json`; `/api/write-meta` surfaces that as a 500 carrying the message.
> `assertSidecarWritable` is the same check exported for callers that want to fail before doing
> work — `/api/reimport` calls it per asset, INSIDE that asset's own try/catch, so a refusal on one
> asset is recorded into `summary.errors` and the loop CONTINUES to the next asset; the route still
> rebuilds the manifest and sends `invalidate-assets` afterward. **Deliberately not [PlayerPrefs' shape](./player-prefs.md)**:
> that one warns and silently does nothing, which is right for a save read at boot with nobody
> watching, and wrong for an action a human just triggered in the editor and is waiting on. The cost
> is accepted — on a branch older than the format bump you cannot reimport that asset until you
> merge.
>
> ⚠️ **The `version: 2` literals still in the seven panel writers are INERT BUT LOAD-BEARING — do
> not tidy them away.** They no longer affect what is written (the server stamps it), so they read
> as dead weight. But `tests/editor/metaMergeNotClobber.test.ts` finds a meta-write literal by
> searching for `version:\s*\d`, so they are that detector's anchor: strip them and every one of its
> per-file assertions matches an empty set and passes **vacuously**. A liveness test in that file
> turns the cleanup red rather than silently green; if you genuinely need them gone, re-anchor the
> detector on the `writeMetaOrWarn(` / `'/api/write-meta'` call instead of deleting the test.

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
asset editors above — which park their document for Cmd+S (#259) — each discrete edit here
persists IMMEDIATELY via `persistAssetEdit` (against the file **and** the material cache) and
pushes its own undo entry. The cache and the panel update optimistically, before the write is
known to have landed, so the viewport reflects the edit at once; a write that then FAILS is
reported (console + a warn toast) and the edited value is deliberately left live rather than
reverted — the next edit rewrites the whole file, so editing again is the retry. Alongside it, `MaterialPreview.tsx` renders the material on a **lit IBL sphere**
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

**The e2e suite has to report its own completeness, because a SHORT run reports green.** It once
printed `17 passed (1.9m)` instead of 46 — exit 0, zero failures. A subset that reports success is
strictly worse than a red run: it sails through the pre-push ritual looking like a pass. The root
cause was found only by trying to start the dev server by hand and getting "port already in use" on
a port believed free — an **orphaned Vite dev server** was bound to the e2e port and
`webServer.reuseExistingServer: true` silently **adopted** it, then that adopted server died partway
through the run. That is why the failure point moved between runs (test 38, then 13, then 5) and why
the symptom alternated between a truncated run and a cascade of `net::ERR_CONNECTION_REFUSED`.
Measured on one commit and tree: adopted orphan → 41 failed / 5 passed; port cleared first → 46
passed, exit 0, clean teardown. Fixed by `reuseExistingServer: false` on the dedicated port — the
suite would rather fail loudly than adopt a server it cannot vouch for. **What creates an orphan is
still unknown**; the leading theory is a run killed by a signal (a `| head` closing the pipe, a
timeout, a Ctrl-C) leaving `npm run dev`'s child vite behind when the npm parent dies.

`engine/tests/e2e/runCompleteReporter.ts` catches the class regardless of cause: a run that reports
success while covering only part of the suite FAILS. Two checks, and the second is not redundant —
every discovered test must actually have run, **and** at least `EXPECTED_MIN_TESTS` must have been
discovered, because if discovery itself comes up short the first check is trivially true.
`MODOKI_E2E_MIN_TESTS=n` for a deliberate subset. Implementation note: `process.exitCode = 1` does
**not** work in a Playwright reporter (Playwright assigns its own exit code after reporters finish),
so the guard returns `{ status: 'failed' }` from `onEnd`. The `46`s above are the 2026-07-29
incident's numbers and stay as narration — **today's floor is `EXPECTED_MIN_TESTS`, currently 54,
matching 54 discovered specs.** Read the constant, never a count copied out of prose; growing the
suite without raising it is how the guard quietly loosens.

**Per-worker dev servers are the real fix for the serial cost, and are deliberately low priority.**
(Why the suite is serial at all — 4 workers contending on the one shared dev server, failing
nondeterministically — is in CLAUDE.md's e2e section.) The ceiling was estimated at ~1.7m: fixed
dev-server boot ≈30s + the then-46 tests ÷ 4. So ~3m/run at best, minus whatever 4 concurrent Vite + backend + chokidar
instances cost each other in I/O and RAM, against the cost of replacing `webServer` with a
worker-scoped fixture plus per-worker teardown.

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

**That guard was necessary and not sufficient — it is TIMING, and timing lost the race (#190).**
It can only catch a child that has *already* exited, and the numbers are lopsided: a server
that is already running answers in <50ms, while a freshly-spawned Vite takes ~2s to reach its
bind and die. So on every project switch the check ran early, saw a live child, accepted the
stale server, and main logged `dev server up (project B)` **17ms** after spawning — about
somebody else's server, still rooted at project A. Nothing looked broken: the editor showed B,
the renderer loaded A's `game.ts` and A's assets, and saves landed in A's tree. The only visible
symptom was the allowed-roots error above, once again naming the wrong cause.

How a stale server got there is the other half, and it was pure bookkeeping. `stopDevServer`
resolved the instant `taskkill` returned rather than when the child exited, so on Windows the
predecessor's `exit` arrived *after* the replacement had been spawned — by which time the
module-global `intentionalStop` had been reset to `false` and was describing the wrong process.
The dead child's handler therefore logged a spurious "dev server exited unexpectedly" **and**
nulled `child`, orphaning the live Vite. The next switch had nothing to stop, so the old server
kept the port and the new one died on `--strictPort`. First switch fine, every one after it wrong.

The fix replaces timing with **identity**, and is in three parts (`devServer.ts`):

| Part | What it closes |
|---|---|
| `intentionallyStopped` (a `WeakSet`) + `exitDisposition` | a superseded child can no longer clear state that now describes its replacement |
| `stopDevServer` awaits the real `exit` | the port is actually free before the respawn |
| `/api/dev-server-identity` + `probeDevServerPort` | the server on the port must BE the one we spawned |

The identity route is served by the asset-scanner middleware and answers `{modoki, pid, ppid,
projectRoot, repoRoot}` — deliberately ahead of the shared `/api` router, because the answer is
about *that process* and the same route mounted in the Electron host would describe the wrong
one. It is checked twice: before spawning (what already holds the port?) and inside
`waitForServer` (is the pid on the port the pid we spawned?).

Because the pre-spawn check can end in a **kill**, two conditions gate it and both must hold:
`repoRoot` must match this install (never take a port from another clone — the rule
`reapScoping.test.ts` enforces for `pkill` patterns applies just as much to a pid a process
hands you), and the server must be *unowned* — its `ppid` either dead, or equal to our own pid,
which is the lost-child case. A second live editor of the same install is refused and named,
not reclaimed. Anything that will not identify itself is refused too: "nothing is listening" and
"something is listening that isn't ours" demand opposite actions, so `probeDevServerPort`
returns a tri-state rather than a nullable identity.

Which failure maps to which state is load-bearing, because `empty` authorises a spawn and
`foreign` refuses one. **Only `ECONNREFUSED` proves the port is free.** A *timeout* means the
connection was accepted and the answer never came — something is there, hung — so it is
`foreign`; filing it under `empty` would send the caller into an occupied port, where
`--strictPort` kills the new Vite and the editor reports "not reachable" about a port that is
plainly answering. That is #190's own failure mode one layer down, which is why the mapping is
spelled out rather than left to intuition.

If the route's payload ever drifts from `parseDevServerIdentity` (a renamed field, a dropped
`ppid`), every probe returns `foreign` and the editor **refuses to launch** with "answering …
but not as our dev server". Loud and immediate, on the first launch after the change — which is
why the two readers of this payload are left as independent checks rather than given a
sync guard.

⚠️ **A leaked Vite does not survive its editor on Windows** — measured: killing the main process
took its Vite with it (Electron's job object), so the damage there is confined to a session. On
macOS/Linux there is no job object and an orphan really can outlive its editor, which is what
`reclaimLeakedDevServer` (called at startup, before `findFreePort`) is for. Letting
`findFreePort` politely drift around a squatter instead would leave it running with its asset
scanner still **watching the repo**, rewriting `.meta.json` sidecars under a project nobody has
open — the write-behind-your-back hazard of root `CLAUDE.md` #18, self-inflicted.

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

### Verifying a CDP attach is actually YOUR clone

`MODOKI_CDP_PORT=9222` (or any derived CDP port) does not guarantee the resulting page belongs
to your clone — with several clones running, the port you asked for can already be held by a
sibling, and a probe against the wrong page silently drives someone else's editor. Verify before
trusting the attach:

1. `curl http://127.0.0.1:<cdp>/json` and read the page URL back — its Vite port must be your
   clone's (cross-check with `lsof -nP -iTCP:<vite-port> -sTCP:LISTEN`: the electron process's
   command path should contain your clone's directory).
2. `curl http://127.0.0.1:<vite-port>/@fs/<absolute path to a file you just edited>` and grep for
   your new code, to confirm the CDP page is actually serving your bundle and not a sibling's.

**HMR does NOT re-run `installEditorTestBridge`** — it is captured once at startup, so a newly
added `devTestBridge` method is not CDP-callable until the page gets a full reload/navigate, not
just an HMR update.

### Stopping an editor

`npm run editor:stop` (`engine/scripts/stop-editor.sh`) is the counterpart to the launcher. It
SIGTERMs this clone's Electron main process first — the editor owns the Vite it spawned and
stops it on quit, so quitting the app is what produces a clean teardown *and* lets the launch
log's background waiter write its `EXIT` line. A straggler Vite is swept only if the editor died
uncleanly. Every match is anchored to this repo's absolute paths, so a sibling clone's editor is
never touched (#69); the matcher itself is shared with the launcher in
`engine/scripts/lib/repo-reap.sh`.

⚠️ **On Windows this was a complete no-op that reported success** (found while reproducing #190).
`reap_repo_alive` returned `1` unconditionally there, on the reasoning that the Windows reap is
already a forced stop so the *polling* callers can treat it as done. True of the polling loops,
false of the guard the script opens with — `if ! reap_repo_alive MAIN && ! reap_repo_alive VITE`
— which therefore always fired: `npm run editor:stop` printed *"no editor running for this
clone"* and exited 0 while the editor and its Vite carried on serving 5173. It now answers the
question for real, via the same CIM query and the same absolute-path scoping the reap uses.

Two things that look like they should stop an editor and do not (#129):

- **`npm run dev:stop`** is for a standalone `npm run dev`. It used to kill the editor's Vite as
  well — leaving the app window up with a dead dev server behind it, which presents as *"the game
  is broken"* rather than *"something was stopped"*, and once cost a debugging session chasing a
  phantom game bug. It now identifies an editor-owned Vite by the `--configLoader runner` flag
  `devServer.ts` passes, skips it, and says so. (Guarded by
  `engine/tests/architecture/devStopEditorCarveOut.test.ts`, because that flag exists for a
  packaging reason and nothing else would notice if it went away.)
  **The tell, when an editor looks broken:** read `modoki_get_console_logs` FIRST, before
  reproducing a game-logic theory. `[vite] server connection lost. Polling for restart...` with a
  live backend but a dead Vite port means the tooling was stopped, not that the game broke — confirm
  with `curl 127.0.0.1:<vitePort>`. (The incident: the owner was *playing* with nothing unsaved when
  the dev server died, so `unsavedChanges: false` does not mean nobody is using the editor.)
- **`POST <backend>/api/exit`** 404s. `/api/exit` is a *Vite dev-server* route, so it answers on
  the Vite port (5175), not on the backend port that `MODOKI_BACKEND` and the launch banner
  advertise — aiming it at the port you were told to use cannot work.

### UI Zoom (VS Code–style)

App-wide UI zoom via Electron `webContents` zoom (`engine/electron/zoom.ts`) — Cmd/Ctrl+wheel
anywhere in the editor, Cmd/Ctrl+`=`/`-`/`0`, and native **View → Zoom In/Out/Actual Size** menu
items (`projects.ts`'s `viewRoleTail`), all routed through one controller so wheel/menu/accelerator
stay in sync. `factor = 1.2^level`, step 0.5, clamped to level ∈ [−3, +4] (matches VS Code). The
level persists per editor identity (`ui-prefs.json`, at the editor-identity dir — ⚠️ **NOT under
`userData`**, which since #1036 is keyed on the PROJECT; see `setUiPrefsDir` and
[connect-claude-code.md](connect-claude-code.md)) and restores on `did-finish-load`. A
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

### Undo outside `stopped`: Play refuses, a preview reads the entry on top (#1148)

`undoStep(direction)` (`editor/undo/undoManager.ts`) returns `{ did, refused }`; `undo()`/`redo()`
are its boolean form. It refuses, **without popping**, whenever `undoRefusedReason(direction)` is
non-null:

| Run mode | Refused | Why |
|---|---|---|
| `stopped` | nothing | the live world IS the authored scene |
| `playing` (incl. paused) | **every** entry | Stop reverts the world and truncates the during-Play entries (`truncateUndoTo`) |
| `scrub` / `preview` | a **scene edit from before the preview session** | Exit restores the snapshot. An asset-document edit (`_isFileDirect`) and a selection step are never touched by that restore, and a scene edit made *during* the session belongs to the posed world |

**Exit drops the session's own scene edits from the history.** The undo manager marks each entry with
the preview session held when it was pushed. `timelinePreview.ts` calls `setPreviewUndoSession` at
begin, before the snapshot await, and clears it at end. Right after a restore,
`endTimelinePreviewSession` calls `dropPreviewSceneEdits`. The restore already discarded those edits.
Undoing one afterwards would write a posed value into the authored scene: a recorded field edit's
`before` becomes the scene value, or a delete respawns an entity the restore already brought back,
duplicating its guid. Asset and selection entries stay.

- An end **without** a restore keeps the entries, because the world still holds those edits.
- **For the length of a restore, every undo/redo is refused** (`beginPreviewRestore` …
  `finishPreviewRestore`, decided when the step runs). The restore then awaits `whenUndoIdle()`,
  which by then only waits for a step that was already running. A step pops its entry and then
  awaits its closure (a prefab re-instantiate respawns asynchronously). Without both halves, an
  entry could be off both stacks during the drop. The step then pushed it back and applied its edit
  to the restored world, whether it was running when Exit was pressed or queued a keystroke later.
- The scene path is re-checked **after** that wait, so a scene opened meanwhile never has the old
  snapshot loaded over it.
- The mark stays on **until after the drop**, and a second end during the restore does not clear it.
  An edit pushed while `loadScene` is awaiting lands in the world the swap discards, so it has to be
  dropped too.
  A *pose* during the restore used to begin a new session over the still-posed world, and its mark
  then replaced the first one's. That begin is now refused (#1167; see § Play / Stop / Pause, "A pose opens a session, or it poses nothing"), so nothing seats a
  second session mid-restore. The restoring set still holds more than one session, as a backstop.
- A coalescing chain never crosses the session boundary.

The marks are keyed to the SESSION, not the run mode, for two reasons. The Timeline ▶ begins its
session *before* entering `preview`. And the mode can reach `stopped` on either side of the restore.

The mode and the entry are read **when the step runs**, not when it was called. A step queued behind
another can be refused by what that step did, so callers read `refused` from the result instead of
pre-checking. A pre-check once reported such a refusal as `did:false`, i.e. "the stack was empty".

- **Why the preview rule reads the entry.** The first ruling refused every undo inside the envelope.
  But an Animation or Timeline clip undo **re-poses**, and a pose re-opens the envelope
  (`poseClipAtTime` → `enterScrubMode`). So one ⏹ Exit bought exactly one undo, and every Exit
  reverted the pose. #709's live run had measured the re-entry ("exit → `'stopped'`; first undo →
  `'scrub'` again"). The owner re-ruled with that known (2026-09-13).
- **The gate lives in the manager, not at the call sites.** Undo has five entry points: the
  Cmd+Z / Shift+Cmd+Z chords, Edit ▸ Undo/Redo, the ↶/↷ buttons in the Animation, SpriteAnim,
  Particle and Skin panels, and the agent `undo`/`redo` ops. Before #1148 only the first two were
  gated, and both read `getPlayState()`, which calls a preview `'stopped'`. The panels and the agent
  reached `undo()` directly, and the agent ops were ungated even during Play.
- **Human paths go through `runUndoCommand`** (`editor/undo/undoCommand.ts`), which toasts
  `refused`. The Edit menu greys each item on `undoRefusedReason('undo' | 'redo')`, recomputed on
  `onRunModeChange` and on every stack change. `onPlayStateChange` does not fire when a preview
  starts.
- **The agent ops answer `REFUSED_BY_OP`** with the same reason.
- **Tests that call `undo()` must set `setRunMode('stopped')`.** The runtime defaults to `playing`
  so a shipped game runs with no setup, which means a bare test is refused.
- `engine/tests/architecture/playStateIsNotAnAuthoringGate.test.ts` bans comparing `playState` to
  `'stopped'` in editor code outside a reasoned allowlist, because that comparison is the defect's
  shape. It shipped three times: #1122, then twice in #1148.

### Asset delete IS undoable — it is snapshot-backed, not a filesystem one-way door

`Assets` → **Move to Trash** looks irreversible and is not. `executeDeletion` calls
`collectDeletion` FIRST, which `fetch`es every path the delete covers and keeps the bytes —
text as text, **binaries base64-round-tripped** (`fetch().text()` would UTF-8-corrupt a `.glb`) —
then `makeDeleteUndo` (`panels/assetUndo.ts`) writes the whole set back on undo. The set is
`deletionPathsFor`'s output, so a model's generated meshes/materials/textures and their
`.meta.json` sidecars come back too, GUIDs intact. Folder delete has its own undo entry.

**This is written down because its absence caused a wrong bug report.** #291 was filed asserting
*"Move to Trash is a filesystem operation and undo does not cover it"* and proposed confirmation
dialogs on the strength of it. Nothing in `docs/` contradicted that. The dialogs were declined —
see `docs/todo.md` § Deferred decisions for that call and for why the one surviving
confirmation (the cross-scene move, including a reparent across scenes since #1429) is not an inconsistency.

**What undo does NOT survive is an editor relaunch** — `undoStack`/`redoStack` are module state
in `undo/undoManager.ts`. That is normal and is deliberately not treated as a defect.

**The rule that came out of it: an undo that restores less than it trashed must SAY SO.** The
empty case used to `console.warn` and return, so Cmd+Z read as working while the files sat in the
OS trash; the partial case was not reported at all. `makeDeleteUndo` now restores what it can and
`console.error`s the **shortfall**, which covers both. Two details are load-bearing:

- **The shortfall is measured against what the backend ACTUALLY trashed, not against
  `deletePaths`.** `deletionPathsFor` deliberately lists maybe-absent sidecars
  (`.meta.local.json` is gitignored and usually not on disk), so a `deletePaths` diff would name
  files that never existed and send the user hunting in the trash for them. `/api/delete-asset`
  returns `{ok, trashed, missing}`; `deleteAssetFiles` surfaces that as `DeleteFilesResult` and
  the caller threads `missing` into the undo action. It used to return a bare boolean and throw
  the rest away.
- **`redo` checks its re-delete too.** A failed re-trash left the files on disk while `refresh()`
  re-listed them, so redo read as a no-op — the same false success on the other half of the pair.

### An undo/redo that discards a failed filesystem op — the whole class (#308)

⚠️ **This class was never confined to asset delete.** The helpers are the trap: `writeAssetFile`,
`deleteAssetFile`, `moveFileTo`, `createFolderApi` and `duplicateAssetFile`
**never throw** — they catch and resolve `false`. (`mutateScene` — then in `SceneAssetView`, since
#831 in `scene/pendingBaseScene.ts` — was the one exception: it resolved `{ok:false}` for an HTTP
error but let a network-level rejection escape,
straight out of an undo closure and into the both-stacks-lost path below. It now catches too.) So ignoring the return value is silent *by
construction*, and `undoManager` pops the entry and reports success either way: Cmd+Z reads as
working while nothing happened. The forward path of the same function usually checks the return;
it was only ever the undo/redo closures that didn't.

**The reporting bar, and why it is not a throw.** A throw looks like the stronger answer — leave
the entry on the stack so the user can retry — and it is worse. It used to be worse because
`undo()` popped the action **before** awaiting `action.undo()` with no catch, so a throw skipped
`redoStack.push`, `notifyEdited`, `markAffectedScenesDirty`, `notifyUndoChanged` and the `!undo`
event: the action was lost from **BOTH** stacks while the panel still rendered it as completed,
and `serialize` handed the rejection to a caller that does not catch it. **#310 fixed that
bookkeeping** (see below), so a throw is now survivable — but the entry is still *dropped*, so a
throw still costs the user their way back. The bar is unchanged, and is #291's — report, let the
stack pop, keep editor state consistent with disk:

- **`reportUndoFailure`** (`undo/undoFailure.ts`) is the one reporter. `console.error` naming the
  direction, the action's label and the paths, always. That log is the user's only hand-recovery
  path, which is why it names paths rather than saying "the operation failed".
- **A toast on top, for a collision only.** `/api/move-file` never clobbers: it answers **409
  "Destination exists"** when something now occupies the path we were moving back to, and
  403/404/5xx otherwise. A 409 is user-CAUSED and user-FIXABLE (they recreated something at the old
  name), so it is worth interrupting them for — the console is not a place anyone is looking. A
  backend failure is not actionable, so it stays console-only.
- **`moveFileToStatus`** (`panels/assetOps.ts`) exists so that distinction is *measured* rather than
  guessed. `moveFileTo` deliberately stays a bare boolean: every existing call site uses it as
  `if (await moveFileTo(…))`, and an object return is always truthy — widening it in place would
  silently disarm each of those guards while typechecking cleanly.
- **Gate the dependent state, don't just log it.** The log is for the user; the gate is what keeps
  the editor honest. Folder rename was an ACTIVE DESYNC rather than a no-op — `setPendingFolders`
  ran unconditionally while only the binding remap was gated, so a failed undo remapped the client
  tree to `/Old` while the folder was still physically at `/New`.

**Partial-progress vs all-or-nothing is decided by the UNIT OF WORK, not by taste** — the two
shapes in this codebase are not a disagreement:

- `makeDeleteUndo` / `makePasteUndo` / `makeFilesDropUndo` cover **N independent files**, so they
  do what they can, batch the shortfall into ONE message naming every skipped path, and always
  `refresh()` — whatever *did* change must appear.
- `createPrefabFromEntity` / `makeRigPrefabAsset` cover **ONE coupled operation** — a
  `.prefab.json` plus the entities linked to it — so they are all-or-nothing. Half-applying that
  leaves the user in a state which is neither before nor after (entities un-linked from a prefab
  still on disk, or linked to one that is not).

**A batch undo must track what it actually MOVED, not replay its list.** This is the trap the
first fix walked into, and it is the same lie pointed the other way. After a partial failure the
two directions are out of step: undo moves A and B back but C's move fails, so C is still at its
forward location. Replaying the whole list on the next redo then asks the backend to move C from
a path nothing is at — `/api/move-file` answers 404 "Source not found", `/api/duplicate-asset`
answers 409 "Destination exists" — and that gets folded into the failure report as though C had
been lost. It has not: C is sitting exactly where redo wanted to put it, and the user is sent
hunting for a file that was never in danger. So each batch builder remembers which items are
currently in the undone state and acts only on those. A skip happens ONLY when the item is
already in the state that direction wants, so a genuine retry still retries.

⚠️ Two things make that state safe to keep in the closure, and both were checked rather than
assumed: `undoManager` puts an action on `redoStack` *only* via `undo()`, so `redo`-before-`undo`
is a sequence production cannot produce; and undo actions are never serialized or cloned
(`swapHistory` stores the same live objects, and the only `structuredClone` touches
`journalPayload`). If either ever changes, this state is what breaks.

**The delayed-desync case is why gating beats logging.** A `setPrefabCache` after a failed write
leaves the editor believing in a file that is not on disk: it reads correctly from cache for the
rest of the session and comes back missing on the next scene load or a fresh editor launch, which
read the FILE. The failure surfaces far from its cause.

**Every fixed site is now a framework-free FACTORY, and that is a testability constraint rather
than tidiness.** Six of these lived inside `Assets.tsx` and one inside `SceneAssetView.tsx`, and a
panel may not be mounted in jsdom to test it (§ Panels — that asserts the mock). So each undo
builder moved to a plain `.ts` module beside its panel — `panels/assetUndo.ts`,
`panels/assetViews/baseSceneUndo.ts` — taking `refresh`, the narrow React setters, or the
component's own `write` as explicit parameters. The panel keeps a one-line
`pushAction(makeXUndo({…}))`. `assetUndo.ts` already existed for exactly this reason (F6); this
extended it rather than inventing a second home.

**Deliberately left alone:** the ~15 closures in `undo/entityActions.ts` that no-op when
`ref.resolve()` returns null. That is an entity which is genuinely gone, not a discarded
filesystem boolean — and stack ordering means the entity is present in the normal case (deleting
it pushed its own undo entry, which unwinds first). The abnormal case is a world-rebuild
guid-index gap, a different bug to chase; fifteen speculative warnings would be noise.


#### The same class one layer up: a boolean that could not be false (#884)

⚠️ **#308 fixed the closures that ignored the boolean. It could not fix a boolean that was
computed from the wrong thing** — and #875 introduced exactly that, without touching a single one
of those closures.

`/api/delete-asset` reports its outcome **per path**: `missing` (never on disk) and, since #875,
`failed` (the OS refused it — a locked file, a denied ACL, a >260-char path). The wrappers
collapsed that to a whole-batch verdict computed from the **HTTP status**: `deleteAssetFile`
returned `res.ok`, and `deleteAssetFiles` hardcoded `ok: true` on any 200. A refusal answers
**200**. So every guard #308 had carefully installed was checking a value that could not be false,
and three consumers went wrong at once:

- the **Assets panel** dropped the row, unbound the editor and offered undo for a file still on
  disk — while the route, one process away, was carefully filtering its OWN half of the repair
  under the comment *"Unbinding an editor from a file that is still on disk would be the wrong
  direction"*;
- the **folder delete** pruned the tree for a folder that is still there;
- **`modoki_delete_asset`** told an agent the file was gone. That one had no backstop at all:
  `isFailureBody` short-circuits on `ok === true` **by design** (*"the route says it succeeded —
  believe its explicit verdict"*), so the shared MCP false-success guard was defeated by the route
  being wrong rather than by the guard being weak.

**The fix is a verdict per OUTCOME, not per request.** A route that answers one `ok` for two
different outcomes gives every caller a value it cannot act on:

| outcome | reply | what a caller should do |
|---|---|---|
| everything went | `ok:true`, no `failed` | the ordinary path |
| some went | `ok:true` + `failed` | reconcile the ones that went; keep the rest |
| nothing went | `ok:false` + `failed` | report it; change nothing |

#875's argument for never answering a failure here — *a 500 reads as "nothing was deleted" about
N-1 files that ARE gone* — is exactly right about the **partial** row and says nothing about the
third. When nothing went, "nothing was deleted" is simply true. It stays a **200** so `missing`,
`failed` and `manifestRebuilt` survive; `isFailureBody` handles an `{ok:false}` 200 explicitly, and
that is the shape it exists for.

**Two rules this leaves behind.**

1. **A per-path outcome list is reported in the CALLER'S OWN strings.** `failed` used to map
   through `absToAssetUrl(abs) ?? abs`, so a path that would not canonicalise arrived as an
   ABSOLUTE path in a field the renderer can only match against asset urls — the same fallback
   `/api/move-file` explicitly refuses, one size smaller. `missing`, the sibling list in the same
   reply, always echoed the input; two outcome lists in one reply that are keyed differently cannot
   be treated uniformly by anyone. The **renderer repair** keeps `absToAssetUrl` — a different
   consumer with a different correct key.
2. **Everything after a partial delete keys off what WENT.** `planDeleteOutcome` (`assetOps.ts`)
   is that split, in `.ts` so it is testable without mounting the panel. Note the asymmetry it
   encodes: a refused **sidecar** does NOT keep the asset's row, because the asset itself is gone
   and a row pointing at nothing is the mirror defect.

**What the close-out review then found — the same class, three more times.** Worth recording
because every one of them was in code the fix had already touched or should have:

- **`makeDeleteUndo`'s REDO half had the identical defect**, one layer over. `if (!res.ok)` cannot
  see a partial refusal, so a redo re-listed the refused file and read as a no-op — #291's
  complaint, reintroduced by #875's new shape. Fixing a false success on the forward path does not
  fix its twin on the undo path; they are separate call sites of the same wrapper.
- **`failed` is NOT stable across a retry, and `missing` is.** They were merged into one
  `notTrashed` set captured at construction — which is wrong precisely because the toast asks the
  human to close the handle and try again. After a successful retry the second undo skipped that
  file's write *and* dropped it from the shortfall report: a clean-looking Cmd+Z with the file
  still in the OS trash. **A filter over a per-path outcome has to be recomputed by whatever
  re-runs the operation.**
- **The route had FIVE consumers, and two searches in a row undercounted them.** `CleanupAssetsDialog`
  posts to `/api/delete-asset` directly, so no search for `deleteAssetFiles` finds it; `modelImport`'s
  orphan-prune does too, behind a bare `.catch(() => {})` that read neither the status nor the body
  — while logging `Pruned N orphan files` unconditionally and having already rewritten `generated`,
  so a refused prune stranded a file nothing would ever retry. The rule this leaves: **when a
  route's contract changes shape, enumerate its callers from the ROUTE (`grep` the url), not from
  the wrapper** — and note that the first application of that rule still missed one, because the
  fix commit said "fourth" when the answer was fifth.

⚠️ **The toast's own reachability is the platform trap, not just its testability.** `describeRefusedDeletes` is driven by `failed`, so on macOS and Linux — where a refusal is a whole-batch
throw — it produces nothing, and the human got a toast for a failed FOLDER delete and silence for a
failed FILE delete. A `!ok` fallback covers it. Naming the paths is better; saying nothing is the
defect.

⚠️ **`failed` is populated on win32 and darwin, not Linux, and the platforms genuinely disagree.**
win32's script names each refused path. darwin's Finder names none, so since #1212 A-8 `moveToTrash`
reports what is still on disk after the refusal, with Finder's own line as `reason` (the route's
`error` / `failedReason`). **Finder's delete is all-or-nothing** — measured 2026-09-17 with a
`chflags uchg` file, in both list orders: one refused item and nothing moves — so on darwin the
partial row of the table above is still unreachable, and a refusal is always the total one. An
AppleEvent timeout (`-1712`) is still a thrown failure: Finder may be mid-move, so "still on disk"
is not an answer yet. On Linux a failing `trash-put` is NOT reported at all: `moveToTrash` falls
back to `rmSync` — a PERMANENT delete — and names only the paths it refuses to remove (#883), so
`ok:true, failed:[]` there can mean "deleted, not trashed". **An empty `failed` is not evidence that
anything went to a Trash — `ok` says whether the paths are gone.** The partial toast
is therefore reachable only on Windows, pinned at the seam (`deleteAssetRouter.test.ts`,
`assetUndo.test.ts`, `assetDeleteRenamePolicy.test.ts`), with end-to-end confirmation on the `win`
clone.

---

### Undoable panel state cannot live in `useState` (#309)

The sibling of the class above, and it survived #308's sweep because it is not a discarded return
value — the call *succeeds* and still does nothing.

An undo builder's closures outlive the render that created them. So a builder handed a React
`setState` from the panel is holding a setter bound to a **fiber that may be gone**: rename folder
`/A` → `/B`, close the Assets panel, press ⌘Z. The file genuinely moves back, and that half reports
correctly — but `setExpanded`/`setPendingFolders` are bound to an unmounted fiber and
**silently no-op, with no warning** (React 19 here; the setState-on-unmounted warning was dropped
in 18 and has not returned). The mounted `useEffect` that mirrored them to `localStorage`
never re-runs either, so the stale `/B` value survives and the next mount reads it back: a phantom
`/B` node, or `/A` rendering collapsed when it was expanded.

**The fix is to move the state out of the component, not to make the setter lookup lazier.**
`panels/assetFolderState.ts` owns `expanded` / `pendingFolders` / `typeFilter` / `viewMode` at
module scope, persists on every mutation, and is read through `useSyncExternalStore`. An undo
closure then holds a **stable module function**, so it is unmount-safe by construction rather than
by discipline.

⚠️ **`assetViews/persist.ts`'s `_assetViewSetters` registry does NOT transfer here**, and the
difference is the whole reason a second mechanism exists. There the FILE + CACHE are the source of
truth and the registered setter is only a live refresh for a panel that happens to be mounted — with
none registered the write still lands and a later re-select re-reads from disk. Folder-tree state has
no file: **the sets ARE the truth**, so a registry with nothing in it drops the update and leaves
`localStorage` stale, i.e. the bug unchanged. Pick by asking *what is the source of truth* — a
setter registry when it is the file, a store when it is the state itself.

**What is NOT affected, and why it is worth knowing.** Every other Assets undo builder receives
`refresh`, which is also panel-bound and also no-ops after unmount — harmlessly, because
`Assets.tsx`'s mount effect calls `refresh()` and re-derives the listing from disk. `useExpandedSet`
(the read-only Engine + Scripts trees) has the same `useState`-plus-mounted-persist shape and is
also safe: no undo builder touches those trees. **The shape alone is not the defect** — it needs
state that is its own source of truth AND a closure that outlives the panel.

Undoing a folder *create* is a folder *delete*, so it prunes both sets, matching
`handleDeleteFolder`. `makeNewFolderUndo` pruned only `pendingFolders` until #309: the forward
`createFolder` never adds the new folder's own key to `expanded` (only its ancestor chain, so the
inline rename input can mount), but `commitFolderRename` does (`.add(newPath)`) — so
create → rename → undo → undo left a key for a folder that no longer exists. Inert, because
`buildFolderTree` builds nodes from `pendingFolders`/`diskFolders`/assets and never from `expanded`
— but persisted, so it accumulated forever. Redo deliberately does not re-add it: the forward path
never put it there.


### A throwing undo/redo closure drops the action, loudly (#310)

The sibling of the class above, and the reason its bar is "report, never throw". Split out of #308
because it needed a policy decision, not a mechanical guard.

**The mechanism.** `undo()` pops the action, then awaits `action.undo()`. Before #310 only
`_executing` was in a `try/finally`, so a throw skipped every statement after the await —
`redoStack.push`, `notifyEdited`, `markAffectedScenesDirty`, `notifyUndoChanged` and the `!undo`
event. The action ended up on **neither** stack: it could not be redone and could not be undone
again, it vanished from the panel *as though it had completed*, and `serialize` handed the
rejection to a caller that does not catch it — including the MCP `undo` op, which reported `did`
for a step that threw. `redo()` was symmetric, and identical, because the two were duplicated.

**The policy (owner, 2026-08-21): drop the action, with a loud report.** It is the same outcome
as before — the entry is gone — but deliberate and *reported* instead of silent. The alternatives
and why they lost:

| | Why not |
|---|---|
| Put it back on its own stack to retry | A closure that threw PARTWAY has already applied some of its work; ⌘Z again re-applies that half |
| Push to the other stack as if it succeeded | Keeps the stacks symmetric, but that is the original false success in a nicer costume |

**Three things must still happen on the failure path**, and each was its own bug. Whatever policy
a future change picks, these do not change:

- **`notifyUndoChanged()` fires.** The stack really did change, so a panel that skips this keeps
  rendering history that no longer exists — the part the user actually sees.
- **The journal event still fires, carrying `failed: true`.** Emitting nothing lets an entry
  disappear with no trace; emitting a bare `!undo` claims an undo that did not happen.
- **The dirty signals fire.** A closure that threw halfway HAS moved the world and we cannot know
  how far, so marking dirty is the conservative direction — under-reporting loses the user's work.

`undo()` and `redo()` now share one `runStep` helper, because they had the same bug twice.
`runStep` returns whether the step applied; `false` reaches the MCP op as `did`. The reporter is
`reportUndoThrew` (`undo/undoFailure.ts`), which **always** toasts — the two-level rule above
distinguishes a failure the user can fix from one they cannot, and this is neither: it is history
loss, worth interrupting for whatever caused it.

⚠️ **This was LATENT when fixed** — #308 closed the last live route (the base-scene field's
`mutateScene` let a network-level rejection escape; it catches now), and every filesystem helper
resolves `false` rather than throwing. It was fixed anyway because "just throw so the entry stays
on the stack" is the obvious-looking design the next change will reach for, and it did not work
until this landed.

### A step that awaits across a scene switch drops its entry too (#1575)

`swapHistory` parks the outgoing world's stacks and refills the live `undoStack`/`redoStack` **in
place** with the incoming world's. A step still awaiting when a scene load, an Exit from prefab edit
or a Create Scene swaps the history would push its entry onto the new world's stack, where a later
undo or redo runs it against a world it was never recorded on. It was latent until #1575. Apply's
undo then started reloading its snapshot under the key live when it runs (see prefabs.md § Undoing
an Apply). A skipped undo's redo then loaded the old world's snapshot under the new scene's key and
saved it into that scene's file.

So `runStep` captures a history liveness token (the shared `createTeardownToken`, docs/async-lifetime.md)
before the await. Every effective `swapHistory` and `clearHistory` invalidates it. A step whose
capture went stale is **dropped**, as a throwing one is, with a
console warning, because the world it belongs to is gone. Its journal event carries `dropped: true`.
It marks neither the incoming world edited nor its own `affectedScenes` dirty. Those are usually
scenes of the world that left, and a dirty mark on a scene that is not loaded makes the incoming
world read as unsaved: a load then refuses, and its next switch discards its history. ⚠️ A base the
incoming scene KEEPS is the exception, since its edit is still live. That, and the other windows an
unserialized undo leaves open, are #1579. An `_isFileDirect` entry is kept, because the asset file outlives the swap; `parkSurvivors`
already keeps those across a discard. The step itself still ran, and whatever it did to disk stands.
Tests: `packages/modoki/tests/editor/undoSpansSceneSwitch.test.ts`, and the scene-switch cases in
`untitledApplyUndo.test.ts` / `prefabEditApplyUndo.test.ts`.


## Quick reference

| Concern | Where |
| --- | --- |
| Editor shell / docking / layouts | `editor/EditorApp.tsx` |
| Host configuration factory | `editor/createEditor.tsx` |
| Editor state (selection, gizmo) | `editor/store/editorStore.ts` |
| Panels | `editor/panels/` (Hierarchy, Inspector, SceneView, Assets, Console, ModelPreview) |
| Trait registry / Inspector field hints | `runtime/core/ecs/traitRegistry.ts`, `engine/app/ecs/registerTraits.ts` |
| 3D gizmo | Three.js `TransformControls` (in `SceneView.tsx`) |
| UI / 2D gizmo | `editor/panels/UIResizeOverlay.tsx`, `Gizmo2D.ts` |
| Multi-select group-gizmo math (3D + 2D) | `editor/scene/multiTransform.ts` |
| Object picking (3D/2D hit-test) | `editor/panels/picking.ts` |
| 3D collider outline | `runtime/rendering/colliderOutline3D.ts` |
| Play / Stop / Pause | `editor/scene/playMode.ts`, `runtime/core/playState.ts` |
| Selection restore on world swap | `editor/store/selectionRestore.ts` |
| Selection / collapse / bound roots follow their entity inside a world | `editor/store/editorRefLiveness.ts`, `editor/store/heldEntity.ts` |
| Console capture | `editor/consoleCapture.ts`, `editor/panels/Console.tsx` |
| Asset editors | `editor/panels/{AnimationEditor,ParticleEditor,SpriteEditor,SpriteAnimEditor}.tsx` |
| Material inspector / preview | `editor/panels/assetViews/MaterialAssetView.tsx`, `editor/panels/MaterialPreview.tsx` |
| Undo / redo | `editor/undo/undoManager.ts` |
| Keyboard shortcuts / focus scope | `editor/input/` — see [editor-input.md](./editor-input.md) |
| Shared 3D sync | `runtime/rendering/scene3DSync.ts` |
| Electron host / Open+New Project | `engine/electron/{main,projects,newProject}.ts` |
