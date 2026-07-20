/** UI Action Registry — games (and the engine) register named handlers; UI
 *  entities reference them by name via a UIAction binding (kind:'call').
 *
 *  Handlers receive a context object, not a bare payload, so the same handler can
 *  read the event's payload, the typed params the binding authored, AND the target
 *  entity the button points at. Actions are usually registered by a system (see
 *  registerSystem's `actions` option) or by the engine's built-ins.
 *
 *  An action may declare a `params` schema (Record<string, FieldHint>) so the editor
 *  renders typed widgets for its arguments instead of one freeform payload string. */

import { isSimRunning } from '../systems/playState';
import { isTimelinePreviewActive } from '../systems/timelinePreview';
import { getCurrentWorld } from '../ecs/world';
import { EntityAttributes } from '../traits/EntityAttributes';
import { emit as emitJournal } from '../systems/journal';
import type { FieldHint } from '../ecs/traitRegistry';
import type { Entity, World } from 'koota';

// Payload is a string for text inputs (submit/change) and a number for range
// sliders (change) — handlers narrow with `typeof` as needed.
export type UIActionPayload = string | number;

/** Context passed to every action handler. */
export interface UIActionContext {
  /** The triggering event's value (input/slider value, or a binding's authored
   *  single payload). Use for the `$value` token and schema-less actions. */
  payload?: UIActionPayload;
  /** Typed arguments the binding authored, keyed by the action's `params` schema
   *  (with the `$value` token already resolved to the event value). */
  params?: Record<string, unknown>;
  /** Entity the binding targets (resolved from the binding's `target` GUID), if any. */
  target?: Entity;
  /** The current ECS world. */
  world: World;
  /** Record a semantic event to the journal (Percept), pre-bound to this action's
   *  world — so a handler never has to pass `world` (and can't target the wrong one
   *  in an async callback). Any koota Entity in the payload is auto-converted to its
   *  stable GUID. Prefer this over the free `emit(type, payload, world)`. */
  emit: (type: string, payload?: unknown) => void;
}

export type UIActionHandler = (ctx: UIActionContext) => void;

/** A registered action: a handler plus an optional typed-argument schema. The
 *  bare-function form is shorthand for `{ handler }` (no declared params). */
export interface UIActionDef {
  handler: UIActionHandler;
  /** Editor-facing schema for this action's arguments — drives typed widgets in
   *  the Inspector's binding editor. Omit for actions that take no authored args. */
  params?: Record<string, FieldHint>;
}

/** Options for dispatching an action — the target is given as a GUID and resolved
 *  to an entity here so callers (applyBindings) don't need world access. A caller
 *  that already resolved the entity (applyBindings builds a guid→entity map once)
 *  can pass `target` to skip the O(n) scan. */
export interface DispatchOptions {
  payload?: UIActionPayload;
  params?: Record<string, unknown>;
  targetGuid?: string;
  /** Pre-resolved target entity. If set, the targetGuid scan is skipped. */
  target?: Entity;
}

const defs = new Map<string, UIActionDef>();

function asDef(def: UIActionHandler | UIActionDef): UIActionDef {
  return typeof def === 'function' ? { handler: def } : def;
}

export function registerUIAction(name: string, def: UIActionHandler | UIActionDef) {
  defs.set(name, asDef(def));
}

export function unregisterUIAction(name: string) {
  defs.delete(name);
}

/** The declared argument schema for an action, if any (for the Inspector). */
export function getUIActionParams(name: string): Record<string, FieldHint> | undefined {
  return defs.get(name)?.params;
}

/** Dispatch a named UI action.
 *
 *  ⚠️ EVENT-HANDLER ONLY (F10): invoke this (and `applyBindings`, which calls it)
 *  from a DOM event handler, never from a system tick / projection. On a missing
 *  handler it THROWS in dev — harmless out of a React event handler (React isolates
 *  the throw), but it would abort the whole frame if reached inside the pipeline. */
export function dispatchUIAction(name: string, opts?: DispatchOptions) {
  // Inert unless the game is actually running. In the editor's Stopped/Paused
  // states a button click must not fire game logic (Unity edit-mode semantics).
  if (!isSimRunning()) return;
  const def = defs.get(name);
  if (!def) {
    if (!name) return; // empty action — nothing wired, not an error
    const msg = `[UIAction] No handler for "${name}"`;
    if (import.meta.env?.DEV) throw new Error(msg); // event-handler-only — see doc above
    console.warn(msg);
    return;
  }
  const world = getCurrentWorld();
  let target: Entity | undefined = opts?.target;
  if (!target && opts?.targetGuid) {
    world.query(EntityAttributes).updateEach(([attr]: any[], entity: any) => {
      if (attr.guid === opts.targetGuid) target = entity;
    });
  }
  def.handler({ payload: opts?.payload, params: opts?.params, target, world, emit: (type, payload) => emitJournal(type, payload, world) });
}

export function getUIActionNames(): string[] {
  return Array.from(defs.keys());
}

/** Is a handler registered under this name? */
export function hasUIAction(name: string): boolean {
  return defs.has(name);
}

/** Pipeline-SAFE action dispatch — like `dispatchUIAction` but never throws on a
 *  missing handler (warns + returns false), so it's safe to call from inside a
 *  system tick / the fixed step. This is the sanctioned way for engine systems to
 *  fire game reactions to simulation events (e.g. `physics2DSystem` dispatching an
 *  `OnCollision2D` action), where `dispatchUIAction`'s dev-throw-on-missing would
 *  abort the whole frame (F10). Still inert unless the sim is running. Returns true
 *  iff a handler ran. */
export function dispatchGameAction(name: string, opts?: DispatchOptions): boolean {
  if (!name) return false;
  // Gated on the sim running — EXCEPT the Timeline panel's forward preview, which fires signal /
  // OnSequence actions with the sim otherwise stopped (see runtime/systems/timelinePreview.ts).
  if (!isSimRunning() && !isTimelinePreviewActive()) return false;
  const def = defs.get(name);
  if (!def) { console.warn(`[gameAction] No handler for "${name}"`); return false; }
  const world = getCurrentWorld();
  let target: Entity | undefined = opts?.target;
  if (!target && opts?.targetGuid) {
    world.query(EntityAttributes).updateEach(([attr]: any[], entity: any) => {
      if (attr.guid === opts.targetGuid) target = entity;
    });
  }
  def.handler({ payload: opts?.payload, params: opts?.params, target, world, emit: (type, payload) => emitJournal(type, payload, world) });
  return true;
}
