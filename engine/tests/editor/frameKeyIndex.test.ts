/** #1937 C-A step 3, T15 (the oracle): every reader that asks "which node does this key name" asks one index,
 *  `frameKeyIndex`, so one frame gets one verdict from all of them. The frame here repeats key `k` at two DEPTHS (a node
 *  at the top and one inside a plain node's children) and holds `w` once — the shape whose verdict split before: the
 *  expansion counted the whole tree, `pairWithBase` only the top level, and the capture's `byKey` maps took the last. */

import { describe, it, expect } from 'vitest';
import { subtractChainStructure } from '../../packages/modoki/src/editor/scene/prefabCapture';
import { frameKeyIndex, applyNodeRows, pairWithBase, baseNodeOf, type KeyedNode } from '../../packages/modoki/src/runtime/loaders/prefabOverrides';

const SRC = 'cccccccc-0000-4000-8000-000000019375';
type N = KeyedNode<N> & { name: string; guid?: string; parentLocalId: number };
const node = (name: string, key: string | undefined, extra: Partial<N> = {}): N => ({
  name, parentLocalId: 1, guid: '', ...(key ? { key } : {}), traits: { EntityAttributes: { name, parentId: 0 }, Transform: { x: 0 } }, children: [], ...extra,
});
/** X (ref, k) · Y (plain) → Z (ref, k) · W (ref, w). */
const frame = (): N[] => [
  node('X', 'k', { prefab: SRC }),
  node('Y', undefined, { children: [node('Z', 'k', { prefab: SRC })] }),
  node('W', 'w', { prefab: SRC }),
];

describe('one frame, one verdict from every reader (#1937 T15)', () => {
  it('the index: w names W, k names neither', () => {
    const index = frameKeyIndex(frame());
    expect(index.get('w')?.name).toBe('W');
    expect(index.get('k')).toBeNull();
  });

  // Mutation: `applyNodeRows` counts top-level nodes only — k names X.
  it('applyNodeRows: a row on w finds W, a row on k finds neither', () => {
    const rows = new Map([['k', { traits: { Transform: { x: 5 } } }], ['w', { traits: { Transform: { x: 6 } } }]]);
    const { hit } = applyNodeRows(frame(), rows as never);
    expect([...hit]).toEqual(['w']);
  });

  // Mutation: `pairWithBase` counts its own top-level `lower` again (the pre-#1937 scope) — the copy of X is paired.
  it('pairWithBase: the copy keyed w is paired with W; the copy keyed k with nothing', () => {
    const copies = [
      node('X', 'k', { prefab: SRC, guid: 'aaaaaaaa-0000-4000-8000-000000019375' }),
      node('W', 'w', { prefab: SRC, guid: 'aaaaaaaa-0000-4000-8000-000000019376' }),
    ];
    const lower = frame();
    const paired = pairWithBase(copies, lower.filter((n) => n.key), frameKeyIndex(lower));
    expect(baseNodeOf(paired[1]!)).toBe(lower[2]);
    expect(baseNodeOf(paired[0]!)).toBeUndefined();
  });

  // Mutation: `subtractChainStructure` maps keys itself, last wins over its top level (the pre-#1937 `byKey`) — the edited
  // copy keyed k is listed to replace X.
  it('subtractChainStructure: an edited copy keyed w replaces W; one keyed k replaces nothing', () => {
    const gx = 'aaaaaaaa-0000-4000-8000-000000019377';
    const gw = 'aaaaaaaa-0000-4000-8000-000000019378';
    const edited = (n: N, guid: string): N => ({ ...n, guid, traits: { ...n.traits, Transform: { x: 9 } } });
    const chain = frame();
    const { replace } = subtractChainStructure(
      { added: [edited(chain[0]!, gx), edited(chain[2]!, gw)], removed: [], removedTraits: {} } as never,
      { added: chain as never },
      new Map([[gx, 'k'], [gw, 'w']]),
    );
    expect(replace.map((r) => r.key)).toEqual(['w']);
  });
});
