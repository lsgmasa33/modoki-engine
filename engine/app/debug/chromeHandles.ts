/** Editor chrome as interaction handles (Enact Phase 2).
 *
 *  Percept could locate every ECS *entity*; it could not locate a single *button* in the
 *  editor's own UI. Panels, toolbar controls, the Inspector's `⋮` and its menu rows were
 *  unaddressable, so an agent drove them by measuring pixels off a downscaled JPEG.
 *
 *  Rather than a parallel system, chrome joins the mechanism that already exists: any
 *  element tagged `data-ui-id="<panel>.<region>.<name>"` becomes an `InteractionHandle`
 *  with `editor: 'chrome'`. `modoki_handles {editor:'chrome'}` discovers them and
 *  `modoki_tap_handle {id}` drives them — ZERO new input tools.
 *
 *  The tagging is curated, not a blanket sweep. The test for inclusion is: *would an agent
 *  ever need to click this?* A label is not a handle.
 *
 *  RESOLUTION GOES THROUGH `domResolve`. This is a binding constraint, not a preference
 *  (docs/enact.md). Phase 1 shipped a DnD path that dropped at the window's
 *  top-left corner because the zero-rect guard lived on one of two DOM→point resolvers.
 *  A second resolver here would recreate that fork, and `occluded` would drift too. So the
 *  handle's point, rect, and occlusion all come from `resolveElementPoint`/`isOccluded`. */

import type { InteractionHandle } from '@modoki/engine/runtime';
import { resolveElementPoint } from './domResolve';

/** The attribute that opts an element into agent addressing. */
export const UI_ID_ATTR = 'data-ui-id';

/** Optional companion attributes, both used verbatim in the handle. `data-ui-kind` groups
 *  handles for filtering ('button', 'menu-item', 'tab', 'field'); `data-ui-label` gives a
 *  human-readable name when the element's text isn't one. */
const UI_KIND_ATTR = 'data-ui-kind';
const UI_LABEL_ATTR = 'data-ui-label';

/** Is this control present but inert? Covers the three ways the editor greys something out:
 *  a real `disabled` property, `aria-disabled`, and the `data-ui-disabled` escape hatch for
 *  a styled div that isn't a `<button>`. Reported as `meta.disabled` — an agent should not
 *  have to infer "greyed out" from a JPEG's shade of grey. */
function isDisabled(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled === true) return true;
  const aria = el.getAttribute('aria-disabled');
  if (aria === 'true') return true;
  return el.getAttribute('data-ui-disabled') === 'true';
}

/** A short label: the explicit attribute, else the element's own trimmed text, else its
 *  title/aria-label. Capped — a panel's text can be arbitrarily long. */
function labelFor(el: Element): string | undefined {
  const explicit = el.getAttribute(UI_LABEL_ATTR);
  if (explicit) return explicit;
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  if (text) return text.length > 60 ? text.slice(0, 57) + '…' : text;
  return el.getAttribute('title') ?? el.getAttribute('aria-label') ?? undefined;
}

/** Walk the DOM for `[data-ui-id]` and turn each into a handle.
 *
 *  A tagged element with a zero-size rect (a collapsed panel, an unmounted tab) is SKIPPED
 *  rather than reported at (0,0): a handle you cannot aim at is worse than one that isn't
 *  offered, because `tap_handle` would happily click the window corner. `modoki_handles`
 *  returning nothing for a panel is the correct signal to open that panel first. */
export function chromeHandles(): InteractionHandle[] {
  if (typeof document === 'undefined') return [];
  const out: InteractionHandle[] = [];
  for (const el of document.querySelectorAll(`[${UI_ID_ATTR}]`)) {
    const id = el.getAttribute(UI_ID_ATTR);
    if (!id) continue;
    const point = resolveElementPoint(el);
    if ('error' in point) continue; // hidden / not laid out — not aimable, so not offered
    const label = labelFor(el); // reads textContent — compute once, not once per use
    out.push({
      id,
      kind: el.getAttribute(UI_KIND_ATTR) ?? el.tagName.toLowerCase(),
      editor: 'chrome',
      x: point.x,
      y: point.y,
      rect: point.rect,
      // `computeHandles` hit-tests this and fills in `occludedBy`. Occlusion is a property
      // of every coordinate-addressed handle, not a chrome feature, so it does not belong here.
      owner: el,
      ...(label ? { label } : {}),
      ...(isDisabled(el) ? { meta: { disabled: true } } : {}),
    });
  }
  return out;
}
