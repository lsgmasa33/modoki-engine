/** #1873 S2 limit (b): a frame the in-place re-import leaves on another document than its file's is REPORTED, never left
 *  quietly. The rebase is stubbed to do nothing — the one way to hold a frame stale on purpose (the real rebase's refusals
 *  are rare shapes) — so this pins the report, not the rebase, which `prefabDiscardInPlace.test.ts` drives for real.
 *  Mutation: drop the `staleFrames` loop in `reimportPrefabsInPlace` → red (the frame goes unreported). */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../packages/modoki/src/editor/scene/prefabRebuild', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rebaseStaleInstances: async () => 0,
}));

import { createTestWorld, Transform, EntityAttributes, PrefabInstance, getCurrentWorld, registerAsset, type TestWorld } from '@modoki/engine/runtime';
import { noteFrameRootDoc } from '../../packages/modoki/src/runtime/core/ecs/identityParents';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { parkPrefab, clearDirtyAssets } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { reimportPrefabsInPlace, reimportOutsidePrefabChanges } from '../../packages/modoki/src/editor/scene/prefabReimport';
import { markSceneDirty, clearSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const X = 'cccccccc-0000-4000-8000-00000000187c';
const X_PATH = '/assets/prefabs/XR.prefab.json';
const doc = (y: number) => ({ id: X, version: 6, name: 'X', rootLocalId: 1, entities: [
  { localId: 1, name: 'XR', nodeGuid: 'eeeeeeee-0000-4000-8000-0000000018c1', traits: { EntityAttributes: { name: 'XR', parentId: 0, guid: '' }, Transform: { x: 0, y, z: 0 } } },
] });

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; clearDirtyAssets(); setPrefabCache(X, null); setPrefabCache(X_PATH, null); vi.unstubAllGlobals(); });

describe('reimportPrefabsInPlace reports what it could not rebase (#1873 S2)', () => {
  it('names a frame still built from the discarded document', async () => {
    game = createTestWorld({});
    registerAsset(X, X_PATH, 'prefab');
    vi.stubGlobal('fetch', async (u: string) => (String(u).endsWith(X_PATH)
      ? new Response(JSON.stringify(doc(0)), { status: 200 })
      : new Response('{}', { status: 404 })));
    const root = game.spawn(Transform(), EntityAttributes({ name: 'I1', guid: 'g-rep-i1' }));
    root.add(PrefabInstance({ source: X, localId: 1, rootInstanceId: root.id() }));
    noteFrameRootDoc(getCurrentWorld(), root, { source: X, doc: doc(5) as never });

    const rep = await reimportPrefabsInPlace([X_PATH]);

    expect(rep.reimported).toEqual([X_PATH]);
    expect(rep.notRebased).toEqual([expect.objectContaining({ entity: 'I1', guid: 'g-rep-i1', source: X })]);
  });

  // #1873 R1: what the in-place path could not reach reloads a CLEAN scene (a reload loses nothing there), and over unsaved
  // work is left to the user. Mutation: `needsReload` ignores the scene's state (always true) → the dirty half goes red;
  // always false → the clean half.
  it('an outside change it could not fully reach asks for a reload over a clean scene only', async () => {
    game = createTestWorld({});
    registerAsset(X, X_PATH, 'prefab');
    vi.stubGlobal('fetch', async (u: string) => (String(u).endsWith(X_PATH)
      ? new Response(JSON.stringify(doc(0)), { status: 200 })
      : new Response('{}', { status: 404 })));
    const spawn = () => {
      const root = game!.spawn(Transform(), EntityAttributes({ name: 'I1' }));
      root.add(PrefabInstance({ source: X, localId: 1, rootInstanceId: root.id() }));
      noteFrameRootDoc(getCurrentWorld(), root, { source: X, doc: doc(5) as never });
    };
    spawn();
    clearSceneDirty('g-dirty-scene');
    expect((await reimportOutsidePrefabChanges([X_PATH])).needsReload, 'clean').toBe(true);
    spawn();
    markSceneDirty('g-dirty-scene');
    try {
      const out = await reimportOutsidePrefabChanges([X_PATH]);
      expect(out.report.notRebased.length, 'premise: something was left').toBeGreaterThan(0);
      expect(out.needsReload, 'dirty: reported, not reloaded').toBe(false);
    } finally { clearSceneDirty('g-dirty-scene'); }
  });

  it('refuses to re-import a path that is still parked, and says so', async () => {
    game = createTestWorld({});
    parkPrefab(X_PATH, doc(5) as never, doc(0) as never);
    const rep = await reimportPrefabsInPlace([X_PATH]);
    expect(rep.reimported).toEqual([]);
    expect(rep.failed).toEqual([{ path: X_PATH, reason: expect.stringMatching(/still parked/) }]);
  });
});
