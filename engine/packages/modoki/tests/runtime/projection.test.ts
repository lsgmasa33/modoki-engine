/** registerProjection — store-subscription dirty flag over a PROJECTION-priority
 *  system: runs syncFn only on the first frame after a store change or scene swap. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld } from 'koota';
import { getCurrentWorld, setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { setPlayState } from '../../src/runtime/core/playState';
import { runPipeline } from '../../src/runtime/core/pipeline';
import { registerProjection, unregisterProjection } from '../../src/runtime/core/projection';

function makeStore() {
  const listeners = new Set<() => void>();
  return {
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    emit() { for (const l of [...listeners]) l(); },
    listenerCount() { return listeners.size; },
  };
}

const tick = () => runPipeline(getCurrentWorld());

describe('registerProjection', () => {
  beforeEach(() => {
    setCurrentWorld(createWorld());
    setPlayState('playing');
  });
  afterEach(() => { unregisterProjection('p'); });

  it('runs once initially, then skips while the store is unchanged', () => {
    const store = makeStore();
    const sync = vi.fn();
    registerProjection('p', store, sync);

    tick();                       // dirty (initial) → runs
    tick(); tick();               // clean → skipped
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('re-runs on a store change', () => {
    const store = makeStore();
    const sync = vi.fn();
    registerProjection('p', store, sync);
    tick();                       // initial
    expect(sync).toHaveBeenCalledTimes(1);

    store.emit();                 // store changed → dirty
    tick();
    expect(sync).toHaveBeenCalledTimes(2);
    tick();                       // clean again
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('re-runs on a scene swap (new world)', () => {
    const store = makeStore();
    const sync = vi.fn();
    registerProjection('p', store, sync);
    tick();
    expect(sync).toHaveBeenCalledTimes(1);

    setCurrentWorld(createWorld()); // onWorldSwap → dirty
    tick();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('re-registering the same name releases the previous subscriptions (no leak)', () => {
    const store = makeStore();
    const syncA = vi.fn();
    const syncB = vi.fn();
    registerProjection('p', store, syncA);
    expect(store.listenerCount()).toBe(1);

    // Re-register under the same name. The old store/swap subs must be dropped,
    // not orphaned — listenerCount stays 1, and the old syncFn never runs again.
    registerProjection('p', store, syncB);
    expect(store.listenerCount()).toBe(1);

    tick();          // initial for B
    store.emit();
    tick();
    expect(syncA).not.toHaveBeenCalled();
    expect(syncB).toHaveBeenCalledTimes(2);
  });

  it('unregister drops the system and all subscriptions', () => {
    const store = makeStore();
    const sync = vi.fn();
    registerProjection('p', store, sync);
    tick();
    expect(store.listenerCount()).toBe(1);

    unregisterProjection('p');
    expect(store.listenerCount()).toBe(0);

    store.emit();
    tick();
    expect(sync).toHaveBeenCalledTimes(1); // never ran again
  });

  describe('pauseWhileStopped', () => {
    it('does not call syncFn while stopped', () => {
      const store = makeStore();
      const sync = vi.fn();
      registerProjection('p', store, sync, undefined, { pauseWhileStopped: true });

      setPlayState('stopped');
      tick(); tick(); tick();
      expect(sync).not.toHaveBeenCalled();
    });

    it('holds pending state (does NOT consume the dirty flag) and projects once running resumes', () => {
      const store = makeStore();
      const sync = vi.fn();
      registerProjection('p', store, sync, undefined, { pauseWhileStopped: true });

      setPlayState('stopped');
      tick(); // initial dirty — held, not consumed
      store.emit(); // store changed while stopped — still dirty
      tick(); tick(); tick(); // held every time
      expect(sync).not.toHaveBeenCalled();

      setPlayState('playing');
      tick();
      expect(sync).toHaveBeenCalledTimes(1); // the held state finally projects
      tick(); // clean now — no further calls
      expect(sync).toHaveBeenCalledTimes(1);
    });

    it('without the option, a projection still runs while stopped (default unchanged)', () => {
      const store = makeStore();
      const sync = vi.fn();
      registerProjection('p', store, sync); // no opts

      setPlayState('stopped');
      tick();
      expect(sync).toHaveBeenCalledTimes(1);
    });

    it('setPlayState("paused") also holds it', () => {
      const store = makeStore();
      const sync = vi.fn();
      registerProjection('p', store, sync, undefined, { pauseWhileStopped: true });

      setPlayState('paused');
      tick(); tick();
      expect(sync).not.toHaveBeenCalled();

      setPlayState('playing');
      tick();
      expect(sync).toHaveBeenCalledTimes(1);
    });
  });
});
