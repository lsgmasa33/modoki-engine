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
export const UIAction = trait((): UIActionData => ({
  bindings: [] as UIActionBinding[],
}));

/** `UIAction`'s shape. */
export interface UIActionData {
  bindings: UIActionBinding[];
  /** Press feedback override (#2011): the scale this element grows to while held. Absent or `0`
   *  inherits the scene-wide `UISettings.pressScale`; `1` turns it off for this element; any
   *  other value overrides the scene. Only read when the element has a `click` binding.
   *
   *  ⚠️ **Optional, and deliberately absent from the factory's defaults.** koota hands an AoS
   *  trait's spawn PARAMS straight through without running the factory, so every scene-loaded
   *  `UIAction` has no `pressScale` whatever the factory says — a `-1` default there would give
   *  the same state two on-disk forms (review). Absent therefore has to MEAN "inherit", and the
   *  Inspector shows it as 0, which is why 0 is the inherit value. Optional in the type too: the
   *  spawn param type is this whole interface, and a required field broke every
   *  `UIAction({ bindings })` call. */
  pressScale?: number;
}

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
