/** Cross-panel command/registry wiring for the SceneView 3D viewport, replacing the old
 *  ad-hoc `window.__sceneViewCamera` / `window.__sceneViewFocusEntity` globals (editor-sceneview
 *  F14). The camera is still mirrored onto `window.__sceneViewCamera` as a debug/e2e handle, but
 *  now CLEARED on cleanup (the dangle F14 flagged); the focus command is no longer a global at all.
 *
 *  Both are inherently NOT React state — one is a live `THREE.Camera` object, the other a
 *  fire-and-forget command — so they live in a tiny module-level registry/emitter instead of
 *  the Zustand store. The viewport registers on mount and clears on cleanup, so panels never
 *  hold a dangling reference to a disposed camera or a torn-down viewport's closure. */

import type * as THREE from 'three';

// ── Editor camera registry (read by the Inspector's "Copy from Editor Camera") ──

/** The active editor orbit camera — perspective OR orthographic (the projection toggle swaps
 *  which one is active; consumers read pose/quaternion, valid on both). */
type EditorCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
let editorCamera: EditorCamera | null = null;

/** SceneView calls this on mount with its live orbit camera (and again on a projection toggle
 *  with the newly-active camera), and with `null` on cleanup so consumers can't read a disposed
 *  camera. Also mirrors onto `window.__sceneViewCamera` as a debug/e2e handle — crucially
 *  DELETED on cleanup, which fixes F14's original complaint (the old global dangled to a disposed
 *  camera forever). The mirror is a convenience handle, not the source of truth: app code reads
 *  `getEditorViewportCamera()`. */
export function setEditorViewportCamera(camera: EditorCamera | null): void {
  editorCamera = camera;
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __sceneViewCamera?: THREE.Camera };
    if (camera) w.__sceneViewCamera = camera;
    else delete w.__sceneViewCamera;
  }
}

/** The live editor orbit camera, or `null` when no viewport is mounted. */
export function getEditorViewportCamera(): EditorCamera | null {
  return editorCamera;
}

// ── Focus-entity command (SceneView F-key + Hierarchy "Focus" menu) ──

type FocusHandler = (entityId: number) => void;
let focusHandler: FocusHandler | null = null;

/** SceneView registers its closure-scoped focus fn; returns an unregister to call on cleanup
 *  (guarded so a remount's stale cleanup can't clobber the live handler). */
export function setFocusEntityHandler(handler: FocusHandler): () => void {
  focusHandler = handler;
  return () => {
    if (focusHandler === handler) focusHandler = null;
  };
}

/** Frame an entity in the SceneView viewport. Returns false (a no-op) when no viewport is
 *  mounted, so an agent caller can tell "framed it" from "nothing to frame it in". */
export function focusEntityInSceneView(entityId: number): boolean {
  if (!focusHandler) return false;
  focusHandler(entityId);
  return true;
}

// ── Viewport orientation controller (SceneViewGizmo corner widget) ──
// Same register-on-mount / fire-and-forget shape as the focus handler: the widget is a
// sibling React component with no access to SceneView's closure-scoped camera/controls, so
// it drives them through this channel. Phase 2 extends the controller with projection toggle.

export type EditorProjection = 'perspective' | 'orthographic';

/** What the corner gizmo needs from the live viewport. `snapToAxis` starts the animated snap;
 *  `toggleProjection` swaps perspective↔orthographic (extent-matched, no jump); `getProjection`
 *  reports the current mode so the widget's center cube can reflect it. */
export interface ViewportController {
  snapToAxis: (dir: THREE.Vector3) => void;
  toggleProjection: () => void;
  getProjection: () => EditorProjection;
}

let viewportController: ViewportController | null = null;

/** SceneView registers its controller on mount; returns an unregister for cleanup (guarded
 *  so a remount's stale cleanup can't clobber the live one, matching setFocusEntityHandler). */
export function setViewportController(ctrl: ViewportController): () => void {
  viewportController = ctrl;
  return () => {
    if (viewportController === ctrl) viewportController = null;
  };
}

/** Snap the editor viewport camera to look down `dir` (animated). Returns false when no
 *  viewport is mounted, so a caller can tell "snapped" from "nothing to snap". */
export function snapEditorViewToAxis(dir: THREE.Vector3): boolean {
  if (!viewportController) return false;
  viewportController.snapToAxis(dir);
  return true;
}

/** Toggle the editor viewport camera between perspective and orthographic. Returns false when
 *  no viewport is mounted. */
export function toggleEditorProjection(): boolean {
  if (!viewportController) return false;
  viewportController.toggleProjection();
  return true;
}

/** Current editor projection, or `null` when no viewport is mounted. */
export function getEditorProjection(): EditorProjection | null {
  return viewportController ? viewportController.getProjection() : null;
}
