/** #2061 (the first ops of #2058's hunt seed 7393) — place P, trash Q (P's nested prefab: its part of the instance shows
 *  as a row placeholder at once, #2056), undo the placement, redo it. P is dropped inside another instance (O1), as the
 *  hunt's agent drop was; at the top level the fresh spawn happened to agree with the records. The redo respawned P FRESH from its document, so
 *  the placeholder took P's row name ("C"), while the instance's record (the one the undo found) names it from the row it
 *  keeps ("QR"): live and record disagreed, and the next rebuild renamed it. The redo now puts back the records its undo
 *  took and shows the tree from them (rule 8).
 *
 *  Driven through the prefab fuzzer's harness, on its fixture. Mutation: drop the `restoreSide` in
 *  `makePrefabInstantiateAction`'s redo (`prefabInstantiateUndo.ts`) → the redo shows the fresh "C" where the undo found
 *  "QR". (The fuzz's no-op rebuild then renamed it back from the record its reload kept; this fixture's rebuild does not,
 *  so the comparison with the world before the undo is the assertion that fails.) */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored, piOf, worldTree, flushWatcher } from './prefabFuzz/harness';
import { deleteAssetFiles, deletionPathsFor } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { deletedPrefabsShown } from '../../packages/modoki/src/editor/scene/deletedPrefabsMissing';
import { runAgentOp } from '../../app/debug/agentBridge';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { refreshInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { frameRootDoc } from '../../packages/modoki/src/runtime/core/ecs/identityParents';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { whyWorldNotAuthored } from '../../packages/modoki/src/editor/scene/authoredWorld';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

/** The world by guid, keys sorted: a rebuild respawns entities, and only their content is compared. */
const tree = () => Object.fromEntries(Object.entries(worldTree()).sort(([a], [b]) => a.localeCompare(b)));

describe('#2061: the redo of an instantiate after its nested prefab was trashed shows the tree its records state', () => {
  it('place P inside O1, trash Q, save and reopen, undo, redo: the world is the one the undo found, and a rebuild changes nothing', async () => {
    const f = await startRun(be, async () => {}, 'instantiate-redo-nested-trash');
    // Dropped INSIDE another instance, as the hunt's agent drop was: under A, a member of O1's nested P frame (N).
    const roots = () => authored().filter((e) => piOf(e.id)?.source === f.prefabs.P.guid && piOf(e.id)?.rootInstanceId === e.id);
    const before = new Set(roots().map((e) => e.guid));
    const n = roots().find((e) => e.parentId !== 0)!;
    const a = authored().find((e) => e.name === 'A' && piOf(e.id)?.rootInstanceId === n.id)!;
    // The agent's drop (`modoki_prefab {action:'instantiate'}`), the hunt's op.
    await runAgentOp('prefab', { action: 'instantiate', path: f.prefabs.P.path, parentGuid: a.guid });
    await settle();
    const placed = roots().find((e) => !before.has(e.guid))!;
    expect(placed, 'premise: P placed').toBeTruthy();

    const snap = be.snapshot();
    expect((await deleteAssetFiles(deletionPathsFor(f.prefabs.Q.path, 'prefab', null))).ok, 'premise: Q is trashed').toBe(true);
    unbindDeletedAssetEditors([f.prefabs.Q.path]);
    await deletedPrefabsShown();
    await flushWatcher(be, snap);
    await settle();
    // Saved and reopened: the reload stores the instance's record from the file, which names the missing row from the row
    // the scene keeps for it ("QR"). The undo stack is the scene's, and survives the reload.
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    const left = tree();

    expect((await undoStep('undo')).did, 'undo the placement').toBe(true);
    await settle();
    expect(authored().some((e) => e.guid === placed.guid), 'premise: the undo removed it').toBe(false);
    expect((await undoStep('redo')).did, 'redo the placement').toBe(true);
    await settle();
    const again = authored().find((e) => e.guid === placed.guid)!;
    expect(again, 'the redo places it again, under its guid').toBeTruthy();

    // The redo restores the state the step left (rule 8): the placeholder is named as the record names it ("QR"), not
    // from P's row ("C") as a fresh spawn of the document names it.
    expect(tree(), 'the redo restores the world the undo found').toEqual(left);
    const shown = tree();
    // The rebuild a rebase runs on a frame whose template did not change (the fuzz's no-op rebuild check).
    const doc = getCachedPrefabSync(f.prefabs.P.guid)!;
    const from = (frameRootDoc(getCurrentWorld(), findEntity(again.id)!)?.doc ?? doc) as typeof doc;
    refreshInstances(f.prefabs.P.guid, [again.id], from, doc);
    await settle();
    expect(tree(), 'a rebuild of the redone instance is the identity').toEqual(shown);
    expect(whyWorldNotAuthored()).toBeNull();
  }, 120_000);
});
