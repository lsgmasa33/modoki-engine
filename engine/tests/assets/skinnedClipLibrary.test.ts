// @vitest-environment node
//   GLTFLoader.parse mis-reads the GLB binary header under the suite's default
//   jsdom env ("Unsupported asset"); the node env decodes it correctly.
/** P6 shared clip library — integration test against the REAL procedurally
 *  generated test assets (engine/scripts/gen-skinned-test-models.mjs):
 *  cylinder.glb + cone.glb (bare rigs, no clips) + clips.glb (bent/shrink/stretch
 *  on the SAME 3-bone rig) + shared.animset.json.
 *
 *  Proves the cross-model premise end-to-end with real THREE objects: a clip
 *  authored in clips.glb binds — by bone NAME — to a DIFFERENT model's skeleton
 *  (the cone) and actually moves its bones. This is what `AnimationLibrary` /
 *  `mergeAnimationLibrary` rely on; the orchestration logic itself is covered by
 *  the mocked unit tests in scene3DSync.test.ts. */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton, retargetClip } from 'three/examples/jsm/utils/SkeletonUtils.js';

const ASSET_DIR = path.resolve(__dirname, '../../../games/3d-test/runtime/assets/models/skinned-test');

function loadGLB(file: string): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  const buf = fs.readFileSync(path.join(ASSET_DIR, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => new GLTFLoader().parse(ab, '', res as never, rej));
}

function boneNames(root: THREE.Object3D): string[] {
  const out: string[] = [];
  root.traverse((o) => { if ((o as THREE.Bone).isBone) out.push(o.name); });
  return out.sort();
}
function findBone(root: THREE.Object3D, name: string): THREE.Bone | undefined {
  let b: THREE.Bone | undefined;
  root.traverse((o) => { if (!b && (o as THREE.Bone).isBone && o.name === name) b = o as THREE.Bone; });
  return b;
}
function hasSkinning(root: THREE.Object3D): boolean {
  let ok = false;
  root.traverse((o) => { const m = o as THREE.SkinnedMesh; if (m.isSkinnedMesh && m.geometry.attributes.skinIndex) ok = true; });
  return ok;
}

// Uses generated GLB fixtures under games/3d-test; skip when absent (engine-only OSS repo).
// TODO(oss): move these skinned-test GLBs to an engine-owned tests/ fixture so they run in public.
describe.skipIf(!fs.existsSync(ASSET_DIR))('P6 skinned clip library (real generated assets)', () => {
  let cylinder: Awaited<ReturnType<typeof loadGLB>>;
  let cone: Awaited<ReturnType<typeof loadGLB>>;
  let clips: Awaited<ReturnType<typeof loadGLB>>;
  let capsule: Awaited<ReturnType<typeof loadGLB>>;

  beforeAll(async () => {
    [cylinder, cone, clips, capsule] = await Promise.all([
      loadGLB('cylinder.glb'), loadGLB('cone.glb'), loadGLB('clips.glb'), loadGLB('capsule.glb'),
    ]);
  });

  it('all three models share the identical 3-bone structure', () => {
    expect(boneNames(cylinder.scene)).toEqual(['bone0', 'bone1', 'bone2']);
    expect(boneNames(cone.scene)).toEqual(['bone0', 'bone1', 'bone2']);
    expect(boneNames(clips.scene)).toEqual(['bone0', 'bone1', 'bone2']);
  });

  it('the display models are skinned but own NO clips (they rely on the library)', () => {
    expect(hasSkinning(cylinder.scene)).toBe(true);
    expect(hasSkinning(cone.scene)).toBe(true);
    expect(cylinder.animations).toHaveLength(0);
    expect(cone.animations).toHaveLength(0);
  });

  it('the library carries bent/shrink/stretch on the shared bones', () => {
    expect(clips.animations.map((c) => c.name).sort()).toEqual(['bent', 'shrink', 'stretch']);
    const tracks = (name: string) => clips.animations.find((c) => c.name === name)!.tracks.map((t) => t.name);
    // Every track targets a bone in the shared rig → binds across models by name.
    for (const c of clips.animations) {
      for (const t of c.tracks) expect(t.name).toMatch(/^bone[012]\.(quaternion|scale|position)$/);
    }
    expect(tracks('bent')).toEqual(expect.arrayContaining(['bone1.quaternion', 'bone2.quaternion']));
  });

  it('a library clip binds by bone name to the CONE and actually moves its bones', () => {
    // Clone the cone (its own rig) and drive it with the "bent" clip authored in
    // clips.glb — a different model. If binding-by-name works, the cone's bone1
    // rotates away from identity.
    const coneRig = cloneSkeleton(cone.scene);
    const bentClip = clips.animations.find((c) => c.name === 'bent')!;
    const mixer = new THREE.AnimationMixer(coneRig);
    mixer.clipAction(bentClip).play();

    const bone1 = findBone(coneRig, 'bone1')!;
    expect(Math.abs(bone1.quaternion.z)).toBeLessThan(1e-6); // identity at rest
    mixer.update(0.6);                                        // → peak of the bend
    expect(Math.abs(bone1.quaternion.z)).toBeGreaterThan(0.1); // bone moved → clip bound by name
  });

  it('the capsule is a FOREIGN rig (joint0/1/2) — needs a bone map to play the library', () => {
    expect(boneNames(capsule.scene)).toEqual(['joint0', 'joint1', 'joint2']);
    expect(capsule.animations).toHaveLength(0);
    // Direct bind would FAIL: the library's tracks target bone1, which the capsule
    // doesn't have — so the clip moves nothing without retargeting.
    const capRig = cloneSkeleton(capsule.scene);
    const mixer = new THREE.AnimationMixer(capRig);
    mixer.clipAction(clips.animations.find((c) => c.name === 'bent')!).play();
    mixer.update(0.6);
    expect(Math.abs(findBone(capRig, 'joint1')!.quaternion.z)).toBeLessThan(1e-6); // unmoved (no binding)
  });

  it('a bone map retargets a library clip onto the foreign capsule rig and moves it', () => {
    // retargetClip with options.names mapping THIS rig's bone → the source bone:
    // joint1 ← bone1, etc. (the exact shape AnimationLibrary.boneMaps feeds in).
    const capRig = cloneSkeleton(capsule.scene);
    const srcMesh = clips.scene.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
    const tgtMesh = capRig.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
    const bentClip = clips.animations.find((c) => c.name === 'bent')!;

    const retargeted = retargetClip(tgtMesh, srcMesh, bentClip, {
      names: { joint0: 'bone0', joint1: 'bone1', joint2: 'bone2' },
    });
    // retargetClip emits skeleton-relative `.bones[Name].prop` track names (bind
    // only to a SkinnedMesh). mergeAnimationLibrary rewrites them to node-name form
    // so they bind to the clone ROOT (a Group) — mirror that here.
    for (const t of retargeted.tracks) t.name = t.name.replace(/^\.bones\[(.+?)\]\./, '$1.');
    expect(retargeted.tracks.some((t) => t.name === 'joint1.quaternion')).toBe(true);

    const mixer = new THREE.AnimationMixer(capRig);
    mixer.clipAction(retargeted).play();
    const joint1 = findBone(capRig, 'joint1')!;
    mixer.update(0.6);
    expect(Math.abs(joint1.quaternion.z)).toBeGreaterThan(0.1); // foreign rig bent → retarget works
  });

  it('a scale-only clip (stretch) survives retargeting onto the foreign capsule', () => {
    // retargetClip resamples only position(hip)+quaternion — it DROPS scale tracks,
    // so a scale-only clip (stretch animates bone0.scale) retargets to a clip that
    // moves NOTHING. mergeAnimationLibrary re-attaches the source scale tracks,
    // renamed target←source via the bone map. This is the bug the user hit: the
    // capsule set to stretch/shrink didn't animate. Mirror the runtime path here.
    const capRig = cloneSkeleton(capsule.scene);
    const srcMesh = clips.scene.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
    const tgtMesh = capRig.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
    const stretchClip = clips.animations.find((c) => c.name === 'stretch')!;
    const boneMap = { joint0: 'bone0', joint1: 'bone1', joint2: 'bone2' };

    const retargeted = retargetClip(tgtMesh, srcMesh, stretchClip, { names: boneMap });
    for (const t of retargeted.tracks) t.name = t.name.replace(/^\.bones\[(.+?)\]\./, '$1.');
    // retargetClip dropped the scale track entirely → without carry-over, nothing moves.
    expect(retargeted.tracks.some((t) => t.name.endsWith('.scale'))).toBe(false);
    // Carry the source scale track over, remapped bone0 → joint0 (what the runtime does).
    const srcToTarget: Record<string, string> = { bone0: 'joint0', bone1: 'joint1', bone2: 'joint2' };
    for (const t of stretchClip.tracks) {
      const m = /^(.+?)\.scale$/.exec(t.name);
      if (!m) continue;
      const c = t.clone();
      c.name = `${srcToTarget[m[1]]}.scale`;
      retargeted.tracks.push(c);
    }
    retargeted.resetDuration();
    expect(retargeted.tracks.some((t) => t.name === 'joint0.scale')).toBe(true);

    const mixer = new THREE.AnimationMixer(capRig);
    mixer.clipAction(retargeted).play();
    const joint0 = findBone(capRig, 'joint0')!;
    expect(Math.abs(joint0.scale.y - 1)).toBeLessThan(1e-6); // at rest
    mixer.update(0.6);                                        // → peak (y stretches to 1.8)
    expect(joint0.scale.y).toBeGreaterThan(1.5);             // foreign rig stretched → scale survives
  });

  it('shared.animset.json sources clips.glb and lists the 3 clips', () => {
    const set = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, 'shared.animset.json'), 'utf-8'));
    const clipsMeta = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, 'clips.glb.meta.json'), 'utf-8'));
    expect(set.source).toBe(clipsMeta.id);                   // animset → clips.glb GUID
    expect(set.clips.map((c: { name: string }) => c.name).sort()).toEqual(['bent', 'shrink', 'stretch']);
  });
});
