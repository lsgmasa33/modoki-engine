import { describe, it, expect } from 'vitest';
import { expectInOrder, found } from './inOrder';

describe('found (#1181)', () => {
  it('returns a real position, including 0', () => {
    expect(found(0, 'x')).toBe(0);
    expect(found(7, 'x')).toBe(7);
  });

  it('refuses -1, any negative and NaN, naming what is missing', () => {
    expect(() => found(-1, 'the setPath call')).toThrow(/the setPath call is not present/);
    expect(() => found(-5, 'x')).toThrow(/not present/);
    expect(() => found(Number.NaN, 'x')).toThrow(/not present/);
  });
});

describe('expectInOrder (#1181)', () => {
  it('accepts needles in order, in a string and in a list', () => {
    expectInOrder('a then b then c', ['a', 'b', 'c']);
    expectInOrder(['enter', 'stay', 'exit'], ['enter', 'exit']);
    expectInOrder([200, 201], [200, 201]);
  });

  it('refuses a missing FIRST needle, which a raw indexOf comparison passes', () => {
    // The defect: `-1 < indexOf('exit')`.
    expect('x'.indexOf('enter')).toBe(-1);
    expect(-1 < 'enter exit'.indexOf('exit')).toBe(true);
    expect(() => expectInOrder(['stay', 'exit'], ['enter', 'exit'], 'fired')).toThrow(/fired\): not present: "enter"/);
  });

  it('refuses a missing later needle, and names every missing one', () => {
    expect(() => expectInOrder('a b', ['a', 'z'])).toThrow(/not present: "z"$/);
    expect(() => expectInOrder('b', ['a', 'b', 'c'])).toThrow(/not present: "a", "c"/);
  });

  it('reports absence before order, so a missing needle is not misreported as out of order', () => {
    expect(() => expectInOrder('b a', ['a', 'b', 'missing'])).toThrow(/not present: "missing"/);
  });

  it('refuses out of order, and equal positions', () => {
    expect(() => expectInOrder('b a', ['a', 'b'])).toThrow(/"a" \(at 2\) must come before "b" \(at 0\)/);
    expect(() => expectInOrder('ab', ['ab', 'a'])).toThrow(/must come before/);
  });

  it('refuses fewer than two needles and a non-string needle in a string', () => {
    expect(() => expectInOrder('a', ['a'])).toThrow(/at least two/);
    expect(() => expectInOrder('1 2', [1, 2])).toThrow(/string needles/);
  });

  it('refuses an empty-string needle, which indexOf finds at 0 in any string', () => {
    // A computed needle that came out '' would read as present-and-first, reopening the hole.
    expect(() => expectInOrder('a x', ['', 'x'])).toThrow(/empty needle/);
  });
});
