/** Dev-mode idempotency guard for LateUpdate systems (Nit 2). A LateUpdate runs once
 *  PER active 3D viewport, so it must be a pure function of the read-back pose: running
 *  the registered systems twice on the SAME input must produce the same output. The
 *  guard in `runLateUpdates` snapshots the input via an IdempotencyProbe, runs, RESETS
 *  to that input, runs again, and compares — flagging only true (hidden-state)
 *  accumulators, NOT the documented-valid "clip + relative offset" pattern. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { World } from 'koota';
import {
  registerLateUpdate, runLateUpdates, clearLateUpdates, type IdempotencyProbe,
} from '../../src/runtime/systems/lateUpdate';

const W = {} as unknown as World; // systems under test ignore the world arg

/** A probe over a plain numeric "pose" array, mimicking the bone-Transform probe. */
function makeProbe(getState: () => number[], setState: (s: number[]) => void): IdempotencyProbe {
  return {
    capture: () => Float64Array.from(getState()),
    restore: (snap) => setState(Array.from(snap)),
  };
}

describe('runLateUpdates — dev idempotency guard', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { clearLateUpdates(); errSpy.mockRestore(); });

  it('does NOT flag an absolute-set system (idempotent)', () => {
    let pose = [0];
    registerLateUpdate('abs', () => { pose[0] = 5; });
    runLateUpdates(W, makeProbe(() => pose, (s) => { pose = s; }));
    expect(errSpy).not.toHaveBeenCalled();
    expect(pose[0]).toBe(5); // canonical first-run result is left in place
  });

  it('does NOT flag a "clip + relative offset" system (valid — reset pose each run)', () => {
    // Mirrors bone.test's `tf.rx += 0.3`: reads the read-back pose, adds an offset.
    // Idempotent because the guard resets to the input pose between the two runs.
    let pose = [10];
    registerLateUpdate('rel', () => { pose[0] += 0.3; });
    runLateUpdates(W, makeProbe(() => pose, (s) => { pose = s; }));
    expect(errSpy).not.toHaveBeenCalled();
    expect(pose[0]).toBeCloseTo(10.3, 6);
  });

  it('FLAGS a hidden-state accumulator (reads its own previous output)', () => {
    let pose = [0];
    let acc = 0; // hidden module-like state — the forbidden pattern
    registerLateUpdate('accumulator', () => { acc += 1; pose[0] = acc; });
    runLateUpdates(W, makeProbe(() => pose, (s) => { pose = s; }));
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain('NON-IDEMPOTENT');
    expect(String(errSpy.mock.calls[0][0])).toContain('accumulator'); // names the system
  });

  it('checks once per distinct system set (no per-frame spam)', () => {
    let pose = [0];
    let acc = 0;
    registerLateUpdate('accumulator', () => { acc += 1; pose[0] = acc; });
    const probe = makeProbe(() => pose, (s) => { pose = s; });
    runLateUpdates(W, probe);
    runLateUpdates(W, probe);
    runLateUpdates(W, probe);
    expect(errSpy).toHaveBeenCalledTimes(1); // only the first frame re-checks this set
  });

  it('re-arms the check when the system set changes', () => {
    let pose = [0];
    let acc = 0;
    registerLateUpdate('acc1', () => { acc += 1; pose[0] = acc; });
    const probe = makeProbe(() => pose, (s) => { pose = s; });
    runLateUpdates(W, probe);
    expect(errSpy).toHaveBeenCalledTimes(1);
    // Registering another bad system changes the signature → re-checks.
    let acc2 = 0;
    registerLateUpdate('acc2', () => { acc2 += 2; pose[0] = acc2; });
    runLateUpdates(W, probe);
    expect(errSpy).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when no systems are registered', () => {
    let pose = [0];
    runLateUpdates(W, makeProbe(() => pose, (s) => { pose = s; }));
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('still runs systems when no probe is supplied (guard skipped)', () => {
    const pose = [0];
    registerLateUpdate('abs', () => { pose[0] = 7; });
    runLateUpdates(W); // no probe → plain run, no guard
    expect(pose[0]).toBe(7);
    expect(errSpy).not.toHaveBeenCalled();
  });
});
