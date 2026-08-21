import { trait } from 'koota';

/** TouchControl — this UI element is an on-screen input control (a d-pad arrow, a jump
 *  button), and holding it drives the same action a key or a gamepad button drives.
 *
 *  ## Why a trait on a UI entity, and not an engine-drawn overlay
 *
 *  The engine draws NOTHING here. A control is an ordinary `UIElement` — the game authors its
 *  art (`imageSrc`, a nine-slice sprite, a border-radius box), its size and its placement
 *  (`UIAnchor`, ideally with `safeArea: true` so a bottom-anchored pad clears the home
 *  indicator / gesture bar), exactly as it authors the rest of its HUD. This trait only says
 *  *what pressing it means*. That is the whole "other games use it with their own art"
 *  requirement, and it is also the repo's standing rule: a control's size, position and look
 *  are things the owner will plausibly want different after seeing them on screen, so they are
 *  authored data, not engine constants.
 *
 *  A **d-pad is four entities**, one per direction (or eight, with diagonals as their own
 *  buttons — nothing here assumes four). A jump button is a fifth. There is no "d-pad widget"
 *  to configure, because every extra layer of configuration would be a layer of layout the
 *  game could not override.
 *
 *  ## How the press reaches the game
 *
 *  `runtime/input/touchControlSource.ts` is a normal `InputSource`: it merges these presses
 *  into the same `InputFrame` the keyboard and the gamepad merge into, so a game reading
 *  `inputAxis(world,'moveX')` needs no change and cannot tell the difference. It resolves
 *  controls from the DOM by the `data-modoki-touch` attribute `UINode` stamps from this trait
 *  — `ui/` (L2) has no import edge to `input/` (L2), and it does not need one: the trait is
 *  L1, the attribute is the seam.
 *
 *  ⚠️ **The entity must be a plain `div`** — not a `UIElement.elementType` of `input`/`range`,
 *  and not something also carrying a `UIToggle`. Those render through earlier `UINode` branches
 *  that do not stamp the control attribute, so the trait would be authored and inert; it is
 *  refused with a DEV warning instead.
 *
 *  ⚠️ **Do not reach for `UIAction` for this.** Its vocabulary is `click`/`change`/`submit` —
 *  discrete events, fired on release. A movement control is a LEVEL: held for as long as the
 *  thumb is down, released the instant it lifts. There is no way to express that with a click,
 *  which is why this is a separate trait rather than a fifth `UIActionEvent`. */
export const TouchControl = trait({
  /** What holding this control means, in the source-agnostic action vocabulary
   *  (`core/inputActions.ts`). The four `move*` values push the locomotion axes AND raise the
   *  matching `nav*` flag, so the same pad drives a character and a menu — exactly what the
   *  keyboard's arrow keys already do. */
  action: 'moveLeft' as TouchControlAction,
  /** When this control is MOUNTED at all.
   *   - `touch` (default) — only on a handheld (`core/formFactor.ts`). A desktop player never
   *     sees a d-pad over their scene, and a phone player is never left without one.
   *   - `always` — mount everywhere. For authoring: the editor's SceneView preview and a
   *     desktop GameView are both `desktop`, so a `touch` control is invisible while you are
   *     positioning it. Flip to `always` to lay it out, flip back before you ship.
   *   - `never` — authored but disabled, without deleting the entity. */
  showOn: 'touch' as TouchControlShowOn,
  /** Element opacity while held, as the press feedback — 0…1, and `1` disables it.
   *
   *  Applied by the input source straight to the element's inline style, NOT through the UI
   *  projection: a rebuild of the whole UI tree on every press and release of a d-pad is a
   *  frame's work for a highlight, and the thumb is pressing at 10 Hz. The source refcounts it
   *  per ELEMENT so two thumbs on one arrow cannot leave it stuck dimmed, and `1` means the
   *  element's opacity is never written at all rather than written back as empty. */
  pressedOpacity: 0.6,
});

/** The actions a touch control can drive. A deliberate SUBSET of the full vocabulary: the four
 *  locomotion directions, plus the digital actions a player can plausibly need a button for.
 *  `nav*` is absent as a standalone value because the `move*` values already raise it. */
export const TOUCH_CONTROL_ACTIONS = [
  'moveLeft', 'moveRight', 'moveForward', 'moveBack',
  'jump', 'aim', 'confirm', 'cancel', 'menu', 'pause',
] as const;
export type TouchControlAction = (typeof TOUCH_CONTROL_ACTIONS)[number];

/** The DOM seam between the two L2 subsystems that must agree about a touch control.
 *
 *  `ui/` stamps these onto the element; `input/` resolves controls by them. Neither may import
 *  the other (both L2), so the names live HERE, next to the trait they are derived from — the
 *  same shape as `core/pointerBlockers.ts` living in L0 because `ui` and `input` both need it. */
export const TOUCH_ATTR = 'data-modoki-touch';
/** Per-element held opacity, stamped alongside it (`TouchControl.pressedOpacity`). */
export const TOUCH_OPACITY_ATTR = 'data-modoki-touch-opacity';
/** Marks a `UIRenderer` root as the RUNTIME one, vs the editor's authoring preview — where a
 *  press means "select this entity" and must never drive the game. */
export const UI_ROOT_ATTR = 'data-modoki-ui-root';

export const TOUCH_CONTROL_SHOW_ON = ['touch', 'always', 'never'] as const;
export type TouchControlShowOn = (typeof TOUCH_CONTROL_SHOW_ON)[number];
