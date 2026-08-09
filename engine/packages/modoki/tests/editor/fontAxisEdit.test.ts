/** Font Inspector variation-axis edit logic. Both functions encode a decision that was
 *  WRONG in the first draft and only surfaced by driving the real control. */

import { describe, it, expect } from 'vitest';
import { commitAxisDraft, applyAxisEdit } from '../../src/editor/panels/assetViews/fontAxisEdit';

const WGHT = { min: 100, max: 900 };

describe('commitAxisDraft', () => {
  it('commits a typed value', () => {
    expect(commitAxisDraft('700', WGHT)).toBe(700);
  });

  it('clamps ONCE, at commit, to the axis range', () => {
    expect(commitAxisDraft('9999', WGHT)).toBe(900);
    expect(commitAxisDraft('1', WGHT)).toBe(100);
  });

  /** The bug this shape exists to prevent. Clamping per keystroke makes the field
   *  impossible to type into: each partial entry is clamped into range, so "700" walks
   *  100 → 100 → 900 and silently writes a value nobody asked for. Measured against the
   *  live Inspector (the field ended on 900), which is the only thing that catches it. */
  it('does not clamp intermediate keystrokes — every prefix of "700" is committable', () => {
    // What a per-keystroke clamp would have produced, versus what a draft produces.
    const perKeystrokeClamp = (s: string) => Math.min(WGHT.max, Math.max(WGHT.min, Number(s)));
    expect(['7', '70', '700'].map(perKeystrokeClamp)).toEqual([100, 100, 700]);
    // The draft never clamps a prefix, because it is only asked at the end.
    expect(commitAxisDraft('700', WGHT)).toBe(700);
  });

  it('treats an untouched field as nothing to commit', () => {
    expect(commitAxisDraft(null, WGHT)).toBeUndefined();
  });

  it('keeps the previous value when the field was emptied rather than writing 0', () => {
    // Number('') is 0, which would clamp to the axis MINIMUM — silently re-weighting the
    // font because someone selected-all and tabbed away.
    expect(commitAxisDraft('', WGHT)).toBeUndefined();
    expect(commitAxisDraft('   ', WGHT)).toBeUndefined();
  });

  it('ignores unparseable input rather than writing NaN', () => {
    for (const bad of ['abc', '--', '1e', '1.2.3']) {
      expect(commitAxisDraft(bad, WGHT), bad).toBeUndefined();
    }
  });

  it('handles a normalized axis with a fractional range', () => {
    expect(commitAxisDraft('0.4', { min: 0, max: 1 })).toBe(0.4);
    expect(commitAxisDraft('5', { min: 0, max: 1 })).toBe(1);
  });

  it('handles a negative-range axis (slnt is -12..0)', () => {
    expect(commitAxisDraft('-8', { min: -12, max: 0 })).toBe(-8);
    expect(commitAxisDraft('4', { min: -12, max: 0 })).toBe(0);
  });
});

describe('applyAxisEdit', () => {
  it('sets an axis on an empty map', () => {
    expect(applyAxisEdit(undefined, 'wght', 700)).toEqual({ wght: 700 });
  });

  it('adds a second axis without disturbing the first', () => {
    expect(applyAxisEdit({ wght: 700 }, 'SHRP', 40)).toEqual({ wght: 700, SHRP: 40 });
  });

  it('overwrites an existing axis', () => {
    expect(applyAxisEdit({ wght: 700 }, 'wght', 300)).toEqual({ wght: 300 });
  });

  it('clears one axis of several', () => {
    expect(applyAxisEdit({ wght: 700, SHRP: 40 }, 'SHRP', undefined)).toEqual({ wght: 700 });
  });

  /** `{}` and absent hash IDENTICALLY in the font cache key, so an empty map is a no-op
   *  that still reads as "an instance was chosen" in the sidecar and the Inspector.
   *  Unauthored is also the only state that keeps following the font's own default if the
   *  file is ever replaced — so clearing the last axis must return to it. */
  it('returns undefined (not {}) when the last axis is cleared', () => {
    expect(applyAxisEdit({ wght: 700 }, 'wght', undefined)).toBeUndefined();
  });

  it('does not mutate the input map', () => {
    const prev = { wght: 700 };
    applyAxisEdit(prev, 'SHRP', 40);
    expect(prev).toEqual({ wght: 700 });
  });

  it('clearing an axis that was never set is a no-op, not an empty map', () => {
    expect(applyAxisEdit(undefined, 'wght', undefined)).toBeUndefined();
    expect(applyAxisEdit({ wght: 700 }, 'CRSV', undefined)).toEqual({ wght: 700 });
  });
});
