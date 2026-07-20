/** canvas2DLayout — THE single, pure, DOM-free function that resolves where a 2D
 *  Canvas (and the content inside it) lands on screen, for a given device + panel.
 *
 *  This composes the whole chain that was previously scattered across GameView
 *  (device letterbox), UINode/flexbox (anchor placement), and SceneView's
 *  `computeCanvas2DRect` (DOM re-derivation). The editor outline, the runtime
 *  PixiJS render, and the unit tests all answer to THIS function so they can't
 *  drift. No `three`, no DOM, no `getBoundingClientRect` — just numbers.
 *
 *  Coordinate space: everything returned is in CSS px relative to the editor game
 *  area's top-left. Layout uses the LOGICAL device size (points); physical pixels
 *  (DPR) only affect render-buffer sharpness, never geometry — see devicePresets.ts.
 */

import { computeDeviceLetterbox } from './sceneViewMath';
import { resolveAnchorRect, resolveLengthPx, type AnchorData } from '../../runtime/ui/anchorLayout';
import { computeCanvasScale } from '../../runtime/rendering/canvas2DScaler';
import type { Canvas2DScaleMode } from '../../runtime/traits/Canvas2D';

export interface Rect { x: number; y: number; w: number; h: number }

/** UIElement size inputs relevant to layout (width/height + units + optional max). */
export interface UISizeSpec {
  width: number; widthUnit?: string;
  height: number; heightUnit?: string;
  maxWidth?: number; maxWidthUnit?: string;
  maxHeight?: number; maxHeightUnit?: string;
}

export interface Canvas2DSpec {
  referenceWidth: number;
  referenceHeight: number;
  scaleMode: Canvas2DScaleMode;
}

export interface Canvas2DLayout {
  /** The on-screen device frame (letterboxed into the panel). Free mode → whole panel. */
  deviceRect: Rect;
  /** Uniform device→screen scale (deviceRect.w / logical deviceW). */
  deviceScale: number;
  /** The Canvas2D's UIElement div, on-screen. */
  divRect: Rect;
  /** The reference-resolution content region after the scaleMode fit — what the
   *  editor outline traces and where the live PixiJS content actually lands. */
  contentRect: Rect;
  /** The scaler result (in div-local SCREEN px) used to map ref coords → screen. */
  scale: number;
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/** Resolve a UIElement length value + unit to LOGICAL pixels. Re-exports the shared
 *  resolver: `%` against `axisTotal` (the own axis); vw/vh/vmin/vmax against the
 *  logical device viewport (`vpW`/`vpH`); else px. */
export const resolveUnit = resolveLengthPx;

/** Resolve the canvas's UIElement size, in LOGICAL px, against the device viewport.
 *  A zero/absent dimension falls back to the full viewport extent (the runtime's
 *  "auto fills" behavior for a root canvas). */
export function resolveCanvasSize(ui: UISizeSpec, deviceW: number, deviceH: number): { w: number; h: number } {
  let w = resolveUnit(ui.width || 0, ui.widthUnit, deviceW, deviceW, deviceH);
  let h = resolveUnit(ui.height || 0, ui.heightUnit, deviceH, deviceW, deviceH);
  if (ui.maxWidth) w = Math.min(w, resolveUnit(ui.maxWidth, ui.maxWidthUnit || 'px', deviceW, deviceW, deviceH));
  if (ui.maxHeight) h = Math.min(h, resolveUnit(ui.maxHeight, ui.maxHeightUnit || 'px', deviceH, deviceW, deviceH));
  if (w <= 0) w = deviceW;
  if (h <= 0) h = deviceH;
  return { w, h };
}

/**
 * Resolve the full on-screen layout of a 2D Canvas.
 *
 * @param deviceW  Logical device width (points). 0 → Free mode (canvas viewport = panel).
 * @param deviceH  Logical device height (points).
 * @param panelW   Editor game-area width (CSS px).
 * @param panelH   Editor game-area height (CSS px).
 * @param ui       The canvas UIElement's size spec.
 * @param anchor   The canvas UIAnchor (null → top-left, unanchored).
 * @param canvas   The Canvas2D reference resolution + scale mode.
 */
export function computeCanvas2DLayout(
  deviceW: number,
  deviceH: number,
  panelW: number,
  panelH: number,
  ui: UISizeSpec,
  anchor: AnchorData | null,
  canvas: Canvas2DSpec,
): Canvas2DLayout {
  // 1) Device frame on screen + uniform device→screen scale.
  //    Free mode (deviceW/H = 0): the canvas viewport IS the panel, scale 1.
  const free = deviceW <= 0 || deviceH <= 0;
  const vpW = free ? panelW : deviceW;       // logical viewport for layout
  const vpH = free ? panelH : deviceH;
  const deviceRect: Rect = free
    ? { x: 0, y: 0, w: panelW, h: panelH }
    : (() => {
        const r = computeDeviceLetterbox(panelW, panelH, deviceW, deviceH);
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      })();
  const deviceScale = vpW > 0 ? deviceRect.w / vpW : 1;

  // 2) Canvas UIElement size + anchor placement, in LOGICAL px within the viewport.
  const { w: logW, h: logH } = resolveCanvasSize(ui, vpW, vpH);
  const anchored = anchor
    ? resolveAnchorRect(logW, logH, vpW, vpH, anchor)
    : { x: 0, y: 0, w: logW, h: logH };

  // 3) Map the div to screen px (device origin + logical × deviceScale).
  const divRect: Rect = {
    x: deviceRect.x + anchored.x * deviceScale,
    y: deviceRect.y + anchored.y * deviceScale,
    w: anchored.w * deviceScale,
    h: anchored.h * deviceScale,
  };

  // 4) Fit the reference resolution inside the div → content region (screen px).
  const refW = canvas.referenceWidth || 1;
  const refH = canvas.referenceHeight || 1;
  const cs = computeCanvasScale(refW, refH, divRect.w, divRect.h, canvas.scaleMode);
  const contentRect: Rect = {
    x: divRect.x + cs.offsetX,
    y: divRect.y + cs.offsetY,
    w: refW * cs.scaleX,
    h: refH * cs.scaleY,
  };

  return {
    deviceRect,
    deviceScale,
    divRect,
    contentRect,
    scale: cs.scale,
    scaleX: cs.scaleX,
    scaleY: cs.scaleY,
    offsetX: cs.offsetX,
    offsetY: cs.offsetY,
  };
}
