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
import { Animator } from '../../src/runtime/traits/Animator';
import { timelineSystem, previewControlAt, clearPreviewControls, applyTimelineState } from '../../src/runtime/timeline/timelineSystem';
import { buildEntityIndex } from '../../src/runtime/core/ecs/entityIndex';
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

describe('muted ACTIVATION track — hands the entity back to its authored isActive (#452)', () => {
  it('muting mid-span while the track shows the entity hands it back to its authored isActive', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'a', name: 'Act', duration: 4, frameRate: 30,
      tracks: [{ id: 'act', name: 'Act', target: 'Prop', type: 'activation', spans: [{ start: 1, end: 3 }] }],
    });
    setTimeline(PATH, def);
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    tw.spawn(EntityAttributes({ name: 'Prop', parentId: root.id(), isActive: false })); // authored HIDDEN

    tw.step(45); // t=1.5 — inside the span → shown
    const getProp = () => {
      let found: { isActive: boolean } | undefined;
      tw!.world.query(EntityAttributes).updateEach(([attrs]) => {
        if ((attrs as { name: string }).name === 'Prop') found = attrs as { isActive: boolean };
      });
      return found!;
    };
    expect(getProp().isActive).toBe(true);

    setMuted(def, 0, true); // mute mid-span
    tw.step(1);
    expect(getProp().isActive).toBe(false); // handed back to authored `false`, not stuck at `true`
  });

  it('muting while the track has the entity hidden hands it back to its authored isActive (stranded-hidden-forever)', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'a', name: 'Act', duration: 4, frameRate: 30,
      tracks: [{ id: 'act', name: 'Act', target: 'Prop', type: 'activation', spans: [{ start: 0, end: 1 }] }],
    });
    setTimeline(PATH, def);
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    tw.spawn(EntityAttributes({ name: 'Prop', parentId: root.id() })); // authored isActive:true (default)
    const getProp = () => {
      let found: { isActive: boolean } | undefined;
      tw!.world.query(EntityAttributes).updateEach(([attrs]) => {
        if ((attrs as { name: string }).name === 'Prop') found = attrs as { isActive: boolean };
      });
      return found!;
    };

    tw.step(60); // t=2 — past the span end → hidden
    expect(getProp().isActive).toBe(false);

    setMuted(def, 0, true);
    tw.step(1);
    expect(getProp().isActive).toBe(true); // no longer stranded hidden forever — this was #452's headline
  });

  it('a track authored muted from the start never writes isActive at all', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    setTimeline(PATH, normalizeTimeline({
      id: 'a', name: 'Act', duration: 4, frameRate: 30,
      tracks: [{ id: 'act', name: 'Act', target: 'Prop', type: 'activation', muted: true, spans: [{ start: 0, end: 4 }] }],
    }));
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    tw.spawn(EntityAttributes({ name: 'Prop', parentId: root.id(), isActive: false }));
    const getProp = () => {
      let found: { isActive: boolean } | undefined;
      tw!.world.query(EntityAttributes).updateEach(([attrs]) => {
        if ((attrs as { name: string }).name === 'Prop') found = attrs as { isActive: boolean };
      });
      return found!;
    };

    tw.step(90); // well inside the (muted-from-the-start) span the whole time
    expect(getProp().isActive).toBe(false); // untouched — nothing was ever captured, so no hand-back fires
  });

  it('unmuting after a hand-back re-drives isActive from `desired` again', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'a', name: 'Act', duration: 4, frameRate: 30,
      tracks: [{ id: 'act', name: 'Act', target: 'Prop', type: 'activation', spans: [{ start: 1, end: 2 }, { start: 3, end: 4 }] }],
    });
    setTimeline(PATH, def);
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    tw.spawn(EntityAttributes({ name: 'Prop', parentId: root.id(), isActive: false })); // authored HIDDEN
    const getProp = () => {
      let found: { isActive: boolean } | undefined;
      tw!.world.query(EntityAttributes).updateEach(([attrs]) => {
        if ((attrs as { name: string }).name === 'Prop') found = attrs as { isActive: boolean };
      });
      return found!;
    };

    tw.step(45); // t=1.5 — inside the first span → shown
    expect(getProp().isActive).toBe(true);

    setMuted(def, 0, true);
    tw.step(1); // t≈1.53 — handed back to authored `false`
    expect(getProp().isActive).toBe(false);

    setMuted(def, 0, false);
    tw.step(59); // t≈3.5 — unmuted, now inside the SECOND span → desired true again
    expect(getProp().isActive).toBe(true);

    tw.step(30); // t clamps to duration=4, past the second span's end → desired false again
    expect(getProp().isActive).toBe(false);
  });

  it('an entity authored isActive:false that the track shows, then mutes, returns to `false` (not a hardcoded default)', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'a', name: 'Act', duration: 4, frameRate: 30,
      tracks: [{ id: 'act', name: 'Act', target: 'Prop', type: 'activation', spans: [{ start: 0, end: 2 }] }],
    });
    setTimeline(PATH, def);
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    tw.spawn(EntityAttributes({ name: 'Prop', parentId: root.id(), isActive: false })); // authored HIDDEN
    const getProp = () => {
      let found: { isActive: boolean } | undefined;
      tw!.world.query(EntityAttributes).updateEach(([attrs]) => {
        if ((attrs as { name: string }).name === 'Prop') found = attrs as { isActive: boolean };
      });
      return found!;
    };

    tw.step(30); // t=1 — inside the span → shown
    expect(getProp().isActive).toBe(true);

    setMuted(def, 0, true);
    tw.step(1);
    expect(getProp().isActive).toBe(false); // back to the AUTHORED value, not a hardcoded `true` default
  });

  it('a muted animation track is unchanged — still skipped, no pose written (deliberate asymmetry)', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'a', name: 'Anim', duration: 4, frameRate: 30,
      tracks: [{ id: 'anim', name: 'Anim', target: 'Alien', type: 'animation', muted: true, clips: [{ start: 0, duration: 4, clip: 'move' }] }],
    });
    setTimeline(PATH, def);
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    const alien = tw.spawn(
      EntityAttributes({ name: 'Alien', parentId: root.id() }),
      Animator({ clip: 'orig', activeClip: 'orig', time: 0, playing: true }),
    );

    tw.step(45); // t=1.5 — well inside the muted clip's span

    const a = alien.get(Animator) as { clip: string; time: number; playing: boolean };
    expect(a.clip).toBe('orig');   // pose() never touched it — the blanket skip is deliberately kept
    expect(a.time).toBe(0);
    expect(a.playing).toBe(true);
  });

  it('a Director on a RECYCLED entity id does not inherit the previous occupant\'s captured base', () => {
    // Mirrors the video-track recycling test above, for the NEW per-(track,target) base memo:
    // koota reuses a freed id immediately, so both the root AND its child can land back on their
    // old numeric ids. Without `generation()` in the key, a fresh Director + child pair could read
    // the destroyed occupant's captured `true` and hand back the wrong value.
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'a', name: 'Act', duration: 4, frameRate: 30,
      tracks: [{ id: 'act', name: 'Act', target: 'Prop', type: 'activation', spans: [{ start: 0, end: 4 }] }],
    });
    setTimeline(PATH, def);
    const root1 = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    const prop1 = tw.spawn(EntityAttributes({ name: 'Prop', parentId: root1.id(), isActive: true }));

    tw.step(2); // captures base=true for (root1, gen1, 'act', prop1.id())
    const rootId = root1.id();
    const propId = prop1.id();
    prop1.destroy();
    root1.destroy();

    // Same track id, now authored MUTED FROM THE START, on entities landing on the recycled ids.
    setTimeline(PATH, normalizeTimeline({
      id: 'a', name: 'Act', duration: 4, frameRate: 30,
      tracks: [{ id: 'act', name: 'Act', target: 'Prop', type: 'activation', muted: true, spans: [{ start: 0, end: 4 }] }],
    }));
    const root2 = tw.spawn(EntityAttributes({ name: 'root2' }), Director({ timeline: PATH }));
    const prop2 = tw.spawn(EntityAttributes({ name: 'Prop', parentId: root2.id(), isActive: false }));
    expect(root2.id()).toBe(rootId); // the premise — if koota stops recycling, this test is moot
    expect(prop2.id()).toBe(propId);

    tw.step(2);
    expect((prop2.get(EntityAttributes) as { isActive: boolean }).isActive).toBe(false); // no bleed from the destroyed occupant's captured `true`
  });

  it('destroying only the TARGET (root untouched) and recycling its id hands back the NEW occupant\'s authored value', () => {
    // The recycling test above destroys the ROOT (and the target), so `trackMuteKey`'s root-half
    // generation guard can't be exercised in isolation. This one leaves the root alive and destroys
    // only the target — the key must carry the TARGET's own generation, not just the root's.
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'a', name: 'Act', duration: 4, frameRate: 30,
      tracks: [{ id: 'act', name: 'Act', target: 'Prop', type: 'activation', spans: [{ start: 0, end: 4 }] }],
    });
    setTimeline(PATH, def);
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    const prop1 = tw.spawn(EntityAttributes({ name: 'Prop', parentId: root.id(), isActive: true })); // authored SHOWN

    tw.step(2); // t≈0.07 — inside the covering span → captures base=true for prop1's (id, generation)
    const propId = prop1.id();
    prop1.destroy();
    // Recycle the SAME numeric id under the SAME root with a DIFFERENT authored isActive.
    const prop2 = tw.spawn(EntityAttributes({ name: 'Prop', parentId: root.id(), isActive: false })); // authored HIDDEN
    expect(prop2.id()).toBe(propId); // the premise — if koota stops recycling, this test is moot

    tw.step(1); // captures base=false for prop2 (new generation) before this frame's write
    setMuted(def, 0, true); // mute
    tw.step(1);
    expect((prop2.get(EntityAttributes) as { isActive: boolean }).isActive).toBe(false); // the NEW occupant's authored `false`, not prop1's stale `true`
  });

  it('two activation tracks on one target: muting BOTH hands back the entity\'s single authored base, not the first track\'s write', () => {
    // #452's stranded-hidden bug, reintroduced one level up: track `t1` (always off) runs before
    // `t2` (covering) in `def.tracks`. Without the two-phase sweep, `t2` would capture `t1`'s write
    // (`false`) as if it were the authored base, and muting both would strand the entity `false`
    // forever instead of restoring the authored `true`.
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'a', name: 'Act', duration: 4, frameRate: 30,
      tracks: [
        { id: 't1', name: 'AlwaysOff', target: 'Prop', type: 'activation', spans: [] },
        { id: 't2', name: 'Covering', target: 'Prop', type: 'activation', spans: [{ start: 0, end: 4 }] },
      ],
    });
    setTimeline(PATH, def);
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    tw.spawn(EntityAttributes({ name: 'Prop', parentId: root.id(), isActive: true })); // authored SHOWN
    const getProp = () => {
      let found: { isActive: boolean } | undefined;
      tw!.world.query(EntityAttributes).updateEach(([attrs]) => {
        if ((attrs as { name: string }).name === 'Prop') found = attrs as { isActive: boolean };
      });
      return found!;
    };

    tw.step(2); // both unmuted — last-track-wins (`t2` is last) → shown
    expect(getProp().isActive).toBe(true);

    const bothMuted = { ...def, tracks: def.tracks.map((t) => ({ ...t, muted: true })) } as TimelineDef;
    setTimeline(PATH, bothMuted);
    tw.step(1);
    expect(getProp().isActive).toBe(true); // handed back to the entity's authored `true`, not `t1`'s `false` write
  });

  it('an unmuted activation track beats a muted one regardless of track order', () => {
    // A per-target key ALONE (without the phase-1-sweep / phase-2-decide restructure) is order
    // dependent: an unmuted track's correct current write can be overwritten by a LATER-processed
    // muted track's hand-back to a base that (pre-fix) was itself captured contaminated by the
    // first track's write. `U` (unmuted) is the only track that should ever win once `M` is muted;
    // this pins that regardless of which of the two is positioned first in `def.tracks`.
    //
    // The authored base (`isActive: true`) is chosen to DIFFER from both U's current desired
    // (`false` at t=2) and M's (`true`) — if it coincided with U's desired, "unmuted wins" and
    // "hand back to base" would be indistinguishable and this test would pass under either
    // hypothesis (this is exactly how the previous version of this test slipped through: it
    // authored `isActive: false`, which happened to equal U's desired at the sampled playhead).
    const run = (order: 'M-then-U' | 'U-then-M'): boolean => {
      const local = createTestWorld({ dt: DT, systems: [TIMELINE] });
      const uTrack = { id: 'u', name: 'U', target: 'Prop', type: 'activation' as const, spans: [{ start: 0, end: 1 }] };
      const mTrack = { id: 'm', name: 'M', target: 'Prop', type: 'activation' as const, spans: [{ start: 0, end: 4 }] };
      const tracks = order === 'M-then-U' ? [mTrack, uTrack] : [uTrack, mTrack];
      const def = normalizeTimeline({ id: 'a', name: 'Act', duration: 4, frameRate: 30, tracks });
      setTimeline(PATH, def);
      const root = local.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
      local.spawn(EntityAttributes({ name: 'Prop', parentId: root.id(), isActive: true }));
      const getProp = () => {
        let found: { isActive: boolean } | undefined;
        local.world.query(EntityAttributes).updateEach(([attrs]) => {
          if ((attrs as { name: string }).name === 'Prop') found = attrs as { isActive: boolean };
        });
        return found!;
      };

      local.step(60); // t=2 — past U's span end (desired false) and inside M's covering span (desired true)

      const muted = { ...def, tracks: def.tracks.map((t) => (t.id === 'm' ? { ...t, muted: true } : t)) } as TimelineDef;
      setTimeline(PATH, muted); // mute M only — U stays unmuted throughout
      local.step(1);

      const result = getProp().isActive;
      local.dispose();
      return result;
    };

    // Both orderings must land on U's OWN current desired at this playhead (false) — NOT M's `true`
    // and NOT the authored base `true` (which would mean M's mute wrongly handed the entity back).
    expect(run('M-then-U')).toBe(false);
    expect(run('U-then-M')).toBe(false);
  });

  it('a muted activation track on a SECOND Director cannot defeat an unmuted track on a different Director (#452 round 3)', () => {
    // Reviewer repro: Director A always keeps 'Inner/Prop' OFF (unmuted, empty spans). Director B
    // sits ON 'Inner' and drives its OWN child 'Prop' with a MUTED activation track. Because
    // `_activationBase` used to be keyed ONLY by target (no owner), B's muted track could capture
    // Prop's authored base and hand it back — even though B never legitimately drove Prop (its
    // track was muted from the start) and even though A's unmuted track is actively holding it
    // OFF. This must land on A's `false` regardless of which Director's `applyTimelineState` call
    // runs first (matching `world.query(Director)` having no defined order).
    const run = (order: 'A-then-B' | 'B-then-A'): boolean => {
      const local = createTestWorld({ dt: DT, systems: [] });
      const rootA = local.spawn(EntityAttributes({ name: 'RootA' }), Director({ timeline: 'a.timeline.json' }));
      const inner = local.spawn(EntityAttributes({ name: 'Inner', parentId: rootA.id() }), Director({ timeline: 'b.timeline.json' }));
      local.spawn(EntityAttributes({ name: 'Prop', parentId: inner.id(), isActive: true }));

      const defA = normalizeTimeline({
        id: 'a', name: 'A', duration: 4, frameRate: 30,
        tracks: [{ id: 'a1', name: 'AlwaysOff', target: 'Inner/Prop', type: 'activation', spans: [] }],
      });
      const defB = normalizeTimeline({
        id: 'b', name: 'B', duration: 4, frameRate: 30,
        tracks: [{ id: 'b1', name: 'Muted', target: 'Prop', type: 'activation', muted: true, spans: [{ start: 0, end: 4 }] }],
      });

      const getProp = () => {
        let found: { isActive: boolean } | undefined;
        local.world.query(EntityAttributes).updateEach(([attrs]) => {
          if ((attrs as { name: string }).name === 'Prop') found = attrs as { isActive: boolean };
        });
        return found!;
      };

      const idx = buildEntityIndex(local.world);
      if (order === 'A-then-B') {
        applyTimelineState(local.world, rootA.id(), defA, 2, idx);
        applyTimelineState(local.world, inner.id(), defB, 2, idx);
      } else {
        applyTimelineState(local.world, inner.id(), defB, 2, idx);
        applyTimelineState(local.world, rootA.id(), defA, 2, idx);
      }

      const result = getProp().isActive;
      local.dispose();
      return result;
    };

    expect(run('A-then-B')).toBe(false);
    expect(run('B-then-A')).toBe(false);
  });

  it('all-unmuted last-track-wins is unchanged: two unmuted tracks disagreeing, the later one wins', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'a', name: 'Act', duration: 4, frameRate: 30,
      tracks: [
        { id: 'first', name: 'First', target: 'Prop', type: 'activation', spans: [{ start: 0, end: 4 }] }, // always on
        { id: 'second', name: 'Second', target: 'Prop', type: 'activation', spans: [] }, // always off
      ],
    });
    setTimeline(PATH, def);
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    tw.spawn(EntityAttributes({ name: 'Prop', parentId: root.id(), isActive: false }));
    const getProp = () => {
      let found: { isActive: boolean } | undefined;
      tw!.world.query(EntityAttributes).updateEach(([attrs]) => {
        if ((attrs as { name: string }).name === 'Prop') found = attrs as { isActive: boolean };
      });
      return found!;
    };

    tw.step(2); // both unmuted, disagreeing — `second` is last in `def.tracks` → its `false` wins
    expect(getProp().isActive).toBe(false);
  });
});

describe('self-deactivation warning fires on the WINNING desired, not per-track (#452)', () => {
  /** #452 moved the self-deactivation check from "once per unmuted track" to "once per target,
   *  against the last-unmuted-track's WINNING `desired`" — see the ⚠️ comment above the check in
   *  timelineSystem.ts (applyTimelineState phase 2, ~:236-246) and docs/timeline.md's #452 section.
   *  These pin that the real soft-lock still warns, warn-once still holds, a track that LOSES the
   *  decision does not warn, and a muted track (never a driver) cannot trigger it either. */

  it('a real soft-lock still warns exactly once and emits @timeline-selfdeact', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'a', name: 'Act', duration: 4, frameRate: 30,
      tracks: [{ id: 'off', name: 'SelfOff', target: '', type: 'activation', spans: [{ start: 0, end: 0.2 }] }],
    });
    setTimeline(PATH, def);
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));

    tw.step(12); // past the 0.2s span end — desired goes false and stays false

    expect(root.get(EntityAttributes)!.isActive).toBe(false);
    const msgs = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('targets its OWN Director'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('"SelfOff"');
    const events = tw.events({ type: '@timeline-selfdeact' });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ director: root.id(), track: 'SelfOff' });
    warn.mockRestore();
  });

  it('warn-once holds across further steps of the same frozen Director', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'a', name: 'Act', duration: 4, frameRate: 30,
      tracks: [{ id: 'off', name: 'SelfOff', target: '', type: 'activation', spans: [{ start: 0, end: 0.2 }] }],
    });
    setTimeline(PATH, def);
    tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));

    tw.step(12); // triggers the soft-lock and warns once
    const firstCount = warn.mock.calls.filter((c) => String(c[0]).includes('targets its OWN Director')).length;
    expect(firstCount).toBe(1);

    tw.step(60); // Director is frozen — more ticks must not warn again
    const secondCount = warn.mock.calls.filter((c) => String(c[0]).includes('targets its OWN Director')).length;
    expect(secondCount).toBe(1);
    warn.mockRestore();
  });

  it('a losing OFF track does not warn — the deliberate #452 change (owner, 2026-08-30)', () => {
    // Pre-#452, this warned: the check ran once per unmuted track, so "Off" alone (desired false at
    // t=2) tripped it even though "On" — later in `def.tracks`, and thus the WINNER — keeps the
    // Director active throughout. Post-#452 the check runs once per target against the WINNING
    // `desired` (the last unmuted track), so a losing OFF track that never actually takes effect
    // must not warn. A zero here is intentional, not a missing case.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'a', name: 'Act', duration: 4, frameRate: 30,
      tracks: [
        { id: 'off', name: 'Off', target: '', type: 'activation', spans: [{ start: 0, end: 1 }] }, // desired false at t=2
        { id: 'on', name: 'On', target: '', type: 'activation', spans: [{ start: 0, end: 4 }] }, // desired true at t=2 — last, so wins
      ],
    });
    setTimeline(PATH, def);
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));

    tw.step(60); // t=2

    const msgs = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('targets its OWN Director'));
    expect(msgs).toHaveLength(0);
    expect(tw.events({ type: '@timeline-selfdeact' })).toHaveLength(0);
    expect(root.get(EntityAttributes)!.isActive).toBe(true);
    warn.mockRestore();
  });

  it('a muted activation track targeting its own root never warns or emits, regardless of spans', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    const def = normalizeTimeline({
      id: 'a', name: 'Act', duration: 4, frameRate: 30,
      tracks: [{ id: 'off', name: 'SelfOff', target: '', type: 'activation', muted: true, spans: [{ start: 0, end: 0.2 }] }],
    });
    setTimeline(PATH, def);
    tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));

    tw.step(40); // muted tracks do not drive — spans are irrelevant

    const msgs = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('targets its OWN Director'));
    expect(msgs).toHaveLength(0);
    expect(tw.events({ type: '@timeline-selfdeact' })).toHaveLength(0);
    warn.mockRestore();
  });
});
