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

import { MIXED_PLACEHOLDER, type InteractionHandle } from '@modoki/engine/runtime';
import { resolveElementPoint, isRenderedChromeCopy } from './domResolve';

/** The attribute that opts an element into agent addressing. */
export const UI_ID_ATTR = 'data-ui-id';

/** Optional companion attributes, both used verbatim in the handle. `data-ui-kind` groups
 *  handles for filtering ('button', 'menu-item', 'tab', 'field'); `data-ui-label` gives a
 *  human-readable name when the element's text isn't one. */
const UI_KIND_ATTR = 'data-ui-kind';
const UI_LABEL_ATTR = 'data-ui-label';

/** Optional CURRENT-VALUE attribute, reported as `meta.state`. Same argument as
 *  `meta.disabled` below: which segment of a tri-state control is active is DATA, and
 *  without it an agent has to infer "selected" from a background colour in a downscaled
 *  JPEG. Set it only where the control has a state worth reading back — a segmented
 *  Auto/On/Off row, a toggle — never as decoration on a plain button. */
const UI_STATE_ATTR = 'data-ui-state';

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

/** The label: the explicit attribute, else the element's own trimmed text, else its
 *  title/aria-label.
 *
 *  ⚠️ UNCAPPED here, and that is load-bearing (#1153). The `label` aim and filter match against
 *  THIS string, so capping it at the provider would make every label past the cap unmatchable by
 *  its own full text. The cap is a response-budget concern and lives at the serialization
 *  boundary, `computeHandles`. */
function labelFor(el: Element): string | undefined {
  const explicit = el.getAttribute(UI_LABEL_ATTR);
  if (explicit) return explicit;
  // A form control's text is not its name: a `<select>`'s textContent is every OPTION run together
  // (measured live: the SceneView mode select labelled itself "3D2D"), and a textarea's is its
  // default contents. Harmless while a label was only display; wrong now that it is an aim key.
  const tag = el.tagName.toLowerCase();
  const text = tag === 'select' || tag === 'textarea' ? '' : (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  if (text) return text;
  return el.getAttribute('title') ?? el.getAttribute('aria-label') ?? undefined;
}

/** A value is capped in the report — a textarea can hold a whole script. */
const VALUE_CAP = 200;
/** What a password field reports instead of its contents. */
export const MASKED_VALUE = '•••';

/** The LIVE form state of a control, read from the element itself (#1152).
 *
 *  `data-ui-state` is opt-in and only a handful of components set it, so an Inspector field's
 *  current value was unreadable without `modoki_eval` walking the DOM — 314 evals did exactly
 *  that. The element already knows its value; this reads it, so no component has to remember to
 *  mirror it into an attribute (and none can forget).
 *
 *  - `value`   — input / select / textarea. A checkbox or radio reports `checked` instead, since
 *                its `value` is a constant form token, not state. A password is MASKED: this
 *                report crosses the agent bridge and lands in a transcript.
 *  - `checked` — checkbox / radio.
 *  - `expanded`— `aria-expanded`, the one standard attribute for "is this disclosure open". */
function formStateFor(el: Element): { value?: string; checked?: boolean; expanded?: boolean; mixed?: true } {
  const out: { value?: string; checked?: boolean; expanded?: boolean; mixed?: true } = {};
  const tag = el.tagName.toLowerCase();
  // ⚠️ MIXED is its own answer, not a value (#1152 close-out). A multi-select whose entities differ
  // renders a checkbox `checked={false}` + `indeterminate`, a text/number field `value=''` behind the
  // MIXED_PLACEHOLDER, and a select `value=''` with a MIXED_PLACEHOLDER option — so reading only
  // checked/value reported a definite `false` and an "empty" field for a state that is neither.
  //
  // Keyed on what every mixed control already RENDERS, not on a marker each producer must add: the
  // first attempt stamped `data-ui-mixed` in `fields.tsx`, and review found the Inspector's main
  // number field (`NumberField`) and five texture selects render mixed without going through it.
  // `data-ui-mixed` survives only for a control that CANNOT show the placeholder (a range slider).
  // A mixed checkbox omits `checked` (a render artifact); a mixed field keeps `value:''`.
  if (el.getAttribute('data-ui-mixed') === 'true') out.mixed = true;
  if (tag === 'input') {
    const input = el as HTMLInputElement;
    const type = (input.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      if (input.indeterminate) out.mixed = true;
      else out.checked = input.checked;
    }
    else if (type === 'password') out.value = input.value ? MASKED_VALUE : '';
    else {
      out.value = input.value;
      if (input.value === '' && input.getAttribute('placeholder') === MIXED_PLACEHOLDER) out.mixed = true;
    }
  } else if (tag === 'textarea') {
    const ta = el as HTMLTextAreaElement;
    out.value = ta.value;
    if (ta.value === '' && ta.getAttribute('placeholder') === MIXED_PLACEHOLDER) out.mixed = true;
  } else if (tag === 'select') {
    const sel = el as HTMLSelectElement;
    out.value = sel.value;
    if (sel.value === '' && sel.selectedOptions[0]?.textContent === MIXED_PLACEHOLDER) out.mixed = true;
  }
  if (out.value !== undefined && out.value.length > VALUE_CAP) out.value = out.value.slice(0, VALUE_CAP - 1) + '…';
  const expanded = el.getAttribute('aria-expanded');
  if (expanded === 'true' || expanded === 'false') out.expanded = expanded === 'true';
  return out;
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
    if (isRenderedChromeCopy(el)) continue; // a stamp/drag-image copy, not the control
    const point = resolveElementPoint(el);
    if ('error' in point) continue; // hidden / not laid out — not aimable, so not offered
    const label = labelFor(el); // reads textContent — compute once, not once per use
    const state = el.getAttribute(UI_STATE_ATTR);
    const meta = {
      ...(isDisabled(el) ? { disabled: true } : {}),
      ...(state ? { state } : {}),
      ...formStateFor(el),
    };
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
      ...(Object.keys(meta).length ? { meta } : {}),
    });
  }
  return out;
}
