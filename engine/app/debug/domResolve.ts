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
  return describeElement(top) ?? 'nothing (clipped or off-window)';
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
  // A coordinate spec matched nothing by name, so there is nothing to be occluded
  // relative to — report only what sits under the point.
  if (!spec.selector) return { ok: true, x: r.x, y: r.y, hitTarget: describeElement(r.el) };
  const top = document.elementFromPoint(r.x, r.y);
  return {
    ok: true, x: r.x, y: r.y,
    matched: describeElement(r.el),
    hitTarget: describeElement(top),
    occluded: isOccluded(r.el, top),
  };
}
