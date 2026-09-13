/**
 * Pointer capture for the SceneView 2D drags (#1161).
 *
 * The 2D gizmo, group and collider-vertex drags all listen on the chrome canvas they started
 * on, and all three COMMIT in that canvas's `pointerup`: the undo entry (for a gizmo or group
 * drag also the `!transform` journal line) and the unsaved flag come from it. Without capture,
 * a release anywhere off that canvas (past its edge, over the toolbar, over another panel) is
 * delivered to whatever is under the cursor instead, so the commit never runs: the entity has
 * moved, nothing can undo it, and the drag ref stays live, so a later hover with no button held
 * keeps dragging. The 3D gizmo never had this because it captures on press.
 *
 * So: capture the pointer the moment a press claims a drag. A `lostpointercapture` on the
 * element for THAT pointer while the drag is still live is treated as the release. Per the
 * Pointer Events spec that is the `pointercancel` path (touch/pen: the browser takes the gesture
 * over), which is not observed live on this editor; for a mouse the normal `pointerup` finishes
 * first and the lost-capture call is a no-op. A canvas REMOVED mid-drag does not reach this
 * handler at all (the event goes to the document), and its effect teardown is what runs.
 *
 * The UI-mode right-button pan (SceneView's zoom/pan effect) binds it too: it commits nothing,
 * but it ended only in its container's `pointerup` the same way, so it stayed live off-viewport.
 */

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
