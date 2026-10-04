/** #1909 (d) — a no-op rebuild of an entry leaves a Missing Prefab placeholder inside it a placeholder, when the same
 *  entry also holds a LIVE frame of that prefab whose record could expand it (`withFrameRecords`' placeholder block,
 *  prefabRebuild.ts).
 *
 *  ⚠️ No gesture found reaches this state since #2146, and no load does (a load shows every frame of a missing prefab as
 *  its placeholder), so the state is BUILT: two P instances placed under H1's root (scene-added reference nodes), the
 *  second deleted, P trashed (#2056: the first shows as its placeholder at once, the undo stack kept), and the delete
 *  undone with the conversion that undo now runs SUPPRESSED (`suppressConversion` below), so the second comes back as a
 *  live P frame. Before #2144's ruling (B) a paste reached it, and before #2146 this undo did; both now show the
 *  placeholder. The block is kept, not deleted (hub, 2026-10-05). H's template has no P row, so no unexpanded row of H1
 *  blocks P's record on its own: only the placeholder does. Without that block the rebuild read P from the live frame's
 *  record and EXPANDED the placeholder, which a reload of the same scene leaves a placeholder (ruling R, #1849).
 *  Mutation: drop the `if (placeholder)` block in `withFrameRecords` — the placeholder's R gains P's members (QR, M, A)
 *  and the rebuild is no longer the identity.
 *
 *  Driven through the prefab fuzzer's harness: the real backend route, SceneManager, both caches and the undo stack. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
/** While set, the conversion a delete's undo asks for (#2146) does nothing: the only way left to build this state. */
let suppressConversion = false;
vi.mock('../../packages/modoki/src/editor/scene/deletedPrefabsMissing', async (orig) => {
  const real = await orig<typeof import('../../packages/modoki/src/editor/scene/deletedPrefabsMissing')>();
  return { ...real, showDeletedPrefabsMissing: () => (suppressConversion ? Promise.resolve() : real.showDeletedPrefabsMissing()) };
});
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored, piOf, worldTree } from './prefabFuzz/harness';
import { deleteAssetFiles, deletionPathsFor, planDeleteOutcome } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { deleteEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { deletedPrefabsShown } from '../../packages/modoki/src/editor/scene/deletedPrefabsMissing';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { refreshInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { unresolvedRefOf } from '../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { frameRootDoc } from '../../packages/modoki/src/runtime/core/ecs/identityParents';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const isUnder = (id: number, ancestor: number) => {
  for (let p = authored().find((x) => x.id === id)?.parentId ?? 0; p; p = authored().find((x) => x.id === p)?.parentId ?? 0) if (p === ancestor) return true;
  return false;
};
/** The world by guid, keys sorted: a rebuild respawns entities, and only their content is compared. */
const tree = () => Object.fromEntries(Object.entries(worldTree()).sort(([a], [b]) => a.localeCompare(b)));

describe("an entry's no-op rebuild leaves a placeholder inside it a placeholder, beside a live frame of its prefab (#1909 d)", () => {
  it('placeholder of P and a live P frame under H1: the rebuild is the identity', async () => {
    const f = await startRun(be, async () => {}, 'placeholder-guard-1909');
    const rootsOf = (src: string) => authored().filter((e) => { const pi = piOf(e.id); return pi?.source === src && pi.rootInstanceId === e.id; });
    const h1 = () => rootsOf(f.prefabs.H.guid).find((e) => e.parentId === 0)!;
    // Two P nodes under H1's root; the second is deleted, P trashed (its instances shown as placeholders at once, #2056,
    // the undo stack kept), and the delete undone with its conversion suppressed: the second comes back a live P frame.
    await placePrefabFromPath(f.prefabs.P.path, { tag: 'test', parentId: h1().id });
    await settle();
    await placePrefabFromPath(f.prefabs.P.path, { tag: 'test', parentId: h1().id });
    await settle();
    const second = rootsOf(f.prefabs.P.guid).filter((e) => isUnder(e.id, h1().id)).sort((x, y) => y.id - x.id)[0]!;
    deleteEntitiesWithUndo([second.id]);
    await settle();
    const paths = deletionPathsFor(f.prefabs.P.path, 'prefab', null);
    const del = await deleteAssetFiles(paths);
    expect(del.ok, 'premise: P is trashed').toBe(true);
    unbindDeletedAssetEditors(planDeleteOutcome(paths, [f.prefabs.P.path], del.failed).went);
    await deletedPrefabsShown();
    await settle();
    const placeholders = () => authored().filter((e) => isUnder(e.id, h1().id) && unresolvedRefOf(findEntity(e.id) as never)?.source === f.prefabs.P.guid);
    expect(placeholders(), 'premise: the node under H1 is a placeholder of P').toHaveLength(1);
    suppressConversion = true;
    try {
      expect((await undoStep('undo')).did, 'premise: the delete undoes').toBe(true);
      await deletedPrefabsShown();
      await settle();
    } finally { suppressConversion = false; }
    const live = rootsOf(f.prefabs.P.guid).filter((e) => isUnder(e.id, h1().id));
    expect(live, 'premise: the undone delete is a live P frame').toHaveLength(1);
    expect(frameRootDoc(getCurrentWorld(), findEntity(live[0]!.id)!)?.source, 'premise: which holds P\'s record').toBe(f.prefabs.P.guid);

    const before = tree();
    const hDoc = getCachedPrefabSync(f.prefabs.H.guid)!;
    refreshInstances(f.prefabs.H.guid, [h1().id], hDoc, hDoc);
    await settle();
    expect(placeholders()).toHaveLength(1);
    expect(tree()).toEqual(before);
  });
});
