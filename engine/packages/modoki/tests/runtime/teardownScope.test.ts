/** createTeardownScope — the release path that exists before the first acquisition (#858).
 *
 *  Each case pins one of the four properties the module header justifies. The point of the module
 *  is that a bring-up which ends EARLY still releases what it took, so the cases drive partial
 *  acquisition — not a happy path that would pass just as well against the bug being fixed.
 *
 *  MUTATION RESULTS, stated because one of them is not what it looks like:
 *    - `pop()` → `shift()` (LIFO lost) ......................... 4 red
 *    - drop the per-step `try/catch` ........................... 1 red (property 3)
 *    - `add()` after disposal queues instead of running ........ 2 red (property 4)
 *    - `disposed` getter always false .......................... 1 red
 *    - set `isDisposed` AFTER the drain (re-entrancy) .......... 2 red
 *    - drop the `if (isDisposed) return` guard ................. 1 red — but NOT the idempotence
 *      case below, and a non-destructive drain alone is caught by NOTHING.
 *
 *  ⚠️ So be honest about what the idempotence case pins: property 2 is provided REDUNDANTLY, by
 *  the `isDisposed` guard AND by the destructive drain leaving the list empty. Remove either one
 *  alone and this file stays green; it goes red only when both are removed (verified). It is a
 *  contract test for callers who legitimately double-dispose — `SceneView`'s `teardownViewport()`
 *  and `ParticleEditor`'s GPU-loss teardown — not a guard on a single mechanism. The re-entrancy
 *  case below is the one that actually pins the flag. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTeardownScope } from '../../src/runtime/core/teardownScope';

afterEach(() => vi.restoreAllMocks());

describe('createTeardownScope', () => {
  it('releases in REVERSE acquisition order (property 1)', () => {
    const order: string[] = [];
    const scope = createTeardownScope('test');
    scope.add(() => order.push('renderer'));
    scope.add(() => order.push('camera'));
    scope.add(() => order.push('controls'));
    scope.dispose();
    // Reverse, so nothing is released before something acquired later that depends on it.
    expect(order).toEqual(['controls', 'camera', 'renderer']);
  });

  it('releases what a bring-up took BEFORE it threw — the whole point (#858)', () => {
    const released: string[] = [];
    const scope = createTeardownScope('test');
    // A bring-up that acquires two things, then dies partway. The teardown path holds `dispose`
    // from before any of it, so it does not matter that the closure releasing them was never
    // built.
    expect(() => {
      scope.add(() => released.push('cameraSlot'));
      scope.add(() => released.push('rendererLease'));
      throw new Error('setup() died here');
    }).toThrow('setup() died here');
    scope.dispose();
    expect(released).toEqual(['rendererLease', 'cameraSlot']);
  });

  it('is idempotent — a second dispose releases nothing again (property 2)', () => {
    const release = vi.fn();
    const scope = createTeardownScope('test');
    scope.add(release);
    scope.dispose();
    scope.dispose();
    scope.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('runs every later step even when one release throws, and reports it (property 3)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after: string[] = [];
    const scope = createTeardownScope('SceneView');
    scope.add(() => after.push('first-acquired'));
    scope.add(() => { throw new Error('context already dead'); });
    scope.add(() => after.push('last-acquired'));
    scope.dispose();
    // LIFO: 'last-acquired', then the thrower, then 'first-acquired' — which must still run.
    expect(after).toEqual(['last-acquired', 'first-acquired']);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toContain('[SceneView]');
  });

  it('runs a release added AFTER disposal immediately (property 4)', () => {
    const scope = createTeardownScope('Scene3D');
    scope.dispose();
    const late = vi.fn();
    // The mirror-image defect: a pending promise resolves after teardown and registers a frame
    // callback. It must self-release, not sit in a list nothing will drain.
    scope.add(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('reports the disposed state, so a late arrival can skip the work instead of undoing it', () => {
    const scope = createTeardownScope('test');
    expect(scope.disposed).toBe(false);
    scope.dispose();
    expect(scope.disposed).toBe(true);
  });

  it('does not recurse when a release re-enters dispose()', () => {
    const order: string[] = [];
    const scope = createTeardownScope('ParticleEditor');
    scope.add(() => order.push('outer'));
    // A GPU-loss teardown firing while the unmount teardown is mid-drain.
    scope.add(() => { scope.dispose(); order.push('reentrant'); });
    scope.dispose();
    expect(order).toEqual(['reentrant', 'outer']);
  });

  it('releases immediately when a release registers another one mid-teardown', () => {
    const order: string[] = [];
    const scope = createTeardownScope('test');
    // Mid-drain the scope is ALREADY closed, so this inner `add` takes property 4's
    // run-immediately path rather than being queued behind the rest of the drain. Either would
    // stop the leak; pinning which one happens is what stops a later "tidy-up" from swapping in
    // a snapshot iteration that would strand it.
    scope.add(() => { scope.add(() => order.push('registered-during-drain')); order.push('outer'); });
    scope.dispose();
    expect(order).toEqual(['registered-during-drain', 'outer']);
  });
});
