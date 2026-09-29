/** #1820 close-out review — Create Prefab's undo re-links the tree and REBASES it onto its template's current document
 *  (`rebaseStaleInstancesSoon`). When that template changed after the create (a saved prefab edit that added a child), the
 *  rebased tree no longer has the rows the create wrote, and the redo tagged nothing while it reported success
 *  (`[Prefab] not tagging … (3 rows now vs 2 written)`), set `tagged` anyway, and the next undo then refused. The redo now
 *  refuses whenever its undo rebased (the undo records it), before anything is written or linked — in shape or in value.
 *
 *  Driven through the prefab fuzzer's harness: the real backend route over a scratch directory, SceneManager, both prefab
 *  caches, prefab edit's world swaps and the undo stack. The fuzzer's own ops rarely reach the shape — Create Prefab on an
 *  instance ROOT (which unpacks it, #1814), then a saved edit of the SOURCE template under one of its members — so it is
 *  driven directly. Mutations: never refuse → the first case goes red (the redo reports did=true and logs "not tagging");
 *  always refuse → the second (accept) case goes red. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';

// The OS trash, stubbed to delete from the scratch directory, as prefabFuzz.test.ts does.
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored, piOf, type Fixture } from './prefabFuzz/harness';
import { pushAction } from '@modoki/engine/editor';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { emptySpecs } from '../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { findEntityByGuid } from '../../packages/modoki/src/runtime/core/ecs/world';
import { getAllEntities } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const errors: string[] = [];
const realError = console.error;
afterEach(() => { console.error = realError; });

/** Q dropped at the scene root and saved as NewP (an instance root: the create unpacks it). */
async function createdFromQ(key: string): Promise<{ f: Fixture; rootGuid: string; target: string; newP: string }> {
  errors.length = 0;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
  const f = await startRun(be, async () => {}, key);
  const qId = await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: 0 });
  await settle();
  expect(qId).toBeTruthy();
  const rootGuid = authored().find((e) => e.id === qId)!.guid!;
  const r = await createPrefabFromEntity(qId!, `${f.root}/prefabs/NewP.prefab.json`, 'Save prefab "QR"', async () => false);
  if (!r || r === 'declined' || 'refused' in r) throw new Error(`create: ${r && r !== 'declined' ? r.refused : r}`);
  pushAction(r.action);
  await settle();
  const newP = (JSON.parse(be.snapshot().get(r.savePath)!) as { id: string }).id;
  return { f, rootGuid, target: r.savePath, newP };
}

/** Q's root QR gains a child Z in prefab edit, saved. */
async function addChildToQ(f: Fixture): Promise<void> {
  expect(await openPrefabForEditing({ path: f.prefabs.Q.path, name: 'Q' }, { confirmDiscard: async () => true })).toBeFalsy();
  const qr = authored().find((e) => e.name === 'QR')!;
  const { specs } = emptySpecs(qr.id);
  createEntityWithUndo('Create Z', qr.id, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name: 'Z' } } : s)), () => {});
  expect((await savePrefabEditReport({})).saved).toBe(true);
  await exitPrefabEditing();
  await settle();
}

const sourceOf = (guid: string) => { const e = findEntityByGuid(guid); return e ? piOf(e.id())?.source : undefined; };
const childNames = (guid: string) => {
  const e = findEntityByGuid(guid);
  return e ? getAllEntities().filter((c) => c.parentId === e.id()).map((c) => c.name).sort() : [];
};

describe("Create Prefab's redo after its undo rebased the tree (#1820)", () => {
  it('the template changed since the create: the redo REFUSES before anything is written, and the undone state stands', async () => {
    const { f, rootGuid, target } = await createdFromQ('redo-after-rebase-changed');
    const fileBefore = be.snapshot().get(target);
    await addChildToQ(f);

    const u = await undoStep('undo');
    await settle();
    expect(u.did).toBe(true);
    // The undo re-linked the tree to Q and rebased it onto Q's current document: it holds Z now.
    expect(sourceOf(rootGuid)).toBe(f.prefabs.Q.guid);
    expect(childNames(rootGuid)).toEqual(['M', 'Z']);

    const r = await undoStep('redo');
    await settle();
    // An UndoRefusedError reaches the step as a failure marked `refused`, with nothing applied.
    expect(r.did).toBe(false);
    expect(r.failed?.refused).toBe(true);
    expect(errors.filter((m) => m.includes('not tagging'))).toEqual([]);
    expect(sourceOf(rootGuid)).toBe(f.prefabs.Q.guid);
    expect(childNames(rootGuid)).toEqual(['M', 'Z']);
    expect(be.snapshot().get(target)).toBe(fileBefore); // nothing written
  }, 120_000);

  it('the accept side — no template change: the redo re-links the tree to NewP', async () => {
    const { rootGuid, newP } = await createdFromQ('redo-after-rebase-unchanged');
    const u = await undoStep('undo');
    await settle();
    expect(u.did).toBe(true);
    expect(sourceOf(rootGuid)).not.toBe(newP);

    const r = await undoStep('redo');
    await settle();
    expect(r.did).toBe(true);
    expect(r.failed).toBeFalsy();
    expect(errors.filter((m) => m.includes('not tagging'))).toEqual([]);
    expect(sourceOf(rootGuid)).toBe(newP);
  }, 120_000);
});
