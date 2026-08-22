// @vitest-environment jsdom
/** Touch-control input source (#297) — on-screen d-pads and buttons as a real modality.
 *
 *  These prove the properties a d-pad is USELESS without, each of which was a decision in the
 *  source rather than a freebie:
 *   - two fingers at once (walk while you orbit), including the DOM-level proof that a press on
 *     a control leaves `pointerSource` free for the next finger — the load-bearing claim of the
 *     whole feature;
 *   - sliding the thumb from one arrow to the next without lifting, and off the pad entirely;
 *   - the diagonal being normalized, so north-east is not 41% faster than north;
 *   - a control in the EDITOR's authoring UI tree never driving the game.
 *
 *  jsdom has no layout, so `document.elementFromPoint` always returns null there — it is stubbed
 *  from a coordinate map. That is a test-harness fact, not a behaviour being asserted: the
 *  source's move path is defined in terms of "what is under the finger now", and a browser
 *  answers it for real. */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { touchControlSource } from '../../src/runtime/input/touchControlSource';
import { pointerSource } from '../../src/runtime/input/pointerSource';
import { TOUCH_ATTR, TOUCH_OPACITY_ATTR, UI_ROOT_ATTR } from '../../src/runtime/traits/TouchControl';
import { createInputFrame, computeEdges, makeFlags, type InputFrame } from '../../src/runtime/core/inputActions';
import { registerPointerBlocker, clearPointerBlockers } from '../../src/runtime/core/pointerBlockers';

/** jsdom's PointerEvent is unreliable across versions — synthesize one carrying pointerId +
 *  clientX/clientY, exactly as the pointerSource suite does. */
function firePointer(type: string, x: number, y: number, pointerId = 1, target: EventTarget = window): void {
  const ev = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }) as MouseEvent & { pointerId: number };
  (ev as { pointerId: number }).pointerId = pointerId;
  target.dispatchEvent(ev);
}

let root: HTMLElement;
/** Coordinate → element, backing the `elementFromPoint` stub. */
const atPoint = new Map<string, Element>();

function mountRoot(kind: 'runtime' | 'editor' = 'runtime'): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute(UI_ROOT_ATTR, kind);
  document.body.appendChild(el);
  return el;
}

/** A control, placed at a coordinate so the move path can find it. */
function control(parent: HTMLElement, action: string, x: number, y: number, opacity?: number): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute(TOUCH_ATTR, action);
  if (opacity != null) el.setAttribute(TOUCH_OPACITY_ATTR, String(opacity));
  parent.appendChild(el);
  atPoint.set(`${x},${y}`, el);
  return el;
}

function sample(): InputFrame {
  const frame = createInputFrame();
  touchControlSource.sample(frame);
  return frame;
}

beforeEach(() => {
  atPoint.clear();
  document.body.innerHTML = '';
  (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null })
    .elementFromPoint = (x, y) => atPoint.get(`${x},${y}`) ?? null;
  root = mountRoot('runtime');
  touchControlSource.attach();
});

afterEach(() => {
  touchControlSource.detach();
  pointerSource.detach();
  clearPointerBlockers();
  document.body.innerHTML = '';
});

describe('touchControlSource', () => {
  it('a held d-pad arrow drives the locomotion axis, and releasing it stops', () => {
    const left = control(root, 'moveLeft', 10, 10);

    expect(sample().axes.moveX).toBe(0);

    firePointer('pointerdown', 10, 10, 1, left);
    const f = sample();
    expect(f.axes.moveX).toBe(-1);
    // The same press raises the nav flag too — one pad drives a character AND a menu, exactly
    // as the keyboard's arrow keys already do.
    expect(f.held.navLeft).toBe(true);
    expect(f.lastDevice).toBe('pointer');

    firePointer('pointerup', 10, 10, 1, left);
    expect(sample().axes.moveX).toBe(0);
  });

  it('a button raises its digital action, and inputSystem derives exactly one pressed edge', () => {
    const jump = control(root, 'jump', 40, 40);
    const prevHeld = makeFlags();

    firePointer('pointerdown', 40, 40, 1, jump);
    let f = createInputFrame();
    touchControlSource.sample(f);
    computeEdges(f, prevHeld);
    expect(f.held.jump).toBe(true);
    expect(f.pressed.jump).toBe(true);

    // Held across a second frame: still held, no second edge — the source is a pure level
    // reporter and never latches an edge of its own.
    f = createInputFrame();
    touchControlSource.sample(f);
    computeEdges(f, prevHeld);
    expect(f.held.jump).toBe(true);
    expect(f.pressed.jump).toBe(false);

    firePointer('pointerup', 40, 40, 1, jump);
    f = createInputFrame();
    touchControlSource.sample(f);
    computeEdges(f, prevHeld);
    expect(f.held.jump).toBe(false);
    expect(f.released.jump).toBe(true);
  });

  it('TWO fingers hold two controls at once, and the diagonal is normalized', () => {
    const left = control(root, 'moveLeft', 10, 10);
    const fwd = control(root, 'moveForward', 20, 10);

    firePointer('pointerdown', 10, 10, 1, left);
    firePointer('pointerdown', 20, 10, 2, fwd);

    const f = sample();
    // NOT (−1, +1): that vector is 1.41 long, and every game here reads the axes as a velocity,
    // so the diagonal would walk 41% faster than a cardinal. On a thumb that reads as the pad
    // being erratic rather than as a technique.
    expect(f.axes.moveX).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(f.axes.moveY).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.hypot(f.axes.moveX, f.axes.moveY)).toBeCloseTo(1, 6);

    // Lifting one finger leaves the other holding a full-strength cardinal.
    firePointer('pointerup', 20, 10, 2, fwd);
    const g = sample();
    expect(g.axes.moveX).toBe(-1);
    expect(g.axes.moveY).toBe(0);
  });

  it('two fingers on the SAME arrow are one unit of movement, not two', () => {
    const left = control(root, 'moveLeft', 10, 10);
    firePointer('pointerdown', 10, 10, 1, left);
    firePointer('pointerdown', 10, 10, 2, left);
    expect(sample().axes.moveX).toBe(-1);
  });

  it('a thumb SLIDES from one arrow to the next without lifting', () => {
    const left = control(root, 'moveLeft', 10, 10);
    control(root, 'moveForward', 20, 10);

    firePointer('pointerdown', 10, 10, 1, left);
    expect(sample().axes.moveX).toBe(-1);

    // The move is dispatched at the ORIGINAL element (as a captured pointer would be); the
    // source re-resolves what is under the coordinates, which is the whole point.
    firePointer('pointermove', 20, 10, 1, left);
    const f = sample();
    expect(f.axes.moveX).toBe(0);
    expect(f.axes.moveY).toBe(1);
  });

  it('sliding OFF the pad stops driving, and sliding back ON resumes without lifting', () => {
    const left = control(root, 'moveLeft', 10, 10);

    firePointer('pointerdown', 10, 10, 1, left);
    expect(sample().axes.moveX).toBe(-1);

    firePointer('pointermove', 500, 500, 1, left); // empty space
    expect(sample().axes.moveX).toBe(0);

    firePointer('pointermove', 10, 10, 1, left);
    expect(sample().axes.moveX).toBe(-1);
  });

  it('pointercancel ends the press cleanly — a reclaimed touch cannot walk forever', () => {
    const left = control(root, 'moveLeft', 10, 10);
    firePointer('pointerdown', 10, 10, 1, left);
    expect(sample().axes.moveX).toBe(-1);
    // Android reclaims a touch for its own gesture navigation mid-press.
    firePointer('pointercancel', 10, 10, 1, left);
    expect(sample().axes.moveX).toBe(0);
  });

  it('reset() drops every held control — the host input gate must not strand a walk', () => {
    const left = control(root, 'moveLeft', 10, 10);
    firePointer('pointerdown', 10, 10, 1, left);
    expect(sample().axes.moveX).toBe(-1);
    touchControlSource.reset!();
    expect(sample().axes.moveX).toBe(0);
  });

  it('a control in the EDITOR UI tree is ignored — an authoring click never drives the game', () => {
    const editorRoot = mountRoot('editor');
    const left = control(editorRoot, 'moveLeft', 10, 10);
    firePointer('pointerdown', 10, 10, 1, left);
    expect(sample().axes.moveX).toBe(0);
  });

  it('a control with no UI root at all is ignored', () => {
    const orphan = document.createElement('div');
    orphan.setAttribute(TOUCH_ATTR, 'moveLeft');
    document.body.appendChild(orphan);
    atPoint.set('10,10', orphan);
    firePointer('pointerdown', 10, 10, 1, orphan);
    expect(sample().axes.moveX).toBe(0);
  });

  it('applies the press highlight to the DOM and restores it exactly on release', () => {
    const left = control(root, 'moveLeft', 10, 10, 0.5);
    left.style.opacity = '0.9'; // an authored opacity the highlight must not eat
    firePointer('pointerdown', 10, 10, 1, left);
    expect(left.style.opacity).toBe('0.5');
    firePointer('pointerup', 10, 10, 1, left);
    expect(left.style.opacity).toBe('0.9');
  });

  it('pressedOpacity of 1 disables the highlight — and RELEASING does not clobber an authored opacity', () => {
    // The second half is the real trap: the apply step bailed out (nothing to do) while the
    // release step still wrote back its captured value, erasing an inline opacity this module
    // had never touched. An element it declines to highlight must be left completely alone.
    const left = control(root, 'moveLeft', 10, 10, 1);
    left.style.opacity = '0.8';
    firePointer('pointerdown', 10, 10, 1, left);
    expect(left.style.opacity).toBe('0.8');
    firePointer('pointerup', 10, 10, 1, left);
    expect(left.style.opacity).toBe('0.8');
  });

  it('TWO fingers on one control leave its opacity correct — in either release order', () => {
    // Per-press capture made the SECOND press read the already-dimmed style as its original, so
    // releasing in press order restored 0.5 and left the button rendered permanently pressed,
    // with no finger on it and no way back: a later single press re-captured 0.5 as ITS
    // original. Press order is not a race — reset() iterates insertion order — so the host input
    // gate's per-frame drain made it certain.
    const left = control(root, 'moveLeft', 10, 10, 0.5);
    left.style.opacity = '0.9';

    firePointer('pointerdown', 10, 10, 1, left);
    firePointer('pointerdown', 10, 10, 2, left);
    expect(left.style.opacity).toBe('0.5');

    // FIFO release: the first lift must NOT un-dim a control the other thumb still holds.
    firePointer('pointerup', 10, 10, 1, left);
    expect(left.style.opacity).toBe('0.5');
    firePointer('pointerup', 10, 10, 2, left);
    expect(left.style.opacity).toBe('0.9');

    // LIFO release: same outcome.
    firePointer('pointerdown', 10, 10, 3, left);
    firePointer('pointerdown', 10, 10, 4, left);
    firePointer('pointerup', 10, 10, 4, left);
    expect(left.style.opacity).toBe('0.5');
    firePointer('pointerup', 10, 10, 3, left);
    expect(left.style.opacity).toBe('0.9');
  });

  it('reset() with two fingers on one control restores it exactly once', () => {
    // The gate-drain path, which is what made the bug above certain rather than likely.
    const left = control(root, 'moveLeft', 10, 10, 0.5);
    left.style.opacity = '0.9';
    firePointer('pointerdown', 10, 10, 1, left);
    firePointer('pointerdown', 10, 10, 2, left);
    touchControlSource.reset!();
    expect(left.style.opacity).toBe('0.9');
    // And the next press still behaves — the wrong value must not be self-perpetuating.
    firePointer('pointerdown', 10, 10, 5, left);
    expect(left.style.opacity).toBe('0.5');
    firePointer('pointerup', 10, 10, 5, left);
    expect(left.style.opacity).toBe('0.9');
  });

  it('a finger that slides between two controls leaves neither one dimmed', () => {
    const left = control(root, 'moveLeft', 10, 10, 0.5);
    const fwd = control(root, 'moveForward', 20, 10, 0.5);
    firePointer('pointerdown', 10, 10, 1, left);
    firePointer('pointermove', 20, 10, 1, left);
    expect(left.style.opacity).toBe('');
    expect(fwd.style.opacity).toBe('0.5');
    firePointer('pointerup', 20, 10, 1, left);
    expect(fwd.style.opacity).toBe('');
  });

  // ── The load-bearing multi-touch claim ─────────────────────────────────────
  //
  // A d-pad is worthless in forest-camp if holding it blocks the camera drag. `pointerSource`
  // tracks exactly ONE gesture (first finger wins), so this only works because a press inside a
  // pointer-block root never latches `activeId` — and `UIRenderer` registers the UI root as one.
  // Asserted at the DOM level here rather than trusted from reading the code.
  it('a thumb on the d-pad leaves pointerSource free for the SECOND finger', () => {
    registerPointerBlocker(root); // exactly what UIRenderer does in runtime mode
    const left = control(root, 'moveLeft', 10, 10);
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);

    pointerSource.attach();

    firePointer('pointerdown', 10, 10, 1, left);   // thumb on the pad
    firePointer('pointerdown', 300, 300, 2, canvas); // other thumb on the scene
    firePointer('pointermove', 340, 300, 2, canvas);

    // The d-pad is walking...
    expect(sample().axes.moveX).toBe(-1);

    // ...while the camera gesture owns the pointer. Two frames: the source drains one queued
    // transition per frame (the press), then reports the live drag.
    const f1 = createInputFrame(); pointerSource.sample(f1);
    expect(f1.pointer.down).toBe(true);
    const f2 = createInputFrame(); pointerSource.sample(f2);
    expect(f2.pointer.down).toBe(true);
    expect(f2.pointer.dragX).toBe(40);
  });
});
