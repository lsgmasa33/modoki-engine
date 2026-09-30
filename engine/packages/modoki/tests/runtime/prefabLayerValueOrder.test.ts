/** #1877 S4: the ORDER the layer fold puts one field's statements in. Each layer states legacy values (`values`) and
 *  member rows (`rows`); layers fold innermost first, and within a layer the rows come after its values. So an OUTER
 *  layer's legacy value beats an INNER layer's row (it used to lose: every layer's legacy values were merged under every
 *  layer's rows), a layer's row beats its own legacy value, and an outer row beats an inner legacy value. Pure
 *  `foldStructureLayers`, which the spawner and `foldRowStep` share. */

import { describe, it, expect } from 'vitest';
import { foldStructureLayers, type StructureLayer } from '../../src/runtime/loaders/prefabOverrides';

const G = 'eeeeeeee-0000-4000-8000-000000001877';
/** A frame whose member localId 2 is the row with identity G. */
const doc = { rootLocalId: 1, entities: [{ localId: 1 }, { localId: 2, nodeGuid: G }] };
const row = (y: number) => ({ [`/${G}`]: { traits: { Transform: { y } } } });
const vals = (y: number) => ({ 2: { Transform: { y } } });
const yOf = (layers: StructureLayer<unknown, never>[]) =>
  (foldStructureLayers(doc, layers as never, 0, { overrides: {} }).channels.overrides?.[2] as { Transform?: { y?: number } } | undefined)?.Transform?.y;

describe('#1877 S4: one field stated by several layers', () => {
  // Mutation: `foldStructureLayers` skips `layer.values` — the inner row's 8 wins.
  it('an OUTER layer\'s legacy value beats an INNER layer\'s member row', () => {
    expect(yOf([{ rows: row(8) as never }, { values: vals(3) }])).toBe(3);
  });

  // Mutation: a layer's values applied AFTER its own rows — its legacy 1 beats its row.
  it('within one layer, the row beats the layer\'s own legacy value', () => {
    expect(yOf([{ values: vals(1), rows: row(8) as never }])).toBe(8);
  });

  it('an outer layer\'s row beats an inner layer\'s legacy value', () => {
    expect(yOf([{ values: vals(1) }, { rows: row(9) as never }])).toBe(9);
  });

  // A slot owns the structural lists, not the values: a layer inside it (index < foldFrom) still states them.
  it('a layer inside an outer slot still states its values', () => {
    const r = foldStructureLayers(doc, [{ values: vals(4) }, {}] as never, 1, { overrides: {} });
    expect((r.channels.overrides?.[2] as { Transform: { y: number } }).Transform.y).toBe(4);
  });
});
