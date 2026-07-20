import { trait } from 'koota';

/** Compositing mode for a 2D renderable (maps 1:1 to the PixiJS blend strings).
 *  `normal` = source-over alpha (default); `add` = additive (glow on dark);
 *  `multiply` = darken; `screen` = lighten. Shared with the 2D-material work. */
export type Renderable2DBlendMode = 'normal' | 'add' | 'multiply' | 'screen';

export const Renderable2D = trait({
  sprite: '' as string,
  /** Optional custom 2D material — a `space:'2d'` `.shader.json` GUID. Empty = the
   *  default texture/tint path (unchanged). When set (and the program resolves), the
   *  entity renders as a shaded quad via a per-entity PixiJS `Shader`, sampling its
   *  own sprite as `uTexture`; a `MaterialInstance` on the entity drives the shader's
   *  uniforms. GUID-only, resolved via the asset manifest (never a literal path). */
  material: '' as string,
  color: 0xffffff as number,
  /** Alpha multiplier (0..1) applied on top of `color`'s RGB tint — the color's
   *  A channel. Folded into the Inspector color picker for Renderable2D. */
  opacity: 1 as number,
  width: 20 as number,
  height: 20 as number,
  pivotX: 0.5 as number,
  pivotY: 0.5 as number,
  keepAspect: false as boolean,
  /** Mirror horizontally (flip around the vertical axis) about the pivot — for sprite
   *  facing. A pure render property: unlike a negative Transform.scale it never touches
   *  the transform, never mirrors child entities, and is invisible to the physics collider. */
  flipX: false as boolean,
  /** Mirror vertically (flip around the horizontal axis) about the pivot. */
  flipY: false as boolean,
  /** Per-renderer visibility — hides just THIS renderable. Independent of the entity's
   *  on/off (`EntityAttributes.isActive`, which also cascades to children); both must be
   *  true to draw. */
  isVisible: true as boolean,
  /** Compositing / blend mode (`normal | add | multiply | screen`). `add` gives an
   *  additive glow with zero shader work; the others darken/lighten. Applies to both
   *  the sprite and primitive (graphics) draw paths. */
  blendMode: 'normal' as Renderable2DBlendMode,
  /** Draw-order override (Unity "Order in Layer"): higher = painted on top, GLOBALLY,
   *  independent of the entity hierarchy. 0 (default) falls back to pure hierarchy paint
   *  order (sortOrder DFS). Lets sprites parented to different bones (e.g. a cut-out
   *  character's parts) stack by an explicit layer order instead of tree position. */
  orderInLayer: 0 as number,
});
