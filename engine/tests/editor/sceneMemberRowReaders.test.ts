/** #1468 Phase 4 — every reader that walks a scene's instance channels also walks the MEMBER ROWS.
 *
 *  Phase 4 moved a member's overrides and the subtrees added under it off `overrides`/`added` and onto
 *  its row (`traits`, `added`). Each walker below used to find those refs in the old channels only; a
 *  ref on a row that one of them misses is dropped from the scene's preload, from the path guard, from
 *  a duplicate's remint, from validation, or from the member-path walk that names guid-less members.
 *  Each case puts the ONLY copy of a ref on a row. (The build's tree-shaker is covered beside its own
 *  siblings, in `plugins/assetTreeShaker.test.ts`.) */

import { describe, it, expect, vi } from 'vitest';
import { collectResourceRefsFromEntities } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { assertNoPathRefs } from '../../packages/modoki/src/editor/scene/serialize';
import { remintSceneEntityGuids } from '../../plugins/asset-fs-ops';
import { validateSceneData } from '../../packages/modoki/src/runtime/loaders/sceneValidation';
import { memberPathRecords, sceneMemberAnchors } from '../../packages/modoki/src/runtime/loaders/memberPaths';

const NODE = 'abcd0000-0000-4000-8000-000000000001';
const MAT = 'abcd0000-0000-4000-8000-0000000000a1';
const ADDED_MAT = 'abcd0000-0000-4000-8000-0000000000a2';
const ADDED_GUID = 'abcd0000-0000-4000-8000-0000000000b1';
const P = 'abcd0000-0000-4000-8000-0000000000f1';

const rowEntry = (row: Record<string, unknown>) => ({
  id: 1, prefab: P, guid: 'abcd0000-0000-4000-8000-0000000000e1',
  traits: { EntityAttributes: { name: 'Root', parentId: 0 }, PrefabInstance: { source: P, localId: 1 } },
  members: { [`/${NODE}`]: { guid: 'abcd0000-0000-4000-8000-0000000000e2', ...row } },
});

describe('readers of a scene`s instance channels walk the member rows (#1468 Phase 4)', () => {
  it('the runtime resource walker acquires a ref held only in a row`s traits or added node', () => {
    const refs = collectResourceRefsFromEntities([rowEntry({
      traits: { Renderable3DPrimitive: { material: MAT } },
      added: [{ parentLocalId: 0, guid: ADDED_GUID, name: 'X', traits: { Renderable3DPrimitive: { material: ADDED_MAT } }, children: [] }],
    })] as never).map((r) => r.path);
    expect(refs).toContain(MAT);
    expect(refs).toContain(ADDED_MAT);
  });

  it('…and one held on a row of a user-added REFERENCE node, which is an instance of its own', () => {
    const refNode = {
      parentLocalId: 1, guid: ADDED_GUID, name: 'R', prefab: P, traits: {}, children: [],
      members: { [`/${NODE}`]: { guid: 'abcd0000-0000-4000-8000-0000000000e3', traits: { Renderable3DPrimitive: { material: MAT } } } },
    };
    const refs = collectResourceRefsFromEntities([{ ...rowEntry({}), members: undefined, added: [refNode] }] as never).map((r) => r.path);
    expect(refs).toContain(MAT);
  });

  it('the save-time path guard flags a raw asset path in a row`s traits and in its added node', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    assertNoPathRefs(rowEntry({
      traits: { Renderable3DPrimitive: { material: '/games/g/assets/mats/raw.mat.json' } },
      added: [{ parentLocalId: 0, guid: ADDED_GUID, name: 'X', traits: { Renderable3DPrimitive: { material: '/games/g/assets/mats/raw2.mat.json' } }, children: [] }],
    }) as never);
    const flagged = err.mock.calls.map((c) => String(c[0]));
    err.mockRestore();
    expect(flagged.some((m) => m.includes(`members{/${NODE}}.Renderable3DPrimitive.material`))).toBe(true);
    expect(flagged.some((m) => m.includes(`members{/${NODE}}.added[0].Renderable3DPrimitive.material`))).toBe(true);
  });

  it('a duplicate remints the guid of a node added on a row', () => {
    const scene = { version: 16, entities: [rowEntry({ added: [{ parentLocalId: 0, guid: ADDED_GUID, name: 'X', traits: {}, children: [] }] })] };
    const copy = remintSceneEntityGuids(scene as never, () => 'abcd0000-0000-4000-8000-00000000c0de') as unknown as typeof scene;
    const added = (copy.entities[0]!.members[`/${NODE}`] as unknown as { added: { guid: string }[] }).added[0]!;
    expect(added.guid).not.toBe(ADDED_GUID);
  });

  it('validation checks a row`s refs, and composes a DIRECT row`s member for the inert-size check', () => {
    const prefab = { id: P, rootLocalId: 1, entities: [
      { localId: 1, traits: { EntityAttributes: { name: 'Root', parentId: 0 } } },
      { localId: 2, nodeGuid: NODE, traits: { EntityAttributes: { name: 'Panel', parentId: 1 }, UIElement: {}, UIAnchor: { anchor: 'stretch' } } },
    ] };
    const { warnings } = validateSceneData({ version: 16, entities: [rowEntry({
      traits: { Renderable3DPrimitive: { material: MAT }, UIElement: { width: 50 } },
    })] }, undefined, (ref) => (ref === P ? prefab : undefined), () => 'missing');
    expect(warnings.some((w) => w.includes(`members[/${NODE}].traits`) && w.includes('Renderable3DPrimitive.material'))).toBe(true);
    expect(warnings.some((w) => w.includes(`members[/${NODE}].traits.UIElement.width is inert`))).toBe(true);
  });

  it('the member-path walk names a keyed node added on a row, under the member the row names', () => {
    const prefab = { id: P, rootLocalId: 1, entities: [
      { localId: 1, traits: { EntityAttributes: { parentId: 0 } } },
      { localId: 2, nodeGuid: NODE, traits: { EntityAttributes: { parentId: 1 } } },
    ] };
    const keyed = { guid: '', key: 'k-row', name: 'K', traits: {}, children: [] };
    const node = { prefab: P, members: { [`/${NODE}`]: { added: [keyed] } } };
    const paths = [...memberPathRecords(node, (g) => (g === P ? prefab : null)).self.keys()];
    // Row localId 2, then the node's key step — the path the loader derives it at.
    expect(paths).toContain('2.+k-row');
  });

  it('…and in a NESTED frame: the nested root`s own row, and a row one frame down', () => {
    const inner = { id: P, rootLocalId: 1, entities: [
      { localId: 1, nodeGuid: 'abcd0000-0000-4000-8000-000000000011', traits: { EntityAttributes: { parentId: 0 } } },
      { localId: 2, nodeGuid: NODE, traits: { EntityAttributes: { parentId: 1 } } },
    ] };
    const O = 'abcd0000-0000-4000-8000-0000000000f2';
    const gN = 'abcd0000-0000-4000-8000-000000000021';
    const outer = { id: O, rootLocalId: 1, entities: [
      { localId: 1, traits: { EntityAttributes: { parentId: 0 } } },
      { localId: 3, nodeGuid: gN, prefab: P, traits: { EntityAttributes: { parentId: 1 } } },
    ] };
    const node = { prefab: O, members: {
      [`/${gN}`]: { added: [{ guid: '', key: 'k-root', name: 'K1', traits: {}, children: [] }] },
      [`/${gN}/${NODE}`]: { added: [{ guid: '', key: 'k-deep', name: 'K2', traits: {}, children: [] }] },
    } };
    const docs: Record<string, unknown> = { [P]: inner, [O]: outer };
    const paths = [...memberPathRecords(node, (g) => docs[g] ?? null).self.keys()];
    expect(paths).toContain('3.+k-root');
    expect(paths).toContain('3.2.+k-deep');
  });

  it('a reference node added on a row is a scene member ANCHOR', () => {
    const ref = { parentLocalId: 0, guid: ADDED_GUID, name: 'R', prefab: P, traits: {}, children: [] };
    const anchors = sceneMemberAnchors({ entities: [rowEntry({ added: [ref] })] });
    expect(anchors.some((a) => a.self === ADDED_GUID)).toBe(true);
  });
});
