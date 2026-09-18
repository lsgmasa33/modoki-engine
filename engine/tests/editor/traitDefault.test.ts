/** `writtenTraitKeys` / `isFieldWritten` — the one rule both scene writers use to decide which trait
 *  keys reach the file and in what order (#1412). `serializeScene` (scene entities) and prefab.ts's
 *  `compactAddedTraitData` (prefab-instance `added[]` children) call it, and
 *  `sceneFormatCanonical.test.ts` checks every committed scene against it, so a change here moves all
 *  three together. Before it existed the added-child writer claimed to mirror serialize.ts but never
 *  skipped `runtimeOnly` fields — the `runtimeOnly` case below is the one that pins that. */
import { describe, it, expect } from 'vitest';
import { writtenTraitKeys, isFieldWritten, traitKeyOrder } from '../../packages/modoki/src/editor/scene/traitDefault';

// A SoA schema: the object passed to koota's `trait({...})`. Its key order IS the write order.
const schema = { x: 0, parent: 0, elapsed: 0, name: '', tags: [] as string[] };
const fields = { parent: { entityId: { onMissing: 'root' } }, elapsed: { runtimeOnly: true } };

describe('writtenTraitKeys', () => {
  it('writes a SoA trait in SCHEMA order, whatever order the live value holds its keys in', () => {
    const data = { name: 'n', x: 3, tags: ['a'], parent: 7, elapsed: 1 };
    expect(writtenTraitKeys(schema, data, fields)).toEqual(['x', 'parent', 'name', 'tags']);
    expect(traitKeyOrder(schema)).toEqual(['x', 'parent', 'elapsed', 'name', 'tags']);
  });

  it('omits a scalar still holding its schema default, but always writes a non-scalar', () => {
    const data = { x: 0, parent: 5, elapsed: 0, name: '', tags: [] };
    expect(writtenTraitKeys(schema, data, fields)).toEqual(['parent', 'tags']);
  });

  it('never omits an entityId field at its default (a default reference is a value)', () => {
    const data = { x: 1, parent: 0, elapsed: 0, name: 'n', tags: [] };
    expect(writtenTraitKeys(schema, data, fields)).toContain('parent');
  });

  it('never writes a runtimeOnly field, even at a non-default value', () => {
    const data = { x: 1, parent: 0, elapsed: 99, name: 'n', tags: [] };
    expect(writtenTraitKeys(schema, data, fields)).not.toContain('elapsed');
    expect(isFieldWritten(99, schema, 'elapsed', fields.elapsed)).toBe(false);
  });

  it('an AoS trait (no schema) keeps every live key, in the live order — nothing to compare against', () => {
    const data = { b: 0, a: '', c: [] };
    expect(writtenTraitKeys(null, data, {})).toEqual(['b', 'a', 'c']);
  });
});
