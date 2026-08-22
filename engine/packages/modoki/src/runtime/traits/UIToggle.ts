import { trait } from 'koota';

/** UIToggle — a scene-authored boolean on/off switch (a track with a knob that slides
 *  between two ends). Opt-in: add it alongside `UIElement` on a UI entity and that
 *  entity renders as a switch instead of a plain box.
 *
 *  ## Why a trait and not another `UIElement.elementType`
 *
 *  The engine's two existing control variants (`input`, `range`) are values of
 *  `UIElement.elementType`, and `docs/ui-system.md` says rendering is content-driven —
 *  so the precedent points the other way. It was departed from deliberately (#280):
 *  `UIElement` is already ~73 fields, and toggle-specific ones there would ride on every
 *  UI entity in every game, nearly all of them dead. `Canvas2D` and `UIFocusable` are
 *  already opt-in traits sitting BESIDE `UIElement`, so "an opt-in capability gets its
 *  own trait" is established — it had just never been used for a *control* before.
 *
 *  ## It does NOT write its own value — and that is load-bearing
 *
 *  A click fires `applyBindings(bindings, 'change', { eventValue: !value })`. The
 *  canonical authoring is a `set` binding onto this trait's own `value` with `'$value'`
 *  (leave `target` empty to mean "my own entity"), which is exactly the shape the range
 *  slider uses. Pair it with a `call` binding when the game must also DO something —
 *  persist the preference, retune a service — and both fire from the one click.
 *
 *  The reason the branch does not just write `value` itself: `applyBindings` early-returns
 *  when the sim is not running, so a self-write would mutate the scene from the editor
 *  while Stopped, which `docs/ui-system.md` forbids. It also keeps ONE writer for one
 *  value instead of two that can disagree.
 *
 *  The cost is that a toggle authored with no binding is silently dead, which is a real
 *  failure class — so `UINode` warns in dev when a `UIToggle` entity carries no binding
 *  that could move it.
 *
 *  ## Reading it back
 *
 *  `value` is the live truth and what gets drawn. A game that restores a saved preference
 *  writes it here at boot (and must `markUIDirty()` if it does so through a raw ECS write
 *  rather than through a UIAction — the repaint invariant in `UIBinding.ts`).
 *
 *  All fields are scalar → serializes cleanly, is editor-authorable, and passes the
 *  trait-scalar guard. */
export const UIToggle = trait({
  /** The live boolean. This is what the knob's position and the track's colour are drawn
   *  from; it is NOT written by the control itself (see the header). */
  value: false as boolean,

  /** Track fill while on / off. */
  trackOnColor: 0x4aa3ff as number,
  trackOffColor: 0x767676 as number,
  /** Track fill opacity. Stated explicitly rather than borrowed from
   *  `UIElement.backgroundOpacity`, which defaults to **0** — an authored colour with no
   *  opacity paints nothing, and that trap has already shipped an invisible panel. */
  trackOpacity: 1 as number,

  /** The sliding knob. */
  knobColor: 0xffffff as number,
  knobOpacity: 1 as number,
  /** Gap in CSS px between the knob and the track's edge, on every side. The knob is
   *  square and its size falls out of the track's height minus twice this. */
  knobInset: 2 as number,

  /** Corner radii. 999 gives a capsule at any height, which is the default look. */
  trackRadius: 999 as number,
  knobRadius: 999 as number,

  /** Dims the control and refuses the click. A disabled toggle still DRAWS its `value` —
   *  it reports state it will not let you change, rather than going blank. */
  disabled: false as boolean,
});
