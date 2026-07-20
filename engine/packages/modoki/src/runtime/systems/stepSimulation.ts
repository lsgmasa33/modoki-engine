/** Deterministic stepping (Phase 1 — verification harness).
 *
 *  Advances a world by an EXACT number of fixed-dt ticks with no real wall-clock
 *  involved, so a headless playtest reproduces byte-for-byte. Installs the manual
 *  clock, forces `'playing'` so the simulation tiers run, primes `timeSystem`'s
 *  baseline, then runs the pipeline `ticks` times advancing the clock by `dt`
 *  each tick. The previous play-state and the real clock are restored after.
 *
 *  Under a fixed dt the smoothing EMA converges to that constant, so
 *  `smoothedDelta === delta` after the first frame — i.e. determinism holds for
 *  the visual layer too. */

import type { World } from 'koota';
import { runPipeline } from './pipeline';
import { setManualNow, advanceManual, restoreRealClock, isManualClock } from './clock';
import { getPlayState, setPlayState } from './playState';
import { resetTimeBaseline } from './timeSystem';
import { getCurrentWorld, setCurrentWorld } from '../ecs/worldRegistry';

export interface StepOptions {
  /** Seconds per tick (default 1/60). */
  dt?: number;
  /** Restore the real clock + prior play-state when done (default true). Pass
   *  false to chain multiple `stepSimulation` calls while staying on the manual
   *  clock (e.g. dispatch an intent between batches). */
  restore?: boolean;
}

/** The bare fixed-dt advance loop: step the manual clock by `dt` and run the
 *  pipeline, `ticks` times. NO state management (play-state / clock install /
 *  baseline) — the caller owns that. Shared by `stepSimulation` (self-contained,
 *  resets each call) and `createTestWorld.step` (state set once at construction,
 *  clock accumulates across steps) so the core loop can't drift between the two. */
export function advanceFixedSteps(world: World, ticks: number, dt: number): void {
  for (let i = 0; i < ticks; i++) {
    advanceManual(dt * 1000);
    runPipeline(world);
  }
}

/** Run `ticks` fixed-dt pipeline frames deterministically. Returns nothing —
 *  read results off the world (traits / event journal) after. */
export function stepSimulation(world: World, ticks = 1, opts: StepOptions = {}): void {
  const dt = opts.dt ?? 1 / 60;
  const restore = opts.restore ?? true;
  const prevState = getPlayState();
  const prevWorld = getCurrentWorld();

  // F4 — headless-only entry point. The dangerous misuse is calling this while the
  // editor/runtime has a LIVE world playing on the real clock: the setManualNow(0)
  // + resetTimeBaseline below would yank the global clock to manual/0 and disturb
  // the live render loop. A real-clock 'playing' state is exactly that signal — a
  // manual clock already installed is the SUPPORTED chain path (restore:false), so
  // we deliberately do NOT warn on that. Dev-only; never throws (don't break a run).
  if (import.meta.env?.DEV && !isManualClock() && prevState === 'playing') {
    console.warn(
      '[stepSimulation] called while a live (real-clock) "playing" session is active. ' +
      'This is a headless-only entry point and will reset the global clock to manual/0, ' +
      'disturbing the live render loop. Stop play (or use a dedicated headless world) first.',
    );
  }

  // Make the stepped world current so the world-scoped free functions game systems
  // use (emit / rngNext, determinism-harness F1) resolve to THIS world — the same
  // one timeSystem stamps the journal tick on. Otherwise emits/RNG would leak into
  // whatever world happened to be current.
  setCurrentWorld(world);
  setPlayState('playing');
  // Start the manual clock at a fixed origin and align timeSystem to it so the
  // first tick produces exactly `dt`, not a jump from the import-time baseline.
  setManualNow(0);
  resetTimeBaseline();

  advanceFixedSteps(world, ticks, dt);

  if (restore) {
    restoreRealClock();
    resetTimeBaseline();
    setPlayState(prevState);
    setCurrentWorld(prevWorld);
  }
}
