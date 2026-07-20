/** P7b — Bone two-way bridge. syncBones, each frame post-pose: read-back (mixer's
 *  THREE.Bone local → the Bone entity's Transform), LateUpdate (game code edits it,
 *  layering on top of the clip), write-back (Transform → THREE.Bone). Driven against
 *  a real koota world + a hand-built rig whose bone sits at a known local pose. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import * as THREE from 'three';
import { Transform, EntityAttributes, Bone, Animator } from '../../src/runtime/traits';
import { deactivatedEntities, transformPropagationSystem, worldTransforms } from '../../src/three/systems/transformPropagationSystem';
import { setPlayState } from '../../src/runtime/systems/playState';
import { setSkeletalPreview } from '../../src/runtime/systems/skeletalPreview';
import { registerLateUpdate, clearLateUpdates } from '../../src/runtime/systems/lateUpdate';
import { registerTrait, getAllTraits } from '../../src/runtime/ecs/traitRegistry';
import { setAnimationClip, clearAnimationClipCache } from '../../src/runtime/loaders/animationClipCache';
import type { AnimationClipDef } from '../../src/runtime/animation/types';
import { createRenderState, syncBones, type RenderState, type SkinnedEntry } from '../../src/runtime/rendering/scene3DSync';

/** Register the traits applyClipAtTime resolves by name (P7b-1b Animator-over-clip). */
function ensureTraitsRegistered() {
  const names = new Set(getAllTraits().map((m) => m.name));
  if (!names.has('Transform'))
    registerTrait({ name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' }, rz: { type: 'number' } } });
  if (!names.has('EntityAttributes'))
    registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' } } });
}

/** A clip with a single constant Transform track on the root (path ""). */
function constClip(field: string, value: number): AnimationClipDef {
  return { id: '', name: 'c', duration: 1, frameRate: 60, loop: true, tracks: [
    { path: '', trait: 'Transform', field, type: 'number', keys: [{ t: 0, v: value, inTangent: 0, outTangent: 0 }] },
  ] };
}

const scene = new THREE.Scene();
let world: ReturnType<typeof createWorld>;
let state: RenderState;

/** A bone posed at local position (0,1,0), rz=0.5, scale (1,2,1). */
function poseBone(): THREE.Bone {
  const bone = new THREE.Bone();
  bone.name = 'bone1';
  bone.position.set(0, 1, 0);
  bone.quaternion.setFromEuler(new THREE.Euler(0, 0, 0.5));
  bone.scale.set(1, 2, 1);
  return bone;
}
/** Spawn a SkinnedModel-root entity holding `bone` in its render entry. `current` is
 *  the playing clip name (drives read-back); pass undefined for a hand-posed rig with
 *  no clip. */
function spawnRig(bone: THREE.Bone, current: string | undefined = 'clip') {
  const rig = world.spawn(Transform(), EntityAttributes({ guid: 'rig', parentId: 0 }));
  state.skinned.set(rig.id(), { bones: new Map([[bone.name, bone]]), current } as unknown as SkinnedEntry);
  return rig;
}

beforeEach(() => {
  world = createWorld();
  state = createRenderState();
  deactivatedEntities.clear();
  clearLateUpdates();
  clearAnimationClipCache();
  ensureTraitsRegistered();
  setPlayState('playing');
  setSkeletalPreview(false, 0);
});
afterEach(() => { world.destroy(); setPlayState('stopped'); setSkeletalPreview(false, 0); clearLateUpdates(); clearAnimationClipCache(); });

describe('syncBones (P7b bridge)', () => {
  it('reads the posed bone back into the Bone entity Transform (local)', () => {
    const bone = poseBone();
    const rig = spawnRig(bone);
    const be = world.spawn(Transform(), Bone({ name: 'bone1' }), EntityAttributes({ guid: 'b', parentId: rig.id() }));

    syncBones(world, scene, state);

    const tf = be.get(Transform)!;
    expect(tf.y).toBeCloseTo(1);     // position
    expect(tf.rz).toBeCloseTo(0.5);  // rotation (euler from the bone quaternion)
    expect(tf.sy).toBeCloseTo(2);    // scale
  });

  it('writes a LateUpdate override back into the bone — LAYERED on top of the clip', () => {
    const bone = poseBone();
    const rig = spawnRig(bone);
    world.spawn(Transform(), Bone({ name: 'bone1' }), EntityAttributes({ guid: 'b', parentId: rig.id() }));
    // Override adds an X bend on top of whatever read-back set (the clip's rz=0.5).
    registerLateUpdate('test', (w) => w.query(Transform, Bone).updateEach(([tf]) => { tf.rx += 0.3; }));

    syncBones(world, scene, state);

    const e = new THREE.Euler().setFromQuaternion(bone.quaternion);
    expect(e.x).toBeCloseTo(0.3);    // override reached the skeleton
    expect(e.z).toBeCloseTo(0.5);    // clip pose preserved → layered, not replaced
  });

  it('does NOT accumulate frame-over-frame (the mixer re-poses, read-back resets)', () => {
    const bone = poseBone();
    const rig = spawnRig(bone);
    world.spawn(Transform(), Bone({ name: 'bone1' }), EntityAttributes({ guid: 'b', parentId: rig.id() }));
    registerLateUpdate('test', (w) => w.query(Transform, Bone).updateEach(([tf]) => { tf.rx += 0.3; }));

    for (let frame = 0; frame < 3; frame++) {
      bone.quaternion.setFromEuler(new THREE.Euler(0, 0, 0.5)); // the mixer re-poses to the clip each frame
      syncBones(world, scene, state);
    }

    const e = new THREE.Euler().setFromQuaternion(bone.quaternion);
    expect(e.x).toBeCloseTo(0.3);    // stays 0.3 across frames, not 0.9 — override layers, doesn't pile up
  });

  it('resolves the rig through an intermediate (non-skinned) ancestor', () => {
    const bone = poseBone();
    const rig = spawnRig(bone);
    const mid = world.spawn(Transform(), EntityAttributes({ guid: 'mid', parentId: rig.id() }));
    const be = world.spawn(Transform(), Bone({ name: 'bone1' }), EntityAttributes({ guid: 'n', parentId: mid.id() }));

    syncBones(world, scene, state);

    expect(be.get(Transform)!.rz).toBeCloseTo(0.5);  // walked mid → rig
  });

  it('NO clip + Playing: a hand edit STICKS and drives the bone (no read-back snap-back)', () => {
    // The reported bug: in Play, moving a bone of an un-animated rig snapped back —
    // read-back mirrored the bind pose over the edit every frame. With no clip there's
    // nothing to mirror, so the edit must persist and reach the skeleton.
    const bone = poseBone();
    const rig = spawnRig(bone, '');   // no clip driving it
    const be = world.spawn(Transform({ rx: 0.7 }), Bone({ name: 'bone1' }), EntityAttributes({ guid: 'b', parentId: rig.id() }));

    syncBones(world, scene, state);          // Playing (default)

    expect(be.get(Transform)!.rx).toBeCloseTo(0.7);                                 // edit NOT clobbered
    expect(new THREE.Euler().setFromQuaternion(bone.quaternion).x).toBeCloseTo(0.7); // reached the bone
  });

  it('NO clip + Stopped: hand-posing reaches the bone, Transform stays authored', () => {
    const bone = poseBone();
    const rig = spawnRig(bone, '');
    const be = world.spawn(Transform({ rx: 0.7 }), Bone({ name: 'bone1' }), EntityAttributes({ guid: 'b', parentId: rig.id() }));
    setPlayState('stopped');

    syncBones(world, scene, state);

    expect(be.get(Transform)!.rx).toBe(0.7);                                        // authored, untouched
    expect(new THREE.Euler().setFromQuaternion(bone.quaternion).x).toBeCloseTo(0.7); // bone driven → deforms
  });

  it('clip + Stopped: hand-posing reaches the bone (write-back runs; no wall-clock preview)', () => {
    // New model: Stopped freezes the mixer (no idle preview), so even a clip-driven rig
    // is hand-posable while Stopped — write-back applies the entity Transform to the bone.
    const bone = poseBone();                 // would-be clip preview: rz=0.5
    const rig = spawnRig(bone, 'clip');       // a clip exists
    const be = world.spawn(Transform({ rx: 0.7 }), Bone({ name: 'bone1' }), EntityAttributes({ guid: 'b', parentId: rig.id() }));
    setPlayState('stopped');

    syncBones(world, scene, state);

    expect(be.get(Transform)!.rx).toBe(0.7);   // authored Transform untouched (read-back skipped)
    const e = new THREE.Euler().setFromQuaternion(bone.quaternion);
    expect(e.x).toBeCloseTo(0.7);              // hand pose reached the bone (write-back ran)
    expect(Math.abs(e.z)).toBeLessThan(1e-6);  // bone follows the entity, NOT a wall-clock clip preview
  });

  it('clip + Playing + no layer: leaves the mixer pose UNTOUCHED (no lossy write-back echo)', () => {
    // The boned-prefab jitter bug: during plain clip playback the bridge read each
    // mixer-posed bone into its entity Transform and wrote it straight back through
    // compose→decompose every frame. For a wrapper-baked root bone that round-trip
    // drops the shear a non-uniform wrapper scale introduces, so the clean mixer pose
    // drifted frame-over-frame → visible jaggy Run animation. With no Animator/
    // LateUpdate layering the mixer fully owns the rig, so write-back must be SKIPPED.
    const bone = poseBone();
    const rig = spawnRig(bone, 'clip');
    // Wrapper prefix with NON-uniform scale: compose(bone)·prefix.fwd then a
    // decompose round-trip cannot be reconstructed exactly → would drift the bone.
    const fwd = new THREE.Matrix4().compose(
      new THREE.Vector3(),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.2, 0)),
      new THREE.Vector3(2, 5, 9),
    );
    (state.skinned.get(rig.id()) as unknown as SkinnedEntry).boneWrapperPrefix = new Map([['bone1', { fwd, inv: fwd.clone().invert() }]]);
    world.spawn(Transform(), Bone({ name: 'bone1' }), EntityAttributes({ guid: 'b', parentId: rig.id() }));

    const p0 = bone.position.clone(), q0 = bone.quaternion.clone(), s0 = bone.scale.clone();
    syncBones(world, scene, state);  // Playing, clip-driven, no layer

    expect(bone.position.distanceTo(p0)).toBeLessThan(1e-9);     // bone bytes unchanged…
    expect(Math.abs(bone.quaternion.dot(q0))).toBeCloseTo(1, 9); // …mixer stays authoritative
    expect(bone.scale.distanceTo(s0)).toBeLessThan(1e-9);
  });

  it('mixed rig: an Animator-driven bone writes back; its clip-driven sibling stays byte-identical', () => {
    // The case the old global `!layered` guard could NOT handle: the moment ANY bone got
    // an Animator/LateUpdate, the coarse guard wrote back EVERY bone — dragging the
    // pure-clip siblings through the lossy echo (so jitter returned as soon as a rig added
    // one procedural/IK bone). Per-bone dirty tracking writes ONLY the bone that diverged.
    setAnimationClip('anim-clip', constClip('rx', 0.9));
    const boneA = poseBone(); boneA.name = 'boneA';   // pure clip-driven, wrapper-baked root
    const boneB = poseBone(); boneB.name = 'boneB';   // clip-driven + an Animator on top
    const rig = world.spawn(Transform(), EntityAttributes({ guid: 'rig', parentId: 0 }));
    const fwd = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.2, 0)), new THREE.Vector3(2, 5, 9));
    state.skinned.set(rig.id(), {
      bones: new Map([['boneA', boneA], ['boneB', boneB]]),
      current: 'clip',
      boneWrapperPrefix: new Map([['boneA', { fwd, inv: fwd.clone().invert() }]]),
    } as unknown as SkinnedEntry);
    world.spawn(Transform(), Bone({ name: 'boneA' }), EntityAttributes({ guid: 'a', parentId: rig.id() }));
    world.spawn(Transform(), Bone({ name: 'boneB' }), Animator({ clips: '[{"name":"c","clip":"anim-clip"}]', clip: 'c' }), EntityAttributes({ guid: 'b', parentId: rig.id() }));

    const ap = boneA.position.clone(), aq = boneA.quaternion.clone(), asc = boneA.scale.clone();
    syncBones(world, scene, state);

    // Pure-clip sibling: untouched, mixer stays authoritative (no echo, despite the layer).
    expect(boneA.position.distanceTo(ap)).toBeLessThan(1e-9);
    expect(Math.abs(boneA.quaternion.dot(aq))).toBeCloseTo(1, 9);
    expect(boneA.scale.distanceTo(asc)).toBeLessThan(1e-9);
    // Animator-driven sibling: the layered pose reached the skeleton.
    const e = new THREE.Euler().setFromQuaternion(boneB.quaternion);
    expect(e.x).toBeCloseTo(0.9);   // Animator override applied
    expect(e.z).toBeCloseTo(0.5);   // clip pose preserved on the un-animated field
  });

  it('skips a Bone with a missing name / no skinned ancestor (no crash, no write)', () => {
    spawnRig(poseBone());
    const orphan = world.spawn(Transform({ x: 5 }), Bone({ name: 'nope' }), EntityAttributes({ guid: 'o', parentId: 0 }));

    expect(() => syncBones(world, scene, state)).not.toThrow();
    expect(orphan.get(Transform)!.x).toBe(5);
  });

  // ── P7b-1b: a bone-targeting Animator LAYERS on top of the skeletal clip ──
  it('an Animator on a Bone overrides the clip pose for the fields it animates', () => {
    setAnimationClip('anim-clip', constClip('rx', 0.9));  // the Animator bends rx
    const bone = poseBone();                              // clip pose: rz=0.5, rx=0
    const rig = spawnRig(bone, 'clip');                  // a skeletal clip is driving the rig
    world.spawn(
      Transform(), Bone({ name: 'bone1' }), Animator({ clips: '[{"name":"c","clip":"anim-clip"}]', clip: 'c' }),
      EntityAttributes({ guid: 'b', parentId: rig.id() }),
    );

    syncBones(world, scene, state);

    const e = new THREE.Euler().setFromQuaternion(bone.quaternion);
    expect(e.x).toBeCloseTo(0.9);   // Animator override reached the skeleton
    expect(e.z).toBeCloseTo(0.5);   // clip pose preserved on the un-animated field → layered
  });

  it('a bone-targeting Animator does NOT run while Stopped (authoring stays clean)', () => {
    setAnimationClip('anim-clip', constClip('rx', 0.9));
    const bone = poseBone();
    const rig = spawnRig(bone, 'clip');
    world.spawn(Transform(), Bone({ name: 'bone1' }), Animator({ clips: '[{"name":"c","clip":"anim-clip"}]', clip: 'c' }),
      EntityAttributes({ guid: 'b', parentId: rig.id() }));
    setPlayState('stopped');

    syncBones(world, scene, state);

    const e = new THREE.Euler().setFromQuaternion(bone.quaternion);
    expect(Math.abs(e.x)).toBeLessThan(1e-6);  // Animator did NOT pose (layer step is Play-only)
    expect(Math.abs(e.z)).toBeLessThan(1e-6);  // bone follows the authored Transform (identity), not a clip preview
  });

  // ── P7b-1b: a renderable parented UNDER a bone follows it the SAME frame ──
  it('re-places a child-of-bone renderable to track the bone this frame (no 1-frame lag)', () => {
    // Translation-only bone so the child's world position is the bone offset + its
    // own local offset, with no rotation/scale to muddy the assertion.
    const bone = new THREE.Bone();
    bone.name = 'bone1';
    bone.position.set(0, 1, 0);               // mixer poses it 1 unit up
    const rig = spawnRig(bone, 'clip');        // clip-driven → read-back moves the bone entity
    const boneEnt = world.spawn(Transform(), Bone({ name: 'bone1' }), EntityAttributes({ guid: 'b', parentId: rig.id() }));
    const child = world.spawn(Transform({ x: 2 }), EntityAttributes({ guid: 'c', parentId: boneEnt.id() }));
    const obj = new THREE.Object3D();
    state.ecsObjects.set(child.id(), obj);

    // Pipeline propagation runs BEFORE the mixer poses the bone → child sees the bone
    // at its bind pose (y=0). Simulate syncRenderables placing the object there.
    transformPropagationSystem(world);
    obj.position.set(worldTransforms.get(child.id())!.x, worldTransforms.get(child.id())!.y, worldTransforms.get(child.id())!.z);
    expect(obj.position.y).toBeCloseTo(0);    // stale: bone hadn't moved yet

    syncBones(world, scene, state);

    // read-back moved the bone entity to y=1; the same-frame re-propagation + re-apply
    // must have carried the child along.
    expect(worldTransforms.get(child.id())!.y).toBeCloseTo(1);
    expect(obj.position.y).toBeCloseTo(1);    // child rode the bone THIS frame
    expect(obj.position.x).toBeCloseTo(2);    // its own local offset preserved
  });
});

/** Regression — Animation-editor preview of a KEYFRAME Animator clip in the Scene
 *  window (the Cone in the Skinned Test scene).
 *
 *  The bug: previewing globally flipped the `skeletalPreview` flag, which made
 *  `syncBones` treat the stopped editor as "playing" and run the bone-Animator
 *  LAYER pass. That pass re-poses the rig from the ECS `Animator.time` — which the
 *  preview never advances (only the editor's store playhead moves) — so it stamped
 *  the keyframe pose the editor just wrote BACK to frame 0 every render. Net: the
 *  Cone looked frozen even though its bone Transform briefly held the right value.
 *
 *  The fix keeps the preview flag OFF for a keyframe clip, so the editor's pose is
 *  the sole writer and write-back carries it to the skeleton — like a scrub. These
 *  two tests pin both halves: the off path must NOT clobber; the on path WOULD. */
describe('keyframe Animator preview on a stopped rig (scene-window preview)', () => {
  /** A clip whose bone1 track is 0 at every time (so the layer pass, sampling at
   *  Animator.time = 0, would reset a non-zero editor pose to 0). */
  const zeroAtT0: AnimationClipDef = {
    id: '', name: 'kf', duration: 2, frameRate: 60, loop: true,
    tracks: [{ path: 'bone1', trait: 'Transform', field: 'rx', type: 'number', keys: [{ t: 0, v: 0, inTangent: 0, outTangent: 0 }] }],
  };

  /** Build the Cone-shaped rig: a SkinnedModel root with NO skeletal clip (current '')
   *  carrying a bone-targeting Animator, and a `bone1` child whose Transform the editor
   *  preview already posed to `editorRx` (as applyClipAtTime does at the playhead). */
  function setupConeRig(editorRx: number) {
    const bone = new THREE.Bone();
    bone.name = 'bone1';                 // identity bind pose
    const rig = spawnRig(bone, '');       // no skeletal clip — exactly the Cone
    setAnimationClip('cone-kf', zeroAtT0);
    rig.add(Animator({ clips: '[{"name":"c","clip":"cone-kf"}]', clip: 'c', time: 0, playing: true }));
    // Name the entity so the clip's `bone1` track path resolves from the rig root.
    const be = world.spawn(Transform({ rx: editorRx }), Bone({ name: 'bone1' }), EntityAttributes({ guid: 'b', name: 'bone1', parentId: rig.id() }));
    return { bone, be };
  }

  it('preview OFF: the editor pose survives and deforms the mesh (no clobber)', () => {
    setPlayState('stopped');
    setSkeletalPreview(false, 0);          // keyframe preview no longer flips this
    const { bone, be } = setupConeRig(-0.5);

    syncBones(world, scene, state);

    expect(be.get(Transform)!.rx).toBeCloseTo(-0.5);                                 // editor pose intact
    expect(new THREE.Euler().setFromQuaternion(bone.quaternion).x).toBeCloseTo(-0.5); // reached the skeleton → deforms
  });

  it('preview ON (the old hazard): the layer pass clobbers the pose back to Animator.time=0', () => {
    setPlayState('stopped');
    setSkeletalPreview(true, 0.016);       // what SceneView used to do during preview
    const { bone, be } = setupConeRig(-0.5);

    syncBones(world, scene, state);

    expect(be.get(Transform)!.rx).toBeCloseTo(0);                                    // editor pose overwritten…
    expect(Math.abs(new THREE.Euler().setFromQuaternion(bone.quaternion).x)).toBeLessThan(1e-6); // …mesh sits at bind (frozen)
  });
});
