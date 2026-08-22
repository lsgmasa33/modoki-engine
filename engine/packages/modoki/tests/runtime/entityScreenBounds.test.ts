/** 3D screen bounds — what a viewport MEASURES, shared by SceneView and the runtime Scene3D.
 *
 *  These pin QA-CTX-0006 / QA-SVIEW-0004: the provider projected only meshes and skinned roots
 *  while a real click could also select billboards, SDF text and the Camera/Light/Environment
 *  icon gizmos — so a light was on screen, selectable, and refused by `modoki_tap{entity}` with
 *  "has no screen bounds". The fix landed verified only against a live editor; this is the
 *  headless gate for it.
 *
 *  Real `three` objects and a real camera throughout — the projection is pure math and mocking
 *  it would assert the mock. */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeEntityScreenBounds, expandPickableBounds, type EntityBoundsSources } from '../../src/runtime/rendering/entityScreenBounds';

const VP = { left: 0, top: 0, width: 800, height: 600 };

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, VP.width / VP.height, 0.1, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

/** A 1x1x1 box mesh at the origin (or wherever placed). */
function boxMesh(x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  m.position.set(x, y, z);
  return m;
}

const empty = (): EntityBoundsSources =>
  ({ ecsObjects: [], skinned: [], billboards: [], textMeshes: [], gizmos: [] });

describe('computeSceneViewBounds — coverage matches what a click can select', () => {
  it('measures meshes, skinned roots, billboards, text meshes AND icon gizmos', () => {
    const skinRoot = new THREE.Object3D(); skinRoot.add(boxMesh());
    const billboard = new THREE.Object3D(); billboard.add(boxMesh());
    const text = new THREE.Object3D(); text.add(boxMesh());
    const out = computeEntityScreenBounds({
      ecsObjects: [[1, boxMesh()]],
      skinned: [[2, { root: skinRoot }]],
      billboards: [[3, { group: billboard }]],
      textMeshes: [[4, { group: text }]],
      gizmos: [[5, boxMesh()]],
    }, camera(), VP, 'scene-view');
    expect(out.map((b) => b.id).sort()).toEqual([1, 2, 3, 4, 5]);
    for (const b of out) {
      expect(b.surface).toBe('scene-view');
      expect(b.layer).toBe('3d');
      expect(b.screen).not.toBeNull();
    }
  });

  it('a LIGHT-style entity — an icon gizmo and nothing else — is measurable', () => {
    // The QA-SVIEW-0004 shape exactly: no mesh anywhere, only the icon that makes it clickable.
    const out = computeEntityScreenBounds({ ...empty(), gizmos: [[7, boxMesh()]] }, camera(), VP, 'scene-view');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(7);
    expect(out[0].onScreen).toBe(true);
    expect(out[0].screen!.w).toBeGreaterThan(0);
  });

  it('an icon gizmo reports NO worldAABB, while a mesh does', () => {
    const out = computeEntityScreenBounds({
      ...empty(), ecsObjects: [[1, boxMesh()]], gizmos: [[2, boxMesh()]],
    }, camera(), VP, 'scene-view');
    const mesh = out.find((b) => b.id === 1)!;
    const gizmo = out.find((b) => b.id === 2)!;
    // A Light has no geometry — reporting the ICON's extent as the entity's would be a
    // confident wrong answer, which is worse than the field being absent.
    expect(mesh.worldAABB).toBeDefined();
    expect(mesh.worldAABB!.size.map(Math.round)).toEqual([1, 1, 1]);
    expect(gizmo.worldAABB).toBeUndefined();
  });

  it('an invisible billboard / text mesh is not measured (it is not clickable either)', () => {
    const hidden = new THREE.Object3D(); hidden.add(boxMesh()); hidden.visible = false;
    const shown = new THREE.Object3D(); shown.add(boxMesh());
    const out = computeEntityScreenBounds({
      ...empty(), billboards: [[1, { group: hidden }]], textMeshes: [[2, { group: shown }]],
    }, camera(), VP, 'scene-view');
    expect(out.map((b) => b.id)).toEqual([2]);
  });

  it('measures an id ONCE even when two maps carry it', () => {
    const out = computeEntityScreenBounds({
      ...empty(), ecsObjects: [[9, boxMesh()]], gizmos: [[9, boxMesh(5, 0, 0)]],
    }, camera(), VP, 'scene-view');
    expect(out).toHaveLength(1);
    expect(out[0].worldAABB).toBeDefined(); // the ecsObjects (geometric) reading won
  });

  it('honours the ids filter across every map', () => {
    const out = computeEntityScreenBounds({
      ...empty(), ecsObjects: [[1, boxMesh()], [2, boxMesh()]], gizmos: [[3, boxMesh()]],
    }, camera(), VP, 'scene-view', new Set([2, 3]));
    expect(out.map((b) => b.id).sort()).toEqual([2, 3]);
  });
});

describe('expandPickableBounds — bounds must not exceed what a raycast can hit', () => {
  /** The camera gizmo: a small icon plus frustum lines that already have a no-op `raycast`
   *  and now carry `noBounds`. Measured whole, the camera came out 5613x1981 px — a rect no
   *  click inside it selects the camera in, so the entity aim was correctly refused. */
  function cameraGizmo(): THREE.Object3D {
    const pivot = new THREE.Object3D();
    pivot.add(boxMesh()); // the icon
    const frustum = new THREE.Mesh(new THREE.BoxGeometry(60, 40, 100));
    frustum.raycast = () => {};
    frustum.userData.noBounds = true;
    pivot.add(frustum);
    pivot.updateMatrixWorld(true);
    return pivot;
  }

  it('prunes a noBounds subtree, where setFromObject would include it', () => {
    const pivot = cameraGizmo();
    const pruned = expandPickableBounds(new THREE.Box3(), pivot);
    const naive = new THREE.Box3().setFromObject(pivot);
    const size = new THREE.Vector3(); pruned.getSize(size);
    expect(size.x).toBeCloseTo(1, 5);   // just the icon
    const naiveSize = new THREE.Vector3(); naive.getSize(naiveSize);
    expect(naiveSize.x).toBeCloseTo(60, 5); // …which is what the bug measured
  });

  it('so the camera projected rect is icon-sized, not frustum-sized', () => {
    const out = computeEntityScreenBounds({ ...empty(), gizmos: [[1, cameraGizmo()]] }, camera(), VP, 'scene-view');
    const naive = computeEntityScreenBounds({ ...empty(), ecsObjects: [[1, cameraGizmo()]] }, camera(), VP, 'scene-view');
    expect(out[0].screen!.w).toBeLessThan(naive[0].screen!.w / 10);
  });

  it('an object with no geometry anywhere yields an empty box (no crash, no rect claim)', () => {
    const box = expandPickableBounds(new THREE.Box3(), new THREE.Object3D());
    expect(box.isEmpty()).toBe(true);
  });
});

/** The surface label is the caller's, and the runtime provider passes no gizmos.
 *
 *  Found by the close-out sweep: `registerBoundsProvider` has exactly three non-test callers
 *  (Scene2D, Scene3D, SceneView), and of the two 3D ones only SceneView measured more than
 *  `ecsObjects`. So a skinned character had no bounds in the GAME view at all — an entity aim
 *  at `surface:'game-3d'` was refused for something plainly on screen. Both now run this body. */
describe('computeEntityScreenBounds — shared by both 3D surfaces', () => {
  it('stamps the surface the caller asked for, on every rect', () => {
    const out = computeEntityScreenBounds({ ...empty(), ecsObjects: [[1, boxMesh()]] }, camera(), VP, 'game-3d');
    expect(out[0].surface).toBe('game-3d');
  });

  it('measures a skinned root on the game surface (the Scene3D gap)', () => {
    const root = new THREE.Object3D(); root.add(boxMesh());
    const out = computeEntityScreenBounds({ ...empty(), skinned: [[4, { root }]] }, camera(), VP, 'game-3d');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(4);
    expect(out[0].worldAABB).toBeDefined();
  });

  it('gizmos are optional — the runtime provider omits the key entirely', () => {
    const sources = {
      ecsObjects: [[1, boxMesh()]] as ReadonlyArray<readonly [number, THREE.Object3D]>,
      skinned: [], billboards: [], textMeshes: [],
    };
    expect(() => computeEntityScreenBounds(sources, camera(), VP, 'game-3d')).not.toThrow();
    expect(computeEntityScreenBounds(sources, camera(), VP, 'game-3d')).toHaveLength(1);
  });
});
