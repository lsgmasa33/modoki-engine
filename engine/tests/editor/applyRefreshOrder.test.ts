/** #1736 (#1715's pool half): the order an Apply's written prefab files are refreshed in (`innermostFirst`). A file
 *  another written file CONTAINS goes first — the outer file's refresh rebuilds the inner file's frames inside it, and a
 *  capture must read frames already rebuilt — and the deepest level a file was reached at breaks ties. The integration
 *  case (`nestedEnclosingLayer.test.ts` #1736 › #1715) is ordered right by EITHER rule, so this pins each one alone. */

import { describe, it, expect } from 'vitest';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { innermostFirst } from '../../packages/modoki/src/editor/scene/prefabApply';

const P = 'aaaaaaaa-0000-4000-8000-000000001715';
const Q = 'aaaaaaaa-0000-4000-8000-000000001716';
const X = 'aaaaaaaa-0000-4000-8000-000000001717';
const doc = (id: string, refs: string[] = []): PrefabFile => ({
  id, version: 6, name: id.slice(-4), rootLocalId: 1,
  entities: [{ localId: 1, name: 'R', traits: {} }, ...refs.map((r, i) => ({ localId: 2 + i, name: `N${i}`, prefab: r, traits: {} }))],
} as unknown as PrefabFile);
const item = (id: string, level: number, refs: string[] = []) => ({ level, w: { source: id, doc: doc(id, refs) } });
const same = (a: string, b: string) => a === b;

describe('innermostFirst', () => {
  it('a contained file goes first even when the file containing it was reached DEEPER (the maximum alone misorders it)', () => {
    // Mutation: drop the containment test (pick `rest[0]`, the deepest level) — Q (level 4) goes before P (level 2),
    // though Q holds P and its refresh would read P's frames not yet rebuilt.
    const order = innermostFirst([item(P, 2), item(Q, 4, [P])], same).map((x) => x.w.source);
    expect(order).toEqual([P, Q]);
  });

  it('unrelated files go deepest first', () => {
    const order = innermostFirst([item(P, 1), item(X, 3)], same).map((x) => x.w.source);
    expect(order).toEqual([X, P]);
  });
});
