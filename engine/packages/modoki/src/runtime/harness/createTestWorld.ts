/** createTestWorld — headless playtest harness (Phase 5 — verification harness).
 *
 *  Ties the substrate together (deterministic clock + seeded RNG + event journal +
 *  pipeline) into the loop Claude uses to verify game logic WITHOUT a renderer:
 *  spawn/register → step deterministically → dispatch intents → assert on the
 *  journal/traits. A passing scenario doubles as a regression test (`npm test`).
 *
 *  It installs PROCESS-GLOBAL state (current world, play-state, manual clock) and
 *  tears it down in `dispose()`. The RNG seed + event journal are now WORLD-SCOPED
 *  (determinism-harness F1) — they live on the test world and GC away with it, so
 *  no restore is needed and a stray production world can't pollute the test stream.
 *  Because the clock/play-state/current-world are still global, test files must run
 *  serially (vitest isolates per file by default; call `dispose()` in `afterEach`).
 *  See docs/verification-harness.md Phase 5.
 *
 *  NOTE: loading a real game SCENE FILE (`loadSceneFile`) needs the game's traits
 *  registered + assets resolvable headlessly — that pairs with the first real
 *  game and is a follow-up. This core supports direct `spawn` + registered
 *  systems/actions, which is what unit-level logic verification needs. */

import { createWorld, type World } from 'koota';
import { Time } from '../core/traits/Time';
import { getCurrentWorld, setCurrentWorld, spawnEntity } from '../core/ecs/world';
import { registerSystem, unregisterSystem, SYSTEM_PRIORITY } from '../core/pipeline';
import { timeSystem } from '../core/timeSystem';
import { setManualNow, restoreRealClock } from '../core/clock';
import { advanceFixedSteps } from '../core/stepSimulation';
import { resetTimeBaseline } from '../core/timeSystem';
import { getPlayState, setPlayState, type PlayState } from '../core/playState';
import { seedRng } from '../core/rng';
import { clearJournal, journalEvents, _resetCaptureSeq, setVerboseCapture, verboseCaptureState, type GameEvent } from '../core/journal';
import {
  registerUIAction, unregisterUIAction, dispatchUIAction,
  type UIActionHandler, type UIActionDef, type UIActionPayload,
} from '../core/actionRegistry';
import { setTimeScale as setWorldTimeScale } from '../core/getTime';
import { clearControlSpawns } from '../timeline/controlSpawnRegistry';
import { clearSkeletalSeeks } from '../core/skeletalSeek';
import { clearParticleControls } from '../core/particleControlRegistry';
import { clearTimelineWarnings } from '../timeline/timelineSystem';
import { setTimelinePreviewActive } from '../core/timelinePreview';

/** A game system to run each frame, with its pipeline priority. */
export interface TestSystemDef {
  name: string;
  fn: (world: World) => void;
  /** Defaults to SYSTEM_PRIORITY.GAME. */
  priority?: number;
}

export interface CreateTestWorldOptions {
  /** RNG seed → reproducible run (default 1). */
  seed?: number;
  /** Seconds per tick (default 1/60). */
  dt?: number;
  /** Game systems to register (timeSystem is always registered first). */
  systems?: TestSystemDef[];
  /** Named actions dispatchable via `.dispatch(name, payload)`. */
  actions?: Record<string, UIActionHandler | UIActionDef>;
}

export interface TestWorld {
  /** The underlying koota world (also the current world for the harness lifetime). */
  readonly world: World;
  /** Spawn an entity (passthrough to `world.spawn`). */
  spawn: (...traits: unknown[]) => ReturnType<World['spawn']>;
  /** Advance `ticks` fixed-dt frames deterministically. Chainable. */
  step: (ticks?: number, dt?: number) => TestWorld;
  /** Fire a named action/intent (same path a UI button would). Chainable. */
  dispatch: (name: string, payload?: UIActionPayload) => TestWorld;
  /** Read the event journal, optionally filtered by type. */
  events: (filter?: { type?: string }) => GameEvent[];
  /** Read a trait off an entity. */
  trait: <T>(t: unknown, entity: unknown) => T;
  /** Query the world (passthrough to `world.query`). */
  query: (...traits: unknown[]) => ReturnType<World['query']>;
  /** Set the global time scale (0 = pause/time-stop, 0.3 = slow-mo). Chainable. */
  setTimeScale: (scale: number) => TestWorld;
  /** Tear down ALL global state and destroy the world. Call in afterEach. */
  dispose: () => void;
}

/** Build a headless playtest world. Remember to `dispose()` it. */
export function createTestWorld(opts: CreateTestWorldOptions = {}): TestWorld {
  const defaultDt = opts.dt ?? 1 / 60;

  // Capture global state to restore on dispose.
  let prevWorld: World | undefined;
  try { prevWorld = getCurrentWorld(); } catch { prevWorld = undefined; }
  const prevPlay: PlayState = getPlayState();

  const world = createWorld();
  setCurrentWorld(world);
  setPlayState('playing');           // sim tiers run; dispatchUIAction is live
  seedRng(opts.seed ?? 1, world);    // reproducible; world-scoped (F1)

  // Spawned + registered BEFORE clearJournal on purpose. Registering is what keeps the
  // harness honest: an unregistered entity is invisible to the O(1) entity index, so any
  // engine code the playtest calls falls back to an O(n) scan and warns — which is how
  // `findEntity(1)` (this Time singleton) came to flood CI with thousands of lines. Doing
  // it before the clear keeps the resulting `@spawn` out of the journal, so a test that
  // asserts on events() still sees only what its own run produced.
  spawnEntity(world, Time);

  clearJournal(world);
  // Headless playtests want FULL observability, so open every Tier-2 (watch-gated)
  // diagnostic capture (@contact, …) — in a real runtime these default off to keep the
  // journal lean until a debugger opens a watch. Closed again in dispose().
  for (const t of verboseCaptureState().types) setVerboseCapture(t, true);
  setManualNow(0);
  resetTimeBaseline();

  // Register timeSystem first, then the game's systems. Track names for teardown.
  const systemNames: string[] = [];
  registerSystem('harness:time', timeSystem, SYSTEM_PRIORITY.TIME);
  systemNames.push('harness:time');
  for (const s of opts.systems ?? []) {
    registerSystem(s.name, s.fn, s.priority ?? SYSTEM_PRIORITY.GAME);
    systemNames.push(s.name);
  }

  const actionNames: string[] = [];
  for (const [name, def] of Object.entries(opts.actions ?? {})) {
    registerUIAction(name, def);
    actionNames.push(name);
  }

  const handle: TestWorld = {
    world,
    // Registered like a real spawn — a playtest entity must be reachable through the
    // entity index, or engine code under test takes a different (O(n), warning) path than
    // it does in the running game. The `@spawn` this journals is correct and wanted: the
    // harness advertises full observability, and a runtime spawn journals one too.
    spawn: (...traits) => spawnEntity(world, ...(traits as Parameters<World['spawn']>)),
    step(ticks = 1, dt = defaultDt) {
      // Play-state + manual clock + baseline were set once above; just advance.
      // Shared loop with stepSimulation so the two can't drift.
      advanceFixedSteps(world, ticks, dt);
      return handle;
    },
    dispatch(name, payload) {
      dispatchUIAction(name, { payload });
      return handle;
    },
    events: (filter) => journalEvents(filter, world),
    trait: <T>(t: unknown, entity: unknown) => (entity as { get: (x: unknown) => T }).get(t),
    query: (...traits) => world.query(...(traits as Parameters<World['query']>)),
    setTimeScale(scale) {
      setWorldTimeScale(world, scale);
      return handle;
    },
    dispose() {
      for (const n of actionNames) unregisterUIAction(n);
      for (const n of systemNames) unregisterSystem(n);
      restoreRealClock();
      resetTimeBaseline();
      _resetCaptureSeq();                // reset the shared cap counter (V3) for the next test
      for (const t of verboseCaptureState().types) setVerboseCapture(t, false); // close Tier-2 captures
      // Timeline module-singletons are keyed by world-local ids / hold an editor flag — reset
      // them so no state leaks into the next serially-run test (the "resets ALL global state"
      // contract). These also self-clear on world swap, but dispose must not depend on prevWorld.
      clearControlSpawns();
      clearSkeletalSeeks();
      clearParticleControls();
      clearTimelineWarnings();          // warn-once sets are keyed by world-local entity ids
      setTimelinePreviewActive(false);
      setPlayState(prevPlay);
      if (prevWorld) setCurrentWorld(prevWorld);
      world.destroy();
    },
  };

  return handle;
}
