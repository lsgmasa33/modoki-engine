/** Muting a track mid-span (#446) — the runtime must reconcile a STATEFUL track's effect OFF the
 *  moment the track is muted, matching what the editor scrub (`previewControlAt`) already does,
 *  instead of stranding whatever the start edge turned on (a playing video, a spawned prefab, a
 *  running particle emitter). Stateless impulse tracks (signal/audio) are unaffected — there is
 *  nothing to turn off. See `timelineSystem.ts`'s `_trackMuted` memo doc comment for the mechanism. */

import { describe, it, expect, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  prefabDef: null as unknown,
  spawnCalls: [] as { parentId?: number; guidSeed?: string }[],
  spawnReturns: [] as number[],
  deleted: [] as number[],
  nextId: 800,
}));

// Same seam timelineControlSpawn.test.ts uses: real timelineCache, stubbed prefab cache + spawn.
vi.mock('../../src/runtime/timeline/assetProvider', async () => {
  const { getTimeline } = await import('../../src/runtime/loaders/timelineCache');
  const impl = {
    getTimeline,
    getCachedPrefab: () => h.prefabDef,
    spawnPrefabInstance: (_w: unknown, _p: unknown, opts: { parentId?: number; guidSeed?: string }) => {
      h.spawnCalls.push({ parentId: opts.parentId, guidSeed: opts.guidSeed });
      const id = h.nextId++;
      h.spawnReturns.push(id);
      return id;
    },
  };
  return { timelineAssetProvider: { get: () => impl } };
});
vi.mock('../../src/runtime/core/ecs/entityUtils', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  deleteEntity: (id: number) => { h.deleted.push(id); },
}));

import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { Director } from '../../src/runtime/traits/Director';
import { VideoPlayer } from '../../src/runtime/traits/VideoPlayer';
import { timelineSystem, previewControlAt, clearPreviewControls } from '../../src/runtime/timeline/timelineSystem';
import { hasControlSpawn, clearControlSpawns } from '../../src/runtime/timeline/controlSpawnRegistry';
import { setTimeline, clearTimelineCache } from '../../src/runtime/loaders/timelineCache';
import { normalizeTimeline, type TimelineDef } from '../../src/runtime/timeline/types';

const TIMELINE = { name: 'timeline', fn: timelineSystem, priority: SYSTEM_PRIORITY.ANIMATION - 1 };
const PATH = 'muted-tracks.timeline.json';
const DT = 1 / 30;

let calls: string[] = [];
const spyActions = {
  'video.stop': () => { calls.push('stop'); },
  'video.pause': () => { calls.push('pause'); },
  'video.setClip': ({ params }: { params?: Record<string, unknown> }) => { calls.push(`setClip:${params?.clip}`); },
  'my.marker': () => { calls.push('marker'); },
  'engine.playClip': () => { calls.push('anim'); },
};

let tw: TestWorld | undefined;
afterEach(() => {
  calls = [];
  clearControlSpawns();
  clearPreviewControls();
  if (tw) { tw.dispose(); tw = undefined; }
  clearTimelineCache();
  h.prefabDef = null; h.spawnCalls = []; h.spawnReturns = []; h.deleted = []; h.nextId = 800;
});

/** Mutate the cached timeline's `tracks[trackIdx].muted` mid-run — `setTimeline` re-normalizes and
 *  replaces the cache entry (fully, not in place), so the system's next-frame `getTimeline` call
 *  picks it up. The mute-transition memo is keyed by (rootId, track.id), which is stable across
 *  the replacement, so the flip is still detected correctly. */
function setMuted(def: TimelineDef, trackIdx: number, muted: boolean): void {
  const next = { ...def, tracks: def.tracks.map((t, i) => (i === trackIdx ? { ...t, muted } : t)) };
  setTimeline(PATH, next as unknown as TimelineDef);
}

describe('muted tracks — immediate off-reconcile (#446)', () => {
  it('a muted video track pauses immediately, mid-span', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: spyActions });
    const def = normalizeTimeline({
      id: 'v', name: 'Cutscene', duration: 4, frameRate: 30,
      tracks: [{ id: 'vid', name: 'Screen', target: '', type: 'video', clips: [{ start: 1, duration: 2, clip: 'guid-vid' }] }],
    });
    setTimeline(PATH, def);
    tw.spawn(EntityAttributes({ name: 'root' }), VideoPlayer({ clip: '', playing: false }), Director({ timeline: PATH }));

    tw.step(45); // t = 1.5 — inside the span
    expect(calls).toEqual(['stop', 'setClip:guid-vid']);

    setMuted(def, 0, true); // mute mid-span
    tw.step(1);
    expect(calls).toEqual(['stop', 'setClip:guid-vid', 'pause']); // paused immediately, not at the authored end (t=3)

    tw.step(60); // well past the authored end — no further dispatch (still muted, one-shot pause)
    expect(calls).toEqual(['stop', 'setClip:guid-vid', 'pause']);
  });

  it('a muted control-prefab track despawns immediately, mid-span (the leak in the issue title)', () => {
    h.prefabDef = { entities: [{ localId: 1, traits: { EntityAttributes: { name: 'Spark' } } }], rootLocalId: 1, id: 'p' };
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'FX', target: '', type: 'control', clips: [{ start: 1, duration: 2, prefab: 'prefab-guid-x' }] }],
    });
    setTimeline(PATH, def);
    tw.spawn(EntityAttributes({ name: 'root', guid: 'dir-guid' }), Director({ timeline: PATH }));

    tw.step(45); // t = 1.5 — inside the span, spawned
    expect(h.spawnCalls).toHaveLength(1);
    const spawnedId = h.spawnReturns[0];

    setMuted(def, 0, true); // mute mid-span
    tw.step(1);
    expect(h.deleted).toEqual([spawnedId]); // despawned immediately, not at the authored end (t=3)

    tw.step(60); // stays gone
    expect(h.spawnCalls).toHaveLength(1); // no respawn while muted
  });

  it('unmuting mid-span respawns the prefab, exactly once', () => {
    h.prefabDef = { entities: [{ localId: 1, traits: { EntityAttributes: { name: 'Spark' } } }], rootLocalId: 1, id: 'p' };
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'FX', target: '', type: 'control', clips: [{ start: 1, duration: 2, prefab: 'prefab-guid-x' }] }],
    });
    setTimeline(PATH, def);
    const root = tw.spawn(EntityAttributes({ name: 'root', guid: 'dir-guid' }), Director({ timeline: PATH }));

    tw.step(45); // t = 1.5 — spawned
    expect(h.spawnCalls).toHaveLength(1);
    const key = `${root.id()}:ctl:0`;

    setMuted(def, 0, true);
    tw.step(1); // despawned
    expect(hasControlSpawn(key)).toBe(false);

    setMuted(def, 0, false);
    tw.step(1); // t ≈ 1.57 — unmuted mid-span → respawned
    expect(h.spawnCalls).toHaveLength(2);
    expect(hasControlSpawn(key)).toBe(true);
    // (The scrub cross-check lives in the MUTED test below — at this playhead the def is unmuted
    // and the prefab already present, so `previewControlAt` takes neither branch and would assert
    // nothing.)
  });

  it('a track authored muted from the start fires no off-edge on its first frame', () => {
    h.prefabDef = { entities: [{ localId: 1, traits: { EntityAttributes: { name: 'Spark' } } }], rootLocalId: 1, id: 'p' };
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: spyActions });
    setTimeline(PATH, normalizeTimeline({
      id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
      tracks: [
        { id: 'ctl', name: 'FX', target: '', type: 'control', muted: true, clips: [{ start: 0, duration: 4, prefab: 'prefab-guid-x' }] },
        { id: 'vid', name: 'Screen', target: '', type: 'video', muted: true, clips: [{ start: 0, duration: 4, clip: 'g' }] },
      ],
    }));
    tw.spawn(EntityAttributes({ name: 'root', guid: 'dir-guid' }), VideoPlayer({ clip: '' }), Director({ timeline: PATH }));

    tw.step(45); // t = 1.5 — well inside both spans, both authored muted from t=0
    expect(h.spawnCalls).toHaveLength(0); // never spawned — no despawn-of-nothing either
    expect(h.deleted).toHaveLength(0);
    expect(calls).toEqual([]); // no video.pause fired for something never playing
  });

  it('a muted signal/audio track is unchanged — no markers, and unmuting mid-span fires no retroactive marker', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: spyActions });
    const def = normalizeTimeline({
      id: 's', name: 'Signals', duration: 4, frameRate: 30,
      tracks: [{ id: 'sig', name: 'Sig', target: '', type: 'signal', muted: true, markers: [{ t: 1, action: 'my.marker' }] }],
    });
    setTimeline(PATH, def);
    tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));

    tw.step(60); // t = 2 — crossed the marker at t=1, but the track is muted throughout
    expect(calls).toEqual([]);

    setMuted(def, 0, false); // unmute AFTER the marker's tick has already passed
    tw.step(1);
    expect(calls).toEqual([]); // no retroactive fire — signal tracks have no catch-up semantics
  });

  it('the two surfaces agree about a MUTED track — this is the drift that produced the bug', () => {
    // The weaker cross-check above only proves the scrub does not DESTROY what the runtime made.
    // The actual divergence #446 is about ran the other way: `previewControlAt` reconciled a muted
    // track's prefab OFF while `applyDirectorFrame` skipped every edge and left it spawned. Pin
    // both surfaces on the muted case, against EACH OTHER rather than a hand-written expectation.
    h.prefabDef = { entities: [{ localId: 1, traits: { EntityAttributes: { name: 'Spark' } } }], rootLocalId: 1, id: 'p' };
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'FX', target: '', type: 'control', clips: [{ start: 1, duration: 2, prefab: 'prefab-guid-x' }] }],
    });
    setTimeline(PATH, def);
    const root = tw.spawn(EntityAttributes({ name: 'root', guid: 'dir-guid' }), Director({ timeline: PATH }));
    const key = `${root.id()}:ctl:0`;

    tw.step(45);                       // t = 1.5, inside the span → spawned
    expect(hasControlSpawn(key)).toBe(true);

    setMuted(def, 0, true);
    tw.step(1);
    const runtimeSaysSpawned = hasControlSpawn(key);   // what PLAY does with a muted track mid-span

    // Now ask the SCRUB the same question at the same playhead, from the same spawned start state.
    // Re-establish presence with an unmuted scrub, then scrub again with the track muted.
    const mutedDef = { ...def, tracks: def.tracks.map((t) => ({ ...t, muted: true })) } as TimelineDef;
    const t = (root.get(Director) as { time: number }).time;
    previewControlAt(tw.world, root.id(), def, t);          // unmuted scrub → present
    expect(hasControlSpawn(key)).toBe(true);
    previewControlAt(tw.world, root.id(), mutedDef, t);     // muted scrub → reconciled off
    const scrubSaysSpawned = hasControlSpawn(key);

    expect(runtimeSaysSpawned).toBe(scrubSaysSpawned);
    expect(runtimeSaysSpawned).toBe(false);   // and both agree the answer is "gone"
  });

  it('an unmute landing ON the start edge spawns ONCE, not spawn-destroy-spawn', () => {
    // Review of #446: the unmute reconcile must not fire on top of the very edge it stands in
    // for. Landing on `atStart` ran spawn → destroy → spawn in a single frame and journalled
    // `@control spawn` TWICE at the same tick with no despawn between — which breaks the
    // journal's role as the deterministic verification trace and re-runs every side effect
    // inside the prefab.
    h.prefabDef = { entities: [{ localId: 1, traits: { EntityAttributes: { name: 'Spark' } } }], rootLocalId: 1, id: 'p' };
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'FX', target: '', type: 'control', muted: true, clips: [{ start: 1, duration: 2, prefab: 'prefab-guid-x' }] }],
    });
    setTimeline(PATH, def);
    tw.spawn(EntityAttributes({ name: 'root', guid: 'dir-guid' }), Director({ timeline: PATH }));

    // Step 31 is the frame that actually crosses `clip.start` (measured: t=1.0333 — accumulated
    // 1/30 steps land just under 1.0 at step 30, and `crossed` is `t > prev && t <= cur`). The
    // unmute has to land on THAT frame for the collision this test is about to happen at all.
    tw.step(30);
    expect(h.spawnCalls).toHaveLength(0);

    setMuted(def, 0, false);  // unmute ON the frame that crosses t=1
    tw.step(1);

    expect(h.spawnCalls).toHaveLength(1);
    expect(h.deleted).toHaveLength(0);
    const spawns = tw.events({ type: '@control' }).filter((e) => (e.payload as { phase: string }).phase === 'spawn');
    expect(spawns).toHaveLength(1);
  });

  it('a muted video clip with NO duration is paused too — it is not an impulse', () => {
    // The particle path gates its mute-off on `duration !== undefined` because an impulse burst
    // self-terminates. A duration-less VIDEO clip does the opposite: it plays on to the media's
    // own end, so it is the clip shape a mute most needs to stop. Gating it the same way left the
    // original bug unfixed for exactly that shape.
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: spyActions });
    const def = normalizeTimeline({
      id: 'v', name: 'Cutscene', duration: 4, frameRate: 30,
      tracks: [{ id: 'vid', name: 'Screen', target: '', type: 'video', clips: [{ start: 1, clip: 'guid-vid' }] }],
    });
    setTimeline(PATH, def);
    tw.spawn(EntityAttributes({ name: 'root' }), VideoPlayer({ clip: '', playing: false }), Director({ timeline: PATH }));

    tw.step(45);
    expect(calls).toEqual(['stop', 'setClip:guid-vid']);

    setMuted(def, 0, true);
    tw.step(1);
    expect(calls).toEqual(['stop', 'setClip:guid-vid', 'pause']);
  });

  it('a Director on a RECYCLED entity id does not inherit the previous occupant\'s mute state', () => {
    // koota reuses an id immediately. Keyed on the id alone, a Director that ran one unmuted frame
    // left `<id>:vid -> false` behind, and a brand-new Director spawning onto that id with the
    // track authored `muted:true` read it as a mute FLIP and paused a video it never started. No
    // world swap is involved, so the onWorldSwap reset cannot cover it — hence `generation()` in
    // the key. Found by review; `absent ≠ false` is only as good as the key.
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: spyActions });
    const unmuted = normalizeTimeline({
      id: 'v', name: 'Cutscene', duration: 4, frameRate: 30,
      tracks: [{ id: 'vid', name: 'Screen', target: '', type: 'video', clips: [{ start: 0, duration: 4, clip: 'guid-vid' }] }],
    });
    setTimeline(PATH, unmuted);
    const first = tw.spawn(EntityAttributes({ name: 'root' }), VideoPlayer({ clip: '', playing: false }), Director({ timeline: PATH }));
    tw.step(2);                       // one unmuted frame → memo records `false` for this track
    const recycledId = first.id();
    first.destroy();
    calls = [];

    // Same track id, now authored muted, on a Director that lands on the recycled id.
    setTimeline(PATH, normalizeTimeline({
      id: 'v', name: 'Cutscene', duration: 4, frameRate: 30,
      tracks: [{ id: 'vid', name: 'Screen', target: '', type: 'video', muted: true, clips: [{ start: 0, duration: 4, clip: 'guid-vid' }] }],
    }));
    const second = tw.spawn(EntityAttributes({ name: 'root2' }), VideoPlayer({ clip: '', playing: false }), Director({ timeline: PATH }));
    expect(second.id()).toBe(recycledId);   // the premise — if koota stops recycling, this test is moot

    tw.step(2);
    expect(calls).toEqual([]);        // no pause for a video this Director never started
  });
});
