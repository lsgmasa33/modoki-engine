/** #868 Group D — the timeline → render-layer request registries and koota's recycled entity index.
 *
 *  `particleControlRegistry` (a pending restart/pause, and the scrub span's on/off memory) and
 *  `skeletalSeek` (an exact-time pose) carry a request from the timeline to whatever renders its
 *  target. A request outlives its target when the target is destroyed before it renders, and each was
 *  keyed by the bare `entity.id()` — so a spawn that reclaimed the index took the dead target's
 *  request as its own. They are keyed by the packed entity now. */

import { describe, it, expect, afterEach } from 'vitest';
import '../../src/runtime/loaders/registerProviders';
import { createWorld, type World } from 'koota';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { Director } from '../../src/runtime/traits/Director';
import { SkeletalAnimator } from '../../src/runtime/traits/SkeletalAnimator';
import { timelineSystem, previewControlAt, previewTimelineAt } from '../../src/runtime/timeline/timelineSystem';
import { clearControlSpawns } from '../../src/runtime/timeline/controlSpawnRegistry';
import {
  takeParticleControl, clearParticleControls, resetScrubParticleReflect,
} from '../../src/runtime/core/particleControlRegistry';
import { getSkeletalSeek, clearSkeletalSeeks } from '../../src/runtime/core/skeletalSeek';
import { setTimeline, clearTimelineCache } from '../../src/runtime/loaders/timelineCache';
import { normalizeTimeline } from '../../src/runtime/timeline/types';

const TIMELINE = { name: 'timeline', fn: timelineSystem, priority: SYSTEM_PRIORITY.ANIMATION - 1 };
const PATH = 'reuse.timeline.json';
const DT = 1 / 30;

let tw: TestWorld | undefined;
const worlds: World[] = [];
afterEach(() => {
  clearControlSpawns(); clearParticleControls(); resetScrubParticleReflect(); clearSkeletalSeeks();
  if (tw) { tw.dispose(); tw = undefined; }
  for (const w of worlds.splice(0)) w.destroy();
  clearTimelineCache();
});

const particleTrack = (duration: number) => normalizeTimeline({
  id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
  tracks: [{ id: 'ctl', name: 'FX', target: 'Emitter', type: 'control', clips: [{ start: 1, duration, particle: true }] }],
});

describe('particleControlRegistry — recycled index', () => {
  it('a restart queued for a destroyed emitter is not delivered to the entity that reclaims its index', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    setTimeline(PATH, particleTrack(1));
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    const a = tw.spawn(EntityAttributes({ name: 'Emitter', parentId: root.id() }));

    tw.step(33); // t ≈ 1.1 — the clip start queued a restart for `a`, which has not rendered yet
    // The request really was made (else the assertion below passes vacuously).
    expect(tw.events({ type: '@control' }).map((e) => (e.payload as { phase: string }).phase)).toEqual(['particle']);
    a.destroy();
    const b = tw.spawn(EntityAttributes({ name: 'Unrelated' }));
    expect(b.id()).toBe(a.id());
    expect(b.valueOf()).not.toBe(a.valueOf());

    expect(takeParticleControl(b)).toBeUndefined();
  });

  it('a new emitter scrubbed into the span restarts, even when a destroyed emitter on its index was ON', () => {
    const world = createWorld(); worlds.push(world);
    const def = particleTrack(1);
    const root = world.spawn(EntityAttributes({ name: 'root' }));
    const a = world.spawn(EntityAttributes({ name: 'Emitter', parentId: root.id() }));

    previewControlAt(world, root.id(), def, 1.5); // inside the span → `a` goes ON
    expect(takeParticleControl(a)).toBe('restart');

    a.destroy();
    const b = world.spawn(EntityAttributes({ name: 'Emitter', parentId: root.id() }));
    expect(b.id()).toBe(a.id());

    previewControlAt(world, root.id(), def, 1.6); // still inside the span — `b` has never been ON
    expect(takeParticleControl(b)).toBe('restart');
  });
});

describe('skeletalSeek — recycled index', () => {
  it('a scrub seek for a destroyed rig does not pose the rig that reclaims its index', () => {
    const world = createWorld(); worlds.push(world);
    const root = world.spawn(EntityAttributes({ name: 'root' }));
    const a = world.spawn(EntityAttributes({ name: 'Alien', parentId: root.id() }), SkeletalAnimator({ clip: '' }));
    const def = normalizeTimeline({
      id: 'tl', duration: 8, frameRate: 30,
      tracks: [{ id: 'a', name: 'Anim', target: 'Alien', type: 'animation', clips: [{ start: 0, duration: 2.5, clip: 'Idle' }] }],
    });

    previewTimelineAt(world, root.id(), def, 1.0);
    expect(getSkeletalSeek(a)).toEqual([{ clip: 'Idle', time: 1.0, weight: 1 }]);

    a.destroy();
    const b = world.spawn(EntityAttributes({ name: 'OtherRig' }), SkeletalAnimator({ clip: '' }));
    expect(b.id()).toBe(a.id());

    // The seek set is rebuilt only on the next scrub or Play; until then `b` must advance normally.
    expect(getSkeletalSeek(b)).toBeUndefined();
  });
});
