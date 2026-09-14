/** Every per-entity THREE object SceneView's setup closure owns. Grouped so the
 *  world-swap handler and the component teardown release the SAME set — #737 was the
 *  two of them diverging (teardown reached 2 of the 5 maps), and unlike Scene3D this
 *  teardown ends in a renderer LEASE, so the survivors kept live GL buffers across
 *  every StrictMode remount and every recovery rebuild. */

import type * as THREE from 'three';

export interface SceneViewEntityObjects {
  outlineMeshes: Map<number, THREE.LineSegments>;
  descOutlineMeshes: Map<number, THREE.LineSegments>;
  colliderWires: Map<number, THREE.LineSegments>;
  colliderWireSigs: Map<number, string>;
  ecsLights: Map<number, THREE.Light>;
}

function disposeMaterial(material: THREE.Material | THREE.Material[] | undefined) {
  if (!material) return;
  if (Array.isArray(material)) {
    for (const m of material) m.dispose();
  } else {
    material.dispose();
  }
}

/** Detach and dispose every per-entity object, emptying the maps. The icon and volume gizmos are
 *  not here: `SceneViewGizmoTable.clear()` releases those (`editor/scene/sceneViewGizmoTable.ts`),
 *  and both call sites clear it beside this call. */
export function disposeSceneViewEntityObjects(
  scene: THREE.Scene,
  objs: SceneViewEntityObjects,
): void {
  for (const [, o] of objs.outlineMeshes) {
    scene.remove(o);
    o.geometry?.dispose();
    disposeMaterial(o.material);
  }
  objs.outlineMeshes.clear();

  for (const [, o] of objs.descOutlineMeshes) {
    scene.remove(o);
    o.geometry?.dispose();
    disposeMaterial(o.material);
  }
  objs.descOutlineMeshes.clear();

  for (const [, o] of objs.colliderWires) {
    scene.remove(o);
    o.geometry?.dispose();
    disposeMaterial(o.material);
  }
  objs.colliderWires.clear();
  objs.colliderWireSigs.clear();

  for (const [, l] of objs.ecsLights) {
    scene.remove(l);
    l.dispose();
  }
  objs.ecsLights.clear();
}
