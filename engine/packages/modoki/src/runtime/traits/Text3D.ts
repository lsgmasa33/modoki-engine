import { trait } from 'koota';

/** In-world SDF text (Three.js layer). Renders a glyph mesh from a baked/dynamic
 *  MSDF font atlas — crisp at any scale, with outline/glow/weight effects. Font is
 *  a GUID ref to an imported `.ttf`/`.otf` (baked via the Font Inspector). */
export const Text3D = trait({
  text: 'Text' as string,
  /** Font asset GUID (imported + baked). */
  font: '' as string,
  /** World units per em. */
  fontSize: 1 as number,
  color: 0xffffff as number,
  /** 0..1 overall opacity. */
  opacity: 1 as number,
  /** left | center | right. */
  align: 'center' as string,
  /** Wrap width in world units (0 = no wrap). */
  maxWidth: 0 as number,
  /** Multiplier on the font's line height. */
  lineSpacing: 1 as number,
  /** Extra tracking per glyph, in world units. */
  letterSpacing: 0 as number,
  /** Horizontal anchor of the text block on the entity origin (0 left, 0.5 center, 1 right). */
  anchorX: 0.5 as number,
  /** Vertical anchor (0 top, 0.5 middle, 1 bottom). */
  anchorY: 0.5 as number,
  /** Faux-bold, in distance-field units — 0 = the glyph as drawn, useful range ~[0, 0.25].
   *  NOT resolution-independent (it bolds by `weight × pxRange / size` em) and NEGATIVE IS
   *  CLAMPED TO 0. For lighter text import a lighter weight. See MtsdfStyle.weight. */
  weight: 0 as number,
  outlineColor: 0x000000 as number,
  /** Outline band width (~0..0.4). 0 = off. */
  outlineWidth: 0 as number,
  outlineOpacity: 1 as number,
  /** Glow colour. WHITE, not black: with `glowStrength` also defaulting to 0 the glow
   *  was doubly inert — authoring `glowSize` alone produced nothing, and the first fix
   *  anyone tried (setting strength) produced a BLACK glow that is invisible on a dark
   *  background. No existing content depends on either default, because a glow was
   *  unreachable without setting both. */
  glowColor: 0xffffff as number,
  /** Glow spread (~0..0.4). 0 = off. */
  glowSize: 0 as number,
  /** Glow intensity multiplier. 1, not 0: the shader multiplies the glow by this, so a
   *  0 default made `glowSize` a knob that does nothing however far you turn it —
   *  reported as "glow does not work". `glowSize: 0` still means glow off, so this only
   *  affects entities that asked for a glow and got none. */
  glowStrength: 1 as number,
  shadowColor: 0x000000 as number,
  /** Drop-shadow opacity. 0 = off. */
  shadowOpacity: 0 as number,
  /** Shadow offset in em (+x right, +y down). */
  shadowOffsetX: 0.05 as number,
  shadowOffsetY: 0.05 as number,
  /** Shadow edge softness (~0..0.4). 0 = crisp. */
  shadowSoftness: 0 as number,
  /** Face the camera (screen-aligned label). */
  billboard: false as boolean,
  isVisible: true as boolean,
});
