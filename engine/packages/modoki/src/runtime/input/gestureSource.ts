/** gestureSource — the multi-touch modality: pan, pinch and tap, derived from EVERY live pointer.
 *
 *  ## Why this is a second source rather than a change to `pointerSource`
 *
 *  `pointerSource` latches the FIRST pointerId and ignores every later one. That primary-touch rule
 *  is load-bearing — it is why a second finger cannot hijack an in-progress drag, and it is why
 *  "walk while you orbit" works at all (see `touchControlSource`'s header) — and the per-pointerId
 *  design it replaced was removed deliberately, with both that module and `core/pointerBlockers`
 *  carrying warnings against reopening it.
 *
 *  A pinch needs exactly the fingers that rule discards. So this source keeps its own list and
 *  listens to the same `window` events independently. Sources are independent listeners, so
 *  nothing here perturbs `pointerSource`: one owns the primary gesture, the other owns the shape of
 *  the whole hand. `touchControlSource` is the precedent — it is the other source that tracks
 *  pointers per id.
 *
 *  ## No wall clock
 *
 *  The tap window is measured from `e.timeStamp` on the pointer events themselves, never from
 *  `performance.now()` — the same clock `pointerSource` already uses for its velocity EMA. That is
 *  what keeps this file clear of the determinism guard, and it is possible because the one case a
 *  timer would be needed for (a finger held motionless past the tap window) has nothing to pan: the
 *  promotion is only ever OBSERVED on the next move or up event, both of which carry a timestamp.
 *
 *  ## The state machine (one finger)
 *
 *      down                  -> PENDING
 *      PENDING, moved > slop -> PANNING   (immediately — a flick must not wait out the tap window)
 *      PENDING, up  < tapMs  -> TAP
 *      PENDING, move ≥ tapMs -> PANNING   (a held finger that then drags)
 *
 *  Panning resumes from where the slop was crossed, not from the press origin, so the content does
 *  not jump by the slop radius the instant pan engages.
 *
 *  A second finger going down abandons any pan/tap candidacy and starts a PINCH; lifting back to
 *  one finger ENDS the gesture rather than silently resuming a pan, so a released pinch cannot
 *  fling the content with whatever the remaining finger does next.
 *
 *  Guards `typeof window` so importing it headless is inert; no wall-clock, no RNG. */

import { isPointerBlocked } from '../core/pointerBlockers';
import type { GestureFrame, InputFrame } from '../core/inputActions';
import type { InputSource } from './inputSources';

/** How long a press may last and still count as a tap, in ms. */
export const DEFAULT_TAP_MAX_MS = 250;
/**
 * How far a press may travel and still count as a tap, in CSS px.
 *
 * ⚠️ CSS px, not a game's design-space px, and that is deliberate: finger slop is a property of the
 * SCREEN, not of whatever reference resolution a game letterboxes into. 10 matches the platform
 * conventions this sits between — Android's 8 dp touch slop and iOS's ~10 pt — so the same number
 * is right on both without a per-game conversion.
 */
export const DEFAULT_TAP_SLOP_PX = 10;

/**
 * How far the cursor must leave the anchor before an emulated pinch ARMS, in CSS px.
 *
 * Not cosmetic — it is what makes the emulation well-defined at all. The two synthetic fingers
 * both start ON the anchor, so the initial spread is 0 and a scale RATIO against it would be
 * undefined. Arming at a real separation gives `pinchStartDist` an honest value to divide by.
 */
export const EMULATED_PINCH_SEED_PX = 24;

let tapMaxMs = DEFAULT_TAP_MAX_MS;
let tapSlopPx = DEFAULT_TAP_SLOP_PX;
// Mouse pinch emulation is a DEVELOPMENT affordance: a desktop has one cursor, and neither
// `modoki_pointer` nor `device_pointer` can drive two fingers, so without it a pinch consumer
// cannot be exercised anywhere but real hardware. Defaults to dev builds only.
let mouseEmulation = Boolean(import.meta.env?.DEV);

/** Retune the tap thresholds. A game calls this once at setup; both are feel knobs, so a game is
 *  expected to author its own values rather than inherit these. */
export function configureGestures(opts: { tapMaxMs?: number; tapSlopPx?: number; mouseEmulation?: boolean }): void {
  if (opts.tapMaxMs !== undefined) tapMaxMs = Math.max(0, opts.tapMaxMs);
  if (opts.tapSlopPx !== undefined) tapSlopPx = Math.max(0, opts.tapSlopPx);
  if (opts.mouseEmulation !== undefined) {
    mouseEmulation = opts.mouseEmulation;
    if (!mouseEmulation) cancelEmulation();
  }
}

/** Current thresholds — exported for tests and for a debug readout. */
export function getGestureConfig(): { tapMaxMs: number; tapSlopPx: number; mouseEmulation: boolean } {
  return { tapMaxMs, tapSlopPx, mouseEmulation };
}

interface LivePointer {
  id: number;
  x: number;
  y: number;
}

/** Pointers currently down, in the order they arrived. The first two drive the pinch. */
const live: LivePointer[] = [];

// 'dead' = fingers are still down, but this gesture is OVER and must not resume. Every phase
// transition out of a live gesture with a finger left over goes here, and only lifting them ALL
// returns to 'idle'.
type Phase = 'idle' | 'pending' | 'panning' | 'pinching' | 'dead';
let phase: Phase = 'idle';

// PENDING bookkeeping — where and when the single finger went down.
let downX = 0;
let downY = 0;
let downT = 0;

// The reference point pan deltas are measured from. Set to the CROSSING point when a pan is
// promoted (not to the press origin), so engaging pan does not jump the content by the slop.
let panRefX = 0;
let panRefY = 0;

// Accumulated across the events since the last sample() — events arrive faster than frames, so a
// per-frame delta must be summed rather than read off the newest event.
let panAccX = 0;
let panAccY = 0;

// Pinch bookkeeping.
let pinchStartDist = 0;
let lastSampledDist = 0;
let pinchBeganThisFrame = false;
let pinchEndedThisFrame = false;

// Whether the CURRENT press is still a tap candidate. An explicit flag rather than a sentinel
// timestamp: the obvious trick — parking `downT` at Infinity so the window test can never pass —
// inverts under subtraction (`t - Infinity` is `-Infinity`, which IS less than the window), so a
// finger surviving a lifted pinch emitted a phantom tap. Caught by `gestureSource.test.ts`.
let tapEligible = false;

// Tap bookkeeping — a completed tap waits here for the next sample().
let tapPending = false;
let tapAtX = 0;
let tapAtY = 0;

const find = (id: number): LivePointer | undefined => live.find((p) => p.id === id);

function centroid(): { x: number; y: number } {
  if (live.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of live) { sx += p.x; sy += p.y; }
  return { x: sx / live.length, y: sy / live.length };
}

/** Distance between the two pinch fingers. 0 when fewer than two are down. */
function spread(): number {
  if (live.length < 2) return 0;
  const dx = live[1].x - live[0].x;
  const dy = live[1].y - live[0].y;
  return Math.hypot(dx, dy);
}

function beginPinch(): void {
  phase = 'pinching';
  pinchStartDist = spread();
  lastSampledDist = pinchStartDist;
  pinchBeganThisFrame = true;
  const c = centroid();
  panRefX = c.x;
  panRefY = c.y;
}

function endGesture(): void {
  if (phase === 'pinching') pinchEndedThisFrame = true;
  // ⚠️ A finger still down after a gesture ends goes to 'dead', NOT back to 'pending'.
  //
  // It was 'pending' with `downT` seeded to 0, which looks equivalent and is not: `e.timeStamp` is
  // milliseconds since page load, so `timeStamp - 0 >= tapMaxMs` is true for EVERY subsequent
  // event, and the leftover finger promoted straight to panning — the exact "a released pinch must
  // not fling the content" property this is here to provide. It survived the first round of tests
  // because they used small synthetic timestamps (t=25), where the subtraction happens to stay
  // inside the window. The tests now use realistic clock values.
  phase = live.length === 0 ? 'idle' : 'dead';
  tapEligible = false;
  pinchStartDist = 0;
  lastSampledDist = 0;
}


// ── Mouse pinch emulation ─────────────────────────────────────────────────────
//
// Modifier + left-drag with a mouse stands in for a two-finger pinch. The finger under the cursor
// is finger A; finger B is A MIRRORED through the anchor (the point the drag started at).
//
// Mirroring rather than a fixed second finger is what keeps the zoom centre still: the centroid of
// A and its own mirror is the anchor, exactly, on every frame. So a consumer that zooms about
// `centerX/centerY` zooms about the point you pressed, which is what you want when magnifying one
// cell. A stationary second finger would drift the centroid as you dragged.
//
// The synthetic fingers are pushed into the SAME `live` list real touches use, so `spread()`,
// `centroid()` and `sample()` need no emulation-aware branch — there is one code path, and the
// emulation cannot drift from the behaviour it stands in for.

interface Emulation { anchorX: number; anchorY: number; sourceId: number; armed: boolean }
let emu: Emulation | null = null;

/** The two circles. Created lazily, removed when the gesture ends. */
let overlay: { root: HTMLElement; a: HTMLElement; b: HTMLElement } | null = null;

function makeDot(): HTMLElement {
  const d = document.createElement('div');
  d.style.cssText =
    'position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;'
    + 'border:2px solid rgba(255,255,255,0.9);background:rgba(120,170,255,0.28);'
    + 'box-shadow:0 0 0 1px rgba(0,0,0,0.45);pointer-events:none;';
  return d;
}

function showOverlay(ax: number, ay: number, bx: number, by: number): void {
  if (typeof document === 'undefined') return;
  if (!overlay) {
    const root = document.createElement('div');
    // pointer-events:none throughout — the overlay must never become a pointer target, or it
    // would block the very gesture it is drawing.
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    const a = makeDot();
    const b = makeDot();
    root.appendChild(a);
    root.appendChild(b);
    document.body.appendChild(root);
    overlay = { root, a, b };
  }
  overlay.a.style.left = `${ax}px`;
  overlay.a.style.top = `${ay}px`;
  overlay.b.style.left = `${bx}px`;
  overlay.b.style.top = `${by}px`;
}

function hideOverlay(): void {
  overlay?.root.remove();
  overlay = null;
}

/** Whether this event should START an emulated pinch. Left button, a mouse, and a modifier. */
function isEmulationStart(e: PointerEvent): boolean {
  return mouseEmulation
    && e.pointerType === 'mouse'
    && e.button === 0
    && (e.shiftKey || e.ctrlKey || e.altKey);
}

/** Place the synthetic pair for a cursor at (x,y), mirroring through the anchor. */
function positionEmulated(x: number, y: number): void {
  if (!emu || live.length < 2) return;
  live[0].x = x;
  live[0].y = y;
  live[1].x = 2 * emu.anchorX - x;
  live[1].y = 2 * emu.anchorY - y;
  showOverlay(live[0].x, live[0].y, live[1].x, live[1].y);
}

function startEmulation(e: PointerEvent): void {
  // ⚠️ HYBRID DEVICES (a touchscreen laptop) are the one case this handles crudely, deliberately.
  // Starting an emulation drops any real fingers below without running `endGesture`, so a live real
  // pinch loses its `pinchEnded` edge; conversely a real touch arriving mid-emulation runs
  // `endGesture` and leaves the emulation inert until the mouse is released. Both need a mouse and a
  // touchscreen driven at once, on a DEV build — so this is documented rather than solved. If mouse
  // emulation is ever enabled in release builds, fix it first: it would then be reachable by
  // ordinary users on 2-in-1 hardware.
  emu = { anchorX: e.clientX, anchorY: e.clientY, sourceId: e.pointerId, armed: false };
  // Both fingers begin ON the anchor. The pinch does not ARM until they separate — see
  // EMULATED_PINCH_SEED_PX for why a zero starting spread cannot be divided by.
  live.length = 0;
  live.push({ id: -1, x: e.clientX, y: e.clientY });
  live.push({ id: -2, x: e.clientX, y: e.clientY });
  phase = 'idle';
  tapEligible = false;
  positionEmulated(e.clientX, e.clientY);
}

function cancelEmulation(): void {
  if (!emu) return;
  emu = null;
  live.length = 0;
  hideOverlay();
  endGesture();
}

/** True when the event was consumed by the emulation. */
function handleEmulatedMove(e: PointerEvent): boolean {
  if (!emu || e.pointerId !== emu.sourceId) return false;
  positionEmulated(e.clientX, e.clientY);
  if (!emu.armed && spread() >= EMULATED_PINCH_SEED_PX * 2) {
    emu.armed = true;
    beginPinch();
  }
  return true;
}

function onPointerDown(e: PointerEvent): void {
  // Filter at INGESTION, the same discipline pointerSource follows: a press that starts on blocked
  // chrome must never enter the list, because filtering later would leave the gesture half-tracked.
  if (isPointerBlocked(e.target)) return;
  if (isEmulationStart(e)) { startEmulation(e); return; }
  if (find(e.pointerId)) return;
  live.push({ id: e.pointerId, x: e.clientX, y: e.clientY });

  if (live.length === 1) {
    phase = 'pending';
    downX = e.clientX;
    downY = e.clientY;
    downT = e.timeStamp;
    panRefX = e.clientX;
    panRefY = e.clientY;
    tapPending = false;
    tapEligible = true;
  } else if (live.length === 2) {
    tapEligible = false; // a second finger abandons the first's tap candidacy
    beginPinch();
  }
}

function onPointerMove(e: PointerEvent): void {
  if (handleEmulatedMove(e)) return;
  const p = find(e.pointerId);
  if (!p) return;
  p.x = e.clientX;
  p.y = e.clientY;

  if (phase === 'pinching') {
    const c = centroid();
    panAccX += c.x - panRefX;
    panAccY += c.y - panRefY;
    panRefX = c.x;
    panRefY = c.y;
    return;
  }

  if (phase === 'pending') {
    const travelled = Math.hypot(e.clientX - downX, e.clientY - downY);
    const outOfWindow = e.timeStamp - downT >= tapMaxMs;
    // Either escape promotes to a pan. The slop one is checked first and is the one that matters
    // for feel: a fast flick is well inside the tap window, and waiting it out would make the
    // content feel stuck for a quarter second before it started moving.
    if (travelled > tapSlopPx || outOfWindow) {
      phase = 'panning';
      // Resume from HERE, not from the press origin — otherwise engaging pan snaps the content by
      // the slop radius.
      panRefX = e.clientX;
      panRefY = e.clientY;
    }
    return;
  }

  if (phase === 'panning') {
    panAccX += e.clientX - panRefX;
    panAccY += e.clientY - panRefY;
    panRefX = e.clientX;
    panRefY = e.clientY;
  }
}

function removePointer(id: number): boolean {
  const i = live.findIndex((p) => p.id === id);
  if (i < 0) return false;
  live.splice(i, 1);
  return true;
}

function onPointerUp(e: PointerEvent): void {
  if (emu && e.pointerId === emu.sourceId) { cancelEmulation(); return; }
  const wasPending = phase === 'pending';
  if (!removePointer(e.pointerId)) return;

  if (wasPending && tapEligible && live.length === 0) {
    const travelled = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (e.timeStamp - downT < tapMaxMs && travelled <= tapSlopPx) {
      tapPending = true;
      // Report where it went DOWN. The two differ by at most the slop radius, and the down point is
      // what the player aimed at.
      tapAtX = downX;
      tapAtY = downY;
    }
  }
  endGesture();
}

/** A cancel (the browser reclaiming the touch) ends the gesture WITHOUT emitting a tap — the
 *  gesture did not complete, and a phantom tap is worse than a missed one. */
function onPointerCancel(e: PointerEvent): void {
  if (emu && e.pointerId === emu.sourceId) { cancelEmulation(); return; }
  if (!removePointer(e.pointerId)) return;
  endGesture();
}

let attached = false;

function reset(): void {
  emu = null;
  hideOverlay();
  live.length = 0;
  phase = 'idle';
  panAccX = 0;
  panAccY = 0;
  pinchStartDist = 0;
  lastSampledDist = 0;
  pinchBeganThisFrame = false;
  pinchEndedThisFrame = false;
  tapPending = false;
  tapEligible = false;
}

export const gestureSource: InputSource = {
  name: 'gesture',

  attach(): void {
    if (attached || typeof window === 'undefined') return;
    attached = true;
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  },

  detach(): void {
    if (!attached || typeof window === 'undefined') return;
    attached = false;
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    reset();
  },

  reset,

  sample(out: InputFrame): void {
    const g: GestureFrame = out.gesture;
    const c = centroid();

    g.pointerCount = live.length;
    g.centerX = c.x;
    g.centerY = c.y;
    g.panning = phase === 'panning';
    g.pinching = phase === 'pinching';

    // Drain the accumulated pan. `beginSample` already zeroed these, so a frame with no movement
    // reports 0 rather than repeating the last delta.
    g.panX = panAccX;
    g.panY = panAccY;
    panAccX = 0;
    panAccY = 0;

    g.pinchStarted = pinchBeganThisFrame;
    g.pinchEnded = pinchEndedThisFrame;
    pinchBeganThisFrame = false;
    pinchEndedThisFrame = false;

    if (phase === 'pinching' && pinchStartDist > 0) {
      const now = spread();
      g.pinchScale = now / pinchStartDist;
      g.pinchScaleDelta = lastSampledDist > 0 ? now / lastSampledDist : 1;
      lastSampledDist = now;
    } else {
      g.pinchScale = 1;
      g.pinchScaleDelta = 1;
    }

    g.tapped = tapPending;
    if (tapPending) {
      g.tapX = tapAtX;
      g.tapY = tapAtY;
      tapPending = false;
    }

    // Claim `lastDevice` on activity, as the InputSource contract asks. 'pointer' rather than a
    // touch-specific value because that is the vocabulary `InputDevice` actually has, and because
    // the primary finger of any gesture is one `pointerSource` is reporting as 'pointer' anyway.
    if (live.length > 0 || g.tapped) out.lastDevice = 'pointer';
  },
};
