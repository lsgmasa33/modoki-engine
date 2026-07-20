/** PlayerPrefs — save → reload → restore integration (Phase 3).
 *
 *  Drives the real headless harness: a game action writes progress to PlayerPrefs and
 *  journals a `saved` event; we flush, tear the world down, then simulate a fresh
 *  launch (reset the in-memory cache, re-init against the SAME backend) and a second
 *  world whose `load` action rehydrates the value and journals `loaded`. This is the
 *  end-to-end persistence contract a game relies on across app restarts. */

import { describe, it, expect, afterEach } from 'vitest';
import { trait } from 'koota';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { PlayerPrefs, InMemoryBackend, resetPlayerPrefsForTest } from '../../src/runtime/storage';

const Score = trait({ value: 0 });
const SAVE_KEY = 'progress';

let game: TestWorld | undefined;

afterEach(() => {
  game?.dispose();
  game = undefined;
  resetPlayerPrefsForTest();
});

describe('PlayerPrefs — persistence across a simulated restart', () => {
  it('saves progress in one session and restores it in the next', async () => {
    const backend = new InMemoryBackend();

    // ── Session 1: play, then save ──────────────────────────────
    await PlayerPrefs.init({ namespace: 'game-x', backend });
    game = createTestWorld({
      actions: {
        save: (ctx) => {
          const e = ctx.world.query(Score)[0];
          const score = e.get(Score)!.value;
          PlayerPrefs.set(SAVE_KEY, { score });
          ctx.emit('saved', { score });
        },
      },
    });
    const player = game.spawn(Score({ value: 7 }));
    game.step(1).dispatch('save');
    await PlayerPrefs.flush();

    expect(game.events({ type: 'saved' })).toHaveLength(1);
    expect(game.trait<{ value: number }>(Score, player).value).toBe(7);

    // ── Simulate app restart: drop the in-memory cache, keep the backend ──
    game.dispose();
    game = undefined;
    resetPlayerPrefsForTest();

    // ── Session 2: fresh launch, load ───────────────────────────
    await PlayerPrefs.init({ namespace: 'game-x', backend });
    expect(PlayerPrefs.get(SAVE_KEY)).toEqual({ score: 7 }); // rehydrated from disk

    game = createTestWorld({
      actions: {
        load: (ctx) => {
          const saved = PlayerPrefs.get<{ score: number }>(SAVE_KEY);
          if (!saved) return;
          const e = ctx.world.query(Score)[0];
          e.set(Score, { value: saved.score });
          ctx.emit('loaded', { score: saved.score });
        },
      },
    });
    const revived = game.spawn(Score({ value: 0 }));
    game.dispatch('load').step(1);

    expect(game.trait<{ value: number }>(Score, revived).value).toBe(7); // restored
    expect(game.events({ type: 'loaded' })).toHaveLength(1);
  });

  it('a different namespace does not see another game\'s save', async () => {
    const backend = new InMemoryBackend();
    await PlayerPrefs.init({ namespace: 'game-x', backend });
    PlayerPrefs.set(SAVE_KEY, { score: 99 });
    await PlayerPrefs.flush();

    resetPlayerPrefsForTest();
    await PlayerPrefs.init({ namespace: 'game-y', backend });
    expect(PlayerPrefs.get(SAVE_KEY)).toBeUndefined();
  });
});
