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
  (`visible | hidden | scroll`), `scrollbarStyle` (`auto | tinted | hidden`) with
  `scrollbarThumbColor`/`scrollbarTrackColor`, `isVisible`, `pointerThrough` (see below).

  **The scrollbar skin is `scrollbar-color` + `scrollbar-width` and nothing else**, because these
  are INLINE styles and `::-webkit-scrollbar` is a pseudo-element that cannot be written inline at
  all (`scrollViewDom.ts` records the same limit where it hides a scroll view's bar). So you get a
  thumb colour, a track colour and a coarse width — no shape, corner or arrow control. The skin is
  gated on `overflow: 'scroll'`, so a tint authored on an element that never scrolls does nothing
  rather than sitting in the Inspector pretending to.
  ⚠️ **`UIScrollView.scrollbar` says the same thing and WINS** — both emit `scrollbar-width: none`
  for their hidden case and the scroll view's style is merged after, so on an element carrying a
  `UIScrollView` that trait decides whether a bar exists and `scrollbarStyle` only tints it.
  ⚠️ `'hidden'` removes an **affordance**, not just a decoration: with no bar, nothing on screen
  says the content continues below the fold. Use it only where something else already does.

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

### Scale (`UIElement.scale`)

`scale` is a **uniform** scale about the anchor pivot; 1 is natural size. It rides the same composer
as `rotation` (`applyRotationStyle` in `ui/anchorCss.ts`) and inherits every rule above: it composes
onto the anchor's pivot translate rather than replacing it, it takes the same pivot-derived
`transform-origin` so the anchored point does not move as the element grows, and it creates the same
stacking context. Uniform scale and rotation commute about a shared origin, so the order the two are
appended in does not matter.

**It scales the RENDER, not the layout.** The element's box keeps its laid-out size, so siblings do
not reflow and nothing shifts underneath a growing card. That is the reason the field exists at all
rather than keying `width`/`height`: those *do* reflow, and they leave text at its original size, so
a "pop" authored that way reads as a box stretching around stationary words.

Why it exists (#340): Court's level-win dialog snapped on screen with no transition, and the fix had
to be an **authored keyframe clip** rather than a tween in code (owner's standing rule — timing and
easing are data the owner retunes in the editor, not numbers an agent picks in a `.ts`).
`UIElement.opacity` was already keyable, but a fade alone reads as soft; a dialog wants to arrive.
No keyable property in the UI layer could express that. The worked example is
`games/court/runtime/assets/anim/dialog-pop.anim.json` — a scale track 0.8 → 1.06 → 1.0 against an
opacity track, played by an `Animator` authored on the card.

⚠️ **Identity is 1, and it is checked against 1, not against falsy.** `scale: 0` is a legitimate
authored value (a pop-in's first keyframe) and must emit `scale(0)`; a `|| 1` anywhere on this path
would silently promote it and the animation would start already open. The projection in
`uiTreeStore.ts` uses `?? 1` for exactly this reason. An element left at 1 emits no transform at
all, so everything that predates the field is byte-identical and gains no stacking context.

⚠️ Like `rotation`, the editor's selection overlay stays at the **unscaled** rect — `resolveAnchorRect`
measures layout, and this deliberately does not change layout.

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
scroll, so a view over N entries costs `visible + overscan` entities instead of N. Landed as
#250 + #316 (Court's level selector); the design tracker is deleted per `doc-conventions.md` and
its durable rationale folded in below.

**An entry is not a row.** The content is a `countX × countY` index space of **entries**, and one
entry is whatever the prefab says — a list row, a card, or a whole authored grid (a *page*). The
three shapes differ only in authored numbers, not in code paths: a vertical strip is `countX: 1`,
a horizontal one `countY: 1`, a pager is a strip whose entry fills the viewport (`100%`), and a
2-D grid has both above 1.

**The first draft modelled this as a vertical list of rows instead** — `rowPrefab`, `rowHeight`,
`firstIndex` — which is one of the three shapes dressed as the general one, and the mistake is
worth keeping rather than erasing. It would have made Court the EXPENSIVE case instead of the
cheap one: virtualizing 589 tiles needs per-tile recycling and a per-tile identity story, where
Court-as-One-case pools ~3 whole *page* entries it already authors. And the naming would have
leaked into the scene format, where it is costly to correct — `rowPrefab` on a horizontally-
scrolling shop strip is a lie an author reads past forever.

| Trait | Owns |
|---|---|
| `UIScrollView` | the box: `axis`, `snap`, `snapStop`, `overscroll`, plus engine-written `scrollX/Y` and viewport size — and content size, which the engine writes and only a reader consumes (see "Rules that bite") |
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
- The member-path walker is **new engine code over the `parentId`/`localId` chain**, not a
  promotion of Court's `findAllInInstance`. `rootInstanceId` is stamped on a prefab's OWN
  members only — never inner members — so `findAllInInstance`'s flat `rootInstanceId ===
  rootEcsId` scan reaches zero of a page prefab's 25 nested tile instances.
- The scene's generated `resources` manifest only seeds what it is told is a ref:
  `UIEntries.prefabs[].prefab` must be registered in `REF_FIELDS_BY_TRAIT`
  (`loaders/sceneValidation.ts`) and in `SCALAR_RESOURCE_TYPE_BY_FIELD` as a `prefab`-typed ref,
  or the entry prefab is invisible to the manifest — the #53 "assets the build cannot see"
  class, silent in dev (which serves everything off disk) and broken only once shipped. Once
  registered, the entry prefab's own assets need nothing further: `SceneManager`'s transitive
  worklist walks its entities with the same collector used for scene entities, so a textured
  entry prefab, a font, or a prefab nested inside it are all acquired and scene-refcounted.

### Sizing, and why the two terms are separate

`poolSize = visible + 1 + 2 × overscan`:

- **`visible + 1`** is GEOMETRY — one entry always straddles the viewport edge at a partial
  offset. Required even at `overscan: 0`.
- **`overscan`** is LATENCY — how far the scroll travels between two pool updates. It is a
  FLOOR, raised at runtime to cover measured travel, because a fixed value blanks: on a Galaxy
  A23 a hard fling traverses up to **4.56 entries per pool update**, and `overscan: 1` blanked
  12/1787 frames.

The raise is **capped at three viewports' worth**. A jump (a `scrollToEntry`, a scrollbar drag)
reports thousands of entries of travel, and an uncapped raise pools every one of them — measured
live, a 5,000-entry list went from a 9-entity pool to 5,000.

⚠️ **The third viewport is not slack — it absorbs a dropped frame.** The window reaches the DOM
through event → ECS → projection → React commit, and that chain misses a frame about one time in
six: measured in the editor 2026-08-21, **7 of 40 frames** of a steady 8-entries-per-frame scroll
left the padding exactly where it was, and those frames were 13 ms like every other — not a
budget problem, a scroll event landing after the pipeline had already run. A one-viewport cap
cannot absorb that miss and the viewport goes **black**, which is how this was reported (a
trackpad flick on the strip). Three viewports was measured, not picked: five costs 45 rows where
three costs 29, buys five more entries per frame, and still blanks on a 30-per-frame flick.

**A `scroll` event also drives the pool immediately** (`driveEntriesFromScroll`), before the frame
paints, instead of waiting for the next pipeline tick. It opens a system tick deliberately — the
pool spawns, and `spawnEntity` tags `Transient` only inside one, without which a pooled entity
reaches the saved scene file. That is the specific reason pool growth is NOT driven from the DOM
`scroll` handler or a React effect directly: `spawnEntity` tags `Transient` only when
`inSystemTick()`, and `spawnPrefabInstance` tags it only when the run mode is not `stopped` — a
handler or effect spawning outside a tick would evade both checks silently, and CLAUDE.md's #18
incident (a stray runtime entity persisted into `tropical-island.json` via a plain save) is
exactly what an untagged pooled entity would repeat.

⚠️ **Travel is measured against the last PIPELINE tick, on both paths.** Two drives now land per
frame, and an accumulator reset by whichever ran first leaves the other reading zero travel and
shrinking the band that was just grown — the pipeline always runs second, so its smaller window
is the one that paints. Measured: the band pinned at 17 rows for every speed from 8 to 30 entries
per frame, and the view went black anyway.

Where that leaves the strip (5,000 entries, 120px rows, 440px viewport):

| scroll speed | before | after |
|---|---|---|
| 5 / frame | clean | clean |
| 8 / frame | 4 black frames in 20 | **clean, zero gap** |
| 12 / frame | black | **clean, zero gap** |
| 15 / frame | black | clean (200px partial) |
| 20 / frame | black | still blacks — the honest ceiling |

The band grows to 29 rows while scrolling that fast and returns to 9 at rest.

⚠️ **Travel is measured from the SCROLL, never from `first`, and that is the whole reason the
pool settles.** `first` is `floor(scroll / stride) − overscan`, so a travel taken from `first`
folds in the change in overscan — and overscan is computed *from* travel. That loop closes: on a
Galaxy A23 (2026-08-21) a 20 × 250 grid **left completely alone** flipped between a 9 × 8 and a
13 × 10 pool forever, re-driving on 102 of 154 frames and holding the device at ~30 fps with no
input at all. Scroll is exogenous; `first` is the response. The accumulator resets only when the
pool actually re-drives, so it stays "the distance the pool has to cover", dropped frames folded
in.

### Measured on the low-end target

Galaxy A23 (Mali-G57 MC2), the shipped web build of `games/scroll-demo`, driven by real touch
(`adb input swipe`) with frame times and viewport coverage sampled per rAF:

| Scene | Fling p50 / p95 | Blank frames | Max travel | Entities at rest → peak | At rest |
|---|---|---|---|---|---|
| strip (1 × 5,000, 120px) | 16.7 / 33.4 ms | **0** of 688 | 40 entries | 34 → 52 | 57 fps, 0 pool updates |
| pager (40 × 1, viewport-sized) | 16.7 / 16.7 ms | **0** of 1,010 | 1 entry | 53 → 53 | 53 fps, 0 pool updates |
| grid (20 × 250, stride 128) | 16.7 / 66.6 ms | **0** of 409 | 14 entries | 229 → 407 |

⚠️ The **peak** column predates the three-viewport cap and will now read higher on a fast fling;
the at-rest figures and the frame times are unaffected (touch travel never exceeded ~2 entries
per frame on that device, so the raise rarely fires there at all). 61 fps, 0 pool updates |

Read it as three separate facts. **Recycling keeps up**: no fling on any shape ever exposed a
gap, at travel up to 40 entries between two pool updates. **Snapping bounds the pager to exactly
one page per fling** when the entry *is* the viewport — which is not a contradiction of the
`snapStop` note above (a 120px entry crossed 3), just the same rule at a different entry size.
And **the 2-D grid is genuinely heavy**: 229 DOM entities is ~7× the strip's, and a fling holds
p95 at 66 ms. That is the cost of a grid on a Mali-G57, not a defect — but it is the number to
weigh before making Court's page a scrolling grid rather than a pager.

### Focus follows the ENTRY across recycling — measured

`games/scroll-demo`'s `row.prefab.json` authors `UIFocusable` for one reason: nothing else in the
repo does. Court's selector is pointer-driven and uses no focus nav, so the engine's
focus-on-recycle re-target (`runtime/ui/entriesFocus.ts`) had zero live callers before this — the
same "an API nothing calls" shape as `scrollTo`'s buttons, one layer up.

`uiFocusSystem` autofocuses the first row on Play, and as you scroll the focus ring stays on the
same **Entry N** while hopping between pooled entities. Measured in the editor 2026-08-22 — a
wheel up from `scrollTop` 363 to 123 moved the ring from entity **22 to 24** with its label still
reading `Entry 1`, while entity 22 went on to show `Entry 0`. That second half is the bug being
prevented: without the re-target the ring would have sat on entity 22 and the player would have
been on `Entry 0` believing they were on `Entry 1`.

### Status (#250, #316, #321)

Built as the live verification harness for #250 and kept as `games/scroll-demo`. All three of the
plan's cases are authored and were measured in a running editor (2026-08-21) — and authoring the
two new ones is what found three engine defects the vertical strip could not expose: the
collapsing content box, a resize that never re-laid-out, and `scroll-snap-align` that no code ever
applied. All three were then flung on a Galaxy A23 with real touch input — no blank frames on any
shape, and a defect that only a device could show: the overscan raise fed itself, so a grid nobody
was touching re-drove its pool on 102 of 154 frames (see "Measured on the low-end target" above).
`wheel` and `scrollbar` were authored on the pager on 2026-08-22 (#321) and measured in the editor
the same day: a trusted 480px wheel advances the pager **exactly one page** (410px) and three
gestures in a row land +1, +1, +1 with a reverse flick at -1, while the identical wheel on the
strip travels 363px freely — the half that proves the `'native'` default survived. And the two
boxes read `clientWidth == offsetWidth` (pager, `scrollbar: 'hidden'`) against **447 vs 462**
(strip, the `'auto'` default): the 15px a classic desktop scrollbar steals, measured on the same
machine in the same session rather than quoted.

The Court migration landed on 2026-08-21 (#316) — Court's level selector is a pager over this same
mechanism, with a 5x5 page as the entry, and wiring its arrows to `scrollToEntry` immediately
found two engine defects this harness had not.

`entryWidth`/`entryHeight` of **`0` means "read it from the prefab root"**, so a fixed-size entry
is not a second copy of a number the prefab already states; `%` resolves against the viewport,
which is how a pager is expressed.

### Motion is CSS, and the vocabulary matches

`snap` / `snapStop` / `overscroll` map to `scroll-snap-align`+`scroll-snap-type`,
`scroll-snap-stop` and `overscroll-behavior`. There is deliberately **no** `deceleration`,
`elasticity`, `duration` or `easing`: CSS cannot honour them, and an authored field that moves
nothing is a lie with a tooltip.

⚠️ **The owned-physics backend is DECLINED, not pending** (owner, 2026-08-21). Shipping CSS
first was what made the question answerable by feel instead of by argument: the owner scrolled
the real Android build on a Galaxy S22 and judged it good. Reopen only for a concrete motion CSS
cannot express — and name it. Recorded in [todo.md](./todo.md) § Declined so it is not
re-litigated.

⚠️ **`snapStop: 'always'` CONSTRAINS a fling; it does not cap it at one entry.** Measured on an
A23: one hard fling advanced **11** entries at `'normal'` and **3** at `'always'`, while a slow
drag advanced exactly 1. The cap is the POOL's extent — a browser can only stop at snap points
that EXIST in the DOM, and recycling is what removes the further ones. So do not size a pool to
buy a feel promise.

`scrollToEntry(viewGuid, {x, y}, {behavior})` and `snapToNearest` request in **entry**
coordinates (the system converts, since it is what resolves entry size); the declarative
`ui.scrollTo` action does the same from a button with no game code. Both are exercised by
`games/scroll-demo`'s strip scene — two authored buttons, one `instant` and one `smooth` — and,
since #316, by Court's level-selector arrows, which is the first caller in a SHIPPING game.

⚠️ **The per-request `behavior` and the authored default are TWO fields, and must stay two**
(#409). `UIScrollView.scrollBehavior` is authored; the request rides the `runtimeOnly`
`scrollToBehavior` and is consumed with the rest of the request by `clearScrollRequest`.
`scrollToEntry` used to store the request ON the authored field, so a call that named no
`behavior` — which defaulted to `'instant'` — permanently destroyed an author's `'smooth'`, and
the next save wrote the overwrite into the scene as authored data. Marking the field `runtimeOnly`
could not fix that; it would have deleted the author's choice instead. Consequence at the call
site: **omitting `behavior` is not the same as passing `'instant'`** — the request then moves the
way the view was authored to move.

⚠️ **OMIT the axis the view does not scroll — `0` is a REAL request, not "no request".** The
sentinel is `-1`. Court asked for `{x: page, y: 0}` on an `axis: 'x'` view; that converted to
`scrollToY: 0`, and because `clearScrollRequest` used to clear only the VIEW's axis it could never
be cleared. `pendingScrollTo` then returned a request on every rebuild, each firing
`scrollTo({top: 0})` with no `left` — which per spec keeps the CURRENT left, so it cancelled the
in-flight smooth scroll about 20 ms in and re-targeted it to roughly where it started. **The
arrows moved nothing, the trait read a clean `scrollToX: -1`, and every unit test was green.** The
clear now clears BOTH axes so the mistake is recoverable, but the call site should still be right.

⚠️ **A converted request must DIRTY the tree.** The px request lands on `UIScrollView` through
the same raw no-dirty `entity.set` the scroll read-back uses, so when the window has not also
moved, nothing rebuilds the UI tree and `UINode`'s one-shot `scrollTo` effect never re-runs —
the request then sits on the trait forever. The API shipped that way and it took wiring the
first real caller to see it: the trait read `scrollToY: 480000` while `scrollY` stayed 0.
Verified live afterwards (2026-08-21): `instant` lands 480,000px in one frame, and `smooth`
eases over 86 frames with 85 distinct intermediate positions.

⚠️ **Clearing the request dirties too, and that asymmetry is deliberate.** The effect is keyed on
the request VALUES, so a second request for the SAME offset only re-fires if the tree observed
the `-1` in between — otherwise the stale value compares equal and the request is swallowed.
The declarative `ui.scrollTo` path HIDES this, because `bindings.ts` dirties after applying any
binding, so the tree happens to see the cleared value first. A game calling `scrollToEntry()`
directly has no binding and no such rescue, so the same call would work from a button and not
from code. Everything else in `scrollViewDom.ts` stays dirty-free; a consumed request costs one
rebuild and is never per-frame.

### Rules that bite

- **The system runs at `SYSTEM_PRIORITY.UI_ENTRIES` (270), ≥ `TRANSFORM`.** `runPipeline` skips
  everything below `TRANSFORM` while the sim is stopped, and a settings list or a level select is
  exactly what you scroll while paused — a sim-gated pool would stop RECYCLING while the native
  scroll kept moving.
- **The scroll read-back does NOT dirty the UI tree.** `UINode` writes `scrollX/Y` through a raw
  `entity.set`, bypassing the `markUIDirty` hook, so a scroll frame that does not move the window
  costs one field write. Routing it through a dirtying helper rebuilds the whole tree at fling
  frequency.
- **The editor mounts `UIRenderer` TWICE, and the measurement is keyed by GUID (#413).** One in
  the Game panel, one in SceneView's UI preview — two real React trees over one ECS world, so a
  scroll view has two DOM elements, two `ResizeObserver`s, and ONE `UIScrollView` slot to write.
  The element inside a hidden dock tab measures 0x0, and with `entryWidth` authored in `%` a zero
  viewport makes every entry zero-wide, the window empty and the pool zero-slot — a blank view
  with **every diagnostic silent**, because the prefab is cached and the source is registered.
  Court's calendar and level selector both sat blank on this. `push()` therefore refuses to record
  a measurement from an element that generates no box (`readScrollMeasurement`): a zero-extent view
  can display no entries either way, so declining costs nothing, while accepting it destroys the
  only good measurement. ⚠️ The device-size gap this used to warn about can't actually happen —
  SceneView sizes its preview from GameView's own size, so both mounts share one logical device
  size by construction; the residual hazard is a MIXED measurement instead — a real viewport from
  one mount paired with `scrollX: 0` from the other while the two trees disagree on scroll offset,
  which can still land the pool's window outside the visible band and blank the view.
- **`contentWidth`/`contentHeight` are DIAGNOSTICS the engine writes and does not read (#414).** They
  carry the box's `scrollWidth`/`scrollHeight` — its full content extent — and every consumer in the
  repo is a human or an agent reading the trait through Percept: `contentWidth === viewportWidth`
  while `countX: 5` is the observation that first said "this view is sized for one page" in #413. No
  engine code derives anything from them. `entriesSystem` and `scrollApi` use only the **viewport**
  pair, and a pooled view's own extent is the PADDING `writeLayout` computes from the entry stride,
  which is a separately-computed quantity. This is deliberate, not an oversight: they are also the
  intended source for the extent-derived features a pooled view cannot supply — a scrollbar thumb
  (`viewport / content`), edge fades, a "can this scroll?" affordance, scroll-to-end, near-the-end
  prefetch, and the upper clamp `scrollByEntry` still lacks — it clamps at `0` only, so a wheel past
  the last entry arms a request off the end, `consumeEntryRequest` hands that target back, and
  **this frame's pooled window is planned for a place the view never reaches** before the DOM clamps
  the offset. The view lands right; the pool spent a frame elsewhere, and nothing in the engine can
  answer "already at the end" for a caller wanting to grey the arrow out (Court's `level-page`
  handler clamps for itself with `clampPage`). All of those are `content − viewport`, and on a
  `UIScrollView` carrying **no** `UIEntries` there is no other source for it.
  ⚠️ **Scope the measurement to one owning tree before building behaviour on them** — they come from
  whichever of the two editor mounts fired, which is exactly the mixed-measurement hazard above.
- **A parked entry reads as DESTROYED to Percept and Enact** — not listed, not aimable, subtree
  included. This is NOT the same as `isVisible: false`, which stays addressable.
- **Every pooled instance shares the prefab's authored `sortOrder`**, so ties fall to koota
  archetype order fixed at pool-creation time — nothing to do with an entry's data position after
  the first recycle. Entries can render in the wrong visual order while every trait value reads
  correctly, the worst shape of "data-correct ≠ pixels-correct" — fixed by writing `sortOrder` to
  the data index on every recycle.
- **`UIElement`'s padding units default to `'%'`, and CSS percentage padding resolves against the
  containing block's WIDTH on both axes** — so a `%` vertical padding is silently wrong. The
  offset write therefore pins the UNIT alongside every padding value it writes; the value on its
  own would be read as a percentage of the WIDTH, on the vertical axis too.
- **Two engine-owned layers sit under the box**, both spawned inside a system tick so they are
  `Transient` and never reach a saved scene: a `__uiEntriesContent` column, and one
  `__uiEntriesRow` per pooled row. See "the DOM shape" below for why the row layer exists.
- **The entry prefab root needs `RenderableUI`**, or the entry renders nothing while looking
  perfect in `get_scene_state`.
- ⚠️ **A prefab the loader never caches leaves the view BLANK, and since #363 it says so.** "Not
  cached yet" is normal for the first frames of a scene load, so `spawnInstance` returns `0` and
  the system retries — but a *permanent* miss is indistinguishable from a transient one at that
  return value, and used to be retried silently forever with no throw, warn or log. The provider
  is now asked `isCached` directly (a zero `rootSize` cannot answer it — an unsized prefab root is
  a legitimate `0`), and `UNCACHED_WARN_TICKS` consecutive pipeline ticks of "no" warns once per
  view, naming the prefab and the causes that were verified against the loader: a GUID that is not
  the one the file declares as its `id`, a prefab unreachable from the scene's `resources`, or a
  fetch that failed. It is exactly the diagnostic #344 lacked — Court's level selector rendered an
  empty grid with `npm run verify` green at 8,462 tests, because every one of those tests reads the
  prefab FILE and the file was well-formed.
  ⚠️ **#344's recorded cause — "a `version: 2` makes the loader decline to cache" — is not real,
  and the belief had spread to four places.** `fetchPrefab` (`meshTemplateCache.ts`) fetches,
  parses and caches without ever inspecting `version`; `editor/scene/prefab.ts` *wrote* `2` for
  any prefab holding nested-instance rows; and `games/court/.../level-page.prefab.json` carried 25
  nested rows at version `1` and worked. (Both of those are stated in the past tense on purpose:
  #379 made every writer stamp `PREFAB_FORMAT_VERSION` unconditionally and migrated the fleet, so
  `level-page.prefab.json` now reads `2` like everything else. The argument is unaffected — it was
  never about which value, only that no value gates loading.) **Confirmed live** (#365): with `level-tile.prefab.json`
  set to `2` and the editor restarted cold, the selector rendered its full 100 tiles at rects
  byte-identical to the version-1 control, with nothing logged. `prefabFormatVersion.test.ts`,
  which required every committed prefab to be `1` citing that mechanism, is **deleted** — it
  guarded a non-entrance and contradicted the serializer, so any editor re-save of a nested prefab
  would have turned `npm run verify` red telling the author to undo what the editor had just done.
  What actually emptied #344's grid is **still unestablished, and probably not a defect at all**:
  the reported commit was checked out and booted COLD, and it rendered the grid in full. The
  symptom belongs to one editor session, not to a tree — most likely the prefab cache serving the
  pre-restructure doc under a live editor. See [prefabs.md](./prefabs.md) and #365 before acting on
  the version theory again.
- ⚠️ **`axis` PINS the cross axis, and it has to.** `UIElement.overflow: 'scroll'` is a both-axes
  CSS property, so an `axis: 'x'` view scrolled vertically too — and on any platform with CLASSIC
  scrollbars (desktop web, the Electron editor) the second scrollbar STEALS cross-axis space from
  the content box. Measured in Court's selector (2026-08-21): a 31.6vh page inside a 31.6vh box
  came back **203px against the grid's 218px**, so the 5-across grid hung 15px outside its own
  page. `axis: 'x'` now emits `overflow-y: hidden`, and `'y'` the mirror.
- ⚠️ **A converted `scrollToEntry` builds that frame's window from the TARGET, not from the
  scroll still observable** (`entriesSystem`), and moves the travel baseline with it. This is the
  fix for a snap/recycling failure that had two faces and one cause: the offset is carried as
  PADDING, so a window built from the observable scroll described where the view WAS while the
  DOM moved to where it had been ASKED to go — and `scroll-snap-type: mandatory` answered that
  mismatch by re-snapping to the previously-snapped ELEMENT, which recycling had just repointed at
  different data. That moved the scroll, re-drove the pool, rewrote the padding, and re-snapped.
  Measured before the fix: asking for page 12 landed on 4 and page 23 on 6 (converging a few pages
  per attempt), and frame time at REST — no input, no pool churn — was **p50 39ms / p95 52ms**
  against 13/18. `scroll-snap-type: proximity` fixed neither.
✅ **Judged good on real touch hardware** (owner, 2026-08-22): Court's level selector, the shipped
iOS build on an iPhone Air — *"Scroll feels good on Air."* That is the verdict the CSS-motion
decision below rests on for touch, taken on a second device and a second platform after the S22
Android run, and it is what closes out the snap question: snapping stays ON throughout, with no
suspension. A perf number for the LOW-end target (Galaxy A23) is still owed — see #320; feel and
frame budget are different questions and the Air answers only the first.

- ⚠️ **Do NOT fix a snap/recycle symptom by suspending snap while the view moves.** It was tried,
  it worked, and the owner felt what it cost within minutes: with snap off during momentum the
  browser cannot decelerate INTO a snap point, so the view coasts to a full stop mid-entry and
  then jerks into line — *"the scroll stops completely once, then it snaps"* — and past the
  halfway mark that jerk reads as an extra entry. Fix the window instead; snap then has nothing to
  correct and stays on throughout. Verified with snap mandatory the whole time: swipe +1, +1,
  fling +3, swipe -2 all land exactly, a programmatic jump to entry 19 lands on 19, and frame time
  is p50 13ms at entry 3 AND at entry 21.
- ⚠️ **A HIDDEN view releases its pool, and "the pool never shrinks" never meant otherwise.** That
  rule is about not churning entities mid-scroll, when the device is busiest; holding them once
  nothing can see the view is a different thing and it cost real memory during play. Measured on a
  Galaxy A23 (2026-08-22): opening Court's level selector took the world from **668 to 1,477**
  entities, and closing it released **none** — 809 entities, 55% of the total, carried for the rest
  of the session behind a screen the player had left. The release checks BOTH ways the engine takes
  something off screen — `EntityAttributes.isActive` (cascading) and `UIElement.isVisible` (a
  per-element hide) — and walks the ANCESTOR chain, because the shipping case hides a ROOT above
  the scroll view, not the view itself. Re-showing rebuilds by re-instantiating.
- ⚠️ **`overscan` is NOT "how many extra you can see" — a pager needs 1 even though only 2 entries
  are ever visible.** Tried at `0` on Court's pager: the pool halved to 2 and never blanked at any
  speed (0 blank frames at ⅓, 1 and even 3 pages per frame) — and *landings broke*, a jump to page
  4 arriving at 0 and a fling to 4 arriving at 21. With no spare, a re-drive can remove the entry
  the scroll offset is standing on, and snap then grabs whatever does exist. **A blank-frame test
  does not cover this**; that is how `0` looked safe. The margin is what keeps the current entry in
  the pool across a re-drive, not what fills the viewport.
- ⚠️ **`wheel: 'entry'` on a PAGER, or a trackpad flies through pages.** A wheel delta MULTIPLIER
  cannot help: under `snap: mandatory` the browser quantises any offset to a whole entry, so
  scaling the delta changes nothing on screen. What needs bounding is how many entries one gesture
  may cross. A single mouse NOTCH (~100-120px against a 218px page) is under half an entry and
  snaps back to where it started; a trackpad swipe emits a rapid stream whose deltas accumulate
  into hundreds of px before the browser resolves them, so one flick crossed several pages (owner,
  2026-08-22: *"with the mouse wheel, scroll is too sensitive"*). `'entry'` moves exactly one entry
  per gesture, where a gesture ends after 140 ms of wheel silence — a fixed cooldown instead would
  let a trackpad's continuous stream re-fire and reintroduce the runaway. Default is `'native'`
  because a long LIST wants the raw delta; capping a 5,000-row strip to one row per gesture would
  be unusable. **Touch is unaffected either way** — a swipe is not a wheel event.
- `scrollByEntry(viewGuid, {x|y}, {behavior})` is what backs it: "move one entry from wherever I
  am", the same window arithmetic `snapToNearest` does plus a delta. A caller cannot compute it
  itself — the engine publishes no resolved entry stride, and `firstX` is the first POOLED entry.
- ⚠️ **`scrollbar: 'hidden'` when the box is sized to fit its content exactly.** A classic
  scrollbar takes ~15px off the CROSS axis, and mobile's overlay scrollbars take none — so
  authoring the box bigger to compensate leaves a gap on the platform that ships. Court's page
  grid was clipped 7px top and bottom until this was authored. Default is `'auto'`.

### Addressing a live entry — data coordinate, not identity

A parked entry (above) is the easy case. The one that produces a wrong answer SILENTLY is a
*visible* entry whose data coordinate changed underneath it: same entity, same guid, different
row of data. An agent that reads a guid while the view shows entry 5 and aims at it two calls
later — after a fling — drives entry 12 and gets a clean `ok:true`. That is a **false success**
([enact.md](./enact.md)) wearing a new hat: the standing advice is "address by `{guid}`, never
`{id}`", and here even the guid is not a stable address.

⚠️ **There is no address that survives this yet.** `entityResolve` accepts `{guid} | {name} |
{id}` and nothing else, so today the only safe protocol is to **re-read the guid immediately
before acting on it** — the same "re-read bounds immediately before acting" rule, one level up.
The plan proposed a data-coordinate address resolved server-side inside the call, refused when
the coordinate is not currently realized (scrolled out, or past `countX`/`countY`), the way
`selector`/`tap_handle` already work:

```
entity: { entry: { view: '<scroll-view guid>', x: 3, y: 0 }, surface: 'game-ui' }   // NOT BUILT
```

That is a **proposal, not a surface**. Nothing parses it; do not write it into a call.

⚠️ **A pooled instance's guid is random unless made otherwise.** `spawnPrefabInstance` mints a
fresh `newGuid()` root unless given a `guidSeed`, and members derive off that root. The pool
passes a deterministic `guidSeed` built from the view guid + slot (which the determinism guard
wants anyway) — but that makes the guid stable at the **slot**, not the entry.
`{entity:{name:'Tile3'}}` means "whatever is in slot 3 right now", and its meaning changes as you
scroll; addressing by `{name}` is worse still, since every pooled instance of one prefab collides
and CLAUDE.md says that is refused rather than first-matched.

### Focus follows the ENTRY, not the slot

The same hazard, one layer up, and it bites the PLAYER rather than an agent. Focus is addressed
by guid (`focusManager`), a pooled instance's guid is stable at the **slot**, and the window
moves data under the slots — so a recycle leaves the focused guid resolving to a live, visible
element that is now showing different data. A gamepad cursor on level 5 is silently on level 12,
and the next Confirm launches the wrong one. Nothing errors, which is why this stayed latent as
long as it did: neither Court's selector nor `games/scroll-demo` uses focus nav, so nothing on
the surface could show it (#319).

So `entriesSystem` captures where focus sits — the entry coordinate plus the member path inside
that entry — before it re-drives the slots, and re-points focus at whichever slot holds that
entry afterwards (`entriesFocus.ts`).

- **It runs at `UI_ENTRIES` (270), inside the drive that caused the recycle**, not in
  `uiFocusSystem`. That system is GAME-tier and therefore dead while paused — the same reason the
  pool itself runs at 270.
- ⚠️ **When the entry has left the pool entirely, focus CLAMPS to the nearest resident entry**
  (owner, 2026-08-22). Clearing focus is the simpler rule and was rejected on feel: with a
  gamepad, focus vanishing mid-fling reads as a dropped input, and autofocus would then drop the
  cursor at the list's lowest `focusOrder` rather than where the player was looking. Clamping
  makes focus ride the leading edge in the direction of travel.
- **The member path is a `stepId` chain, and both obvious alternatives are wrong.** It cannot be
  `resolveMemberPathIn`'s name path: that walker calls an ambiguous segment an ERROR by design,
  which is right for an authored resolver key and wrong here — this path is DERIVED from an
  entity that provably exists, so refusing it would mean declining to re-target focus that is
  demonstrably sitting somewhere (`level-tile.prefab.json` alone carries three `Num`s). And it
  must not be **name + ordinal among siblings**, which is the tempting fix and is unsound: that
  order comes from `buildChildIndex` iterating `world.entities`, which is koota's `dense` array,
  which `releaseEntity` maintains by **swap-pop** — destroying any entity moves the world's LAST
  alive one into the freed slot. `releaseViewPool` destroys hundreds at once when an unrelated
  view is hidden (809 on Court's selector close), so a destroy elsewhere can reorder two siblings
  of a live instance relative to the same two in every other instance, and the ordinal would then
  name a different member per slot with no error anywhere. A segment is therefore
  `PrefabInstance.parentLocalId || localId` — authored, identical across instances, unique among
  siblings by construction. That is not a new claim: `deriveInstanceMemberGuids` already builds
  every member guid from exactly this chain, for exactly this reason.
- ⚠️ **A QUEUED ACTIVATION moves with the focus, and forgetting that half fires the wrong
  element.** A "confirm" is deferred on purpose: `uiFocusSystem` sets `pendingActivateGuid`
  inside the pipeline tick and `UIRenderer` drains it from a React effect after commit, because
  `applyBindings`' `call` path throws from a tick. `driveEntriesFromScroll` runs straight off the
  DOM `scroll` event, so a re-drive lands *inside* that gap — and a queued guid left on the old
  slot would activate whatever entry the slot recycled to. Confirm on level 5 launching level 12,
  from one fling. `retargetFocusedGuid` moves both or neither; never call `setFocus` here.
- **Zero cost when nothing is focused** — one `focusedGuid()` read, which returns the empty
  string in every game today.
- `focusOrder` is authored once in the prefab and is therefore identical across the whole pool,
  so nav ORDER between entries still falls entirely to the DOM-rect spatial path. That is a
  separate gap and this does not close it.

### The DOM shape — a column of auto-width rows, and why a flat box cannot work

The scroll offset is carried as **padding**, and CSS padding eats the box it sits on. A single
content child at `width: 100%` with `padding-right: 23040px` has a content box of **zero**: every
entry in it shrinks to nothing and `flex-wrap` has no line to wrap into. Measured on
`games/scroll-demo` (2026-08-21): pager pages came back **0px wide**, and grid tiles authored at
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

⚠️ **Two things change the window without moving its origin, and both are in the invalidation
test.** A viewport RESIZE leaves `first` put while every padding value changes — without that the
pager kept a 640px page inside a 395px panel, for good. And at `scroll = 0` the origin is
CLAMPED to 0, so a travel spike that raises the overscan and then decays changes `pooled` while
`first` cannot move: with only the X pooled count tracked, the top of the 5,000-entry strip went
from 8 rows to 29 on a fast scroll and stayed at 29 through 60 idle frames. Entry size AND the
pooled count on BOTH axes therefore invalidate, not just the origin.

**Snapping is declared on the box and honoured on the TARGET**, and those are different
elements. The tree build stamps `scroll-snap-align`/`scroll-snap-stop` onto the pooled entries
(or, for a scroll view with no entries, onto its direct children). Stamping the *entry* rather
than the row serves both axes at once. `scrollSnapChildStyle` shipped with a unit test and no
caller, so `snap` styled the container and nothing ever snapped — found by measuring the pager's
DOM, and the reason this paragraph exists.

### Degenerate shapes

`countX`/`countY: 0` is undefined — nothing renders, and whether the view still scrolls to
nowhere is unspecified. More sharply: a scroll container needs a **definite** cross-axis size,
and `UIElement.height` defaults to `0` = auto — so an un-anchored scroll view in flex flow grows
forever and never scrolls, with **no error at all**. Author an explicit height (or anchor the
view); there is no diagnostic for this yet. Nested scroll views get `overscroll` (which only
governs chaining) and have no inner-viewport measurement story.

### Open questions

- Does the padding-offset approach interact cleanly with `UIAnchor` when the scroll view is
  itself anchored? Believed yes — the padding lives on an inner child, not the anchored root —
  but unverified.
- Should scroll position be journalled? Leaning no: it is DOM-driven presentation state, and
  journalling at fling frequency would drown the journal. Revisit if a test ever needs it.

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

#### Invalidating an SDF font: a late cleanup must run, not queue

`invalidateFont(guid)` (the SDF sibling of the DOM eviction above) disposes the live provider and
re-acquires a fresh one **under the same guid**, so the Three/Pixi atlas-texture caches — keyed
`${provider.id}:image` — are what carry the old atlas across the swap. Those entries are freed
through `provider.addDisposable`, and the Pixi image path registers its cleanup **inside the
`.then()` of an async `loadPixiTexture`**. Disposing the provider mid-flight therefore left the
registration landing on an already-disposed provider, where it was pushed onto a `disposables`
array nothing would ever drain again: the entry survived, the re-acquired provider hit it as a
cache hit, and the **re-baked font kept drawing the old atlas until a page reload** — permanently,
since a provider taking the cache-hit early-return registers no disposable of its own to clean it
up later either.

The fix is on the contract, not the call site: **`addDisposable` after `dispose()` runs `fn`
immediately** (both `BakedFontProvider` and `DynamicFontProvider`). A late registration is the
normal case for an async load, not a misuse, so dropping it silently was the defect. The Three
twin never showed the symptom — `TextureLoader.load` returns synchronously and registers before
any dispose can interleave — which is exactly why the shared contract, rather than a patch to the
Pixi `.then()`, is where this belongs. Pinned by `fontTexturePixi.test.ts` § "a provider disposed
mid-load must not leave its texture in the cache", which asserts the cache entry, the
`Assets.unload`, and the contract on both provider classes.

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
