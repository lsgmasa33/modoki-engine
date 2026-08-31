/** #459: the trait registry is populated racily — engine traits and a game's own
 *  traits register independently, so `buildSceneSchema()` can be non-empty well
 *  before it is COMPLETE. `makeSchemaPusher` must keep polling while the trait
 *  SET is still changing and send every time it changes, not freeze on the first
 *  non-empty read. Uses a fake, manually-driven timer — no real time, no
 *  renderer, per the repo's determinism rules. */

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
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, settleTicks: 5, maxTicks: 40 });
    pusher.start();
    flush();

    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(sent[0].traits).length).toBe(8);
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
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, settleTicks: 5, maxTicks: 40 });
    pusher.start();
    flush();

    expect(sent.length).toBe(1);
    expect(Object.keys(sent[0].traits)).toEqual(['Transform']);
  });

  it('sends an unchanged registry exactly once, not once per tick', () => {
    const { scheduleTimer, flush } = makeFakeTimer();
    const sent: SceneSchema[] = [];
    const buildSchema = (): SceneSchema => schemaWith(['Transform', 'Sprite2D']);
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, settleTicks: 5, maxTicks: 40 });
    pusher.start();
    flush();

    expect(sent.length).toBe(1);
  });

  it('stops polling after the settle window — no further sends once stable', () => {
    const { scheduleTimer, flush, hasPending } = makeFakeTimer();
    const sent: SceneSchema[] = [];
    const buildSchema = (): SceneSchema => schemaWith(['Transform']);
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, settleTicks: 5, maxTicks: 40 });
    pusher.start();
    flush();

    expect(hasPending()).toBe(false);
    expect(sent.length).toBe(1);
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
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, settleTicks: 5, maxTicks: 40 });
    pusher.start();
    flush();

    expect(sent.length).toBe(1);
    expect(Object.keys(sent[0].traits)).toEqual(['Transform']);
  });

  it('the tick budget bounds the loop when the registry stays empty forever', () => {
    const { scheduleTimer, flush, hasPending } = makeFakeTimer();
    const sent: SceneSchema[] = [];
    let ticks = 0;
    const buildSchema = (): SceneSchema => { ticks += 1; return schemaWith([]); };
    const pusher = makeSchemaPusher((s) => sent.push(s), { buildSchema, scheduleTimer, settleTicks: 5, maxTicks: 40 });
    pusher.start();
    flush();

    expect(sent.length).toBe(0);
    expect(hasPending()).toBe(false);
    // maxTicks=40: loop runs tries 0..40 inclusive of the check (`tries++ > 40`), i.e. 42 ticks.
    expect(ticks).toBeLessThanOrEqual(42);
    expect(ticks).toBeGreaterThan(35);
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

  /** Regression, found reviewing the #459 fix rather than from a report. `start()` is now
   *  wired to the Electron `scene-changed` hook AND was already on `vite:afterUpdate`, so a
   *  re-arm happens routinely. Gating the settle check on a per-run "did this run send"
   *  flag made an unchanged re-arm unable to ever settle: nothing to send, so the flag
   *  stayed false and it polled the ENTIRE tick budget every time. Settling on
   *  `lastSentSignature` instead makes a no-op re-arm cost one settle window. */
  it('a re-arm over an UNCHANGED registry settles quickly instead of burning the whole tick budget', () => {
    const { scheduleTimer, flush, hasPending } = makeFakeTimer();
    const sent: SceneSchema[] = [];
    let builds = 0;
    const buildSchema = () => { builds += 1; return schemaWith(['Transform', 'Camera']); };
    const pusher = makeSchemaPusher((s2) => sent.push(s2), { buildSchema, scheduleTimer, settleTicks: 5, maxTicks: 40 });

    pusher.start();
    flush();
    expect(sent).toHaveLength(1);
    expect(hasPending()).toBe(false);
    const buildsAfterFirst = builds;

    pusher.start();
    flush();
    expect(sent, 'an unchanged trait set must not be re-sent').toHaveLength(1);
    // Settle window is 5 ticks; the old flag-gated logic ran the full 40+ budget instead.
    expect(builds - buildsAfterFirst).toBeLessThanOrEqual(8);
    expect(hasPending()).toBe(false);
  });

  /** `start()` does not cancel an in-flight chain, so without a generation guard a re-arm
   *  during a settle window leaves TWO chains polling, and they accumulate per update.
   *
   *  ⚠️ Assert on CONCURRENT SCHEDULED CALLBACKS, not on the number of builds. The first
   *  version of this test counted builds and passed with the guard removed: both chains
   *  share `unchangedStreak`, so together they reach the settle threshold in the same total
   *  number of polls a single chain would. Only the queue depth distinguishes one chain
   *  from two. (Caught by mutation-checking this defect in isolation — the build-count
   *  version failed only when a DIFFERENT mutation was applied at the same time.) */
  it('a re-arm SUPERSEDES the running chain — never two callbacks pending at once', () => {
    const queue: (() => void)[] = [];
    let maxDepth = 0;
    const scheduleTimer = (fn: () => void, _ms: number) => {
      queue.push(fn);
      maxDepth = Math.max(maxDepth, queue.length);
    };
    const buildSchema = () => schemaWith(['Transform']);
    const pusher = makeSchemaPusher(() => {}, { buildSchema, scheduleTimer, settleTicks: 5, maxTicks: 40 });

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
});
