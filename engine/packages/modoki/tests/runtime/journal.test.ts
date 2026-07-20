/** Event journal (Phase 3 — verification harness). */

import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld, type Entity } from 'koota';
import {
  emit, entityRef, journalEvents, drainJournal, clearJournal, setJournalTick, setJournalEnabled,
  _resetCaptureSeq,
} from '../../src/runtime/systems/journal';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { createTestWorld } from '../../src/runtime/harness/createTestWorld';

beforeEach(() => {
  clearJournal();
  setJournalEnabled(true);
  setJournalTick(0);
  _resetCaptureSeq();
});

describe('journal', () => {
  it('records events in order with payloads', () => {
    emit('match', { color: 'red', count: 3 });
    emit('score', { delta: 30, total: 30 });
    const evs = journalEvents();
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ type: 'match', payload: { color: 'red', count: 3 } });
    expect(evs[1]).toMatchObject({ type: 'score', payload: { delta: 30, total: 30 } });
  });

  it('stamps the current tick', () => {
    setJournalTick(5);
    emit('spawn');
    setJournalTick(9);
    emit('win');
    expect(journalEvents().map((e) => e.tick)).toEqual([5, 9]);
  });

  it('stamps a monotonic shared capture counter (cap) on each event (Percept V3)', () => {
    emit('a'); emit('b'); emit('c');
    expect(journalEvents().map((e) => e.cap)).toEqual([1, 2, 3]);
  });

  it('filters by type', () => {
    emit('match'); emit('score'); emit('match'); emit('win');
    expect(journalEvents({ type: 'match' })).toHaveLength(2);
    expect(journalEvents({ type: 'win' })).toHaveLength(1);
    expect(journalEvents({ type: 'nope' })).toHaveLength(0);
  });

  it('drain returns all and clears', () => {
    emit('a'); emit('b');
    const drained = drainJournal();
    expect(drained.map((e) => e.type)).toEqual(['a', 'b']);
    expect(journalEvents()).toHaveLength(0);
  });

  it('clear empties the buffer', () => {
    emit('a');
    clearJournal();
    expect(journalEvents()).toHaveLength(0);
  });

  it('records nothing while disabled', () => {
    setJournalEnabled(false);
    emit('ignored');
    expect(journalEvents()).toHaveLength(0);
    setJournalEnabled(true);
  });

  it('journalEvents returns a copy (mutating it does not corrupt the buffer)', () => {
    emit('a');
    const snap = journalEvents();
    snap.push({ tick: 99, type: 'injected', cap: 0 });
    expect(journalEvents()).toHaveLength(1);
  });

  // F2 — drop-oldest ring behavior, now via a head index (no per-emit O(n) shift).
  // Emit well past 2×MAX so the periodic compaction path (_head reset) is exercised.
  it('caps at MAX_EVENTS, dropping oldest in order, across the compaction boundary', () => {
    const MAX = 10_000;
    const N = 25_000; // > 2·MAX → forces at least one compaction
    for (let i = 0; i < N; i++) emit('e', { i });

    const evs = journalEvents();
    expect(evs).toHaveLength(MAX);
    // Oldest retained is i = N - MAX; newest is N - 1; strictly increasing (order kept).
    expect((evs[0].payload as { i: number }).i).toBe(N - MAX);
    expect((evs[evs.length - 1].payload as { i: number }).i).toBe(N - 1);
    for (let k = 1; k < evs.length; k++) {
      expect((evs[k].payload as { i: number }).i).toBe((evs[k - 1].payload as { i: number }).i + 1);
    }

    // drain after wrap returns exactly the live window and clears.
    const drained = drainJournal();
    expect(drained).toHaveLength(MAX);
    expect(journalEvents()).toHaveLength(0);
  });

  // Missing Test #1 (determinism-harness F1): the trace + tick are world-scoped,
  // so two coexisting worlds keep SEPARATE, independently-ticked traces instead of
  // interleaving (would FAIL with the old module-global buffer).
  it('keeps a separate, independently-ticked trace per world', () => {
    const a = createWorld();
    const b = createWorld();

    setJournalTick(3, a);
    emit('a-match', { n: 1 }, a);
    setJournalTick(7, b);
    emit('b-spawn', { n: 2 }, b);
    setJournalTick(4, a);
    emit('a-score', { n: 3 }, a);

    const aEvs = journalEvents(undefined, a);
    const bEvs = journalEvents(undefined, b);

    // World A sees only its own events, stamped with A's ticks.
    expect(aEvs.map((e) => e.type)).toEqual(['a-match', 'a-score']);
    expect(aEvs.map((e) => e.tick)).toEqual([3, 4]);
    // World B sees only its own event, stamped with B's tick — B's tick=7 did not
    // bleed into A's a-score, and A's emits did not appear under B.
    expect(bEvs.map((e) => e.type)).toEqual(['b-spawn']);
    expect(bEvs.map((e) => e.tick)).toEqual([7]);

    // Clearing one world leaves the other intact.
    clearJournal(a);
    expect(journalEvents(undefined, a)).toHaveLength(0);
    expect(journalEvents(undefined, b)).toHaveLength(1);
  });
});

// J2 (Percept identity) — entityRef() gives an entity a stable GUID reference so a
// journal entry survives scene hot-reloads (runtime ids churn). Conversion is
// EXPLICIT (at the call site), never auto-applied to payloads — see the regression
// test below for why.
describe('journal — entityRef()', () => {
  it('returns the entity GUID when it has one', () => {
    const w = createWorld();
    const e = w.spawn(EntityAttributes({ guid: 'ball-guid', name: 'Ball' }));
    expect(entityRef(e)).toBe('ball-guid');
  });

  it('falls back to the numeric id for an un-guidable (fresh) entity', () => {
    const w = createWorld();
    const e = w.spawn(EntityAttributes({ name: 'fresh' })); // guid ''
    expect(entityRef(e)).toBe(e.id());
  });

  it('composes into a payload the caller builds', () => {
    const w = createWorld();
    const a = w.spawn(EntityAttributes({ guid: 'a' }));
    const b = w.spawn(EntityAttributes({ guid: 'b' }));
    emit('pair', { bodies: [entityRef(a), entityRef(b)] }, w);
    expect(journalEvents(undefined, w)[0].payload).toEqual({ bodies: ['a', 'b'] });
  });
});

// REGRESSION (review Phase 1) — emit() must NEVER auto-probe payload values. koota
// entities are primitive numbers sharing Number.prototype, so a scalar payload
// value is indistinguishable from an entity handle; an earlier "auto-convert any
// Entity in the payload" implementation silently rewrote scalars that collided
// with a live entity index into that entity's GUID. emit() must store payloads
// verbatim; only entityRef() (called explicitly) converts.
describe('journal — emit() stores payloads verbatim (no auto entity probing)', () => {
  it('does NOT convert scalar numbers even when a live entity shares that value', () => {
    const w = createWorld();
    // Populate the world so low entity indices exist and bear EntityAttributes —
    // the exact condition that used to trigger the mis-conversion.
    const ents: Entity[] = [];
    for (let i = 0; i < 64; i++) ents.push(w.spawn(EntityAttributes({ guid: `e${i}` })));
    const collidingScalar = ents[5].id(); // a plain number equal to a live entity id
    emit('score', { points: collidingScalar, count: 3 }, w);
    expect(journalEvents(undefined, w)[0].payload).toEqual({ points: collidingScalar, count: 3 });
  });

  it('stores the payload object by reference (no deep copy / walk)', () => {
    const w = createWorld();
    const payload = { a: 1, nested: { b: 2 } };
    emit('e', payload, w);
    expect(journalEvents(undefined, w)[0].payload).toBe(payload);
  });
});

// J2 (Percept ergonomics) — ctx.emit on the action context records to the action's
// bound world (no wrong-world in async callbacks); entityRef stays the caller's job.
describe('journal — ctx.emit (action context)', () => {
  it('records to the action-bound world, converting entities via entityRef', () => {
    let ball: Entity | undefined;
    const tw = createTestWorld({
      actions: { hit: (ctx) => ctx.emit('hit', { body: ball ? entityRef(ball) : undefined }) },
    });
    try {
      ball = tw.spawn(EntityAttributes({ guid: 'ball-guid', name: 'Ball' }));
      tw.dispatch('hit');
      const evs = tw.events({ type: 'hit' });
      expect(evs).toHaveLength(1);
      expect(evs[0].payload).toEqual({ body: 'ball-guid' });
    } finally {
      tw.dispose();
    }
  });
});
