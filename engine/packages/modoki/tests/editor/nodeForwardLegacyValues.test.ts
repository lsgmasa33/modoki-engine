/** #1877 S4: a template REFERENCE node's legacy `nestedOverrides` reach its frame's nested rows as the node's own layer
 *  (`nodeForward`, `prefabBase.ts`), so they fold OVER what the nested row itself states — the spawner's answer. The
 *  editor's baseline (`frameBase`/`chainLayer`) reads it this way; answering the row's value instead, a capture against
 *  it wrote a spurious override. Mutation: `nodeForward`'s layer drops `valuePaths` — the row's own 3 wins. */

import { describe, it, expect } from 'vitest';
import { nodeForward } from '../../src/editor/scene/prefabBase';
import { foldPath } from '../../src/runtime/loaders/prefabOverrides';

const P = 'cccccccc-0000-4000-8000-000001877f01';
const Q = 'cccccccc-0000-4000-8000-000001877f02';
const q = { id: Q, rootLocalId: 1, entities: [{ localId: 1, name: 'QR', traits: {} }] };
/** P: PR, and row 2 expanding Q, which states Q's root y = 3 itself. */
const p = { id: P, rootLocalId: 1, entities: [
  { localId: 1, name: 'PR', traits: {} },
  { localId: 2, name: 'QRow', prefab: Q, overrides: { 1: { Transform: { y: 3 } } }, traits: {} },
] };

describe('#1877 S4: a reference node\'s legacy value over its frame\'s nested row', () => {
  it('the node\'s `nestedOverrides` beat the row\'s own override', () => {
    const node = { prefab: P, nestedOverrides: { 2: { 1: { Transform: { y: 5 } } } } };
    const seed = nodeForward(node as never, p as never);
    const r = foldPath([p, q] as never, [2], seed as never);
    expect((r.overrides[1] as { Transform: { y: number } }).Transform.y).toBe(5);
  });
});
