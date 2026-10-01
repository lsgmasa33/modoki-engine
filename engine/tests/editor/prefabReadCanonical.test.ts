/** #1937 C-A: every editor read of a prefab's BYTES reads the document a seat would hold (`parsePrefabBytes`: admitted,
 *  then migrated), and the "is this file that document" test admits both sides (`prefabTextIsDocument`). Otherwise a
 *  keyless template node's minted key made a cache's document differ from the same file read raw: the prefab-edit save
 *  refused every keyless prefab as changed on disk, an undo's restore parked a raw document no Apply then recognised, and
 *  a keyless node with a legacy `UIAnchor.zIndex` minted one key at the seat and another here (the migration rewrites
 *  the node the seed is taken from). Found by the hub-requested sweep after 500971083. */

import { describe, it, expect } from 'vitest';
import { parsePrefabBytes, prefabTextIsDocument } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { admitPrefabDocument } from '../../packages/modoki/src/runtime/loaders/documentIdentity';
import { migrateUIAnchorZIndexStructured } from '../../packages/modoki/src/runtime/loaders/uiAnchorZIndexMigration';
import type { PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';

const G = 'cccccccc-0000-4000-8000-000000193790';
const node = (traits: Record<string, unknown>) => ({ parentLocalId: 2, guid: '', name: 'Loose', traits: { EntityAttributes: { name: 'Loose', parentId: 0 }, ...traits }, children: [] });
const fileOf = (traits: Record<string, unknown>) => ({
  id: G, version: 9, name: 'O', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'OR', nodeGuid: 'eeeeeeee-0000-4000-8000-000000193791', traits: { EntityAttributes: { name: 'OR', parentId: 0, guid: '' } } },
    { localId: 2, name: 'N', nodeGuid: 'eeeeeeee-0000-4000-8000-000000193792', prefab: 'cccccccc-0000-4000-8000-000000193799', traits: {}, added: [node(traits)] },
  ],
});
/** What a seat holds for `file`: admitted, then migrated (meshTemplateCache's fetch, the editor's fetchPrefabSource). */
const seated = (file: object): PrefabFile => {
  const a = admitPrefabDocument(structuredClone(file));
  const doc = ('doc' in a ? a.doc : file) as PrefabFile;
  for (const e of doc.entities) migrateUIAnchorZIndexStructured(e as never);
  return doc;
};
const keyOf = (doc: unknown) => (doc as { entities: Array<{ added?: Array<{ key?: string }> }> }).entities[1]!.added![0]!.key;

describe('one canonical read of a prefab\'s bytes (#1937 C-A)', () => {
  // Mutation: migrate before admitting in `parsePrefabBytes` — the legacy-zIndex node mints another key than the seat's.
  it('parsePrefabBytes mints the key the seat mints, a legacy zIndex on the node included', () => {
    for (const traits of [{ Transform: { x: 1 } }, { UIAnchor: { zIndex: 4 }, UIElement: {} }]) {
      const text = JSON.stringify(fileOf(traits));
      expect(keyOf(parsePrefabBytes(text)), JSON.stringify(traits)).toBe(keyOf(seated(fileOf(traits))));
      expect(keyOf(parsePrefabBytes(text))).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  // Mutations: `sameDocument` without admitting the file side — the raw bytes are not the cached document (the refused
  // prefab-edit save); without admitting `expected` — a raw parse (an undo's restore) is not the file.
  it('prefabTextIsDocument: the raw file is the seated document, and a raw document is the file, either way round', () => {
    const file = fileOf({ Transform: { x: 1 } });
    const text = `${JSON.stringify(file, null, 1)}\n`; // not the editor's own formatting, so no byte match
    expect(prefabTextIsDocument(text, seated(file))).toBe(true);
    expect(prefabTextIsDocument(text, structuredClone(file) as unknown as PrefabFile)).toBe(true);
    // The accept side's control: another document is not this file.
    expect(prefabTextIsDocument(text, seated(fileOf({ Transform: { x: 2 } })))).toBe(false);
  });
});
