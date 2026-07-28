import { trait } from 'koota';

/** UIAction — event handlers for interactive UI elements.
 *
 *  A single flat list of bindings. Each binding fires on one event (click /
 *  change / submit) and either writes a property declaratively (`kind:'set'`) or
 *  dispatches a named action (`kind:'call'`). This unifies what used to be six
 *  separate fields (onClick/onClickPayload/onClickTarget/onClickSet/onChange/
 *  onSubmit) into one honest model — see runtime/ui/bindings.ts.
 *
 *   - A button that opens Credits and closes Settings = two `set` bindings on
 *     `click`.
 *   - A slider that drives a system = one `call` binding on `change`.
 *   - A slider that writes a field directly = one `set` binding on `change` with
 *     `value:'$value'` (the live slider number), no game code.
 *
 *  koota note: this is an AoS trait (callback form) because `bindings` is an
 *  array — koota forbids array fields in the plain object (SoA) form. The callback
 *  runs per entity, so each element gets its OWN fresh `bindings` array (no shared
 *  default). applyBindings only reads it and the editor replaces it immutably, so
 *  never mutate the live array in place. `.schema` is undefined for AoS traits;
 *  serialize/prefab snapshot fall back to the registered field list. */
export const UIAction = trait(() => ({
  bindings: [] as UIActionBinding[],
}));

export type UIActionEvent = 'click' | 'change' | 'submit';
export type UIActionKind = 'set' | 'call';

/** One event→response binding on a UIAction. This is the trait's own schema —
 *  `ui/bindings.ts` (the applying logic) imports it from here, not the reverse. */
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
