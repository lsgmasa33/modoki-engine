/** Touch-control input source — on-screen d-pads and buttons, as a first-class modality.
 *
 *  The engine had NO touch locomotion of any kind (#297): every game here is either drag/tap
 *  native (sling, space-invader, chess, court) or keyboard-only, and `demos/forest-camp` — the
 *  flagship published demo, shipped with real iOS + Android native — told phone players
 *  "WASD to walk". This source is the general fix, not a demo-local one.
 *
 *  ## It is a SOURCE, not synthesized key events
 *
 *  The obvious implementation is to dispatch `KeyboardEvent`s for 'w'/'a'/'s'/'d' and let
 *  `keyboardSource` pick them up. It is worse in three ways that matter: `keyboardSource`'s
 *  `editing()` guard silently swallows them whenever a text field has focus; the events are
 *  `isTrusted:false`, so anything gating on that ignores them; and a key is binary forever,
 *  which forecloses the analog stick that shares this trait's seam. The engine already HAS the
 *  right abstraction — sources merge into one `InputFrame` and nothing downstream knows the
 *  modality — so this merges `moveX`/`moveY`/`held` like every other source, and a game
 *  reading `inputAxis(world,'moveX')` cannot tell a thumb from a keyboard.
 *
 *  ## One delegated listener set, not per-element handlers
 *
 *  Controls are resolved from the live DOM (`closest('[data-modoki-touch]')`, stamped by
 *  `UINode` from the `TouchControl` trait) rather than by React handlers on each control. That
 *  buys three things:
 *   - **`ui/` needs no import edge to `input/`** — both are L2 and may not reach each other.
 *     The attribute IS the seam; the trait (L1) is what both sides agree on.
 *   - **Nothing to re-bind.** The UI tree is rebuilt wholesale on `markUIDirty`; per-node
 *     handlers would churn with it, and a rebuild mid-press would drop the press.
 *   - **Sliding works for free.** A real d-pad lets the thumb roll from ← to ↑ without
 *     lifting. Because every move re-resolves the control under the finger
 *     (`elementFromPoint`), that is the default behaviour rather than a feature.
 *
 *  ## Multi-touch: this source is the reason two thumbs work at all
 *
 *  `pointerSource` tracks exactly ONE gesture (`activeId`, first finger wins) — walk-while-you-
 *  orbit is impossible through it. It works out because a press inside a pointer-block root
 *  never latches `activeId` (see `core/pointerBlockers.ts`), and `UIRenderer` registers the UI
 *  root as one: a thumb on the d-pad is invisible to `pointerSource`, leaving the NEXT finger
 *  free to become the camera drag. So this source keeps its own per-`pointerId` map and never
 *  goes through the shared single pointer.
 *
 *  ⚠️ That is a claim about the running browser, and it was verified on hardware rather than
 *  reasoned about — see docs/input.md § "On-screen touch controls".
 *
 *  RUNTIME UI ONLY. The editor mounts the same UI tree a second time inside SceneView's
 *  authoring preview, where a click means "select this entity"; a press there must never drive
 *  the game. `UIRenderer` marks its runtime root `data-modoki-ui-root="runtime"` (the same
 *  `!onSelectEntity` structural property that gates the pointer-block registration), and a
 *  control outside such a root is ignored. */

import type { InputSource } from './inputSources';
import type { InputFrame } from '../core/inputActions';
import {
  TOUCH_ATTR, TOUCH_OPACITY_ATTR, UI_ROOT_ATTR, type TouchControlAction,
} from '../traits/TouchControl';
import { noteUserInput } from '../core/userActivity';
import { rawNow } from '../core/clock';
import { getPlayState, onPlayStateChange } from '../core/playState';

interface Press {
  /** null while the finger has slid OFF every control but has not lifted — tracked, driving
   *  nothing, and able to resume if it slides back on. */
  action: TouchControlAction | null;
  /** The element currently under this finger — held so the press highlight can be lifted from
   *  the element it was applied to, even after the finger has slid onto another control. */
  el: HTMLElement | null;
}

/** Live press highlights, keyed by ELEMENT and refcounted — NOT stored per `Press`.
 *
 *  ⚠️ Per-press was wrong in two ways that both leave a HUD button rendered permanently
 *  "pressed" with no finger on it, and neither self-heals:
 *
 *   - **Two fingers on one arrow.** The second press captured the element's ALREADY-DIMMED
 *     style as if it were the original, so releasing in press order restored 0.55 and left it
 *     there forever. Not a race: `reset()` iterates `presses` in insertion order, so the host
 *     input gate's per-frame drain (and blur, and play-start) made it certain rather than
 *     likely. A later single press then re-captured 0.55 as ITS original, so the wrong value
 *     was self-perpetuating.
 *   - **A highlight that was never applied.** With `pressedOpacity: 1` (feedback deliberately
 *     off) the apply step bailed out but the clear step still wrote back its captured value —
 *     erasing an authored inline opacity the code had never touched.
 *
 *  Keying by element fixes both: exactly one entry owns the pre-press value, the first press
 *  writes it and the last release restores it, and an element with no entry is never written
 *  to at all. */
const highlights = new Map<HTMLElement, { count: number; prevOpacity: string }>();

const presses = new Map<number, Press>();
let attached = false;
let active = false;
let offPlayState: (() => void) | null = null;

/** Resolve the touch control under a DOM node, or null. Requires a RUNTIME UI root ancestor —
 *  see the module banner. */
function controlAt(target: EventTarget | null): HTMLElement | null {
  const el = target instanceof Element ? target.closest(`[${TOUCH_ATTR}]`) : null;
  if (!(el instanceof HTMLElement)) return null;
  const root = el.closest(`[${UI_ROOT_ATTR}]`);
  if (!root || root.getAttribute(UI_ROOT_ATTR) !== 'runtime') return null;
  return el;
}

function actionOf(el: HTMLElement): TouchControlAction | null {
  const a = el.getAttribute(TOUCH_ATTR);
  return a ? (a as TouchControlAction) : null;
}

function applyHighlight(p: Press): void {
  if (!p.el) return;
  const raw = p.el.getAttribute(TOUCH_OPACITY_ATTR);
  const o = raw == null ? 1 : Number(raw);
  // No feedback authored (or a nonsense value): register NOTHING, so the release path has
  // nothing to restore and cannot clobber an opacity this module never set.
  if (!Number.isFinite(o) || o >= 1) return;
  const live = highlights.get(p.el);
  if (live) { live.count++; return; }  // already dimmed by another finger — leave the style alone
  highlights.set(p.el, { count: 1, prevOpacity: p.el.style.opacity });
  p.el.style.opacity = String(Math.max(0, o));
}

function clearHighlight(p: Press): void {
  if (!p.el) return;
  const live = highlights.get(p.el);
  if (live && --live.count <= 0) {
    p.el.style.opacity = live.prevOpacity;
    highlights.delete(p.el);
  }
  p.el = null;
}

function endPress(id: number): void {
  const p = presses.get(id);
  if (!p) return;
  clearHighlight(p);
  presses.delete(id);
  active = true; // the RELEASE is activity too — the frame it lands on must still be sampled
}

function reset(): void {
  for (const id of [...presses.keys()]) endPress(id);
  presses.clear();
  // Every press is gone, so no highlight can still be owed. Restoring here as well would be
  // wrong (endPress already did it, and a second write would re-apply a stale value); this
  // just refuses to carry orphaned bookkeeping into the next gesture.
  highlights.clear();
}

function onPointerDown(e: PointerEvent): void {
  const el = controlAt(e.target);
  if (!el) return; // not ours — leave it to pointerSource (or to nothing)
  const action = actionOf(el);
  if (!action) return;
  noteUserInput(rawNow()); // see core/userActivity.ts — tier calibration must not judge an idle device
  const p: Press = { action, el };
  presses.set(e.pointerId, p);
  applyHighlight(p);
  active = true;
  // ⚠️ No `setPointerCapture` — the exact opposite of pointerSource. Capturing would pin every
  // later move to THIS element, and re-resolving under the finger is the whole point: capture
  // would break sliding from one arrow to the next, which is how a d-pad is actually used.
}

function onPointerMove(e: PointerEvent): void {
  const p = presses.get(e.pointerId);
  if (!p) return;
  // Re-resolve under the finger. `elementFromPoint` (not e.target) because the finger may have
  // travelled onto a sibling control, or off the pad entirely onto the scene behind it.
  const el = typeof document !== 'undefined'
    ? controlAt(document.elementFromPoint(e.clientX, e.clientY))
    : null;
  const action = el ? actionOf(el) : null;
  if (!action) {
    // Slid off every control: the press stops driving anything, but stays TRACKED under its
    // pointerId so sliding back on resumes it without lifting. A finger that leaves the pad
    // must not keep walking the character — that is the bug this branch exists for.
    clearHighlight(p);
    p.action = null;
    active = true;
    return;
  }
  if (el !== p.el) { clearHighlight(p); p.el = el; applyHighlight(p); }
  p.action = action;
  active = true;
}

function onPointerUp(e: PointerEvent): void { endPress(e.pointerId); }
function onBlur(): void { reset(); }
function onVisibility(): void { if (document.visibilityState === 'hidden') reset(); }

/** Which actions are held RIGHT NOW, deduplicated. Two fingers on the same arrow is one press
 *  worth of movement, not two — the axis is a direction, not an accumulator. */
function heldActions(): Set<TouchControlAction> {
  const out = new Set<TouchControlAction>();
  for (const p of presses.values()) if (p.action) out.add(p.action);
  return out;
}

export const touchControlSource: InputSource = {
  name: 'touch-control',

  attach(): void {
    if (attached || typeof window === 'undefined') return;
    // Passive: this source never calls preventDefault. Scroll/zoom/long-press suppression is
    // done in CSS by `UINode` (`touch-action: none`, `user-select: none`) on the control
    // itself, which is both cheaper and scoped to the element rather than to the window.
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    // `pointercancel` is a clean release, exactly as in pointerSource: Android reclaims a touch
    // for its own gesture navigation, and a stranded `down` would walk the character forever.
    window.addEventListener('pointercancel', onPointerUp, { passive: true });
    window.addEventListener('blur', onBlur);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    offPlayState = onPlayStateChange(() => { if (getPlayState() === 'playing') reset(); });
    attached = true;
  },

  detach(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', onBlur);
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    offPlayState?.(); offPlayState = null;
    reset(); active = false; attached = false;
  },

  /** Drop held controls without detaching — the host input gate's suppressed frames. Also
   *  lifts every press highlight, so the d-pad does not sit visibly lit while the editor has
   *  taken input away. */
  reset(): void { reset(); },

  sample(out: InputFrame): void {
    const actions = heldActions();
    if (actions.size === 0) { if (active) { out.lastDevice = 'pointer'; active = false; } return; }

    // Accumulate THIS source's own locomotion vector before merging, so the diagonal can be
    // normalized without touching another source's contribution.
    let dx = 0, dy = 0;
    for (const a of actions) {
      switch (a) {
        case 'moveLeft': dx -= 1; out.held.navLeft = true; break;
        case 'moveRight': dx += 1; out.held.navRight = true; break;
        case 'moveForward': dy += 1; out.held.navUp = true; break;   // forward/up = +1
        case 'moveBack': dy -= 1; out.held.navDown = true; break;
        default: out.held[a] = true; break;
      }
    }
    // ⚠️ Normalize the DIAGONAL. Holding ← and ↑ on a keyboard gives (−1, +1), a vector of
    // length √2, and every game in this repo takes the axes as a velocity — so walking
    // north-east is 41% faster than walking north. On a keyboard that has always been true and
    // players have always exploited it; on a d-pad the diagonal is a THUMB POSITION rather
    // than a deliberate two-key press, so the speed-up would read as the control being erratic.
    // Scaled here, in the source, because only the source knows which contributions are its
    // own — `clampAxes` runs after every source has merged and can only clamp, not normalize.
    if (dx !== 0 && dy !== 0) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
    out.axes.moveX += dx;
    out.axes.moveY += dy;

    // Touch reports as 'pointer': Pointer Events unify mouse/touch/pen and `InputDevice` has no
    // 'touch' member. Adding one would give prompt text a real "Tap" (see inputPrompts.ts), but
    // nothing needs it yet — a control's own VISIBILITY is a host question, answered by
    // `isTouchDevice()`, not by what was last pressed.
    out.lastDevice = 'pointer';
    active = false;
  },
};
