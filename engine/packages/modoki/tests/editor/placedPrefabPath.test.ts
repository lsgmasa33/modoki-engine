/** An Instantiate's redo finds the prefab it placed (#1868): an Assets Rename is not undoable, so the redo can run after
 *  the file moved — it resolves the placed document's guid, and falls back to the recorded path only when the manifest
 *  has no entry. And when that path now holds ANOTHER prefab (the placed one deleted, another renamed onto its name) it
 *  refuses rather than placing a different prefab under the step's label (#1868 close-out review, finding 1). */

import { describe, it, expect, afterEach } from 'vitest';
import { placedPrefabPath, placedPrefabRefusal } from '../../src/editor/scene/prefabPlace';
import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import { UndoRefusedError } from '../../src/editor/undo/undoFailure';

const G = 'aaaaaaaa-1868-4000-8000-000000000001';
afterEach(() => clearManifest());

describe('placedPrefabPath', () => {
  it('follows a Rename: the guid names the new path', () => {
    // Mutation: return the recorded path — this reads the old one.
    registerAsset(G, '/assets/prefabs/Renamed.prefab.json', 'prefab');
    expect(placedPrefabPath(G, '/assets/prefabs/A.prefab.json')).toBe('/assets/prefabs/Renamed.prefab.json');
  });

  it('falls back to the recorded path when the manifest has no entry, or the document had no id', () => {
    expect(placedPrefabPath(G, '/assets/prefabs/A.prefab.json')).toBe('/assets/prefabs/A.prefab.json');
    expect(placedPrefabPath(undefined, '/assets/prefabs/A.prefab.json')).toBe('/assets/prefabs/A.prefab.json');
  });
});

describe('placedPrefabRefusal', () => {
  it('refuses another prefab at the path, naming both', () => {
    // Mutation: drop the id comparison — no refusal, and the redo places B under "Instantiate A".
    const r = placedPrefabRefusal(G, { id: 'bbbbbbbb-1868-4000-8000-000000000002' }, '/assets/prefabs/A.prefab.json');
    expect(r).toBeInstanceOf(UndoRefusedError);
    expect(r!.message).toContain('bbbbbbbb-1868-4000-8000-000000000002');
    expect(r!.message).toContain(G);
  });

  it('accepts the placed prefab itself, and a placement whose document had no id', () => {
    expect(placedPrefabRefusal(G, { id: G }, '/p')).toBeNull();
    expect(placedPrefabRefusal(undefined, { id: 'x' }, '/p')).toBeNull();
    expect(placedPrefabRefusal(G, null, '/p')).toBeNull();
  });
});
