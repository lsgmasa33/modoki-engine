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

`UIElement` is a single ~60-field trait holding layout, box style, text, image, and
element-type properties. There is no separate "label" vs "panel" vs "button" trait —
**rendering is content-driven**: a node renders its `text` if non-empty, and paints
`imageSrc` as a CSS `backgroundImage` if non-empty (so text can sit *over* an image).

Field groups (representative fields, verified against `UIElement.ts`):

- **Layout** — `width`/`height` (+ `widthUnit`/`heightUnit`, `'px' | '%'`, `0` = auto),
  `flexDirection`, `flexWrap`, `justifyContent`, `alignItems`, `gap`, `flexGrow`,
  `flexShrink`, per-edge `padding*`/`margin*` (each with its own `*Unit`),
  `minWidth`/`maxWidth`/`minHeight`/`maxHeight`, `alignSelf`, `zIndex`, `overflow`
  (`visible | hidden | scroll`), `isVisible`.
- **Style (box visuals)** — `backgroundColor` (packed hex int, `0` = transparent),
  `backgroundOpacity`, `borderRadius`, `borderWidth`, `borderColor`, `opacity`.
- **Text** — `text`, `fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `textColor`,
  `textAlign`, `lineHeight`, `letterSpacing`, `textShadow*` (color/offsetX/offsetY/blur),
  `textStrokeColor`/`textStrokeWidth`, `textOverflow` (`clip | ellipsis`), `maxLines`.
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
`runtime/ui/actionRegistry.ts`, where games register handlers via
`registerUIAction(name, handler)` / `unregisterUIAction(name)`. An unknown action
**throws in dev** and warns in production, so typo'd action names surface immediately.
(Bindings are inert unless the game is running — `applyBindings` early-returns when the
sim is stopped, so editor Stopped/Paused states never mutate the scene.)

#### Engine built-in `UIAction`s

Three stateless lifecycle/animator handlers are registered once at startup by
`registerEngineActions()` (`runtime/ui/engineActions.ts`), callable from any
`kind:'call'` binding by name:

- **`engine.reload`** — `window.location.reload()` (hard web-view reload).
- **`engine.quit`** — a no-op that logs on web; the app shell wires Capacitor's
  `App.exitApp()` if a real device quit is needed.
- **`engine.toggleAnimator`** — flips `playing` on the binding's `target` entity's
  animator, toggling whichever of `SkeletalAnimator` (GLB skeletal clips) / `Animator`
  (keyframe `.anim.json`) the target carries — a plain field write the render sync picks
  up next frame. Warns if the target is missing or carries neither trait.

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
right/bottom offsets subtracting inward, etc.).

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

`uiFocusSystem` (`runtime/systems/uiFocusSystem.ts`) is an app-pipeline GAME-tier system
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
   offset (a slightly-off but closer target still wins; a wildly-sideways one loses),
   using on-screen rects from the shared bounds providers. Headless (no rects) → spatial
   no-ops, but explicit links + autofocus still work.

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
jitter | fade | rainbow`), `speed`, `amplitude` (em, ×fontSize), `frequency` (per-glyph
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
`.meta.json` (`font` block, `runtime/loaders/fontSettings.ts`): `fieldType` (`mtsdf`),
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
| Element trait (~60 fields) | `runtime/traits/UIElement.ts` |
| Bindings / actions / anchor | `runtime/traits/UIBinding.ts`, `UIAction.ts`, `UIAnchor.ts` |
| Renderer + DOM node | `runtime/ui/UIRenderer.tsx`, `UINode.tsx` |
| Tree build + dirty flag | `runtime/ui/uiTreeStore.ts` (`buildTree`, `markUIDirty`, `uiTreeProjection`) |
| Selector hook | `runtime/ui/useUIEntities.ts` |
| Action registry + engine built-ins | `runtime/ui/actionRegistry.ts`, `runtime/ui/engineActions.ts` |
| Binding resolver | `runtime/ui/bindingResolver.ts` |
| Anchor math | `runtime/ui/anchorLayout.ts` |
| Focus nav (trait / system / manager) | `runtime/traits/UIFocusable.ts`, `runtime/systems/uiFocusSystem.ts`, `runtime/ui/focusManager.ts` |
| Text animation | `runtime/traits/TextAnimation.ts`, `runtime/ui/uiTextAnimation.ts`, `runtime/rendering/text/textAnimate.ts` |
| Nine-slice image + editor | `runtime/ui/NineSliceImage.tsx`, `editor/panels/NineSliceEditor.tsx` |
| Fonts (FontFace loader / MSDF convert / settings) | `runtime/loaders/fontLoader.ts`, `plugins/font-convert.ts`, `runtime/loaders/fontSettings.ts` |
| Custom game UI | game's `game.ts` (`UIComponent`), `app/App.tsx`, `app/ui/DefaultGameUILayer.tsx` |
