/** Marquee (box) selection geometry + policy for the 2D viewport.
 *
 *  Extracted from `SceneView.tsx` (#105 Phase 2). The panel keeps the parts that
 *  are genuinely impure — the DOM rubber-band element, the client→game coordinate
 *  mapping, and the ECS query that yields candidates — and calls these for every
 *  decision. Before this, reaching any of it meant driving a real pointer drag
 *  through a mounted viewport, so none of it was unit-tested.
 *
 *  The threshold is the part most worth pinning: below it a Shift+drag is treated
 *  as a Shift+CLICK and the marquee is abandoned, which is what PRESERVES an
 *  existing selection. Lower it and a shaky click silently replaces the user's
 *  multi-selection with one entity. */

/** Client-space travel, in px, before a Shift+drag becomes a marquee rather than a
 *  click. Strictly greater-than: exactly 4px is still a click. */
export const MARQUEE_DRAG_THRESHOLD_PX = 4;

export interface MarqueeRect {
  minX: number; maxX: number; minY: number; maxY: number;
}

/** Has the drag travelled far enough to BE a marquee? */
export function marqueeExceededThreshold(x0: number, y0: number, x: number, y: number): boolean {
  return Math.hypot(x - x0, y - y0) > MARQUEE_DRAG_THRESHOLD_PX;
}

/** The rubber-band overlay's client-space box. Drag direction is irrelevant — a
 *  right-to-left or bottom-to-top drag yields the same positive-extent rect. */
export function marqueeOverlayBox(x0: number, y0: number, x: number, y: number): { left: number; top: number; width: number; height: number } {
  return {
    left: Math.min(x0, x),
    top: Math.min(y0, y),
    width: Math.abs(x - x0),
    height: Math.abs(y - y0),
  };
}

/** Normalize two opposite corners (already mapped into game/reference space) into
 *  a min/max rect, so the enclosure test never has to care which way the drag went. */
export function marqueeRect(a: { x: number; y: number }, b: { x: number; y: number }): MarqueeRect {
  return {
    minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
  };
}

/** One entity the marquee could enclose, already resolved to world/game space by
 *  the caller (the ECS query lives in the panel). */
export interface MarqueeCandidate {
  id: number;
  x: number;
  y: number;
  /** `Renderable2D.isVisible` — an invisible entity is not box-selectable. */
  visible: boolean;
  /** The Canvas2D this entity routes under, via `findCanvasAncestor`. */
  canvasId: number | null;
}

/** Which candidates the box encloses.
 *
 *  Containment is INCLUSIVE on all four edges — an entity exactly on the boundary
 *  is caught, matching the user's expectation that a box drawn "up to" something
 *  takes it.
 *
 *  Three things disqualify a candidate: it is hidden, it is deactivated, or it
 *  belongs to a DIFFERENT canvas than the one being edited. The last matters most
 *  — without it a marquee in one canvas silently selects overlapping entities from
 *  another, which is invisible until the user moves them. */
export function enclosedByMarquee(
  candidates: ReadonlyArray<MarqueeCandidate>,
  rect: MarqueeRect,
  deactivated: ReadonlySet<number>,
  canvasEntityId: number | null,
): number[] {
  const inside: number[] = [];
  for (const c of candidates) {
    if (!c.visible || deactivated.has(c.id)) continue;
    if (c.canvasId !== canvasEntityId) continue;
    if (c.x >= rect.minX && c.x <= rect.maxX && c.y >= rect.minY && c.y <= rect.maxY) inside.push(c.id);
  }
  return inside;
}

/** Fold the enclosed set into the existing selection.
 *
 *  A marquee ADDS (it is Shift+drag), it never replaces — and an empty result is
 *  `null` rather than an empty selection, so dragging a box over nothing leaves
 *  what the user already had. The primary becomes the LAST enclosed entity, which
 *  is what the Inspector then shows. */
export function mergeMarqueeSelection(
  current: ReadonlyArray<number>,
  inside: ReadonlyArray<number>,
): { ids: number[]; primary: number } | null {
  if (inside.length === 0) return null;
  return {
    ids: Array.from(new Set([...current, ...inside])),
    primary: inside[inside.length - 1],
  };
}
