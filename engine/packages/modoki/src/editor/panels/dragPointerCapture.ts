/**
 * Pointer capture for an editor canvas drag (#1161, #1176).
 *
 * A canvas drag listens on the element it started on and ENDS (for most, commits) in that
 * element's `pointerup`. Without capture, a release anywhere off it (past its edge, over the
 * toolbar, over another panel) is delivered to whatever is under the cursor instead, so the
 * end never runs: in SceneView the entity has moved, nothing can undo it, and the drag ref
 * stays live, so a later hover with no button held keeps dragging. The 3D gizmo never had this
 * because it captures on press.
 *
 * The other half of the same defect is ending a drag on LEAVE instead (#1176: the Sprite and
 * Nine-Slice editors had `onMouseLeave={onMouseUp}`). That does commit, but at the last
 * in-canvas position, so a drag can never overshoot the canvas and let the clamp pin an edge
 * exactly on the sheet boundary. Under capture a leave cannot end a live drag at all: measured
 * on Electron, a trusted drag from a captured element to outside it fires `pointerup`,
 * `lostpointercapture`, and only THEN `pointerout`/`pointerleave`.
 *
 * So: capture the pointer the moment a press claims a drag. A `lostpointercapture` on the
 * element for THAT pointer while the drag is still live is treated as the release. Per the
 * Pointer Events spec that is the `pointercancel` path (touch/pen: the browser takes the gesture
 * over), which is not observed live on this editor; for a mouse the normal `pointerup` finishes
 * first and the lost-capture call is a no-op. An element REMOVED mid-drag does not reach this
 * handler at all (the event goes to the document), and its effect teardown is what runs.
 *
 * Pans count as drags wherever they end in the same `pointerup` (SceneView's UI-mode
 * right-button pan, the slicer canvases' right-drag): they commit nothing, but uncaptured they
 * stayed live off the viewport the same way.
 */

import { useEffect, useRef, type RefObject } from 'react';
import { useHmrEpoch } from '../input/hmrEpoch';

export interface DragCaptureBinding {
  /** Call after the press handler ran: captures `e.pointerId` iff that press claimed a drag. */
  afterPress(e: PointerEvent): void;
  dispose(): void;
}

export function bindDragPointerCapture(
  el: HTMLElement,
  isDragging: () => boolean,
  finish: (e: PointerEvent) => void,
): DragCaptureBinding {
  /** The pointer whose press started the live drag. A second pointer (another finger) pressing
   *  mid-drag must neither steal the capture nor end the first drag when IT lifts. */
  let capturedId: number | null = null;
  const onLost = (e: PointerEvent) => {
    if (e.pointerId !== capturedId) return;
    capturedId = null;
    if (isDragging()) finish(e);
  };
  el.addEventListener('lostpointercapture', onLost);
  return {
    afterPress(e) {
      if (!isDragging()) return;
      // Still held by an earlier pointer: leave it. `hasPointerCapture` guards against a stale
      // id whose lost-capture never reached this element, which would otherwise disable
      // capture for every later drag.
      if (capturedId !== null && capturedId !== e.pointerId && el.hasPointerCapture?.(capturedId)) return;
      // Throws when the pointer is not active (a synthetic event with no real pointer id);
      // the drag then simply runs uncaptured, exactly as it did before capture existed.
      try { el.setPointerCapture(e.pointerId); capturedId = e.pointerId; } catch { /* not capturable */ }
    },
    dispose() { el.removeEventListener('lostpointercapture', onLost); },
  };
}

/** True when a press on a scrolling element landed on its own SCROLLBAR rather than its content.
 *  The browser still dispatches that press to the element, so a drag handler bound there would
 *  treat grabbing the scrollbar as the start of an edit (in the slicer, a create that clears the
 *  selection) and capture the pointer for it. `clientWidth`/`clientHeight` exclude the scrollbar,
 *  so anything past them inside the border box is scrollbar or border. */
export function pressIsOnScrollbar(el: HTMLElement, clientX: number, clientY: number): boolean {
  const r = el.getBoundingClientRect();
  return clientX - r.left - el.clientLeft >= el.clientWidth || clientY - r.top - el.clientTop >= el.clientHeight;
}

/** React form for a panel whose drag handlers are JSX props on an element that is mounted for
 *  the panel's whole life. Both callbacks are read through a ref, so they may close over render
 *  state. Call the returned function from `onPointerDown` AFTER the press handler has run. The
 *  binding is keyed on the HMR epoch because a `[]` effect does not re-run under Fast Refresh. */
export function useDragPointerCapture(
  ref: RefObject<HTMLElement | null>,
  isDragging: () => boolean,
  finish: () => void,
): (e: PointerEvent) => void {
  const hmrEpoch = useHmrEpoch();
  const live = useRef({ isDragging, finish });
  live.current = { isDragging, finish };
  const binding = useRef<DragCaptureBinding | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const b = bindDragPointerCapture(el, () => live.current.isDragging(), () => live.current.finish());
    binding.current = b;
    return () => { b.dispose(); if (binding.current === b) binding.current = null; };
  }, [ref, hmrEpoch]);
  return (e) => binding.current?.afterPress(e);
}
