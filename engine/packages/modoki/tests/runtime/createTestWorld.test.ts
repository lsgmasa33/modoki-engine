/** createTestWorld headless harness (Phase 5 — verification harness).
 *
 *  A worked example of the loop Claude uses to verify game logic: define a tiny
 *  "game" (a Score trait, an addPoint action, a win-check system that emits to
 *  the journal), drive it with dispatch + deterministic step, and assert on the
 *  journal + trait state. Also proves RNG reproducibility and global-state
 *  teardown. NO renderer involved. */

import { describe, it, expect, afterEach } from 'vitest';
import { trait, createWorld } from 'koota';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { emit, journalEvents } from '../../src/runtime/systems/journal';
import { getCurrentWorld } from '../../src/runtime/ecs/world';
import { getPlayState } from '../../src/runtime/systems/playState';
import { rngInt, rngNext, seedRng } from '../../src/runtime/systems/rng';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Time } from '../../src/runtime/traits/Time';

const Score = trait({ value: 0, won: false });

/** A win-check system: when score crosses 30, flip `won` once and emit 'win'. */
function winCheckSystem(world: ReturnType<typeof getCurrentWorld>) {
  world.query(Score).updateEach(([s]) => {
    if (s.value >= 30 && !s.won) {
      s.won = true;
      emit('win', { score: s.value });
    }
  });
}

/** The 'addPoint' action: +10 and emit 'score' (uses the dispatched world). */
const addPoint = ({ world }: { world: ReturnType<typeof getCurrentWorld> }) => {
  world.query(Score).updateEach(([s]) => {
    s.value += 10;
    emit('score', { total: s.value });
  });
};

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; });

describe('createTestWorld', () => {
  it('runs a tiny game end-to-end: dispatch → step → journal + trait assertions', () => {
    game = createTestWorld({
      systems: [{ name: 'winCheck', fn: winCheckSystem, priority: SYSTEM_PRIORITY.GAME }],
      actions: { addPoint },
    });
    const scoreEntity = game.spawn(Score);

    // Three points, stepping a frame after each so winCheck runs.
    game.dispatch('addPoint').step(1);
    game.dispatch('addPoint').step(1);
    game.dispatch('addPoint').step(1);

    expect(game.trait<{ value: number; won: boolean }>(Score, scoreEntity).value).toBe(30);
    expect(game.trait<{ value: number; won: boolean }>(Score, scoreEntity).won).toBe(true);
    expect(game.events({ type: 'score' })).toHaveLength(3);
    expect(game.events({ type: 'win' })).toHaveLength(1);
    // The win fired on the frame the third point landed (tick 3).
    expect(game.events({ type: 'win' })[0].tick).toBe(3);
  });

  it('advances time deterministically across step() calls', () => {
    game = createTestWorld({});
    game.step(7).step(3); // 10 fixed-dt frames total, across two calls
    let frame = 0, elapsed = 0;
    game.query(Time).updateEach(([t]: [{ frame: number; elapsed: number }]) => { frame = t.frame; elapsed = t.elapsed; });
    expect(frame).toBe(10);
    expect(elapsed).toBeCloseTo(10 / 60, 6);
  });

  it('is reproducible — same seed yields the same RNG-driven outcome', () => {
    const run = (seed: number) => {
      const g = createTestWorld({
        seed,
        systems: [{
          name: 'roller',
          fn: (world) => world.query(Score).updateEach(([s]) => { s.value = rngInt(1, 100); }),
        }],
      });
      const e = g.spawn(Score);
      g.step(1);
      const v = g.trait<{ value: number }>(Score, e).value;
      g.dispose();
      return v;
    };
    expect(run(42)).toBe(run(42)); // identical seed → identical roll
  });

  it('tears down global state on dispose', () => {
    const before = getPlayState();
    const g = createTestWorld({});
    expect(getPlayState()).toBe('playing'); // forced while live
    g.dispose();
    expect(getPlayState()).toBe(before);    // restored
  });

  // Missing Test #2 (determinism-harness F1): a full createTestWorld lifecycle must
  // not perturb a pre-existing ("production") world's RNG sequence or event journal.
  // With world-scoped state the harness world's seed/emit land on ITS OWN world and
  // GC away on dispose — so no restore is needed and the prod world stays pristine.
  it('does not perturb a pre-existing world\'s RNG sequence or journal', () => {
    // Control: an uninterrupted 4-draw sequence on the prod world.
    const control = createWorld();
    seedRng(123, control);
    const expectedSeq = [rngNext(control), rngNext(control), rngNext(control), rngNext(control)];

    // Actual: same prod world, but a whole harness lifecycle interleaves mid-stream.
    const prod = createWorld();
    seedRng(123, prod);
    emit('prod-event', { phase: 'before' }, prod);
    const actualSeq = [rngNext(prod), rngNext(prod)];

    const g = createTestWorld({ seed: 999 }); // seeds + clears ITS world, not prod
    g.spawn(Score);
    g.step(3);
    rngInt(0, 1000, g.world); // draw on the harness world
    emit('harness-event', {}, g.world);
    g.dispose();

    actualSeq.push(rngNext(prod), rngNext(prod));
    emit('prod-event', { phase: 'after' }, prod);

    // Prod RNG stream is identical to the uninterrupted control.
    expect(actualSeq).toEqual(expectedSeq);
    // Prod journal holds only prod events — the harness 'harness-event' never bled in.
    expect(journalEvents(undefined, prod).map((e) => e.type)).toEqual(['prod-event', 'prod-event']);
  });
});
