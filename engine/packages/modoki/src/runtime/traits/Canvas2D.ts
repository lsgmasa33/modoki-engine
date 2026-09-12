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
  /** Opt-in adaptive width — on a host WIDER than the design aspect, the design box
   *  may widen from `referenceWidth` up to this value (never past it). `0` (or any
   *  value <= `referenceWidth`) disables adaptation entirely and is the default, so
   *  every existing project is unaffected. It never shrinks the box below
   *  `referenceWidth`. Intended for `contain`/`fitH`, where a narrower-than-host box
   *  would otherwise pillarbox; past the cap the content letterboxes exactly as it
   *  does today. */
  maxReferenceWidth: 0 as number,
  /** Opt-in adaptive height — the vertical twin of `maxReferenceWidth` (#1087). On a host
   *  TALLER than the design aspect, the design box may grow from `referenceHeight` up to
   *  this value (never past it), turning the letterbox strip into addressable design space
   *  instead of dead pixels. `0` (or any value <= `referenceHeight`) disables it and is the
   *  default, so every existing project is unaffected.
   *
   *  ⚠️ **At most ONE axis ever adapts, and the two caps never interact.** A host is either
   *  wider than the design aspect or taller than it, never both, and each formula's lower
   *  clamp is what decides: on a wide host `referenceWidth / hostAspect <= referenceHeight`,
   *  so the height clamps back to its authored value, and vice versa. That is why the width
   *  is derived from the raw `referenceHeight` and the height from the raw `referenceWidth`
   *  — deriving either from the other's EFFECTIVE value would be mutually recursive, and
   *  there is no need.
   *
   *  ⚠️ **Under `contain` this does not change `scale` at all** on the host it targets, which
   *  is what makes it safe where the width half was not (#774 -> #806). Growing the height to
   *  `referenceWidth / hostAspect` makes `actualH / effectiveRefH === actualW / referenceWidth`,
   *  so the `contain` min is taken between two equal terms and lands exactly where it does
   *  today; past the cap the width term wins and it is unchanged again. Host-space chrome
   *  (`vmin`, safe-area insets) therefore cannot drift against design-space content the way it
   *  did when the box widened. Under `fitH` the scale DOES move — that mode keys off the height
   *  by definition. */
  maxReferenceHeight: 0 as number,
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
