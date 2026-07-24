/** Pointer input source — the mouse/touch modality of the source-agnostic input
 *  seam. The single active pointer (mouse, or the primary touch of a multi-touch
 *  gesture) is tracked from Pointer Events on `window` and merged into the shared
 *  `InputFrame` as a `PointerFrame` (position + down + drag delta). Game/UI logic
 *  reads it via the `Input` resource accessors (`pointerPressed`/`pointerDrag`/…),
 *  never from `window` — the input-source guard enforces that games route through
 *  here instead of adding their own `window.addEventListener('pointer…')`.
 *
 *  Only tracks LEVEL state (down + position); the down-EDGE (`pressed`/`released`)
 *  is derived centrally by `inputSystem` (`computePointerEdge`), same discipline as
 *  the keyboard/gamepad sources — this source stays a pure reporter.
 *
 *  Android/touch robustness (the reason this exists): a raw `pointercancel` from the
 *  browser reclaiming a touch for a scroll/zoom gesture must NOT read as a normal
 *  release — otherwise a drag-to-aim gets cancelled mid-gesture. So:
 *    - we `setPointerCapture` on press, so moves keep flowing to us even outside the
 *      original element, and
 *    - `pointercancel` ends the gesture as a plain up (down=false) — the same as
 *      release; combined with the app's `touch-action: none` on the game canvas
 *      (which stops the browser stealing the gesture in the first place) the cancel
 *      path is rarely hit at all.
 *
 *  Guards `typeof window` so importing it headless is inert; no wall-clock / no RNG.
 *  The primary-touch rule: the FIRST pointer down owns the gesture (its pointerId is
 *  latched); later pointers are ignored until it lifts — so a second finger can't
 *  hijack an in-progress drag. */

import type { InputSource } from './inputSources';
import type { InputFrame } from './actions';
import { getPlayState, onPlayStateChange } from '../systems/playState';

// Tracked level state of the owning pointer. `activeId` is the pointerId that owns
// the current gesture (null = no pointer down). start* latch on press for the drag delta.
let down = false;
let x = 0;
let y = 0;
let startX = 0;
let startY = 0;
let activeId: number | null = null;
let active = false;         // saw activity since last sample → sets lastDevice='pointer'
let attached = false;
let offPlayState: (() => void) | null = null;
// Accumulated scroll-notch delta since the last sample (+down / −up), one unit per
// wheel event; drained to `pointer.wheel` each frame and re-zeroed. Transient, not
// latched level state — so it's cleared on reset() too.
let wheelAccum = 0;

function reset(): void { down = false; activeId = null; wheelAccum = 0; }

function onPointerDown(e: PointerEvent): void {
  if (activeId !== null) return;           // a gesture already owns the pointer
  activeId = e.pointerId;
  down = true;
  x = e.clientX; y = e.clientY;
  startX = x; startY = y;
  active = true;
  // Keep receiving moves even if the finger/cursor leaves the original element.
  const el = e.target as Element | null;
  try { el?.setPointerCapture?.(e.pointerId); } catch { /* capture is best-effort */ }
}

function onPointerMove(e: PointerEvent): void {
  if (e.pointerId !== activeId) return;
  x = e.clientX; y = e.clientY;
  active = true;
}

/** Up OR cancel: end the gesture. `pointercancel` is treated identically to `up`
 *  (a plain release) rather than as an abort, so a browser-reclaimed touch doesn't
 *  strand `down=true` forever — the consumer sees a clean released edge. */
function onPointerUp(e: PointerEvent): void {
  if (e.pointerId !== activeId) return;
  x = e.clientX; y = e.clientY;
  down = false;
  activeId = null;
  active = true;
}

/** Wheel/scroll — accumulate one signed notch per event (magnitude-agnostic, so a
 *  free-spinning vs clicky wheel behave the same). Passive listener, no
 *  `preventDefault`, so it never fights editor-panel scrolling. */
function onWheel(e: WheelEvent): void {
  if (e.deltaY === 0) return;
  wheelAccum += Math.sign(e.deltaY);
  active = true;
}

export const pointerSource: InputSource = {
  name: 'pointer',

  attach(): void {
    if (attached || typeof window === 'undefined') return;
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('wheel', onWheel, { passive: true });
    // Drop a stale press each time the sim (re)starts, so a pointer left down across
    // a Play toggle can't leak a held drag into the first play frame.
    offPlayState = onPlayStateChange(() => { if (getPlayState() === 'playing') reset(); });
    attached = true;
  },

  detach(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('wheel', onWheel);
    }
    offPlayState?.(); offPlayState = null;
    reset(); active = false; attached = false;
  },

  /** Drop latched pointer state without detaching — host input gate closing edge. */
  reset(): void { reset(); },

  sample(out: InputFrame): void {
    // Authoritative: overwrite the pointer level state wholesale (no OR-merge —
    // there is one pointer). Edge (pressed/released) is derived by inputSystem.
    const p = out.pointer;
    p.x = x; p.y = y; p.down = down;
    p.startX = startX; p.startY = startY;
    p.dragX = down ? x - startX : 0;
    p.dragY = down ? y - startY : 0;
    p.wheel = wheelAccum; wheelAccum = 0; // transient per-frame delta, consumed here
    if (active) { out.lastDevice = 'pointer'; active = false; }
  },
};
