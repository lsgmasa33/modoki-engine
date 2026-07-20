/** Pure field-helper invariants extracted from Inspector.tsx — the corrected
 *  behavior behind editor-inspector.md findings F1, F4, F5, F11. These are the
 *  testable units of otherwise jsdom-heavy controlled-input fixes. */

import { describe, it, expect } from 'vitest';

const { colorToHex, coerceSortOrder, editableEntityName, defaultForHint, UNIT_FIELD_MAPS, UNIT_COMPANION_FIELDS } =
  await import('../../src/editor/panels/Inspector');

describe('colorToHex (F5 — ColorField must emit a valid #rrggbb)', () => {
  it('round-trips an in-range color', () => {
    expect(colorToHex(0xff8000)).toBe('#ff8000');
  });
  it('zero-pads small values to 6 digits', () => {
    expect(colorToHex(0x0000ff)).toBe('#0000ff');
    expect(colorToHex(0)).toBe('#000000');
  });
  it('masks out-of-range values to 24 bits (no 7+ char string)', () => {
    // alpha-packed / overflowed int — must NOT produce '#1ff8000'
    expect(colorToHex(0x1ff8000)).toBe('#ff8000');
    const hex = colorToHex(0xffffffff);
    expect(hex).toBe('#ffffff');
    expect(hex).toHaveLength(7);
  });
  it('floors fractional values instead of emitting fractional hex', () => {
    expect(colorToHex(0xff8000 + 0.8)).toBe('#ff8000');
  });
  it('falls back to black on NaN / non-finite', () => {
    expect(colorToHex(NaN)).toBe('#000000');
    expect(colorToHex(Infinity)).toBe('#000000');
    expect(colorToHex(undefined as unknown as number)).toBe('#000000');
  });
  it('always returns exactly 7 chars', () => {
    for (const v of [0, 0xffffff, 0x123456, 0x1ffffff, NaN, -1]) {
      expect(colorToHex(v)).toHaveLength(7);
    }
  });
});

describe('coerceSortOrder (F4 — cleared field must never write NaN)', () => {
  it('parses a normal integer', () => {
    expect(coerceSortOrder('5')).toBe(5);
    expect(coerceSortOrder('-3')).toBe(-3);
  });
  it('returns 0 for an empty field instead of NaN', () => {
    expect(coerceSortOrder('')).toBe(0);
    expect(Number.isNaN(coerceSortOrder(''))).toBe(false);
  });
  it('returns 0 for non-numeric input', () => {
    expect(coerceSortOrder('abc')).toBe(0);
  });
  it('preserves a fractional value (finite)', () => {
    expect(coerceSortOrder('2.5')).toBe(2.5);
  });
});

describe('editableEntityName (F1 — editable field binds the RAW name)', () => {
  it('returns the raw stored name unchanged (no display transform applied)', () => {
    expect(editableEntityName('Enemy_01')).toBe('Enemy_01');
    expect(editableEntityName('Pre fix Name')).toBe('Pre fix Name');
  });
  it('coerces a nullish name to empty string for the controlled input', () => {
    expect(editableEntityName(undefined)).toBe('');
    expect(editableEntityName(null)).toBe('');
  });
});

describe('defaultForHint (F11 — color seeds white, consistent with ColorField)', () => {
  it('seeds white for a color field, not black', () => {
    expect(defaultForHint({ type: 'color' } as any)).toBe(0xffffff);
  });
  it('keeps the existing defaults for other types', () => {
    expect(defaultForHint({ type: 'boolean' } as any)).toBe(false);
    expect(defaultForHint({ type: 'number' } as any)).toBe(0);
    expect(defaultForHint({ type: 'string' } as any)).toBe('');
    expect(defaultForHint(undefined)).toBe('');
  });
});

describe('UNIT_FIELD_MAPS / UNIT_COMPANION_FIELDS (F2 — single source of truth for value↔unit pairing)', () => {
  it('derives the companion (hide-list) set from the value→unit map per trait', () => {
    // The hide-list must be exactly the unit-field VALUES of the map — nothing
    // hand-listed separately (the bug F2 called out: two lists kept in sync by hand).
    for (const trait of Object.keys(UNIT_FIELD_MAPS)) {
      const expected = new Set(Object.values(UNIT_FIELD_MAPS[trait]));
      expect(UNIT_COMPANION_FIELDS[trait]).toEqual(expected);
    }
  });
  it('maps every UIElement value field to its *Unit companion', () => {
    expect(UNIT_FIELD_MAPS.UIElement.width).toBe('widthUnit');
    expect(UNIT_FIELD_MAPS.UIElement.marginLeft).toBe('marginLeftUnit');
    expect(UNIT_COMPANION_FIELDS.UIElement.has('widthUnit')).toBe(true);
    // A value field is NOT itself a companion (so it still renders).
    expect(UNIT_COMPANION_FIELDS.UIElement.has('width')).toBe(false);
  });
  it('maps UIAnchor offsets to their *Unit companions', () => {
    expect(UNIT_FIELD_MAPS.UIAnchor).toEqual({ top: 'topUnit', right: 'rightUnit', bottom: 'bottomUnit', left: 'leftUnit' });
    expect(UNIT_COMPANION_FIELDS.UIAnchor.has('leftUnit')).toBe(true);
  });
  it('has no entry for traits without unit fields', () => {
    expect(UNIT_FIELD_MAPS.Transform).toBeUndefined();
    expect(UNIT_COMPANION_FIELDS.Transform).toBeUndefined();
  });
});
