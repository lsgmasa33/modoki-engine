/**
 * Frame2D, applied: the local-fit provider (`core/ecs/localFit2D.ts`) that fits each `Frame2D` entity's box to the
 * visible part of its canvas, and the pure fit math. The visible part comes from the primary Scene2D
 * (`publishCanvasView2D`); without one (headless), it is the canvas's reference rect.
 */
import type { Entity, World } from 'koota';

import { setLocalFit2DProvider, localFit2DOf, type LocalFit2D } from '../core/ecs/localFit2D';
import { onWorldSwap } from '../core/ecs/worldRegistry';
import { Canvas2D } from '../traits/Canvas2D';
import { EntityAttributes } from '../core/traits/EntityAttributes';
import { Frame2D, type Frame2DFit } from '../traits/Frame2D';
import type { CanvasScale } from './canvas2DScaler';

/** A design-space rect, edges inclusive of nothing in particular: left/top/right/bottom. */
export interface DesignRect { left: number; top: number; right: number; bottom: number }

/** The part of a canvas's design space that is on screen, given its scale (`computeCanvasScale`) and its actual
 *  size: wider than the reference when it letterboxes, narrower when it crops. Pure. */
export function visibleDesignRect(s: Pick<CanvasScale, 'scaleX' | 'scaleY' | 'offsetX' | 'offsetY'>, actualW: number, actualH: number): DesignRect {
  return {
    left: -s.offsetX / s.scaleX,
    top: -s.offsetY / s.scaleY,
    right: (actualW - s.offsetX) / s.scaleX,
    bottom: (actualH - s.offsetY) / s.scaleY,
  };
}

/** The fit that puts a `w` x `h` box (top-left at local 0,0) onto `view`. Pure. A degenerate box or view is the
 *  identity, so a half-authored frame never collapses its subtree. */
export function frame2DFit(view: DesignRect, w: number, h: number, fit: Frame2DFit, alignX = 0.5, alignY = 0.5): LocalFit2D {
  const vw = view.right - view.left, vh = view.bottom - view.top;
  if (!(w > 0 && h > 0 && vw > 0 && vh > 0)) return { x: 0, y: 0, kx: 1, ky: 1 };
  let kx: number, ky: number;
  if (fit === 'stretch') { kx = vw / w; ky = vh / h; }
  else { kx = ky = fit === 'contain' ? Math.min(vw / w, vh / h) : Math.max(vw / w, vh / h); }
  return { x: view.left + (vw - w * kx) * alignX, y: view.top + (vh - h * ky) * alignY, kx, ky };
}

// ── The visible rect of each canvas as the primary renderer last drew it, by PACKED canvas entity
//    (`entity.valueOf()`), so a canvas that recycles a dead one's index never inherits its rect. ──
const views = new Map<number, DesignRect>();

/** The primary Scene2D, each frame, for each canvas. Returns whether it changed. */
export function publishCanvasView2D(canvas: Entity, r: DesignRect): boolean {
  const key = canvas.valueOf() as number;
  const p = views.get(key);
  if (p && p.left === r.left && p.top === r.top && p.right === r.right && p.bottom === r.bottom) return false;
  views.set(key, { ...r });
  return true;
}

/** Drop every canvas's visible rect (nothing draws any more). */
export function forgetCanvasView2D(): void {
  views.clear();
}

/** What is on screen of a canvas, in its design space: as last drawn, or its reference rect. */
export function canvasView2D(canvas: Entity): DesignRect | null {
  const v = views.get(canvas.valueOf() as number);
  if (v) return v;
  const c = canvas.get(Canvas2D);
  return c ? { left: 0, top: 0, right: c.referenceWidth || 1080, bottom: c.referenceHeight || 1920 } : null;
}

/** This pass's fits, and the visible rect each was made for, by PACKED Frame2D entity (localFit2D.ts's key). `fits`
 *  and `spare` swap every pass, so the last pass's fits are still there to compare against. */
let fits = new Map<number, LocalFit2D>();
let spare = new Map<number, LocalFit2D>();
const fittedTo = new Map<number, DesignRect>();
/** Bumped by every pass whose fits differ from the last pass's (a resize, the view forgotten, a Frame2D added or
 *  gone). A fit change writes no trait, so this is how every Scene2D (the Game view's and the editor SceneView's)
 *  learns its idle frame is owed a draw. */
let fitEpoch = 0;
/** Scratch: this pass's canvases by id, to resolve a parent id. */
const canvasById = new Map<number, Entity>();
/** Frame2D entities already warned about sitting below a canvas's direct children (packed key). */
const warnedNested = new Set<number>();

/** The fit epoch: changes whenever a propagation pass fitted anything differently from the pass before. */
export function frame2DFitEpoch(): number {
  return fitEpoch;
}

function sameFits(a: ReadonlyMap<number, LocalFit2D>, b: ReadonlyMap<number, LocalFit2D>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, f] of a) {
    const g = b.get(k);
    if (!g || g.x !== f.x || g.y !== f.y || g.kx !== f.kx || g.ky !== f.ky) return false;
  }
  return true;
}

function provide(world: World, parentOf: ReadonlyMap<number, number>): ReadonlyMap<number, LocalFit2D> | null {
  fittedTo.clear();
  const frames = world.query(Frame2D);
  if (!frames.length) {
    if (fits.size) { fits.clear(); fitEpoch++; }
    return null;
  }
  const next = spare;
  next.clear();
  canvasById.clear();
  for (const e of world.query(Canvas2D)) canvasById.set(e.id(), e);
  for (const e of frames) {
    // Its canvas: its PARENT, and only that. The fit is made in the canvas's design space and applied in the
    // parent's, so a Frame2D under a moved or scaled group would land off by that group's pose: refuse it, once.
    const canvas = canvasById.get(parentOf.get(e.id()) ?? 0);
    const key = e.valueOf() as number;
    if (!canvas) {
      if (underACanvas(e.id(), parentOf) && !warnedNested.has(key)) {
        warnedNested.add(key);
        console.warn(`[Frame2D] "${e.get(EntityAttributes)?.name ?? e.id()}" is not a direct child of its Canvas2D, so it is not fitted. Move it directly under the canvas.`);
      }
      continue;
    }
    const view = canvasView2D(canvas);
    if (!view) continue;
    const f = e.get(Frame2D)!;
    next.set(key, frame2DFit(view, f.width, f.height, f.fit, f.alignX, f.alignY));
    fittedTo.set(key, view);
  }
  canvasById.clear();
  if (!sameFits(next, fits)) fitEpoch++;
  spare = fits;
  fits = next;
  return fits;
}

/** Whether a Canvas2D is anywhere up the entity's parent chain (depth-capped against a cycle). */
function underACanvas(id: number, parentOf: ReadonlyMap<number, number>): boolean {
  let p = parentOf.get(id) ?? 0;
  for (let d = 0; p && d < 64; d++) {
    if (canvasById.has(p)) return true;
    p = parentOf.get(p) ?? 0;
  }
  return false;
}

setLocalFit2DProvider(provide);
onWorldSwap(() => { views.clear(); fittedTo.clear(); warnedNested.clear(); fits.clear(); spare.clear(); fitEpoch++; });

/** What is on screen of a Frame2D entity's canvas, in the entity's OWN (box) space: where a game places things
 *  that should reach the screen's edges. Null until a propagation pass has fitted it. */
export function frame2DVisibleLocal(frame: Entity): DesignRect | null {
  const fit = localFit2DOf(frame.valueOf() as number);
  const view = fittedTo.get(frame.valueOf() as number);
  if (!fit || !view) return null;
  return {
    left: (view.left - fit.x) / fit.kx, right: (view.right - fit.x) / fit.kx,
    top: (view.top - fit.y) / fit.ky, bottom: (view.bottom - fit.y) / fit.ky,
  };
}

/** A point in the canvas's design space, in a Frame2D entity's own space; null when it has no fit. */
export function designToFrame2D(frame: Entity, x: number, y: number): { x: number; y: number } | null {
  const fit = localFit2DOf(frame.valueOf() as number);
  return fit ? { x: (x - fit.x) / fit.kx, y: (y - fit.y) / fit.ky } : null;
}
