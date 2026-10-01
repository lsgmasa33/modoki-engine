/** #1914 F8 / #1867: the validator's check of a scene's copies of missing prefabs (`embeddedPrefabs`, scene v19). The
 *  loader drops a copy with no `entities` array rather than expand it, and a copy keyed or id'd as another prefab would
 *  stand in for the wrong one, so the validator names each. */

import { describe, it, expect } from 'vitest';
import { validateSceneData } from '../../packages/modoki/src/runtime/loaders/sceneValidation';

const Q = 'cccccccc-0000-4000-8001-000000000001';
const doc = (over: Record<string, unknown> = {}) => ({
  id: Q, version: 5, rootLocalId: 1,
  entities: [{ localId: 1, name: 'QR', traits: { EntityAttributes: { name: 'QR', parentId: 0, guid: '' } } }],
  ...over,
});
const warnings = (embeddedPrefabs: unknown) =>
  validateSceneData({ version: 19, entities: [], ...(embeddedPrefabs === undefined ? {} : { embeddedPrefabs }) }).warnings;

describe('embeddedPrefabs validation (#1867)', () => {
  it('a scene without copies, and a well-formed copy, validate clean', () => {
    expect(warnings(undefined)).toEqual([]);
    expect(warnings({ [Q]: doc() })).toEqual([]);
  });

  it('names a copy that is not a prefab document, a key that is not a guid, and an id that is not its key', () => {
    // Mutation: drop `embeddedPrefabWarnings` from `validateSceneData` — every expectation below reads [].
    expect(warnings([doc()])).toEqual(['embeddedPrefabs is not an object keyed by prefab guid — the loader ignores it']);
    expect(warnings({ [Q]: { id: Q } })).toEqual([`embeddedPrefabs['${Q}']: not a prefab document (no \`entities\` array) — the loader ignores it`]);
    expect(warnings({ 'Q.prefab.json': doc({ id: undefined }) })).toEqual([
      "embeddedPrefabs['Q.prefab.json']: the key is not a prefab guid, so no reference can name this copy",
    ]);
    const other = 'cccccccc-0000-4000-8002-000000000001';
    expect(warnings({ [Q]: doc({ id: other }) })).toEqual([`embeddedPrefabs['${Q}']: the copy's id is "${other}", not its key`]);
  });

  it('checks each copy as a prefab document, labelled with its key', () => {
    // Mutation: drop the `validatePrefabData` line — the entity warning is not reported.
    expect(warnings({ [Q]: doc({ entities: [null] }) })).toEqual([
      `embeddedPrefabs['${Q}']: entities[0] is null, not an entity object — it was not checked`,
    ]);
  });

  it('reads a copy\'s nested prefabs as the load does — the project\'s file, then the scene\'s copy — so a readable one is not reported', () => {
    // Hunt seed 6136: a copy of O, whose row N nests P, read with no reader reported P "could not be read" on every save.
    // Mutation: call `validatePrefabData(doc)` with no reader — both clean cases below report P unread.
    const P = 'cccccccc-0000-4000-8002-000000000001';
    const pDoc = { id: P, version: 5, rootLocalId: 1, entities: [{ localId: 1, name: 'R', nodeGuid: 'eeeeeeee-0000-4000-8003-000000000001', traits: { EntityAttributes: { name: 'R', parentId: 0, guid: '' } } }] };
    const oDoc = doc({ entities: [
      { localId: 1, name: 'OR', nodeGuid: 'eeeeeeee-0000-4000-8001-000000000001', traits: { EntityAttributes: { name: 'OR', parentId: 0, guid: '' } } },
      { localId: 2, name: 'N', nodeGuid: 'eeeeeeee-0000-4000-8002-000000000001', prefab: P, traits: { EntityAttributes: { name: 'N', parentId: 1, guid: '' } },
        added: [{ parentLocalId: 1, guid: '', key: 'k-x', name: 'X', traits: { EntityAttributes: { name: 'X', parentId: 0 } }, children: [] }] },
    ] });
    const scene = (embeddedPrefabs: unknown, getPrefab?: (g: string) => unknown) =>
      validateSceneData({ version: 19, entities: [], embeddedPrefabs }, undefined, getPrefab).warnings;
    const unread = scene({ [Q]: oDoc });
    expect(unread).toEqual([expect.stringMatching(new RegExp(`^embeddedPrefabs\\['${Q}'\\]: .*could not be read$`))]);
    expect(scene({ [Q]: oDoc }, (g) => (g === P ? pDoc : undefined))).toEqual([]);
    expect(scene({ [Q]: oDoc, [P]: pDoc })).toEqual([]);
  });
});
