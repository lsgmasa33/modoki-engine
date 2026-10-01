import { trait } from 'koota';

/** How a Frame2D box is fitted to what is on screen of its canvas. */
export type Frame2DFit = 'cover' | 'contain' | 'stretch';
export const FRAME_2D_FITS: readonly Frame2DFit[] = ['cover', 'contain', 'stretch'];

/** Frame2D — fit an entity's subtree to the part of its Canvas2D that is ON SCREEN: the 2D CameraFrame.
 *
 *  A Canvas2D maps its design resolution onto the screen (`scaleMode`), and on a phone of another shape part of
 *  that design space is cropped, or more of it shows. Art authored to fill "the screen" (a full-bleed backdrop, a
 *  parallax scene) then misses an edge on one phone and is cut on another. Put Frame2D on the entity holding it,
 *  directly under the canvas host. Author the subtree inside a `width` x `height` box whose top-left is the
 *  entity's local origin, and the engine scales and places that box so it:
 *  - `cover`: fills the visible area, cropping whichever axis is longer (no gaps, ever);
 *  - `contain`: fits wholly inside it, leaving bands;
 *  - `stretch`: matches it exactly, non-uniformly (do not rotate anything under a stretched frame).
 *  `alignX`/`alignY` pick which part stays when one axis is cropped or banded: 0 = left/top, 1 = right/bottom.
 *
 *  **The fit is applied, never authored** (`core/ecs/localFit2D.ts`): the entity's Transform keeps its authored
 *  values, and is composed INSIDE the fit (an offset/scale within the box). Every world-pose reader — rendering,
 *  picking, gizmos, physics, particles — sees the fitted pose. The visible area is the primary 2D renderer's
 *  (the Game view in the editor), and the canvas's reference rect when nothing renders (headless, tests). */
export const Frame2D = trait({
  width: 1080,
  height: 1920,
  fit: 'cover' as Frame2DFit,
  alignX: 0.5,
  alignY: 0.5,
});
