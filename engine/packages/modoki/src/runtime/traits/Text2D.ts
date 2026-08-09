import { trait } from 'koota';

/** SDF text on the 2D (PixiJS) layer. Same MSDF atlas + shader as {@link Text3D},
 *  rendered as a Pixi mesh under a Canvas2D. `fontSize` is in pixels. */
export const Text2D = trait({
  text: 'Text' as string,
  /** Font asset GUID (imported + baked). */
  font: '' as string,
  /** Pixels per em. */
  fontSize: 32 as number,
  color: 0xffffff as number,
  opacity: 1 as number,
  align: 'center' as string,
  /** Wrap width in px (0 = no wrap). */
  maxWidth: 0 as number,
  lineSpacing: 1 as number,
  letterSpacing: 0 as number,
  anchorX: 0.5 as number,
  anchorY: 0.5 as number,
  /** Faux-bold, in distance-field units — 0 = the glyph as drawn, useful range ~[0, 0.25].
   *  NOT resolution-independent (it bolds by `weight × pxRange / size` em) and NEGATIVE IS
   *  CLAMPED TO 0. For lighter text import a lighter weight. See MtsdfStyle.weight. */
  weight: 0 as number,
  outlineColor: 0x000000 as number,
  outlineWidth: 0 as number,
  outlineOpacity: 1 as number,
  /** Glow colour. WHITE, not black: with `glowStrength` also defaulting to 0 the glow
   *  was doubly inert — authoring `glowSize` alone produced nothing, and the first fix
   *  anyone tried (setting strength) produced a BLACK glow that is invisible on a dark
   *  background. No existing content depends on either default, because a glow was
   *  unreachable without setting both. */
  glowColor: 0xffffff as number,
  glowSize: 0 as number,
  /** Glow intensity multiplier. 1, not 0: the shader multiplies the glow by this, so a
   *  0 default made `glowSize` a knob that does nothing however far you turn it —
   *  reported as "glow does not work". `glowSize: 0` still means glow off, so this only
   *  affects entities that asked for a glow and got none. */
  glowStrength: 1 as number,
  shadowColor: 0x000000 as number,
  shadowOpacity: 0 as number,
  shadowOffsetX: 0.05 as number,
  shadowOffsetY: 0.05 as number,
  shadowSoftness: 0 as number,
  /** Draw order within the 2D layer (higher = in front). */
  orderInLayer: 0 as number,
  isVisible: true as boolean,
});
