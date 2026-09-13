// @vitest-environment jsdom
/** #1161 — the SceneView 2D drags commit in their canvas's pointerup, so a drag must CAPTURE
 *  the pointer or a release off the canvas never commits (and the drag stays live on hover).
 *  jsdom cannot route events by capture, so this pins the decisions the helper owns: capture
 *  exactly when a press claimed a drag, finish a drag whose capture is lost, and keep a second
 *  pointer out of the first one's drag.
 *  The routing itself is covered live (qa/cases/sceneview/gizmo2d-drag-released-off-canvas-commits.md). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bindDragPointerCapture, pressIsOnScrollbar } from '../../src/editor/panels/dragPointerCapture';

let el: HTMLElement;
let capture: ReturnType<typeof vi.fn>;
/** Pointer ids the element currently holds, as the browser would report them. */
let held: Set<number>;

function pointer(type: string, pointerId = 7): PointerEvent {
  const e = new Event(type) as PointerEvent;
  Object.defineProperty(e, 'pointerId', { value: pointerId });
  return e;
}

beforeEach(() => {
  el = document.createElement('canvas');
  held = new Set();
  capture = vi.fn((id: number) => { held.add(id); });
  // Neither is implemented in jsdom.
  el.setPointerCapture = capture as unknown as HTMLElement['setPointerCapture'];
  el.hasPointerCapture = ((id: number) => held.has(id)) as HTMLElement['hasPointerCapture'];
});

/** What the browser does when capture ends: forget it, then tell the element. */
function loseCapture(id: number) {
  held.delete(id);
  const e = pointer('lostpointercapture', id);
  el.dispatchEvent(e);
  return e;
}

describe('bindDragPointerCapture (#1161)', () => {
  it('captures the pressing pointer when the press claimed a drag', () => {
    const b = bindDragPointerCapture(el, () => true, vi.fn());
    b.afterPress(pointer('pointerdown', 7));
    expect(capture).toHaveBeenCalledWith(7);
  });

  it('accept side: a press that claimed NO drag does not capture (a click must stay a click)', () => {
    const b = bindDragPointerCapture(el, () => false, vi.fn());
    b.afterPress(pointer('pointerdown'));
    expect(capture).not.toHaveBeenCalled();
  });

  it('finishes a drag that is still live when its capture is lost (pointercancel)', () => {
    const finish = vi.fn();
    const b = bindDragPointerCapture(el, () => true, finish);
    b.afterPress(pointer('pointerdown', 7));
    const lost = loseCapture(7);
    expect(finish).toHaveBeenCalledWith(lost);
  });

  it('a lost capture AFTER a normal release is a no-op — the release already finished the drag', () => {
    const finish = vi.fn();
    let dragging = true;
    const b = bindDragPointerCapture(el, () => dragging, finish);
    b.afterPress(pointer('pointerdown', 7));
    dragging = false;                     // pointerup ran the finish and cleared the drag ref
    loseCapture(7);
    expect(finish).not.toHaveBeenCalled();
  });

  it('a SECOND pointer lifting mid-drag does not end the first pointer\'s drag', () => {
    const finish = vi.fn();
    const b = bindDragPointerCapture(el, () => true, finish);
    b.afterPress(pointer('pointerdown', 7));
    b.afterPress(pointer('pointerdown', 8));   // another finger lands while 7 still drags
    expect(capture, 'the second pointer did not steal the capture').toHaveBeenCalledTimes(1);
    loseCapture(8);
    expect(finish).not.toHaveBeenCalled();
    loseCapture(7);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('a stale captured id whose lost-capture never arrived does not disable capture for the next drag', () => {
    const b = bindDragPointerCapture(el, () => true, vi.fn());
    b.afterPress(pointer('pointerdown', 7));
    held.delete(7);                        // released, but the event went elsewhere
    b.afterPress(pointer('pointerdown', 9));
    expect(capture).toHaveBeenLastCalledWith(9);
  });

  it('an uncapturable pointer does not throw out of the press handler', () => {
    el.setPointerCapture = (() => { throw new DOMException('no active pointer', 'NotFoundError'); }) as HTMLElement['setPointerCapture'];
    const b = bindDragPointerCapture(el, () => true, vi.fn());
    expect(() => b.afterPress(pointer('pointerdown'))).not.toThrow();
  });

  it('dispose removes the lost-capture listener', () => {
    const finish = vi.fn();
    const b = bindDragPointerCapture(el, () => true, finish);
    b.afterPress(pointer('pointerdown', 7));
    b.dispose();
    loseCapture(7);
    expect(finish).not.toHaveBeenCalled();
  });
});

describe('pressIsOnScrollbar (#1176)', () => {
  /** The slicer viewport as measured live: a 720×552 border box at (245,172), 1 px border, a
   *  horizontal scrollbar under 718×537 of content (zoomed in on a wide sheet). */
  function viewport(clientWidth = 718, clientHeight = 537): HTMLElement {
    const v = document.createElement('div');
    v.getBoundingClientRect = () => ({ left: 245, top: 172, right: 965, bottom: 724, width: 720, height: 552, x: 245, y: 172, toJSON: () => ({}) });
    Object.defineProperty(v, 'clientLeft', { value: 1 });
    Object.defineProperty(v, 'clientTop', { value: 1 });
    Object.defineProperty(v, 'clientWidth', { value: clientWidth });
    Object.defineProperty(v, 'clientHeight', { value: clientHeight });
    return v;
  }

  it('a press on the horizontal scrollbar is not an edit; the content just above it is', () => {
    // The live scrollbar drag pressed at (600,717), which reached the drag handler and cleared the selection.
    expect(pressIsOnScrollbar(viewport(), 600, 717)).toBe(true);
    expect(pressIsOnScrollbar(viewport(), 600, 709)).toBe(false);
  });

  it('a press on a vertical scrollbar is not an edit either', () => {
    expect(pressIsOnScrollbar(viewport(705, 550), 955, 400)).toBe(true);
    expect(pressIsOnScrollbar(viewport(705, 550), 945, 400)).toBe(false);
  });
});
