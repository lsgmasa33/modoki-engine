/** UIAction bindings — the unified event→response model for interactive UI.
 *
 *  A UIAction holds a flat list of bindings. Each binding fires on one `event`
 *  (click / change / submit) and does one of two `kind`s of work:
 *
 *   - `set`  — a declarative property write: set `property` of `component` on the
 *              `target` entity to `value`. Subsumes the old show/hide pair
 *              (opening a panel is `UIElement.isVisible = true`). Engine-applied,
 *              no game code.
 *   - `call` — dispatch a named action (system logic or an engine built-in like
 *              `engine.loadScene`). `target` becomes ctx.target; `params` are the
 *              action's typed arguments.
 *
 *  The `$value` token (in a set's `value` or any `params` entry) is replaced at
 *  dispatch with the triggering event's value — e.g. a range slider's `change`
 *  event can write its live number straight into a field with zero game code.
 *
 *  Inert unless the game is running (mirrors dispatchUIAction): in the editor's
 *  Stopped/Paused states an event must not mutate the scene. Writes that happen
 *  while playing are reverted by Stop (snapshot/revert) and Cmd+S is blocked in
 *  play, so runtime state never reaches disk. */

import { getCurrentWorld, findEntityByGuid } from '../ecs/world';
import { getTraitByName } from '../ecs/traitRegistry';
import { markUIDirty } from './uiTreeStore';
import { isSimRunning } from '../systems/playState';
import { dispatchUIAction, type UIActionPayload } from './actionRegistry';

export type UIActionEvent = 'click' | 'change' | 'submit';
export type UIActionKind = 'set' | 'call';

/** One event→response binding on a UIAction. */
export interface UIActionBinding {
  /** Which interaction fires this binding. Defaults to 'click' when omitted. */
  event: UIActionEvent;
  /** What the binding does. */
  kind: UIActionKind;
  // ── kind: 'set' ── declarative write
  /** Target entity GUID. For 'set' it's the entity written; for 'call' it's
   *  passed to the handler as ctx.target. Empty → the element's own entity. */
  target?: string;
  /** Component (trait) name to write, e.g. 'UIElement'. */
  component?: string;
  /** Field on that component, e.g. 'isVisible'. */
  property?: string;
  /** Value to write — typed by the field's FieldHint, or the token '$value'. */
  value?: unknown;
  // ── kind: 'call' ── named action
  /** Action name (system-owned or engine built-in). */
  action?: string;
  /** Typed arguments for the action; values may be the '$value' token. */
  params?: Record<string, unknown>;
}

/** The `$value` token resolves to the triggering event's value at dispatch. */
export const VALUE_TOKEN = '$value';

function resolve(v: unknown, eventValue: UIActionPayload | undefined): unknown {
  return v === VALUE_TOKEN ? eventValue : v;
}

export interface ApplyBindingsOptions {
  /** GUID of the element's own entity — resolves bindings whose target is empty. */
  selfGuid?: string;
  /** The triggering event's value (slider number, input string) — feeds '$value'
   *  and is passed as ctx.payload to 'call' handlers. */
  eventValue?: UIActionPayload;
}

/** Resolve only the requested guids to entities via the maintained guid→entity
 *  index — O(1) per target. Replaces the old early-break world scan; matters for a
 *  range slider firing `change` continuously during a drag (F6). */
function resolveGuids(world: ReturnType<typeof getCurrentWorld>, needed: Set<string>): Map<string, any> {
  const out = new Map<string, any>();
  if (needed.size === 0) return out;
  for (const guid of needed) {
    const entity = findEntityByGuid(guid, world);
    if (entity) out.set(guid, entity);
  }
  return out;
}

/** Run every binding registered for `event`.
 *
 *  ⚠️ EVENT-HANDLER ONLY (F10): call this from a DOM event handler, never from a
 *  system tick / projection. `kind:'call'` routes through `dispatchUIAction`, which
 *  THROWS in dev on an unregistered action — fine out of a React handler (React
 *  isolates it) but it would abort the frame if invoked inside the pipeline. */
export function applyBindings(
  bindings: UIActionBinding[] | undefined,
  event: UIActionEvent,
  opts: ApplyBindingsOptions = {},
): void {
  if (!bindings?.length || !isSimRunning()) return;

  const { selfGuid, eventValue } = opts;

  // Pass 1: collect the distinct target guids of the rows matching this event —
  // inline, no `.filter` allocation. Most UIs target `selfGuid` → a 1-element set.
  const needed = new Set<string>();
  let anyRow = false;
  for (const b of bindings) {
    if (!b || (b.event || 'click') !== event) continue;
    anyRow = true;
    const guid = b.target || selfGuid;
    if (guid) needed.add(guid);
  }
  if (!anyRow) return;

  const world = getCurrentWorld();
  // Resolve only the needed guids (early-break scan), shared by 'set' + 'call'.
  const byGuid = resolveGuids(world, needed);

  let touchedUI = false;
  // Pass 2: apply each matching row.
  for (const b of bindings) {
    if (!b || (b.event || 'click') !== event) continue;
    if (b.kind === 'call') {
      if (!b.action) continue;
      const params = b.params
        ? Object.fromEntries(Object.entries(b.params).map(([k, v]) => [k, resolve(v, eventValue)]))
        : undefined;
      // ctx.payload is the live event value, falling back to an authored single
      // `payload` param — the schema-less convention (one freeform value).
      const payload = eventValue !== undefined ? eventValue : (params?.payload as UIActionPayload | undefined);
      const guid = b.target || selfGuid;
      // Reuse the guid→entity map we already built — skip dispatchUIAction's scan.
      dispatchUIAction(b.action, { payload, params, targetGuid: guid, target: guid ? byGuid.get(guid) : undefined });
      continue;
    }
    // kind: 'set'
    if (!b.component || !b.property) continue;
    const guid = b.target || selfGuid;
    if (!guid) continue;
    const entity = byGuid.get(guid);
    if (!entity) continue;
    const meta = getTraitByName(b.component);
    if (!meta || !entity.has(meta.trait)) continue;
    const value = resolve(b.value, eventValue);
    const current = entity.get(meta.trait) as Record<string, unknown>;
    if (current[b.property] === value) continue;
    entity.set(meta.trait, { ...current, [b.property]: value });
    // Any successful set can feed a UIBinding active-highlight (which reads an
    // arbitrary trait on a target entity — e.g. SkeletalAnimator.clip), not just
    // direct UIElement writes, so rebuild the projection on any change.
    touchedUI = true;
  }

  if (touchedUI) markUIDirty(); // rebuild the UI projection so the renderer re-reads
}
