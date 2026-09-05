/** SceneView's setup closure owns five per-entity THREE maps. #737: the world-swap handler
 *  disposed four of them and the component teardown only two — a third gap
 *  (`descOutlineMeshes`) was found during the sweep, saved only by a per-frame prune that
 *  cannot run after teardown. Fixed structurally: ONE helper, called from both sites, so they
 *  can't diverge again.
 *
 *  This proves `dispose()` fires on every object in every map. It does NOT prove the GPU
 *  buffer behind a disposed geometry/material/light is actually freed — that's three.js's own
 *  documented contract, not something a unit test can observe (#590's lesson: a dispose() that
 *  runs cleanly and frees nothing looks identical to a correct one). */

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { disposeSceneViewEntityObjects, type SceneViewEntityObjects } from '../../src/editor/panels/sceneViewResources';

function buildObjects(scene: THREE.Scene) {
  const outline = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
  const descOutline = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
  const colliderWire = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
  const gizmoMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  const light = new THREE.PointLight();

  scene.add(outline, descOutline, colliderWire, gizmoMesh, light);

  const objs: SceneViewEntityObjects = {
    outlineMeshes: new Map([[1, outline]]),
    descOutlineMeshes: new Map([[2, descOutline]]),
    colliderWires: new Map([[3, colliderWire]]),
    colliderWireSigs: new Map([[3, 'sig-3']]),
    ecsGizmos: new Map([[4, gizmoMesh]]),
    ecsLights: new Map([[5, light]]),
  };

  return { objs, outline, descOutline, colliderWire, gizmoMesh, light };
}

describe('disposeSceneViewEntityObjects', () => {
  it('positive control: objects start in the scene, spies armed but unfired', () => {
    const scene = new THREE.Scene();
    const { objs, outline, descOutline, colliderWire, gizmoMesh, light } = buildObjects(scene);

    const geoSpy = vi.spyOn(outline.geometry, 'dispose');
    const matSpy = vi.spyOn(gizmoMesh.material as THREE.Material, 'dispose');
    const lightSpy = vi.spyOn(light, 'dispose');

    for (const o of [outline, descOutline, colliderWire, gizmoMesh, light]) {
      expect(scene.children).toContain(o);
    }
    expect(geoSpy).not.toHaveBeenCalled();
    expect(matSpy).not.toHaveBeenCalled();
    expect(lightSpy).not.toHaveBeenCalled();
    expect(objs.outlineMeshes.size).toBe(1); // and the maps are populated, not empty-by-default

    // Consume the spies so vitest doesn't flag them as unused across this shared setup.
    disposeSceneViewEntityObjects(scene, objs);
    expect(geoSpy).toHaveBeenCalledTimes(1);
    expect(matSpy).toHaveBeenCalledTimes(1);
    expect(lightSpy).toHaveBeenCalledTimes(1);
  });

  it('disposes every geometry/material/light exactly once and empties every map', () => {
    const scene = new THREE.Scene();
    const { objs, outline, descOutline, colliderWire, gizmoMesh, light } = buildObjects(scene);

    const geoSpies = [outline, descOutline, colliderWire].map((o) => vi.spyOn(o.geometry, 'dispose'));
    const matSpies = [outline, descOutline, colliderWire, gizmoMesh].map((o) =>
      vi.spyOn(o.material as THREE.Material, 'dispose'),
    );
    const lightSpy = vi.spyOn(light, 'dispose');

    disposeSceneViewEntityObjects(scene, objs);

    for (const spy of geoSpies) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of matSpies) expect(spy).toHaveBeenCalledTimes(1);
    expect(lightSpy).toHaveBeenCalledTimes(1);

    expect(objs.outlineMeshes.size).toBe(0);
    expect(objs.descOutlineMeshes.size).toBe(0);
    expect(objs.colliderWires.size).toBe(0);
    expect(objs.colliderWireSigs.size).toBe(0);
    expect(objs.ecsGizmos.size).toBe(0);
    expect(objs.ecsLights.size).toBe(0);

    for (const o of [outline, descOutline, colliderWire, gizmoMesh, light]) {
      expect(scene.children).not.toContain(o);
    }
  });

  it('the "keep" object is skipped for removal and disposal but still dropped from its map', () => {
    const scene = new THREE.Scene();
    const { objs, gizmoMesh } = buildObjects(scene);
    const matSpy = vi.spyOn(gizmoMesh.material as THREE.Material, 'dispose');

    disposeSceneViewEntityObjects(scene, objs, gizmoMesh);

    expect(scene.children).toContain(gizmoMesh); // not removed
    expect(matSpy).not.toHaveBeenCalled(); // not disposed
    expect(objs.ecsGizmos.size).toBe(0); // but gone from the map
  });

  it('does not throw on a bare THREE.Group gizmo with no geometry or material', () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    scene.add(group);
    const objs: SceneViewEntityObjects = {
      outlineMeshes: new Map(),
      descOutlineMeshes: new Map(),
      colliderWires: new Map(),
      colliderWireSigs: new Map(),
      ecsGizmos: new Map([[10, group]]),
      ecsLights: new Map(),
    };

    expect(() => disposeSceneViewEntityObjects(scene, objs)).not.toThrow();
    expect(objs.ecsGizmos.size).toBe(0);
    expect(scene.children).not.toContain(group);
  });

  it('disposes a Zone3D capsule gizmo\'s per-entity geometry (userData.zoneCapSig set)', () => {
    // Almost every gizmo shares a module-level GIZMO_SHAPES.* geometry, so this loop must NOT
    // dispose geometry in general — the negative case right below is what protects that shared
    // geometry from being freed out from under every other live gizmo of the same shape. The
    // Zone3D capsule is the one exception: SceneView mints it per-entity via
    // `new THREE.CapsuleGeometry(...)` (radius/length are independent, so a shared unit capsule
    // can't express it) and tags it with `userData.zoneCapSig` — that geometry has no other
    // owner and must be disposed here or it leaks on every world swap / teardown.
    const scene = new THREE.Scene();
    const geo = new THREE.CapsuleGeometry(1, 2, 6, 16);
    const mat = new THREE.MeshBasicMaterial();
    const capsule = new THREE.Mesh(geo, mat);
    (capsule.userData as { zoneCapSig?: string }).zoneCapSig = '1.0000:2.0000';
    scene.add(capsule);
    const objs: SceneViewEntityObjects = {
      outlineMeshes: new Map(),
      descOutlineMeshes: new Map(),
      colliderWires: new Map(),
      colliderWireSigs: new Map(),
      ecsGizmos: new Map([[12, capsule]]),
      ecsLights: new Map(),
    };
    const geoSpy = vi.spyOn(geo, 'dispose');

    disposeSceneViewEntityObjects(scene, objs);

    expect(geoSpy).toHaveBeenCalledTimes(1);
    expect(objs.ecsGizmos.size).toBe(0);
  });

  it('does NOT dispose a shared GIZMO_SHAPES-style geometry when userData.zoneCapSig is absent', () => {
    // This is the arm that protects the shared geometries: a plain gizmo mesh (no zoneCapSig)
    // must survive geometry disposal, because in production its geometry is a module-level
    // GIZMO_SHAPES.* instance reused by every other live gizmo of that shape.
    const scene = new THREE.Scene();
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    const objs: SceneViewEntityObjects = {
      outlineMeshes: new Map(),
      descOutlineMeshes: new Map(),
      colliderWires: new Map(),
      colliderWireSigs: new Map(),
      ecsGizmos: new Map([[13, mesh]]),
      ecsLights: new Map(),
    };
    const geoSpy = vi.spyOn(geo, 'dispose');

    disposeSceneViewEntityObjects(scene, objs);

    expect(geoSpy).not.toHaveBeenCalled();
    expect(objs.ecsGizmos.size).toBe(0);
  });

  it('does not throw and disposes every entry when a gizmo material is an array', () => {
    const scene = new THREE.Scene();
    const matA = new THREE.MeshBasicMaterial();
    const matB = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [matA, matB]);
    scene.add(mesh);
    const objs: SceneViewEntityObjects = {
      outlineMeshes: new Map(),
      descOutlineMeshes: new Map(),
      colliderWires: new Map(),
      colliderWireSigs: new Map(),
      ecsGizmos: new Map([[11, mesh]]),
      ecsLights: new Map(),
    };
    const spyA = vi.spyOn(matA, 'dispose');
    const spyB = vi.spyOn(matB, 'dispose');

    expect(() => disposeSceneViewEntityObjects(scene, objs)).not.toThrow();
    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledTimes(1);
    expect(objs.ecsGizmos.size).toBe(0);
  });
});
