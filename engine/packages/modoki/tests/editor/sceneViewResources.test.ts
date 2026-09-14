/** SceneView's setup closure owns five per-entity THREE maps. #737: the world-swap handler
 *  disposed four of them and the component teardown only two — a third gap
 *  (`descOutlineMeshes`) was found during the sweep, saved only by a per-frame prune that
 *  cannot run after teardown. Fixed structurally: ONE helper, called from both sites, so they
 *  can't diverge again. The icon/volume gizmos left this helper for `SceneViewGizmoTable`
 *  (#1206); their disposal cases live in `sceneViewGizmoTable.test.ts`.
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
  const light = new THREE.PointLight();

  scene.add(outline, descOutline, colliderWire, light);

  const objs: SceneViewEntityObjects = {
    outlineMeshes: new Map([[1, outline]]),
    descOutlineMeshes: new Map([[2, descOutline]]),
    colliderWires: new Map([[3, colliderWire]]),
    colliderWireSigs: new Map([[3, 'sig-3']]),
    ecsLights: new Map([[5, light]]),
  };

  return { objs, outline, descOutline, colliderWire, light };
}

describe('disposeSceneViewEntityObjects', () => {
  it('positive control: objects start in the scene, spies armed but unfired', () => {
    const scene = new THREE.Scene();
    const { objs, outline, descOutline, colliderWire, light } = buildObjects(scene);

    const geoSpy = vi.spyOn(outline.geometry, 'dispose');
    const matSpy = vi.spyOn(colliderWire.material as THREE.Material, 'dispose');
    const lightSpy = vi.spyOn(light, 'dispose');

    for (const o of [outline, descOutline, colliderWire, light]) {
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
    const { objs, outline, descOutline, colliderWire, light } = buildObjects(scene);

    const geoSpies = [outline, descOutline, colliderWire].map((o) => vi.spyOn(o.geometry, 'dispose'));
    const matSpies = [outline, descOutline, colliderWire].map((o) =>
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
    expect(objs.ecsLights.size).toBe(0);

    for (const o of [outline, descOutline, colliderWire, light]) {
      expect(scene.children).not.toContain(o);
    }
  });
});
