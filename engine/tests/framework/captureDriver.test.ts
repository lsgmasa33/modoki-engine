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
  emit, sceneManager, setTimeScale, appLifetimeEvent,
} from '@modoki/engine/runtime';
import type { World } from 'koota';
import { beginCapture, stepCapture, bootStepCapture, endCapture, initCaptureDriver } from '../../app/debug/captureDriver';
import { frameCountFor, TakeCursor } from '../../packages/modoki/src/editor/recorder/take';

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

  it('reports the event types the page declared app-lifetime, for the replay check to skip (#1524)', () => {
    expect(appLifetimeEvent('probe.boot-once')).toBe('probe.boot-once');
    initCaptureDriver('?scene=main');
    const api = (window as unknown as { __modokiCapture: { appLifetimeTypes: () => string[] } }).__modokiCapture;
    expect(api.appLifetimeTypes()).toContain('probe.boot-once');
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

    type HeldLoad = { start(): void; release(): void; load: Promise<unknown> | null };
    const emptyScene = () => ({ preloaded: { version: 8, resources: [], entities: [] } as never });
    /** A REAL scene load from '/a' to '/b', held open at the swap by a before-swap hook until
     *  `release()` — a stubbed getNext() would not prove it is SceneManager that tells the take clock
     *  a load is in flight. The load is released and settled in `finally`, INSIDE the test: the
     *  describe's afterEach restores the previous world, and onTestFinished runs after it — a swap
     *  landing on the world afterEach put back fails the NEXT test instead of this one. */
    async function withHeldLoad(body: (h: HeldLoad) => Promise<void>): Promise<void> {
      await sceneManager.loadScene('/a.scene.json', emptyScene());
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const hook = () => held;
      sceneManager.registerBeforeSwap(hook);
      const h: HeldLoad = { release, load: null, start() { h.load ??= sceneManager.loadScene('/b.scene.json', emptyScene()); } };
      try {
        await body(h);
      } finally {
        release();
        await h.load;
        sceneManager.unregisterBeforeSwap(hook);
        unregisterFrameCallback('captureDriverLoad');
      }
    }

    it('a mid-take scene load costs zero take time, yet every timed step is still one dt (#1486)', () => withHeldLoad(async (h) => {
      let startLoad = false;
      registerFrameCallback('captureDriverLoad', () => { if (startLoad) h.start(); }, 0);
      beginCapture({ dtMs: 25, seed: 1 });
      expect((await stepCapture(1)).takeTime).toBeCloseTo(0.025, 9);
      // This step's own frame starts the load. It is a timed frame on both halves — the load was
      // not in flight when it began — so it counts its dt, exactly as the editor's does.
      startLoad = true;
      expect((await stepCapture(1)).takeTime).toBeCloseTo(0.05, 9);
      expect(sceneManager.getNext()).not.toBeNull();
      const next = stepCapture(1);
      await new Promise((r) => setTimeout(r, 40));
      expect(runs).toBe(2);   // the settle gate is waiting the load out
      h.release();
      await h.load;
      // N timed steps are N dt, load or no load: the CLI renders `frameCountFor` frames on exactly
      // that promise, and a step that added zero left the take's last dt of input undispatched.
      expect((await next).takeTime).toBeCloseTo(0.075, 9);
    }));

    it('a take with a mid-take load still dispatches its closing event — the CLI loop, driven for real (#1486)', () => withHeldLoad(async (h) => {
      // record-take.mjs's own loop: dispatch what is due, then step, for exactly frameCountFor frames.
      // Found by review: with the load-start frame counting zero, the last frame's dispatch fell one
      // dt short of `duration`, and the closing `up` (stamped AT duration) never went in.
      h.release();   // not held: the settle gate waits the load out on its own
      let startLoad = false;
      registerFrameCallback('captureDriverLoad', () => { if (startLoad) h.start(); }, 0);
      const take = { duration: 0.1, events: [
        { t: 0.075, kind: 'down' as const, x: 1, y: 1 },
        { t: 0.1, kind: 'up' as const, x: 1, y: 1 },
      ] };
      const cursor = new TakeCursor(take.events);
      const dispatched: string[] = [];
      beginCapture({ dtMs: 25, seed: 1 });
      let takeTime = 0;
      const total = frameCountFor(take, 40);
      for (let f = 0; f < total; f++) {
        for (const ev of cursor.due(takeTime)) dispatched.push(ev.kind);
        if (f === 1) startLoad = true;
        takeTime = (await stepCapture(1)).takeTime;
      }
      expect(h.load).not.toBeNull();
      expect(dispatched).toEqual(['down', 'up']);
      expect(cursor.remaining).toBe(0);
    }));

    it('waits out a load a continuation starts inside the settle gate\'s last macrotask (#1486)', () => withHeldLoad(async (h) => {
      // Found by review: the gate awaited one more macrotask and went ahead without looking again,
      // so a load started there was unseen — the step's frame began mid-load and added zero, with
      // nothing in `unsettled`. A timer queued from a frame fires first inside that macrotask. Held
      // for 50 ms: an empty preloaded load otherwise finishes within microtasks, before the step
      // runs, and the gap never opens (this test was inert without the hold).
      let queueLoad = false;
      registerFrameCallback('captureDriverLoad', () => {
        if (!queueLoad) return;
        queueLoad = false;
        setTimeout(() => { h.start(); setTimeout(h.release, 50); }, 0);
      }, 0);
      beginCapture({ dtMs: 25, seed: 1 });
      await stepCapture(1);
      queueLoad = true;
      await stepCapture(1);
      const state = await stepCapture(1);
      expect(h.load).not.toBeNull();
      expect(state.unsettled).toBe(0);
      expect(state.takeTime).toBeCloseTo(0.075, 9);
    }));

    it('a step the settle gate lets past a stuck load adds no take time, and says so (#1486)', () => withHeldLoad(async (h) => {
      // The one path where the replay's own frame-start sample decides the answer: every other step
      // begins settled. The editor counts nothing for a frame that begins mid-load, so neither does
      // this — and the give-up is in `unsettled`, where the report can show it.
      let startLoad = false;
      registerFrameCallback('captureDriverLoad', () => { if (startLoad) h.start(); }, 0);
      beginCapture({ dtMs: 25, seed: 1, settleTimeoutMs: 30 });
      await stepCapture(1);
      startLoad = true;
      expect((await stepCapture(1)).takeTime).toBeCloseTo(0.05, 9);
      const state = await stepCapture(1);   // gives up on the held load and steps anyway
      expect(state.unsettled).toBe(1);
      expect(state.takeTime).toBeCloseTo(0.05, 9);
    }));

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
    initCaptureDriver('');
    beginCapture({ dtMs: 40, seed: 1, settleTimeoutMs: 60 });
    await stepCapture(5);
    // One timeout, then the same pending set no longer blocks. Counted by REPORTS, not wall clock:
    // every timeout pushes one `unsettled` entry, so a re-wait shows as a second one — a bound on
    // elapsed time went red on a loaded CI runner (47ms against a 30ms bound).
    const api = (window as unknown as { __modokiCapture: { unsettled: () => unknown[] } }).__modokiCapture;
    expect(api.unsettled()).toEqual([{ step: 0, pending: ['1 2D surface init'] }]);
    expect(runs).toBe(5);
  });

  it('a stuck set that SHRINKS stays given up, and the give-up is reported once, not every frame', async () => {
    let inits = 2;
    win.__2d = { pool: { pendingInits: () => inits } };
    initCaptureDriver('');
    beginCapture({ dtMs: 40, seed: 1, settleTimeoutMs: 30 });
    await stepCapture(1);          // gives up on 2 inits
    inits = 1;                     // one of them finishes; the other stays stuck
    await stepCapture(3);          // a re-wait on the shrunk set would time out and report again
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
