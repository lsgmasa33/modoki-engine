/** describeEditorCamera — the projection-aware shaping behind the agent/MCP editor-camera read,
 *  after the bus camera type was widened PerspectiveCamera → Perspective|Orthographic. Guards
 *  that perspective reports fov (no orthoSize), ortho reports orthoSize=top/zoom (no fov), null
 *  passes through, and a zoom of 0 doesn't divide-by-zero. Pure — real THREE cameras in. */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { describeEditorCamera } from '../../app/editor/editorCameraInfo';

describe('describeEditorCamera', () => {
  it('returns null when no camera is mounted', () => {
    expect(describeEditorCamera(null)).toBeNull();
  });

  it('reports fov (and no orthoSize) for a perspective camera + its world position', () => {
    const c = new THREE.PerspectiveCamera(55, 1.5, 0.1, 100);
    c.position.set(1, 2, 3);
    c.updateMatrixWorld();
    const r = describeEditorCamera(c)!;
    expect(r.projection).toBe('perspective');
    expect(r.fov).toBe(55);
    expect(r.orthoSize).toBeUndefined();
    expect(r.position[0]).toBeCloseTo(1, 6);
    expect(r.position[1]).toBeCloseTo(2, 6);
    expect(r.position[2]).toBeCloseTo(3, 6);
    expect(r.direction).toHaveLength(3);
  });

  it('reports orthoSize=top/zoom (and no fov) for an orthographic camera', () => {
    const o = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
    o.zoom = 2;
    o.updateProjectionMatrix();
    o.updateMatrixWorld();
    const r = describeEditorCamera(o)!;
    expect(r.projection).toBe('orthographic');
    expect(r.orthoSize).toBeCloseTo(1.5, 9); // top(3) / zoom(2)
    expect(r.fov).toBeUndefined();
  });

  it('falls back to top when ortho zoom is 0 (no divide-by-zero)', () => {
    const o = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
    o.zoom = 0;
    o.updateMatrixWorld();
    expect(describeEditorCamera(o)!.orthoSize).toBeCloseTo(3, 9);
  });
});
