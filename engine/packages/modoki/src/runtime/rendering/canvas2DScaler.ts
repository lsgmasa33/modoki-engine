/** canvas2DScaler — computes the scale + offset to map a design-resolution
 *  coordinate space onto an actual canvas size. */

import type { Canvas2DScaleMode } from '../traits/Canvas2D';
import { warnVocabOnce } from '../core/warnVocab';

export interface CanvasScale {
  /** Uniform scale (min of scaleX, scaleY) — used for object shapes */
  scale: number;
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  /** Shape compensation: multiply object scaleX by this to undo non-uniform stretch */
  compensateX: number;
  /** Shape compensation: multiply object scaleY by this to undo non-uniform stretch */
  compensateY: number;
}

/** Compute scale and centering offset for a Canvas2D.
 *  @param refW   Design resolution width
 *  @param refH   Design resolution height
 *  @param actualW  Actual canvas pixel width
 *  @param actualH  Actual canvas pixel height
 *  @param mode   'fitW' | 'fitH' | 'fill' | 'none' */
export function computeCanvasScale(
  refW: number, refH: number,
  actualW: number, actualH: number,
  mode: Canvas2DScaleMode,
): CanvasScale {
  if (refW <= 0 || refH <= 0 || actualW <= 0 || actualH <= 0) {
    return { scale: 1, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, compensateX: 1, compensateY: 1 };
  }

  let scaleX: number;
  let scaleY: number;
  switch (mode) {
    case 'fitW': {
      // Match width exactly — may crop or letterbox vertically
      const s = actualW / refW;
      scaleX = s;
      scaleY = s;
      break;
    }
    case 'fitH': {
      // Match height exactly — may crop or letterbox horizontally
      const s = actualH / refH;
      scaleX = s;
      scaleY = s;
      break;
    }
    case 'contain': {
      // Uniform scale to fit the reference ENTIRELY inside — letterboxes the
      // axis with the larger reference extent.
      const s = Math.min(actualW / refW, actualH / refH);
      scaleX = s;
      scaleY = s;
      break;
    }
    case 'cover': {
      // Uniform scale to COVER the canvas — the overflowing axis is cropped.
      const s = Math.max(actualW / refW, actualH / refH);
      scaleX = s;
      scaleY = s;
      break;
    }
    case 'fill':
      // Non-uniform: stretch to fill canvas exactly (no cropping, no letterbox)
      scaleX = actualW / refW;
      scaleY = actualH / refH;
      break;
    case 'none':
      scaleX = 1;
      scaleY = 1;
      break;
    default:
      warnVocabOnce('canvas2D', 'Canvas2D.scaleMode', mode, "treated as 'none' (1:1)");
      scaleX = 1;
      scaleY = 1;
      break;
  }

  // Center on both axes for every mode. `none` (1:1 pixels) is centered too — a
  // reference region smaller than the canvas sits in the middle, not the top-left
  // corner (matches the Canvas2D trait doc "none = 1:1 pixels, centered"). `fill`
  // covers exactly so the offsets resolve to 0.
  const offsetX = (actualW - refW * scaleX) / 2;
  const offsetY = (actualH - refH * scaleY) / 2;
  // Uniform scale for object shapes — use the smaller axis
  const scale = Math.min(scaleX, scaleY);
  // Compensation: undo the non-uniform stretch so shapes stay uniform
  const compensateX = scale / scaleX;
  const compensateY = scale / scaleY;

  return { scale, scaleX, scaleY, offsetX, offsetY, compensateX, compensateY };
}

/** Client (CSS) coords → canvas rendering-space px (the space `computeCanvasScale`'s
 *  container transform, and PixiJS `getBounds()`, both operate in — NOT the backing
 *  pixel size when a project pins `resolution` > 0 with autoDensity; see
 *  `referenceToScreen2D`/`canvasPxToClient`, the paired inverse). Factored out of
 *  `screenToReference2D` so bounds reporting can share the exact same client↔canvas-px
 *  half without re-deriving it (a divergent re-derivation was the coordinate-space bug
 *  behind Court's 2D drag-aim misses — see docs/rendering.md's Canvas2D section). */
export function clientToCanvasPx(
  clientX: number, clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  backingW: number, backingH: number,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: ((clientX - rect.left) / rect.width) * backingW,
    y: ((clientY - rect.top) / rect.height) * backingH,
  };
}

/** Inverse of `clientToCanvasPx`: canvas rendering-space px → client (CSS) coords. */
export function canvasPxToClient(
  pxX: number, pxY: number,
  rect: { left: number; top: number; width: number; height: number },
  backingW: number, backingH: number,
): { x: number; y: number } {
  if (backingW <= 0 || backingH <= 0) return { x: rect.left, y: rect.top };
  return {
    x: rect.left + (pxX / backingW) * rect.width,
    y: rect.top + (pxY / backingH) * rect.height,
  };
}

/** Invert a canvas-2D hit: client (CSS) coords → the Canvas2D's reference space.
 *  This is the inverse of `computeCanvasScale`'s forward mapping and the shared coord math
 *  behind 2D picking (`toGame`). Renderer-independent so the DOM SceneView layer and the Pixi
 *  pick overlay both pick identically: DOM feeds the live `<canvas>` backing size; Pixi feeds the
 *  pooled Pixi canvas backing size — the `rect`/`backing`/`cs` inputs are all that differ.
 *  @param rect     the target element's on-screen rect (already includes viewport zoom transform)
 *  @param backingW canvas backing pixel width; @param backingH backing pixel height
 *  @param cs       the scale from computeCanvasScale for this canvas */
export function screenToReference2D(
  clientX: number, clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  backingW: number, backingH: number,
  cs: CanvasScale,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0 || cs.scaleX === 0 || cs.scaleY === 0) return { x: 0, y: 0 };
  const { x: pxX, y: pxY } = clientToCanvasPx(clientX, clientY, rect, backingW, backingH);
  return {
    x: (pxX - cs.offsetX) / cs.scaleX,
    y: (pxY - cs.offsetY) / cs.scaleY,
  };
}

/** Invert `screenToReference2D`: a Canvas2D reference-space (design) coordinate →
 *  client (CSS) coords. The forward twin agents need to AIM at a design-space point
 *  (e.g. a game's own layout data) without hand-rolling the design→CSS fit transform —
 *  see docs/rendering.md's Canvas2D section. Shares
 *  `canvasPxToClient` with `bounds2DProvider` (`Scene2D.tsx`) so both directions and
 *  the bounds report agree by construction, not by re-derivation. */
export function referenceToScreen2D(
  refX: number, refY: number,
  rect: { left: number; top: number; width: number; height: number },
  backingW: number, backingH: number,
  cs: CanvasScale,
): { x: number; y: number } {
  const pxX = refX * cs.scaleX + cs.offsetX;
  const pxY = refY * cs.scaleY + cs.offsetY;
  return canvasPxToClient(pxX, pxY, rect, backingW, backingH);
}

/** One-call convenience for game code: a Canvas2D host's own `<canvas>` + its design
 *  resolution/scale mode → a client point's design-space coordinate, or null if the
 *  canvas is gone/degenerate. Wraps `computeCanvasScale` + `screenToReference2D` so a
 *  game never has to hand-roll the fit-mode math itself (a hand-rolled copy is exactly
 *  what silently drifts from the engine the day the Canvas2D trait is edited — see
 *  docs/rendering.md's Canvas2D section). Pair: `designToClient2D`. */
export function clientToDesign2D(
  canvas: HTMLCanvasElement,
  clientX: number, clientY: number,
  refW: number, refH: number, mode: Canvas2DScaleMode,
): { x: number; y: number } | null {
  if (!canvas.isConnected) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) return null;
  const cs = computeCanvasScale(refW, refH, canvas.width, canvas.height, mode);
  return screenToReference2D(clientX, clientY, rect, canvas.width, canvas.height, cs);
}

/** Inverse of `clientToDesign2D`: a design-space point on a Canvas2D host → client
 *  (CSS) coords, for an agent aiming at a game's own layout data (e.g. a cell center)
 *  without re-deriving the fit-mode math. */
export function designToClient2D(
  canvas: HTMLCanvasElement,
  refX: number, refY: number,
  refW: number, refH: number, mode: Canvas2DScaleMode,
): { x: number; y: number } | null {
  if (!canvas.isConnected) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) return null;
  const cs = computeCanvasScale(refW, refH, canvas.width, canvas.height, mode);
  return referenceToScreen2D(refX, refY, rect, canvas.width, canvas.height, cs);
}
