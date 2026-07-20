/** Seeded RNG service (Phase 2 — verification harness). */

import { describe, it, expect } from 'vitest';
import { createWorld } from 'koota';
import { seedRng, rngNext, rngFloat, rngInt, rngBool, rngPick } from '../../src/runtime/systems/rng';

describe('rng', () => {
  it('is reproducible — same seed produces the same sequence', () => {
    seedRng(42);
    const a = [rngNext(), rngNext(), rngNext(), rngNext()];
    seedRng(42);
    const b = [rngNext(), rngNext(), rngNext(), rngNext()];
    expect(a).toEqual(b);
  });

  it('different seeds produce different sequences', () => {
    seedRng(1);
    const a = [rngNext(), rngNext(), rngNext()];
    seedRng(2);
    const b = [rngNext(), rngNext(), rngNext()];
    expect(a).not.toEqual(b);
  });

  it('rngNext stays in [0, 1)', () => {
    seedRng(7);
    for (let i = 0; i < 1000; i++) {
      const x = rngNext();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('rngInt is inclusive on both ends and reproducible', () => {
    seedRng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const n = rngInt(1, 6);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(6);
      expect(Number.isInteger(n)).toBe(true);
      seen.add(n);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]); // covers the full inclusive range
  });

  it('rngFloat stays within [min, max)', () => {
    seedRng(3);
    for (let i = 0; i < 1000; i++) {
      const x = rngFloat(-5, 5);
      expect(x).toBeGreaterThanOrEqual(-5);
      expect(x).toBeLessThan(5);
    }
  });

  it('rngBool(p) roughly honors the probability', () => {
    seedRng(123);
    let trues = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) if (rngBool(0.3)) trues++;
    expect(trues / N).toBeCloseTo(0.3, 1); // within ~0.05
  });

  it('rngPick returns an element (or undefined when empty) and is reproducible', () => {
    const arr = ['a', 'b', 'c', 'd'];
    seedRng(55);
    const a = [rngPick(arr), rngPick(arr), rngPick(arr)];
    a.forEach((x) => expect(arr).toContain(x));
    seedRng(55);
    const b = [rngPick(arr), rngPick(arr), rngPick(arr)];
    expect(a).toEqual(b);
    expect(rngPick([])).toBeUndefined();
  });

  // Missing Test #1 (determinism-harness F1): RNG state is world-scoped, so two
  // coexisting worlds draw from independent sequences — world A is unaffected by
  // any draws made against world B (would FAIL with the old module-global state).
  it('is isolated per world — draws on world B do not perturb world A', () => {
    const a = createWorld();
    const b = createWorld();
    seedRng(7, a);
    seedRng(7, b);

    // Baseline: A and B seeded identically produce the same sequence in isolation.
    const aSolo = [rngNext(a), rngNext(a), rngNext(a)];

    // Re-seed A, then interleave a bunch of draws on B between A's draws. With
    // world-scoped state, B's draws must NOT advance A's generator.
    seedRng(7, a);
    const aInterleaved: number[] = [];
    for (let i = 0; i < 3; i++) {
      rngInt(0, 1000, b);
      rngFloat(-1, 1, b);
      rngBool(0.5, b);
      aInterleaved.push(rngNext(a));
    }
    expect(aInterleaved).toEqual(aSolo);

    // And A draws don't perturb B either: B continues its own stream.
    seedRng(99, b);
    const bSolo = [rngNext(b), rngNext(b)];
    seedRng(99, b);
    rngNext(a); rngNext(a);
    const bAfterAdraws = [rngNext(b), rngNext(b)];
    expect(bAfterAdraws).toEqual(bSolo);
  });
});
