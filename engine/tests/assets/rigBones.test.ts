// @vitest-environment node
//   GLTFLoader.parse mis-reads the GLB binary header under jsdom; node decodes it.
/** P7b-2 skeleton expansion — extractRigBones flattens a rigged GLB's skeleton to
 *  the bind-pose RigBoneInfo[] the importer spawns as `Bone` entities. Drives the
 *  REAL generated test rigs: cylinder (bone0/1/2) + the foreign capsule (joint0/1/2),
 *  a 3-bone vertical chain, each bone 1 unit above its parent. */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { extractRigBones, glbDeclaresSkin } from '../../packages/modoki/src/editor/scene/rigBones';

const ASSET_DIR = path.resolve(__dirname, '../../../games/3d-test/runtime/assets/models/skinned-test');

function loadGLB(file: string): Promise<{ scene: THREE.Group }> {
  const buf = fs.readFileSync(path.join(ASSET_DIR, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => new GLTFLoader().parse(ab, '', res as never, rej));
}
function skeletonsOf(root: THREE.Object3D): Set<THREE.Skeleton> {
  const set = new Set<THREE.Skeleton>();
  root.traverse((o) => { const m = o as THREE.SkinnedMesh; if (m.isSkinnedMesh && m.skeleton) set.add(m.skeleton); });
  return set;
}

// Uses generated GLB fixtures under games/3d-test; skip when absent (engine-only OSS repo).
// TODO(oss): move these skinned-test GLBs to an engine-owned tests/ fixture so they run in public.
describe.skipIf(!fs.existsSync(ASSET_DIR))('extractRigBones (P7b-2 skeleton expansion)', () => {
  let cylinder: Awaited<ReturnType<typeof loadGLB>>;
  let capsule: Awaited<ReturnType<typeof loadGLB>>;

  beforeAll(async () => {
    [cylinder, capsule] = await Promise.all([loadGLB('cylinder.glb'), loadGLB('capsule.glb')]);
  });

  it('flattens the cylinder rig to a parent-linked bone chain (bone0→bone1→bone2)', () => {
    const bones = extractRigBones(skeletonsOf(cylinder.scene));
    const byName = Object.fromEntries(bones.map((b) => [b.name, b]));
    expect(Object.keys(byName).sort()).toEqual(['bone0', 'bone1', 'bone2']);
    expect(byName.bone0.parent).toBeNull();        // root bone → parented to the model root
    expect(byName.bone1.parent).toBe('bone0');
    expect(byName.bone2.parent).toBe('bone1');
  });

  it('captures each bone BIND-pose LOCAL transform (1 unit above its parent)', () => {
    const byName = Object.fromEntries(extractRigBones(skeletonsOf(cylinder.scene)).map((b) => [b.name, b]));
    expect(byName.bone0.pos[1]).toBeCloseTo(0);    // root bone at origin
    expect(byName.bone1.pos[1]).toBeCloseTo(1);    // local +1 under bone0
    expect(byName.bone2.pos[1]).toBeCloseTo(1);    // local +1 under bone1
    // Bind pose has no rotation; identity scale.
    expect(byName.bone1.rot.every((r) => Math.abs(r) < 1e-6)).toBe(true);
    expect(byName.bone1.scale).toEqual([1, 1, 1]);
  });

  it('handles the FOREIGN rig too (joint0→joint1→joint2)', () => {
    const byName = Object.fromEntries(extractRigBones(skeletonsOf(capsule.scene)).map((b) => [b.name, b]));
    expect(Object.keys(byName).sort()).toEqual(['joint0', 'joint1', 'joint2']);
    expect(byName.joint0.parent).toBeNull();
    expect(byName.joint1.parent).toBe('joint0');
    expect(byName.joint2.parent).toBe('joint1');
  });

  it('bakes a non-bone wrapper (FBX armature: rotation + 100x scale) into the root bone', () => {
    // Mirror the real alien GLB: scene -> "Armature" Object3D (Z-up->Y-up -90deg X +
    // 100x unit scale) -> root bone -> child bone. extractRigBones must author the
    // ROOT bone relative to the scene so the wrapper is baked in — else the skeleton
    // collapses ~100x small at the origin and is mis-rotated (the bones-off-mesh bug).
    const scene = new THREE.Group();
    const armature = new THREE.Object3D();
    armature.name = 'Armature';
    armature.rotation.set(-Math.PI / 2, 0, 0);
    armature.scale.set(100, 100, 100);
    const root = new THREE.Bone(); root.name = 'root';
    const child = new THREE.Bone(); child.name = 'child'; child.position.set(0, 2, 0);
    root.add(child); armature.add(root); scene.add(armature);
    scene.updateMatrixWorld(true);
    const skel = new THREE.Skeleton([root, child]);

    const byName = Object.fromEntries(extractRigBones([skel], scene).map((b) => [b.name, b]));
    // Root bone baked: carries the wrapper's 100x scale and -90deg X (NOT identity).
    expect(byName.root.parent).toBeNull();
    expect(byName.root.scale[0]).toBeCloseTo(100);
    expect(Math.abs(byName.root.rot[0])).toBeCloseTo(Math.PI / 2);
    // Child stays parent-LOCAL (its parent bone entity carries the chain).
    expect(byName.child.parent).toBe('root');
    expect(byName.child.pos[1]).toBeCloseTo(2);
    expect(byName.child.scale).toEqual([1, 1, 1]);
    // Reconstructing root∘child world (scene space) must equal the GLB bone world.
    const recon = new THREE.Matrix4()
      .multiply(new THREE.Matrix4().compose(new THREE.Vector3(...byName.root.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...byName.root.rot)), new THREE.Vector3(...byName.root.scale)))
      .multiply(new THREE.Matrix4().compose(new THREE.Vector3(...byName.child.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...byName.child.rot)), new THREE.Vector3(...byName.child.scale)));
    const got = new THREE.Vector3().setFromMatrixPosition(recon);
    const want = child.getWorldPosition(new THREE.Vector3());   // 100 * 2 along -Z after -90deg X
    expect(got.distanceTo(want)).toBeLessThan(1e-4);
  });

  it('glbDeclaresSkin: true for a rigged GLB, false for a static one (or junk)', () => {
    const ab = (p: string) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
    // The inspector uses this to show skinned-model controls before import.
    expect(glbDeclaresSkin(ab(path.join(ASSET_DIR, 'capsule.glb')))).toBe(true);   // rigged
    const island = path.resolve(__dirname, '../../../games/3d-test/runtime/assets/models/tropical-island/island.glb');
    expect(glbDeclaresSkin(ab(island))).toBe(false);                               // static
    expect(glbDeclaresSkin(new ArrayBuffer(4))).toBe(false);                       // not a GLB
  });
});
