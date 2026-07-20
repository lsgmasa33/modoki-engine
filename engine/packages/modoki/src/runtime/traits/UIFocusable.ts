import { trait } from 'koota';

/** UIFocusable — marks a UI entity as reachable by directional focus navigation, so
 *  a controller/keyboard can traverse and activate UI without a pointer (Part B of the
 *  input-and-ui-focus plan). Purely additive: pointer/touch is unchanged, and focus is
 *  inert until nav input arrives.
 *
 *  Focus is resolved per active SCOPE (a menu/screen/modal grouping) so it never jumps
 *  between an open modal and the screen behind it. Within a scope, directional movement
 *  resolves in order: (1) an explicit hand-authored nav link (`nav*` GUID) if set, else
 *  (2) spatial nearest-in-direction using on-screen rects. `focusManager` owns the state
 *  + resolution; `uiFocusSystem` drives it from the `Input` resource.
 *
 *  All fields are scalar (GUID strings / number / booleans) → serializes cleanly, is
 *  editor-authorable, and passes the trait-scalar guard. v1 is OPT-IN: only entities
 *  carrying this trait are focusable (auto-focusability for any interactive element is
 *  a deliberate follow-up, to avoid changing existing pointer-only games). */
export const UIFocusable = trait({
  /** Whether this element participates in focus navigation. */
  focusable: true as boolean,
  /** Tie-break order within a scope (lower = earlier); seeds autofocus + is a stable
   *  fallback when no spatial rect is available (e.g. headless). */
  focusOrder: 0 as number,
  /** Explicit directional links (target UI entity GUIDs). Empty → fall back to spatial
   *  resolution. Authoring these pins a menu's traversal regardless of layout. */
  navUp: '' as string,
  navDown: '' as string,
  navLeft: '' as string,
  navRight: '' as string,
  /** Scope key grouping a screen/menu/modal. Focus only moves among same-scope
   *  elements; the active scope is the top of the focus scope stack ('' = default). */
  focusScope: '' as string,
  /** When this element's scope becomes active and nothing is focused, focus lands here
   *  first. If several are marked, the lowest `focusOrder` wins. */
  autoFocus: false as boolean,
});
