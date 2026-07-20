import { trait } from 'koota';

/** Scale mode for Canvas2D. */
export type Canvas2DScaleMode = 'fitW' | 'fitH' | 'fill' | 'none' | 'contain' | 'cover';

/** Canvas2D — marks a UIElement as hosting a 2D PixiJS canvas.
 *  The entity must also have RenderableUI + UIElement (for DOM positioning).
 *  Child entities with Renderable2D are rendered into this canvas. */
export const Canvas2D = trait({
  /** Design resolution width — game content is authored at this width. */
  referenceWidth: 1080 as number,
  /** Design resolution height — game content is authored at this height. */
  referenceHeight: 1920 as number,
  /** How to scale content to fit the actual canvas size (all modes center the
   *  content; only `fill` is non-uniform).
   *  fitW    = match width exactly (the other axis may crop or letterbox)
   *  fitH    = match height exactly (the other axis may crop or letterbox)
   *  contain = uniform scale to fit ENTIRELY inside (letterboxes the excess axis)
   *  cover   = uniform scale to COVER the area (crops the overflowing axis)
   *  fill    = stretch non-uniformly to fill exactly (no crop, no letterbox)
   *  none    = 1:1 pixels, centered */
  scaleMode: 'fitH' as Canvas2DScaleMode,
});
