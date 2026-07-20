/** The wire contract for `resolve-dom-point`, shared by the renderer that produces it
 *  (`domResolve.ts`) and the Electron main process that consumes it (`inputRoutes.ts`).
 *
 *  Types only, and DOM-free on purpose: the electron tsconfig has no `dom` lib, so main
 *  cannot import `domResolve.ts` (it references `document` and `Element`). Re-declaring
 *  the shape on each side would compile — and then silently drift the moment a field is
 *  added to one copy. This module is the single declaration both sides speak. */

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
}
