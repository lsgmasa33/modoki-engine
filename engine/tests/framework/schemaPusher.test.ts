/** #459: game traits register before engine traits (deterministic order — see
 *  `engine/app/editor/setup.ts` step 3 vs 4), with an AWAITED dynamic import in the
 *  gap for a game's `editorPanels()` hook. `buildSceneSchema()` can therefore be
 *  non-empty (game traits only) well before it is COMPLETE (engine traits too).
 *  `makeSchemaPusher` must keep polling for its full tick budget and send every
 *  time the trait SET changes — it must NOT stop early on a settle heuristic,
 *  because a settle window that is shorter than a cold dynamic import serves the
 *  incomplete schema for the rest of the session (the #459 report). Uses a fake,
 *  manually-driven timer — no real time, no renderer, per the repo's determinism
 *  rules. */

import { describe, it, expect, vi } from 'vitest';
import { makeSchemaPusher } from '../../app/debug/schemaPusher';
import type { SceneSchema } from '@modoki/engine/runtime';

function schemaWith(names: string[]): SceneSchema {
  const traits: SceneSchema['traits'] = {};
  for (const n of names) traits[n] = { category: 'component', fields: {} };
  return { traits };
}

/** A manually-stepped fake timer: `scheduleTimer` records the pending callback
 *  instead of using `setTimeout`, and `flush()` runs pending callbacks until
 *  none remain (each tick may schedule the next one). */
function makeFakeTimer() {
  let pending: (() => void) | undefined;
  const scheduleTimer = (fn: () => void, _ms: number) => { pending = fn; };
  const flush = (maxSteps = 1000) => {
    let steps = 0;
    while (pending && steps++ < maxSteps) {
      const fn = pending;
      pending = undefined;
      fn();
    }
  };
  const hasPending = () => pending !== undefined;
  return { scheduleTimer, flush, hasPending };
}

describe('makeSchemaPusher', () => {
  it('reports the missing-trait bug: sends the partial 8-trait set, then the complete 83-trait set', () => {
    const { scheduleTimer, flush } = makeFakeTimer();
    const sent: SceneSchema[] = [];
    let tick = 0;
    const buildSchema = (): SceneSchema => {
      tick += 1;
      if (tick === 1) return schemaWith(Array.from({ length: 8 }, (_, i) => `sling${i}`));
      // Stays at 83 from tick 2 onward, like the real registry settling.
      return schemaWith(Array.from({ length: 83 }, (_, i) => `engine${i}`));
    };
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, maxTicks: 40 });
    pusher.start();
    flush();

    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(sent[0].traits).length).toBe(8);
    const final = sent[sent.length - 1];
    expect(Object.keys(final.traits).length).toBe(83);
  });

  /** The #459 scenario itself: the trait set doesn't stabilize until WELL into the tick
   *  budget (tick 20 of 40) — a settle-after-N-unchanged-ticks heuristic with a short
   *  window would have declared victory on the partial set long before this and never
   *  seen the complete one. There is no settle window any more, so this must pass. */
  it('a change arriving LATE in the tick budget is still sent (the #459 scenario)', () => {
    const { scheduleTimer, flush } = makeFakeTimer();
    const sent: SceneSchema[] = [];
    let tick = 0;
    const buildSchema = (): SceneSchema => {
      tick += 1;
      if (tick < 20) return schemaWith(['sling0', 'sling1']);
      return schemaWith(Array.from({ length: 83 }, (_, i) => `engine${i}`));
    };
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, maxTicks: 40 });
    pusher.start();
    flush();

    expect(sent.length).toBeGreaterThanOrEqual(2);
    const final = sent[sent.length - 1];
    expect(Object.keys(final.traits).length).toBe(83);
  });

  it('never sends while the registry is empty, and sends once it becomes non-empty', () => {
    const { scheduleTimer, flush } = makeFakeTimer();
    const sent: SceneSchema[] = [];
    let tick = 0;
    const buildSchema = (): SceneSchema => {
      tick += 1;
      return tick < 3 ? schemaWith([]) : schemaWith(['Transform']);
    };
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, maxTicks: 40 });
    pusher.start();
    flush();

    expect(sent.length).toBe(1);
    expect(Object.keys(sent[0].traits)).toEqual(['Transform']);
  });

  it('sends an unchanged registry exactly once, not once per tick', () => {
    const { scheduleTimer, flush } = makeFakeTimer();
    const sent: SceneSchema[] = [];
    const buildSchema = (): SceneSchema => schemaWith(['Transform', 'Sprite2D']);
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, maxTicks: 40 });
    pusher.start();
    flush();

    expect(sent.length).toBe(1);
  });

  it('polls for the full tick budget even once something has been sent — no early settle', () => {
    const { scheduleTimer, flush } = makeFakeTimer();
    const sent: SceneSchema[] = [];
    let builds = 0;
    const buildSchema = (): SceneSchema => { builds += 1; return schemaWith(['Transform']); };
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, maxTicks: 40 });
    pusher.start();
    flush();

    expect(sent.length).toBe(1);
    // maxTicks=40: the loop keeps building/checking every tick of the budget (~41-42 builds),
    // it just doesn't RESEND an unchanged signature. The old settle logic stopped after ~6.
    expect(builds).toBeGreaterThan(35);
  });

  it('a throwing builder does not kill the loop, and a later successful tick still sends', () => {
    const { scheduleTimer, flush } = makeFakeTimer();
    const sent: SceneSchema[] = [];
    let tick = 0;
    const buildSchema = (): SceneSchema => {
      tick += 1;
      if (tick <= 3) throw new Error('registry not ready');
      return schemaWith(['Transform']);
    };
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, maxTicks: 40 });
    pusher.start();
    flush();

    expect(sent.length).toBe(1);
    expect(Object.keys(sent[0].traits)).toEqual(['Transform']);
  });

  it('the tick budget bounds the loop when the registry stays non-empty... but unsendable never happens; instead bounds an empty registry via hardMaxTicks', () => {
    const { scheduleTimer, flush, hasPending } = makeFakeTimer();
    const sent: SceneSchema[] = [];
    let ticks = 0;
    const buildSchema = (): SceneSchema => { ticks += 1; return schemaWith([]); };
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, maxTicks: 40, hardMaxTicks: 150 });
    pusher.start();
    flush();

    expect(sent.length).toBe(0);
    expect(hasPending()).toBe(false);
    // Nothing was ever sent, so the normal 40-tick budget extends to hardMaxTicks=150 before
    // the loop finally gives up.
    expect(ticks).toBeLessThanOrEqual(152);
    expect(ticks).toBeGreaterThan(140);
  });

  /** The never-published edge (Task 1): registration itself is slow enough that nothing has
   *  been sent by the normal `maxTicks` budget. Instead of giving up (leaving `list_traits`
   *  reporting `schemaAvailable:false` for the rest of the session), the loop extends to
   *  `hardMaxTicks` and keeps trying. */
  it('extends past maxTicks to hardMaxTicks when nothing has EVER been sent, and sends once ready', () => {
    const { scheduleTimer, flush, hasPending } = makeFakeTimer();
    const sent: SceneSchema[] = [];
    let tick = 0;
    const buildSchema = (): SceneSchema => {
      tick += 1;
      // Stays empty well past the normal 40-tick budget, becomes ready at tick 60.
      return tick < 60 ? schemaWith([]) : schemaWith(['Transform']);
    };
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, maxTicks: 40, hardMaxTicks: 150 });
    pusher.start();
    flush();

    expect(sent.length).toBe(1);
    expect(Object.keys(sent[0].traits)).toEqual(['Transform']);
    expect(hasPending()).toBe(false);
  });

  it('pushOnce sends directly and reports whether it sent', () => {
    const sent: SceneSchema[] = [];
    let tick = 0;
    const buildSchema = (): SceneSchema => { tick += 1; return tick === 1 ? schemaWith([]) : schemaWith(['Transform']); };
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer: vi.fn() });
    expect(pusher.pushOnce()).toBe(false); // empty
    expect(pusher.pushOnce()).toBe(true); // non-empty, new signature
    expect(pusher.pushOnce()).toBe(false); // unchanged — no-op
    expect(sent.length).toBe(1);
  });

  it('start({force:true}) re-sends an unchanged trait set; a plain start() does not', () => {
    const { scheduleTimer, flush } = makeFakeTimer();
    const sent: SceneSchema[] = [];
    const buildSchema = (): SceneSchema => schemaWith(['Transform', 'Camera']);
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, maxTicks: 40 });

    pusher.start();
    flush();
    expect(sent).toHaveLength(1);

    pusher.start();
    flush();
    expect(sent, 'a plain start() over an unchanged trait set must not re-send').toHaveLength(1);

    pusher.start({ force: true });
    flush();
    expect(sent, 'start({force:true}) must re-send even though the trait set is unchanged').toHaveLength(2);
  });

  it('start() with no arguments still works (both real call sites use it)', () => {
    const { scheduleTimer, flush } = makeFakeTimer();
    const sent: SceneSchema[] = [];
    const buildSchema = (): SceneSchema => schemaWith(['Transform']);
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, maxTicks: 40 });
    expect(() => pusher.start()).not.toThrow();
    flush();
    expect(sent).toHaveLength(1);
  });

  /** Regression: `start()` is wired to both `vite:afterUpdate` and `vite:ws:connect`, so a
   *  re-arm happens routinely. `start()` does not cancel an in-flight chain, so without a
   *  generation guard a re-arm during a poll leaves TWO chains polling, and they accumulate
   *  per update. */
  it('a re-arm SUPERSEDES the running chain — never two callbacks pending at once', () => {
    const queue: (() => void)[] = [];
    let maxDepth = 0;
    const scheduleTimer = (fn: () => void, _ms: number) => {
      queue.push(fn);
      maxDepth = Math.max(maxDepth, queue.length);
    };
    const buildSchema = () => schemaWith(['Transform']);
    const pusher = makeSchemaPusher(() => {}, { buildSchema, scheduleTimer, maxTicks: 40 });

    pusher.start();          // chain A armed, one tick pending
    expect(queue).toHaveLength(1);
    pusher.start();          // chain B armed — A must be dead, not running alongside
    // Two pending here is EXPECTED and not the bug: the guard makes a superseded callback
    // inert when it FIRES, it cannot reach into the queue and remove it. The bug is whether
    // the dead chain keeps RE-SCHEDULING, so measure the steady state during the drain.
    maxDepth = 0;

    let steps = 0;
    while (queue.length && steps++ < 500) queue.shift()!();

    expect(maxDepth, 'a superseded chain that keeps rescheduling holds the queue at two')
      .toBeLessThanOrEqual(1);
    expect(queue).toHaveLength(0);
  });

  describe('shipped defaults', () => {
    /** Both real call sites (`agentBridge.ts`'s bridge pusher and its Vite HMR pusher) call
     *  `makeSchemaPusher` with NO options — every other test here passes `maxTicks`/`buildSchema`
     *  explicitly, so editing a default (e.g. `intervalMs`) would keep the whole suite green while
     *  materially changing shipped behaviour. This drives a chain with only the injected
     *  builder/timer and asserts the actual shipped budget and interval. */
    it('ships intervalMs=200, maxTicks=40, hardMaxTicks=150', () => {
      const seenIntervals: number[] = [];
      const queue: (() => void)[] = [];
      const scheduleTimer = (fn: () => void, ms: number) => { seenIntervals.push(ms); queue.push(fn); };
      let ticks = 0;
      const buildSchema = () => { ticks += 1; return schemaWith([]); }; // stays empty forever

      const pusher = makeSchemaPusher(() => {}, { buildSchema, scheduleTimer });
      pusher.start();
      let steps = 0;
      while (queue.length && steps++ < 1000) queue.shift()!();

      expect(new Set(seenIntervals)).toEqual(new Set([200]));
      // Nothing was ever sent, so this exercises the hardMaxTicks=150 extension, not maxTicks=40.
      expect(ticks).toBeLessThanOrEqual(152);
      expect(ticks).toBeGreaterThan(140);
    });
  });
});
