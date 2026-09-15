/** A compile holding `Scene3D`'s frames keeps the loading overlay up — within a bound (#1246).
 *
 *  Named for the two failures it sits between: an overlay that lifts over frames still held (the
 *  game then runs under an undrawn canvas — a 9.3 s cold scene-pass compile on an iPad mini 5 did
 *  exactly that), and an overlay a compile that never settles holds up forever. */
import { describe, it, expect } from 'vitest';
import { createHeldFramePaintWait } from '../../src/runtime/rendering/heldFramePaintWait';

function harness(stepMs = 5000, maxMs = 20_000) {
  let t = 0;
  const extends_: Array<{ at: number; ms: number }> = [];
  const exhausted: number[] = [];
  const wait = createHeldFramePaintWait({
    now: () => t,
    extend: (ms) => extends_.push({ at: t, ms }),
    stepMs,
    maxMs,
    onBudgetExhausted: (heldMs) => exhausted.push(heldMs),
  });
  return { wait, extends_, exhausted, advance: (ms: number) => { t += ms; } };
}

describe('heldFramePaintWait', () => {
  it('renews the overlay\'s wait on every held frame, so a hold longer than any one promise keeps it up', () => {
    const h = harness();
    for (let i = 0; i < 10; i++) { h.wait.held(); h.advance(1000); } // a 10 s hold, one frame a second
    expect(h.extends_.map((e) => e.at)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000]);
    expect(h.extends_.every((e) => e.ms === 5000)).toBe(true);
    expect(h.exhausted).toEqual([]);
  });

  it('never promises past the budget, then stops renewing and reports it ONCE — the overlay cannot stick', () => {
    const h = harness();
    for (let i = 0; i <= 24; i++) { h.wait.held(); h.advance(1000); } // held 0 … 24 s
    const last = h.extends_[h.extends_.length - 1];
    expect(last.at + last.ms).toBe(20_000); // the final promise ends exactly at the budget
    expect(h.extends_.every((e) => e.at < 20_000)).toBe(true);
    expect(h.exhausted).toEqual([20_000]);
  });

  it('a frame that was not held ends the hold — the next hold gets a fresh budget', () => {
    const h = harness();
    for (let i = 0; i <= 20; i++) { h.wait.held(); h.advance(1000); }
    expect(h.exhausted).toHaveLength(1);
    h.wait.released();
    h.extends_.length = 0;
    h.wait.held();
    expect(h.extends_).toEqual([{ at: 21_000, ms: 5000 }]);
  });

  it('a gap longer than one renewal starts a NEW hold — an idle-gated frame loop must not inherit an old hold\'s time', () => {
    const h = harness();
    h.wait.held();
    h.advance(19_000); // no frame for 19 s: the first renewal expired long ago
    h.wait.held();
    expect(h.extends_[1]).toEqual({ at: 19_000, ms: 5000 });
    expect(h.exhausted).toEqual([]);
  });
});
