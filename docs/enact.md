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

**Aimed input has THREE target surfaces**, and for a long time only two were covered:

| Target | Aim mode | Resolved in-call? |
|---|---|---|
| Editor chrome (DOM) | `selector` / `data-ui-id` handle | ✅ |
| Canvas-editor geometry (bones, keyframes, collider verts, gizmo axes) | `modoki_handles` → `tap_handle`/`drag_handle` | ✅ |
| **Scene entities in a viewport** | **`entity: {guid\|name\|id}`** — see below | ✅ (added 2026-07-29) |

The entity row was the last read-then-act race in the surface: before it, tapping a mesh meant
reading `get_scene_state?bounds=1` in one round-trip and clicking those coordinates in the next —
and `modoki_tap`'s own description recommended exactly that. `entity` closes it, and the same
single-resolver discipline applies: a **UI** entity IS a DOM node, so it goes through
`resolveElementPoint`/`occlusionAt` — the selector path's own recipe, not a copy of it — while 2D/3D
entities take their rect from the registered **bounds providers** (`collectScreenBounds`, the same
data `layout-bounds` reports) rather than a second projection that could drift from it.
Implementation: `engine/app/debug/entityResolve.ts` + the `resolve-entity-point` op, wired into the
one `resolvePoint` seam in `engine/electron/inputRoutes.ts` so all five aimed routes get it at once.

**A COVERED aim is refused, whichever resolvable form it took** (2026-08-19). `entity` and
`selector` are one category — both resolved server-side inside the call — so both now answer
`OCCLUDED` (400) naming the cover, with `allowOccluded:true` as the escape hatch. The selector path
used to press anyway and report `occluded:true` beside `ok:true`; that is the false success
`mcp-tool-conventions.md` §0 ranks worst, the device surface had refused a covered selector all
along, and the editor was the lone holdout. Raw `{x,y}` is exempt — a coordinate is what you asked
for. One carve-out, about delivery rather than aim: `modoki_pointer`'s `move`/`up` go to whatever
captured the press, so occlusion at the destination cannot stop them and is not checked.

**`occlusionScope` — the honest half, and the part to actually read.** An entity aim reports how far
the occlusion check could see, because `occluded:false` does not mean the same thing on every path:

- **`'element'`** (UI) — a real DOM comparison. Anything covering the entity, including another UI
  entity, is detected. Trustworthy.
- **`'entity'`** (2D/3D, a surface with a registered **pick provider** —
  `registerPickProvider`/`pickAt`, `engine/packages/modoki/src/runtime/core/screenPick.ts`) — the
  surface's OWN hit-test was asked what a click at the aim point would actually select, so
  entity-vs-entity occlusion inside the canvas IS checked: a mesh in front of the target is
  detected. This is a **prediction** of that surface's picking, not a second opinion beside it —
  the provider is wired to the SAME code path the surface's pointer handler runs (`screenPick.ts`'s
  header states the rule), never an independently-written raycast that merely happens to agree
  today. On this scope an **occluded entity aim is a REFUSAL** (`ok:false`, HTTP 400), not a flag:
  `entity` aiming expresses intent about an ENTITY — "click the character" — so if the surface
  would not select that character, the intent has failed, and dispatching anyway would land on the
  blocker (or nothing) while still reporting success. The refusal names the blocking entity the way
  `hitTarget` names a covering DOM element. Pass `entity.allowOccluded:true` to dispatch anyway and
  see what was actually hit — the escape hatch stays available, it just is not the default.
- **`'canvas'`** (2D/3D, a surface with **no** pick provider) — the entity is pixels inside a
  canvas, not a DOM node, so this only answers *"does the click reach the rendering surface"*. A
  panel or dialog over the canvas is caught; **a mesh directly in front of the target is NOT** — it
  reports `occluded:false`. This is the honest fallback, not a bug: the engine ships no default
  picker for the runtime GameView surfaces (`game-2d`/`game-3d`) on purpose — selection policy is
  GAME code (a physics scene query, PixiJS events, a custom raycast, or nothing at all), and the
  engine has no business deciding what a game considers clickable. A game registers its own
  provider to opt in; only the editor's `scene-view` surface ships one today (its SceneView
  pointer-handler picking, hoisted into a shared function both the handler and the provider call).
  `scene-view` registers **two** — the 2D canvas overlay and the 3D viewport, which overlap on
  screen — so `registerPickProvider` takes an explicit `priority` (higher consulted first,
  registration order breaking ties) and the 2D overlay declares that it sits on top. Before #80
  this could not bite, because a 2D `scene-view` aim was refused for want of bounds before any
  picker ran; the order it fell back on was React effect mount order, which is not guaranteed to
  match z-order. State the priority rather than relying on mount timing.

Reporting the scope is what stops the weaker check from being read as the stronger one; a bare
`occluded:false` on `'canvas'` would be a false clean bill of health. The `'entity'` scope also
reports **`aimedAt`** (`'centre'` | `'sampled'`): the aim point starts at the centre of the
entity's projected rect, which for a torus, an L-shape, a crescent — any concave or hollow mesh —
is not on the entity at all. When the picker confirms the centre misses, the rect is searched (a
small grid, closest-to-centre first, capped and reported as `samplesTried`) for a point that DOES
pick the target; `aimedAt:'sampled'` marks that this happened, so a sampled aim is never mistaken
for a clean centre hit.

**Everything ambiguous is refused, never approximated** — an ambiguous `name`, an off-screen entity,
a zero-size projection, a UI entity with no mounted node, and the subtle one: a rect that *overlaps*
the viewport while its CENTRE sits outside the window. Clamping that to the viewport edge would
produce a successful-looking click on the border.

### `surface` — WHICH on-screen copy of the entity

One entity often has **several** on-screen rects, and in the editor that is the norm rather than an
edge case: with the Scene and Game panels both open, `Scene3D` and `SceneView` each measure every 3D
entity through their own camera. Measured on `games/3d-test`, one entity id, `get_layout_bounds`:

| surface | rect |
|---|---|
| `game-3d` | `{x:755, y:312, w:47, h:45}` |
| `scene-view` | `{x:76, y:-63, w:496, h:372}` |

Both `onScreen: true`, and — until 2026-07-30 — both **unlabelled**, so resolution took the first
one the provider `Set` happened to yield. When that was the panel not on top, the click landed in
the wrong viewport and reported success: the exact failure mode `entity` aiming exists to remove.

So every provider labels its rects (`surface: 'game-3d' | 'game-2d' | 'scene-view'`, plus
`'game-ui'` for the DOM UI layer), and **a 2D/3D
entity aim REQUIRES `surface`** — including when only one viewport has the entity.

That last part is the whole point, and it is not about disambiguation. Refusing only the *ambiguous*
case (the first version of this) left the dangerous half open: a single-surface aim **succeeds
without the caller ever stating what it meant**, so there is nothing to check the intent against. An
agent that believed it was clicking the GameView, while only the SceneView had the entity aimable,
got `ok:true` and a wrong belief — recorded solely in a `surface` field it had no reason to re-read.
Requiring the parameter turns that into a refusal that **names what is actually on screen**, which
corrects the belief instead of confirming the wrong one. A refusal is not a confusion; it is the good
outcome. The cost is one parameter on every mesh aim; the gain is that the call means the same thing
regardless of which panels the human happens to have open.

- A successful aim **always** reports the `surface` it used — "I tapped the cube" is not checkable
  without knowing which on-screen cube.
- **A UI entity accepts `surface`, and REQUIRES it when it is mounted more than once.** "It is a
  single DOM node" was the original ground for refusing it, and that was wrong: the editor mounts a
  UIRenderer in **both** SceneView's `[data-ui-preview-frame]` (`scene-view`) and GameView's
  `[data-game-view-area]` (`game-ui`), and every UINode stamps `data-entity-id` — so with both
  panels open, every full-screen overlay, modal and HUD button has TWO live nodes. Unlike 2D/3D it
  is **not** required when only one node exists: a shipped game has exactly one, so demanding it
  there would break correct calls to buy nothing. The response always echoes the surface aimed at.
  (The MCP schema omitted `'game-ui'` from its enum until #151, which made a two-mount UI entity
  unaimable by name: the backend refused the un-surfaced aim and named the fix, and the fix it
  named was rejected by the tool's own schema. Both refusals were individually right; together
  they were a dead end — the reason a vocabulary must live in ONE place.)
- When the chosen surface is not aimable, the reason names **that** surface (`game-3d: off-screen`).
  Reporting the other panel's reason would answer a question the caller did not ask.
- **`get_editor_state.surfaces`** lists the surfaces mounted right now, so a caller — especially a
  batch, which cannot read a response to recover from a refusal — can get it right first time
  instead of guessing at the very thing the requirement exists to stop it guessing about.

`get_layout_bounds` returns one row per surface, each labelled. `get_scene_state?bounds=1` has one
row per *entity*, so it reports the winning rect's `surface` plus `otherSurfaces: […]` — it still
answers with one rect, but no longer presents one of several answers as the answer.

### What a 3D surface measures — and why it must equal what a click SELECTS

Both 3D providers run one shared body, `runtime/rendering/entityScreenBounds.ts`: meshes
(`ecsObjects`), skinned roots, billboards, SDF text meshes, and — SceneView only — the **icon
gizmos** that stand in for Camera/Light/Environment entities. That list is not decoration; it is
the invariant. Measure fewer kinds than the surface renders and an entity is on screen, genuinely
click-selectable, and refused by an `entity` aim with *"has no screen bounds"* — which is what
QA-CTX-0006/QA-SVIEW-0004 hit for lights and cameras, and what a skinned character hit in the
GAME view. Two consequences that are easy to get backwards:

- **An icon gizmo reports no `worldAABB`.** That field means the entity's true geometric extent;
  a Light has none, so the icon's box would be a confident wrong answer. Screen rect only.
- **A child excluded from picking is excluded from bounds.** The camera gizmo's frustum lines
  already had a no-op `raycast`, but `Box3.setFromObject` walks every child regardless — which
  measured the camera at 5613×1981 px, a rect no click inside it selects the camera in.
  `userData.noBounds` prunes such a subtree, and the flag is set beside the raycast override so
  the two cannot drift.

### A covered aim is refused on EVERY scope (2026-08-19)

`mcp-tool-conventions.md` §3 says a resolvable aim that something covers is refused, and that the
rule "binds `entity` and `selector` alike — they are the same category". Only the MESH half was
implemented: `entityResolve` refuses when the surface's own picker names another entity in front.
DOM-level covering — a modal, a menu, a panel over the viewport — was reported as `occluded:true`
and **dispatched anyway**, on all three scopes. A tap aimed at a UI button under an open dialog
pressed the dialog and answered `ok:true`. That is the §0 rank-1 false success, and the contract had
already decided it; this was a gap, not a policy question.

`allowOccluded:true` is the escape hatch and now has an effect on the canvas scope too (its
description said it did not). The two carve-outs §3 names are unchanged: raw `{x,y}` is never
refused, and a held gesture's `move`/`up` goes to whatever captured the press — `inputRoutes` forces
`allowOccluded` for any `pointer` action other than `down`, so occlusion at the destination cannot
break a legitimate drag — and it forces it on the ENTITY spec as well as the top-level field,
because the two merge with `??` and a caller's explicit `entity:{allowOccluded:false}` would
otherwise win and refuse a move the press had already captured. The carve-out is a fact about
delivery, not a preference, so it overrides; `??` stays the right precedence everywhere the flag
really is the caller's intent.

### A refusal that may be TRANSIENT says so — and the retry was DECLINED (#261, 2026-08-22)

An aim refusal can be true at the instant it is asked and gone a frame later: the dock has just
changed and the target has not reached its final position. The verdict is accurate; the advice it
offers ("dismiss what covers it") is useless, because nothing needs dismissing and the caller's next
move is simply to re-aim. #261 asked whether `resolvePoint` should therefore **settle-and-retry**.

**Measured first, three ways, before deciding** — editor on a live clone, restored and re-verified
after each probe:

| path | settle | false `OCCLUDED`? |
|---|---|---|
| steady state (resolver vs. a same-instant `getBoundingClientRect` + `elementFromPoint`) | n/a — identical, 6/6 frames | no |
| a React commit (filtering the Hierarchy moved a row 206 → 104 px) | **0 frames** — the first sample after the commit already has the new position | no |
| a FlexLayout tab reveal | **1 frame** | no |
| a FlexLayout tab add/remove (panel open, then closed) | **0–1 frames** | no |

Two conclusions, and the second is the one that decided it:

1. **The window is 0–1 frames**, not the ~50 ms a fixed sleep would have waited — roughly three
   times longer than the thing it waits for.
2. **None of the paths produced a false cover.** The unsettled state is a **zero rect**, so the
   resolver returns *no point at all* — a clean "cannot resolve", which is already an honest
   refusal rather than the confident wrong verdict #261 is about.

So the retry is **declined**: a caller who re-aims at all has already waited longer than the layout
needs. What was missing was never the retry — it was the caller being able to tell the two cases
apart. Every aim refusal now measures whether the layout MOVED across one frame
(`engine/app/debug/layoutSettle.ts`, agent op `layout-settling`) and appends a warning when it did,
on all three paths: `entity`, `selector`, and the handle route's `blockedReason`.

⚠️ **The hint covers the DID-NOT-RESOLVE refusals too, and that is the branch that reproduces.**
The first cut instrumented only `OCCLUDED` — the shape the issue *reported* — while the shape the
measurements *produce* is the other one. Without it the refusal reads as "your selector is wrong",
sending the caller after a better address instead of a re-aim.

**Not implemented as a `dockChangedAt` timestamp**, which the issue sketched. That needs the editor
to publish "the dock changed at T", and the only seam from the package's editor to this layer is
`window.__editorStore` — which is **DEV-ONLY**. Enact runs in the packaged DMG too, so a hint
plumbed that way would work in dev and silently do nothing in the thing that ships. Measuring the
movement is the fact itself rather than a proxy for it, and stays correct if the dock ever animates.

**Still unmeasured:** a dock change that *splits* the layout. `openPanel` only ever docked into an
existing tabset, so reproducing one needs a tab dragged to an edge by hand.

### The aim point must be ON the surface, and INSIDE the panel (2026-08-19)

Two aims, one mistake, found one after the other: a coordinate is judged against the WINDOW when
the boundary that matters is the panel it belongs to.

- **`handles`' `onScreen`** compared the point to `window.innerWidth/Height` only. A docked panel
  is an `overflow`-clipped box and `getBoundingClientRect()` on something scrolled out of one still
  reports its laid-out position — for a Particle Editor two-and-a-half screens tall, hundreds of px
  below the panel, on top of whichever panel owns those pixels. `computeHandles` now intersects the
  clip box of every clipping ancestor **including the owner itself** (the Dopesheet and Curves
  editors hand out their own `overflow:hidden` container as `owner` and compute each handle's x
  unclamped from `timeToX`, so a keyframe panned out of the time window sits beside the container,
  over the TrackList). Testboard `AceYUBoBXbcGtIIFmzGb`.
- **The `selector` aim** had the same blind spot with a worse symptom: a Hierarchy row below the
  fold resolves to a real rect whose centre lands on a splitter, so the refusal blamed "an open
  menu, a modal, a panel that overlaps" — none of them true, none of them actionable. A sweep of
  this editor's live `[data-ui-id]` set found 12 of 22 occluded hits were this class. Both paths now
  share `withinClip` and report **`clipped`**, which is what picks the remedy: *scroll/enlarge the
  panel* versus *dismiss what covers it*. The covering element's name cannot distinguish them —
  it is an anonymous `div` either way.
- **An `entity` aim on a canvas surface** could resolve onto a DIFFERENT panel's canvas entirely.
  The editor puts the Game panel's canvases beside the SceneView's (measured on `games/3d-test`,
  1600×968: Game 3D at x 0–366, SceneView at x 370–736), an entity's rect may straddle its own
  canvas's edge with its centre outside, and the DOM check accepted *any* `<canvas>` as "the click
  reached the surface". Measured: `modoki_tap {entity: Plane029, surface:'game-3d'}` at (402,186)
  answered `ok:true, occluded:false` and the editor journal recorded `!focus {panel:"scene"}` — the
  click drove the Scene panel. The canvas must now belong to the surface that was named, decided
  from the two host markers that exist (`[data-game-view-area]`, `[data-scene-viewport]`) and
  **positively in both directions**: a canvas under neither — a shipped game's — stays permissive,
  because the markers are editor chrome and reading their absence as "foreign" would refuse every
  runtime aim. `allowOccluded` does not open it: nothing is covering the target, the coordinate is
  simply not on the surface that was asked for.

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

`modoki_tap` / `drag` / `hover` / `scroll` / `pointer` accept an optional `selector` (and an
`entity`, above) alongside `{x,y}`, resolved **server-side** so there's no race between reading a
position and acting on it. Precedence is `entity` → `selector` → `{x,y}`.

- `resolveDomPointReport` lives in `engine/app/debug/domResolve.ts` (extracted from the DnD path in
  `engine/app/debug/domDnd.ts`).
- A renderer op `resolve-dom-point` performs the resolution; the `resolvePoint` seam in
  `engine/electron/inputRoutes.ts` resolves before calling `tap()`/`drag()`, mirroring the
  `/api/input/tap-handle` route.
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
- **`meta.state`** (from an optional `data-ui-state` on the element) → the same argument for a
  control that has a CURRENT VALUE rather than just a pressed/not-pressed. A segmented
  Auto | On | Off row renders its active segment as a background colour, which is unreadable in a
  downscaled capture; `state:'selected'` on the active segment makes "what is physics3d set to?"
  a read instead of a guess. Set it only where there is a state worth reading back — it is not
  decoration for a plain button.
- **`occludedBy`**, computed via `document.elementFromPoint(cx, cy)`: when the topmost element at
  the handle's center isn't the handle or a descendant, the report names what covers it. This
  finds the "`⋮`-covered-by-its-own-open-menu" bug in a single query.
  The `tap_handle` / `drag_handle` RESPONSES report it the same way every other aimed route does
  (S3.17): `occluded` is a **boolean, always present**, with the covering element in `occludedBy`.
  They used to emit `occluded` as the string itself and omit it when clean, so "not occluded" and
  "this route does not report occlusion" were indistinguishable. `drag_handle` reports per ENDPOINT
  (`fromTarget` / `toTarget`, mirroring `/api/input/drag`), because a covered source and a covered
  destination need different fixes.

  **Every provider names its owning element, and that is a rule, not a nicety.** `computeHandles`
  occlusion-checks a handle only when its provider supplies `owner` (the element itself for chrome,
  the owning `<canvas>`/`<svg>`/container for a Canvas2D/SVG editor); one that omits it is counted
  in `occlusionUnchecked` instead of being given a wrong clean bill of health. That fallback is
  honest but was, for a while, the state of every non-chrome provider — so a keyframe, a bone, a
  collider vertex and a 3D gizmo axis were all un-hit-tested.

  What that cost, measured 2026-08-18 on `games/anim-bug`: a bug was filed as "dragging a LIGHT's
  3D translate gizmo does nothing while a mesh in the same scene moves" (QA-SVIEW-0003), which
  reads as a lights regression and is not one. A gizmo axis aim point WAS the object's origin plus a
  FIXED 52px screen offset (it is derived from the picker's real geometry now — see below, which is
  the same constant biting a second way). The Scene panel's canvas was 256px wide; the light's origin projected to
  x=253.8, so its +x aim point landed at x=305.1 — 49px past the canvas edge, inside the Assets
  panel — and the trusted click went there while `modoki_drag_handle` answered `ok:true` with a
  resolved from/to. The mesh simply projected further left. The light's un-occluded z handle moved
  it normally. With `owner` supplied the same call reports `occludedBy` naming the cover and
  `occludedCount` rises, which is the whole difference between a silent miss and a diagnosable one.

  **The prediction must include the GIZMO, or it names an entity the click will not select.** The
  transform gizmo of the selected entity sits exactly where an aim lands (its origin) and covers
  ~50-200 px around it; TransformControls handles that press itself and SceneView's selection
  handler bails, so the click changes nothing. The pick provider did not model that, so `pickAt`
  answered with whatever mesh was behind the gizmo — or `null` for a point on an arm over empty
  sky, where the click provably leaves the selection alone. Filed as "the reported
  `occludedByEntity`/`hitTarget` does not match what the dispatched click actually selects"
  (testboard `UfbeEfhHmNwd0GVVnESC`). The provider now answers with the gizmo's OWN entity for such
  a point — the truthful "a click here leaves that selected" — which also makes an aim at the
  already-selected entity succeed instead of being refused by its own gizmo. Guarded by an e2e that
  predicts, clicks, and compares across a ring of points around the gizmo
  (`editor-smoke.spec.ts`), verified to FAIL with the fix disabled.

  **Reporting the cover was not enough on its own, and the same class of phantom bug came back.**
  A covered handle still DISPATCHED, so `ok:true` with an `occludedBy` field kept reading as a
  success: on 2026-08-19 a 2D gizmo's free-move handle sat under the SceneView's own 32px toolbar,
  the press went to the toolbar, and it was filed as "`gizmo2d:free` has ZERO effect — not just
  unsnapped, completely inert" (testboard 5jE5Tip6Qwp7s7YVAYoH, severity high). The handle was
  fine — moving the entity out from under the toolbar moved it on the first attempt. So an occluded
  endpoint is now a **REFUSAL** on `tap_handle`/`drag_handle`, the way an occluded entity aim
  already is on `modoki_tap`, with `allowOccluded:true` as the deliberate escape hatch. Two smaller
  changes came with it, because a refusal is only useful if it is actionable: `describeOccluder`
  walks up for the nearest ancestor that names anything (a bare `"div"` identifies nothing), and
  the SceneView toolbar — chrome that structurally overlaps the top of the viewport — carries
  `data-ui-id="sceneView.toolbar"` so it names itself.

  **A 3D gizmo aim point is now geometry, not a pixel guess — for EVERY handle.** The old constants
  (52px for an arrow, 66px for a ring) could not work, and not because of camera distance: the gizmo
  holds a constant size in the RENDERER'S viewport, so its screen size scales with the PANEL. In the
  default dock the Scene canvas is small. Measured 2026-08-19 on games/3d-test (canvas 366x227),
  raycasting three's own picker along the X axis: it answers `X` from ~10px out to ~45px and
  NOTHING at 52px — the published aim sat past the arrow's tip, the press fell through, and the
  drag orbited the camera. (A miss over empty viewport also MARQUEE-SELECTS, so it can silently
  swap the selection and make the next drag move the wrong entities.) After the fix, all 11
  published handles across translate/rotate/scale raycast to exactly their intended picker on that
  same small panel. An axis three has HIDDEN (within ~8° of the view, where it collapses the picker
  to 1e-10) is no longer published at all.

  A ROTATE ring's picker is a thin torus with nothing inside it, so the fixed 66px offset
  aimed into its hole at every camera distance: the press fell through to the viewport background
  and orbited the camera (testboard `zBgcNtw2HLyXwT9lMEe4`). And `scale:center` pressed the gizmo
  ORIGIN, where three's uniform-scale ratio `pointEnd.length() / pointStart.length()` divides by
  ~0 — measured 8.3e7 from a 120x80px drag, with the reflection decomposing to a sign flip on X
  alone (`1Rg36fFvZBdeNmUrtjs7`, filed as a "non-uniform" scale; it is one mirror, not per-axis
  skew). Both aims are derived from three's own handle scale in
  `engine/packages/modoki/src/editor/panels/gizmo3dAim.ts`, which carries the formula and the
  measurements.

  **Three things the close-out's own review turned up, all measured, all fixed in the same pass.**
  (a) `eye` — three derives it as the negated VIEW DIRECTION for an orthographic camera and as
  `cameraPosition - worldPosition` for a perspective one; the editor has an ortho sibling, so the
  perspective form would have hidden an axis three kept or published one it collapsed to 1e-10.
  (b) The rotate ring's near-candidate is ranked by projected NDC depth, not by distance to the
  camera's POSITION — the latter is quietly the wrong measure under an orthographic projection.
  (c) `scale:center` verifies which picker it would select: three's three PLANE pickers are thin
  plates in the gizmo's positive octant, and a ray can cross one before reaching the uniform box —
  measured on a two-entity selection, whose proxy has no rotation so the plates lie in the world
  planes, the drag came back with `sy` UNCHANGED and x/z grown, i.e. a silent two-axis scale.

  The rule is enforced by `engine/tests/architecture/handleProviderOwner.test.ts` — a SOURCE guard,
  because these providers live inside panel mount effects that cannot be invoked without a real
  viewport. One provider is deliberately exempt and the guard asserts it stays that way:
  **`UIResizeOverlay`**, whose 8 handles sit ON the entity element but are driven by sibling overlay
  divs drawn over it, so owning the entity element would report every handle as occluded by its own
  grab affordance. Wiring it needs the overlay divs themselves, which the provider does not hold.

### What's tagged today

28 live handles in the first pass: ContextMenu rows (every menu in the editor), Inspector header
plus per-trait `⋮`/header plus Add Component, the SceneView toolbar (gizmo mode/space, FX,
collider points), the Hierarchy toolbar, the Assets toolbar, the Console toolbar, and the prefab
dialog confirm/cancel.

The **asset editors** were tagged next (#287), because QA started driving them: SkinEditor and
ParticleEditor were the two worst files in the editor (36 and 20 controls, zero tags), so every
case against them fell back to `modoki_eval` plus a text match — brittle against any copy
change, and unable to tell two same-labelled controls apart at all.

ParticleEditor is worth reading as a pattern rather than a list. Its ~58 property fields all
route through six shared widgets, so the ids come from a **React context** that `<Section>`
provides (`panels/particle/fieldIds.ts`) instead of a `uiId` prop threaded through every call
site: tag the widgets once and the whole panel is tagged, including fields added later. The
section half of `particle.<section>.<field>` is load-bearing, not tidiness — "Mode" and "Shape"
each name a field in BOTH the Collision and Render sections, and "Size"/"Opacity" in both Start
values and Over life; those sections mount together, so a bare `particle.mode` would resolve to
whichever the DOM happened to order first. That is measured, not asserted:
`particleFieldIds.test.tsx` renders the mechanism and proves no two co-mounted fields collide.

**Same-labelled controls are the ambiguity worth hunting for.** Two buttons in the AI panel both
read "Connect" — Claude Code (`ai.connect.claudeCode`) and the device (`ai.device.connect`) —
and both mount together, so whenever neither is connected, a text search or a blind aim for
"Connect" there had no way to pick one.

⚠️ **`SubSection` collapse toggles used to be on the deliberately-untagged list, and #287
moved them off it — because tagging their CONTENTS changed the calculus.** Leaving a
disclosure un-addressable is free while nothing behind it is addressable. It stops being free
the moment it isn't: `TextureAssetView`'s Advanced subsection is `defaultOpen={false}` and
holds seven tagged controls, so those seven ids existed in the DOM contract and no agent could
ever click them. A live editor reported **4** `assetView.texture.*` handles where the source
has 11; tagging the toggle and clicking it by id took that to 10 (the 11th, `uastcLevel`, is
correctly gated on a UASTC variant being emitted). **A tag behind a door an agent cannot open
is not a tag** — so when you tag a panel, check what gates it, and tag the gate too. The
toggle carries `data-ui-state` open/closed so the agent can tell "already open" from "needs a
click" instead of toggling blind and closing it.

**The same rule caught a worse case one level up: a MODAL an agent could not leave.**
`FindReferencesDialog` is `position:fixed; inset:0; zIndex:9999`, has no Escape handling, and
its only Close button carried a `data-testid` and no `data-ui-id` — and nothing in the Enact
path reads `data-testid`. While that overlay is open every other tagged handle in the editor
reports occluded and Enact refuses the aim, so an agent that opened Find References was
trapped, with a raw `{x,y}` tap (the documented last resort, and refused outright by
`modoki_batch`) as its only way out. Swept every full-screen overlay in the editor for a
tagged exit; it was the ONLY one with no `data-ui-id` at all. **A modal's exit is load-bearing
tagging, not optional** — the `ApplyPrefabDialog` entry in `chromeTagging.test.ts` already said
so, and this was the second instance of the same rule.

Some surfaces are **deliberately not tagged** yet — the boundary is a choice, not an oversight.
Untagged: Assets/Hierarchy *folder rows* (`assets.folder.${path}`), per-override checkboxes in
`ApplyPrefabDialog`, and the GameView transport (already covered by `modoki_play_control`) and
its DevicePicker. Tag one when a task needs it — the convention is the whole cost. Apply the
gate rule above before adding to this list: none of these currently hide a tagged control.

Tagging is guarded by an existence test so it can't silently rot: the load-bearing
`data-ui-id`s are asserted present, so deleting one fails a test rather than quietly removing an
agent's only handle on a button.

⚠️ **That guard reads SOURCE, and a source guard has a specific blind spot: a widget can keep
computing an id and stop rendering it.** Verified by mutation — dropping `data-ui-id` from
ParticleEditor's `Check` widget (leaving the `useFieldId` call in place) un-tagged every
checkbox in the panel while both suites stayed green. `chromeTagging.test.ts` now asserts each
shared field widget's OUTPUT, not just the wiring once. Neither guard can tell you a tag reaches
the LIVE DOM; `modoki_handles {editor:'chrome'}` against a running editor is the only thing that
can, and it is the check to run after a tagging pass.

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

## Input fidelity — synthesized input is not always human input

Trusted input is *not* automatically faithful, and the failure shape is the dangerous one: the
call returns `ok:true` either way. Two gaps have been found by measurement, so treat "the tool
said it worked" as a claim about the renderer, not about the human.

- **`modoki_press_key` — KNOWN GAP, measured.** `sendInputEvent` (and CDP
  `Input.dispatchKeyEvent`) reaches the renderer but does **not** trigger native Electron menu
  accelerators. Verified with a positive control: a bare `e` set `gizmoMode`, while ⌘R did not
  reload. So an agent can drive chords a human physically cannot deliver to the renderer, and can
  "verify" a binding that is dead for the human. The tool description carries this caveat.
- **`modoki_tap` — VERIFIED FAITHFUL.** It delivers a real `pointerdown` *and* correctly
  reproduces the browser suppressing the compatibility `mousedown` when a canvas handler
  `preventDefault`s. This is the standard the others should be held to.

### An OCCLUDED window delivers nothing at all (measured 2026-08-18, fixed)

The most complete version of that failure shape: while the editor window is **hidden** —
another app fully covers it, or it is minimised, i.e. `document.visibilityState === 'hidden'` —
Chromium **drops every `sendInputEvent`**, and every input route used to answer `ok:true`.
Measured on backend 5183 with `document.elementFromPoint` returning the intended Assets row:
three consecutive `modoki_tap {selector}` calls returned `ok:true, occluded:false`, a
capture-phase `click` **and** `mousedown` listener on `document` recorded **zero** events, and the
row never selected. Raising the window (`osascript … set frontmost of process "Electron"`) made
the *identical* call land, `trusted:true`.

This is precisely what the provenance fields exist to remove — the reply described what the call
**aimed at**, never what **arrived** — and it is the likely cause of a QA report blaming three
trusted primitives (Escape, a tap, Tab) that were all working.

**Now refused, not reported.** `createInputRoutes` asks the renderer (`input-deliverability`,
`engine/app/debug/agentBridge.ts`) before dispatching anything, at the same single seam as the
actor lease, and a hidden window is an HTTP **409** naming the cause and the fix (raise the
window) with **nothing dispatched** — no aim resolved, no lease opened. A renderer that cannot
answer does **not** veto the input: an unqualified tap is a missing hint, a refused one is a
broken tool.

Two deliberate exceptions, both because a refusal must not state a false cause:

- **`/api/input/focus` is exempt.** It is the one route here that dispatches no OS input —
  `focusElement` is `wc.focus()` plus `executeJavaScript`, which a hidden window still runs.
- **An unrecognised `/api/input/<x>` still falls through** (`null`, so the caller tries its next
  handler) rather than 409-ing on a path this file does not own. `DISPATCHED_INPUT_ROUTES` is
  what both the gate and the fall-through read.

**`/api/capture-gesture` carries the same gate**, wired through the exported
`inputDeliverability`/`hiddenWindowRefusal` rather than a second copy of the rule: it drives its
own trusted drag through `rendererOps`, so it never passes through `createInputRoutes`. A hidden
window there produces a flat trajectory — the third way that route can manufacture a confident
"the object didn't track the drag", after the phantom sample guid and the stopped sim it already
guards.

**The weaker sibling is reported, not refused.** With the window **visible but not OS-focused**
(`document.hasFocus() === false`), input DOES arrive, but Chromium dispatches no
`focus`/`blur`/`focusin`/`focusout` — `el.focus()`/`el.blur()` move `document.activeElement` and
fire nothing, so anything the editor does *on* a focus event silently does not happen (a
commit-on-blur field is the classic; RenameInput was fixed at the source in `a03249ca`). The
input itself is real, so the response simply carries **`windowFocused: false`**.

### Audited and fixed (2026-07-22)

A fan-out audit over drag / dnd / scroll / hover / type_text / handles / capture_gesture, each
finding adversarially refuted, then the survivors **measured against the live editor**. Three were
confirmed by measurement and fixed; all three were false successes, the class this surface was
supposedly already hardened against.

- **A zero-length drag is a click.** `modoki_drag {from:{700,200},to:{700,200}}` over empty
  SceneView space returned `ok:true, dragged:{…}` and **cleared the human's selection** (entity 38
  → null): `mouseDown`+`mouseUp` at one pixel is what Blink synthesizes a `click` from, and
  SceneView's deselect gesture only cancels past `DESELECT_DRAG_PX`. Reachable most easily via
  `drag_handle {delta:{dx:0,dy:0}}` — a truthy object that sails past the "did you give me a
  destination?" guard. Both routes now refuse it and name `tap`/`tap_handle` instead. A *one-pixel*
  drag is still dispatched: sub-threshold gestures are app semantics, not this layer's policy.
  **The same class, found later on SCROLL (S3.15):** a scroll with no delta dispatched a zero-delta
  wheel and answered `ok:true, scrolled:{deltaX:0,deltaY:0}` — nothing moved, reported as success, in
  the one input family whose siblings already refused the analogous no-op. Now refused, naming
  `deltaY` (~120 ≈ one wheel tick). Its device twin `device_scroll` refuses too, and took the
  opportunity to adopt `deltaX`/`deltaY` (it had `dx`/`dy` — same operation, two names).
- **`type_text` reported success typing into a `readOnly` field.** `{ok:true, typed:3}` into the
  Inspector's readOnly name input, whose value was provably unchanged (`"пальма_1"` before and
  after, read via CDP). `typed` was only ever `text.length` — the op never reads back.
  **Fully closed by S3.18:** `typed` is now the MEASURED value delta of the focused element and
  `valueAfter` echoes the field, so a short insert is `ok:false` naming what landed. Pinned by
  `engine/tests/electron/typeTextMeasured.test.ts` (mutation-tested: replacing the delta with
  `text.length` fails it).

  ⚠️ **This entry used to add that non-ASCII text "is silently dropped" and to send the reader to
  the app's own UI. That is FALSE and has been removed** (bug `xaewBYMBYXoeuiTllsI8`,
  QA-INPUT-0003). Measured on Electron 43.2.0: `太陽ランプ`, `café` and `A🚀B` all insert cleanly
  through the `char` path, `typed` counts them correctly, and the world matches `valueAfter` every
  time. The advice was worse than the behaviour it described — the recommended detour,
  `modoki_eval`, is a NON-input write that a React controlled input never sees, so it is strictly
  more fragile than the path that works; and the repo owner writes Japanese, which makes this the
  common path rather than a corner. The MEASUREMENT is still the point: when text really does not
  land, the live cause is a field that reformats, truncates or rejects input as you type, and
  `valueAfter` names what it actually accepted.
- **`press_key`'s warning over-claimed.** It said a focused field "will swallow this key" on a
  press where `f` demonstrably framed the selection (camera `[12,15,20]` → `[-0.1,1.4,1.8]`).

**Root cause of the last two, and the durable lesson:** one predicate was answering two different
questions. "Can this element receive typed text?" (readOnly/disabled/checkbox/`<select>` → no) and
"will the running game's sampler ignore keys?" (blunt, tagName-only, ships inside every game → yes
for all of those) are *not* the same test. `rendererOps.ts` used the blunt one for both. They are
now split — `typable` vs `gameSwallows` — and pinned to the editor's own `isTextEditable` by
`engine/tests/electron/activeElementProbe.test.ts`.

That parity test is the load-bearing part. `focusScope.ts` already carried a comment saying these
predicates were "kept in the same shape ... if these drift, that warning starts lying" — and they
had drifted anyway. Writing the invariant as a test immediately found **two further** drifts nobody
had reported: `isTextEditable` returned true for a `readOnly` *textarea* (the readOnly check was on
the INPUT branch only), so a readOnly textarea suppressed every editor shortcut while rejecting
every character. A comment cannot fail; a test can.

Follow-ups:

- [ ] **Audit the rest of the surviving findings.** The audit produced 19 that survived refutation;
      3 were measured and fixed. Unverified-but-plausible remainders worth measuring: `hover` never
      un-hovers (sticky hover state inherited by later ops), `scroll` takes no `modifiers` (so
      Ctrl/Cmd+wheel paths are unreachable), and `capture_gesture`'s `t` is an interpolation
      fraction with no time axis at all — which is odd for the op whose whole purpose is measuring
      input *feel*. (`handles`' window-relative `onScreen` was on this list; measured and fixed
      2026-08-19 — see "The aim point must be ON the surface, and INSIDE the panel".)
### `dnd`: accepted ≠ committed (measured + fixed 2026-07-22)

The prediction above was **confirmed**. Dropping a texture on a Hierarchy entity row returned
`{ok:true, accepted:true, types:[…]}` and did nothing: entity count unchanged, the target entity
byte-identical, `unsavedChanges:false`, and `canUndo:false` — not one undo entry pushed, which is
the decisive part, since every real editor mutation pushes one.

The cause is structural, not a slip. A Hierarchy row `preventDefault`s `dragover` for **any** asset
payload, and only then does its drop handler return early for anything that isn't a prefab. So
`accepted` — the only success signal the op had — can *only* ever see the first half. No amount of
care with `DataTransfer` fixes that, because the information isn't in the event sequence.

`performDomDnd` now takes an injected `editVersion` probe (the editor's monotonic non-selection
edit counter), waits out the async handler, and reports **`committed`**. Verified live in both
directions: texture → row gives `committed:false` + a warning naming the prefab case; prefab → row
gives `committed:true` (136 → 141 entities, `undoLabel: 'Instantiate "Cone"'`).

`ok` deliberately stays **true** on an uncommitted drop. The sequence really was delivered and
really was accepted; some legitimate drops make no undoable edit (a file move writes to disk), so
downgrading them would trade a false success for a false failure across drop targets nobody has
enumerated. The warning says exactly what is known and no more.
- [x] Apply the same question to the **device twin** (`device_tap`/`device_drag`/`device_pointer`/
      `device_press_key`/`device_hover`/`device_scroll`/`device_type_text`) — it dispatched SYNTHETIC
      DOM events, never OS-level trusted input, a strictly weaker fidelity position than the editor
      twins above. (It also carried a private-API PixiJS v8 poke for canvas ops; that was **inert** —
      the global it read was never assigned — and is now deleted. See #93 and
      [docs/debug-tools-mcp.md](debug-tools-mcp.md) § "Synthetic input: which canvas gets it".) Full
      route research + phased plan:
      **[docs/trusted-device-input.md](trusted-device-input.md)**
      (issue #32). Phase 0 (make the gap HONEST — every reply states the mechanism it used) has
      landed. **Phase 1 (Android CDP) has landed and is hardware-verified** (2026-08-02, on the
      Samsung — see the plan doc): `device_tap`/`drag`/`press_key`/`hover`/`scroll` now route
      through `Input.dispatchTouchEvent`/`dispatchKeyEvent`/`dispatchMouseEvent` over a CDP session
      to the device's debug WebView when one is reachable (reported `[input:trusted-cdp]`), falling
      back to the original synthetic path otherwise (`[input:synthetic]`) — `device_pointer` and
      `device_type_text` are unchanged, still synthetic-only. `device_status` now live-probes which
      mechanism is available rather than stating a constant. Phase 2 (iOS WebDriverAgent) is still
      open.

      **Capability matrix (op × platform × mechanism), current as of Phase 1:**

      | Op | Android | iOS |
      |---|---|---|
      | `device_tap` / `drag` | `trusted-cdp` when a CDP session to the debug WebView is reachable, else `synthetic` | **`trusted-wda`** when WebDriverAgent is provisioned + reachable, else `synthetic` |
      | `device_press_key` / `hover` / `scroll` | `trusted-cdp` when reachable, else `synthetic` | `synthetic` — **by design, not by omission** (see below) |
      | `device_pointer` | `synthetic` | `synthetic` |
      | `device_type_text` | `synthetic` | `synthetic` |

      **iOS routes a NARROWER set than Android, and that is measured.** WebDriverAgent supports only
      `pointer` and `key` W3C actions — it rejects `wheel` outright — a touchscreen has no hover
      state, and a trusted key reaches only a FOCUSED element (with the game canvas focused, WDA
      returns `ok` and the page receives nothing). Routing those three would stamp `trusted` on
      something weaker or dead, so they stay synthetic and say so. Detail + the measurements:
      `engine/plugins/backend/deviceWda.ts` and
      [docs/trusted-device-input.md](trusted-device-input.md).

      Check `device_status`'s input-mechanism line before relying on fidelity for a specific test —
      it reports the mechanism actually available RIGHT NOW (nothing when no lease is connected),
      never a hardcoded claim. On a `synthetic` row, also read the reply's `canvas:` marker: the
      synthetic path must CHOOSE a target element where a trusted injection is hit-tested by the
      browser, and `canvas:ambiguous` means that choice was a guess (#93).
      *Partly advanced earlier by the MCP audit's Phase 8:* a table-driven sweep over all 20
      `device_*` tools asserts each reports a failure as an envelope naming itself and treats the
      device's `Error: …` STRING reply as a failure. That found `device_console_logs` feeding the
      string to `result.map(...)` — the throw was then classified as a TRANSPORT failure, so a
      device-side refusal was reported as "the app may have been backgrounded — relaunch it". The
      false-success question is closed for all 20; the FIDELITY question is what the linked plan
      now tracks.

**`modoki_dnd` is the one input tool that cannot be aimed by `entity` (S3.6).** HTML5 DnD is a
DOM-element protocol — the source element's own `dragstart` handler fills the `DataTransfer`, which is
the whole reason this tool exists rather than a synthesized payload — so an endpoint is a DOM
`selector` or raw viewport `{x,y}`, and there is no scene-entity endpoint to resolve. It is also the
only input tool that cannot be aimed by `entity`. Both facts are now in the tool
description instead of being discoverable only by trying. Its endpoints are strict + refined, so `to:{}`
and a misspelled `selecter` are refused rather than reaching the relay as "no aim at all".

It DOES carry the shared `matched`/`hitTarget`/`occluded` provenance now, per endpoint, matching the
shape `/api/input/drag` returns (#260) — that it ran through the editor-action relay rather than
`/api/input/*` was never a reason for the report to be thinner, only for it to be assembled
separately. `aimProvenance` (`domResolve.ts`) is that shared assembly: `resolveDomPointReport` cannot
serve the DnD path (it is serializable by design and DnD needs the live `Element` to dispatch on), so
the recipe is factored out rather than copied — this module's header records what a second copy of a
resolver cost last time.

**And it does not occlusion-check either endpoint — deliberately, for a reason the other aims do not
have.** §3's rule refuses a covered aim because *the input would land on the covering element*; that
rationale does not hold here. `performDomDnd` resolves with `resolveDomPoint` (which computes no
occlusion at all) and then dispatches `dragstart`/`dragover`/`drop` with `el.dispatchEvent()` —
straight at the node, bypassing hit-testing. So a covered target really does receive the drop, and
refusing would reject a call that works.

The trap is the other way round, and it is a FIDELITY one: a covered drop **succeeds here where a
human's would fail**, hit-tested into the covering element. So a QA case that drops onto something
behind a modal passed, and the product could still be broken for a user — with nothing in the
response to say so.

**Closed as a WARNING, never a refusal (#260).** Both endpoints are hit-tested BEFORE any event
fires, and a covered one still gets the full sequence and still reports `ok:true`, because it
genuinely lands. What it also reports now is `occluded:true` on the offending endpoint, `hitTarget`
naming the cover, and a warning that opens `THIS DROP IS NOT ONE A HUMAN COULD PERFORM` and says
what to do about it. Both endpoints are checked: a covered SOURCE gets `dragstart` dispatched onto
something a human could not even grab.

Two things fix the shape of this and are worth keeping in mind before anyone tries to tighten it
into a gate. First, a refusal would reject calls that work — see the paragraph above. Second, the
endpoints are resolved before the gesture starts, so a cover that appears only MID-drag (the
Hierarchy drop indicator, the Assets drop overlay) is invisible from here; gating on a check that
cannot see those would be a false positive on legitimate flows. The warning composes with the
`accepted ≠ committed` one above — both can fire on one drop, joined by ` ALSO: `.

**Device-surface asymmetries (§9), both deliberate, neither previously written down:**
`allowOccluded` exists only on the editor — `resolveAim` (`bridge.ts`) refuses a covered selector
unconditionally, with no escape hatch — and the device surface has no `entity` addressing at all
(selector or screenshot pixels only), because it has no editor to resolve a scene entity through.
Both leave the device STRICTER than the editor, which is the safe direction; the `entity` gap is
now stated on `device_screenshot`'s description too, which used to send callers to "aim by
selector/entity" on tools that have no such parameter.
### Agent-input provenance: the actor lease (fixed 2026-07-22)

`withEditorActor` can only attribute code the agent **calls**. Trusted input is the opposite
shape — `sendInputEvent` injects real OS-level input and the editor's own handlers run,
indistinguishable from a human's click *by construction*, since that fidelity is the entire point.
Nothing on that path reaches the renderer op registry, so `withEditorActor` never wrapped it.

Measured, same session, back to back:

| Action | Journaled as |
|---|---|
| `modoki_tap` on a Hierarchy row | `!focus` + `!select` → **`source:"human"`** ← agent-driven |
| `modoki_gizmo` (a renderer op, so wrapped) | `!gizmo` → `source:"agent"` ← correct |

Provenance depended purely on which transport the op happened to use. That defeats the point of
the split: the human can't tell their own edits from Claude's, and Claude reports the human "did"
things Claude did.

The fix is a **lease**: `/api/input/*` opens one before dispatching and closes it after, at a
single seam wrapping every route (a per-route wrapper would be nine chances to forget, and the
next route added would silently reintroduce the bug).

**Why a lease and not a flag** — this is the whole design. A flag set around an async dispatch
sticks if the op throws, is killed, or the renderer reloads mid-flight, and then the human's
*entire remaining session* is mis-tagged `agent`: strictly worse than the bug. A lease carries a
**deadline** (lazy expiry, checked at emit — no timer to leak) and is **keyed to the in-flight
request**, so a late close from a superseded op can't strip attribution from the one now running.

Verified live in both directions: `modoki_tap` → `agent`; a CDP-dispatched click, same delivery
path but no lease → `human`.

**What it honestly cannot do:** while a lease is open the human is still at the keyboard, and
their click is byte-identical to the agent's. So this converts "100% of agent input is mislabeled
human" into "agent input is labeled agent; a human action inside a short, bounded window is
mislabeled agent" — the same race `withEditorActor` already documents, now with a deadline.

A corollary for tests: a jsdom test is necessary but **not sufficient** for an input change.
`fireEvent.*` synthesizes straight into React and cannot reproduce the real pipeline — see the
`PanelFocusHost` case in [editor-input.md](./editor-input.md).

## Open / deferred

Not-yet-done follow-ups, none blocking:

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
