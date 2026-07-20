/** previewTimelineAt — the editor scrub-preview helper: poses activation + SAMPLES keyframe
 *  Animator clips to an exact frame (so a stopped SceneView shows the pose), and publishes a
 *  SEEK request for each 3D SkeletalAnimator target (Phase 5) that the render layer consumes to
 *  pose the THREE mixer at the exact time. */

import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { Transform } from '../../src/runtime/traits/Transform';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Animator } from '../../src/runtime/traits/Animator';
import { SkeletalAnimator } from '../../src/runtime/traits/SkeletalAnimator';
import { registerTrait, getAllTraits } from '../../src/runtime/ecs/traitRegistry';
import { setAnimationClip } from '../../src/runtime/loaders/animationClipCache';
import { previewTimelineAt } from '../../src/runtime/systems/timelineSystem';
import { getSkeletalSeek, hasSkeletalSeeks, clearSkeletalSeeks } from '../../src/runtime/systems/skeletalSeek';
import { normalizeTimeline } from '../../src/runtime/timeline/types';
import type { AnimationClipDef } from '../../src/runtime/animation/types';

const CLIP: AnimationClipDef = {
  id: 'clip-guid', name: 'move', duration: 1, frameRate: 60, loop: false,
  tracks: [
    { path: '', trait: 'Transform', field: 'x', type: 'number',
      keys: [{ t: 0, v: 0, inTangent: 100, outTangent: 100 }, { t: 1, v: 100, inTangent: 100, outTangent: 100 }] },
  ],
};

function ensureRegistered() {
  const names = new Set(getAllTraits().map((m) => m.name));
  if (!names.has('Transform')) registerTrait({ name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' } } });
  if (!names.has('EntityAttributes')) registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' } } });
}

describe('previewTimelineAt', () => {
  beforeEach(ensureRegistered);

  it('samples a keyframe Animator clip to the exact frame + toggles activation', () => {
    const world = createWorld();
    setAnimationClip('seed.anim.json', CLIP);
    const root = world.spawn(EntityAttributes({ name: 'root' }));
    const alien = world.spawn(
      EntityAttributes({ name: 'Alien', parentId: root.id() }),
      Transform({ x: 0 }),
      Animator({ clips: JSON.stringify([{ name: 'move', clip: 'seed.anim.json' }]), clip: '' }),
    );
    const prop = world.spawn(EntityAttributes({ name: 'Prop', parentId: root.id(), isActive: true }));

    const def = normalizeTimeline({
      id: 'tl', duration: 2, frameRate: 60,
      tracks: [
        { id: 'a', name: 'Anim', target: 'Alien', type: 'animation', clips: [{ start: 0, duration: 1, clip: 'move' }] },
        { id: 'p', name: 'Act', target: 'Prop', type: 'activation', spans: [{ start: 0.2, end: 0.8 }] },
      ],
    });

    previewTimelineAt(world, root.id(), def, 0.5);
    expect((alien.get(Transform) as { x: number }).x).toBeCloseTo(50, 0);     // linear 0→100 at t=0.5
    expect((prop.get(EntityAttributes) as { isActive: boolean }).isActive).toBe(true); // inside [0.2,0.8)

    previewTimelineAt(world, root.id(), def, 0.9);
    expect((prop.get(EntityAttributes) as { isActive: boolean }).isActive).toBe(false); // past the span
  });

  it('publishes a skeletal seek at the exact local clip time (Phase 5)', () => {
    clearSkeletalSeeks();
    const world = createWorld();
    const root = world.spawn(EntityAttributes({ name: 'root' }));
    // A 3D skeletal target — NO keyframe Animator, so it takes the seek branch.
    const alien = world.spawn(EntityAttributes({ name: 'Alien', parentId: root.id() }), SkeletalAnimator({ clip: '' }));

    const def = normalizeTimeline({
      id: 'tl', duration: 8, frameRate: 30,
      tracks: [{
        id: 'a', name: 'Anim', target: 'Alien', type: 'animation',
        clips: [{ start: 0, duration: 2.5, clip: 'Idle' }, { start: 2.5, duration: 2, clip: 'Attack' }],
      }],
    });

    // Scrub inside the first block → seek Idle at local time (t − start). fadeDuration defaults to
    // 0, so a single full-weight clip (no crossfade).
    previewTimelineAt(world, root.id(), def, 1.0);
    expect(getSkeletalSeek(alien.id())).toEqual([{ clip: 'Idle', time: 1.0, weight: 1 }]);

    // Scrub well into the second block → seek Attack at its OWN local time.
    previewTimelineAt(world, root.id(), def, 3.5);
    expect(getSkeletalSeek(alien.id())).toEqual([{ clip: 'Attack', time: 1.0, weight: 1 }]); // 3.5 − 2.5

    // Scrub past the last block (no active clip) → the seek set is cleared, rig un-seeked.
    previewTimelineAt(world, root.id(), def, 7.0);
    expect(getSkeletalSeek(alien.id())).toBeUndefined();
    expect(hasSkeletalSeeks()).toBe(false);
  });

  it('crossfades skeletal clips within fadeDuration after a boundary (Phase B)', () => {
    clearSkeletalSeeks();
    const world = createWorld();
    const root = world.spawn(EntityAttributes({ name: 'root' }));
    // fadeDuration 0.25 → scrubbing just past the 2.5 boundary blends the two clips.
    const alien = world.spawn(EntityAttributes({ name: 'Alien', parentId: root.id() }), SkeletalAnimator({ clip: '', fadeDuration: 0.25 }));

    const def = normalizeTimeline({
      id: 'tl', duration: 8, frameRate: 30,
      tracks: [{
        id: 'a', name: 'Anim', target: 'Alien', type: 'animation',
        clips: [{ start: 0, duration: 2.5, clip: 'Idle' }, { start: 2.5, duration: 2, clip: 'Attack' }],
      }],
    });

    // t = 2.6 → 0.1s into the 0.25s fade → incoming Attack weight 0.4, outgoing Idle weight 0.6.
    previewTimelineAt(world, root.id(), def, 2.6);
    const parts = getSkeletalSeek(alien.id())!;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ clip: 'Idle' });   // outgoing, still advancing
    expect(parts[0].weight).toBeCloseTo(0.6, 5);
    expect(parts[1]).toMatchObject({ clip: 'Attack', time: expect.closeTo(0.1, 5) });
    expect(parts[1].weight).toBeCloseTo(0.4, 5);

    // Past the fade window → single full-weight clip.
    previewTimelineAt(world, root.id(), def, 3.0);
    expect(getSkeletalSeek(alien.id())).toEqual([{ clip: 'Attack', time: 0.5, weight: 1 }]);
  });

  it('crossfades over the authored OVERLAP region, not fadeDuration, when blocks overlap (Phase D)', () => {
    clearSkeletalSeeks();
    const world = createWorld();
    const root = world.spawn(EntityAttributes({ name: 'root' }));
    // fadeDuration is only 0.1, but the two blocks OVERLAP by 0.5 — the authored overlap must win.
    const alien = world.spawn(EntityAttributes({ name: 'Alien', parentId: root.id() }), SkeletalAnimator({ clip: '', fadeDuration: 0.1 }));

    const def = normalizeTimeline({
      id: 'tl', duration: 8, frameRate: 30,
      tracks: [{
        id: 'a', name: 'Anim', target: 'Alien', type: 'animation',
        // Idle ends at 2.5; Attack starts at 2.0 → overlap region [2.0, 2.5], width 0.5.
        clips: [{ start: 0, duration: 2.5, clip: 'Idle' }, { start: 2.0, duration: 2, clip: 'Attack' }],
      }],
    });

    // t = 2.1 → 0.1s into the 0.5s overlap → incoming Attack weight 0.1/0.5 = 0.2.
    // (With the old fadeDuration=0.1 window, 0.1 ≥ 0.1 would collapse to a single full-weight clip.)
    previewTimelineAt(world, root.id(), def, 2.1);
    const parts = getSkeletalSeek(alien.id())!;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ clip: 'Idle' });
    expect(parts[0].weight).toBeCloseTo(0.8, 5);
    expect(parts[0].time).toBeCloseTo(2.1, 5);  // Idle still advancing (t − 0)
    expect(parts[1]).toMatchObject({ clip: 'Attack' });
    expect(parts[1].weight).toBeCloseTo(0.2, 5);
    expect(parts[1].time).toBeCloseTo(0.1, 5);  // Attack local (t − 2.0)

    // Past the overlap end (2.5) → single full-weight Attack.
    previewTimelineAt(world, root.id(), def, 2.6);
    const after = getSkeletalSeek(alien.id())!;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ clip: 'Attack', weight: 1 });
    expect(after[0].time).toBeCloseTo(0.6, 5); // 2.6 − 2.0
  });

  it('blends a KEYFRAME Animator over the authored overlap region (Phase D)', () => {
    const world = createWorld();
    // Two constant clips — A holds x=0, B holds x=100 — so the overlap blend is readable off Transform.x.
    setAnimationClip('ao.anim.json', {
      id: 'ao-guid', name: 'ao', duration: 2.5, frameRate: 60, loop: false,
      tracks: [{ path: '', trait: 'Transform', field: 'x', type: 'number', keys: [{ t: 0, v: 0 }, { t: 2.5, v: 0 }] }],
    } as AnimationClipDef);
    setAnimationClip('bo.anim.json', {
      id: 'bo-guid', name: 'bo', duration: 2, frameRate: 60, loop: false,
      tracks: [{ path: '', trait: 'Transform', field: 'x', type: 'number', keys: [{ t: 0, v: 100 }, { t: 2, v: 100 }] }],
    } as AnimationClipDef);
    const root = world.spawn(EntityAttributes({ name: 'root' }));
    const alien = world.spawn(
      EntityAttributes({ name: 'Alien', parentId: root.id() }),
      Transform({ x: 0 }),
      // fadeDuration 0.1 on the incoming clip, but the blocks overlap by 0.5 → overlap wins.
      Animator({ clips: JSON.stringify([{ name: 'ao', clip: 'ao.anim.json' }, { name: 'bo', clip: 'bo.anim.json', fadeDuration: 0.1 }]), clip: '' }),
    );

    const def = normalizeTimeline({
      id: 'tl', duration: 6, frameRate: 60,
      tracks: [{ id: 'a', name: 'Anim', target: 'Alien', type: 'animation', clips: [{ start: 0, duration: 2.5, clip: 'ao' }, { start: 2.0, duration: 2, clip: 'bo' }] }],
    });

    // Overlap [2.0, 2.5], width 0.5. At t = 2.1 → incoming weight 0.2 → x = 0*(0.8) + 100*(0.2) = 20.
    previewTimelineAt(world, root.id(), def, 2.1);
    expect((alien.get(Transform) as { x: number }).x).toBeCloseTo(20, 1);
  });

  it('does NOT crossfade within the fade window of the FIRST block (no clips[-1]) — single full-weight clip', () => {
    clearSkeletalSeeks();
    const world = createWorld();
    const root = world.spawn(EntityAttributes({ name: 'root' }));
    // fadeDuration 0.25, but the first block starts at 1.0 — a crossfade here would read clips[-1].
    const alien = world.spawn(EntityAttributes({ name: 'Alien', parentId: root.id() }), SkeletalAnimator({ clip: '', fadeDuration: 0.25 }));

    const def = normalizeTimeline({
      id: 'tl', duration: 4, frameRate: 30,
      tracks: [{ id: 'a', name: 'Anim', target: 'Alien', type: 'animation', clips: [{ start: 1, duration: 2, clip: 'Idle' }] }],
    });

    // t = 1.1 → 0.1s into the fade after the FIRST block's start. The i>0 guard must keep this a
    // single clip (there is no previous block to blend from), not throw on clips[-1].
    previewTimelineAt(world, root.id(), def, 1.1);
    const parts = getSkeletalSeek(alien.id())!;
    expect(parts).toHaveLength(1);
    expect(parts[0].clip).toBe('Idle');
    expect(parts[0].time).toBeCloseTo(0.1, 5); // t − start
    expect(parts[0].weight).toBe(1);
  });

  it('blends a KEYFRAME Animator across a clip boundary within the fade window (parts.length === 2)', () => {
    const world = createWorld();
    // Two constant clips — A holds x=0, B holds x=100 — so a blend is directly readable off Transform.x.
    setAnimationClip('a.anim.json', {
      id: 'a-guid', name: 'a', duration: 2.5, frameRate: 60, loop: false,
      tracks: [{ path: '', trait: 'Transform', field: 'x', type: 'number', keys: [{ t: 0, v: 0 }, { t: 2.5, v: 0 }] }],
    } as AnimationClipDef);
    setAnimationClip('b.anim.json', {
      id: 'b-guid', name: 'b', duration: 2, frameRate: 60, loop: false,
      tracks: [{ path: '', trait: 'Transform', field: 'x', type: 'number', keys: [{ t: 0, v: 100 }, { t: 2, v: 100 }] }],
    } as AnimationClipDef);
    const root = world.spawn(EntityAttributes({ name: 'root' }));
    const alien = world.spawn(
      EntityAttributes({ name: 'Alien', parentId: root.id() }),
      Transform({ x: 0 }),
      // incoming clip 'b' carries the 0.25s fade (the source animationSystem uses during Play).
      Animator({ clips: JSON.stringify([{ name: 'a', clip: 'a.anim.json' }, { name: 'b', clip: 'b.anim.json', fadeDuration: 0.25 }]), clip: '' }),
    );

    const def = normalizeTimeline({
      id: 'tl', duration: 6, frameRate: 60,
      tracks: [{ id: 'a', name: 'Anim', target: 'Alien', type: 'animation', clips: [{ start: 0, duration: 2.5, clip: 'a' }, { start: 2.5, duration: 2, clip: 'b' }] }],
    });

    // t = 2.6 → 0.1s into the 0.25s fade → incoming 'b' weight 0.4. Blend x = 0*(0.6) + 100*(0.4) = 40.
    previewTimelineAt(world, root.id(), def, 2.6);
    expect((alien.get(Transform) as { x: number }).x).toBeCloseTo(40, 1);
  });

  it('does not seek a muted or scrub:false skeletal track', () => {
    clearSkeletalSeeks();
    const world = createWorld();
    const root = world.spawn(EntityAttributes({ name: 'root' }));
    const alien = world.spawn(EntityAttributes({ name: 'Alien', parentId: root.id() }), SkeletalAnimator({ clip: '' }));

    const muted = normalizeTimeline({
      id: 'tl', duration: 4, frameRate: 30,
      tracks: [{ id: 'a', name: 'Anim', target: 'Alien', type: 'animation', muted: true, clips: [{ start: 0, clip: 'Idle' }] }],
    });
    previewTimelineAt(world, root.id(), muted, 1.0);
    expect(getSkeletalSeek(alien.id())).toBeUndefined();

    const noScrub = normalizeTimeline({
      id: 'tl', duration: 4, frameRate: 30,
      tracks: [{ id: 'a', name: 'Anim', target: 'Alien', type: 'animation', clips: [{ start: 0, clip: 'Idle', scrub: false }] }],
    });
    previewTimelineAt(world, root.id(), noScrub, 1.0);
    expect(getSkeletalSeek(alien.id())).toBeUndefined();
  });
});
