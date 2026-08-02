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
 *  hijack an in-progress drag.
 *
 *  EDGE LATCHING. Level state alone can silently drop a whole press+release: if both
 *  happen between two `inputSystem` samples, the down/up cancel out and NEITHER a
 *  pressed nor released edge is ever seen — worse, if a press is followed by several
 *  moves before the next sample, level state reports the LATEST move position as if
 *  it were where the press happened, corrupting anything that reads the down point
 *  (a drag's start, a tap's aim). So `down`/`up` also push onto a small FIFO of
 *  transitions (`pending`, capped) carrying their own exact `{x,y,startX,startY}`;
 *  `sample()` drains at most one transition per frame BEFORE falling back to level
 *  state, so a press and its matching release are always reported as two distinct
 *  samples, each with its own true coordinates — a press+release inside one frame
 *  now yields pressed on frame N and released on frame N+1, rather than vanishing.
 *  A drained RELEASE transition reports the TRUE final `dragX/dragY` (not zeroed) —
 *  matching `PointerFrame`'s documented contract ("a tap is a pressed with a small
 *  dragX/dragY AT released") — so a consumer that computes a fling/throw/launch from
 *  `pointerReleased() + pointerDrag()` together still sees the real magnitude.
 *
 *  POINTER-BLOCK ROOTS (`core/pointerBlockers.ts`). A DOM overlay sibling of the
 *  game canvas (the engine `UIRenderer`, the debug menu panel, a game's own hand-
 *  built chrome like Court's rules dialog) can register itself so a pointerdown/
 *  wheel that starts on it never reaches the game. The filter is applied HERE, at
 *  ingestion — in `onPointerDown`/`onWheel`, before `activeId` latches or
 *  `setPointerCapture` is called — never inside `sample()`. Filtering at read-time
 *  instead would be wrong: a blocked press has already been pushed onto `pending`
 *  (the FIFO above), and masking it out there breaks the down/up alternation
 *  `pushTransition`'s comment describes, so `computePointerEdge` would swallow the
 *  gesture silently. Filtering at ingestion means a blocked pointer never latches
 *  `activeId` at all, so subsequent moves/up for it already no-op via the existing
 *  `pointerId !== activeId` checks below — for free, with no additional state, and
 *  a SECOND pointer landing on the canvas becomes the active gesture (the only real
 *  multitouch benefit available here — `pointerSource` tracks a single pointer, so
 *  there is nothing to key a claim by `pointerId`; see the module's git history /
 *  `docs/todo.md` for the earlier per-pointerId design this replaced). Because the
 *  decision is recomputed from the live DOM at every event rather than latched into
 *  a claim, a registration can never "leak" — there is no claim state to strand. */

import type { InputSource } from './inputSources';
import type { InputFrame } from '../core/inputActions';
import { getPlayState, onPlayStateChange } from '../core/playState';
import { isPointerBlocked } from '../core/pointerBlockers';
import { peekCurrentWorld } from '../core/ecs/worldRegistry';
import { emit } from '../core/journal';

/** One press or release event, captured with the exact coordinates it occurred at
 *  (not the coordinates by the time it's sampled). `startX/startY` snapshot the
 *  gesture's down point so a drained `up` still reports the correct drag origin
 *  even if a later gesture has since latched a new module-level `startX/startY`. */
interface PointerTransition { down: boolean; x: number; y: number; startX: number; startY: number }

// Cap on queued transitions awaiting drain — real gestures produce at most one down
// and one up per frame-gap; this only guards against a pathological event storm.
const MAX_PENDING = 16;

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
// Queued down/up transitions awaiting drain by `sample()`, oldest first.
const pending: PointerTransition[] = [];

function reset(): void { down = false; activeId = null; wheelAccum = 0; pending.length = 0; }

function pushTransition(t: PointerTransition): void {
  // Drop the NEWEST on overflow, not the oldest: dropping the oldest can leave an
  // `up` at the head with no matching `down` ahead of it in the queue, which breaks
  // down/up alternation — `computePointerEdge` then sees `now=false, prev.down=false`
  // and emits NEITHER a pressed nor released edge, silently swallowing a whole
  // gesture (the exact failure class this FIFO exists to kill). Refusing the newest
  // push instead preserves the drained prefix's alternation; only reachable under a
  // pathological event storm (MAX_PENDING), never in a real single/double gesture.
  if (pending.length >= MAX_PENDING) return;
  pending.push(t);
}

function onPointerDown(e: PointerEvent): void {
  if (activeId !== null) return;           // a gesture already owns the pointer
  if (isPointerBlocked(e.target)) {
    // Never latch `activeId` for a blocked press — the whole gesture (its later
    // move/up) already falls through the `pointerId !== activeId` checks below
    // for free, with no claim state to strand. A second, unblocked pointer can
    // still land on the canvas and become the active gesture.
    if (import.meta.env.DEV) {
      const world = peekCurrentWorld();
      if (world) emit('input.pointer.blocked', { x: e.clientX, y: e.clientY }, world);
    }
    return;
  }
  activeId = e.pointerId;
  down = true;
  x = e.clientX; y = e.clientY;
  startX = x; startY = y;
  active = true;
  pushTransition({ down: true, x, y, startX, startY });
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
  pushTransition({ down: false, x, y, startX, startY });
}

/** Wheel/scroll — accumulate one signed notch per event (magnitude-agnostic, so a
 *  free-spinning vs clicky wheel behave the same). Passive listener, no
 *  `preventDefault`, so it never fights editor-panel scrolling. */
function onWheel(e: WheelEvent): void {
  if (e.deltaY === 0) return;
  // Unlike pointerdown, this check is correct PER EVENT: a wheel notch is not a
  // gesture, so there is no "hold for the whole gesture" argument here — a
  // registered root (e.g. a scrollable DOM list) should block only the notches
  // that land on it, not every notch for the rest of time.
  if (isPointerBlocked(e.target)) return;
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
    const t = pending.shift(); // drain at most one queued transition this frame
    if (t) {
      p.down = t.down; p.x = t.x; p.y = t.y;
      p.startX = t.startX; p.startY = t.startY;
      // Report the true delta even on a drained RELEASE transition (down:false) —
      // forcing it to 0 here would discard the gesture's final magnitude on the one
      // frame a consumer reading pointerReleased()+pointerDrag() together expects it
      // (a fling/throw/launch computed at release, not during the hold).
      p.dragX = t.x - t.startX;
      p.dragY = t.y - t.startY;
    } else {
      p.x = x; p.y = y; p.down = down;
      p.startX = startX; p.startY = startY;
      p.dragX = down ? x - startX : 0;
      p.dragY = down ? y - startY : 0;
    }
    p.wheel = wheelAccum; wheelAccum = 0; // transient per-frame delta, consumed here
    if (active) { out.lastDevice = 'pointer'; active = false; }
  },
};
