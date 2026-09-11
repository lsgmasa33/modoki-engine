/** #840 — the one table of UI length defaults, and the reader that returns a value WITH its unit.
 *
 *  The defect class: a length is two fields, and every reader of authored data guessed ONE fallback
 *  for an absent unit. The right answer differs by field, so any blanket fallback is wrong for some
 *  of them — which is why the reader cases below always come in pairs, one `%`-default field and one
 *  `px`-default field: either blanket answer fails one of the pair. */

import { describe, it, expect } from 'vitest';
import { UIElement } from '../../src/runtime/traits/UIElement';
import { UIAnchor } from '../../src/runtime/traits/UIAnchor';
import {
  UI_ELEMENT_LENGTHS, UI_ANCHOR_LENGTHS, readUILength, readUIAnchorLength,
} from '../../src/runtime/traits/uiLength';

const schemaOf = (t: unknown) => (t as { schema: Record<string, unknown> }).schema;

describe('the length table IS the trait schema\'s defaults (#840)', () => {
  it.each([
    ['UIElement', UIElement, UI_ELEMENT_LENGTHS],
    ['UIAnchor', UIAnchor, UI_ANCHOR_LENGTHS],
  ] as const)('%s: every *Unit field has a table entry, and every entry names a real field pair', (_name, trait, table) => {
    const schema = schemaOf(trait);
    const unitFields = Object.keys(schema).filter((k) => k.endsWith('Unit')).map((k) => k.slice(0, -'Unit'.length)).sort();
    expect(unitFields.length, 'anti-vacuity: the schema must actually carry unit fields').toBeGreaterThan(0);
    expect(Object.keys(table).sort()).toEqual(unitFields);
    for (const field of unitFields) expect(Object.prototype.hasOwnProperty.call(schema, field), `${field} value field`).toBe(true);
  });

  it.each([
    ['UIElement', UIElement, UI_ELEMENT_LENGTHS],
    ['UIAnchor', UIAnchor, UI_ANCHOR_LENGTHS],
  ] as const)('%s: the schema default of each value and unit equals the table\'s', (_name, trait, table) => {
    const schema = schemaOf(trait);
    for (const [field, spec] of Object.entries(table)) {
      expect(schema[field], `${field}`).toBe(spec.value);
      expect(schema[`${field}Unit`], `${field}Unit`).toBe(spec.unit);
    }
  });

  it('the defaults are the per-field split the engine has always had — not one blanket unit', () => {
    // Pinned explicitly, so a table edit that "tidies" every unit to one value is a red test here
    // and not only a quiet change in every reader.
    const pct = ['width', 'height', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom',
      'marginTop', 'marginRight', 'marginBottom', 'marginLeft'];
    const px = ['gap', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'minTapSize', 'fontSize', 'letterSpacing'];
    for (const f of pct) expect(UI_ELEMENT_LENGTHS[f as keyof typeof UI_ELEMENT_LENGTHS].unit, f).toBe('%');
    for (const f of px) expect(UI_ELEMENT_LENGTHS[f as keyof typeof UI_ELEMENT_LENGTHS].unit, f).toBe('px');
    for (const spec of Object.values(UI_ANCHOR_LENGTHS)) expect(spec.unit).toBe('px');
  });
});

describe('readUILength / readUIAnchorLength (#840)', () => {
  it('an ABSENT unit resolves per field — both blanket answers fail one of this pair', () => {
    expect(readUILength({ paddingLeft: 4 }, 'paddingLeft')).toEqual({ value: 4, unit: '%' });
    expect(readUILength({ gap: 4 }, 'gap')).toEqual({ value: 4, unit: 'px' });
    expect(readUILength({ width: 90 }, 'width').unit).toBe('%');
    expect(readUILength({ maxWidth: 3 }, 'maxWidth').unit).toBe('px');
    expect(readUIAnchorLength({ top: 12 }, 'top')).toEqual({ value: 12, unit: 'px' });
  });

  it('a PRESENT unit is returned exactly as written — including one the engine does not know', () => {
    expect(readUILength({ width: 50, widthUnit: 'vh' }, 'width')).toEqual({ value: 50, unit: 'vh' });
    expect(readUILength({ gap: 2, gapUnit: '%' }, 'gap').unit).toBe('%');
    expect(readUILength({ width: 1, widthUnit: 'furlong' }, 'width').unit).toBe('furlong');
  });

  it('an absent VALUE resolves to the field\'s own default, and an empty unit string counts as absent', () => {
    expect(readUILength({}, 'fontSize')).toEqual({ value: 16, unit: 'px' });
    expect(readUILength(undefined, 'width')).toEqual({ value: 0, unit: '%' });
    expect(readUILength({ width: 10, widthUnit: '' }, 'width').unit).toBe('%');
  });

  it('reads the pair from a LIVE trait snapshot the same way as from authored JSON', () => {
    expect(readUILength(schemaOf(UIElement), 'paddingTop')).toEqual({ value: 0, unit: '%' });
  });
});
