# UI System

modoki's UI layer is **ECS-driven**: each UI element is a normal entity carrying
`Renderable.layer = 'ui'` (the `RenderableUI` tag trait) plus a set of UI traits.
A React component, `UIRenderer`, queries those entities every time they change and
renders them as a tree of DOM nodes laid out with CSS flexbox. There is no separate
UI scene graph — the ECS world *is* the UI document.

This page documents the runtime UI traits, the renderer, the projection/dirty-flag
model that keeps it off the per-frame path, anchor positioning, directional
controller/keyboard focus, text animation, nine-slice backgrounds, fonts, an image-ref
gotcha, and the per-game custom-React-UI escape hatch.

Related: [Architecture](./architecture.md) · [Scene Loading](./scene-loading.md) ·
[Prefabs](./prefabs.md) · [Materials & Textures](./textures.md) · [Visual Editor](./editor.md)

---

## UI traits

All UI traits live in `packages/modoki/src/runtime/traits/`. An entity becomes a UI
node when it has the `RenderableUI` tag plus `UIElement`; the rest — `UIBinding`,
`UIAction`, `UIAnchor`, plus `UIFocusable` (marks an element reachable by directional
controller/keyboard focus nav — opt-in, resolved per active scope by `uiFocusSystem`)
and `Canvas2D` (marks a `UIElement` as hosting a 2D PixiJS canvas; child `Renderable2D`
entities render into it) — are optional add-ons.

### `UIElement` — the consolidated element trait

`UIElement` is a single ~73-field trait holding layout, box style, text, image, and
element-type properties. There is no separate "label" vs "panel" vs "button" trait —
**rendering is content-driven**: a node renders its `text` if non-empty, and paints
`imageSrc` as a CSS `backgroundImage` if non-empty (so text can sit *over* an image).

Field groups (representative fields, verified against `UIElement.ts`):

- **Layout** — `width`/`height` (+ `widthUnit`/`heightUnit`, `0` = auto). ⚠️ **Every `*Unit` field
  is the SIX-member `UILengthUnit`** — `'px' | '%' | 'vw' | 'vh' | 'vmin' | 'vmax'` — exported from
  `@modoki/engine/runtime`, and every one of them is selectable from the Inspector dropdown. This
  line read `'px' | '%'` until 2026-08-07, contradicting the viewport-units paragraph below and the
  type itself; a game had already written a three-way unit resolver that silently treated `vw` and
  `vmax` as `vmin`, which is wrong on any non-square host. **Resolve units through a map that is
  total over the union, not a ternary chain with a fall-through.** Also:
  `flexDirection`, `flexWrap`, `justifyContent`, `alignItems`, `gap` + `gapUnit`, `flexGrow`,
  `flexShrink`, per-edge `padding*`/`margin*` (each with its own `*Unit`),
  `minWidth`/`maxWidth`/`minHeight`/`maxHeight`, `alignSelf`, `zIndex`, `overflow`
  (`visible | hidden | scroll`), `isVisible`, `pointerThrough` (see below).

  ⚠️ **Match `gapUnit` to the unit the CHILDREN are sized in.** `gap` was px-only until
  2026-08-07, and a `flexWrap: 'wrap'` container whose items scale (`vh`/`vmin`/`%`) while its
  gaps do not has a viewport size below which an item silently reflows onto the next row — the
  items shrink, the gaps do not, and eventually one stops fitting. It is silent because nothing
  is wrong with the data: Court's 5x5 attack reference (five 5vh cells, four 4px gaps, a 29.6vh
  row) needed 98.95px of a 98.26px row on a short window and drew 4-wide by 7 rows deep. Mixed
  units are only safe where the row COUNT carries no meaning.

  ⚠️ **`fontSize` carries a unit too, since #245 — and it did NOT until then.** It was unitless px
  while every other length had a unit, so an element whose HEIGHT comes from its text could not
  scale while its container could: there was always a viewport size below which such content
  overflowed a `%`/`vh`-sized parent. Court hit it twice — a pen glyph that "agreed at exactly one
  screen size and drifted at every other", and its main menu overflowing the paper page below a
  ~975px window. `fontSizeUnit` defaults to `'px'`, so nothing authored before it changes.
  **Pick the unit from the CONSTRAINT's axis**: if the thing that must fit is a height, use `vh` —
  `vmin` is `min(vw,vh)` and tracks WIDTH on any landscape host, so a window that only gets shorter
  would shrink the parent and leave the text alone. And remember margin/padding percentages resolve
  against WIDTH even for `marginTop`, so a `%` top margin is a width-derived vertical term.
  ⚠️ **`letterSpacing` carries a unit too, and it must MATCH `fontSizeUnit`.** Tracking is only
  meaningful as a ratio of the glyph size, so px tracking under a scaling font says something
  different at every viewport — measured on Court's menu title, 0.130em of tracking at its
  reference size and 0.261em at a 480px window, from the same authored 7px, because only the font
  shrank. Both now scale: 0.1296em and 0.0627em hold across viewports (observed live).
  ⚠️ `lineHeight` is still px-only — leave it `0` (auto) alongside a scaling `fontSize`. So are
  `textStrokeWidth`, `textShadowOffset{X,Y}`/`textShadowBlur`, `borderWidth` and `borderRadius`;
  each has the same shape and will drift under a scaling font, and none is wired yet.
- **Style (box visuals)** — `backgroundColor` (packed hex int, `0` = transparent),
  `backgroundOpacity`, `borderRadius`, `borderWidth`, `borderColor`, `borderOpacity`
  (border color alpha, folded into the `borderColor` picker), `opacity`.
- **Text** — `text`, `fontFamily`, `fontSize` + **`fontSizeUnit`**, `fontWeight`, `fontStyle`, `textColor`,
  `textOpacity` (folded into the `textColor` picker), `textAlign`, `lineHeight`,
  `letterSpacing` + **`letterSpacingUnit`**, `textShadow*` (color/opacity/offsetX/offsetY/blur — `textShadowOpacity`
  folded into `textShadowColor`), `textStrokeColor`/`textStrokeOpacity`
  (folded into `textStrokeColor`)/`textStrokeWidth`, `textOverflow` (`clip | ellipsis`),
  `maxLines`.
- **Image** — `imageSrc`, `imageMode` (`cover | contain | fill | none`).
- **Element type** — `elementType` (`div | input | range`) and `placeholder`. Most
  elements are `div`; `input` renders an `<input>` text field and `range` renders an
  `<input type="range">` slider (`rangeMin`/`rangeMax`/`rangeStep`).

Colors are stored as packed hex integers (e.g. `0xffffff`) and converted to CSS at
render time. Numeric+unit pairs are converted by `UINode`'s `cssVal()` helper, which
also supports viewport units (`vw`/`vh`/`vmin`/`vmax`) via CSS custom properties that
`UIRenderer` sets on its container — so viewport-relative sizes resolve against the
**game viewport**, not the browser window (critical for the editor's simulated device).

### `UIBinding` — store-driven content & visibility

Connects an element to a Zustand store (`UIBinding.ts`):

- `textBinding` — store field whose value feeds the `text` template.
- `visibleBinding` + `visibleOp` + `visibleValue` — gate visibility on a store field
  (in ADDITION to the authored `UIElement.isVisible` — both must be true). `visibleOp`
  is `''` (truthy) | `'=='` | `'!='` | `'>'` | `'>='` | `'<'` | `'<='`; the store value
  is compared against `visibleValue` (number-coerced when both look numeric).
- `inputBinding` — two-way value field for `input`/`range` elements.
- **Active highlight** — `highlightTarget` (a GUID) / `highlightComponent` /
  `highlightProperty` / `highlightValue` / `highlightColor` / `highlightTextColor`:
  paint this element with `highlightColor`/`highlightTextColor` whenever the live value
  of `highlightComponent.highlightProperty` on the `highlightTarget` entity string-equals
  `highlightValue` (canonical use: a clip-selector button that lights up while its clip is
  the one playing). Disabled when `highlightColor` < 0 (the default). It reads the source
  of truth directly (no mirrored store flag) and re-resolves only on a UI dirty signal — a
  system that drives the watched value via a raw `entity.set` must call `markUIDirty()`.

Text templates use `{field}` placeholders resolved by `resolveTemplate()` in
`runtime/ui/bindingResolver.ts`; visibility by `evalVisibility()` in the same file.

### `UIAction` — button & input events

A single AoS array field, `bindings: UIActionBinding[]` (`UIAction.ts`) — the six old
fields (`onClick`/`onClickPayload`/`onClickTarget`/`onClickSet`/`onChange`/`onSubmit`)
were unified away. Each binding (`runtime/ui/bindings.ts`) fires on one `event`
(`'click'` | `'change'` | `'submit'`) and does one of two `kind`s of work:

- `kind:'set'` — a declarative property write: set `property` of `component` on the
  `target` entity (empty → the element's own entity) to `value`. Subsumes the old
  show/hide pair — opening a panel is `UIElement.isVisible = true`, no game code.
- `kind:'call'` — dispatch a named `action` (system logic or an engine built-in like
  `engine.loadScene`) with typed `params`.

The `$value` token (in a set's `value` or any `params` entry) is replaced at dispatch
with the triggering event's value — e.g. a range slider's `change` writes its live
number straight into a field with zero game code.

`UINode` runs the matching rows with `applyBindings(node.action.bindings, event, {selfGuid, …})`
(imported from `runtime/ui/bindings.ts`) on `'click'`/`'change'`/`'submit'`. For a
`kind:'call'` row, `applyBindings` dispatches internally through `dispatchUIAction` into
`runtime/core/actionRegistry.ts`, where games register handlers via
`registerUIAction(name, handler)` / `unregisterUIAction(name)`. An unknown action
**throws in dev** and warns in production, so typo'd action names surface immediately.
(Bindings are inert unless the game is running — `applyBindings` early-returns when the
sim is stopped, so editor Stopped/Paused states never mutate the scene.)

#### Engine built-in `UIAction`s

Four stateless lifecycle/animator handlers are registered once at startup by
`registerEngineActions()` (`runtime/actions/engineActions.ts`), callable from any
`kind:'call'` binding by name:

- **`engine.reload`** — `window.location.reload()` (hard web-view reload).
- **`engine.quit`** — a no-op that logs on web; the app shell wires Capacitor's
  `App.exitApp()` if a real device quit is needed.
- **`engine.toggleAnimator`** — flips `playing` on the binding's `target` entity's
  animator, toggling whichever of `SkeletalAnimator` (GLB skeletal clips) / `Animator`
  (keyframe `.anim.json`) the target carries — a plain field write the render sync picks
  up next frame. Warns if the target is missing or carries neither trait.
- **`engine.playClip`** — switches the target's active clip BY NAME across all three
  animator flavours (`Animator` keyframe, `SpriteAnimator` flipbook, `SkeletalAnimator`
  GLB) — the unified twin of `engine.toggleAnimator`. The clip name comes from the
  binding's typed `clip` param (or the event `$value`); keyframe/sprite validate the name
  synchronously against their clip bank and no-op+warn on an unknown one, while skeletal
  clips are validated at the render layer (unknown names are ignored there).

Scene navigation (`engine.loadScene` / `engine.navigateBack`) is **not** here — it lives
in `NavigationManager`, which owns the history stack (see
[Managers & Systems](./managers-and-systems.md)).

### `UIAnchor` — screen positioning + safe area

For root UI containers that should pin to a screen edge rather than flow in their
parent (`UIAnchor.ts`):

- `anchor` — one of `stretch`, `center`, the four edges (`top`/`bottom`/`left`/`right`),
  the four corners (`top-left` … `bottom-right`), and the stretch variants
  (`top-stretch`, `h-stretch`, `v-stretch`, etc.).
- `top`/`left`/`right`/`bottom` (+ units), `pivotX`/`pivotY` (0..1 pivot relative to the
  element's own box), `zIndex`.
- `safeArea` — when true, padding is `max(<padding>, env(safe-area-inset-*))` so content
  clears notches and home indicators.

An anchored element is rendered with `position: absolute`; pivot is applied as a CSS
`translate(-pivotX%, -pivotY%)`. Stretched axes ignore pivot (both edges are pinned).

**An offset means a different thing per axis, and the axis decides — not the field.**
On a **non-stretched** axis the anchor is a single *point*, so an offset **moves** the
box and leaves its size alone: `left`/`top` push away from that point, `right`/`bottom`
push *inward from the far edge* (i.e. they subtract from the same near edge). On a
**stretched** axis both edges are pinned, so each offset **insets its own edge** and the
box **shrinks** — `left: 5%` + `right: 5%` on a `bottom-stretch` bar is a pair of side
margins, giving a 90%-wide band. (Folding `right` back into the near edge there would
make the two cancel to a full-bleed box — the bug fixed 2026-07-31.) A stretched axis
also **clears any authored `width`/`height`**, so the two offsets fully govern that axis.

That last clause is a trap worth stating twice, because the authored value is still
*stored and displayed*: on a stretched axis `UIElement.width`/`height` can never take
effect, and the two offsets are the ONLY way to size it. The axes are independent — a
`top-stretch` element has an inert width but a perfectly live height. Three places agree
on this via the one predicate `isSizeInert` (`runtime/ui/anchorLayout.ts`), so none of
them can drift from the layout that does the clearing:
- **the layout** — `applyAnchorStyle` clears the CSS size, `resolveAnchorRect` overwrites
  the pixel extent;
- **the Inspector** — greys the field out per-axis (read-only input + disabled unit
  dropdown; across a multi-selection only when it is unanimous — see below) and, on
  hover, names the responsible anchor and the offsets to edit instead.
  The `AnchorLayoutNote` banner atop the Layout section says the same thing generically
  for the whole section; the per-field tooltip is the specific half — *which* axis, and
  what to reach for. It deliberately **supersedes** the field's own hint, because
  "0 = auto (sized by content/flexbox)" is false once the axis is stretched;
- **the scene validator** — warns on an authored size the anchor makes inert, so a scene
  read as JSON gets the same signal the Inspector gives, including for a prefab
  instance's overridden fields when a prefab resolver is available. Its noise budget
  (why `0` and `100%` are excluded) and the prefab-instance resolver contract are in
  [scene-loading.md](./scene-loading.md#scene-validation-warn-but-load).

**Across a multi-selection the gate is unanimous-or-nothing.** Because it *disables* the
control rather than merely dimming it, resolving it from the primary entity alone is wrong in
both directions: a stretched primary makes the field read-only on siblings where the value
genuinely takes effect, and an un-stretched primary lets a write land on siblings that
silently discard it — the very trap the gate exists for, re-entered through the selection.
So both gates read EVERY selected entity (`selectionSizeGate` / `selectionAnchorGate`,
`runtime/ui/uiAuthoring.ts`) and yield one of three verdicts: **inert** (dead on all → read-only
+ dimmed), **live** (dead on none → untouched), or **mixed** — which stays **editable**,
half-dimmed, its tooltip stating how much of the write will be discarded. Blocking the mixed
case would strand the entities where the value works, which is why "some are inert" may not
disable anything. The same rule governs the self-placement props and the `AnchorLayoutNote`,
which carries a "partly anchored" wording rather than claiming fields are disabled when they
are not. One distinction the two gates deliberately disagree on: an anchor with an unreadable
mode kills self-placement (any anchor does) but stretches nothing, so it leaves the size live.

The failure mode this guards: `games/court`'s `NarrationBand` carries `width: 90%` on a
`bottom-stretch` anchor whose `left: 5%` + `right: 5%` offsets independently produce 90%.
It looks deliberate and correct, and editing that field to `50%` would change nothing.

---

## `UIRenderer` — ECS → DOM

`runtime/ui/UIRenderer.tsx` is the entry point, mounted in both the **GameView**
(editor) and the running app (`app/App.tsx`, via `DefaultGameUILayer`). It:

1. Pulls the current UI node tree from `useUIEntities()`.
2. Measures its own container with a `ResizeObserver` and sets `--ui-vw/--ui-vh/
   --ui-vmin/--ui-vmax` CSS variables so viewport units resolve to the container.
3. Renders each root through `UINode` (recursive), passing a `storeState` object used
   to resolve bindings and an optional `onSelectEntity` callback (editor click-select).

The container is `position: absolute; inset: 0; pointerEvents: none` — only interactive
leaves (buttons, inputs, scroll containers) re-enable `pointerEvents`, so the UI never
blocks the 3D/2D canvases underneath.

#### `pointerThrough` — the escape hatch those rules cannot express

The rules above are inferred from STRUCTURE: an element with a click binding is interactive, a
LEAF with none is transparent, and a **container stays `auto` because it must pass events to its
children**. `overflow: 'scroll'` separately forces `auto` so the box can be scrolled.

That leaves one shape unrepresentable: **a decorative container drawn over something that must
stay tappable.** `UIElement.pointerThrough` is the author's explicit "let taps through to what is
behind me". It is applied last, so it outranks both inferences — inference must not beat a
statement of intent.

- It does **not** disarm children. CSS `pointer-events: none` on a parent leaves a child that sets
  `auto` fully clickable, which is the entire point: a decorative panel that still holds a working
  button.
- It is **ignored in the editor's click-to-select mode** (`onSelectEntity`). Selecting an element
  in the viewport is authoring, not gameplay — an element the game must not receive taps on is
  still one the author has to be able to pick.
- On an `overflow: 'scroll'` box it gives up **scrolling** (that is what the force was for), so it
  is correct only when the box is sized never to overflow.
- A child `Canvas2D` re-enables `auto` on its own mount, so a `pointerThrough` container wrapping
  one still delivers taps to the canvas. That is the "children keep their own" rule, not an
  exception to it.

Worked example — Court's narration band: a panel holding a Skip button, drawn above a full-screen
tap-catcher. Being a container (and a `scroll` one) it swallowed every tap meant for the catcher;
putting the catcher on top instead buried Skip inside the band's stacking context and made it
silently unclickable. Neither ordering works, because the two controls need opposite answers —
`pointerThrough` is what breaks the tie.

`UINode` (`runtime/ui/UINode.tsx`) translates one `UINodeData` into a styled DOM
element, applying the trait fields in order (layout → box style → image → text →
anchor → click handler), then recurses into children. It is wrapped in `React.memo`.

### Parent/child tree from `EntityAttributes.parentId`

There is no nested data structure in ECS — every UI entity is flat. The tree is built
in `runtime/ui/uiTreeStore.ts` (`buildTree()`): it queries all
`RenderableUI + UIElement` entities, reads `EntityAttributes.parentId` /
`sortOrder` for each, then links children to parents. The builder is **cycle-safe**:
any node whose parent chain doesn't terminate within `nodes.size` hops is treated as a
root and logged in dev (so the editor can flag a bad `parentId`).

---

## Projection & the dirty flag (no per-frame work)

The UI tree is **not** rebuilt every frame. `useUIEntities()` is a thin Zustand
selector over `uiTreeStore`:

```ts
export function useUIEntities() {
  return useUITreeStore(s => s.tree);
}
```

The store is updated by `uiTreeProjection(world)`, an ECS system registered at
`SYSTEM_PRIORITY.PROJECTION`. It checks a module-level `_dirty` flag:

- Any ECS write that could affect UI (`writeTraitField`, `deleteEntity`, …) calls
  `markUIDirty()`, an O(1) boolean set wired in via `addDirtyListener`.
- Each frame, `uiTreeProjection()` runs once; if clean it **returns immediately**
  (zero cost when the UI is idle); if dirty it clears the flag, rebuilds the tree, and
  pushes it into the Zustand store, which re-renders the subscribed React components.
- A world swap (scene change) forces a rebuild and clears the tree.

This replaced an older architecture that re-queried ECS and diffed ~50 fields per node
every frame. See [Architecture](./architecture.md) for where PROJECTION sits in the
frame pipeline.

---

## Anchor layout (`resolveAnchorRect`)

`runtime/ui/anchorLayout.ts` exposes `resolveAnchorRect(w, h, vpW, vpH, anchor)`, which
resolves a `UIAnchor` to a pixel rect within a viewport. It is the **shared** source of
truth for anchor math: the runtime DOM path in `UINode` mirrors it with CSS
`top/left/right/bottom` + `translate`, and the editor's `SceneView` uses it directly to
draw the device-space gizmo over the simulated viewport. Keeping both paths on one
function avoids the runtime and editor drifting on edge cases (pivot on stretched axes,
far-edge offsets subtracting inward on a point axis but insetting on a stretched one,
etc. — see the offset rules under `UIAnchor` above).

The parity test (`uiAnchorParity.test.ts`) feeds identical anchor data to both paths and
asserts they agree. **Agreement is not correctness** — it pins consistency, and the two
implementations can be wrong in the *same* way, which is exactly how the stretched-axis
offset bug survived. So that suite also asserts the resolved rect outright (a 5%/5%
`bottom-stretch` band must measure x=5%, w=90%), not just that the two paths match.

---

## Directional focus navigation (controller / keyboard)

`UIFocusable` opts an element into pointer-free navigation — a controller or keyboard
traverses and activates UI without a cursor. It is purely additive: pointer/touch is
unchanged, and focus stays inert until nav input arrives. **v1 is opt-in** — only
entities carrying the trait are focusable (auto-focusability for every interactive
element is a deliberate follow-up, to avoid changing existing pointer-only games).

### `UIFocusable` trait (`runtime/traits/UIFocusable.ts`)

All-scalar (GUID strings / number / booleans), so it serializes cleanly and is
editor-authorable:

- `focusable` — participates in nav (default `true`).
- `focusOrder` — tie-break within a scope (lower = earlier); seeds autofocus and is the
  stable fallback when no on-screen rect is available (headless).
- `navUp` / `navDown` / `navLeft` / `navRight` — explicit directional link target GUIDs;
  empty → fall back to spatial resolution. Authoring these pins a menu's traversal
  regardless of layout.
- `focusScope` — groups a screen/menu/modal; focus only moves among same-scope elements
  (`''` = default scope).
- `autoFocus` — when this scope becomes active and nothing is focused, focus lands here
  (lowest `focusOrder` wins among several marked).

### `uiFocusSystem` + `focusManager`

`uiFocusSystem` (`runtime/ui/uiFocusSystem.ts`) is an app-pipeline GAME-tier system
— it runs only while the sim plays, after `inputSystem` writes the frame's input edges.
Each tick it: gathers focusable candidates in the **active scope** (top of the scope
stack), ensures something is focused (autofocus if not), moves focus on a nav edge
(`navUp`/`navDown`/`navLeft`/`navRight`), queues activation on `confirm`, and pops the
scope on `cancel`. It reads only plain data (the `Input` resource, ECS traits, on-screen
rects, the focus store) — no wall-clock, no RNG — so it is determinism-guard-safe and
harness-testable.

`focusManager` (`runtime/ui/focusManager.ts`) owns the state in a Zustand store
(`focusedGuid`, a `scopeStack`, and `pendingActivateGuid`) so `UINode` re-renders its
focus ring reactively — no per-frame polling, matching the `uiTreeProjection` dirty-flag
pattern. `UINode` subscribes with `useFocusStore(s => s.focusedGuid === node.guid)`, so
only the entering/leaving node re-renders; the ring is a non-layout
`outline: 2px solid #4aa3ff` (offset 2px) that never shifts the flexbox box, and it is
**runtime-only** (suppressed in the editor's click-select mode).

Directional resolution, per move:

1. **Explicit link** — the `nav<Dir>` GUID, if it points at a live scoped candidate.
2. **Spatial** — `pickInDirection()` picks the nearest scoped candidate strictly in the
   pressed direction, scored by distance *along* the axis plus 2× the perpendicular
   offset (a slightly-off but closer target still wins; a wildly-sideways one loses).
   Rects come from the **DOM** — the same `[data-entity-id]` nodes the `layout-bounds` op
   reads — measured within ONE host, the one holding the focused node (the editor mounts a
   `UIRenderer` in both GameView and SceneView's preview frame, and the two are different
   projections of the same layout). A registered bounds provider is the fallback for a
   non-DOM host; headless (no rects either way) → spatial no-ops, but explicit links +
   autofocus still work.

   ⚠️ It read `collectScreenBounds()` alone until QA-UI-0002, and that never returned a
   rect for a UI entity: **every bounds provider is a 2D/3D renderer** (`Scene2D`,
   `Scene3D`, `SceneView`), and UI rects have always been merged separately from the DOM.
   So the spatial tier — the fallback that fires when an explicit link points at something
   no longer focusable — could not fire in a real game, and focus BLOCKED on a disabled
   button instead of skipping it. It looked healthy because the unit test registered a
   provider of its own.

Candidate gathering enforces **ancestor-inclusive visibility**: the canonical hide
pattern sets `UIElement.isVisible=false` on a panel container while its children stay
visible, and `UINode` prunes the whole subtree — so `gatherCandidates` walks each
candidate's parent chain and excludes any child of a hidden ancestor, matching the
renderer's prune.

**Deferred activation, on purpose.** `applyBindings`'s `call` path must run from an event
context, not a pipeline tick (it throws in dev otherwise — see `bindings.ts`). So
`confirm` does NOT fire bindings inside the system tick: `uiFocusSystem` sets
`pendingActivateGuid`, and `consumePendingActivation(world)` — drained from the
`UIRenderer` effect (or a headless test) — runs the SAME
`applyBindings(bindings, 'click', …)` a DOM tap runs. It clears the pending GUID first
(reading the live store value), so two `UIRenderer`s draining in one tick activate
exactly once. Focus fully resets on world/scene swap (`onWorldSwap` → `resetFocus`), so
stale GUIDs never linger.

---

## Text animation (`TextAnimation` → CSS)

`TextAnimation` (`runtime/traits/TextAnimation.ts`) is a modifier trait: attach it
alongside a text-bearing entity and its glyphs animate procedurally from
`(glyphIndex, engine time, params)` — no per-glyph authoring, and it works on
dynamic/CJK strings of any length. Fields: `effect` (`none | typewriter | wave | bounce |
jitter | fade | rainbow`), `speed`, `amplitude` (em — emitted as `em`, see below), `frequency` (per-glyph
phase), `loop`, and `fadeIn` (typewriter soft-fade vs hard-pop). Like skeletal animation
it plays only while the sim runs and freezes when stopped.

The trait is **shared across all three text layers** but realized differently:

- **2D / 3D world text** (`Text2D`/`Text3D`) animate per-glyph GEOMETRY via the pure
  `applyTextAnimation()` (`runtime/rendering/text/textAnimate.ts`): it rewrites the
  laid-out glyph quads each frame — translating (wave/bounce/jitter), collapsing hidden
  glyphs to zero-area rects for a typewriter reveal (length-invariant, so geometry
  rebuilds in place with no shader recompile or vertex-count churn), or tinting per-glyph
  (`fade`/`rainbow`). Offsets are authored in em and scaled to px here; jitter uses an
  integer hash, never `Math.random`/wall-clock — headless-testable and
  determinism-guard-clean.
- **DOM UI text** (`UIElement.text`) can't animate per-glyph geometry (it's one styled
  string), so `uiTextAnimation()` (`runtime/ui/uiTextAnimation.ts`) maps the same effect
  vocabulary to a **CSS `@keyframes` animation** run by the browser compositor (no
  per-frame ECS/React work). Amplitude drives the translate distance via a `--ui-amp`
  custom property so the keyframes stay static (injected once by `ensureUITextAnimStyles()`).
  Most effects animate the whole element (wave→float, bounce, jitter→shake, fade→pulse,
  rainbow→a scrolling `background-clip:text` gradient); **typewriter is genuinely
  per-character** — `UINode`'s `AnimatedText` splits the text into one `<span>` per glyph
  and staggers each by `staggerSec` (a width clip would slice mid-glyph on a proportional
  font), so whole glyphs pop/fade in sequence.

The play gate lives in the **projection**, not the renderer: `uiTreeProjection`
(`uiTreeStore.ts`) copies `TextAnimation` onto `node.textAnim` only when `isSimRunning()`,
so a stopped editor shows static text and starting/stopping the sim re-renders the node.

---

## Nine-slice backgrounds

A UI sprite with authored **border insets** renders as a scalable 9-slice background
behind a `UIElement`'s text/children — corners stay fixed, edges + centre stretch. When
`UINode` resolves a `UIElement.imageSrc` to a sprite whose `border` (`{l,r,t,b}` in source
px, optional `scale`) is non-zero, it renders `NineSliceImage`
(`runtime/ui/NineSliceImage.tsx`) instead of a plain CSS background.

`NineSliceImage` paints the 9 regions as SEPARATE, slightly-overlapping `<div>`s — NOT
CSS `border-image`. Per spec, border-image's regions tile exactly and cannot overlap, so
Chrome leaves hairline subpixel seams under the non-integer scaling of the editor preview;
separate divs each bleed `OV = 1px` past their grid cell to swallow the gap — seamless at
any zoom, no backstop plane. The layer sits `pointer-events:none`, `z-index:-1` behind
content (the host element sets `isolation:isolate`); a CSS grid (`{l} 1fr {r}` ×
`{t} 1fr {b}`) adapts cell sizes to the element's real, unknown size. Each cell shows its
source sub-rect via the dimensionless `background-position`/`background-size` % trick, so
it's independent of the (downscaled) texture variant actually loaded.

### ⚠️ `scale` does not adapt — and for a capsule that is load-bearing

`border.scale` is **CSS px per source px, fixed**. The grid adapts *cell sizes* to the element's
real size, but the corner/edge columns are drawn at `inset × scale` regardless of how big the
element turned out. So a master is only correct at the size its `scale` was chosen for.

The sharp case is a **capsule** — a pill sliced with `t/b = 0`, where the left/right columns *are*
the round caps. A true capsule needs its cap exactly **half the rendered height**; the columns
still stretch vertically to fill, so any other value renders them as an ellipse. Court shipped
`btn-pill-small` (228×68, `l/r = 36`) at `scale: 1` inside a 26 px-tall button: caps drawn 36 px
wide and crushed to 26 tall, sitting inside the element's own `borderRadius: 999` — which draws a
*real* capsule. Two mismatched curves, one inside the other, reading on screen as a stray shape
floating in the button. `scale: 0.36` (= 13/36) fixes it.

- **The check**: `l × scale ≈ height / 2`. Measure the emitted columns to confirm — expect
  `l × scale + 2`, since each cell bleeds `OV = 1px` per side (above).
- **Slicing a pill horizontally cannot work.** `t/b > 0` cuts through the caps and straightens
  their sides; no guide value recovers the curve. A small pill needs its own master at `t/b = 0`
  rather than a share of a bigger button's.
- **A viewport-relative height desyncs it.** An element sized in `vmin`/`vh` under a fixed `scale`
  is only correct at one viewport; below that the caps flatten again. Pin the height in px, or
  accept the distortion off the design size. Court's pill measured 26 px on an iPad Pro 11", 19 px
  on an iPhone Air and 16 px on a folded Fold7 from one `4.5vmin` authoring — caps 1.00× / 1.37× /
  1.60× off. Only the height matters; the width may stay relative, since the middle column stretches.
- ⚠️ **Verify on the SMALLEST target, never the largest.** Where a `vmin` height clamps to its own
  px cap, the broken and pinned authorings render identically — so the big screen passes under both
  hypotheses and proves nothing. The iPad did exactly that for Court.

### The 9-slice editor

`NineSliceEditor` (`editor/panels/NineSliceEditor.tsx`) is a dev-only modal opened from
the Texture Inspector (UI-type textures — also reachable via the `modoki_open_nine_slice_editor`
MCP tool). It shows the source image on a zoomable/pannable canvas with **four draggable
guide lines** (the l/r/t/b insets) plus an "edge scale" (CSS px per source px — Unity's
"pixels per unit"). Save persists `border` into the texture's `.meta.json` sidecar and
**live-registers the texture's auto whole-image sprite** with the new border (via
`registerSprite` + `markUIDirty`), so `UINode` reflects the edit without a rescan. The
four guide knobs are also exposed as Enact interaction handles (`kind:'nineslice-guide'`)
for headless dragging.

Two things about the modal are load-bearing, both from the same report ("editing the 9-slice
doesn't change the Inspector values", owner 2026-08-18):

- **Save AWAITS the meta write before calling `onClose`.** The Inspector's close handler re-reads
  the same sidecar (`loadMeta()`), so an un-awaited POST raced that GET over one file with no
  ordering between them. When the GET won, the edit was on disk and the Inspector kept showing
  the pre-edit numbers indefinitely. It reproduced 2 times in 6 on a live editor — intermittent
  enough that a first attempt to reproduce it came back clean, which is exactly what made it
  expensive. `writeMetaOrWarn` returns its promise for this reason; a caller that then READS the
  file back must await it. (`SpriteEditor` had the identical shape and the identical fix.
  `EnvironmentAssetView` was already writing `await writeMetaOrWarn(...)` against the old `void`
  signature — an await that sequenced nothing.)
- **Closing without saving REVERTS the live preview.** The preview re-registers the whole-image
  sprite on every drag; nothing used to undo it, so Cancel left the RUNNING manifest holding the
  discarded border while the file and the Inspector held the old one. Measured on `games/3d-test`'s
  "Hello Buton" (a UI element whose `imageSrc` IS that sprite guid): drag `l` 34→59, Cancel, then
  touch any `UIElement` field and the button re-renders at `background-size: 472.881%` (279/59)
  instead of `820.588%` (279/34) — file 34, Inspector 34, screen 59, for the rest of the session.
  That three-way divergence is most of why the whole thing read as "the editor applied my change
  but the Inspector didn't update". `nineSliceRevert.ts` restores the SNAPSHOT taken when the modal
  opened rather than re-deriving from the meta: a sliced sheet has no whole-image sprite at all
  (see [textures.md](./textures.md)), so it must end up with none again rather than one the modal
  invented. A FAILED write does not count as saved: `savedRef` is assigned from the write's RESULT,
  so the revert still fires and the live sprite cannot keep a border that never reached disk.
- **A failed write keeps the dialog OPEN** (owner, 2026-08-18), with the reason logged — closing
  would throw the edit away for something that has nothing to do with the edit (a dev-server blip)
  and leave no way to retry. Verified against a real 500: the dialog stays open with the edit
  intact, pressing Save again lands it, and cancelling after a failed save still reverts the
  preview to the last value that actually reached disk. `SpriteEditor` does the same, and matters
  more there — a slice set is far more work to re-author than four insets.
- **The backdrop does NOT dismiss it.** This dialog holds unsaved work, and a stray click outside
  used to close it and discard every edit with no confirmation — indistinguishable from a Save,
  while the scene kept the live preview. Cancel and Save are the only exits. The one-shot pickers
  (SpritePicker, AddPropertyPicker, BindAnimatorPicker, the layout prompts) keep their backdrop
  dismiss, because there dismissing IS the cancel. Guarded both ways by
  `engine/tests/architecture/modalDismissScope.test.ts`.

---

## Fonts

Two independent font pipelines feed the two text worlds:

### DOM / PixiJS fonts (`FontFace`)

`runtime/loaders/fontLoader.ts` loads `.ttf`/`.otf` files via the browser `FontFace` API
and registers each family (`document.fonts.add`), serving both the DOM UI layer
(`UIElement.fontFamily`, a CSS family name — never an asset GUID) and the PixiJS 2D layer,
since both use the browser's font system. `loadAllFonts()` bulk-loads every `type:'font'`
asset from the scan; concurrent loads of the same path share one in-flight
`FontFace.load()`, and a failed load is evicted so it can retry. Family/weight/style come
from the filename (`parseFontFilename`); a (weight, style) collision within a family warns
(last-added wins). `getLoadedFontFamilies()` backs the Inspector's font dropdown.

### MSDF world-text atlases (`Text2D`/`Text3D`)

World-space text renders from a signed-distance-field atlas, not a `FontFace`.
`engine/plugins/font-convert.ts` (Node — dev server + build) runs **msdf-atlas-gen** over
a source `.ttf`/`.otf` and the resolved charset to emit an mtsdf atlas PNG + a Chlumsky
JSON metrics layout into a content cache (cache hits skip the work; a missing
`msdf-atlas-gen` binary surfaces an install hint). Per-font settings live in the font's
`.meta.json` (`font` block, `runtime/core/fontSettings.ts`): `fieldType` (`mtsdf`),
`size` (default 128), `pxRange` (default 8 — headroom for outline/glow), `charset`
(`ascii`/`latin1`/`custom`), `atlasMax`, and `mode` (`baked` fixed atlas vs `dynamic`,
which seeds a runtime MSDF generator for unseen/CJK glyphs). Settings are baked into the
asset manifest (`FontManifestBlock`) so the runtime picks its provider without a per-font
fetch; the derived files are served/copied at the `~atlas.png` / `~metrics.json` variant
URLs, mirroring the texture-variant convention (see [Materials & Textures](./textures.md)).

---

## Image-ref gotcha (production builds drop source PNGs)

2D/DOM image refs (`UIElement.imageSrc`) **must** resolve through the texture variant
resolver, not the raw asset URL. `UINode` does this via `resolveDomImageUrl(node.imageSrc)`
(from `runtime/rendering/renderUtils`), which maps the ref to its **WebP/PNG** variant for
the DOM path — a `<img>`/CSS `background-image` cannot decode the KTX2 GPU variant.

This matters because `vite build` drops source PNGs from `dist/` and ships only the
converted variants. Resolving an `imageSrc` with raw `resolveRef` + `assetUrl` would
point at a PNG that no longer exists in production, yielding a broken image. Do NOT use
`resolveImageUrl` here — it returns `resolveTextureVariantUrl(ref, '2d')`, the KTX2 GPU
variant meant for the PixiJS/Scene2D path, which the DOM can't decode. Always go through
`resolveDomImageUrl` → `resolveBrowserImageUrl` for DOM/Canvas2D. See
[Materials & Textures](./textures.md) for the full conversion pipeline.

---

## Custom React UI per game

Sometimes a game's UI is easier to write as a hand-authored React component than as ECS
entities (chat transcripts, a chessboard, etc.). A game's `GameDefinition` (exported as
`game` from its `game.ts`) may set an optional `UIComponent`:

```ts
UIComponent?: React.LazyExoticComponent<React.ComponentType> | React.ComponentType;
```

When set, the app renders this component **instead of** the default ECS `UIRenderer`.
The component takes **no props** — it reads Zustand stores and ECS queries directly.
Lazy-load it to keep it out of the main bundle:

```ts
UIComponent: React.lazy(() =>
  import('./chess/runtime/ui/ChessGameUI').then(m => ({ default: m.ChessGameUI })),
)
```

`app/App.tsx` wires it up: the custom UI is wrapped in a `GameUIErrorBoundary` whose
fallback is `DefaultGameUILayer`, inside a `<Suspense>` — so if the custom UI crashes or
is still loading, the default ECS UI takes over. Games currently using it: **llm-test**
(`LLMGameUI`) and **chess** (`ChessGameUI`).

### Store-hook injection (`addStoreHook` / `removeStoreHook`)

`DefaultGameUILayer` (`app/ui/DefaultGameUILayer.tsx`) feeds store state into
`UIRenderer`'s `storeState` for binding resolution. Because the Rules of Hooks forbid a
dynamic number of `useStore()` calls, games register their stores up-front via
`addStoreHook(hook)` / `removeStoreHook(hook)`; the layer remounts (via a `version` key)
when the hook set changes and calls each hook. This lets multiple games contribute store
fields to the shared UI bindings without prop-drilling. (Source: `games/CUSTOM_UI.md`,
verified against the game's `game.ts`/`runtime/setup.ts` and `app/App.tsx`.)

---

## Quick reference

| Concern | Where |
| --- | --- |
| Element trait (~73 fields) | `runtime/traits/UIElement.ts` |
| Bindings / actions / anchor | `runtime/traits/UIBinding.ts`, `UIAction.ts`, `UIAnchor.ts` |
| Renderer + DOM node | `runtime/ui/UIRenderer.tsx`, `UINode.tsx` |
| Tree build + dirty flag | `runtime/ui/uiTreeStore.ts` (`buildTree`, `markUIDirty`, `uiTreeProjection`) |
| Selector hook | `runtime/ui/useUIEntities.ts` |
| Action registry + engine built-ins | `runtime/core/actionRegistry.ts`, `runtime/actions/engineActions.ts` |
| Binding resolver | `runtime/ui/bindingResolver.ts` |
| Anchor math | `runtime/ui/anchorLayout.ts` |
| Focus nav (trait / system / manager) | `runtime/traits/UIFocusable.ts`, `runtime/ui/uiFocusSystem.ts`, `runtime/ui/focusManager.ts` |
| Text animation | `runtime/traits/TextAnimation.ts`, `runtime/ui/uiTextAnimation.ts`, `runtime/rendering/text/textAnimate.ts` |
| Nine-slice image + editor | `runtime/ui/NineSliceImage.tsx`, `editor/panels/NineSliceEditor.tsx` |
| Fonts (FontFace loader / MSDF convert / settings) | `runtime/loaders/fontLoader.ts`, `plugins/font-convert.ts`, `runtime/core/fontSettings.ts` |
| Custom game UI | game's `game.ts` (`UIComponent`), `app/App.tsx`, `app/ui/DefaultGameUILayer.tsx` |
