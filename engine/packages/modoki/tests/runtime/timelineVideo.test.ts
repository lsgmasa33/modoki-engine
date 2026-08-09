/** Video track — a Director sequencing a cutscene.
 *
 *  The track deliberately talks to the ACTION REGISTRY rather than importing `videoSystem`:
 *  it keeps the video subsystem DCE-able behind `build.modules`, and mirrors how the animation
 *  track triggers a skeletal animator. So these assert on the DISPATCHES — which is not a
 *  weaker test than poking videoSystem, it is a test of the actual contract between the two. */

import { describe, it, expect, afterEach } from 'vitest';
// Side-effect only: wires core provider slots so the timeline cache below resolves.
import '../../src/runtime/loaders/registerProviders';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { Director } from '../../src/runtime/traits/Director';
import { VideoPlayer } from '../../src/runtime/traits/VideoPlayer';
import { timelineSystem } from '../../src/runtime/timeline/timelineSystem';
import { setTimeline, clearTimelineCache } from '../../src/runtime/loaders/timelineCache';
import { normalizeTimeline } from '../../src/runtime/timeline/types';

const TIMELINE = { name: 'timeline', fn: timelineSystem, priority: SYSTEM_PRIORITY.ANIMATION - 1 };
const PATH = 'video.timeline.json';
const DT = 1 / 30;

/** Every `video.*` dispatch the track makes, in order — the whole observable contract. */
let calls: string[] = [];
const spyActions = {
  'video.stop': () => { calls.push('stop'); },
  'video.pause': () => { calls.push('pause'); },
  'video.setClip': ({ params }: { params?: Record<string, unknown> }) => {
    calls.push(`setClip:${params?.clip}`);
  },
};

let tw: TestWorld | undefined;
afterEach(() => { calls = []; if (tw) { tw.dispose(); tw = undefined; } clearTimelineCache(); });

function makeWorld(clips: { start: number; duration?: number; clip: string }[], opts: { duration?: number; loop?: boolean } = {}) {
  tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: spyActions });
  setTimeline(PATH, normalizeTimeline({
    id: 'v', name: 'Cutscene', duration: opts.duration ?? 4, frameRate: 30,
    tracks: [{ id: 'vid', name: 'Screen', target: '', type: 'video', clips }],
  }));
  return tw.spawn(
    EntityAttributes({ name: 'root' }),
    VideoPlayer({ clip: '', playing: false }),
    Director({ timeline: PATH, loop: opts.loop === true }),
  );
}

describe('video track', () => {
  it('starts the clip at its start tick and pauses it at start+duration, once each', () => {
    makeWorld([{ start: 1, duration: 1, clip: 'guid-vid' }]);

    tw!.step(27);                    // t ≈ 0.9 — before the clip
    expect(calls).toEqual([]);

    tw!.step(6);                     // t ≈ 1.1 — crossed start
    expect(calls).toEqual(['stop', 'setClip:guid-vid']);

    tw!.step(30);                    // t ≈ 2.1 — crossed start+duration
    expect(calls).toEqual(['stop', 'setClip:guid-vid', 'pause']);

    tw!.step(30);                    // nothing further fires
    expect(calls).toHaveLength(3);
  });

  it('rewinds BEFORE setting the clip', () => {
    // `setClip` with the same GUID is a no-op in the video reconcile, so without the rewind a
    // re-entered span would resume from wherever the previous pass left off instead of
    // replaying the cutscene. Order is the whole fix; assert it directly.
    makeWorld([{ start: 0, duration: 1, clip: 'g' }]);
    tw!.step(1);
    expect(calls).toEqual(['stop', 'setClip:g']);
  });

  it('never pauses a clip authored with no duration', () => {
    // Omitting duration means "let the clip's own length decide" — the track must not invent
    // an end for it.
    makeWorld([{ start: 1, clip: 'guid-vid' }]);
    tw!.step(120);                   // t ≈ 4 — well past where a 1s default would have ended
    expect(calls).toEqual(['stop', 'setClip:guid-vid']);
  });

  it('replays from the beginning on every loop of the Director', () => {
    makeWorld([{ start: 0.5, duration: 1, clip: 'g' }], { duration: 2, loop: true });
    tw!.step(150);                   // 5s over a 2s looping timeline → the span is entered 3×
    const starts = calls.filter((c) => c.startsWith('setClip')).length;
    const stops = calls.filter((c) => c === 'stop').length;
    expect(starts).toBe(3);
    expect(stops).toBe(3);           // one rewind per entry, never a bare resume
  });

  it('drives several clips on one track in order', () => {
    makeWorld([
      { start: 0.5, duration: 0.5, clip: 'a' },
      { start: 2, duration: 0.5, clip: 'b' },
    ]);
    tw!.step(90);                    // t = 3
    expect(calls).toEqual(['stop', 'setClip:a', 'pause', 'stop', 'setClip:b', 'pause']);
  });

  it('does nothing while the track is muted', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: spyActions });
    setTimeline(PATH, normalizeTimeline({
      id: 'v', name: 'C', duration: 4, frameRate: 30,
      tracks: [{ id: 'vid', name: 'Screen', target: '', type: 'video', muted: true, clips: [{ start: 1, duration: 1, clip: 'g' }] }],
    }));
    tw.spawn(EntityAttributes({ name: 'root' }), VideoPlayer({ clip: '' }), Director({ timeline: PATH }));
    tw.step(90);
    expect(calls).toEqual([]);
  });

  it('is deterministic — two identical runs dispatch identically', () => {
    const run = () => {
      calls = [];
      const e = makeWorld([{ start: 0.5, duration: 1, clip: 'g' }]);
      void e;
      tw!.step(90);
      const trace = [...calls];
      tw!.dispose(); tw = undefined; clearTimelineCache();
      return trace;
    };
    expect(run()).toEqual(run());
  });

  it('resolves the track target, not just the Director root', () => {
    // A cutscene screen is normally a CHILD of the Director entity. A bare dispatch to the root
    // would silently ignore `track.target` — the exact bug the signal track already had.
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: spyActions });
    setTimeline(PATH, normalizeTimeline({
      id: 'v', name: 'C', duration: 4, frameRate: 30,
      tracks: [{ id: 'vid', name: 'Screen', target: 'Screen', type: 'video', clips: [{ start: 0.5, clip: 'g' }] }],
    }));
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    tw.spawn(EntityAttributes({ name: 'Screen', parentId: root.id() }), VideoPlayer({ clip: '' }));
    tw.step(30);
    expect(calls).toEqual(['stop', 'setClip:g']);
  });

  it('does nothing when the target name-path resolves to nothing', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: spyActions });
    setTimeline(PATH, normalizeTimeline({
      id: 'v', name: 'C', duration: 4, frameRate: 30,
      tracks: [{ id: 'vid', name: 'Screen', target: 'NoSuchChild', type: 'video', clips: [{ start: 0.5, clip: 'g' }] }],
    }));
    tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    tw.step(60);
    expect(calls).toEqual([]);
  });
});
