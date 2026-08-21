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
controller/keyboard focus nav — opt-in, resolved per active scope by `uiFocusSystem`),
`UIToggle` (renders the element as an on/off switch) and `Canvas2D` (marks a `UIElement`
as hosting a 2D PixiJS canvas; child `Renderable2D` entities render into it) — are
optional add-ons.

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
  `minWidth`/`maxWidth`/`minHeight`/`maxHeight`, `alignSelf`, `zIndex`, `rotation` (see below),
  `overflow`
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
  `vmin` is `min(vw,vh)`, so it equals `vh` only while the host is WIDER than tall and follows
  WIDTH the moment it is TALLER than wide, which is every phone in portrait. There a window that
  only gets shorter shrinks the parent and leaves `vmin` text alone — the bug intact, on the
  orientation a mobile game ships in. `vh` tracks height in both orientations, which is the whole
  reason to prefer it. And remember margin/padding percentages resolve
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
- **Text** — `text`, **`fontFamily`** (a font-asset GUID) + **`systemFont`** (a CSS family name; the asset wins — see § Fonts), `fontSize` + **`fontSizeUnit`**, `fontWeight`, `fontStyle`, `textColor`,
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

⚠️ **`--ui-*` and `getBoundingClientRect` are in DIFFERENT SPACES in the editor, and code that
mixes them is wrong by the preview's zoom factor.** The Game panel's device preset sizes
`UIRenderer`'s container at the device's *logical* size (375x667 for an iPhone SE) and then
displays it under a CSS `scale()` — so `--ui-vh` is `6.67px` while a rect measured off the same
subtree reports the scaled number. Consequences, both measured on 2026-08-20:

- A **ratio** of two measured values is safe: the scale cancels. That is why the game-side
  helpers that must survive this emit **percentages** (see `games/court/runtime/sceneChrome.ts`,
  whose patchers refuse px for exactly this reason).
- A **length** derived from a measured rect and then handed back as a style value is scaled
  twice. Court computed HUD font sizes that way and got `41.6px` where `22.8px` was intended —
  1.83x, the preview's own factor — which pushed the HUD through the board on nine of twelve
  device presets before it was caught.

So: convert positions to `%`, and express a length that must track the canvas design box as a
viewport unit rather than a computed px. Note that **no single viewport unit equals a
`contain`-fitted design box** — it is `min(100vw, refW/refH * 100vh)` wide, so `vh` is exact only
while the box is height-bound and `vw` only while it is width-bound. Court picks between them per
frame from the host aspect (`designUnit()`); the `vmin` + `vh`-cap pairing used on its buttons is
a hand-rolled approximation of the same thing.

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

### `UIToggle` — an on/off switch

Add it beside `UIElement` and the entity renders as a switch: a track with a knob at one
end or the other. Fields: `value`, `trackOnColor`/`trackOffColor`/`trackOpacity`,
`knobColor`/`knobOpacity`/`knobInset`, `trackRadius`/`knobRadius`, `disabled`.

**It does not write its own `value`.** A click fires the `change`-event bindings with
`eventValue` set to the NEGATION of the current value, and the canonical authoring is a
`set` binding onto its own `UIToggle.value` with `'$value'` (leave `target` empty to mean
"my own entity"). Pair it with a `call` binding when the game must also *do* something —
persist the preference, retune a service — and both fire from the one click.

⚠️ **The reason it does not self-write is not tidiness.** `applyBindings` early-returns
when the sim is not running, so a control that wrote its own trait field would mutate the
scene from a **Stopped editor**, which that early return exists to prevent. It also keeps
one writer for one value instead of two that can disagree.

The cost is that a toggle authored with no binding renders perfectly and is inert — the
silent-authoring-failure class this repo keeps paying for. So `UINode` **warns once per
entity in dev** when a `UIToggle` carries no `change`/`click` binding. It warns rather
than throws: an authoring mistake must not blank the screen mid-render.

⚠️ **A `UIToggle` OWNS its inner layout**, so `UIElement`'s flex and padding fields are
overridden on that entity and do nothing. Everything else on `UIElement` — size, border,
opacity, visibility, anchoring — still applies normally, because the rendered ROOT element
is the track and it carries the standard style object. That is also what gives a toggle
the focus ring and the pointer-events rules for free.

The knob is positioned by flex (`justifyContent` flips between the two ends) and sized off
the track's own height via `aspectRatio`, so a switch works at any authored size with no
measurement and no second render pass.

⚠️ **Keyboard support is the DOM's, not `UIFocusable`'s.** The track is focusable
(`tabIndex`) and Space/Enter flip it. Routing a toggle through the controller-nav focus
manager is a **follow-up**: that path activates by firing `click` bindings with no event
value, and a switch has to carry the new value with it. Deliberately not half-wired.

It is the first control in the engine to render more than one DOM node from one entity —
`input` and `range` both delegate to a native element — so it is the template for the next
one.

### `UIAnchor` — screen positioning + safe area

For root UI containers that should pin to a screen edge rather than flow in their
parent (`UIAnchor.ts`):

- `anchor` — one of `stretch`, `center`, the four edges (`top`/`bottom`/`left`/`right`),
  the four corners (`top-left` … `bottom-right`), and the stretch variants
  (`top-stretch`, `h-stretch`, `v-stretch`, etc.).
- `top`/`left`/`right`/`bottom` (+ units), `pivotX`/`pivotY` (0..1 pivot relative to the
  element's own box), `zIndex`.
- `safeArea` — clear the notch / home indicator. **Defaults to TRUE** — an absent field
  in a scene JSON is ON, not off. It takes ONE OF TWO ARMS, decided by the anchor, and
  they are mutually exclusive by construction so nothing can be inset twice:
  - **A STRETCHED anchor PADS**: `max(<padding>, var(--ui-sa-*, env(safe-area-inset-*)))`
    on the edges the anchor reaches. Its *children* move away from the edge; its own box
    does not move.
  - **A POINT anchor OFFSETS**: the anchor point moves inward, the box keeps its size,
    composed onto (not replacing) any authored offset — so `top: 4vmin` on a notched
    phone means "4vmin below the notch". Padding would be wrong here because it INFLATES
    the element: a 44pt gear anchored top-right would render 106pt tall with its glyph
    shoved to the bottom.
  - **`center` is a genuine no-op** — it reaches no edge. It is the only anchor for which
    the Inspector greys the checkbox out.

  ⚠️ **The anchor MODE is a proxy for "which edges this element reaches", and an authored
  or runtime-driven offset can falsify it.** An element anchored `top-stretch` but pushed
  to the bottom of the screen still takes a top inset — the inset is static CSS and cannot
  see where the element ended up. That is an authoring call, not an engine bug: opt such
  an element out.

An anchored element is rendered with `position: absolute`; pivot is applied as a CSS
`translate(-pivotX%, -pivotY%)`. Stretched axes ignore pivot (both edges are pinned).

⚠️ **The app root is FULL-BLEED and must stay that way** (`engine/app/App.css`). It
carried a blanket `padding: env(safe-area-inset-top/bottom)` from the initial commit,
which inset everything the app drew — black bands on a notched iPhone, no art able to
bleed to the edge, and an element that opted in inset twice. Per-element is the whole
mechanism; a second blunt one is strictly worse than either alone (#272).

#### The editor simulates the safe area (#271)

`env(safe-area-inset-*)` resolves to **0** on every desktop browser, so an editor preview
structurally could not show what a notched phone does — a class of layout bug that was
invisible until a build reached hardware, and the reason a previous safe-area fix shipped
unverified and had to be reverted (`c6e570f6` → `6f495a0d9`).

So the inset is emitted as `var(--ui-sa-<edge>, env(safe-area-inset-<edge>))`
(`runtime/ui/anchorCss.ts`), and the editor's device preview publishes `--ui-sa-*` from
the selected device preset. Three things about that shape are load-bearing:

- **A shipped build never sets the var** and falls through to the real `env()`. There is
  no `isEditor` branch in the runtime and only one expression, so the two cannot drift.
- **Both viewports publish the same insets.** GameView owns the device picker and writes
  them to `gameViewSafeArea` in the editor store; SceneView's UI preview frame reads them
  back. The same UI tree is mounted in both, so insetting one and not the other would put
  an element in two places and make the authoring view the liar.
- **The insets are per-orientation DATA, not a rotation.** `DevicePreset.safeArea` carries
  a portrait and a landscape quartet because they are genuinely different: an iPhone in
  portrait is inset at the top by the notch (62) and the bottom by the home indicator
  (34); rotated, it has **no top inset at all** (0 top, 21 bottom, 62 on both sides).
  Deriving one from the other by swapping w/h — which `resolveLogicalSize` legitimately
  does for the screen box — invents a top inset the device does not have.

The bands are drawn over the preview (`editor/rendering/SafeAreaOverlay.tsx`), always on
with a device preset: simulating an inset without showing it trades one invisible failure
for another.

#### Game code reads the insets through `getSafeAreaInsets()`

Chrome that only needs to CLEAR the notch should use `UIAnchor.safeArea` and never touch this.
It exists for a game whose own layout ARITHMETIC has to account for the inset — Court reserves a
band for a banner ad and derives the button row's position and the narration band's height from
it. It reports px **and percentages of the UI root**; use the percentages, because dividing the
px by your own `getBoundingClientRect` mixes a pre-transform inset with a post-transform box and
is wrong in editor previews only.

⚠️ **The read REFRESHES ITSELF on a throttle, and that is not defensive coding.** An inset can
change with no resize to announce it: under `setDecorFitsSystemWindows(false)` an Android window
keeps its size when the system bars hide, so only the insets move and no `ResizeObserver` fires
— and `env()` changing fires no event of its own, so there is nothing to subscribe to. A value
captured at mount stuck at a 48px nav-bar inset the device had already dropped to 0, which lifted
Court's ad band off the bottom edge *and* shortened its paper (one number, two bug reports).
A **detached** root is skipped rather than measured: a removed node answers empty computed styles
and `clientHeight` 0, so refreshing off one would silently zero every inset when a viewport
unmounts.

⚠️ **The preset numbers are mostly PUBLISHED, not measured**, and they model the
**physical** insets — the notch/Dynamic Island and the home indicator, i.e. what a
full-screen game sees with the status bar hidden. A device with no notch reports 0 there
(measured on the iPhone 8; that fact is what disproved the first attempt at the fix). See
the header of `editor/scene/devicePresets.ts` for what is verified, what is not, and the
Android caveat (real Android insets move with the OEM and with gesture vs 3-button nav).

### Rotation (`UIElement.rotation`)

`rotation` tilts an element by N **degrees clockwise**; 0 is square. It composes onto the anchor's
pivot translate (`translate(…) rotate(Ndeg)`), never replaces it — replacing it would MOVE the
element rather than turn it.

**It turns about the anchor PIVOT**, via a matching `transform-origin`. The pivot is by definition
the point of the element that sits on the anchor point, so it is the one point a tilt must leave
alone; rotating about the box centre would swing a `top-left`-anchored element off its own anchor as
the angle changed, which reads as a broken anchor rather than as a tilt. An element with **no**
anchor, or on a **stretched** axis (where the pivot is already ignored because both edges are
pinned), turns about its centre — there is no pivot to honour.

Why it exists (#234): **a nine-slice cannot bake its own tilt.** Slices are axis-aligned rects, so a
rotated master is cut along the wrong axes and the corners shear — and a dialog card has to be a
nine-slice, because one master serves both a wide panel and a tall one. So the choice was
tilt-in-the-engine or square, with nothing in between.

Two costs, both real:

- ⚠️ **A non-zero rotation creates a stacking context** (any CSS transform does), which traps the
  `zIndex` of everything inside it — the same trap `games/court/CLAUDE.md` records for
  `ChromeRoot`'s centre anchor. Tilt the CARD, not the layer that holds it. A zero angle emits
  nothing at all (no `rotate(0deg)`, no origin), so an element that predates the field is
  byte-identical and gains no stacking context.
- ⚠️ **The editor's selection overlay stays axis-aligned.** `resolveAnchorRect` measures an
  unrotated rect, so a tilted element's outline and gizmo box do not follow the tilt. Cosmetic —
  the render is correct — and deliberately out of scope.

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

## Scroll views and recycled entries (`UIScrollView` + `UIEntries`)

A scroll box with a **pooled** content set: a handful of prefab instances re-driven as you
scroll, so a view over N entries costs `visible + overscan` entities instead of N. Design
rationale and the open work: [plans/ui-scroll-view-plan.md](./plans/ui-scroll-view-plan.md).

**An entry is not a row.** The content is a `countX × countY` index space of **entries**, and one
entry is whatever the prefab says — a list row, a card, or a whole authored grid (a *page*). The
three shapes differ only in authored numbers, not in code paths: a vertical strip is `countX: 1`,
a horizontal one `countY: 1`, a pager is a strip whose entry fills the viewport (`100%`), and a
2-D grid has both above 1.

| Trait | Owns |
|---|---|
| `UIScrollView` | the box: `axis`, `snap`, `snapStop`, `overscroll`, plus engine-written `scrollX/Y`, viewport + content size |
| `UIEntries` | what it shows: `prefabs` (a JSON bank of `{name, prefab}`), entry size, `gap`, `overscan`, `countX/countY`, `epoch`, `source` |
| `UIEntry` | stamped by the engine on each pooled instance: the **data** index, the slot, and `live` |

`UIElement.overflow: 'scroll'` is still what makes the box scroll — `UIScrollView` supplies the
position and the motion fields, and does not override what the author wrote.

### The contract: the engine asks, the game answers

The engine decides WHICH pooled instance shows entry (x, y); the game answers WHAT it says, via
`registerEntrySource(name, resolver)`. Keys are **member paths** inside the entry prefab
(`'Tile3/Solved/Num'`, `''` for the root); values are **trait-keyed** (`{ UIElement: { text } }`).

- A path must be FULL and match exactly one member — **ambiguity is an error, not a fan-out**.
  `level-tile.prefab.json` carries three entities named `Num`, so a leaf-name match would write
  all three and look like it worked. This differs deliberately from Court's `patchUIInInstance`,
  which writes every match by design.
- Trait-keyed with no shorthand, because a flat field map would have to *guess* a trait — a
  resolver returning a `UIToggle.value` would then silently write nothing.
- Bump **`epoch`** when content changes but the window does not (a level gets solved; an async
  manifest arrives). Without it the resolver is only called when the window moves.

### Sizing, and why the two terms are separate

`poolSize = visible + 1 + 2 × overscan`:

- **`visible + 1`** is GEOMETRY — one entry always straddles the viewport edge at a partial
  offset. Required even at `overscan: 0`.
- **`overscan`** is LATENCY — how far the scroll travels between two pool updates. It is a
  FLOOR, raised at runtime to cover measured travel, because a fixed value blanks: on a Galaxy
  A23 a hard fling traverses up to **4.56 entries per pool update**, and `overscan: 1` blanked
  12/1787 frames.

The raise is **capped** at roughly a viewport's worth. A jump (a `scrollToEntry`, a scrollbar
drag) reports thousands of entries of travel, and an uncapped raise pools every one of them —
measured live, a 5,000-entry list went from a 9-entity pool to 5,000.

⚠️ **Travel is measured from the SCROLL, never from `first`, and that is the whole reason the
pool settles.** `first` is `floor(scroll / stride) − overscan`, so a travel taken from `first`
folds in the change in overscan — and overscan is computed *from* travel. That loop closes: on a
Galaxy A23 (2026-08-21) a 20 × 250 grid **left completely alone** flipped between a 9 × 8 and a
13 × 10 pool forever, re-driving on 102 of 154 frames and holding the device at ~30 fps with no
input at all. Scroll is exogenous; `first` is the response. The accumulator resets only when the
pool actually re-drives, so it stays "the distance the pool has to cover", dropped frames folded
in.

### Measured on the low-end target

Galaxy A23 (Mali-G57 MC2), the shipped web build of `demos/scroll-demo`, driven by real touch
(`adb input swipe`) with frame times and viewport coverage sampled per rAF:

| Scene | Fling p50 / p95 | Blank frames | Max travel | Entities at rest → peak | At rest |
|---|---|---|---|---|---|
| strip (1 × 5,000, 120px) | 16.7 / 33.4 ms | **0** of 688 | 40 entries | 34 → 52 | 57 fps, 0 pool updates |
| pager (40 × 1, viewport-sized) | 16.7 / 16.7 ms | **0** of 1,010 | 1 entry | 53 → 53 | 53 fps, 0 pool updates |
| grid (20 × 250, stride 128) | 16.7 / 66.6 ms | **0** of 409 | 14 entries | 229 → 407 | 61 fps, 0 pool updates |

Read it as three separate facts. **Recycling keeps up**: no fling on any shape ever exposed a
gap, at travel up to 40 entries between two pool updates. **Snapping bounds the pager to exactly
one page per fling** when the entry *is* the viewport — which is not a contradiction of the
`snapStop` note above (a 120px entry crossed 3), just the same rule at a different entry size.
And **the 2-D grid is genuinely heavy**: 229 DOM entities is ~7× the strip's, and a fling holds
p95 at 66 ms. That is the cost of a grid on a Mali-G57, not a defect — but it is the number to
weigh before making Court's page a scrolling grid rather than a pager.

`entryWidth`/`entryHeight` of **`0` means "read it from the prefab root"**, so a fixed-size entry
is not a second copy of a number the prefab already states; `%` resolves against the viewport,
which is how a pager is expressed.

### Motion is CSS, and the vocabulary matches

`snap` / `snapStop` / `overscroll` map to `scroll-snap-align`+`scroll-snap-type`,
`scroll-snap-stop` and `overscroll-behavior`. There is deliberately **no** `deceleration`,
`elasticity`, `duration` or `easing`: CSS cannot honour them, and an authored field that moves
nothing is a lie with a tooltip. They arrive together with an owned-physics backend.

⚠️ **`snapStop: 'always'` CONSTRAINS a fling; it does not cap it at one entry.** Measured on an
A23: one hard fling advanced **11** entries at `'normal'` and **3** at `'always'`, while a slow
drag advanced exactly 1. The cap is the POOL's extent — a browser can only stop at snap points
that EXIST in the DOM, and recycling is what removes the further ones. So do not size a pool to
buy a feel promise.

`scrollToEntry(viewGuid, {x, y}, {behavior})` and `snapToNearest` request in **entry**
coordinates (the system converts, since it is what resolves entry size); the declarative
`ui.scrollTo` action does the same from a button with no game code.

### Rules that bite

- **The system runs at `SYSTEM_PRIORITY.UI_ENTRIES` (270), ≥ `TRANSFORM`.** `runPipeline` skips
  everything below `TRANSFORM` while the sim is stopped, and a settings list or a level select is
  exactly what you scroll while paused — a sim-gated pool would stop RECYCLING while the native
  scroll kept moving.
- **The scroll read-back does NOT dirty the UI tree.** `UINode` writes `scrollX/Y` through a raw
  `entity.set`, bypassing the `markUIDirty` hook, so a scroll frame that does not move the window
  costs one field write. Routing it through a dirtying helper rebuilds the whole tree at fling
  frequency.
- **A parked entry reads as DESTROYED to Percept and Enact** — not listed, not aimable, subtree
  included. This is NOT the same as `isVisible: false`, which stays addressable.
- **Two engine-owned layers sit under the box**, both spawned inside a system tick so they are
  `Transient` and never reach a saved scene: a `__uiEntriesContent` column, and one
  `__uiEntriesRow` per pooled row. See "the DOM shape" below for why the row layer exists.
- **The entry prefab root needs `RenderableUI`**, or the entry renders nothing while looking
  perfect in `get_scene_state`.

### The DOM shape — a column of auto-width rows, and why a flat box cannot work

The scroll offset is carried as **padding**, and CSS padding eats the box it sits on. A single
content child at `width: 100%` with `padding-right: 23040px` has a content box of **zero**: every
entry in it shrinks to nothing and `flex-wrap` has no line to wrap into. Measured on
`demos/scroll-demo` (2026-08-21): pager pages came back **0px wide**, and grid tiles authored at
120px rendered at **36px stacked in one column**. The vertical strip survived only because
vertical padding does not touch the *horizontal* content box — which is precisely why one axis
shipped looking correct while both others were broken.

So the content child is a **column of auto-width rows**: an auto-width box sizes to
`padding + children` instead of being squeezed by its own padding.

| Element | Carries |
|---|---|
| the scroll box | `overflow`, `scroll-snap-type`, `overscroll-behavior` |
| `__uiEntriesContent` (column) | the **Y** offset as `padding-top`/`bottom`, and the **Y** gap as `gap` |
| `__uiEntriesRow` (row, auto width) | the **X** offset as `padding-left`/`right`, and the **X** gap as `gap` |
| the pooled entry | the resolved entry size in px, `flex-shrink: 0`, and `scroll-snap-align` |

Three things fall out of the split rather than needing their own rule: `UIElement`'s single `gap`
field serves both axes (a column's gap is the Y gap, a row's is the X gap); wrap disappears, so
the 2-D case never has to reconcile "break every `pooled` entries" with the width the scrollbar
needs; and `padLeading + rendered + padTrailing` lands exactly on `count × stride − gap`
(verified live: a 20 × 250 grid of 120px tiles at `gap: 8` measured `scrollWidth` 2552 and
`scrollHeight` 31992).

**The engine writes the resolved entry size onto the pooled root**, in px. That is not a shadow
of the authored value — it *is* the authored value resolved (`%` against the live viewport, `0`
read back from the prefab root), and a definite box is what a `%`-sized prefab root needs once
its parent is an auto-width row.

⚠️ **A viewport RESIZE moves no window origin.** `first` stays put while every padding value
changes, so entry size and pooled-column count are part of the system's invalidation test, not
just the window origin. Without that the pager kept a 640px page inside a 395px panel — for good.

**Snapping is declared on the box and honoured on the TARGET**, and those are different
elements. The tree build stamps `scroll-snap-align`/`scroll-snap-stop` onto the pooled entries
(or, for a scroll view with no entries, onto its direct children). Stamping the *entry* rather
than the row serves both axes at once. `scrollSnapChildStyle` shipped with a unit test and no
caller, so `snap` styled the container and nothing ever snapped — found by measuring the pager's
DOM, and the reason this paragraph exists.

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
(`UIElement.fontFamily`) and the PixiJS 2D layer, since both use the browser's font system. `loadAllFonts()` bulk-loads every `type:'font'`
asset from the scan; concurrent loads of the same path share one in-flight
`FontFace.load()`, and a failed load is evicted so it can retry. Family/weight/style come
from the filename (`parseFontFilename`); a (weight, style) collision within a family warns
(last-added wins).
`getLoadedFontFamilies()` / `getLoadedFonts()` expose the registry to game code; nothing in the
engine or editor consumes them today (verified 2026-08-20).

#### Two fields, one answer: `fontFamily` + `systemFont` (#231)

**`UIElement.fontFamily` is a font-ASSET GUID**, resolved through the manifest like every
other asset reference; **`UIElement.systemFont`** is a plain CSS family name, for the case a
GUID cannot express (`system-ui`, `Helvetica`, a stack). **Precedence is one-way: the asset
wins when set, else `systemFont`, else the browser default** — pinned in `resolveUIFontFamily`
(`runtime/ui/fontFamilyRef.ts`), which is the only place that decides, so "both are set" is
never a question answered by experiment.

Resolution happens in the **UI tree projection**, not in `UINode`: `uiTreeStore` writes the
RESOLVED CSS value into the node's `fontFamily`, and the DOM layer stays a pure style writer.
`ui/` is an L2 subsystem and cannot import the L3 manifest, so it reaches it through the
`core/domFontProvider` seam (installed by `loaders/registerProviders.ts`), the same shape
`textureProvider` uses.

**Why it changed.** `fontFamily` held the CSS family name, which made it the one
`accept:`-typed field in the engine that did not store a ref — so the build's tree-shaker had
to resolve it by matching family names against FILENAMES, the validator and `diagnose` could
not check it at all, and a font named from anywhere the static scan cannot read was simply
dropped from the shipped bundle. It also forced a second, field-aware path predicate
(`isInternalFontPath`, QA-INSP-0004), since a literal font path was legitimate in that one
field and invalid everywhere else; that predicate is retired and font extensions are now
part of `isInternalAssetPath` like every other asset kind.

**Migration.** A legacy family name still RENDERS — `resolveUIFontFamily` passes it through
with a one-time warning — so a pre-#231 scene is not broken, merely invisible to the build.
`engine/scripts/migrate-font-family-refs.mjs` rewrites authored values to GUIDs (dry-run by
default, `--write` to apply); a family matching no font asset is reported rather than guessed
at, since it is probably a system typeface that belongs in `systemFont`. In-repo, the only
authored value was Court's `Intro` root, migrated with the script.

**Authoring.** Drag a font from the Assets panel onto the field (the drop writes the GUID and
registers the FontFace so the Game panel updates immediately), or use the field's **`Aa`**
picker, which lists every font asset previewed in its own typeface. Typing is no longer an
option for this field — `isAcceptableTypedRef` rejects a bare family name in every font field,
because a GUID cannot be typed and a name would resolve to nothing.

#### Who registers a scene's fonts — and the bug that answer used to have (#253)

**A scene's own fonts are registered by the SCENE-LOAD path**, not by whoever happens to
have called `loadAllFonts`. `collectResourceRefsFromEntities` emits each authored
`UIElement.fontFamily` as a **`{type:'font-family', path:'<font GUID>'}`** scene resource, and
`SceneManager`'s `acquireResource` hands it to **`loadFontFamilyForRef`** → `loadFontFamily(family)`
— which finds
every manifest `font` asset whose `parseFontFilename(path).family` matches and FontFace-loads
them all (all variants: a UI authoring `fontWeight: 700` needs the real Bold file, or the
browser synthesizes a fake bold). It is awaited with the scene's other resources, so the
first frame has the face. The walk covers referenced PREFABS too — the same collector runs
over each prefab's entities.

⚠️ **`font-family` and `font` are two resource types over the same kind of asset, and that is
deliberate.** A `font` resource is an SDF atlas acquire (`Text2D.font`/`Text3D.font`, scene-scoped
+ refcounted); a `font-family` resource is a FontFace registration for the DOM. **One asset can be
both** — Court names one typeface from a canvas label and from DOM text — so collapsing them into
one type would drop whichever consumer the surviving branch does not serve.

⚠️ **Matching is `parseFontFilename(path).family`, deliberately the same rule the build's
`resolveFontsByFamily` (`asset-tree-shaker.ts`) uses** to decide whether a font's source
`.ttf` is worth shipping. The two must agree: a family the runtime resolves but the build
does not is a font that works in the editor and is absent from the shipped game.

That acquire used to be a **no-op**, on the reasoning that `loadAllFonts` had already
registered everything globally. It has exactly two callers — the game runtime's
`initWorldSync` (`engine/app/ecs/init.ts`) and **the editor's Assets PANEL**. The editor
route mounts `EditorApp`, not `GameShell`, so `initWorldSync` never runs there and the only
registrar left was a panel: with the Assets tab unmounted, `document.fonts.size` was **0**
and every DOM string in the Game panel rendered in the browser's default **serif**.

**Why that was worth more than a cosmetic bug: it silently corrupts MEASUREMENT.** Nothing
errors, and a serif page still looks like a page — so a capture judged against reference art
can be wrong about weight, tracking, wrap, line count and therefore panel fit, with nothing
to indicate it. It was found while re-capturing Court's menu for an art evaluation. Measured
A/B on the live editor with the panel's registration disabled (2026-08-20, `games/court`):

| | `document.fonts.size` | `measureText('COURT')` @ `700 73px` |
|---|---|---|
| before | 0 | `Varela Round` 261.096 = `NoSuchFontXyz123` 261.096 = `serif` 261.096 |
| after | 1 (`Varela Round`) | `Varela Round` **260.318** ≠ `serif` 261.096 |

**The cheap guard that came with it**: a family matching no manifest font asset warns once
(naming the filename→family rule, since that is usually the mistake), and a family whose
source the build dropped (`sourceShipped:false`) gets a *different* message — those need
different fixes, and the second reads as the first otherwise. Generic CSS keywords
(`sans-serif`, `system-ui`, …) name no asset by design and are silent. Before this, the
failure produced no console output at all.

#### Re-importing a font: how the DOM face is replaced (#276)

`fontLoader` subscribes to the **same `onFontInvalidated` signal the SDF loader uses** (fired by
`registerAsset` when a `'font'` entry re-registers with a changed `hash` or `font.mode`), resolves
the guid to a path, and re-registers the face. Until this landed the DOM half had **no
invalidation at all**: `loadFont` short-circuited on `loadedPaths`, so a re-imported font re-baked
the SDF atlas and visibly changed `Text2D`/`Text3D` **while DOM text kept the old typeface until
the editor was restarted** — no error, and the two text systems silently disagreeing on screen
about what one font looks like. Measured on the live editor before/after, one re-import swapping a
font's bytes at the same path (Varela Round → Arimo, `games/anim-bug`, 2026-08-20):

| | SDF `Text3D` world width | DOM span width @100px |
|---|---|---|
| before the fix | 8.412 → **7.848** ✅ re-baked | 837.91 → **837.91** ❌ stale |
| after | 8.412 → **7.848** ✅ | 837.91 → **778.38** ✅ |

The four parts are a **package** — any one alone still leaves the old face rendering:

1. **The registry is evicted.** `invalidateFontFace(path)` drops the path from `loadedPaths`, and
   `forgetVariant` drops its `FontInfo` from `loadedFonts` so the reload registers exactly one
   variant instead of appending a duplicate (which would also trip the same-(weight,style)
   collision log against the font's own previous self).
2. **The URL is cache-busted** — `withCacheBust(assetUrl(path), getAssetEntry(path)?.hash)`,
   matching `fontUrls()` in the SDF sibling. Without it the refetch is served the cached bytes and
   the reload is a no-op. Like its sibling this is a **no-op in dev** (the Vite dev server does not
   cache), so it is the production half of the fix; the editor half is (1) and (3).
3. **The old `FontFace` is deleted from `document.fonts`** — the browser owns a face until
   something removes it, so re-adding alone leaves the stale one registered. A `faces` map keys the
   live face per path, and the delete happens in `doLoadFont` **immediately after the replacement is
   added** — the only place a face is ever added, so the ordering cannot drift. That ordering is the
   answer to "when is it safe to delete a face live text is rendering with": after its replacement
   is registered, never before, so nothing falls back to a system font for a frame.
4. **In-flight loads are fenced.** A `generation` counter (mirroring the SDF loader's) is bumped by
   every invalidation; a load captures it before `await face.load()` and refuses to register if it
   changed. Otherwise a load of the OLD bytes still in flight when the re-import lands resolves
   afterwards and re-registers the stale face on top of the fresh one — last-added wins.

A **failed** reload deliberately leaves the previous face registered (and warns) rather than
dropping the family to a system fallback, which follows from the ordering in (3): the delete never
runs if the replacement never arrives. ⚠️ **That branch is where the naive version of this fix
re-created the very bug it was closing**, and it is worth knowing before touching the guard: a
failed reload clears both `loadedPaths` and `loading`, which reads *identically to "never loaded"*
— so an early-out keyed on those silently drops **every later re-import**, and the stale face
(never deleted, because the delete only follows a successful add) renders until an editor restart.
The early-out is therefore keyed on **`faces`**, which survives a failed reload precisely because
the old face is still registered. For the same reason `forgetVariant` runs in `doLoadFont` at
registration time rather than in the invalidation: the registry then keeps describing what is
actually in `document.fonts`, instead of reporting a family as gone while its old face is visibly
still rendering. A path this module never loaded IS a genuine no-op — eagerly loading on
invalidation would FontFace-load fonts no scene asked for. `disposeAllFontFaces()`
mirrors `disposeAllFonts()` for full teardown and removes the faces from `document.fonts` too: a
face the browser still holds after its registry is cleared can never be removed afterwards.

⚠️ This is the dev-editor half of a class the production build has too: **the tree-shaker
cannot see a family NAME reached from anywhere but a scene/prefab field** (a stylesheet, a
code constant), so the font is dropped and every string falls back — see
[Build](./build.md) § "Converted assets: the manifest points at the SOURCE, the build ships the
VARIANT". **The scene/prefab half of that is closed** — `fontFamily` is a GUID as of #231, so a
UI font ref is followed by the same walk as every other ref (and its family's other variants come
with it). What remains is a family named from a place no static scan can read — a stylesheet or a
runtime code string — which is what `shipSource: 'always'` exists for.

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
