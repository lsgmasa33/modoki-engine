/** #2001 S6: an editor from before the instance model REFUSES a scene this build saves, and writes nothing over it.
 *
 *  Scene format v20 keeps an instance's records on its rows (the root's on `"/"`), which a v19 build would read as
 *  rows it does not know and drop at its next save. The version bump is what stops that: the older build's gate
 *  (`sceneFormatGate.ts`, unchanged by S6) compares the file's version with its own constant.
 *
 *  The older build is this tree's gate with the scene constant it shipped with: `SCENE_FORMAT_VERSION` mocked to the
 *  capture form's version (19). The file is stamped with the REAL constant, read past the mock.
 *
 *  Mutation: set the real `SCENE_FORMAT_VERSION` back to 19 (`version.ts`) — the file is stamped 19, the gate reads it,
 *  and the load is 'loaded'. */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../packages/modoki/src/runtime/core/version', async (orig) => {
  const real = await orig<typeof import('../../packages/modoki/src/runtime/core/version')>();
  return { ...real, SCENE_FORMAT_VERSION: real.CAPTURE_FORM_SCENE_VERSION };
});

import { getAllEntities } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, settle } from './prefabFuzz/harness';
import { ROOT_URL } from './prefabFuzz/backend';
import { loadSceneReporting, getLastSceneLoadFailureMessage } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

describe('#2001 S6: a build from before scene v20 refuses a v20 scene', () => {
  it('the load is refused with the version named, nothing is spawned, and the file is left as it was', async () => {
    const real = await vi.importActual<typeof import('../../packages/modoki/src/runtime/core/version')>('../../packages/modoki/src/runtime/core/version');
    expect(real.SCENE_FORMAT_VERSION, 'premise: this build writes a newer scene format than the capture form').toBeGreaterThan(real.CAPTURE_FORM_SCENE_VERSION);
    const P = 'cccccccc-0000-4000-8000-000000002001';
    const scene = {
      id: 'aaaaaaaa-0000-4000-8000-000000002001', version: real.SCENE_FORMAT_VERSION, name: 'V20', createdAt: '2026-01-01T00:00:00.000Z', resources: [],
      entities: [
        { name: 'Plain', traits: { EntityAttributes: { name: 'Plain', parentId: '', guid: 'dddddddd-0000-4000-8000-000000002001' } } },
        // An instance entry as this build's save writes it: placement on the entry, the records on its rows.
        { name: 'R', traits: { EntityAttributes: { sortOrder: 1 } }, prefab: P, guid: 'dddddddd-0000-4000-8000-000000002002',
          members: { '/': { traits: { EntityAttributes: { name: 'R' }, Transform: { x: 3 } } } } },
      ],
    };
    const path = `${ROOT_URL}/v20/scenes/V20.json`;
    const bytes = `${JSON.stringify(scene, null, 2)}\n`;
    be.write(path, bytes);
    registerAsset(scene.id, path, 'scene');

    const report = await loadSceneReporting(path);
    await settle();
    expect(report.outcome).toBe('refused');
    expect(getLastSceneLoadFailureMessage()).toBe(
      `Scene not loaded: its format version (${real.SCENE_FORMAT_VERSION}) is newer than this engine supports (${real.CAPTURE_FORM_SCENE_VERSION}). Update the engine to open this scene.`,
    );
    expect(getAllEntities().some((e) => e.name === 'Plain')).toBe(false);
    expect(be.read(path)).toBe(bytes);
  });
});
