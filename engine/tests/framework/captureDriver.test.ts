// @vitest-environment jsdom
/** The gameplay recorder's in-page replay driver (#1479, `engine/app/debug/captureDriver.ts`): it
 *  takes the frame cadence, advances exactly one dt per step, and waits for the page to SETTLE
 *  before each step — a Pixi init or a fetch completes in real time, and a fixed-dt replay that did
 *  not wait would capture frames missing whatever had not arrived yet. */

import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from 'vitest';
import { createWorld } from 'koota';
import {
  isFrameLoopHeld, isCaptureMode, getCaptureMode, isManualClock, rawNow, registerFrameCallback, unregisterFrameCallback,
  rngNext, seedRng, Time, timeSystem, getCurrentWorld, setCurrentWorld, setPlayState, getPlayState, holdTimeForLoading,
  emit, sceneManager, setTimeScale,
} from '@modoki/engine/runtime';
import type { World } from 'koota';
import { beginCapture, stepCapture, bootStepCapture, endCapture, initCaptureDriver } from '../../app/debug/captureDriver';

type PoolHandle = { __2d?: { pool: { pendingInits: () => number } } };
const win = window as unknown as PoolHandle;

let runs = 0;
beforeEach(() => {
  runs = 0;
  registerFrameCallback('captureDriverProbe', () => { runs++; }, 0);
});
afterEach(() => {
  endCapture();
  unregisterFrameCallback('captureDriverProbe');
  delete win.__2d;
});

describe('captureDriver', () => {
  it('takes the cadence: holds the loop, pins the clock, enters capture mode — and gives it all back', () => {
    const originalFetch = window.fetch;
    beginCapture({ dtMs: 40, seed: 1 });
    expect(isFrameLoopHeld()).toBe(true);
    expect(isManualClock()).toBe(true);
    expect(isCaptureMode()).toBe(true);
    expect(getCaptureMode()).toBe('rendering');
    const frozen = rawNow();
    expect(rawNow()).toBe(frozen);
    endCapture();
    expect(isFrameLoopHeld()).toBe(false);
    expect(isManualClock()).toBe(false);
    expect(isCaptureMode()).toBe(false);
    expect(window.fetch).toBe(originalFetch);
  });

  it('each step advances the clock by exactly one dt and runs the frame callbacks once', async () => {
    beginCapture({ dtMs: 40, seed: 1 });
    const t0 = rawNow();
    await stepCapture(3);
    // t0 is the fractional performance.now() the clock was pinned at, so the sum is exact only to float
    // precision — 119.99999999999977 for some t0. A missed or doubled step is 40ms off either way.
    expect(rawNow() - t0).toBeCloseTo(120, 6);
    expect(runs).toBe(3);
  });

  it('pins the seed for a world created after the capture begins — the replay world', () => {
    beginCapture({ dtMs: 40, seed: 4242 });
    const replay = createWorld();
    const ref = createWorld();
    seedRng(4242, ref);
    expect([rngNext(replay), rngNext(replay)]).toEqual([rngNext(ref), rngNext(ref)]);
    replay.destroy(); ref.destroy();
  });

  it('waits for a 2D surface still initialising before drawing the frame', async () => {
    let pending = 1;
    win.__2d = { pool: { pendingInits: () => pending } };
    beginCapture({ dtMs: 40, seed: 1 });
    const step = stepCapture(1);
    await new Promise((r) => setTimeout(r, 40));
    // Still waiting: nothing drawn, and the sim clock has not moved.
    expect(runs).toBe(0);
    pending = 0;
    const state = await step;
    expect(runs).toBe(1);
    expect(state.settleMs).toBeGreaterThan(0);
    expect(state.unsettled).toBe(0);
  });

  it('waits for a fetch in flight', async () => {
    let release!: () => void;
    const realFetch = window.fetch;
    onTestFinished(() => { window.fetch = realFetch; });
    window.fetch = (() => new Promise<Response>((r) => { release = () => r(new Response('ok')); })) as typeof fetch;
    beginCapture({ dtMs: 40, seed: 1 });
    const inFlight = window.fetch('/asset');
    const step = stepCapture(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(runs).toBe(0);
    release();
    await inFlight;
    await step;
    expect(runs).toBe(1);
  });

  it('goes ahead after the settle timeout, and records the step as unsettled with what was pending', async () => {
    win.__2d = { pool: { pendingInits: () => 2 } };
    initCaptureDriver('');   // installs the window API without starting a capture
    beginCapture({ dtMs: 40, seed: 1, settleTimeoutMs: 30 });
    const state = await stepCapture(1);
    expect(runs).toBe(1);
    expect(state.unsettled).toBe(1);
    const api = (window as unknown as { __modokiCapture: { unsettled: () => unknown } }).__modokiCapture;
    expect(api.unsettled()).toEqual([{ step: 0, pending: ['2 2D surface init'] }]);
  });

  it('starts a capture from the URL only when asked', () => {
    initCaptureDriver('?scene=main');
    expect(isFrameLoopHeld()).toBe(false);
    initCaptureDriver('?capture=1&dt=20&seed=3');
    expect(isFrameLoopHeld()).toBe(true);
  });

  describe('the take clock and the journal, through real worlds', () => {
    /** A world with a clock, current and playing, whose sim runs in the frame loop like `ecs` does. */
    const worldWithClock = (): World => {
      const w = createWorld();
      w.spawn(Time());
      setCurrentWorld(w);
      return w;
    };
    let prevWorld: World;
    let prevPlay: ReturnType<typeof getPlayState>;
    beforeEach(() => {
      prevWorld = getCurrentWorld();
      prevPlay = getPlayState();
      setPlayState('playing');
      // "On screen" needs a loaded scene as well as a released hold; these tests have no SceneManager load.
      vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ id: 1, path: '/assets/scenes/main.scene.json', state: 'active' } as never);
      registerFrameCallback('captureDriverSim', () => timeSystem(getCurrentWorld()), -1);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      unregisterFrameCallback('captureDriverSim');
      setPlayState(prevPlay);
      setCurrentWorld(prevWorld);
    });

    it('sums each frame\'s sim delta, and does NOT restart when a scene load swaps in a fresh Time', async () => {
      worldWithClock();
      beginCapture({ dtMs: 25, seed: 1 });
      let state = await stepCapture(4);
      expect(state.takeTime).toBeCloseTo(0.1, 9);
      // A level change mid-take: the new world's Time starts from zero…
      worldWithClock();
      state = await stepCapture(2);
      expect(state.frame).toBe(2);
      // …and the take clock carries on — a clock read from Time.elapsed would say 0.05 here.
      expect(state.takeTime).toBeCloseTo(0.15, 9);
    });

    it('stays at zero while the loading hold freezes time — the take starts when the game is on screen', async () => {
      worldWithClock();
      const release = holdTimeForLoading();
      beginCapture({ dtMs: 25, seed: 1 });
      let state = await stepCapture(3);
      expect(state.takeTime).toBe(0);
      expect(state.loading).toBe(true);
      release();
      state = await stepCapture(1);
      expect(state.takeTime).toBeCloseTo(0.025, 9);
    });

    it('seeds the world again on the first frame time moves in, whatever the held frames drew', async () => {
      const w = worldWithClock();
      const release = holdTimeForLoading();
      beginCapture({ dtMs: 25, seed: 77 });
      await stepCapture(2);
      rngNext(w); rngNext(w); // a system drawing while the hold is up — a count no replay can match
      release();
      await stepCapture(1);
      const ref = createWorld();
      seedRng(77, ref);
      expect(rngNext(w)).toBe(rngNext(ref));
      ref.destroy();
    });

    it('keeps journal events from BEFORE a scene load — the journal is per world', async () => {
      worldWithClock();
      registerFrameCallback('captureDriverEmit', () => emit('probe.tick', { w: 1 }), 1);
      onTestFinished(() => unregisterFrameCallback('captureDriverEmit'));
      initCaptureDriver('');
      beginCapture({ dtMs: 25, seed: 1 });
      await stepCapture(2);
      worldWithClock();
      await stepCapture(1);
      const api = (window as unknown as { __modokiCapture: { events: () => { step: number; type: string }[] } }).__modokiCapture;
      const probes = api.events().filter((e) => e.type === 'probe.tick');
      expect(probes.map((e) => e.step)).toEqual([0, 1, 2]);
    });

    it('keeps an event emitted BETWEEN steps — a click handler carries the previous frame\'s tick', async () => {
      worldWithClock();
      initCaptureDriver('');
      beginCapture({ dtMs: 25, seed: 1 });
      await stepCapture(2);
      emit('probe.between', null);   // outside any frame, like a DOM click's UI action
      await stepCapture(2);
      const api = (window as unknown as { __modokiCapture: { events: () => { step: number; type: string }[] } }).__modokiCapture;
      expect(api.events().filter((e) => e.type === 'probe.between').map((e) => e.step)).toEqual([2]);
    });

    it('drains the OLD world once more at a swap — its last events are not lost with it', async () => {
      const old = worldWithClock();
      initCaptureDriver('');
      beginCapture({ dtMs: 25, seed: 1 });
      await stepCapture(1);
      emit('probe.teardown', null, old);   // the old world's teardown, after its last step
      worldWithClock();
      await stepCapture(1);
      const api = (window as unknown as { __modokiCapture: { events: () => { type: string }[] } }).__modokiCapture;
      expect(api.events().some((e) => e.type === 'probe.teardown')).toBe(true);
    });

    it('sums UNSCALED time — a slow-mo stretch plays slowly in the video instead of shortening the take', async () => {
      const w = worldWithClock();
      setTimeScale(w, 0.5);
      beginCapture({ dtMs: 25, seed: 1 });
      const state = await stepCapture(4);
      expect(state.takeTime).toBeCloseTo(0.1, 9);
    });

    it('is NOT on screen before a scene has loaded — the gap before GameShell takes the hold', async () => {
      const w = worldWithClock();
      vi.spyOn(sceneManager, 'getCurrent').mockReturnValue(null);
      beginCapture({ dtMs: 25, seed: 5 });
      let state = await bootStepCapture();
      // No hold yet, but no scene either: still booting, so it stepped — and did NOT seed.
      expect(state.ready).toBe(false);
      expect(state.steps).toBe(1);
      rngNext(w);   // the boot world drawing before the scene exists
      vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ id: 1, path: '/assets/scenes/main.scene.json', state: 'active' } as never);
      state = await bootStepCapture();
      expect(state.ready).toBe(true);
      await stepCapture(1);   // the take's first timed frame: seeded here, whatever boot drew
      const ref = createWorld();
      seedRng(5, ref);
      expect(rngNext(w)).toBe(rngNext(ref));
      ref.destroy();
    });

    it('bootStep does not step once the game is on screen, even when the hold lets go DURING its settle', async () => {
      worldWithClock();
      const release = holdTimeForLoading();
      let pending = 1;
      win.__2d = { pool: { pendingInits: () => pending } };
      beginCapture({ dtMs: 25, seed: 1 });
      const boot = bootStepCapture();
      await new Promise((r) => setTimeout(r, 20));
      release();          // GameShell lets go from a raw rAF wait, mid-settle
      pending = 0;
      const state = await boot;
      expect(state.ready).toBe(true);
      expect(state.steps).toBe(0);      // the first timed frame is still the take's
      expect(state.takeTime).toBe(0);
    });
  });

  it('gives up on a pending set ONCE — a permanently stuck init must not cost the timeout on every step', async () => {
    win.__2d = { pool: { pendingInits: () => 1 } };
    beginCapture({ dtMs: 40, seed: 1, settleTimeoutMs: 60 });
    const t = performance.now();
    await stepCapture(5);
    // One timeout, then the same pending set no longer blocks.
    expect(performance.now() - t).toBeLessThan(60 * 3);
    expect(runs).toBe(5);
  });

  it('a stuck set that SHRINKS stays given up, and the give-up is reported once, not every frame', async () => {
    let inits = 2;
    win.__2d = { pool: { pendingInits: () => inits } };
    initCaptureDriver('');
    beginCapture({ dtMs: 40, seed: 1, settleTimeoutMs: 30 });
    await stepCapture(1);          // gives up on 2 inits
    inits = 1;                     // one of them finishes; the other stays stuck
    const t = performance.now();
    await stepCapture(3);
    expect(performance.now() - t).toBeLessThan(30);
    const api = (window as unknown as { __modokiCapture: { unsettled: () => unknown[] } }).__modokiCapture;
    expect(api.unsettled()).toEqual([{ step: 0, pending: ['2 2D surface init'] }]);
  });

  it('a give-up DURING BOOT is reported — the latch would hide it from every later step', async () => {
    win.__2d = { pool: { pendingInits: () => 1 } };   // stuck from boot onward
    initCaptureDriver('');
    beginCapture({ dtMs: 40, seed: 1, settleTimeoutMs: 30 });
    await bootStepCapture();
    await stepCapture(3);
    const api = (window as unknown as { __modokiCapture: { unsettled: () => unknown[]; givenUp: () => string[] } }).__modokiCapture;
    expect(api.unsettled()).toEqual([{ step: 0, pending: ['1 2D surface init'] }]);
    expect(api.givenUp()).toEqual(['1 2D surface init']);
  });

  it('waits out a scene load in flight — a mid-take load costs the same take time on every render', async () => {
    let loading = true;
    const spy = vi.spyOn(sceneManager, 'getNext').mockImplementation(() => (loading ? ({ id: 2, path: '/b.scene.json', state: 'loading' } as never) : null));
    onTestFinished(() => spy.mockRestore());
    beginCapture({ dtMs: 40, seed: 1 });
    const step = stepCapture(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(runs).toBe(0);
    loading = false;
    await step;
    expect(runs).toBe(1);
  });

  it('a NEW pending item after giving up still blocks', async () => {
    let inits = 1;
    let images = 0;
    win.__2d = { pool: { pendingInits: () => inits + images } };
    beginCapture({ dtMs: 40, seed: 1, settleTimeoutMs: 30 });
    await stepCapture(1);           // gives up on "1 2D surface init(s)"
    images = 1;                     // now "2 …" — a different set
    const step = stepCapture(1);
    await new Promise((r) => setTimeout(r, 15));
    expect(runs).toBe(1);
    inits = 0; images = 0;
    await step;
    expect(runs).toBe(2);
  });
});
