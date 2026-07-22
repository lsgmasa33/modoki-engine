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
- **`type_text` reported success typing into a `readOnly` field.** `{ok:true, typed:3}` into the
  Inspector's readOnly name input, whose value was provably unchanged (`"пальма_1"` before and
  after, read via CDP). `typed` was only ever `text.length` — the op never reads back.
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
      Ctrl/Cmd+wheel paths are unreachable), `handles`' `onScreen` is window-relative rather than
      clipped to the owning panel, and `capture_gesture`'s `t` is an interpolation fraction with no
      time axis at all — which is odd for the op whose whole purpose is measuring input *feel*.
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
- [ ] Apply the same question to the **device twin** (`device_tap`/`device_drag`/
      `device_press_key`/`device_hover`/`device_scroll`), which dispatches SYNTHETIC DOM events
      rather than trusted input — a strictly weaker fidelity position.
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
