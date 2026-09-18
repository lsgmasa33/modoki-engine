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

import type { DomPointSpec, DomPointResolution, DomRect, AimGesture } from './domPointContract';
import { isClickShaped } from './domPointContract';
// ⚠️ The RUNTIME's own veto, not a copy of the rule (#1016). `resolveTapZoneVeto` is what
// `pressOrigin.ts` uses to route a real press, so the aim surface and the router cannot disagree
// about who gets the click — §9: a rule implemented twice diverges, and this pair already had.
import { resolveTapZoneVeto, UI_TAP_ZONE_ATTR, collectHandles, normalizeHandleLabel } from '@modoki/engine/runtime';

// Re-exported so existing importers (domDnd, agentBridge) keep one import site.
export type { DomPointSpec, DomPointResolution, DomRect, AimGesture } from './domPointContract';
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

/** Containers whose contents are RENDERED COPIES of real chrome, never the chrome itself.
 *
 *  FlexLayout mounts a "stamp" of every tab button inside `.flexlayout__layout_tab_stamps`, parked
 *  at y≈-9960, to measure tabs and build drag images — and it renders those stamps through the same
 *  `onRenderTab` hook that tags the real buttons (`layoutTabTag.ts`). Measured live 2026-09-13: every
 *  `layout.tab.*` id came back TWICE, the second copy off-window. A duplicate id is the silent bug
 *  `collectHandles` warns about (`tap_handle` resolves the FIRST match), and the `label` aim would
 *  count the copy as a second candidate. The copy is not something anyone can click, so it is not a
 *  handle — `chromeHandles` excludes it where the handle population is defined, rather than each
 *  consumer filtering it. (This is also the offscreen "duplicate tab strip" the pre-#1152
 *  docs/mcp-tool-conventions.md recipe filtered on `y > 0`.) */
const RENDERED_COPY_CONTAINERS =
  '.flexlayout__layout_tab_stamps, [data-layout-path="/popup-menu"], [data-layout-path="/drag-rectangle"]';

/** Is this element a rendered COPY of chrome rather than the chrome itself? Exported because every
 *  walker over `[data-ui-id]` needs the same answer: `chromeHandles.ts` defines the handle population
 *  with it, `layoutSettle.ts` keys its samples by id (a stamp overwriting the real tab's entry would
 *  hide the real tab's movement). It lives here, in the resolver core both walkers already import, so no
 *  import cycle forms. (`uiIdAddressable` deliberately does NOT use it — it models focus's raw lookup.)
 *
 *  All three are FlexLayout (0.8.19) rendering a `TabButtonStamp` through `onRenderTab`:
 *  - the offscreen stamp strip, always mounted;
 *  - the tabset OVERFLOW menu (`PopupMenu`, `/popup-menu`), mounted while it is open — a hidden
 *    tab's row there would otherwise be a second `layout.tab.<id>` and make its label AMBIGUOUS;
 *  - the drag image (`setDragComponent`, `/drag-rectangle`) — only under `onRenderDragRect` or
 *    Safari, neither of which the Electron editor uses, and removed a tick later. Kept because the
 *    web editor can run in Safari. */
export function isRenderedChromeCopy(el: Element): boolean {
  return el.closest(RENDERED_COPY_CONTAINERS) !== null;
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
export function occlusionAt(owner: Element, x: number, y: number, gesture: AimGesture | undefined): string | null {
  const top = effectiveHit(x, y, gesture);
  if (!isOccluded(owner, top)) return null;
  return describeOccluder(top) ?? NOTHING_AT_POINT;
}

/** The same hit test as `occlusionAt`, answering with the covering ELEMENT rather than its name —
 *  for a caller that must ask WHERE the cover sits before it counts it (the dispatch-action carrier
 *  gate, #1418, counts only a cover inside the game's own UI host). `undefined` = cleanly hit;
 *  `null` = nothing at the point (outside the window, or clipped away). */
export function coveringElementAt(owner: Element, x: number, y: number, gesture: AimGesture | undefined): Element | null | undefined {
  const top = effectiveHit(x, y, gesture);
  return isOccluded(owner, top) ? top : undefined;
}

/** The element the gesture would REALLY reach — `elementFromPoint`, then the runtime's tap-zone
 *  redirect where it applies.
 *
 *  ⚠️ **Why the raw topmost element stopped being the right answer** (#1016). #977 made a
 *  `minTapSize` expander LOSE the press to real content underneath it: the expander is stamped
 *  `data-tap-zone`, and `pressOrigin.ts` hands the click to whatever would have handled it. The aim
 *  surface did not follow, so `isOccluded` still counted the zone as a cover and `modoki_tap`
 *  refused an aim a human's finger now reaches — naming a bare anonymous `div` the caller cannot
 *  act on.
 *
 *  ⚠️ **And why it is gated on the gesture.** The redirect is a CLICK-time mechanism and needs the
 *  release in the same zone, which a drag never satisfies — both `pressOrigin.ts` and
 *  `docs/ui-system.md` say so. Applying it to `modoki_drag {from:{entity:'DailyClose'}}` under a
 *  neighbour's expander would stop the refusal, dispatch the gesture, begin it on the ZONE'S HOST,
 *  and report success: `docs/mcp-tool-conventions.md` §0 ranks that false success first among
 *  failure modes, above the refusal it replaces. That trade is what got `75ba25601` reverted, and
 *  `isClickShaped` is the line that refuses to make it.
 *
 *  ⚠️ `elementsFromPoint` is called through `?.() ?? []`, matching the guard `pressOrigin.ts`
 *  already has two files away. jsdom implements neither hit-test, so an unguarded call is a
 *  `TypeError` out of a function whose callers treat the result as data. */
function effectiveHit(x: number, y: number, gesture: AimGesture | undefined): Element | null {
  const top = document.elementFromPoint(x, y);
  if (!top || !isClickShaped(gesture)) return top;
  const zone = top.closest(`[${UI_TAP_ZONE_ATTR}]`);
  if (!zone) return top;
  const stack = document.elementsFromPoint?.(x, y) ?? [];
  // `null` means the zone legitimately KEEPS the press — the refusal is correct, and
  // `describeOccluder` now names it well enough to act on.
  return resolveTapZoneVeto(stack, zone) ?? top;
}

/** Name the covering element WELL ENOUGH TO ACT ON. `describeElement` falls back to the bare tag
 *  when an element carries no id/class/data-ui-id, and a bare `"div"` is what a caller gets told is
 *  covering their handle — true, useless, and indistinguishable from every other anonymous div. The
 *  editor's own panel chrome is exactly that kind of element: the SceneView toolbar strip that
 *  covered a 2D gizmo handle (testboard 5jE5Tip6Qwp7s7YVAYoH) is a style-only div. So when the top
 *  element names nothing, walk up for the nearest ancestor that does and say which panel it is in. */
export function describeOccluder(el: Element | null | undefined): string | null {
  // ⚠️ A tap zone that legitimately KEEPS the press is a correct refusal and was still useless:
  // the expander is a style-only div, so the caller was told `div in the "Game" panel` — true,
  // and not a thing anyone can move out of the way (#1016). Name what it belongs to instead.
  //
  // ⚠️ **By `data-entity-id`, NOT by `describeElement`, and the first version got this wrong in the
  // one shape it was written for.** `UINode.tsx` stamps a game UI host as
  // `<div data-entity-id={n} data-press-origin style={…}>` — no `id`, no `className`, no `title`,
  // and `data-entity-id` is not the `data-ui-id` `describeElement` looks for. So it returned a bare
  // `'div'` and the promised *"the minTapSize tap zone of #pager-next"* was
  // *"the minTapSize tap zone of div"* on every shipping node — a NET LOSS against the
  // `div in the "Game" panel` it replaced, since this branch also skips the panel walk below.
  // Caught because the test fixture set an `id` no UINode has.
  //
  // `data-entity-id` is the handle an agent aims at anyway (`bridge.ts`'s `describeEl` names the
  // same audience the same way), so a caller can act on it directly: it is the `entity` id.
  const zone = el?.closest?.(`[${UI_TAP_ZONE_ATTR}]`);
  if (zone) {
    const host = zone.parentElement;
    const entityId = host?.getAttribute('data-entity-id');
    const named = entityId ? `entity ${entityId}` : (host ? describeElement(host) : null);
    // Falls through to the ancestor walk when the host names nothing at all, rather than
    // announcing an anonymous owner — "of div" tells the caller strictly less than the panel does.
    // ⚠️ `/[.#[]/` — "did `describeElement` find a real name, or fall back to a bare tag?" — NOT
    // `named !== 'div'`. The literal test is right only while `UINode.tsx` gates tap zones to
    // `elementType === 'div'`; the day a `<span>` or `<button>` may host one, it would announce
    // "the minTapSize tap zone of span", the anonymous-owner shape this branch exists to avoid.
    // Same predicate the non-zone path two functions down already uses.
    if (named && /[.#[]|^entity /.test(named)) return `the minTapSize tap zone of ${named}`;
    const anon = describeElement(el);
    return anon ? `the minTapSize tap zone in ${describeOccluderContext(el!) ?? anon}` : null;
  }
  const own = describeElement(el);
  if (!own || /[.#[]/.test(own)) return own; // already identifiable
  return describeOccluderContext(el!) ?? own;
}

/** Walk up for the nearest ancestor that names something, and say where the element sits. Split out
 *  of `describeOccluder` so the tap-zone branch can fall back to it (#1016 close-out F2) instead of
 *  returning early with an anonymous owner — losing the context the pre-#1016 message had. */
function describeOccluderContext(el: Element): string | null {
  // Both callers guard on a truthy `describeElement(el)`, so no `??` fallback here — a defensive
  // branch nothing can reach reads as evidence that a case exists.
  const own = describeElement(el)!;
  for (let p = el.parentElement, hops = 0; p && hops < 8; p = p.parentElement, hops++) {
    const panel = p.getAttribute('data-editor-panel');
    if (panel) return `${own} in the "${panel}" panel`;
    const named = describeElement(p);
    if (named && /[.#[]/.test(named)) return `${own} inside ${named}`;
  }
  return null;
}

type CoreResolution =
  | { el: Element; x: number; y: number; uiId?: string }
  | { error: string; matched?: Element; code?: 'NOT_FOUND' | 'AMBIGUOUS' };

const isElementValue = (v: unknown): v is Element => typeof Element !== 'undefined' && v instanceof Element;

/** How many candidates a refusal names before it summarises the rest. */
const NAMED_CANDIDATES = 8;

/** Resolve a `label` aim to ONE element (#1153).
 *
 *  ⚠️ **The population is the chrome HANDLE set, not "any text on the page".** `collectHandles
 *  ({editor:'chrome', label})` is exactly what `modoki_handles {editor:'chrome', label}` returns, so
 *  a label an agent READ is a label it can AIM at, and the match rule (`labelMatches`) is the one
 *  function both use. Matching arbitrary visible text would reach untagged elements too, but a label
 *  is not a handle (`chromeHandles.ts`): a paragraph saying "Save" is not a Save button, and a
 *  text-scrape aim would press whichever one came first in the DOM.
 *
 *  ⚠️ **Only ON-WINDOW candidates are counted, and never a first-match.** FlexLayout parks a copy of
 *  every tab ~10000px above the window (excluded at the provider), a collapsed panel keeps its
 *  tagged controls at zero size (excluded there too), and a panel taller than its dock leaves rows
 *  laid out past the window edge. None of those can receive a press, so counting them would turn
 *  every such label into an AMBIGUOUS refusal about things nobody can see. Among on-window
 *  candidates, one scrolled out of its own container is dropped the same way, but ONLY when a
 *  visible one remains — a lone scrolled-out match is returned, so the caller gets the
 *  "SCROLLED OUT, scroll it into view" refusal rather than a misleading NOT_FOUND. */
function resolveLabel(label: string, within: string | undefined): CoreResolution {
  if (!normalizeHandleLabel(label)) return { error: 'label is empty — nothing to match' };
  let inScope: (el: Element) => boolean = () => true;
  if (within !== undefined) {
    let scope: Element | null;
    try { scope = document.querySelector(within); } catch { return { error: `invalid CSS selector in within: ${JSON.stringify(within)}` }; }
    if (!scope) return { error: `no element matches within: ${JSON.stringify(within)} — that panel or dialog is not open`, code: 'NOT_FOUND' };
    inScope = (el) => el.closest(within) !== null;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const onWindow: Array<{ el: Element; x: number; y: number; id: string; label?: string; clear: boolean }> = [];
  let offWindow = 0;
  for (const h of collectHandles({ editor: 'chrome', label })) {
    if (!isElementValue(h.owner) || !inScope(h.owner)) continue;
    const p = resolveElementPoint(h.owner);
    if ('error' in p) { offWindow++; continue; }
    if (p.x < 0 || p.y < 0 || p.x > vw || p.y > vh) { offWindow++; continue; }
    onWindow.push({ el: h.owner, x: p.x, y: p.y, id: h.id, label: h.label, clear: withinClip(h.owner, p.x, p.y) });
  }
  const asked = `label ${JSON.stringify(label)}${within !== undefined ? ` within ${JSON.stringify(within)}` : ''}`;
  const visible = onWindow.filter((c) => c.clear);
  const pick = visible.length === 1 ? visible[0] : (visible.length === 0 && onWindow.length === 1 ? onWindow[0] : null);
  if (pick) return { el: pick.el, x: pick.x, y: pick.y, uiId: pick.id };
  if (visible.length > 1 || onWindow.length > 1) {
    const many = visible.length > 1 ? visible : onWindow;
    const named = many.slice(0, NAMED_CANDIDATES).map((c) => `${c.id} (${JSON.stringify(c.label)})`).join(', ');
    const more = many.length > NAMED_CANDIDATES ? ` and ${many.length - NAMED_CANDIDATES} more` : '';
    // Aiming "by selector at one of these ids" is only advice when the ids DIFFER: two crashed panels'
    // Reload buttons share `panel-error.reload-panel`, and a selector would take the first (close-out).
    const sharedId = new Set(many.map((c) => c.id)).size < many.length;
    return {
      error: `${asked} matches ${many.length} on-screen chrome elements: ${named}${more}. Narrow it with `
        + '`within` (a CSS selector for the panel or dialog, e.g. \'[data-panel-scope="inspector"]\', or '
        + '\'[data-modal-shell="sprite-editor"]\' for a modal — a modal is portalled to <body>, so it is '
        + 'NOT under its panel\'s data-panel-scope)'
        + (sharedId ? ' — some of these SHARE a data-ui-id, so a selector cannot separate them.' : ', or aim by selector at one of these data-ui-ids.'),
      code: 'AMBIGUOUS',
    };
  }
  if (offWindow > 0) {
    return {
      // Only "past the window edge" can reach here: a collapsed panel's controls are zero-size and an
      // unselected tab's panel is hidden at zero size (FlexLayout keeps a once-shown tab mounted but
      // display:none), so `chromeHandles` never offers either (close-out).
      error: `${asked} matches ${offWindow} chrome element(s), but none is inside the window — laid out past `
        + 'its edge (a panel taller than its dock). Scroll that panel or enlarge it, then re-aim.',
      code: 'NOT_FOUND',
    };
  }
  // `within` filtered out every match: say THAT, rather than suggest back the very label the caller
  // typed as if it did not exist (close-out). Counted over the same unscoped population.
  if (within !== undefined) {
    const outside = collectHandles({ editor: 'chrome', label }).filter((h) => isElementValue(h.owner)).length;
    if (outside > 0) {
      return {
        error: `${asked}: ${outside} chrome element(s) have that label, but none is inside ${JSON.stringify(within)}. `
          + 'Widen or drop `within`, or check which panel it is in with modoki_handles {editor:"chrome", label}. '
          + 'A control in an UNSELECTED tab is hidden at zero size, so it cannot match until its tab is tapped.',
        code: 'NOT_FOUND',
      };
    }
  }
  // Suggest labels that CONTAIN the query, so "Save" → "Save All" is one step away rather than a
  // blind retry. Substrings are offered, never aimed at: exact is the rule, this is only the hint.
  const q = normalizeHandleLabel(label);
  const near = new Set<string>();
  for (const h of collectHandles({ editor: 'chrome' })) {
    if (h.label && normalizeHandleLabel(h.label).includes(q)) near.add(JSON.stringify(h.label.length > 60 ? `${h.label.slice(0, 57)}…` : h.label));
    if (near.size >= NAMED_CANDIDATES) break;
  }
  return {
    error: `no on-screen editor chrome is labelled ${JSON.stringify(label)}${within !== undefined ? ` within ${JSON.stringify(within)}` : ''}. `
      + 'A label aim matches the WHOLE label of a data-ui-id control or dock tab (whitespace-collapsed, case-insensitive), '
      + `never a substring.${near.size ? ` Labels containing it: ${[...near].join(', ')}.` : ''} `
      + 'modoki_handles {editor:"chrome", prefix} lists what is live; a control in an UNSELECTED tab is hidden '
      + 'at zero size, so tap that tab first.',
    code: 'NOT_FOUND',
  };
}

/** The single place a spec becomes an element + a point. Both public resolvers wrap this,
 *  so the guards (selector miss, zero-size rect, missing target) cannot drift apart between
 *  the DnD path and the trusted-input path. Returns an error as data; the wrappers decide
 *  whether to throw. */
function resolveCore(spec: DomPointSpec): CoreResolution {
  if (spec.label !== undefined) {
    if (spec.selector) {
      return { error: 'give a label OR a selector, not both — two addresses for one target', code: 'AMBIGUOUS' };
    }
    return resolveLabel(spec.label, spec.within);
  }
  if (spec.within !== undefined) return { error: '`within` scopes a `label` aim; it has no meaning without one' };
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
    return {
      ok: false, error: r.error,
      ...(r.matched ? { matched: describeElement(r.matched) } : {}),
      ...(r.code ? { code: r.code } : {}),
    };
  }
  // A label aim names a THING exactly as a selector does, so it gets the same occlusion verdict.
  const byName = !!spec.selector || spec.label !== undefined;
  return {
    ok: true, x: r.x, y: r.y,
    // ⚠️ A RAW `querySelector`, deliberately — copies included. `uiIdAddressable` PREDICTS what
    // `/api/input/focus` will do, and `focusElement` (rendererOps.ts) re-finds by exactly this raw
    // lookup. Skipping rendered copies here would report "addressable" for an id whose first match is a
    // stamp, and focus would then land on the stamp (close-out §2d, a reviewer suggestion declined).
    ...(r.uiId ? { uiId: r.uiId, uiIdAddressable: document.querySelector(`[data-ui-id=${JSON.stringify(r.uiId)}]`) === r.el } : {}),
    ...aimProvenance(r.el, r.x, r.y, byName, spec.gesture),
  };
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
  el: Element, x: number, y: number, bySelector: boolean, gesture: AimGesture | undefined,
): Pick<DomPointResolution, 'matched' | 'hitTarget' | 'occluded' | 'clipped'> {
  if (!bySelector) return { hitTarget: describeElement(el) };
  // ⚠️ **The selector path reaches GAME UI, so it needs the redirect too** (#1016). The reverted
  // `75ba25601` excused this path as "editor chrome only", which is false: `UINode.tsx` stamps
  // `data-entity-id` on every game UI node, so `modoki_tap {selector:'[data-entity-id="42"]'}`
  // resolves through here and kept the stale verdict. `docs/enact.md` states `entity` and
  // `selector` are ONE category — the split was the bug, not the design.
  const top = effectiveHit(x, y, gesture);
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
