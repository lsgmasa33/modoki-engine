/** CROSS-SUBSYSTEM INTEGRATION SMOKE — `docs/architecture-layers.md` (P2 of the module-boundaries layering work).
 *
 *  The two barrel tests next to this one catch the STRUCTURAL failure of the P3–P7 file moves:
 *  an export that comes out `undefined` because a move changed module evaluation order. They
 *  cannot catch the BEHAVIOURAL failure — a move that leaves every import resolving fine but
 *  quietly severs a runtime hand-off between two subsystems (a registry that two folders used to
 *  share now has two copies; a system registered at the wrong tier; an event bus keyed on a
 *  module-level Map that got duplicated). Those are silent in unit tests too, because a unit test
 *  boots one system in isolation.
 *
 *  So this test boots ONE world with (near) the full production system pipeline — the same
 *  systems, at the same priorities, as `engine/app/ecs/pipeline.ts` — and runs a scenario that
 *  deliberately crosses five subsystem boundaries in a single frame budget:
 *
 *    timeline → animation   a Director's animation track scrubs an `Animator`, which the
 *                           ANIMATION-tier `animationSystem` samples the SAME frame into Transform.
 *    timeline → audio       an audio track cues a clip; the AUDIO-tier `audioSystem` drains it.
 *    timeline → actions     a signal marker dispatches a named UIAction through the action registry.
 *    physics  → journal     a falling dynamic body lands on a static floor → `@contact`.
 *    physics/transform → zones  the falling body is a `ZoneOccupant`; the TRANSFORM+2 zone system
 *                           sees its post-physics world pose and fires `@zone` enter + `OnZone2D`.
 *    zones    → audio       the zone's declarative action cues another clip.
 *
 *  Everything is asserted on the JOURNAL and on trait state — never pixels — per the harness
 *  contract in `docs/verification-harness.md`.
 *
 *  DELIBERATELY EXCLUDED from the pipeline (with reasons, so a future phase does not "fix" it):
 *   - `inputSystem`, `characterInputSystem`, `characterInput3DSystem`, `uiFocusSystem` — the app
 *     pipeline registers these but the HEADLESS harness must not: they read live DOM/gamepad
 *     sources, which would make the run non-deterministic. Tests set the `Input` resource directly.
 *   - `materialInstanceSystem`, `uiTreeProjection` — reach live render surfaces / the UI store;
 *     they no-op headless, so including them would add cost and no signal.
 *   - `physics3DSystem` — the 2D dimension exercises the identical wiring; 3D is covered by its
 *     own tests and would double the Rapier WASM boot cost here.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
// Side-effect only: wires core provider slots (P7 C11+) so the real animation/sprite caches below resolve correctly.
import '../../src/runtime/loaders/registerProviders';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { registerTrait, getAllTraits } from '../../src/runtime/core/ecs/traitRegistry';

import { Transform } from '../../src/runtime/core/traits/Transform';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { Animator } from '../../src/runtime/traits/Animator';
import { Director } from '../../src/runtime/traits/Director';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { Zone2D } from '../../src/runtime/traits/Zone2D';
import { ZoneOccupant } from '../../src/runtime/traits/ZoneOccupant';
import { OnZone2D } from '../../src/runtime/traits/OnZone2D';

import { timelineSystem } from '../../src/runtime/timeline/timelineSystem';
import { animationSystem } from '../../src/runtime/animation/animationSystem';
import { spriteAnimationSystem } from '../../src/runtime/animation/spriteAnimationSystem';
import { rotate3DSystem } from '../../src/runtime/rendering/rotate3DSystem';
import { physics2DSystem, disposePhysics2D } from '../../src/runtime/physics/physics2DSystem';
import { initRapier2D } from '../../src/runtime/physics/rapierLoader';
import { zone2DSystem } from '../../src/runtime/zones/zone2DSystem';
import { audioSystem } from '../../src/runtime/audio/audioSystem';
import { transformPropagationSystem } from '../../src/runtime/core/ecs/transformPropagationSystem';

import { setAnimationClip, clearAnimationClipCache } from '../../src/runtime/loaders/animationClipCache';
import { setTimeline, clearTimelineCache } from '../../src/runtime/loaders/timelineCache';
import { normalizeTimeline, type TimelineDef } from '../../src/runtime/timeline/types';
import type { AnimationClipDef } from '../../src/runtime/animation/types';
import { registerAsset, newGuid, clearManifest } from '../../src/runtime/loaders/assetManifest';
import { cueClip } from '../../src/runtime/audio/audioCues';
import { getAudioLog, clearAudioLog, setAudioRecordMode } from '../../src/runtime/audio/audioService';
import { zone2DEvents } from '../../src/runtime/zones/Zone2DEvents';
import { timelineEvents } from '../../src/runtime/timeline/TimelineEvents';
import { emit } from '../../src/runtime/core/journal';

/** The production pipeline, minus the app-only systems listed in the header. Priorities are
 *  copied from `engine/app/ecs/pipeline.ts` on purpose — if a phase changes a tier, this test
 *  should be updated in the same commit, and the diff makes that visible. */
const PIPELINE = [
  { name: 'timeline', fn: timelineSystem, priority: SYSTEM_PRIORITY.ANIMATION - 1 },
  { name: 'animation', fn: animationSystem, priority: SYSTEM_PRIORITY.ANIMATION },
  { name: 'spriteAnimation', fn: spriteAnimationSystem, priority: SYSTEM_PRIORITY.ANIMATION },
  { name: 'rotate3D', fn: rotate3DSystem, priority: SYSTEM_PRIORITY.GAME },
  { name: 'transformPropagationPre', fn: transformPropagationSystem, priority: SYSTEM_PRIORITY.TRANSFORM_PREPASS },
  { name: 'physics2D', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS },
  { name: 'transformPropagation', fn: transformPropagationSystem, priority: SYSTEM_PRIORITY.TRANSFORM },
  { name: 'zone2D', fn: zone2DSystem, priority: SYSTEM_PRIORITY.TRANSFORM + 2 },
  { name: 'audio', fn: audioSystem, priority: SYSTEM_PRIORITY.AUDIO },
];

const TIMELINE_PATH = 'smoke.timeline.json';
const CLIP_PATH = 'smoke.anim.json';
/** Animator clip bank: name `move` → the seeded clip. */
const MOVE_BANK = JSON.stringify([{ name: 'move', clip: CLIP_PATH }]);
/** The engine clamps per-tick delta at 1/30, so stepping AT the cap keeps playhead math exact. */
const DT = 1 / 30;

const MOVE_CLIP: AnimationClipDef = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'move',
  duration: 1,
  frameRate: 30,
  loop: false,
  tracks: [
    {
      path: '', trait: 'Transform', field: 'x', type: 'number',
      keys: [
        { t: 0, v: 0, inTangent: 100, outTangent: 100 },
        { t: 1, v: 100, inTangent: 100, outTangent: 100 },
      ],
    },
  ],
};

function ensureTraitsRegistered() {
  const names = new Set(getAllTraits().map((m) => m.name));
  if (!names.has('Transform'))
    registerTrait({ name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' } } });
  if (!names.has('EntityAttributes'))
    registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' } } });
}

let tw: TestWorld | undefined;
let timelineClip = '';
let signalClip = '';
let zoneClip = '';

beforeAll(async () => { await initRapier2D(); });

beforeEach(() => {
  ensureTraitsRegistered();
  setAudioRecordMode(true);   // no AudioContext in node — log what WOULD play
  clearAudioLog();
  timelineClip = newGuid(); registerAsset(timelineClip, `/games/x/assets/sfx/${timelineClip}.mp3`, 'audio');
  signalClip = newGuid();   registerAsset(signalClip, `/games/x/assets/sfx/${signalClip}.mp3`, 'audio');
  zoneClip = newGuid();     registerAsset(zoneClip, `/games/x/assets/sfx/${zoneClip}.mp3`, 'audio');
  setAnimationClip(CLIP_PATH, MOVE_CLIP);
});

afterEach(() => {
  if (tw) {
    zone2DEvents.__clear(tw.world);
    timelineEvents.__clear(tw.world);
    disposePhysics2D(tw.world);
    tw.dispose();
    tw = undefined;
  }
  clearTimelineCache();
  clearAnimationClipCache();
  clearManifest();
  clearAudioLog();
  setAudioRecordMode(false);
});

function seedTimeline(): TimelineDef {
  const def = normalizeTimeline({
    id: '33333333-3333-3333-3333-333333333333',
    name: 'smoke',
    duration: 1,
    frameRate: 30,
    tracks: [
      // timeline → animation: scrubs the root's Animator, sampled by animationSystem the same frame.
      { id: 'a', name: 'Anim', target: '', type: 'animation', clips: [{ start: 0, duration: 1, clip: 'move' }] },
      // timeline → actions: a named UIAction dispatch through the action registry.
      { id: 's', name: 'Sig', target: '', type: 'signal', markers: [{ t: 0.2, action: 'smoke.signal' }] },
      // timeline → audio: a cue drained by audioSystem at the AUDIO tier.
      { id: 'u', name: 'Audio', target: '', type: 'audio', cues: [{ t: 0.4, clip: timelineClip, bus: 'sfx' }] },
    ],
  });
  setTimeline(TIMELINE_PATH, def);
  return def;
}

/** Build the whole cross-subsystem scene in one world. Returns the entities under assertion. */
function buildScene() {
  const world = createTestWorld({
    dt: DT,
    seed: 7,
    systems: PIPELINE,
    actions: {
      // Fired by the timeline signal marker.
      'smoke.signal': (ctx) => {
        cueClip(signalClip, { bus: 'sfx' });
        emit('@smoke.signal', { from: 'timeline' }, (ctx.world ?? undefined) as never);
      },
      // Fired by the zone's declarative OnZone2D.onEnter.
      'smoke.zoneEnter': () => { cueClip(zoneClip, { bus: 'sfx' }); },
    },
  });
  seedTimeline();

  // Director root — carries the Animator the timeline scrubs.
  const director = world.spawn(
    EntityAttributes({ name: 'director' }),
    Transform({ x: 0, y: 0 }),
    Animator({ clips: MOVE_BANK, clip: '', time: 0, speed: 1, playing: false, loop: false }),
    Director({ timeline: TIMELINE_PATH }),
  );

  // Physics: static floor + a dynamic box dropped onto it. Screen Y is DOWN, gravity is +Y.
  world.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
  const floor = world.spawn(
    EntityAttributes({ name: 'floor' }),
    Transform({ x: 0, y: 300 }),
    RigidBody2D({ bodyType: 'static' }),
    Collider2D({ shape: 'box', halfW: 200, halfH: 20 }),
  );
  // The falling body is ALSO a zone occupant — the zone system reads its post-physics pose.
  const box = world.spawn(
    EntityAttributes({ name: 'box' }),
    Transform({ x: 0, y: 0 }),
    RigidBody2D({ bodyType: 'dynamic' }),
    Collider2D({ shape: 'circle', radius: 15 }),
    ZoneOccupant,
  );
  // Zone sitting just above the floor, on the box's path down. Circle zone → radius = sx.
  world.spawn(
    EntityAttributes({ name: 'zone' }),
    Transform({ x: 0, y: 200, sx: 60, sy: 60 }),
    Zone2D({ shape: 'circle' }),
    OnZone2D({ onEnter: 'smoke.zoneEnter', onExit: '' }),
  );

  return { world, director, floor, box };
}

describe('cross-subsystem smoke — full pipeline in one world', () => {
  it('drives timeline + animation + audio + physics + zones together in one run', () => {
    const scene = buildScene();
    tw = scene.world;

    tw.step(120);   // 4 s of sim at the 1/30 cap — well past the timeline (1 s) and the box's fall

    // --- timeline → animation ------------------------------------------------------------
    const anim = tw.trait<{ time: number; activeClip: string }>(Animator, scene.director);
    expect(anim.activeClip, 'timeline animation track never scrubbed the Animator').toBe('move');
    const tf = tw.trait<{ x: number }>(Transform, scene.director);
    expect(tf.x, 'animationSystem never sampled the scrubbed Animator into Transform.x').toBeGreaterThan(0);

    // --- timeline → actions --------------------------------------------------------------
    expect(tw.events({ type: '@marker' }).length, 'timeline signal marker did not fire').toBeGreaterThanOrEqual(1);
    expect(tw.events({ type: '@smoke.signal' }).length, 'the dispatched action did not run').toBeGreaterThanOrEqual(1);

    // --- physics → journal ---------------------------------------------------------------
    const contacts = tw.events({ type: '@contact' });
    expect(contacts.length, 'the falling body never contacted the floor').toBeGreaterThanOrEqual(1);

    // --- physics/transform → zones -------------------------------------------------------
    const zoneEvents = tw.events({ type: '@zone' });
    const enters = zoneEvents.filter((e) => (e.payload as { phase: string }).phase === 'enter');
    expect(enters.length, 'the falling occupant never entered the zone').toBeGreaterThanOrEqual(1);

    // --- timeline → audio, zones → audio -------------------------------------------------
    const played = getAudioLog().filter((e) => e.op === 'play').map((e) => e.clip);
    expect(played, 'timeline audio track cue never reached audioSystem').toContain(timelineClip);
    expect(played, 'signal-dispatched action cue never reached audioSystem').toContain(signalClip);
    expect(played, 'OnZone2D declarative action cue never reached audioSystem').toContain(zoneClip);

    // --- ordering sanity: the journal is tick-stamped monotonically ------------------------
    const ticks = tw.events().map((e) => e.tick);
    expect(ticks, 'journal ticks went backwards').toEqual([...ticks].sort((a, b) => a - b));
  });

  it('is deterministic — two identical runs produce the same journal', () => {
    function run(): string {
      const scene = buildScene();
      scene.world.step(120);
      const summary = scene.world
        .events()
        .map((e) => `${e.tick}:${e.type}`)
        .join('\n');
      disposePhysics2D(scene.world.world);
      zone2DEvents.__clear(scene.world.world);
      timelineEvents.__clear(scene.world.world);
      scene.world.dispose();
      return summary;
    }
    const a = run();
    clearAudioLog();
    const b = run();
    expect(a.length).toBeGreaterThan(0);
    expect(b, 'the same scenario produced a different event stream on a second run').toEqual(a);
  });
});
