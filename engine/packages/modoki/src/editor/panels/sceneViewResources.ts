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
  ecsGizmos: Map<number, THREE.Object3D>;
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

/** Detach and dispose every per-entity object, emptying the maps.
 *  @param keep an object the CALLER keeps across the call — the persistent
 *         `camGizmoPivot`, added to the scene once at init and reused across world
 *         swaps. It is skipped for BOTH removal and disposal but still dropped from
 *         the map, which is exactly what the swap handler does today (removing it
 *         orphans it and makes TransformControls warn every frame on the next Camera
 *         select). Teardown passes nothing — everything goes. */
export function disposeSceneViewEntityObjects(
  scene: THREE.Scene,
  objs: SceneViewEntityObjects,
  keep?: THREE.Object3D,
): void {
  for (const [, o] of objs.outlineMeshes) {
    if (o === keep) continue;
    scene.remove(o);
    o.geometry?.dispose();
    disposeMaterial(o.material);
  }
  objs.outlineMeshes.clear();

  for (const [, o] of objs.descOutlineMeshes) {
    if (o === keep) continue;
    scene.remove(o);
    o.geometry?.dispose();
    disposeMaterial(o.material);
  }
  objs.descOutlineMeshes.clear();

  for (const [, o] of objs.colliderWires) {
    if (o === keep) continue;
    scene.remove(o);
    o.geometry?.dispose();
    disposeMaterial(o.material);
  }
  objs.colliderWires.clear();
  objs.colliderWireSigs.clear();

  for (const [, o] of objs.ecsGizmos) {
    if (o === keep) continue;
    scene.remove(o);
    disposeMaterial((o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined);
    // Geometry is normally NOT disposed here — almost every gizmo shares a GIZMO_SHAPES.*
    // geometry that lives for the whole `setup()` lifetime (not module-level), and
    // disposing one on a world swap would break every OTHER live gizmo of that shape.
    // Releasing those is SceneView.tsx's component-teardown job, not this helper's — it
    // runs once, after every gizmo referencing them is gone. The one exception is the
    // Zone3D capsule: its radius and
    // segment length are independent, so a shared unit capsule can't express it and
    // SceneView mints a `new THREE.CapsuleGeometry(...)` per zone entity instead, tagged
    // with `userData.zoneCapSig`. That per-entity geometry has no other owner, so it must
    // be disposed here or it leaks on every world swap / teardown.
    if ((o.userData as { zoneCapSig?: string }).zoneCapSig) {
      (o as THREE.Mesh).geometry?.dispose();
    }
  }
  objs.ecsGizmos.clear();

  for (const [, l] of objs.ecsLights) {
    if (l === keep) continue;
    scene.remove(l);
    l.dispose();
  }
  objs.ecsLights.clear();
}
