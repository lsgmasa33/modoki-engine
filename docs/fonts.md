# Fonts & SDF text

Everything the Font Inspector and the `Text2D`/`Text3D` inspectors expose: what each knob
does, on which path, and **what it interacts with**. Written because the interactions are
the hard part — several knobs look independent and are not, and one that "does nothing"
is usually being scaled to nothing by another.

See also: [Rendering](./rendering.md) (the 2D/3D text passes) · [UI System](./ui-system.md)
(the separate `FontFace` pipeline for DOM/CSS text) · [Build](./build.md) (what ships).

Live reference scene: **`games/text_demo` → `font-parameters.scene.json`**. One block per
interaction, each changing exactly one thing. Block A (baked vs dynamic, everything else
matched) is a **control**: those two rows must be indistinguishable, and a difference there
is a bug rather than a setting.

---

## 1. Two font pipelines, and which one you are in

| | DOM / CSS text | SDF world text |
|---|---|---|
| Trait field | `UIElement.fontFamily` (a CSS family **name**) | `Text2D.font` / `Text3D.font` (an asset **GUID**) |
| Loader | browser `FontFace` (`runtime/loaders/fontLoader.ts`) | MSDF atlas (`runtime/loaders/fontAtlasLoader.ts`) |
| Needs the `.ttf` shipped | yes | no — the atlas alone renders |
| Honours the Font Inspector | no | yes |

The Font Inspector settings below apply **only** to SDF world text. CSS text instances a
variable font natively via `font-weight`, so it ignores `variationAxes` entirely — which is
why `sourceShipped` and `instanced` are independent flags on the manifest.

---

## 2. The one rule behind most "this knob does nothing"

Every text effect is a **threshold band inside the distance field**. The field is only
`pxRange` pixels wide at a glyph size of `size` pixels, so the field's whole em budget is

```
1 field unit = pxRange / size  em
```

and **every effect is denominated in field units**:

| Knob | em it actually produces | at 8/128 (default) | at 24/128 |
|---|---|---|---|
| `weight` (max 0.25) | `weight × pxRange/size` | 0.016 em | 0.047 em |
| `outlineWidth` (0..1) | `w × 0.4 × pxRange/size` | 0.025 em | 0.075 em |
| `glowSize` (0..1) | `g × 0.45 × pxRange/size` | 0.028 em | 0.084 em |
| `shadowOffsetX/Y` | clamped to `pxRange/size` | 0.063 em | 0.188 em |

So the **same authored value produces 3× the effect on a pxRange-24 font**. This is not a
bug and cannot be normalized away — a wider band needs field to live in, and the field is
baked. Consequences worth internalizing:

- An outline at full width on the default 8/128 bake is **1.5 px on 60 px text**. That reads
  as a dead slider. Raise `pxRange` and re-bake; it costs atlas area. The Font Inspector's
  **Effect budget** panel states the numbers for the font you are looking at.
- Comparing two fonts is only meaningful when their `pxRange/size` match. Block B and C of
  the reference scene exist to make that visible.
- `shadowOffset` is clamped, not ignored: the shadow is an *offset sample of the same atlas*,
  so past the baked padding it reads the neighbouring glyph. Bigger shadow ⇒ bigger `pxRange`.

---

## 3. Font Inspector (the `font` block in a `.meta.json` sidecar)

| Setting | Effect | Baked | Dynamic | Interacts with |
|---|---|---|---|---|
| `fieldType` | `mtsdf` = 4-channel (RGB median + a true SDF in alpha). `msdf` = 3-channel, ~25% smaller | ✅ | ❌ **not offered** — the runtime generator is MSDF-only and synthesizes alpha = median(RGB) | glow + soft shadow (see below) |
| `size` | glyph em size in px the field is rasterized at | ✅ | ✅ | the effect budget (§2); corner quality |
| `pxRange` | distance range in px baked into the field | ✅ | ✅ | **everything in §2** |
| `charset` / `customChars` | which glyphs are baked | ✅ (a miss ⇒ tofu) | ✅ but only a **warm start** — anything else generates on demand | — |
| `atlasMax` | **baked**: not used (msdf-atlas-gen auto-sizes, `-potr`) — the control is hidden. **dynamic**: the runtime page size | — | ✅ | page count / LRU eviction |
| `mode` | `baked` = fixed atlas only. `dynamic` = the atlas seeds a runtime generator | — | — | see §5 |
| `variationAxes` | pins a variable font's axes **before** rasterizing — the real typeface weight | ✅ | ✅ | distinct from `Text2D.weight` (§4) |
| `shipSource` | whether the build ships the `.ttf` next to the atlas | ✅ | ✅ | DOM usage only; SDF text never needs it |

**`fieldType: 'msdf'` used to be a footgun and no longer is.** Glow and the *soft* drop
shadow read a true SDF; a 3-channel atlas samples alpha as 1.0 everywhere, so they used to
saturate into solid rectangles over the whole glyph quad, and the corner-clash correction
(`max(0, alpha − median)`) dilated the fill at every edge. Both shaders now fall back to the
median when the atlas has no alpha SDF (`uHasTrueSdf` in the Pixi program, a build-time
branch in the TSL one) — which is exactly what the dynamic path always did. The cost is now
only a very slight softening at concave corners, stated in the Inspector.

That fix shipped BROKEN for one commit, in a way worth remembering: `Scene2D` built the
shader's atlas argument from a hand-written four-field literal, so the new `type` field was
silently dropped and the fallback never engaged — while the unit tests stayed green, because
they assert on the generated shader SOURCE and not on the uniform that reaches it. It was
caught only by authoring a real `fieldType: 'msdf'` font and looking (block G of the
reference scene). `MtsdfPixiAtlas.type` is REQUIRED now, and the caller spreads
`{ ...provider.atlas }`, so the same omission is a compile error rather than a silent
behaviour change. The repo rule it violated is in CLAUDE.md: prefer binding the whole thing
over enumerating fields, because a hand-maintained field list goes stale invisibly.

**One font asset = one instance** (as in Unity). Two weights of a family = two font assets,
because each bakes its own atlas. `msdf-atlas-gen`'s `-varfont` flag is a **silent no-op** in
our build (accepted, exit 0, byte-identical atlas — measured), so instancing is done up front
with `hb-subset` via `harfbuzzjs` and the bake is always fed an already-pinned file. A test
asserts `buildAtlasGenArgs` never emits `-varfont`; do not "simplify" that away.

---

## 4. `Text2D` / `Text3D` — the per-entity knobs

Both traits carry the same field set (`Text3D` adds `billboard`, `Text2D` adds
`orderInLayer`) and render through the same maths, so 2D and 3D text look identical.

**Layout** — `text`, `fontSize`, `align`, `maxWidth` (0 = no wrap), `lineSpacing`,
`letterSpacing`, `anchorX/Y`. All path-independent; `fontSize` is px for `Text2D` and world
units per em for `Text3D`.

**Colour** — `color` + `opacity`. A per-glyph colour animation (`TextAnimation` rainbow/fade)
multiplies on top via a vertex attribute.

**Effects** — all budgeted by §2:

| Field | Notes |
|---|---|
| `weight` | Faux-bold: shifts the fill threshold outward. **Negative is clamped to 0 by both shaders** — eroding a rasterized glyph nicks sharp corners, so *thinning is an import choice* (a lighter `variationAxes.wght`, or the family's Light weight), not a per-entity one. The Inspector's minimum is 0; a scene/prefab/code can still author a negative, and it does nothing. |
| `outlineWidth` / `outlineColor` / `outlineOpacity` | 0..1 mapped to a seam-free budget. Uses the **median** field (a sharp outline wants the same clash-free field the fill uses). Shrinks toward nothing at small on-screen sizes rather than flooding the quad. |
| `glowSize` / `glowColor` / `glowStrength` | Soft band outside the median silhouette. **Both `glowSize` and `glowStrength` must be non-zero** — `glowStrength` defaults to 1 and `glowColor` to white precisely because a 0/black default made the glow doubly inert. |
| `shadowOpacity` / `shadowColor` / `shadowOffsetX/Y` / `shadowSoftness` | `shadowOpacity: 0` = off. Offset is in em and **clamped** (§2). `shadowSoftness` 0 = crisp (median), > 0 = soft (alpha SDF). |

**`variationAxes.wght` vs `Text2D.weight` — not the same thing, and this has been conflated
more than once.** The axis picks which *instance of the typeface* is rasterized: real
outlines, correct advances, correct counters. `weight` dilates whatever was rasterized. Block
D of the reference scene shows a dilated Thin beside the real Bold — counters close and joins
thicken, but the stems never arrive.

---

## 5. `mode: dynamic` — what it is for, and its two footguns

A dynamic font is **seeded by its own baked atlas** and generates only what the bake does not
contain. Page 0 IS the `~atlas.png`, loaded exactly as a baked font loads it; a codepoint
outside the baked charset is generated at runtime from the real outlines
(`@zappar/msdf-generator`, msdfgen on WASM in a worker) onto pages 1+, sized to match the
bake, with LRU eviction. That is how CJK works without baking 7000 glyphs. When
`variationAxes` is set the generator fetches the pinned `~instance.ttf`, not the source — it
cannot apply axes itself — and it fetches it **lazily, on the first miss**.

So a dynamic font costs exactly what a baked one costs until something actually misses: no
worker, no wasm, no rasterization at boot. It did not always work that way. The loader used
to ignore the bake entirely and REGENERATE the seed charset on every load — Court shipped a
346 KB `~atlas.png` it never fetched, downloaded a 1.5 MB wasm, and rebuilt the same 95 ASCII
glyphs the atlas already held (~640 ms on a desktop, more on a phone), all of it blocking the
scene load because fonts are awaited scene resources.

Two consequences of page 0 being an image while pages 1+ are canvases, both of which bit:
the page-0 texture is cached **without** `atlasVersion` (it is immutable, and keying it by a
version that bumps on every generated batch made all baked text flicker while the same URL
re-loaded); and the renderers ask for a **canvas** and fall through when there isn't one,
rather than branching on whether the provider has an `atlasCanvasAt` method at all.

⚠️ The bake is loaded as an **image**, never drawn into a canvas. A 2D canvas stores
premultiplied alpha, and a baked mtsdf atlas carries a true SDF in alpha — round-tripping it
would destroy RGB precision exactly where alpha is low, which is the outside region where
outline and glow live. Hence page 0 is an image texture and generated pages are canvases; the
renderers ask for a canvas first and fall through to the image.

Two things bit hard enough to be worth stating outright:

### The generator is a SHARED, SINGLE-FONT worker — generations must be serialized

The worker holds exactly one loaded font, and the library's `generateAtlas` is two awaited
round-trips: `loadFont(font)` then `generateAtlas(...)`. Two fonts generating concurrently
interleave as `loadFont(A) · loadFont(B) · generateAtlas(A) · generateAtlas(B)` — and **A's
atlas comes back drawn from B's outlines**. Nothing errors: real glyphs, real advances, wrong
typeface.

A scene with **two** `mode:'dynamic'` fonts hits this at load, because `acquireFont` seeds
them in parallel. It therefore presented as an intermittent cold-start *"this font renders at
the wrong weight"* that healed after a re-import (a lone re-acquire cannot race) — and it cost
a full session, because every check of the **served bytes** was correct. The swap is inside the
generator, past anything a `fetch` can observe. It was finally caught by reading the live
provider's vertical metrics: the Geologica-wght-700 provider reported `H` advance 0.698 and
ascender 1.16 — NotoSansJP's numbers, against Geologica's own 0.773 / 0.975.

`generateMsdf` now serializes every call through a module-level promise chain (`genQueue`),
and `DynamicFontProvider` errors if a later batch's vertical metrics disagree with its seed's,
so the condition can never be silent again. **The lock is correctness, not throttling** —
`DynamicFontProvider.flush()`'s `generating` flag does not cover it, being per provider when
the race is *between* providers.

### The generator's cell padding is `floor(fieldRange/2)`, not the `padding` option

The `padding` option is only the packer's gap *between* cells in its scratch atlas; each glyph
cell is padded by `floor(fieldRange/2)`. Measured at size 128 with the option pinned at 8:
fieldRange 8/16/24 ⇒ cell pad 4/8/12.

This matters because the quad the runtime builds must match the cell its UVs address. A
constant 8 was right only by coincidence (`floor(16/2) === 8`) and broke the moment
`fieldRange` became authored: a font authoring `pxRange: 8` got cell pad 4 against a quad
built for 8, so every glyph rendered ~8% oversized and shifted — **non-uniformly**, since the
error is `(bw+16)/(bw+8)` and so far worse for a narrow glyph (`l` ≈ +35% wide) than a wide
one (`H` ≈ +8%). The padding is now derived in one place and used for both.

Related: the generator shelf-packs into whatever texture it is handed and **never
bounds-checks the bottom edge** — a cell past it is written out of range, silently dropped by
the typed array, and the glyph blits fully transparent. `atlasMax` used to size that scratch
atlas as well as our pages, so `atlasMax: 512` + `size: 128` lost **70 of 95** seed glyphs with
no warning. The scratch is now a fixed 2048 independent of `atlasMax`, and each generation is
chunked to fit it.

---

## 6. Debugging text that looks wrong

- **Measure the PROVIDER, not the served bytes.** `getLoadedFont(guid).metrics` +
  `.getGlyph(cp).advance` is the ground truth for *which typeface actually got rasterized*.
  Vertical metrics are the cheapest fingerprint separating two faces, and they do not move
  with a variation axis. In the dev editor:
  `await import('/packages/modoki/src/runtime/loaders/fontAtlasLoader.ts')` reaches the app's
  own module instance — a `/@fs/…` import gives a **second** instance with an empty provider
  map, which reads as "no fonts are loaded".
- **A rect is not a weight measurement.** `get_layout_bounds` returns the quad union, which
  includes the field padding — and the baked and dynamic paths pad differently (msdf-atlas-gen
  uses `-pxpadding` = `pxRange` *plus* `range/2`; the generator uses `floor(range/2)` alone).
  Two fonts with different `pxRange` are not comparable by rect. Compare *modelled* widths, or
  measure ink.
- **Compare at matched settings or not at all** — Block A of the reference scene.
- **`weight` and the effects scale with `pxRange/size`** (§2) before you conclude a knob is dead.

---

## Quick reference

| Concern | Where |
|---|---|
| Import settings + defaults | `runtime/core/fontSettings.ts` |
| Font Inspector | `editor/panels/assetViews/FontAssetView.tsx` |
| Bake (msdf-atlas-gen) | `engine/plugins/font-convert.ts`, `font-cache.ts` |
| Axis instancing (hb-subset WASM) | `engine/plugins/font-instance.ts` |
| GUID → provider, scene refcount | `runtime/loaders/fontAtlasLoader.ts` |
| Baked / dynamic providers | `runtime/rendering/text/fontProvider.ts`, `dynamicFontProvider.ts` |
| Runtime generation (shared worker + lock) | `runtime/rendering/text/msdfGenerate.ts` |
| Generator output → our glyph format | `runtime/rendering/text/dynamicGlyphMap.ts` |
| Layout (shared by 2D + 3D) | `runtime/rendering/text/layoutText.ts` |
| Shaders | `runtime/rendering/text/mtsdfShader.ts` (Three/TSL), `mtsdfPixiShader.ts` (Pixi WGSL+GLSL), `mtsdfStyle.ts` (shared budgets) |
| Reference scene | `games/text_demo/runtime/assets/scenes/font-parameters.scene.json` |
