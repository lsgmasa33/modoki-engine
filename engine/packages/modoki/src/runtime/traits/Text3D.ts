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
  /** Edge shift: >0 bolder, <0 thinner (~[-0.3, 0.3]). */
  weight: 0 as number,
  outlineColor: 0x000000 as number,
  /** Outline band width (~0..0.4). 0 = off. */
  outlineWidth: 0 as number,
  outlineOpacity: 1 as number,
  glowColor: 0x000000 as number,
  /** Glow spread (~0..0.4). 0 = off. */
  glowSize: 0 as number,
  glowStrength: 0 as number,
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
