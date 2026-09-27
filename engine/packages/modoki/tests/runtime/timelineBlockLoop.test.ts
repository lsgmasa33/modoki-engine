/** #1596: a Timeline animation block longer than its keyframe clip plays the clip with the
 *  clip's OWN loop setting — the Animator bank entry's `loop`, else `Animator.loop` — in both the
 *  Play pose (`applyTimelineState`) and the editor scrub (`previewTimelineAt`). The Director poses
 *  with `playing:false`, which skips animationSystem's loop wrap, so it used to hold the last key
 *  of every clip. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import '../../src/runtime/loaders/registerProviders';
import { createWorld } from 'koota';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { Transform } from '../../src/runtime/core/traits/Transform';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { Animator } from '../../src/runtime/traits/Animator';
import { registerTrait, getAllTraits } from '../../src/runtime/core/ecs/traitRegistry';
import { setAnimationClip } from '../../src/runtime/loaders/animationClipCache';
import { applyTimelineState, previewTimelineAt } from '../../src/runtime/timeline/timelineSystem';
import { normalizeTimeline } from '../../src/runtime/timeline/types';
import type { AnimationClipDef } from '../../src/runtime/animation/types';

/** 1 s, x 0→100 linear. The clip def's own `loop` is deliberately the OPPOSITE of what the tests
 *  expect — runtime playback never reads it (docs/timeline.md), and this proves the Timeline
 *  doesn't start to. */
const CLIP: AnimationClipDef = {
  id: 'sway-guid', name: 'sway', duration: 1, frameRate: 60, loop: false,
  tracks: [{ path: '', trait: 'Transform', field: 'x', type: 'number',
    keys: [{ t: 0, v: 0, inTangent: 100, outTangent: 100 }, { t: 1, v: 100, inTangent: 100, outTangent: 100 }] }],
};

/** One 6 s block playing the 1 s clip. */
const DEF = normalizeTimeline({
  id: 'tl', duration: 6, frameRate: 60,
  tracks: [{ id: 'a', name: 'Anim', target: 'Alien', type: 'animation', clips: [{ start: 0, duration: 6, clip: 'sway' }] }],
});

const bank = (over: Record<string, unknown> = {}) => JSON.stringify([{ name: 'sway', clip: 'sway.anim.json', ...over }]);

beforeEach(() => {
  setAnimationClip('sway.anim.json', CLIP);
  const names = new Set(getAllTraits().map((m) => m.name));
  if (!names.has('Transform')) registerTrait({ name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' } } });
  if (!names.has('EntityAttributes')) registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' } } });
});

describe('Timeline block longer than its keyframe clip — Play pose (#1596)', () => {
  let tw: TestWorld | undefined;
  afterEach(() => { tw?.dispose(); tw = undefined; });

  function timeAt(animator: Record<string, unknown>, t: number): number {
    tw = createTestWorld();
    const root = tw.spawn(EntityAttributes({ name: 'root' }));
    const alien = tw.spawn(EntityAttributes({ name: 'Alien', parentId: root.id() }), Animator(animator));
    applyTimelineState(tw.world, root.id(), DEF, t);
    return tw.trait<{ time: number }>(Animator, alien).time;
  }

  it('a looping clip (Animator.loop default true) wraps past its end', () => {
    expect(timeAt({ clips: bank() }, 2.25)).toBeCloseTo(0.25, 9);
  });
  it('a bank entry loop:false holds the clip end', () => {
    expect(timeAt({ clips: bank({ loop: false }) }, 2.25)).toBe(1);
  });
  it('Animator.loop:false holds, and a bank entry loop:true overrides it', () => {
    expect(timeAt({ clips: bank(), loop: false }, 2.25)).toBe(1);
    expect(timeAt({ clips: bank({ loop: true }), loop: false }, 2.25)).toBeCloseTo(0.25, 9);
  });
  it('inside the first cycle the time is unchanged', () => {
    expect(timeAt({ clips: bank() }, 0.5)).toBeCloseTo(0.5, 9);
  });
});

describe('Timeline block longer than its keyframe clip — editor scrub (#1596)', () => {
  function xAt(over: Record<string, unknown>, t: number): number {
    const world = createWorld();
    const root = world.spawn(EntityAttributes({ name: 'root' }));
    const alien = world.spawn(EntityAttributes({ name: 'Alien', parentId: root.id() }), Transform({ x: -1 }), Animator({ clips: bank(over), clip: '' }));
    previewTimelineAt(world, root.id(), DEF, t);
    return (alien.get(Transform) as { x: number }).x;
  }

  it('samples the wrapped pose of a looping clip', () => {
    expect(xAt({}, 2.25)).toBeCloseTo(25, 0);
  });
  it('samples the held end pose of a one-shot clip', () => {
    expect(xAt({ loop: false }, 2.25)).toBeCloseTo(100, 0);
  });
});
