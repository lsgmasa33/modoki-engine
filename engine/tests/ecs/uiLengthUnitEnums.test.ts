/** Every `UIElement`/`UIAnchor` unit enum offers exactly `UI_LENGTH_UNITS` (#1064).
 *
 *  These 22 enums were 22 hand-typed copies of the six units — the largest share of the copies #1064
 *  counted — and they drive both the Inspector's generic enum widget and the field schema the
 *  validator and `modoki_list_traits` read. They now spread the tuple; this reads the REAL registry
 *  (not a mock) so a unit enum offering a DIFFERENT list — a unit dropped, added or reordered, or a
 *  new length field registered with its own list — is caught. ⚠️ It compares by VALUE, so a literal
 *  list that happens to hold the same six passes here; that shape is `uiLengthUnitCopies.test.ts`'s to
 *  catch, via the quoted viewport-unit literals such a list contains (#1064 close-out review). The
 *  floor keeps "no unit fields found" from passing as "all fine".
 *
 *  ⚠️ `UIEntries`' `entryWidthUnit`/`entryHeightUnit` are deliberately NOT in scope: `['px', '%']` is a
 *  separately typed subset (`UIEntryLengthUnit`), which `entryPrefabProvider` enforces. */

import { describe, it, expect } from 'vitest';
import { UIElement, UIAnchor, UI_LENGTH_UNITS, getTraitMeta } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';

describe('UI length unit enums spread the one tuple (#1064)', () => {
  it('every *Unit enum on UIElement and UIAnchor offers exactly UI_LENGTH_UNITS', () => {
    registerAllTraits();
    const unitFields: string[] = [];
    const wrong: string[] = [];
    for (const [name, trait] of [['UIElement', UIElement], ['UIAnchor', UIAnchor]] as const) {
      const fields = getTraitMeta(trait)?.fields ?? {};
      for (const [key, hint] of Object.entries(fields)) {
        if (!key.endsWith('Unit') || hint.type !== 'enum') continue;
        unitFields.push(`${name}.${key}`);
        if (JSON.stringify(hint.options) !== JSON.stringify([...UI_LENGTH_UNITS])) {
          wrong.push(`${name}.${key} offers ${JSON.stringify(hint.options)}`);
        }
      }
    }
    expect(unitFields.length, 'found fewer unit enums than the 22 this was written against').toBeGreaterThanOrEqual(22);
    expect(wrong).toEqual([]);
  });
});
