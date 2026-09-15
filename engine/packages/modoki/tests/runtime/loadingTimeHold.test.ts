/** `core/loadingTimeHold.ts` (#1246) — game time waits while a loading screen is up.
 *
 *  The owner's call: the whole game waits, so the first frame anyone sees is t = 0 of the scene. The
 *  failure it replaces was silent: a Director tour played its first station under the overlay. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { holdTimeForLoading, isTimeHeldForLoading, resetLoadingTimeHold } from '../../src/runtime/core/loadingTimeHold';
import { getTime, getSimDelta, getVisualDelta, setTimeScale } from '../../src/runtime/core/getTime';

let tw: TestWorld | undefined;
afterEach(() => { tw?.dispose(); tw = undefined; resetLoadingTimeHold(); vi.restoreAllMocks(); });

describe('loadingTimeHold', () => {
  it('counts holds, and a release is idempotent — a cleanup path cannot free someone else’s hold', () => {
    const a = holdTimeForLoading();
    const b = holdTimeForLoading();
    a(); a();
    expect(isTimeHeldForLoading()).toBe(true);
    b();
    expect(isTimeHeldForLoading()).toBe(false);
  });

  it('while held, time stands still for every accessor — and the authored timeScale is untouched', () => {
    tw = createTestWorld({ dt: 1 / 60 });
    tw.step(10);
    const before = getTime(tw.world)!;
    const elapsed = before.elapsed;
    const frame = before.frame;
    setTimeScale(tw.world, 0.5);

    const release = holdTimeForLoading();
    tw.step(30);
    const held = getTime(tw.world)!;
    expect(held.elapsed).toBe(elapsed);
    expect(getSimDelta(tw.world)).toBe(0);
    expect(getVisualDelta(tw.world)).toBe(0);
    expect(held.frame).toBe(frame + 30);   // systems still ticked: poses sample, frames render
    expect(held.timeScale).toBe(0.5);

    release();
    tw.step(1);
    expect(getSimDelta(tw.world)).toBeGreaterThan(0);
    expect(getTime(tw.world)!.elapsed).toBeGreaterThan(elapsed);
  });
});
