/** Pure description of the editor viewport camera for the agent/MCP `get_editor_state` read.
 *  Extracted from agentEditorOps.readEditorCamera so the projection branching is unit-testable
 *  without dragging that module's heavy editor/debug import graph into a test. */

import * as THREE from 'three';

export interface EditorCameraInfo {
  position: number[];
  direction: number[];
  projection: 'perspective' | 'orthographic';
  /** Present only for a perspective camera. */
  fov?: number;
  /** Present only for an orthographic camera: its vertical half-height (top / zoom). */
  orthoSize?: number;
}

/** Report position + forward direction + projection for `cam`, or null when none is mounted.
 *  `fov` is included only for a perspective camera; an orthographic camera reports `orthoSize`
 *  (its effective vertical half-height) instead. A zoom of 0 falls back to the raw `top`. */
export function describeEditorCamera(
  cam: THREE.PerspectiveCamera | THREE.OrthographicCamera | null,
): EditorCameraInfo | null {
  if (!cam) return null;
  const p = cam.getWorldPosition(new THREE.Vector3());
  const d = cam.getWorldDirection(new THREE.Vector3());
  const base = { position: [p.x, p.y, p.z], direction: [d.x, d.y, d.z] };
  if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
    const o = cam as THREE.OrthographicCamera;
    return { ...base, projection: 'orthographic', orthoSize: o.top / (o.zoom || 1) };
  }
  return { ...base, projection: 'perspective', fov: (cam as THREE.PerspectiveCamera).fov };
}
