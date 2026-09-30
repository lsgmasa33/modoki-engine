/** #1908 — Create Prefab's undo gives a node born AFTER the create the guid a reload gives (`rederiveUntaggedTree`).
 *
 *  The create swallows a P instance under Plain; a prefab-edit save of P then adds N under P's nested row C, so every P
 *  instance gains N, a template-keyed node, and the one under Plain derives its guid through the NEW prefab's frame. The
 *  create's undo reverses only the renames its stamp recorded, which N is not in: it kept the guid of a frame the undo
 *  removed, while a reload (and a no-op rebuild) derived it from the P instance that is a stored root again, so every
 *  ref to it dangled (hunt seed 7035, `prefabFuzz/knownOpen.ts` REGRESSIONS). Mutation: drop the `rederiveUntaggedTree`
 *  call from the create's undo (`assetOps.ts`) — red.
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
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored, piOf } from './prefabFuzz/harness';
import { pushAction } from '@modoki/engine/editor';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { emptySpecs } from '../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { templateKeyOf } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const isUnder = (id: number, ancestor: number) => {
  for (let p = authored().find((x) => x.id === id)?.parentId ?? 0; p; p = authored().find((x) => x.id === p)?.parentId ?? 0) if (p === ancestor) return true;
  return false;
};
const plainId = () => authored().find((e) => e.name === 'Plain')!.id;
/** The one N under Plain (the scene's own P1 gains one too). */
const nUnderPlain = () => {
  const hits = authored().filter((e) => e.name === 'N' && isUnder(e.id, plainId()));
  if (hits.length !== 1) throw new Error(`expected one N under Plain, found ${hits.length}`);
  return hits[0]!;
};

describe("Create Prefab's undo re-derives a node born after the create (#1908)", () => {
  // The create's undo, and a Replace's (its restore's rebuild runs the same call). Mutation per case: drop that branch's
  // `rederiveUntaggedTree` call in `assetOps.ts` — that case red.
  it.each([
    ['a create', (root: string) => `${root}/prefabs/NewPlain.prefab.json`, 'Save prefab "Plain"'],
    ['a Replace of H', (_root: string, hPath: string) => hPath, 'Save prefab "H"'],
  ] as const)('%s: N, added to a swallowed P by a prefab-edit save, has the guid a reload gives after the undo', async (_what, path, label) => {
    const f = await startRun(be, async () => {}, `rederive-1908-${label}`);
    await placePrefabFromPath(f.prefabs.P.path, { tag: 'test', parentId: plainId() });
    await settle();
    const r = await createPrefabFromEntity(plainId(), path(f.root, f.prefabs.H.path), label, async () => true);
    if (!r || r === 'declined' || 'refused' in r) throw new Error(`create: ${r && r !== 'declined' ? r.refused : r}`);
    pushAction(r.action);
    await settle();

    const refusal = await openPrefabForEditing({ path: f.prefabs.P.path, name: 'P' }, { confirmDiscard: async () => true });
    expect(refusal, 'premise: P opens for editing').toBeFalsy();
    // C, P's nested Q row: in the edit world its root is the one Q instance.
    const c = authored().find((e) => { const pi = piOf(e.id); return pi?.source === f.prefabs.Q.guid && pi.rootInstanceId === e.id; })!;
    const { specs } = emptySpecs(c.id);
    createEntityWithUndo('Create N', c.id, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name: 'N' } } : s)), () => {});
    await settle();
    expect((await savePrefabEditReport({})).saved, 'premise: the prefab-edit save lands').toBe(true);
    await exitPrefabEditing();
    await settle();
    expect(templateKeyOf(findEntity(nUnderPlain().id)), 'premise: N is a template-keyed node of P').toBeTruthy();
    const underCreate = nUnderPlain().guid;

    const u = await undoStep('undo');
    await settle();
    expect(u.label, "premise: that undo was the create's").toBe(label);
    expect(piOf(plainId()), 'premise: Plain is plain again').toBeFalsy();
    const live = nUnderPlain().guid;
    expect(live, 'the frame N was derived under is gone').not.toBe(underCreate);

    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(nUnderPlain().guid).toBe(live);
  });
});
