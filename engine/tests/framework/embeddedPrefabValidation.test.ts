/** #1914 F8 / #1867, owner ruling B (design § 5.4, #1940): a scene's copies of missing prefabs (`embeddedPrefabs`, scene
 *  v19) are read by nothing — a missing prefab's instance loads as its placeholder — and dropped by the next save. The
 *  validator names each as that backup, whatever its shape, so an agent neither reads the instance as loading from it nor
 *  loses the last record of a deleted prefab unwarned. Before, it checked each copy as the document the load expanded. */

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
const backup = (g: string) => `embeddedPrefabs['${g}']: this scene holds a backup of prefab ${g} that is no longer used; it will be dropped at the next save. Restore the prefab from version control if you need it`;

describe('embeddedPrefabs validation (#1867, owner ruling B)', () => {
  it('a scene without copies validates clean', () => {
    expect(warnings(undefined)).toEqual([]);
  });

  it('names each copy as a backup the next save drops, whatever its shape', () => {
    // Mutation: drop `embeddedPrefabWarnings` from `validateSceneData` — every expectation below reads [].
    expect(warnings({ [Q]: doc() })).toEqual([backup(Q)]);
    expect(warnings({ [Q]: { id: Q } }), 'not a document: still the user\'s backup').toEqual([backup(Q)]);
    const other = 'cccccccc-0000-4000-8002-000000000001';
    expect(warnings({ [Q]: doc(), [other]: doc({ id: other }) })).toEqual([backup(Q), backup(other)]);
    expect(warnings([doc()])).toEqual(['embeddedPrefabs: this scene holds backups of prefabs that are no longer used; they will be dropped at the next save. Restore a prefab from version control if you need it']);
  });
});
