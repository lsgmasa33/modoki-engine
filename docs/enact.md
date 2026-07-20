# Enact — Editor-Chrome Addressability

**Enact** is the trusted-input layer that makes the editor's own UI — not just ECS entities —
agent-addressable. It closes a gap that used to force an agent to measure pixels off downscaled
JPEGs just to find a button: Percept can locate ECS entities, but for a long time it could not
locate **editor chrome** (the Inspector's `⋮`, its menu rows, the Add Component dropdown, panel
headers, toolbar buttons). Enact makes those surfaces discoverable and clickable the same way
canvas handles already were: `modoki_handles {editor:'chrome'}` lists them by name, and
`tap_handle` clicks one — resolved server-side, with no query→act race.

The design principle throughout: **one resolver, two discovery front-ends.** A raw `selector`
is the uncurated escape hatch; `data-ui-id` handles are the curated, enumerable index. Both aim
the same way through the same DOM→point resolver, so the zero-rect guard, the invalid-selector
guard, and occlusion reporting live in exactly one place.

## The original gap

Percept can locate ECS entities via bounds providers, but those providers are only three —
`Scene3D`, `Scene2D`, `SceneView` — and `layoutDump.ts` walks `[data-entity-id]`, which are
*game* UI entities, not editor chrome. Handle providers covered ten canvas editors
(`collider2d`, `curves`, `dopesheet`, `gizmo2d`, `gizmo3d`, `nineslice`, `particle`, `skin`,
`sprite`, `ui-resize`) — none of them panel UI. So every button in the editor's own React chrome
was unaddressable.

For reference, entity addressing already worked and is unchanged: `scene-state?bounds=1` reports
an entity's `screen` center in **window CSS px**, and tapping exactly there selects it.
`editor-state.camera` reads the live Three camera (`readEditorCamera()`), so an orbit reflects in
the reported position immediately. Enact adds the missing chrome layer on top of this.

Three compounding papercuts motivated the fix, all now addressed by the pieces below:

1. Raw input tools (`modoki_tap`/`drag`/`hover`/`scroll`) took `{x,y}` only, even though the
   bridge already resolved CSS selectors elsewhere (`modoki_focus`; `domDnd.ts` did
   `querySelector` → `getBoundingClientRect` → center).
2. `capture_viewport` returned image dims with no CSS size or scale — the true window size was
   only discoverable by probing with a large `maxSide`.
3. There was no identity endpoint, so `MODOKI_BACKEND` could point at a sibling clone's editor
   for a whole session with nothing to reveal the misattribution.

## Selector-aware raw input

`modoki_tap` / `drag` / `hover` / `scroll` accept an optional `selector` alongside `{x,y}`,
resolved **server-side** so there's no race between reading a position and acting on it.

- `resolveEndpoint` lives in `engine/app/debug/domResolve.ts` (extracted from the DnD path in
  `engine/app/debug/domDnd.ts`).
- A renderer op `resolve-dom-point` performs the resolution; `engine/electron/main.ts` resolves
  before calling `tap()`/`drag()`, mirroring the `/api/input/tap-handle` route.
- The response **reports the element actually hit**:
  `{ok, point, matched:'span.kebab', hitTarget:'div.header'}`. When `matched !== hitTarget`,
  something is covering the target — this diagnoses the occlusion class of bug without a
  screenshot.

`selector` is the uncurated escape hatch: it works against any element but is brittle against
inline-styled div soup, which is exactly why the curated path below addresses by stable id
instead of CSS path.

## Editor chrome as handle providers

Surfaces an agent must drive carry a `data-ui-id="<panel>.<region>.<name>"` attribute. The test
for inclusion is deliberately narrow — *would an agent ever need to click this?* — not a blanket
sweep of every element.

`engine/app/debug/chromeHandles.ts` walks `[data-ui-id]` and emits an `InteractionHandle`
(see `interactionHandles.ts`) with `editor: 'chrome'`. Because it produces standard handles,
`modoki_tap_handle {id}` drives chrome with **zero new input tools**, and
`modoki_handles {editor:'chrome'}` makes every tagged surface discoverable by name.

Chrome handles resolve through the **same** `resolve-dom-point` / `domResolve.ts` path as
`selector` input — not a second resolver. This is load-bearing: the moment a chrome handle is
derived from a `[data-ui-id]` element, having a separate DOM→point resolver would mean the
zero-rect guard, the invalid-selector guard, and `occluded` reporting live in only one of the
two paths. One resolver keeps them unified; the two front-ends (`selector` vs `data-ui-id`) are
just different ways to name the target.

The handle shape carries three fields that make chrome addressing robust:

- **`rect`** (not just the center point) → overlap between handles is computable.
- **`meta.disabled`** → a greyed-out Paste is reported as data, not left for the agent to infer
  from a pixel shade.
- **`occludedBy`**, computed via `document.elementFromPoint(cx, cy)`: when the topmost element at
  the handle's center isn't the handle or a descendant, the report names what covers it. This
  finds the "`⋮`-covered-by-its-own-open-menu" bug in a single query.

### What's tagged today

28 live handles in the first pass: ContextMenu rows (every menu in the editor), Inspector header
plus per-trait `⋮`/header plus Add Component, the SceneView toolbar (gizmo mode/space, FX,
collider points), the Hierarchy toolbar, the Assets toolbar, the Console toolbar, and the prefab
dialog confirm/cancel.

Some surfaces are **deliberately not tagged** yet — the boundary is a choice, not an oversight.
Untagged: Assets/Hierarchy *folder rows* (`assets.folder.${path}`), `SubSection` collapse
toggles, per-override checkboxes in `ApplyPrefabDialog`, ProjectSettings tabs and per-field
Browse, and the GameView transport (already covered by `modoki_play_control`) and its
DevicePicker. Tag one when a task needs it — the convention is the whole cost.

Tagging is guarded by an existence test so it can't silently rot: the load-bearing
`data-ui-id`s are asserted present, so deleting one fails a test rather than quietly removing an
agent's only handle on a button.

## Capture reports its own scale

`captureViewport` (`rendererOps.ts`) holds the pre-resize size and returns `cssWidth` /
`cssHeight` / `scale` beside the image `width` / `height`. An agent no longer has to probe for
the window's true CSS size — the downscale ratio is reported directly, so a point read off a
captured image maps back to window coordinates.

## Wrong-clone detection

`GET /api/identity` returns `{repoRoot, projectRoot, backendPort, pid}`. The MCP calls it at
startup, prints a line like `[modoki] backend 5181 → ~/Projects/modoki-ai2 (work-ai2)`, and
**warns loudly** when `repoRoot` differs from the MCP's own cwd. This is cheap insurance against
a whole session of failures misattributed to a bug when the real cause is `MODOKI_BACKEND`
pointed at a sibling clone's editor. (See also `modoki_identity` in the debug-tools reference.)

## Operating rule — re-read bounds immediately before acting

A camera move, a relaunch, or a scene reload between a bounds read and a tap invalidates the
coordinates. Nearly every "the tool is broken" moment in the session that motivated Enact was a
stale read, not a bug. `selector`- and handle-based aiming resolve inside the call and sidestep
this; raw `{x,y}` does not, so re-read first.

## Why this shape

`modoki_handles` (discover by id) → `tap_handle` / `drag_handle` (resolved server-side, no
query→act race) was already the right pattern for the canvas editors, and tagging precedent
already existed (`data-menu-item`, `data-entity-row`, `data-entity-id`). Chrome joins that
system as another handle provider rather than getting a parallel one. Addressing by stable id
rather than CSS path is what makes it robust against the editor's inline-styled markup, and
occlusion checks depend on real layout — they're verified in the Electron editor, never in jsdom
(which reports every `getBoundingClientRect` as zeroes).

## Open / deferred

Not-yet-done follow-ups, none blocking:

- **Canvas providers should name their owning `<canvas>`** (`owner: canvasEl`, one field per
  provider) so their handles get occlusion-checked instead of counted in `occlusionUnchecked`.
  Until then a covered keyframe is *admitted-unknown*, not *assumed-fine*.
- **`registerHandleProvider(fn, {editor})`** so `collectHandles` can skip providers the `editor`
  filter excludes. Today `modoki_handles {editor:'collider2d'}` still pays the full chrome DOM
  walk (a `getBoundingClientRect` + `elementFromPoint` per tagged element) before discarding it —
  invisible at 32 handles, real at 200.
- **A thin render test for the 2–3 highest-value dynamic tags.** The existence guard reads
  SOURCE, so it catches deletion but not "tag present, no longer rendered" (wrap the `⋮` in a new
  conditional and it stays green). Rendering `<Section title="Transform" menuItems={…}/>` and
  asserting the `data-ui-id` reaches the DOM — and is unique — closes that gap cheaply.
- **A read-only `resolve-dom-point` MCP tool** (dry-run: resolve + occlusion, no dispatch). The
  renderer op already exists; only the wrapper is missing. This would satisfy the "occlusion is
  Percept's job" argument without weakening the atomic provenance that `tap` reports.
- **`capture-gesture` placement.** It is aimed input — it composes `requestRenderer` + a trusted
  drag, structurally identical to `tap-handle` — yet it stayed inline in `main.ts` while the
  handle routes moved to `inputRoutes.ts`. Either move it or document why it's exempt (it
  produces a trajectory *read*, not just a dispatch).
- **`InputOps` mirrors the `rendererOps` signatures by hand.** Compile-time-checked at the wiring
  site, so drift is caught — but it isn't free.
