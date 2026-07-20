/** TimeManager — anchors over the pause-aware clock. The System half (timeSystem)
 *  is not exercised here; we drive `Time.elapsed` directly to isolate the Manager. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { getCurrentWorld, setCurrentWorld } from '../../src/runtime/ecs/world';
import { Time } from '../../src/runtime/traits';
import { setPlayState } from '../../src/runtime/systems/playState';
import { timeManager } from '../../src/runtime/managers/TimeManager';
import { resolveTemplate } from '../../src/runtime/ui/bindingResolver';
import { __resetReadSourcesForTesting } from '../../src/runtime/ui/readSourceRegistry';

/** Set the active world's Time.elapsed/delta (spawns the Time singleton if absent). */
function setElapsed(elapsed: number, delta = 0) {
  const w = getCurrentWorld();
  let done = false;
  w.query(Time).updateEach(([t]: any[]) => { t.elapsed = elapsed; t.delta = delta; done = true; });
  if (!done) w.spawn(Time({ elapsed, delta }));
}

describe('TimeManager', () => {
  beforeEach(() => {
    setCurrentWorld(createWorld());
    setPlayState('playing');
    setElapsed(0);
  });
  afterEach(() => {
    timeManager.dispose();
    __resetReadSourcesForTesting();
    setPlayState('playing');
  });

  // ── generic layer ─────────────────────────────────────────────────────────

  it('timeSince(anchor) = elapsed − stamp; unknown anchor = 0', () => {
    setElapsed(10);
    timeManager.mark('a');
    setElapsed(13);
    expect(timeManager.timeSince('a')).toBe(3);
    expect(timeManager.timeSince('never')).toBe(0);
  });

  // ── fixed accessors delegate to the generic layer ───────────────────────────

  it('timeSinceGameStart delegates to the gameStart anchor', () => {
    setElapsed(5);
    timeManager.mark('gameStart');
    setElapsed(8);
    expect(timeManager.timeSinceGameStart).toBe(3);
  });

  it('deltaTime reads Time.delta', () => {
    setElapsed(8, 0.016);
    expect(timeManager.deltaTime).toBeCloseTo(0.016, 5);
  });

  // ── event anchoring (requires init's listeners) ─────────────────────────────

  it('re-stamps gameStart on every entry into Playing (editor Stop→Play)', () => {
    timeManager.init();                 // stamps gameStart at elapsed 0
    setPlayState('stopped');
    setElapsed(5);
    setPlayState('playing');            // → re-stamps gameStart at elapsed 5
    setElapsed(9);
    expect(timeManager.timeSinceGameStart).toBe(4);
  });

  it('re-stamps sceneLoad on every world swap', () => {
    timeManager.init();                 // stamps sceneLoad at elapsed 0
    const next = createWorld();
    next.spawn(Time({ elapsed: 100, delta: 0 }));
    setCurrentWorld(next);              // fires onWorldSwap → re-stamps sceneLoad at 100
    setElapsed(102);                    // mutate the new world's Time
    expect(timeManager.timeSinceSceneLoad).toBe(2);
  });

  it('does not advance while elapsed is frozen (pause derives for free)', () => {
    setElapsed(5);
    timeManager.mark('gameStart');
    // elapsed unchanged (simulated pause: timeSystem stops advancing it)
    expect(timeManager.timeSinceGameStart).toBe(0);
  });

  // ── read-source integration ─────────────────────────────────────────────────

  it('exposes timeSinceGameStart to UI text bindings via the read-source registry', () => {
    timeManager.init();                 // registers read sources, stamps gameStart at 0
    setElapsed(7);
    expect(resolveTemplate('{timeSinceGameStart}', {})).toBe('7');
  });
});
