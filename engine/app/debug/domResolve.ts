/** DOM point resolution — turn a CSS selector into viewport CSS coordinates, and
 *  report what is actually AT those coordinates (Enact: selector-aware input).
 *
 *  Two callers, one resolver:
 *    - `domDnd.ts` needs the Element (to dispatch DnD events on it) → `resolveDomPoint`.
 *    - The trusted-input host routes need only a point, resolved in the RENDERER and
 *      handed back to main → `resolveDomPointReport` (serializable, never throws).
 *
 *  Why resolve server-side rather than have the agent query-then-tap: a tap issued from
 *  coordinates read in an earlier round-trip races anything that moved in between — a
 *  camera orbit, a re-render, a scroll. `tap-handle` already resolves inside the same
 *  call for that reason; this extends it to CSS selectors.
 *
 *  `hitTarget` is the load-bearing part. Chromium hit-tests a trusted click by
 *  coordinate, so dispatching at an element's center does NOT guarantee the element
 *  receives it — an overlay (or the element's own open menu) can sit on top. Reporting
 *  the topmost element at the point turns that silent miss into data: `occluded: true`
 *  plus the name of whatever covered it, with no screenshot. */

import type { DomPointSpec, DomPointResolution, DomRect } from './domPointContract';

// Re-exported so existing importers (domDnd, agentBridge) keep one import site.
export type { DomPointSpec, DomPointResolution, DomRect } from './domPointContract';
// The "nothing is at this point" sentinel lives in the DOM-free contract so the Electron main
// process can import it as a value too — see its declaration there.
export { NOTHING_AT_POINT } from './domPointContract';
import { NOTHING_AT_POINT } from './domPointContract';

export interface DomPointHit {
  el: Element;
  x: number;
  y: number;
}

/** A short, human-readable identifier for an element — enough to tell "the button" from
 *  "the menu that covered it" in a one-line result. Prefers the Enact tagging attribute,
 *  then `id`, then the first couple of classes. */
export function describeElement(el: Element | null | undefined): string | null {
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const uiId = el.getAttribute('data-ui-id');
  if (uiId) return `${tag}[data-ui-id="${uiId}"]`;
  if (el.id) return `${tag}#${el.id}`;
  // SVG elements expose className as an SVGAnimatedString, not a string.
  const cls = typeof el.className === 'string' ? el.className.trim() : '';
  if (cls) return tag + '.' + cls.split(/\s+/).slice(0, 2).join('.');
  // `title` before the bare tag: the editor's chrome is full of style-only divs that carry a
  // human-readable title and nothing else, and those are exactly the ones that end up COVERING
  // something. Measured 2026-08-19: a tap at a game-ui entity while the sim is stopped is refused
  // as "covered by div inside div.flexlayout__tab_moveable" — true, and useless. The cover is the
  // Game panel's stopped-state shield, whose own title says what to do about it: "Press Play to
  // run the game and interact with its UI". Naming it turns the refusal into its own remedy.
  const title = el.getAttribute('title');
  if (title) return `${tag}[title="${title.length > 80 ? `${title.slice(0, 77)}…` : title}"]`;
  return tag;
}

/** Resolve a live ELEMENT to its aim point + rect. The narrowest core: everything that
 *  turns a DOM element into something you can click goes through here — selector input,
 *  DnD, and the chrome handle provider alike. Keeping it single is a deliberate constraint
 *  (see `docs/enact.md`): the zero-rect guard once existed on one of two
 *  resolvers, and the one without it dropped a DnD at the window's top-left corner. */
export function resolveElementPoint(el: Element): { x: number; y: number; rect: DomRect } | { error: string } {
  const r = el.getBoundingClientRect();
  // A display:none / detached element reports an all-zero rect. Aiming at its "centre"
  // would silently act on the top-left corner of the window — a wrong click (or a wrong
  // DROP) that looks exactly like a successful one. Refuse instead.
  if (r.width === 0 && r.height === 0) {
    return { error: 'has a zero-size rect (hidden or not laid out) — nothing to aim at' };
  }
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    rect: { x: r.left, y: r.top, w: r.width, h: r.height },
  };
}

/** Is `top` (the topmost element at a point) the target `el` or something inside it? A
 *  descendant is NOT occlusion — the event bubbles, so the target's handler still runs. */
export function isOccluded(el: Element, top: Element | null): boolean {
  return !(top && (top === el || el.contains(top)));
}

/** The visible clip box an element's own contents are confined to — the intersection of every
 *  SCROLLING/CLIPPING ancestor's rect — or null when nothing above it clips.
 *
 *  Why this exists: `getBoundingClientRect()` on a descendant of an `overflow:hidden` box
 *  reports the descendant's LAID-OUT position, which is correct DOM behaviour and completely
 *  ignores the clip. So a gradient stop sitting 800px down a docked panel's un-scrolled
 *  content flow reports a y that is inside the WINDOW but hundreds of pixels below its own
 *  panel — over whatever other panel occupies those pixels. Judging "is this aimable?" against
 *  the viewport alone therefore answers yes for a handle that is not on screen at all
 *  (testboard AceYUBoBXbcGtIIFmzGb: a right-click aimed at such a handle opened the Assets
 *  panel's context menu instead).
 *
 *  Approximates the CSS clipping rules where they are cheap and honest: an `overflow`
 *  computed to anything but `visible` clips its descendants, and a `position:fixed` element
 *  escapes the overflow of everything ABOVE it (so the walk stops there, after applying that
 *  element's own overflow). `body`/`html` are excluded — the window bound is checked
 *  separately, and a page that sets `overflow:hidden` on `body` would otherwise clip fixed
 *  chrome to the document's content height. */
export function visibleClipRect(el: Element): DomRect | null {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null;
  let clip: DomRect | null = null;
  // Starts at `el` ITSELF, not its parent. For the busiest providers the owner IS the clipper:
  // DopesheetView and CurvesView hand out `owner: <their own overflow:hidden container>` and
  // compute each handle's x from `rect.left + timeToX(t)`, which is NOT clamped to the container —
  // so a keyframe panned out of the visible time window reports a coordinate over the TrackList
  // sidebar beside it. Walking from the parent found only the panel's outer clip, which is wider
  // than that, and answered "not clipped" for a diamond that is not drawn at all. Skipping the
  // owner would reopen exactly the aim-lands-on-the-neighbour bug this function exists to close,
  // one level down.
  for (let p: Element | null = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const cs = window.getComputedStyle(p);
    // Any of the three saying "not visible" is enough. Reading only the two axes would be the
    // browser-accurate rule and would silently degrade to the old window-only answer under
    // jsdom, which resolves `style.overflow = 'hidden'` into the SHORTHAND and leaves both
    // axes reading 'visible' — so the guard would be untestable exactly where it matters.
    if ([cs.overflow, cs.overflowX, cs.overflowY].some((v) => v && v !== 'visible')) {
      const r = p.getBoundingClientRect();
      clip = clip ? intersectRects(clip, { x: r.left, y: r.top, w: r.width, h: r.height })
        : { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    // A fixed element is positioned against the viewport, so no ancestor's overflow clips it —
    // but its OWN overflow (applied above) still clips what is inside it.
    if (cs.position === 'fixed') break;
  }
  return clip;
}

function intersectRects(a: DomRect, b: DomRect): DomRect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

/** Is (x,y) inside the element's visible clip box? True when nothing clips it — the caller
 *  still has to check the window bound, which this deliberately does not duplicate.
 *
 *  `cache` memoises the ancestor walk per owner ELEMENT. Pass one when judging many points against
 *  the same owner: a Dopesheet hands every keyframe the same container (the tool's own docs cite
 *  ~2000 handles), and without it each one re-walks an identical chain of ~10 ancestors calling
 *  getComputedStyle per hop and getBoundingClientRect per clipping ancestor — tens of thousands of
 *  synchronous layout reads per poll for a value that cannot change inside one call. */
export function withinClip(el: Element, x: number, y: number, cache?: Map<Element, DomRect | null>): boolean {
  let clip: DomRect | null | undefined = cache?.get(el);
  if (clip === undefined) {
    clip = visibleClipRect(el);
    cache?.set(el, clip);
  }
  if (!clip) return true;
  return x >= clip.x && x <= clip.x + clip.w && y >= clip.y && y <= clip.y + clip.h;
}

/** Hit-test (x,y) and describe what — if anything — covers `owner` there.
 *
 *  The one place the "elementFromPoint → isOccluded → describeElement" recipe lives. It was
 *  briefly copy-pasted into the chrome handle provider and the selector resolver, and the
 *  two copies immediately disagreed about how to report "nothing is there". Sharing the
 *  primitives but not the recipe is the same drift that let a zero-rect DnD fire at the
 *  window corner; this is the recipe.
 *
 *  Returns `null` when the point is cleanly hit — i.e. `owner` (or a descendant) is on top.
 *  Otherwise a NON-NULL descriptor of the covering element, because a falsy value would slip
 *  past every `if (occludedBy)` a caller writes. `null` from `elementFromPoint` means the
 *  point is outside the window or clipped away, which is still un-clickable. */
export function occlusionAt(owner: Element, x: number, y: number): string | null {
  const top = document.elementFromPoint(x, y);
  if (!isOccluded(owner, top)) return null;
  return describeOccluder(top) ?? NOTHING_AT_POINT;
}

/** Name the covering element WELL ENOUGH TO ACT ON. `describeElement` falls back to the bare tag
 *  when an element carries no id/class/data-ui-id, and a bare `"div"` is what a caller gets told is
 *  covering their handle — true, useless, and indistinguishable from every other anonymous div. The
 *  editor's own panel chrome is exactly that kind of element: the SceneView toolbar strip that
 *  covered a 2D gizmo handle (testboard 5jE5Tip6Qwp7s7YVAYoH) is a style-only div. So when the top
 *  element names nothing, walk up for the nearest ancestor that does and say which panel it is in. */
export function describeOccluder(el: Element | null | undefined): string | null {
  const own = describeElement(el);
  if (!own || /[.#[]/.test(own)) return own; // already identifiable
  for (let p = el!.parentElement, hops = 0; p && hops < 8; p = p.parentElement, hops++) {
    const panel = p.getAttribute('data-editor-panel');
    if (panel) return `${own} in the "${panel}" panel`;
    const named = describeElement(p);
    if (named && /[.#[]/.test(named)) return `${own} inside ${named}`;
  }
  return own;
}

/** The single place a spec becomes an element + a point. Both public resolvers wrap this,
 *  so the guards (selector miss, zero-size rect, missing target) cannot drift apart between
 *  the DnD path and the trusted-input path. Returns an error as data; the wrappers decide
 *  whether to throw. */
function resolveCore(spec: DomPointSpec): { el: Element; x: number; y: number } | { error: string; matched?: Element } {
  if (spec.selector) {
    let el: Element | null;
    try {
      el = document.querySelector(spec.selector);
    } catch {
      // querySelector throws a DOMException on a syntactically invalid selector.
      return { error: `invalid CSS selector ${JSON.stringify(spec.selector)}` };
    }
    if (!el) return { error: `no element matches selector ${JSON.stringify(spec.selector)}` };
    const p = resolveElementPoint(el);
    if ('error' in p) return { error: `element ${JSON.stringify(spec.selector)} ${p.error}`, matched: el };
    return { el, x: p.x, y: p.y };
  }
  if (typeof spec.x === 'number' && typeof spec.y === 'number') {
    const el = document.elementFromPoint(spec.x, spec.y);
    if (!el) return { error: `no element at (${spec.x}, ${spec.y})` };
    return { el, x: spec.x, y: spec.y };
  }
  return { error: 'provide a selector or {x,y}' };
}

/** Resolve a spec to an element + point, THROWING on a miss. For callers that need the
 *  Element itself (DnD dispatch). */
export function resolveDomPoint(spec: DomPointSpec, which = 'target'): DomPointHit {
  const r = resolveCore(spec);
  if ('error' in r) throw new Error(`${which}: ${r.error}`);
  return r;
}

/** Resolve a spec into a serializable report. Never throws — a miss is a result, because
 *  this runs in the renderer and travels back over the bridge as JSON. */
export function resolveDomPointReport(spec: DomPointSpec): DomPointResolution {
  const r = resolveCore(spec);
  if ('error' in r) {
    return { ok: false, error: r.error, ...(r.matched ? { matched: describeElement(r.matched) } : {}) };
  }
  return { ok: true, x: r.x, y: r.y, ...aimProvenance(r.el, r.x, r.y, !!spec.selector) };
}

/** The PROVENANCE half of a resolution: what the aim matched, and what is actually on top of it.
 *
 *  Split out of `resolveDomPointReport` for `domDnd`, which needs the same three fields but
 *  cannot use that resolver — it needs the live Element to dispatch DnD events on, and the
 *  report is deliberately serializable. Duplicating the recipe there is precisely the drift this
 *  module's header warns about (the zero-rect guard that existed on one of two resolvers, and the
 *  one without it dropped a DnD at the window's top-left corner). So: one recipe, two callers.
 *
 *  `bySelector` is the whole reason this takes a flag rather than a spec. A COORDINATE aim matched
 *  nothing by name, so there is nothing for it to be occluded RELATIVE TO — whatever sits under
 *  the point simply is the target. Reporting `occluded` there would be a category error, not a
 *  stricter check. */
export function aimProvenance(
  el: Element, x: number, y: number, bySelector: boolean,
): Pick<DomPointResolution, 'matched' | 'hitTarget' | 'occluded' | 'clipped'> {
  if (!bySelector) return { hitTarget: describeElement(el) };
  const top = document.elementFromPoint(x, y);
  const occluded = isOccluded(el, top);
  // SCROLLED OUT is a different diagnosis from COVERED, and until now the selector path could only
  // say the latter. `getBoundingClientRect()` on a row scrolled past its list's `overflow` clip
  // still reports its laid-out position, so the centre lands on whatever chrome occupies those
  // pixels and the refusal blamed "an open menu, a modal, a panel that overlaps" — none of which
  // is true or actionable. Measured by an independent sweep of this editor's live `[data-ui-id]`
  // set on 2026-08-19: 12 of the 22 occluded hits were this class, led by Hierarchy rows below the
  // fold. Same clip test the HANDLE path already uses, so the two aims agree about what "off the
  // panel" means instead of each having its own idea.
  const clippedAway = occluded && !withinClip(el, x, y);
  return {
    matched: describeElement(el),
    // When something COVERS the target, name it well enough to act on — the covering element is
    // usually anonymous panel chrome, and "div" is not a thing a caller can move out of the way.
    // Only when occluded: on a clean aim `top` IS the target, which describeElement already names.
    hitTarget: occluded ? describeOccluder(top) : describeElement(top),
    occluded,
    ...(clippedAway ? { clipped: true as const } : {}),
  };
}
