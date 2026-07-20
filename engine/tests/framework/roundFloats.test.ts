/** Significant-digit rounding for agent-facing floats (docs/mcp-response-budget.md, float precision).
 *
 *  This is the ONE change in the payload work that alters what the data SAYS rather than how much
 *  of it you get. So the tests care about two things in equal measure: that it saves what it claims,
 *  and that the error it introduces is bounded and never lands where it would be a bug —
 *  specifically, that a small magnitude (a 1.5e-7 scale) is preserved rather than flattened to 0,
 *  which `toFixed(3)` would do. */

import { describe, it, expect } from 'vitest';
import { roundSig, roundFloats, resolvePrecision, DEFAULT_FLOAT_PRECISION } from '../../app/debug/roundFloats';

describe('roundSig', () => {
  it('trims the mantissa to N significant digits', () => {
    expect(roundSig(247.13061935179246, 9)).toBe(247.130619);
    expect(roundSig(-0.31536382659192896, 9)).toBe(-0.315363827);
    expect(roundSig(3.141592653589793, 9)).toBe(3.14159265);
  });

  it('preserves SMALL magnitudes exactly — the reason this is sig-digits, not decimals', () => {
    // toFixed(3) would report 0 for all three. A scale of 1.5e-7 collapsing to zero is a bug.
    expect(roundSig(1.5e-7, 9)).toBe(1.5e-7);
    expect(roundSig(0.0004321, 9)).toBe(0.0004321);
    expect(roundSig(-2.5e-12, 9)).toBe(-2.5e-12);
  });

  it('leaves integers, zero and -0 untouched', () => {
    expect(roundSig(0, 9)).toBe(0);
    expect(Object.is(roundSig(-0, 9), -0)).toBe(true);
    expect(roundSig(1, 9)).toBe(1);
    expect(roundSig(-42, 9)).toBe(-42);
    expect(roundSig(1e14, 9)).toBe(1e14);
  });

  it('does not throw on non-finite values', () => {
    expect(roundSig(NaN, 9)).toBeNaN();
    expect(roundSig(Infinity, 9)).toBe(Infinity);
  });

  it('precision 0 or >= 17 is the exact-fidelity escape hatch', () => {
    const x = 247.13061935179246;
    expect(roundSig(x, 0)).toBe(x);
    expect(roundSig(x, 17)).toBe(x);
    expect(roundSig(x, 99)).toBe(x);
  });

  it('the error stays inside the advertised bound (3.5e-7 abs on the reference data)', () => {
    const vals = [247.13061935179246, 199.72223393637603, -3.141592653589793, 679.0625, 623.49609375, 120.44999999999999];
    for (const v of vals) {
      const r = roundSig(v, 9);
      expect(Math.abs(r - v)).toBeLessThan(1e-6);
      expect(Math.abs((r - v) / v)).toBeLessThan(1e-8); // relative
    }
  });

  it('9 sig cleans float-representation noise rather than adding it', () => {
    expect(roundSig(120.44999999999999, 9)).toBe(120.45);
  });
});

describe('roundFloats — deep, and non-mutating', () => {
  it('walks objects and arrays', () => {
    const src = { a: 1.23456789012, xs: [0.111111111111, { b: -9.87654321098 }], s: 'x', t: true, n: null };
    expect(roundFloats(src, 9)).toEqual({
      a: 1.23456789, xs: [0.111111111, { b: -9.87654321 }], s: 'x', t: true, n: null,
    });
  });

  it('COPIES — the producer keeps its exact values (WatchTab renders those arrays)', () => {
    const live = { series: [{ samples: [{ tick: 1, value: 0.123456789012345 }] }] };
    const out = roundFloats(live, 9);
    expect(out.series[0].samples[0].value).toBe(0.123456789);
    // The source is untouched: rounding in place would degrade the human's sparkline.
    expect(live.series[0].samples[0].value).toBe(0.123456789012345);
    expect(out.series).not.toBe(live.series);
  });

  it('precision 0 short-circuits and returns the SAME reference (no needless copy)', () => {
    const src = { a: 1.23456789012 };
    expect(roundFloats(src, 0)).toBe(src);
  });

  it('does not rebuild exotic objects into {}', () => {
    class Rect { constructor(public x = 1.23456789012) {} }
    const src = { r: new Rect(), d: new Date(0) };
    const out = roundFloats(src, 9);
    expect(out.r).toBeInstanceOf(Rect);
    expect(out.r.x).toBe(1.23456789012); // untouched, not silently flattened
    expect(out.d).toBeInstanceOf(Date);
  });

  it('an entity index (no floats) round-trips unchanged', () => {
    const idx = { entityCount: 2, entities: [{ id: 1, guid: 'g', traits: ['Transform'] }] };
    expect(roundFloats(idx, 9)).toEqual(idx);
  });
});

describe('resolvePrecision', () => {
  it('defaults when absent', () => expect(resolvePrecision(undefined)).toBe(DEFAULT_FLOAT_PRECISION));

  it('a garbage value falls back to the default — it must never disable rounding', () => {
    // The `?limit=abc` -> NaN -> full-ring-flood lesson, applied to precision.
    expect(resolvePrecision('abc')).toBe(DEFAULT_FLOAT_PRECISION);
    expect(resolvePrecision(NaN)).toBe(DEFAULT_FLOAT_PRECISION);
    expect(resolvePrecision('')).toBe(DEFAULT_FLOAT_PRECISION);
    expect(resolvePrecision(null)).toBe(DEFAULT_FLOAT_PRECISION);
  });

  it('honours an explicit value, including 0 (exact)', () => {
    expect(resolvePrecision(0)).toBe(0);
    expect(resolvePrecision('0')).toBe(0);
    expect(resolvePrecision(6)).toBe(6);
  });
});

describe('the default is 9', () => {
  it('9 sig, not 6 — 6 buys ~6 more points of saving at 1,400x the error', () => {
    expect(DEFAULT_FLOAT_PRECISION).toBe(9);
    expect(Math.abs(roundSig(247.13061935179246, 9) - 247.13061935179246)).toBeLessThan(4e-7);
    expect(Math.abs(roundSig(247.13061935179246, 6) - 247.13061935179246)).toBeGreaterThan(3e-4);
  });
});
