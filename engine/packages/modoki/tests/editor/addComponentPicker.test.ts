/** filterAndGroupAddable — the pure search/group builder behind the Inspector's
 *  Add Component picker. Guards the filter (case-insensitive substring), the
 *  category bucketing + ordering (COMPONENT_CATEGORY_ORDER first, extras alpha),
 *  and the by-name sort within each bucket. No React / live world needed. */

import { describe, it, expect } from 'vitest';
import type { TraitMeta } from '../../src/runtime/ecs/traitRegistry';
import { COMPONENT_CATEGORY_ORDER } from '../../src/runtime/ecs/traitRegistry';
import { filterAndGroupAddable } from '../../src/editor/panels/AddComponentPicker';

// Minimal TraitMeta stubs — the builder only reads `name` + `componentCategory`.
const t = (name: string, componentCategory?: string): TraitMeta =>
  ({ name, category: 'component', componentCategory } as unknown as TraitMeta);

// Two categories from the fixed order (whatever the first two are) plus an unknown
// one, so we can assert both the fixed-order-first and extras-alphabetical rules.
const [CAT_A, CAT_B] = COMPONENT_CATEGORY_ORDER;
const UNKNOWN = 'Zzz-Unknown-Category';

const ADDABLE: TraitMeta[] = [
  t('Zebra', CAT_A),
  t('Apple', CAT_A),
  t('Mango', CAT_B),
  t('Custom', UNKNOWN),
  t('Misc-less', undefined), // no componentCategory → 'Misc'
];

describe('filterAndGroupAddable', () => {
  it('empty query returns every trait, grouped and sorted by name within a group', () => {
    const groups = filterAndGroupAddable(ADDABLE, '');
    const catA = groups.find(([c]) => c === CAT_A)!;
    expect(catA[1].map(m => m.name)).toEqual(['Apple', 'Zebra']); // sorted within group
    // Every input trait is present exactly once across all groups.
    const all = groups.flatMap(([, list]) => list.map(m => m.name)).sort();
    expect(all).toEqual(['Apple', 'Custom', 'Mango', 'Misc-less', 'Zebra']);
  });

  it('whitespace-only query is treated as empty (no filter)', () => {
    const all = filterAndGroupAddable(ADDABLE, '   ').flatMap(([, l]) => l);
    expect(all).toHaveLength(ADDABLE.length);
  });

  it('filters case-insensitively by name substring', () => {
    const groups = filterAndGroupAddable(ADDABLE, 'AN'); // matches "Mango"
    const names = groups.flatMap(([, l]) => l.map(m => m.name));
    expect(names).toEqual(['Mango']);
  });

  it('drops categories with no matching traits', () => {
    const groups = filterAndGroupAddable(ADDABLE, 'apple');
    expect(groups.map(([c]) => c)).toEqual([CAT_A]); // only Apple's category survives
  });

  it('orders known categories by COMPONENT_CATEGORY_ORDER, then unknown extras alphabetically', () => {
    const cats = filterAndGroupAddable(ADDABLE, '').map(([c]) => c);
    // CAT_A before CAT_B (both fixed order). 'Misc' is the LAST fixed-order entry,
    // so it precedes UNKNOWN, which is a true extra appended after all known ones.
    expect(cats.indexOf(CAT_A)).toBeLessThan(cats.indexOf(CAT_B));
    expect(cats.indexOf(CAT_B)).toBeLessThan(cats.indexOf('Misc'));
    expect(cats.indexOf('Misc')).toBeLessThan(cats.indexOf(UNKNOWN));
  });

  it('missing componentCategory buckets under "Misc"', () => {
    const misc = filterAndGroupAddable(ADDABLE, '').find(([c]) => c === 'Misc')!;
    expect(misc[1].map(m => m.name)).toEqual(['Misc-less']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterAndGroupAddable(ADDABLE, 'no-such-trait')).toEqual([]);
  });
});
