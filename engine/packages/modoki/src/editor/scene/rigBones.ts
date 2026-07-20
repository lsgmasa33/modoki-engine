/** Skeleton flattening for opt-in bone-entity expansion at import (P7b). Pure
 *  (THREE-only) so it's unit-testable in isolation, away from modelImport's
 *  editor/browser deps. */

import * as THREE from 'three';

/** One bone of a rigged GLB's skeleton. `parent` is the parent BONE name (null =
 *  skeleton root); the transform is the BIND-pose LOCAL transform (what a `Bone`
 *  entity authors as its bind pose). */
export interface RigBoneInfo {
  name: string;
  parent: string | null;
  pos: [number, number, number];
  rot: [number, number, number];
  scale: [number, number, number];
}

/** Does a GLB's glTF JSON declare a skin? Reads ONLY the JSON chunk (no geometry
 *  parse) — a cheap way to tell a rigged GLB from a static one before import. */
export function glbDeclaresSkin(buf: ArrayBuffer): boolean {
  try {
    if (buf.byteLength < 20) return false;
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) return false; // 'glTF' magic (little-endian)
    const jsonLen = dv.getUint32(12, true);                 // chunk 0 (JSON) length
    if (20 + jsonLen > buf.byteLength) return false;
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
    return Array.isArray(json.skins) && json.skins.length > 0;
  } catch { return false; }
}

/** Flatten a rig's skeleton(s) to `RigBoneInfo[]` (deduped by name, first wins).
 *  Call on a freshly-loaded GLB (rig at bind pose, no mixer) so each bone's local
 *  TRS is its bind-pose local.
 *
 *  `sceneRoot` is the gltf scene Group the imported `Bone` entities hang under (via
 *  the model-root entity). A child bone authors its parent-LOCAL TRS — its parent
 *  bone entity carries the chain. But a ROOT bone (parent is not a bone) is parented
 *  to the model root, so it must author its transform RELATIVE TO `sceneRoot`, which
 *  BAKES IN any non-bone wrapper between the scene root and the skeleton — the
 *  Blender/FBX "Armature" node that carries the Z-up→Y-up rotation AND the 100× unit
 *  scale. Reading a root bone's parent-LOCAL TRS instead drops that wrapper, leaving
 *  the whole skeleton ~100× too small (collapsed at the origin) and mis-rotated, so
 *  the bone entities no longer overlay the skinned mesh. */
export function extractRigBones(
  skeletons: Iterable<THREE.Skeleton>,
  sceneRoot?: THREE.Object3D,
): RigBoneInfo[] {
  const euler = new THREE.Euler();
  const out = new Map<string, RigBoneInfo>();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scl = new THREE.Vector3();
  const _rel = new THREE.Matrix4();
  const invRoot = new THREE.Matrix4();
  if (sceneRoot) {
    sceneRoot.updateWorldMatrix(true, false);
    invRoot.copy(sceneRoot.matrixWorld).invert();
  }
  for (const skel of skeletons) {
    for (const bone of skel.bones) {
      if (!bone || out.has(bone.name)) continue;
      const par = bone.parent as (THREE.Object3D & { isBone?: boolean }) | null;
      const parentBone = par && par.isBone && par.name ? par.name : null;
      if (parentBone) {
        // Child bone — parent-local bind TRS (its parent bone entity carries the chain).
        euler.setFromQuaternion(bone.quaternion);
        out.set(bone.name, {
          name: bone.name,
          parent: parentBone,
          pos: [bone.position.x, bone.position.y, bone.position.z],
          rot: [euler.x, euler.y, euler.z],
          scale: [bone.scale.x, bone.scale.y, bone.scale.z],
        });
      } else {
        // Root bone — author its transform relative to sceneRoot so the non-bone
        // armature wrapper (rotation + 100× scale) is baked in (see doc comment).
        bone.updateWorldMatrix(true, false);
        _rel.multiplyMatrices(invRoot, bone.matrixWorld).decompose(_pos, _quat, _scl);
        euler.setFromQuaternion(_quat);
        out.set(bone.name, {
          name: bone.name,
          parent: null,
          pos: [_pos.x, _pos.y, _pos.z],
          rot: [euler.x, euler.y, euler.z],
          scale: [_scl.x, _scl.y, _scl.z],
        });
      }
    }
  }
  return [...out.values()];
}
