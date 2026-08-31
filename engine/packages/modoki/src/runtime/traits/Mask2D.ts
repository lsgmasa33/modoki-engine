import { trait } from 'koota';

/** Mask2D — clip an entity AND every descendant in the 2D layer (#449).
 *
 *  `Scene2D` renders a FLAT PixiJS tree (every display object goes straight onto its Canvas2D
 *  slot container, per `groupAlpha.ts`'s header), so a parent's transform/alpha never reaches
 *  its children the way nested PixiJS containers would. `Mask2D` rides the same sparse
 *  ancestor-walk shape as `GroupAlpha` (`computeMaskGroups`, the `maskGroups.ts` sibling of
 *  `computeGroupAlpha`) to answer the analogous question for clipping instead of fading: which
 *  entities does this mask's shape clip, given the flat tree?
 *
 *  Put it on an entity to clip that entity and its whole subtree to the mask's shape. TWO things
 *  are exempt, deliberately. **Particles are never clipped** (owner ruling, #453) — the load-bearing
 *  one: a travelling effect that crosses a clip boundary (a particle flying INTO a clipped panel,
 *  or wordweave's #450 flying letters) would have its arc erased. The **collider debug overlay**
 *  (`zIndex = 1e9`) bypasses it too, so a debug shape you cannot see because it got clipped is not
 *  a useful debug shape. Read the contract as "every descendant except those two".
 *
 *  Nested `Mask2D`s INTERSECT rather than replace: each mask applies as the tree descends, so a
 *  descendant is clipped to every ancestor mask's shape at once, not just the nearest one — the
 *  renderer nests mask containers to get this for free instead of hand-intersecting shapes.
 *
 *  `width`/`height` are **HALF-extents**, exactly like `Renderable2D`'s convention (see that
 *  trait's doc comment) — the masked rect spans `width * 2` by `height * 2`. This is the
 *  classic place to get it backwards: a mask authored as if these were full extents clips at
 *  half the intended size. `pivotX`/`pivotY` follow `Renderable2D`'s pivot convention too
 *  (`computePivotOffset` in `render2DUtils.ts`: 0.5/0.5 centers the rect on the entity origin,
 *  0/0 anchors its top-left corner there) — read consistently so a mask lines up with the
 *  sprite it is meant to clip without a separate mental model.
 *
 *  `feather` is in DESIGN PIXELS (0 = hard edge, >0 = a soft alpha ramp that many pixels wide).
 *  ⚠️ This is not free, and the cost split is a REAL mechanism, not an implementation detail:
 *  Pixi's mask resolution (`rendering/init.mjs`, testing `AlphaMask, ColorMask, StencilMask` in
 *  that order) resolves a `Sprite` mask to `AlphaMask` and any other `Container` — including a
 *  `Graphics` rect/rounded-rect — to `StencilMask`. A hard edge (`feather: 0`) draws as a
 *  `Graphics` shape and gets the cheap `StencilMask` path; a soft edge needs alpha gradation,
 *  which only `AlphaMask` gives, so `feather > 0` costs a filter pass. Prefer `feather: 0`
 *  unless the soft edge is actually visible in the shot.
 *
 *  `mode: 'texture'` masks by the alpha channel of `sprite` instead of a rect + corner radius —
 *  for shapes the rect path can't describe (a starburst, an irregular vignette). ⚠️ `sprite` is
 *  a GUID, resolved via the asset manifest — per the repo's GUID-only rule, never a literal
 *  asset path (`assetRefIntegrity.test.ts` guards this).
 *
 *  ⚠️ The mask's geometry comes from the MASK ENTITY'S OWN world transform, evaluated like any
 *  other entity's. So a mask must sit on a STATIC parent, not on the thing it's meant to clip —
 *  putting it on a pan/zoom root moves the mask WITH the content it's clipping, and it stops
 *  clipping anything (the wordweave crossword case: the board pans, a mask on the board pans
 *  with it and never crops the viewport). Put the mask on a non-moving ancestor instead, sized
 *  to the viewport you want.
 *
 *  ⚠️ A masked group becomes a CONTIGUOUS Z-BAND: everything the mask clips is drawn together as
 *  one unit, so an entity outside the group cannot interleave in draw order with an entity
 *  inside it (no drawing an unmasked HUD element "between" two masked sprites). This is a real
 *  authoring constraint on paint order, not a rendering detail to work around per-case. */
export const Mask2D = trait({
  /** 'rect': an authored rectangle (width/height/pivot/cornerRadius/feather), drawn as a
   *  Graphics shape. 'texture': the alpha channel of `sprite`, for shapes a rect can't express. */
  mode: 'rect' as 'rect' | 'texture',
  /** Off = no clip at all (transparent pass-through) — lets a mask be authored once and toggled
   *  without removing the entity or breaking the z-band its descendants sit in. */
  isEnabled: true as boolean,
  /** ⚠️ HALF-extent, matching `Renderable2D.width/height` — the masked rect is `width * 2` wide.
   *  Only read in 'rect' mode. */
  width: 0.5 as number,
  /** ⚠️ HALF-extent — see `width`. */
  height: 0.5 as number,
  /** Pivot, `Renderable2D` convention: 0.5/0.5 centers the rect on this entity's origin. */
  pivotX: 0.5 as number,
  /** Pivot, `Renderable2D` convention: 0.5/0.5 centers the rect on this entity's origin. */
  pivotY: 0.5 as number,
  /** Corner radius in design pixels, 'rect' mode only. 0 = sharp corners. */
  cornerRadius: 0 as number,
  /** Soft-edge width in DESIGN PIXELS. 0 = hard-edged stencil mask (cheap); >0 = a soft alpha
   *  ramp that costs a filter pass (see the trait header — AlphaMask vs StencilMask). */
  feather: 0 as number,
  /** Sprite GUID used as an alpha mask in 'texture' mode. GUID-only — never a literal path. */
  sprite: '' as string,
  /** The mask rect's centre relative to the mask entity's OWN origin, in the entity's LOCAL space
   *  (design px). ⚠️ This field exists to remove a trap, so state it plainly: a `Mask2D` clips a
   *  subtree by being its ANCESTOR, so moving the mask ENTITY also moves every descendant it
   *  clips — a mask parked at a panel's centre displaces the whole subtree by that centre (measured
   *  live in wordweave: `CrosswordClip` at (540, 515.6) shifted every crossword cell by exactly
   *  that, off the panel entirely). Use `offsetX`/`offsetY` to place the clip rect and leave the
   *  mask entity's `Transform` at identity instead. This sits ALONGSIDE the "put the mask on a
   *  static ancestor" warning above — both are needed: static keeps the mask from panning with the
   *  content it clips, and a zero entity transform keeps it from displacing that content. */
  offsetX: 0 as number,
  /** ⚠️ See `offsetX` — same local-space offset, Y axis. */
  offsetY: 0 as number,
});
