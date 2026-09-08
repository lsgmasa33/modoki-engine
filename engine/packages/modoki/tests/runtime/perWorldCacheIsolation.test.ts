/**
 * #851 — the remaining per-`World` caches, held to the two-live-Worlds contract.
 *
 * The three event-bus factories are covered separately in `eventBusWorldIsolation.test.ts` (they
 * are one shape and get one fix). This file covers the rest: zone trigger state, the two audio
 * caches, the physics contact index, and the physics world registry.
 *
 * Read `docs/falsifiable-tests.md` before touching these — the mutation bar (collapse the
 * `Map<World,…>` to a module-level value, confirm THIS member's case goes red, restore) is what
 * separates these from the tests they replace.
 *
 * ⚠️ **Honest framing, carried from the issue:** two koota `World`s coexist only transiently,
 * during the two-world atomic scene swap — unlike #828's renderer axis, where SceneView and
 * GameView coexist permanently. So this is a COVER gap first and only possibly a live defect.
 * `physicsContactIndex` in particular is the weakest member: correctness there is independently
 * defended by explicit `onWorldSwap`/`onPlayStateChange` clears, so its case below pins a
 * CONTRACT rather than a live bug, and says so.
 */
import { describe, it, expect, beforeEach, afterEach, onTestFinished } from 'vitest';
import type { World } from 'koota';
import { twoWorlds, assertIsolated, assertClearIsScoped } from '../helpers/twoWorlds';
import { setCurrentWorld, peekCurrentWorld } from '../../src/runtime/core/ecs/world';
import { runZoneTriggers, clearZoneState } from '../../src/runtime/zones/zoneTriggerCore';
import { createZoneEventBus } from '../../src/runtime/zones/zoneEventBus';
import { cueSound, drainAudioCues, clearAudioCues } from '../../src/runtime/audio/audioCues';
import {
  updateContactIndex, getContactState, clearContactIndex,
} from '../../src/runtime/physics/physicsContactIndex';
import { createPhysicsWorldRegistry } from '../../src/runtime/physics/physicsWorldRegistry';
import { audioSystem, stopWorldAudio } from '../../src/runtime/audio/audioSystem';
import { setAudioRecordMode, clearAudioLog } from '../../src/runtime/audio/audioService';
import { AudioSource } from '../../src/runtime/traits/AudioSource';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { setPlayState, getPlayState } from '../../src/runtime/core/playState';
import { journalEvents, clearJournal } from '../../src/runtime/core/journal';
import { registerAsset, newGuid, clearManifest } from '../../src/runtime/loaders/assetManifest';

describe('audioCues keeps its queue per World (#851)', () => {
  it('cueing on B does not put the cue in A’s queue', () => {
    assertIsolated(
      twoWorlds(),
      (world, name: string) => cueSound(name, world),
      // `drain` empties the queue, so each world is read exactly once — which is fine here
      // because assertIsolated reads A before B and never re-reads.
      // Exactly one cue per world, so the single name IS the queue's identity. Comparing the
      // whole array would compare shape as well as content and obscure which half failed.
      (world) => drainAudioCues(world).map((c) => c.name).join('+'),
      ['a-sound', 'b-sound'],
      'audioCues',
    );
  });

  it('clearing A’s queue leaves B’s intact', () => {
    const { a, b } = twoWorlds();
    cueSound('a-sound', a);
    cueSound('b-sound', b);
    clearAudioCues(a);
    expect(drainAudioCues(a)).toEqual([]);
    // The half no single-world suite can reach: a shared queue is emptied for everyone.
    expect(drainAudioCues(b).length, 'clearing world A’s cues also drained world B').toBe(1);
  });

  it('CONTROL: a cue really is queued — the assertions above are not passing on emptiness', () => {
    const { a } = twoWorlds();
    cueSound('x', a);
    expect(drainAudioCues(a).length).toBe(1);
  });
});

describe('zoneTriggerCore keeps prev-frame occupancy per World (#851)', () => {
  // `stateFor` is private, so this drives the PUBLIC path — `runZoneTriggers`, whose whole job is
  // to diff THIS frame's containment against the previous frame's state for that world+channel.
  // A shared `stateByWorld` shows up as a missing `enter`: world B's run overwrites the prev-frame
  // baseline, so world A's next run believes its occupant was already inside.
  const alwaysInside = { contains: () => true };

  function harness(world: World) {
    const { events } = createZoneEventBus('ZoneIsoTest', 'zoneIsoTest');
    const fired: string[] = [];
    const zone = world.spawn();
    const occupant = world.spawn();
    const run = () => runZoneTriggers(
      world,
      'chan',
      [{ entity: zone, ...alwaysInside }],
      [{ entity: occupant, x: 0, y: 0, z: 0 }],
      events,
      (_z, _o, phase) => { fired.push(phase); },
      '@zoneIsoTest',
    );
    return { run, fired };
  }

  it('world B’s frame does not become world A’s prev-frame baseline', () => {
    const { a, b } = twoWorlds();
    const A = harness(a);
    const B = harness(b);

    A.run();                       // A: enter
    expect(A.fired).toEqual(['enter']);
    B.run();                       // B: enter — and, if shared, overwrites A's baseline
    expect(B.fired).toEqual(['enter']);

    A.run();                       // A again: the occupant never left, so NOTHING should fire
    expect(
      A.fired,
      'world A re-fired after world B ran — the prev-frame occupancy state is shared',
    ).toEqual(['enter']);
  });

  it('clearZoneState(A) re-arms only A — B’s baseline survives', () => {
    const { a, b } = twoWorlds();
    const A = harness(a);
    const B = harness(b);
    A.run();
    B.run();
    clearZoneState(a);             // A forgets, so its next run re-fires `enter`
    A.run();
    B.run();
    expect(A.fired, 'clearing A should re-arm A').toEqual(['enter', 'enter']);
    expect(B.fired, 'clearZoneState(A) also wiped world B’s baseline').toEqual(['enter']);
  });
});

describe('physicsContactIndex keys contacts per World (#851)', () => {
  // ⚠️ Pins a CONTRACT, not an observed bug — see this file's header. Kept because the contract
  // is what a future per-entity/streaming teardown would silently break.
  it('a contact recorded in B is not visible in A', () => {
    const { a, b } = twoWorlds();
    updateContactIndex(a, 1, 2, false, 'enter');
    updateContactIndex(b, 1, 3, false, 'enter');
    // Read A back AFTER writing B — the ordering that the guidIndex near-miss got wrong.
    expect(getContactState(a, 1)?.contacts, 'world A’s contacts were clobbered by world B').toEqual([2]);
    expect(getContactState(b, 1)?.contacts).toEqual([3]);
  });

  it('clearing world A’s index leaves world B’s contacts', () => {
    const { a, b } = twoWorlds();
    updateContactIndex(a, 1, 2, false, 'enter');
    updateContactIndex(b, 1, 3, false, 'enter');
    clearContactIndex(a);
    expect(getContactState(a, 1)).toBeUndefined();
    expect(getContactState(b, 1)?.contacts, 'clearing world A also wiped world B').toEqual([3]);
  });
});

describe('physicsWorldRegistry holds one Rapier state per World (#851)', () => {
  // The issue flagged this member for escalation: the blast radius is WASM handle identity, not a
  // stale cached value. Reading the module settles the design question it raised — `worlds` is a
  // `Map<World, S>` whose `disposeAll` iterates, and `onWorldSwap((next, old) => dispose(old))`
  // frees the OLD world while the new one is already live. So two entries coexisting is a
  // DESIGNED state during the atomic swap, not something prevented elsewhere, and a test is the
  // right artifact rather than an assertion at a prevention point.
  // ⚠️ `disposeRegistry`, per test. The factory registers a global `onPlayStateChange` and
  // `onWorldSwap` hook; production calls it exactly twice (2D and 3D, at module load) so it never
  // needed a teardown, but a file that builds one per CASE leaks two live listeners each time —
  // and they keep firing, running `disposeAll()` on dead registries at the next
  // `setPlayState('stopped')` (the audio describe above does exactly that) or world swap. Latent
  // rather than failing today, and it becomes a cross-test failure the moment a case asserts on
  // `freed` after that point. Found in close-out review.
  const freeing = () => {
    const freed: string[] = [];
    const reg = createPhysicsWorldRegistry<{ tag: string }>((s) => { freed.push(s.tag); });
    onTestFinished(() => reg.disposeRegistry());
    return { reg, freed };
  };

  // ⚠️ **There is deliberately NO "two worlds retain their own state" case here.** One was
  // written and removed in close-out review: writing `reg.worlds.set(a, …)` and reading
  // `reg.worlds.get(a)` supplies both the key and the value, so it asserts `Map.prototype` and
  // cannot fail under the mutation `docs/falsifiable-tests.md` prescribes ("keep the map, ignore
  // the key"). The keying this member is actually about lives at the CONSUMERS —
  // `physics2DSystem.ts` / `physics3DSystem.ts` take `registry.worlds` and do their own
  // `get(world)`/`set(world, st)` — so a test in this file could never reach it. What IS the
  // registry's own mechanism, and is covered below, is WHICH world each teardown path frees.

  it('the world-swap hook frees the OLD world and leaves the NEW one live', () => {
    // The registry's real contract, and the reason two entries legitimately coexist: a scene load
    // creates the new world and `setCurrentWorld` fires `onWorldSwap` SYNCHRONOUSLY with the old
    // one still alive. Freeing the wrong side here frees WASM handles the live world is stepping.
    const { a, b } = twoWorlds();
    const { reg, freed } = freeing();
    // `peek`, not `get`: `getCurrentWorld()` lazily ALLOCATES a world when none is current, and
    // worldRegistry documents exactly this case — a fresh-module test must not accidentally
    // spend one of koota's 16 slots on a world it only wanted to read. Restoring `null` is also
    // the honest restore; promoting a synthetic world is not.
    const restore = peekCurrentWorld();
    try {
      setCurrentWorld(a);
      reg.worlds.set(a, { tag: 'A' });
      reg.worlds.set(b, { tag: 'B' });
      setCurrentWorld(b); // a → b: the swap
      expect(freed, 'the swap should free exactly the OUTGOING world').toEqual(['A']);
      expect(reg.worlds.get(b)?.tag, 'the swap freed the INCOMING world’s state').toBe('B');
    } finally {
      if (restore) setCurrentWorld(restore);
    }
  });

  it('disposing A frees ONLY A’s WASM and leaves B’s live', () => {
    // The consequence that makes this member worse than a stale cache: under a shared slot,
    // dispose(A) frees the handles world B is still stepping.
    const { a, b } = twoWorlds();
    const { reg, freed } = freeing();
    reg.worlds.set(a, { tag: 'A' });
    reg.worlds.set(b, { tag: 'B' });
    reg.dispose(a);
    expect(freed, 'dispose(A) freed the wrong world’s WASM').toEqual(['A']);
    expect(reg.worlds.get(b)?.tag, 'disposing world A dropped world B’s live Rapier state').toBe('B');
  });

  it('disposeAll frees every world exactly once', () => {
    const { a, b } = twoWorlds();
    const { reg, freed } = freeing();
    reg.worlds.set(a, { tag: 'A' });
    reg.worlds.set(b, { tag: 'B' });
    reg.disposeAll();
    expect(freed.sort()).toEqual(['A', 'B']);
    expect(reg.worlds.size).toBe(0);
  });
});

/** #851 — `audioSystem`'s `states` map. This member is the one whose docstring already MAKES the
 *  claim: `stopWorldAudio` says it is "scoped to the given world — NOT a global stopAll — so a
 *  swap in one viewport can't cut audio in another (editor dual-viewport)". Nothing tested it
 *  with two live worlds, so the docstring was the only thing holding the contract up.
 *
 *  Found by `/close-out`'s sweep of the per-World cache declarations, not by the original design
 *  pass — it was in #851's table and in the plan, and the first round of tests skipped it. */
describe('audioSystem keeps its live-voice state per World (#851)', () => {
  const prevPlayState = getPlayState();

  beforeEach(() => {
    setAudioRecordMode(true);
    clearAudioLog();
    setPlayState('playing');
  });
  afterEach(() => {
    clearManifest();
    setPlayState(prevPlayState);
    // Restore the global too — leaving record mode on leaks into any suite that runs after this
    // one in the same process (close-out review).
    setAudioRecordMode(false);
  });

  function mintClip(): string {
    const guid = newGuid();
    registerAsset(guid, `/games/x/assets/audio/${guid}.mp3`, 'audio');
    return guid;
  }

  /** Start one autoplaying voice in `world` and return its clip guid. */
  function startVoice(world: World): string {
    clearJournal(world);
    const clip = mintClip();
    world.spawn(AudioSource({ clip, autoplay: true }), EntityAttributes({ guid: newGuid() }));
    audioSystem(world);
    return clip;
  }

  const stopReasons = (world: World) =>
    journalEvents({ type: '@audio' }, world)
      .map((e) => (e.payload as { phase: string; reason?: string }))
      .filter((p) => p.phase === 'stop')
      .map((p) => p.reason);

  it('stopWorldAudio(A) does not cut world B’s voices', () => {
    const { a, b } = twoWorlds();
    // ⚠️ **Shift B's entity ids, or the primary assertion below CANNOT FAIL.** Two fresh koota
    // worlds hand out the same ids from 0, and `AudioState.sources` is keyed by raw numeric
    // entity id — so under a shared `states` map B's voice OVERWRITES A's entry rather than
    // coexisting with it, and the surplus stop lands in A's journal. `stopReasons(b)` is then
    // `[]` under BOTH hypotheses. Measured in close-out re-review: without this line the case
    // passed with the mechanism deleted, and only the CONTROL failed — by accident, via that
    // same id collision. A red COUNT is not a red TEST.
    b.spawn(EntityAttributes({ guid: newGuid() }));
    startVoice(a);
    startVoice(b);

    stopWorldAudio(a);

    // A's voice is torn down…
    expect(stopReasons(a), 'world A’s voice should stop').toEqual(['world-teardown']);
    // …and B's is NOT. Under a shared `states` map, stopWorldAudio(A) iterates B's sources too
    // and cuts audio in the other viewport — exactly what the docstring promises it cannot do,
    // and what no single-world suite can observe.
    expect(
      stopReasons(b),
      'stopWorldAudio(A) also stopped world B’s voice — the audio state map is shared',
    ).toEqual([]);
  });

  it('CONTROL: a voice really did start in each world', () => {
    // Without this, two worlds that never started any audio would satisfy the assertion above.
    const { a, b } = twoWorlds();
    startVoice(a);
    startVoice(b);
    for (const [label, w] of [['A', a], ['B', b]] as const) {
      const phases = journalEvents({ type: '@audio' }, w).map((e) => (e.payload as { phase: string }).phase);
      expect(phases, `world ${label} should have started a voice`).toContain('start');
    }
  });
});

/** The fixture is itself a mechanism, so it gets its own falsification. */
describe('the twoWorlds fixture cannot pass vacuously', () => {
  it('assertIsolated FAILS when handed one world twice', () => {
    const { a } = twoWorlds();
    const store = new Map<World, string>();
    expect(() => assertIsolated(
      { a, b: a, both: [a, a] },
      (world, v: string) => { store.set(world, v); },
      (world) => store.get(world),
      ['x', 'y'],
    )).toThrow(/ONE world twice/);
  });

  it('assertIsolated FAILS on a deliberately shared store', () => {
    const w = twoWorlds();
    let shared = '';
    expect(() => assertIsolated(
      w,
      (_world, v: string) => { shared = v; },
      () => shared,
      ['x', 'y'],
    )).toThrow(/not keyed by World/);
  });

  it('assertClearIsScoped FAILS when the clear is global', () => {
    const w = twoWorlds();
    const store = new Map<World, string>();
    expect(() => assertClearIsScoped(
      w,
      (world, v: string) => { store.set(world, v); },
      (world) => store.get(world),
      () => store.clear(),
      ['x', 'y'],
      undefined,
    )).toThrow(/ALSO cleared world B/);
  });
});
