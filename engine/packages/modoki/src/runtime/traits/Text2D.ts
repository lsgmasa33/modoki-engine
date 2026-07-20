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
  weight: 0 as number,
  outlineColor: 0x000000 as number,
  outlineWidth: 0 as number,
  outlineOpacity: 1 as number,
  glowColor: 0x000000 as number,
  glowSize: 0 as number,
  glowStrength: 0 as number,
  shadowColor: 0x000000 as number,
  shadowOpacity: 0 as number,
  shadowOffsetX: 0.05 as number,
  shadowOffsetY: 0.05 as number,
  shadowSoftness: 0 as number,
  /** Draw order within the 2D layer (higher = in front). */
  orderInLayer: 0 as number,
  isVisible: true as boolean,
});
