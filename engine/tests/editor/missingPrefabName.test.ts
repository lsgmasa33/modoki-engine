/** #1873 L5: a live frame whose prefab was deleted is named by the PATH its file had, not a bare guid. The delete's
 *  pruned manifest no longer maps the guid (`resolveRef` answers nothing), and the Revert dialog and the agent `revert`
 *  both showed `(<guid>)` — observed live on a kept nested frame. The prune remembers the path (`lastKnownPathOf`, #1834).
 *  Mutation: drop the `lastKnownPathOf` fallback in `missingPrefabInstance` → red (the guid is shown). */
import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, Transform, EntityAttributes, type TestWorld } from '@modoki/engine/runtime';
import { clearManifest, loadManifestJson, resolveRef } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { missingSourceRefusal } from '../../packages/modoki/src/editor/scene/prefabFrames';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const GUID = 'aaaaaaaa-0000-4000-8000-0000000018a5';
const PATH = '/assets/prefabs/Gone.prefab.json';
let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; clearManifest(); });

describe('a missing prefab is named by its path (#1873 L5)', () => {
  it('after the delete\'s prune, the refusal names the path the file had', () => {
    game = createTestWorld({});
    const root = game.spawn(Transform(), EntityAttributes({ name: 'QR', guid: 'g-l5-qr' }));
    loadManifestJson({ version: 1, assets: [{ guid: GUID, path: PATH, type: 'prefab' }] } as never, { prune: true });
    loadManifestJson({ version: 1, assets: [{ guid: 'aaaaaaaa-0000-4000-8000-0000000018a6', path: '/assets/prefabs/Other.prefab.json', type: 'prefab' }] } as never, { prune: true });
    expect(resolveRef(GUID), 'premise: the prune dropped the mapping').toBeFalsy();
    const text = missingSourceRefusal(root.id(), GUID, 'revert');
    expect(text).toContain(`(${PATH})`);
    expect(text).not.toContain(GUID);
  });
});
