/** A template-added node whose ANCHOR member an inner prefab's edit deletes (#1872, and #2001 S6 for prefab v10).
 *
 *  O's row N (a P) adds nodes under P's member A. Which rule applies is decided by HOW the row names the anchor
 *  (docs/prefabs.md § Format rule):
 *
 *  - **A v10 row names it by identity** (`members["/<A's nodeGuid>"].own`). When A goes, the row's target is gone: the
 *    nodes are not shown, the row is kept by every writer, and they return with the member (B′, #1880 F3a). Before
 *    prefab v10 the row named A by localId and the load re-anchored the nodes to N's root (#1872's own cases, where the
 *    scene then pinned a whole `added` list over them); an editor-saved prefab no longer reaches that.
 *  - **A v9 row names it by localId** (`added[].parentLocalId`). A node whose localId names no row is re-anchored at the
 *    frame root, as it always was, and the first v10 save stores it on the `"/"` row, where it stays.
 *
 *  The whole-list fold #1872 fixed is still read (a v16 scene's `added` on a member row); its regression is the
 *  fuzzer's seed 6053 (`prefabFuzz/knownOpen.ts` REGRESSIONS).
 *
 *  Mutations (measured): the old row fold applying a row whose component names no member at the frame root
 *  (`foldMemberRowChannels`: `if (at) apply(…)` given an `else apply(rootLocalId, row, false)`) — the H case red, and
 *  only it (a top-level instance is built by the new fold); the row capture without the kept orphan rows
 *  (`captureRowChannels`: `keptMemberOrphans(rootGuid) ?? {}` → `{}`) — "O's own prefab-edit save" red, and only it.
 *
 *  Driven through the prefab fuzzer's harness: the real backend route, SceneManager, both caches, prefab edit and the
 *  simulated watcher. */

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
import { getTraitByName, getAllEntities, readTraitData } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored, flushWatcher, type Fixture } from './prefabFuzz/harness';
import { deleteEntitiesWithUndo, writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { previewApply } from '../../packages/modoki/src/editor/scene/prefabApply';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyTargetOptions } from '../../packages/modoki/src/editor/scene/prefabApplyOptions';
import { initialTargets, toApplyTargets } from '../../packages/modoki/src/editor/panels/applyDialogModel';
import { getCachedPrefabSync, preloadNestedPrefabsForSubtree } from '../../packages/modoki/src/editor/scene/prefabCache';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

async function editAndSave(path: string, name: string, edit: () => Promise<void> | void): Promise<void> {
  expect(await openPrefabForEditing({ path, name }, { confirmDiscard: async () => true })).toBeFalsy();
  await edit();
  expect((await savePrefabEditReport({})).saved).toBe(true);
  await exitPrefabEditing();
  await settle();
}

/** O's N (the P it nests) in the fixture's own O instance (its scene guid, `ffffffff-…-8001-…`: a rebuild in place
 *  re-mints ids, so a second instance can come first by id), and the P reference node O's prefab edit placed under it. */
const frame = () => {
  const or = authored().find((e) => e.name === 'OR' && e.guid?.startsWith('ffffffff-0000-4000-8001-'))!;
  const n = authored().find((e) => e.name === 'R' && e.parentId === or.id)!;
  return { or, n, nested: authored().find((e) => e.name === 'R' && e.parentId === n.id) };
};
const byName = (name: string, parentId: number) => authored().filter((e) => e.name === name && e.parentId === parentId);
/** Every entity named `name` anywhere under `rootId`. */
const inSubtree = (name: string, rootId: number) => {
  const all = authored();
  const under = (id: number): boolean => { for (let e = all.find((x) => x.id === id); e?.parentId; e = all.find((x) => x.id === e!.parentId)) if (e.parentId === rootId) return true; return false; };
  return all.filter((e) => e.name === name && under(e.id));
};
const duplicateGuids = () => {
  const n = new Map<string, number>();
  for (const e of authored()) if (e.guid) n.set(e.guid, (n.get(e.guid) ?? 0) + 1);
  return [...n].filter(([, c]) => c > 1).map(([g]) => g);
};

/** In O's prefab edit, drop P under `under(N)` — a reference node on O's N row. */
async function nestPInO(f: Fixture, under: 'A' | 'root'): Promise<void> {
  await editAndSave(f.prefabs.O.path, 'O', async () => {
    const n = authored().find((e) => e.name === 'R')!;
    const parent = under === 'root' ? n : authored().find((e) => e.name === 'A' && e.parentId === n.id)!;
    expect(await placePrefabFromPath(f.prefabs.P.path, { tag: 'test', parentId: parent.id })).toBeTruthy();
    await settle();
  });
}
const deleteAInP = (f: Fixture) => editAndSave(f.prefabs.P.path, 'P', () => { deleteEntitiesWithUndo([authored().find((e) => e.name === 'A')!.id]); });
/** In the scene, delete QR inside the nested P reference node: the edit that makes the save pin N's whole list. */
async function deleteInsideNested(): Promise<string> {
  const { nested } = frame();
  const qr = byName('QR', nested!.id)[0]!;
  deleteEntitiesWithUndo([qr.id]);
  await settle();
  return qr.guid!;
}
/** O's N inside the scene's H instance (the fixture's, `ffffffff-…-8003-…`), once H's prefab edit has nested O under HR. */
const hInstanceN = () => {
  const hr = authored().find((e) => e.name === 'HR' && e.guid?.startsWith('ffffffff-0000-4000-8003-'))!;
  return byName('R', byName('OR', hr.id)[0]!.id)[0]!;
};

/** Another O instance applies a Transform.y to O: every other frame of O is rebuilt in place from the written document. */
async function applyFromSecondO(f: Fixture): Promise<void> {
  const o2 = (await placePrefabFromPath(f.prefabs.O.path, { tag: 'test', parentId: 0 }))!;
  await settle();
  expect(writeTraitFieldWithUndo(o2, getTraitByName('Transform')!, 'y', 3)).toBeFalsy();
  await preloadNestedPrefabsForSubtree(o2);
  const prefab = getCachedPrefabSync(f.prefabs.O.guid)!;
  const sel = new Set(collectInstanceOverrideKeys(o2, prefab).all.filter((k) => k.endsWith('.Transform.y')));
  const targets = toApplyTargets(initialTargets(applyTargetOptions(o2, prefab, [...sel])), sel);
  const pv = await previewApply(o2, new Set(sel), targets);
  expect((await applyToPrefabWithUndo(o2, sel, targets, { expect: pv.fingerprint })).applied).toBe(true);
  await settle();
}

describe('a template-added node whose anchor member is deleted (#1872; prefab v10, #2001 S6)', () => {
  type ORow = { localId: number; members?: Record<string, { own?: Array<{ name?: string; key?: string }> }> };
  const oRowN = (f: Fixture) => (JSON.parse(be.read(f.prefabs.O.path)!) as { entities: ORow[] }).entities.find((e) => e.localId === 2)!;
  const aKey = (pBytes: string) => `/${(JSON.parse(pBytes) as { entities: Array<{ name: string; nodeGuid: string }> }).entities.find((e) => e.name === 'A')!.nodeGuid}`;
  const ownNames = (f: Fixture, key: string) => (oRowN(f).members?.[key]?.own ?? []).map((n) => n.name).sort();
  /** A checkout of P from before the delete reaches the editor. */
  async function restoreP(f: Fixture, bytes: string): Promise<void> {
    const before = be.snapshot();
    be.write(f.prefabs.P.path, bytes);
    await flushWatcher(be, before);
    await settle();
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
  }
  const parentName = (name: string) => { const e = inSubtree(name, frame().n.id)[0]; return e && authored().find((x) => x.id === e.parentId)?.name; };
  async function sceneRoundTripIsStable(f: Fixture): Promise<void> {
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const first = be.read(f.scenePath)!;
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(duplicateGuids()).toEqual([]);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath)).toBe(first);
  }

  it('the anchor goes: the row\'s nodes are not shown, the row is kept, and they return under the anchor when it comes back', async () => {
    const f = await startRun(be, async () => {}, 'anchor-gone');
    await nestPInO(f, 'A');
    const pBefore = be.read(f.prefabs.P.path)!;
    const key = aKey(pBefore);
    expect(ownNames(f, key), 'premise: O\'s v10 row names the anchor by identity').toEqual(['Extra', 'R']);
    await deleteAInP(f);
    expect(inSubtree('Extra', frame().n.id).length, 'Extra is not shown').toBe(0);
    expect(frame().nested, 'nor the nested P').toBeUndefined();
    await sceneRoundTripIsStable(f);
    expect(inSubtree('Extra', frame().n.id).length).toBe(0);
    expect(ownNames(f, key), 'O still states both').toEqual(['Extra', 'R']);
    await restoreP(f, pBefore);
    expect(inSubtree('Extra', frame().n.id).length).toBe(1);
    expect(parentName('Extra')).toBe('A');
    expect(parentName('R'), 'the nested P, anchored at A too').toBe('A');
    expect(duplicateGuids()).toEqual([]);
  });

  it('a node the row adds at the frame ROOT stays when another anchor goes, with the scene\'s edit inside it', async () => {
    const f = await startRun(be, async () => {}, 'anchor-gone-rootNode');
    await nestPInO(f, 'root');
    const pBefore = be.read(f.prefabs.P.path)!;
    const qr = await deleteInsideNested();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    await deleteAInP(f);
    await sceneRoundTripIsStable(f);
    const { n } = frame();
    expect(byName('R', n.id).length, 'one nested P under N').toBe(1);
    expect(inSubtree('Extra', n.id).length, 'Extra, anchored at A, is not shown').toBe(0);
    expect(authored().some((e) => e.guid === qr), 'the scene\'s delete of QR holds').toBe(false);
    await restoreP(f, pBefore);
    expect(parentName('Extra')).toBe('A');
    expect(byName('R', frame().n.id).length).toBe(1);
    expect(authored().some((e) => e.guid === qr), 'and still holds once A is back').toBe(false);
  });

  it('a rebuild in place (another O instance\'s Apply writes O) keeps the row', async () => {
    const f = await startRun(be, async () => {}, 'anchor-gone-rebuild');
    await nestPInO(f, 'A');
    const pBefore = be.read(f.prefabs.P.path)!;
    const key = aKey(pBefore);
    await deleteAInP(f);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    await applyFromSecondO(f);
    expect(duplicateGuids()).toEqual([]);
    expect(inSubtree('Extra', frame().n.id).length).toBe(0);
    expect(ownNames(f, key), 'the Apply wrote O with the row kept').toEqual(['Extra', 'R']);
    await sceneRoundTripIsStable(f);
    await restoreP(f, pBefore);
    expect(parentName('Extra')).toBe('A');
    expect(parentName('R')).toBe('A');
  });

  it('O\'s own prefab-edit save while the anchor is gone keeps the row', async () => {
    const f = await startRun(be, async () => {}, 'anchor-gone-ownSave');
    await nestPInO(f, 'A');
    const pBefore = be.read(f.prefabs.P.path)!;
    const key = aKey(pBefore);
    await deleteAInP(f);
    await editAndSave(f.prefabs.O.path, 'O', async () => {
      const n = authored().find((e) => e.name === 'R')!;
      expect(inSubtree('Extra', n.id).length, 'not shown in O\'s own edit either').toBe(0);
      expect(writeTraitFieldWithUndo(n.id, getTraitByName('Transform')!, 'x', 4)).toBeFalsy();
    });
    expect(ownNames(f, key), 'the save, which captures the live tree, wrote the row back').toEqual(['Extra', 'R']);
    await restoreP(f, pBefore);
    expect(parentName('Extra')).toBe('A');
    expect(parentName('R')).toBe('A');
  });

  it("a prefab that nests O while the anchor is gone (H's edit) shows them once the anchor is back", async () => {
    const f = await startRun(be, async () => {}, 'anchor-gone-templateForm');
    await nestPInO(f, 'A');
    const pBefore = be.read(f.prefabs.P.path)!;
    await deleteAInP(f);
    await editAndSave(f.prefabs.H.path, 'H', async () => {
      const hr = authored().find((e) => e.name === 'HR' && !e.parentId)!;
      expect(await placePrefabFromPath(f.prefabs.O.path, { tag: 'test', parentId: hr.id })).toBeTruthy();
      await settle();
    });
    await sceneRoundTripIsStable(f);
    expect(inSubtree('Extra', hInstanceN().id).length).toBe(0);
    await restoreP(f, pBefore);
    const n = hInstanceN();
    expect(inSubtree('Extra', n.id).length, 'one Extra in the H instance\'s N').toBe(1);
    expect(byName('R', byName('A', n.id)[0]!.id).length, 'and one nested P, under A').toBe(1);
    expect(duplicateGuids()).toEqual([]);
  });

  it('a v9 row (the anchor named by localId): the node is re-anchored at the frame root, and the first v10 save stores it on the "/" row', async () => {
    const f = await startRun(be, async () => {}, 'anchor-gone-legacyRow');
    const pBefore = be.read(f.prefabs.P.path)!;
    expect(be.read(f.prefabs.O.path)!.includes('"parentLocalId": 2'), 'premise: the fixture\'s O states Extra under localId 2').toBe(true);
    await deleteAInP(f);
    expect(byName('Extra', frame().n.id).length, 're-anchored to N\'s root').toBe(1);
    await editAndSave(f.prefabs.O.path, 'O', async () => {
      expect(writeTraitFieldWithUndo(authored().find((e) => e.name === 'R')!.id, getTraitByName('Transform')!, 'x', 4)).toBeFalsy();
    });
    expect(ownNames(f, '/')).toEqual(['Extra']);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(byName('Extra', frame().n.id).length).toBe(1);
    await restoreP(f, pBefore);
    expect(byName('Extra', frame().n.id).length, 'it stays where the row now states it').toBe(1);
    expect(duplicateGuids()).toEqual([]);
  });

  it('a key used twice in O\'s frame is refused at O\'s seat: a Damaged Prefab placeholder keeps the record, and the fixed file brings it back (#1937 C-A)', async () => {
    // Before #1937 a merge that brought a repeated key into O wrote every anchor of the frame whole (the re-review's
    // finding this case held). Unity refuses a file whose identifiers repeat and loads its instances as missing assets;
    // so does every prefab seat now (owner ruling F-A (1)). Driven through the real backend, both caches and the watcher.
    // Mutation: drop the seat refusal (`admitAtSeat` in `fetchPrefab`) — O expands: no placeholder, no label.
    const f = await startRun(be, async () => {}, 'reanchored-dupKey');
    expect(writeTraitFieldWithUndo(frame().n.id, getTraitByName('Transform')!, 'x', 7)).toBeFalsy();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const edited = be.read(f.scenePath)!;
    const good = be.read(f.prefabs.O.path)!;
    const doc = JSON.parse(good) as { entities: Array<{ localId: number; added?: unknown[] }> };
    const dup = (x: number) => ({ parentLocalId: 1, guid: '', key: 'k-dup', name: 'Dup', traits: { EntityAttributes: { name: 'Dup', parentId: 0 }, Transform: { x, y: 0, z: 0 } }, children: [] });
    (doc.entities.find((e) => e.localId === 2)!.added ??= []).push(dup(1), dup(2));
    let before = be.snapshot();
    be.write(f.prefabs.O.path, `${JSON.stringify(doc, null, 2)}\n`); // a merge that brought a repeated key in
    await flushWatcher(be, before);
    await settle();
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    const placeholder = authored().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8001-'));
    expect(placeholder?.missingPrefab, 'O\'s instance is a placeholder').toBe(true);
    expect(placeholder?.damagedPrefab).toMatch(/template key k-dup to two nodes in one frame/);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath), 'the record is written back as it was read').toBe(edited);
    before = be.snapshot();
    be.write(f.prefabs.O.path, good); // the file is fixed
    await flushWatcher(be, before);
    await settle();
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(getAllEntities().some((e) => e.missingPrefab), 'O expands again').toBe(false);
    expect((readTraitData(frame().n.id, getTraitByName('Transform')!) as { x: number }).x, 'with the scene\'s edit').toBe(7);
  });

  it('a key one frame\'s lists give two nodes is REFUSED: placing the prefab is refused with the reason (#1937 C-A, #1933 L5)', async () => {
    // O's N adds k-dup at P's root and at A — one frame of P (I7: a keyed node derives from its frame root plus its key),
    // so both derive one guid. Admission groups by anchor (it sees O alone, not which of P's rows are frames), so the
    // repeat is the derive walk's to see (`frameRepeatRefusal`), which placement, the load and every write ask. This
    // case used to place O and test the fold's key clause over the collision (third review); since owner ruling F-A (1)
    // that prefab does not load. Mutation: drop placement's `frameRepeatRefusal` — O is placed.
    const f = await startRun(be, async () => {}, 'reanchored-templateDupKey');
    const doc = JSON.parse(be.read(f.prefabs.O.path)!) as { entities: Array<{ localId: number; added?: unknown[] }> };
    const dup = (x: number, at: number) => ({ parentLocalId: at, guid: '', key: 'k-dup', name: 'Dup', traits: { EntityAttributes: { name: 'Dup', parentId: 0 }, Transform: { x, y: 0, z: 0 } }, children: [] });
    doc.entities.find((e) => e.localId === 2)!.added!.push(dup(1, 1), dup(2, 2));
    const before = be.snapshot();
    be.write(f.prefabs.O.path, `${JSON.stringify(doc, null, 2)}\n`);
    await flushWatcher(be, before);
    await settle();
    const warn = vi.spyOn(console, 'warn');
    try {
      expect(await placePrefabFromPath(f.prefabs.O.path, { tag: 'test' })).toBeNull();
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/was not placed: prefab "O" gives template key k-dup to two nodes in one frame/);
    } finally { warn.mockRestore(); }
  });
});
