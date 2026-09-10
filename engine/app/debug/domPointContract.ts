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

/** **What the caller is about to DO at this point**, which the occlusion check needs in order to
 *  model how the runtime routes a press (#1016).
 *
 *  ⚠️ **A typed field, NOT `resolvePoint`'s `which` label.** `which` is prose for error messages —
 *  the pointer route passes `` `pointer ${action}` `` — so deriving intent from it would be
 *  string-matching a display string, the failure `docs/mcp-tool-conventions.md` §5 names
 *  ("classify structurally, never by message prefix") and the one `relayFailureStatus`'s scar is
 *  about. Two fields, because they answer two questions.
 *
 *  Only `'tap'` is CLICK-SHAPED, and the distinction is the whole point:
 *  - `tap` — press and release at one point, so #977's `minTapSize` redirect applies: an enlarged
 *    tap zone LOSES the press to real content underneath it.
 *  - `drag` — `modoki_drag`'s `from`/`to`, and `modoki_dnd`. The redirect requires press and
 *    release in the SAME zone (`runtime/ui/pressOrigin.ts`), which a drag never satisfies, so the
 *    zone really does take the gesture. Applying the redirect here would turn a correct refusal
 *    into a gesture that begins on the wrong element and reports success — §0's rank-1 failure,
 *    and the reason `75ba25601` was reverted.
 *  - `press` — a lone `modoki_pointer {action:'down'|'move'|'up'}`. No release pairs with it, so
 *    the redirect never runs.
 *  - `hover` / `scroll` — no press at all.
 *
 *  ⚠️ It has **no default** at the call sites. A default is what lets the next one silently inherit
 *  tap semantics, and `domDnd` is exactly the call site that must not. */
export type AimGesture = 'tap' | 'drag' | 'press' | 'hover' | 'scroll';

/** Does the runtime's click-time tap-zone redirect apply to this gesture? One predicate, so the
 *  renderer and any future caller cannot disagree about which gestures are click-shaped.
 *
 *  ⚠️ **ABSENT is NOT click-shaped, and getting this backwards is a false success.** The first
 *  version of this change read an absent gesture as `'tap'` and called that "the strictest
 *  reading". It is the opposite: the redirect can only ever turn `occluded: true` into
 *  `occluded: false` — it hands the press PAST the zone to real content — so treating an unknown
 *  intent as a tap REMOVES refusals. A caller that did not say what it was doing, reaching a
 *  renderer newer than itself (a stale main process over HMR, an `eval` body calling the op
 *  directly, a packaged main against a dev renderer), would have had its DRAG waved through and
 *  begun on the zone's host — §0's rank-1 failure, arriving by the exact back door the gesture
 *  split exists to close. Unknown intent therefore gets the STRICT answer: no redirect, so at
 *  worst a refusal the caller can override with `allowOccluded`. */
export function isClickShaped(gesture: AimGesture | undefined): boolean {
  return gesture === 'tap';
}

/** Where a point is: a CSS selector (resolves to the element's centre) or explicit
 *  viewport CSS coordinates. */
export interface DomPointSpec {
  selector?: string;
  x?: number;
  y?: number;
  /** What the caller will do here. Absent on the DnD path, which passes its gesture directly. */
  gesture?: AimGesture;
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
