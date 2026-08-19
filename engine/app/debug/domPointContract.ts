/** The wire contract for `resolve-dom-point`, shared by the renderer that produces it
 *  (`domResolve.ts`) and the Electron main process that consumes it (`inputRoutes.ts`).
 *
 *  Types only, and DOM-free on purpose: the electron tsconfig has no `dom` lib, so main
 *  cannot import `domResolve.ts` (it references `document` and `Element`). Re-declaring
 *  the shape on each side would compile — and then silently drift the moment a field is
 *  added to one copy. This module is the single declaration both sides speak. */

/** What `hitTarget` says when the hit-test found NO element at all — the point is clipped away or
 *  past the window edge. Lives HERE, in the DOM-free contract, because both sides need it as a
 *  VALUE: the renderer produces it and main's refusal messages branch on it ("dismiss what covers
 *  it" is unactionable advice when the answer is "nothing"). Importing it from `domResolve.ts`
 *  would drag `document`/`Element` into the electron program, which has no `dom` lib — the exact
 *  reason this module exists. */
export const NOTHING_AT_POINT = 'nothing (clipped or off-window)';

/** Where a point is: a CSS selector (resolves to the element's centre) or explicit
 *  viewport CSS coordinates. */
export interface DomPointSpec {
  selector?: string;
  x?: number;
  y?: number;
}

/** An element's box in viewport CSS px, origin top-left. Named to avoid colliding with the
 *  DOM's own `DOMRect` (which this module cannot reference — see the header). */
export interface DomRect {
  x: number; y: number; w: number; h: number;
}

export interface DomPointResolution {
  ok: boolean;
  /** Present when `ok` is false — why the selector could not be aimed at. */
  error?: string;
  x?: number;
  y?: number;
  /** Descriptor of the element the selector matched (absent for a coordinate spec). */
  matched?: string | null;
  /** Descriptor of the TOPMOST element at (x,y) — who will actually receive the click. */
  hitTarget?: string | null;
  /** True when `hitTarget` is neither the matched element nor a descendant of it, i.e.
   *  something is covering the target and a trusted click there would hit the wrong
   *  thing. Measured AT RESOLUTION TIME, a few ms before the dispatch that follows —
   *  far tighter than a separate query, but not atomic with the click. Undefined for a
   *  coordinate spec (nothing to compare against). */
  occluded?: boolean;
  /** Present (`true`) only when the target is occluded BECAUSE it is scrolled out of its own
   *  clipping container — the rect is real but nothing is drawn there, so the point lands on the
   *  chrome behind it. Distinguishes "scroll it into view" from "dismiss what covers it", which
   *  the covering element's name alone cannot: it is usually an anonymous splitter or panel div. */
  clipped?: true;
}
