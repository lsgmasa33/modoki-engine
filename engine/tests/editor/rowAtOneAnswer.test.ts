/** #1880 F3c: a repeated localId or template key has ONE answer. A repeated localId names the LAST row (`rowAt`, the
 *  spawner's `localToEcs`); a repeated key names NEITHER node (`applyNodeRows`, `applyNodeRowsLive`, `memberPathIndex`,
 *  the fold's `replaced()`). No writer emits either; a hand edit or a merge can, and the validator reports it. The raw
 *  lookups are refused by `tests/architecture/rowLookupCensus.test.ts`. */

import { describe, it, expect } from 'vitest';
import { rowAt, referenceRowAt } from '../../packages/modoki/src/runtime/core/prefabRowAt';
import { applyNodeRows } from '../../packages/modoki/src/runtime/loaders/prefabOverrides';
import { getOverrideValues } from '../../packages/modoki/src/editor/scene/prefabInstanceOverrides';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const row = (localId: number, name: string, x: number, extra: Record<string, unknown> = {}) =>
  ({ localId, name, ...extra, traits: { EntityAttributes: { name, parentId: localId === 1 ? 0 : 1, guid: '' }, Transform: { x, y: 0, z: 0 } } });
/** localId 2 twice: the spawner keeps the SECOND row's entity at that number. */
const doc = () => ({ id: 'p', version: 6, name: 'P', rootLocalId: 1, entities: [row(1, 'R', 0), row(2, 'First', 1, { prefab: 'q' }), row(2, 'Last', 5)] });

describe('a repeated localId names the LAST row (#1880 F3c)', () => {
  // Mutation: `rowAt` loops from the front — every case goes red.
  it('rowAt: the last row, from a document or a row list; nothing for an absent doc or number', () => {
    expect(rowAt(doc(), 2)?.name).toBe('Last');
    expect(rowAt(doc().entities, 2)?.name).toBe('Last');
    expect(rowAt(undefined, 2)).toBeUndefined();
    expect(rowAt(doc(), undefined)).toBeUndefined();
    // …and a reference row only when THAT row is one: the first row's `prefab` is not the spawner's row.
    expect(referenceRowAt(doc(), 2)).toBeUndefined();
  });

  it('the effective base reads the row the spawner shows: x 5 is no override', () => {
    expect(getOverrideValues(2, { Transform: { x: 5, y: 0, z: 0 } }, doc() as never)).toEqual({});
    expect(getOverrideValues(2, { Transform: { x: 1, y: 0, z: 0 } }, doc() as never)).toEqual({ Transform: { x: 1 } });
  });
});

describe('a repeated template key names NEITHER node (#1880 F3c)', () => {
  // Mutation: drop the `seen.get(key) === 1` test in `applyNodeRows` — both nodes take the row's x.
  it('applyNodeRows applies nothing to either node, and does not report the row as hit', () => {
    const node = (name: string) => ({ parentLocalId: 1, guid: '', name, key: 'k', traits: { Transform: { x: 0 } }, children: [] });
    const { nodes, hit } = applyNodeRows([node('A'), node('B')] as never, new Map([['k', { traits: { Transform: { x: 9 } } }]]) as never);
    expect((nodes as unknown as { traits: { Transform: { x: number } } }[]).map((n) => n.traits.Transform.x)).toEqual([0, 0]);
    expect([...hit]).toEqual([]);
    // (accept) a key one node carries takes the row.
    const one = applyNodeRows([node('A')] as never, new Map([['k', { traits: { Transform: { x: 9 } } }]]) as never);
    expect((one.nodes as unknown as { traits: { Transform: { x: number } } }[])[0]!.traits.Transform.x).toBe(9);
  });
});
