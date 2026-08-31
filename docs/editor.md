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

- **A second concurrent build is refused.** `/api/build` takes no lock, `runBuild` fires an SSE
  request per call, and a native OS menu is not covered by the DOM progress modal — so the modal
  only *looks* like it is holding the door. Before every device row was a build this took a
  deliberate second trip through the menu; now "wrong phone — click the right one" is the natural
  gesture, and it would put two `xcodebuild`/gradle pipelines on one project dir, both reporting
  into the single shared `buildStatus`. A build that already FAILED does not count as running: its
  modal is merely still up, and refusing there would make "dismiss a dialog" a prerequisite for
  retrying.
- **A pick is refused while Project Settings is open.** `user.device.*` has two writers, and they
  write differently: this menu sends a partial patch, while the dialog snapshots the whole config
  when it OPENS and posts that snapshot on Save. So a pick made while it sits open is silently
  written back to the old device — even when the user only meant to edit the app name — and the
  menu then re-reads disk and quietly agrees with the stale value. A lost update nobody is told
  about is worse than a refusal naming the reason.

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
| `panels/assetListing.ts` | Assets filtering, sprite/type grouping, the visible-order walk that drives keyboard nav |
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
  unmount. It reloads on a re-import off the invalidation epoch — see "The asset Inspector"
  below, rule 3.

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
is `runtime/loaders/modelLoadNotify.ts`, fired by **both** model caches — `meshTemplateCache` for
static templates and `riggedModelCache` for skinned prototypes. A notifier wired into only the first
would leave re-imported CHARACTERS broken while every static mesh recovered, which is why it is a
shared leaf module rather than an export of either cache.

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

A device preset carries its **safe-area insets** as well as its logical and physical
sizes, and the preview publishes them so UI insets exactly as it would on that phone —
`env(safe-area-inset-*)` is 0 on a desktop browser, so without this the preview cannot
show a notch bug at all. Always on, with the bands drawn over the frame. Mechanism, the
per-orientation data, and what is measured vs published:
[UI system](./ui-system.md) § "The editor simulates the safe area".

### Driving the preview screen from an agent (#367)

The selected device and orientation live in the **editor store** (`gameViewDevice` /
`gameViewOrientation`), not in GameView-local state, so `modoki_set_game_view_device` can set them —
the same lift `sceneViewMode` got, for the same reason: the device picker is a popup that trusted
input cannot operate. Before it, every layout check an agent ran measured whatever device the human
last left selected, and the per-device bug class (safe-area insets, panel-fit budgets) is precisely
the one that needs the device changed repeatedly to be checked at all. `modoki_game_view_devices`
lists the catalog; `modoki_get_editor_state` reports the current selection as `gameView`, so a
measurement can be attributed to a screen size.

Four things about that surface are load-bearing:

- **`gameViewDevice` + `gameViewOrientation` are the source of truth; `gameViewSize`,
  `gameViewSafeArea` and `gameRect` stay DERIVED** — GameView resolves them and publishes them
  downward for SceneView's preview frame. Writing them from the setter as well would give each two
  writers to keep in sync by hand.
- **An explicit `{logicalWidth, logicalHeight}` is carried as a synthetic preset named `Custom`**,
  so every `resolve*` helper and every GameView consumer handles it unbranched. `logicalW: 0` is
  reserved by `FREE_PRESET` for "fill the panel", so a zero dimension is refused rather than
  silently becoming Free.
- **A custom size reports `safeAreaBasis: 'custom-none'`.** There is no device to look insets up
  from, so its zeros are zeros *by construction* — and four bare zeros are indistinguishable from a
  measured "this screen has no notch", which is the mis-authoring `devicePresets.ts` warns about.
  A catalog preset reports `'preset'`, where a zero is a statement.
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

**Six call sites, and they are the whole contract** — asset delete (`executeDeletion`),
folder delete (`handleDeleteFolder`, which deliberately does *not* route through
`executeDeletion`), asset rename, cut/paste move, folder rename, and drag-drop into a folder
(`handleFilesDrop`). The four move sites remap in their **undo/redo closures** too, since
those move the file back — and each closure gates the remap on the move actually succeeding:
`/api/move-file` 409s when the destination exists, and repointing a binding at a path the
file is *not* at is the forking bug itself.

Two sweep lessons are baked into that list. The first version wired only `executeDeletion`
and missed four; a follow-up sweep for `moveFileTo` call sites still missed `handleFilesDrop`,
which uses the sibling helper **`moveFile`** (folder target) instead. Grep for the *behaviour*
— "what changes an asset's path?" — not for one helper's name. A copy/paste is deliberately
absent: it creates a new file and leaves the original in place, so nothing bound has moved.

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
  UUID, so a query suffix 404s the model). The engine's own `withCacheBust` cannot serve here:
  it is PROD-and-content-hash only, and the editor is neither.
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
`AtlasAssetView` serializes and writes the entire `.atlas.json` on every control interaction,
from a copy it read when the panel opened. Nothing tells it the file changed underneath —
`assetsVersion` is keyed on paths, not content (see § "A panel that reads `getAllAssets()` must
subscribe to `assetsVersion`" above) — so a `.atlas.json` altered on disk while the panel is
open (a `git checkout` under a live editor, which CLAUDE.md names as a real hazard) was silently
reverted by the next padding nudge, with nothing erroring (#439). The write is now a
**compare-and-swap**: `persistAtlasDocIfUnchanged` (`assetViews/atlasPersist.ts`) re-reads the
file immediately before writing and refuses if it no longer matches what the panel read,
surfacing a "changed on disk" banner and re-reading the truth instead. A failed or unknown
re-read refuses too — "we don't know what is on disk" must never authorize a whole-file
overwrite.

Why this panel and not its siblings: the parked-write panels (`ParticleEditor`,
`SpriteAnimEditor`, `AnimationEditor`, `TimelineEditor`, `SkinEditor`) go through
`useParkedAssetDoc` and write on Save All (see [mcp-persistence.md](./mcp-persistence.md)
§ "5. The dirty-asset registry — the ONE path from an asset edit to disk"); `AtlasAssetView`
reads and writes the file directly instead, and that asymmetry is what makes it the one panel
exposed to this hazard.

Why it stayed invisible: `AtlasAssetView`'s own header notes the page preview "refreshes after a
Re-pack via the watcher's manifest broadcast" — and it does. **Derived** data (the `.meta.json`
pages/frames block, surfaced through the manifest) refreshed correctly, while the **authored**
source document did not. A panel that visibly updates is the worst place to hide a stale read.
(#439's sibling #430, on the failed-READ half of the same panel, has no separate write-up here —
it shipped with code + tests + one QA case only.)

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
`window.confirm` (cross-scene move) is not an inconsistency.

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
**never throw** — they catch and resolve `false`. (`SceneAssetView`'s `mutateScene` was the one
exception: it resolved `{ok:false}` for an HTTP error but let a network-level rejection escape,
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

⚠️ **This was LATENT when fixed** — #308 closed the last live route (`SceneAssetView`'s
`mutateScene` let a network-level rejection escape; it catches now), and every filesystem helper
resolves `false` rather than throwing. It was fixed anyway because "just throw so the entry stays
on the stack" is the obvious-looking design the next change will reach for, and it did not work
until this landed.


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
| Console capture | `editor/consoleCapture.ts`, `editor/panels/Console.tsx` |
| Asset editors | `editor/panels/{AnimationEditor,ParticleEditor,SpriteEditor,SpriteAnimEditor}.tsx` |
| Material inspector / preview | `editor/panels/assetViews/MaterialAssetView.tsx`, `editor/panels/MaterialPreview.tsx` |
| Undo / redo | `editor/undo/undoManager.ts` |
| Keyboard shortcuts / focus scope | `editor/input/` — see [editor-input.md](./editor-input.md) |
| Shared 3D sync | `runtime/rendering/scene3DSync.ts` |
| Electron host / Open+New Project | `engine/electron/{main,projects,newProject}.ts` |
