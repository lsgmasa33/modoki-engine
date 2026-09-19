/** The AGENT `prefab revert` op dirties the BASE scene that owns the instance (#1431).
 *
 *  Save All writes a base only when it is dirty, and a revert rebuilds the instance without any
 *  field edit that would mark it — so the op must pass `RevertResult.affectedScenes` as its undo
 *  action's `affectedScenes`. `rebuildKeepsSourceScene.test.ts` pins that the result names the base;
 *  this pins that the op actually hands it to the undo stack. (The dialog's twin is a `.tsx` and is
 *  not unit-tested by convention.) Driven the way production drives it: `runAgentOp` on the
 *  registered editor ops, with the real undo stack. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestWorld, type TestWorld, setPlayState, getTraitByName, writeTraitField, findEntity, getAllEntities,
} from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved, undo, redo } from '@modoki/engine/editor';
import { setPrefabCache, instantiatePrefab, setPrefabSource } from '../../packages/modoki/src/editor/scene/prefab';
import { markOverride } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
import { isSceneDirty, clearSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

const KIT = 'dddddddd-0000-4000-8000-00000000c431';
const BASE = 'cccccccc-0000-4000-8000-00000000c431';
const kit = {
  id: KIT, version: 3 as const, name: 'Kit', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'Kit', traits: { Transform: {}, EntityAttributes: { name: 'Kit', parentId: 0, guid: '' } } },
    { localId: 2, name: 'Slot', traits: { Transform: {}, EntityAttributes: { name: 'Slot', parentId: 1, guid: '' } } },
  ],
};

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
  clearSceneDirty(BASE);
  registerAsset(KIT, '/assets/prefabs/Kit.prefab.json', 'prefab');
  setPrefabCache(KIT, kit as never);
});
afterEach(() => { game?.dispose(); game = undefined; setPrefabCache(KIT, null); });

/** An instance of Kit whose Slot carries a marked `Transform.x` override, every entity stamped `scene`. */
function instanceIn(scene: string): string {
  const root = instantiatePrefab(kit as never, 0);
  setPrefabSource(root, KIT);
  const ea = getTraitByName('EntityAttributes')!;
  for (const e of getAllEntities()) writeTraitField(e.id, ea, 'sourceScene', scene);
  const slot = getAllEntities().find((e) => e.name === 'Slot')!.id;
  writeTraitField(slot, getTraitByName('Transform')!, 'x', 5);
  markOverride(findEntity(slot)!, 'Transform', 'x');
  writeTraitField(root, ea, 'guid', 'g-kit-root');
  return 'g-kit-root';
}

describe('agent prefab revert on a base\'s instance (#1431)', () => {
  // Mutation: delete `affectedScenes,` from the revert `pushAction` in agentEditorOps.ts.
  it('dirties the base on the revert, its undo and its redo', async () => {
    const guid = instanceIn(BASE);
    const res = await runAgentOp('prefab', { action: 'revert', entityGuid: guid }) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(isSceneDirty(BASE)).toBe(true);
    for (const step of [undo, redo]) {
      clearSceneDirty(BASE);
      await step();
      expect(isSceneDirty(BASE)).toBe(true);
    }
  });

  it('a primary instance dirties no base', async () => {
    const guid = instanceIn('');
    const res = await runAgentOp('prefab', { action: 'revert', entityGuid: guid }) as { ok: boolean };
    expect(res.ok).toBe(true); // a refused op would pass the next line trivially
    expect(isSceneDirty(BASE)).toBe(false);
  });
});
