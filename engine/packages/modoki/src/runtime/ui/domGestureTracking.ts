/** domGestureTracking — whether a native TOUCH gesture is CURRENTLY held down anywhere in the
 *  DOM, independent of the canvas-scoped `Input` resource (`runtime/input/pointerSource.ts`).
 *
 *  `Input.pointer` deliberately EXCLUDES a press that starts on a pointer-block root (the
 *  UIRenderer/DOM chrome layer — see `pointerSource.ts`'s own header and `core/pointerBlockers
 *  .ts`) by design: that input is meant to be handled by the DOM/React layer, not fed into
 *  gameplay. This exists for the opposite case — something that needs to know a NATIVE DOM
 *  gesture is live, regardless of which layer owns it, most commonly a touch-scroll on a
 *  `UIScrollView` box. The scroll views affected (a store item list, a level selector) are DOM
 *  chrome, exactly what `Input.pointer` cannot see.
 *
 *  ⚠️ **The ORIGINAL motivating consumer is gone, and this module is not.** #579 added this so
 *  Court could defer `getSafeAreaInsets()`'s forced-layout probe while a gesture was live —
 *  forcing that layout mid-drag desynced WebKit's native touch-scroll compositor on old hardware.
 *  #612 fixed that at its source: `safeArea.ts` is push-based and forces no layout at all, so
 *  Court's `boardSafeAreaInsets()` wrapper was deleted. The LIVE consumer today is Court's
 *  `relayoutBoardIfHostMoved` (`games/court/runtime/systems.ts`), which defers its own
 *  `getBoundingClientRect` host re-measure for the same reason, against the same compositor.
 *  Keep the #579 history: it is why this file is shaped the way it is, and `docs/input.md`'s
 *  raw-listener exemption still points here.
 *
 *  ⚠️ **TOUCH ONLY — no mouse, and that is a correction, not the original design.** A first cut
 *  also tracked Pointer Events for mouse/pen (mirroring `scrollAnchor.ts`, where a real mouse
 *  drag genuinely races that file's own `restore()`). Review found that justification does not
 *  transfer here: the thing this file exists to protect is WebKit's native TOUCH-scroll
 *  compositor, which a mouse press cannot start or desync, so tracking mouse bought nothing for
 *  the stated purpose — while costing something real, because `registerGameSystems` wires this
 *  in the EDITOR too, where the game runtime and the editor chrome share one `document`. Held
 *  mouse buttons are common there (orbiting SceneView, dragging a gizmo, scrubbing a slider), and
 *  each one froze `relayoutBoardIfHostMoved` (and, at the time, `boardSafeAreaInsets`) for the
 *  duration — silently
 *  breaking the live-tuning loop `CLAUDE.md` § "Author values in the SCENE" depends on (a
 *  `boardCaptionGap` retune stopped moving the board until mouse-up). TOUCH is tracked via
 *  `touchstart`/`touchend`/`touchcancel` specifically (never `pointerdown`/`pointerup`) for the
 *  reason `scrollAnchor.ts`'s header explains at length and a jsdom probe proved (#579
 *  close-out): once a box lets the browser scroll it natively, the browser reclaims the touch as
 *  a pan almost immediately and fires `pointercancel` while the finger is still down, which would
 *  disarm a pointer-tracked "gesture" within the first few px — before the drag that actually
 *  needs protecting has even begun.
 *
 *  ⚠️ **The safety timeout resets on `touchmove`, not just `touchstart`.** `scrollAnchor.ts`'s own
 *  `GESTURE_SAFETY_MS` can assert "no real gesture runs anywhere near this long" because that
 *  file's gestures are quick settle-and-release interactions. This file's motivating case is
 *  different by nature: browsing a long list (Court's level selector runs to hundreds of
 *  entries) with a finger down for MORE than a few seconds is completely ordinary. A timer that
 *  only measured "since the gesture started" would fire mid-browse, silently un-gate the deferred
 *  re-measure, and reproduce the original stall for the rest of that same touch. Resetting the
 *  deadline on every `touchmove` makes it mean "no activity for `SAFETY_MS`", which only degrades
 *  when a finger is held stationary and dead — the case the timeout actually exists for.
 *
 *  ⚠️ **#595 — the listeners stay at `document`/`window` scope, but `onStart`/`onMove` now filter
 *  by TARGET.** This is the touch counterpart of the mouse bug the header above already describes:
 *  `registerGameSystems` wires this module in the Electron EDITOR too, where the game runtime and
 *  the editor's own chrome (Hierarchy, Inspector, viewport gizmos, panel dividers) share one
 *  `document`. On touch-capable dev hardware a touch anywhere on that chrome set `active = true`
 *  document-wide, gating `relayoutBoardIfHostMoved` for the duration — same shape of bug as the
 *  mouse case, one layer down (target, not event type). The listeners cannot simply move to a
 *  narrower DOM root: which element IS the game's surface is not known here and changes at
 *  runtime, so the fix filters the already-`document`-scoped event by its `target` instead.
 *  `core/pointerBlockers.ts`'s `isInsideGameSurface` is the right test for that — its registry is a
 *  union of `UIRenderer`'s block root (registered in RUNTIME mode ONLY, `if (!onSelectEntity)`, so
 *  the editor's chrome is excluded by construction) and the game canvas passthrough surface, and it
 *  fails OPEN to document-wide tracking when nothing is registered yet, so this stays exactly as
 *  permissive as before in every context that isn't the editor-with-chrome-and-a-mounted-game case
 *  this exists to fix. `onEnd` stays UNGATED on purpose — see its own comment below.
 *
 *  ⚠️ **The fix's precondition: the filter only discriminates once something is REGISTERED in
 *  `core/pointerBlockers.ts`.** While both registries are empty it fails open, and a touch on
 *  editor chrome still activates — e.g. a GameView that is closed, or one that has not yet mounted
 *  its `UIRenderer` (which returns null while `tree.length === 0`). Court is 2D and entirely
 *  UI-driven, so its registry is populated whenever the game is up — but a future consumer whose
 *  registry can stay empty with the game running should know this boundary before relying on it. */

import { isInsideGameSurface } from '../core/pointerBlockers';

let active = false;
let safetyTimer: ReturnType<typeof setTimeout> | null = null;
const SAFETY_MS = 5000;
let wired = false;

function armSafetyTimer(): void {
  if (safetyTimer !== null) clearTimeout(safetyTimer);
  safetyTimer = setTimeout(onEnd, SAFETY_MS);
}
function onStart(e: TouchEvent): void {
  if (!isInsideGameSurface(e.target)) return;
  active = true;
  armSafetyTimer();
}
/** Keeps the safety deadline alive for as long as the touch keeps moving — see this file's own
 *  header for why a fixed "since start" timeout is wrong for this file's motivating case.
 *
 *  ⚠️ **Unconditionally sets `active = true` — an earlier version gated that on the CURRENT value
 *  of `active` (`if (active) armSafetyTimer()`), which review found reopens the exact stall this
 *  file exists to close.** Once the safety timer fires mid-touch (finger held still ≥`SAFETY_MS`
 *  — the ordinary "paused reading a list item" case this file's header already calls out),
 *  `active` drops to `false` and stays there: a gated re-arm can only ever re-arm an ALREADY-active
 *  gesture, so no subsequent `touchmove` — however much the finger then moves — can ever set it
 *  back to `true`. The gate silently stays off for the rest of that same touch, and the original
 *  forced-layout compositor stall returns on the very next scroll. `touchmove` firing at all
 *  already means a finger is down (there is no `touchmove` this file did not see a `touchstart`
 *  for first), so this always means a gesture is live — including recovering from a safety-timer
 *  false positive, which is bounded by `SAFETY_MS` either way.
 *
 *  Gated the same way as `onStart` (see #595 in the module header) — a `touchmove`'s `target` is
 *  fixed to its `touchstart`'s target per spec, so gating both on the same test is consistent: a
 *  move that belongs to a start this module never activated for stays filtered too. */
function onMove(e: TouchEvent): void {
  if (!isInsideGameSurface(e.target)) return;
  active = true;
  armSafetyTimer();
}
/** ⚠️ **Deliberately UNGATED by target — the #595 filter above applies to `onStart`/`onMove` only.**
 *  A release can land off-element (or squarely on editor chrome) even when the gesture it ends
 *  started on the game surface, so gating `onEnd` the same way would leave `active` stuck `true`
 *  with nothing left able to clear it — the "a mechanism that cannot fire" defect, one level up
 *  from the safety timer this file already guards against for the same reason. */
function onEnd(e?: TouchEvent): void {
  // A multi-touch release: only the FINAL finger lifting ends the gesture. `scrollAnchor.ts` has
  // the identical simplification (per-box, one scroll gesture at a time); this is a wider,
  // `document`-scoped listener, so the same gap is reached more easily — a second finger tapping
  // HUD chrome mid-scroll must not un-gate the probe out from under the first finger's drag.
  if (e && e.touches.length > 0) return;
  if (safetyTimer !== null) { clearTimeout(safetyTimer); safetyTimer = null; }
  active = false;
}

/** Wire the listeners. Idempotent, and a no-op headlessly. A game calls this once from its own
 *  register hook (Court: `registerGameSystems`) — kept explicit rather than a module-load side
 *  effect, matching this file's siblings (`scrollAnchor.ts` wires from a React effect;
 *  `safeArea.ts` wires its own single `visibilitychange` listener lazily, from the first real
 *  registration, rather than at import — #592): an unconditional `addEventListener` at import
 *  time would fire in every embedding context that imports this module, wanted or not.
 *
 *  ⚠️ `wired` is a plain boolean, not refcounted, unlike its sibling `core/pointerBlockers.ts`
 *  (deliberately refcounted so a second registrant cannot silently undo a first). There is
 *  exactly one consumer today (Court). If a second game starts using this module, `wired` needs
 *  the same refcount treatment first — a second `unwireDomGestureTracking()` call would otherwise
 *  tear down the first consumer's listeners out from under it with no way to detect the desync. */
export function wireDomGestureTracking(): void {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchmove', onMove, { passive: true });
  window.addEventListener('touchend', onEnd, { passive: true });
  window.addEventListener('touchcancel', onEnd, { passive: true });
}

/** Tear the listeners down — a game's unregister hook, matching `wireDomGestureTracking`'s call
 *  site. Also resets `active`, so a game that unregisters mid-gesture does not leave a later
 *  reader of `isDomGestureActive()` permanently gated by a gesture nothing will ever end. */
export function unwireDomGestureTracking(): void {
  if (!wired) return;
  wired = false;
  document.removeEventListener('touchstart', onStart);
  document.removeEventListener('touchmove', onMove);
  window.removeEventListener('touchend', onEnd);
  window.removeEventListener('touchcancel', onEnd);
  if (safetyTimer !== null) { clearTimeout(safetyTimer); safetyTimer = null; }
  active = false;
}

/** Is a native touch gesture currently held down anywhere in the DOM? */
export function isDomGestureActive(): boolean { return active; }

/** For tests: force the flag back to its rest state without touching whether the listeners are
 *  wired — mirrors `resetSafeAreaInsets`'s own teardown role for its sibling module state. */
export function resetDomGestureTracking(): void {
  if (safetyTimer !== null) { clearTimeout(safetyTimer); safetyTimer = null; }
  active = false;
}
