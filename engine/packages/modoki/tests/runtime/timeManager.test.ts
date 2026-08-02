/** TimeManager — anchors over the pause-aware clock. The System half (timeSystem)
 *  is not exercised here; we drive `Time.elapsed` directly to isolate the Manager. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { getCurrentWorld, setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { Time } from '../../src/runtime/traits';
import { setPlayState } from '../../src/runtime/core/playState';
import { timeManager } from '../../src/runtime/managers/TimeManager';
import { resolveTemplate } from '../../src/runtime/ui/bindingResolver';
import { getReadValue, __resetReadSourcesForTesting } from '../../src/runtime/core/readSourceRegistry';
import { registerManager, unregisterManager } from '../../src/runtime/managers/managerRegistry';

// Called as methods (not extracted) so `this` inside TimeManagerImpl still resolves.
// These used to need an `as unknown as () => void` cast: the `TimeManager` interface
// inherited `ManagerDef`'s `init(ctx: ManagerContext)` while the implementation takes
// no ctx, so a direct call had to fabricate a context this suite has no use for. The
// interface now declares the no-arg form it actually has (#37).
const init = () => timeManager.init();
const dispose = () => timeManager.dispose();

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
    dispose();
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
    init();                 // stamps gameStart at elapsed 0
    setPlayState('stopped');
    setElapsed(5);
    setPlayState('playing');            // → re-stamps gameStart at elapsed 5
    setElapsed(9);
    expect(timeManager.timeSinceGameStart).toBe(4);
  });

  it('re-stamps sceneLoad on every world swap', () => {
    init();                 // stamps sceneLoad at elapsed 0
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
    init();                 // registers read sources, stamps gameStart at 0
    setElapsed(7);
    expect(resolveTemplate('{timeSinceGameStart}', {})).toBe('7');
  });

  // ── dispose actually tears down (the listeners init() subscribed) ────────────
  // dispose() drops the read sources AND unsubscribes the playState/worldSwap
  // listeners. The unsubscribe half was previously unasserted: a leaked listener
  // keeps re-stamping anchors on a disposed manager, which is invisible until some
  // later scene mis-reports its timings. Observed via the anchor, not the internals —
  // a live listener would re-stamp, a dead one leaves timeSince at 0 (unknown anchor).

  it('dispose() unsubscribes the playState listener — no re-stamp after teardown', () => {
    init();
    dispose();
    setPlayState('stopped');
    setElapsed(5);
    setPlayState('playing');  // a leaked listener would re-stamp gameStart here
    setElapsed(9);
    expect(timeManager.timeSince('gameStart')).toBe(0);
  });

  it('dispose() unsubscribes the worldSwap listener — no re-stamp after teardown', () => {
    init();
    dispose();
    const next = createWorld();
    next.spawn(Time({ elapsed: 100, delta: 0 }));
    setCurrentWorld(next);    // a leaked listener would re-stamp sceneLoad here
    setElapsed(102);
    expect(timeManager.timeSince('sceneLoad')).toBe(0);
  });

  it('dispose() drops the read sources it registered', () => {
    init();
    expect(getReadValue('timeSinceGameStart')).toBeDefined();
    dispose();
    for (const n of ['deltaTime', 'timeSinceGameStart', 'timeSinceSceneLoad']) {
      expect(getReadValue(n)).toBeUndefined();
    }
  });

  // ── registry integration: the path production actually uses ─────────────────
  // Every test above calls init()/dispose() directly. Production never does — core
  // registers the singleton and the registry drives it, calling init({world, scenePath})
  // with a REAL ManagerContext that this manager ignores (#37). That seam was uncovered:
  // nothing asserted the manager still works when a ctx it does not read is handed to it.

  describe('driven through managerRegistry', () => {
    afterEach(() => { unregisterManager('engine.time'); });

    it('registerManager activates it (app scope) — anchors stamped, read sources live', () => {
      registerManager(timeManager);   // scope 'app' → activates immediately, init(ctx)
      setElapsed(7);
      expect(resolveTemplate('{timeSinceGameStart}', {})).toBe('7');
      expect(timeManager.timeSinceSceneLoad).toBe(7);
    });

    it('the ignored ctx changes nothing — registered behaves exactly like a direct init()', () => {
      registerManager(timeManager);
      setPlayState('stopped');
      setElapsed(5);
      setPlayState('playing');        // listeners wired by the registry-driven init
      setElapsed(9);
      expect(timeManager.timeSinceGameStart).toBe(4);
    });

    it('unregisterManager disposes it — read sources dropped, listeners unsubscribed', () => {
      registerManager(timeManager);
      unregisterManager('engine.time');
      expect(getReadValue('timeSinceGameStart')).toBeUndefined();
      setPlayState('stopped');
      setElapsed(5);
      setPlayState('playing');
      setElapsed(9);
      expect(timeManager.timeSince('gameStart')).toBe(0);
    });
  });
});
