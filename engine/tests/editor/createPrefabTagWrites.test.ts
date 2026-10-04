/** #1830 — Create Prefab's undo restores only what its tag OVERWROTE, and the tag leaves nothing it did not write
 *  (`tagCreatedPrefab`). The fuzzer's REGRESSIONS (`prefabFuzz/knownOpen.ts`, issue 1830) carry one repro per symptom;
 *  these are the halves the fuzzer does not pin:
 *
 *  - A frame the tag RELINKED gets its record back with its links (#1665 close-out). Create Prefab on an instance root
 *    relinks it to the new prefab and records the new document; the undo puts the old links back, and only the snapshot
 *    knows which document they index. Mutation: drop the frame of a relinked root too (`writes.get(l.id) === 'link' &&
 *    frame` → `(l)`) — the unpack case goes red. The Replace case holds either way (the Replace's in-memory restore
 *    re-records the old document itself); it pins the outcome the #1665 re-review asked for.
 *  - The redo refuses when a frame its undo RELINKED was rebuilt since (the close-out review's repro): a saved prefab
 *    edit of the template the undo put back changes the tree's values, and linked anyway those values sat on rows
 *    written with the old ones, so a Save + reload reverted them. Mutation: `relinkedFramesCheck`'s check always null —
 *    red.
 *
 *  Driven through the prefab fuzzer's harness: the real backend route, SceneManager, both caches and the undo stack. */

import { describe, it, expect, vi } from 'vitest';
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
import { boot, bridge, memoryStorage, startRun, settle, authored, getCurrentWorld } from './prefabFuzz/harness';
import { pushAction } from '@modoki/engine/editor';
import { getTraitByName } from '@modoki/engine/runtime';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { emptySpecs } from '../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { createEntityWithUndo, writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { frameRootDoc } from '../../packages/modoki/src/runtime/core/ecs/identityParents';
import { findEntityByGuid } from '../../packages/modoki/src/runtime/core/ecs/world';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { piOf } from './prefabFuzz/harness';
import { overrideKeysOf } from '../../packages/modoki/src/editor/instance/instanceOverrideView';
import { templateKeyOf } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { findEntityById as findEntity } from '../../packages/modoki/src/runtime/core/ecs/world';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

/** The document a frame root's record says it was expanded from: its id, and its row count. */
const recordedId = (guid: string) => {
  const e = findEntityByGuid(guid);
  return e ? (frameRootDoc(getCurrentWorld(), e)?.doc as { id?: string } | undefined)?.id : undefined;
};
const recordedRows = (guid: string) => {
  const e = findEntityByGuid(guid);
  return e ? (frameRootDoc(getCurrentWorld(), e)?.doc as { entities?: unknown[] } | undefined)?.entities?.length : undefined;
};

describe("Create Prefab's tag and its undo (#1830)", () => {
  it("Create Prefab on an instance ROOT (it unpacks it, #1814): the undo puts the root's record of the OLD prefab back", async () => {
    const f = await startRun(be, async () => {}, 'tagWrites-unpack');
    const qId = await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: 0 });
    await settle();
    const rootGuid = authored().find((e) => e.id === qId)!.guid!;
    expect(recordedId(rootGuid)).toBe(f.prefabs.Q.guid);
    const r = await createPrefabFromEntity(qId!, `${f.root}/prefabs/NewQ.prefab.json`, 'Save prefab "QR"', async () => false);
    if (!r || r === 'declined' || 'refused' in r) throw new Error(`create: ${r && r !== 'declined' ? r.refused : r}`);
    pushAction(r.action);
    await settle();
    expect(recordedId(rootGuid)).toBe(r.prefab.id);
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(recordedId(rootGuid)).toBe(f.prefabs.Q.guid);
  });

  it("a Replace over the tree's own prefab: the undo puts the relinked root's OLD record back with its links", async () => {
    const f = await startRun(be, async () => {}, 'tagWrites-replace');
    const qId = await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: 0 });
    await settle();
    const rootGuid = authored().find((e) => e.id === qId)!.guid!;
    const v1Rows = recordedRows(rootGuid)!;
    // A child the Replace writes as a new row, so v2 has one row more than v1.
    const { specs } = emptySpecs(qId!);
    createEntityWithUndo('Create Z', qId!, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name: 'Z' } } : s)), () => {});
    const r = await createPrefabFromEntity(qId!, f.prefabs.Q.path, 'Save prefab "QR"', async () => true);
    if (!r || r === 'declined' || 'refused' in r) throw new Error(`replace: ${r && r !== 'declined' ? r.refused : r}`);
    pushAction(r.action);
    await settle();
    expect(recordedRows(rootGuid)).toBe(v1Rows + 1);
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(recordedRows(rootGuid)).toBe(v1Rows);
  });

  it("a saved prefab edit after the undo changed a relinked frame: the redo REFUSES, and the tree stays on its template", async () => {
    const f = await startRun(be, async () => {}, 'tagWrites-relinked');
    const qId = await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: 0 });
    await settle();
    const rootGuid = authored().find((e) => e.id === qId)!.guid!;
    const r = await createPrefabFromEntity(qId!, `${f.root}/prefabs/NewQ.prefab.json`, 'Save prefab "QR"', async () => false);
    if (!r || r === 'declined' || 'refused' in r) throw new Error(`create: ${r && r !== 'declined' ? r.refused : r}`);
    pushAction(r.action);
    await settle();
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    // Q's M gains a new value in prefab edit, saved: the relinked tree is rebuilt onto it.
    expect(await openPrefabForEditing({ path: f.prefabs.Q.path, name: 'Q' }, { confirmDiscard: async () => true })).toBeFalsy();
    const m = authored().find((e) => e.name === 'M')!;
    expect(writeTraitFieldWithUndo(m.id, getTraitByName('Transform')!, 'x', 5)).toBeFalsy();
    expect((await savePrefabEditReport({})).saved).toBe(true);
    await exitPrefabEditing();
    await settle();
    const redo = await undoStep('redo');
    // A refusal (`UndoRefusedError`: nothing applied), not a shortfall.
    expect(redo.did).toBe(false);
    expect(redo.failed?.refused).toBe(true);
    expect(redo.failed?.error).toMatch(/changed since/);
    const root = findEntityByGuid(rootGuid)!;
    expect(piOf(root.id())?.source).toBe(f.prefabs.Q.guid);
  });

  // The same over a Replace of ANOTHER prefab (the second close-out review): the tree was an instance of Q, and the Replace
  // wrote it over H. The Replace's in-memory precondition asks only after H. Mutation: drop the capture in the Replace
  // undo's rebuild — the redo re-links, and a reload reverts M to 1.
  it("a Replace over another prefab, then a saved edit of the template its undo put back: the redo REFUSES", async () => {
    const f = await startRun(be, async () => {}, 'tagWrites-relinked-replace');
    const qId = await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: 0 });
    await settle();
    const rootGuid = authored().find((e) => e.id === qId)!.guid!;
    const r = await createPrefabFromEntity(qId!, f.prefabs.H.path, 'Save prefab "QR"', async () => true);
    if (!r || r === 'declined' || 'refused' in r) throw new Error(`replace: ${r && r !== 'declined' ? r.refused : r}`);
    pushAction(r.action);
    await settle();
    expect(piOf(findEntityByGuid(rootGuid)!.id())?.source, 'premise: a Replace of H').toBe(f.prefabs.H.guid);
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(await openPrefabForEditing({ path: f.prefabs.Q.path, name: 'Q' }, { confirmDiscard: async () => true })).toBeFalsy();
    const m = authored().find((e) => e.name === 'M')!;
    expect(writeTraitFieldWithUndo(m.id, getTraitByName('Transform')!, 'x', 5)).toBeFalsy();
    expect((await savePrefabEditReport({})).saved).toBe(true);
    await exitPrefabEditing();
    await settle();
    const redo = await undoStep('redo');
    expect(redo.did).toBe(false);
    expect(redo.failed?.refused).toBe(true);
    expect(redo.failed?.error).toMatch(/changed since/);
    expect(piOf(findEntityByGuid(rootGuid)!.id())?.source).toBe(f.prefabs.Q.guid);
  });

  // Hunt seed 3297 (#1914 R6): a scene-added reference node's root records its sibling order (F7), and a load STORES that
  // record (the root's guid is not durable yet when the overrides apply). Create Prefab then makes the node a row of the
  // new template — a nested row (P, stamped) or that row's added node (Q, keyed by the capture) — which states its place,
  // so a reload reads no record of it; the stored mark stayed, and save → reload was not the identity. Since #2001 S8b the
  // order record is the role's (`recordsRootOrder`), so it goes with the role. Held twice, so one mutation alone stays
  // green (measured): the view asks the rule only for a record's root row (`recordedFieldsOf`), and the rule asks
  // `isStoredRoot` and the template key. Mutation: the view asks it for every member AND the rule drops both checks — red.
  it('Create Prefab takes the sibling-order record off the nodes it makes rows of the new template', async () => {
    const f = await startRun(be, async (fx) => {
      const plain = authored().find((e) => e.name === 'Plain')!;
      const pId = await placePrefabFromPath(fx.prefabs.P.path, { tag: 'test', parentId: plain.id });
      await settle();
      const a = authored().find((e) => e.name === 'A' && piOf(e.id)?.rootInstanceId === pId)!;
      await placePrefabFromPath(fx.prefabs.Q.path, { tag: 'test', parentId: a.id });
      await settle();
    }, 'tagWrites-rootOrder');
    const plain = authored().find((e) => e.name === 'Plain')!;
    // By where they sit: the fixture's other instances hold an R and a QR too. Read afresh, as a reload re-spawns them.
    const child = (parentId: number | undefined, name: string) => authored().find((e) => e.parentId === parentId && e.name === name);
    const rootOf = (name: 'R' | 'QR') => {
      const r = child(authored().find((e) => e.name === 'Plain')!.id, 'R')!;
      return name === 'R' ? r : child(child(r.id, 'A')?.id, 'QR')!;
    };
    const ordered = (name: 'R' | 'QR') => [...(overrideKeysOf(findEntity(rootOf(name).id)!) ?? [])].includes('EntityAttributes.sortOrder');
    expect([ordered('R'), ordered('QR')], 'premise: both scene-placed roots record their order').toEqual([true, true]);
    const r = await createPrefabFromEntity(plain.id, `${f.root}/prefabs/NewPlain.prefab.json`, 'Save prefab "Plain"', async () => false);
    if (!r || r === 'declined' || 'refused' in r) throw new Error(`create: ${r && r !== 'declined' ? r.refused : r}`);
    pushAction(r.action);
    await settle();
    expect(templateKeyOf(findEntity(rootOf('QR').id)), 'premise: the capture keyed the scene-added Q').toBeTruthy();
    expect([ordered('R'), ordered('QR')]).toEqual([false, false]);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect([ordered('R'), ordered('QR')]).toEqual([false, false]);
  });
});
