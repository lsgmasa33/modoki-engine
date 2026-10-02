/** #1872 — a template-added node the load RE-ANCHORED to its frame root (a prefab edit deleted its anchor) round-trips as
 *  ONE node when a whole `added` list is pinned at that root, in either order.
 *
 *  An edited template REFERENCE node has no node-row address, so the save pins its member's whole `added` list, where
 *  the node is PLACED (`chainNodesAsPlaced`: a node whose anchor row the document lost sits at the root). The load's
 *  fold replaces only the nodes the TEMPLATE anchors at the list's member. So the diff also writes a by-key `removed`
 *  node row (scene form; the list's own key in template form) for each node the load re-anchored into a pinned list
 *  (`reanchoredKeys`, `diffFrameAdded`'s `pinnedOver`); node rows apply by key wherever the template anchors the node.
 *
 *  - 6053's order (win's hunt seed, whose shrunk list is in `prefabFuzz/knownOpen.ts` REGRESSIONS): the anchor goes,
 *    then the scene edits inside the re-anchored node. Without the node rows the template's copies spawned beside the
 *    pinned ones: every node twice on one guid, and the deleted QR back.
 *  - The reversed order (the close-out review's): the scene pins the root's list while the anchor still exists, then
 *    the anchor goes. A fold that replaced every node PLACED at the root (the first fix) lost O's Extra for good.
 *  - The anchor comes BACK (an outside edit restoring the prefab): the removed rows still name the template's nodes.
 *  - A rebuild in place (another instance's Apply refreshes this frame) diffs through the same `diffFrameAdded`.
 *
 *  - A TEMPLATE-form save (H's prefab edit nests O), where the list carries the node's key (the close-out re-review).
 *  - A key used twice in O's own frame (the re-review's other finding) is refused at O's seat since #1937 C-A: its
 *    instances are Damaged Prefab placeholders that keep their record, so the whole list can no longer come from it.
 *
 *  Each: one copy, and a second save byte-identical to the first. Mutations, each red on exactly its cases: the fold
 *  replacing everything PLACED at the anchor (the reversed order); no scene-form removed rows (every scene-form case);
 *  removed rows in template form too (the template-form case); no key-named replacement in the fold (the template-form
 *  case); the rebuild subtracting a pinned-over node (the rebuild).
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

/** Save, reload, and hold what must hold after it: one Extra and one nested P under N, no I7, the scene's delete kept;
 *  then a second save byte-identical to the first. */
async function roundTripsAsOne(f: Fixture, deletedGuid: string, anchorBack = false): Promise<void> {
  expect((await saveScene({ allowDialog: false })).saved).toBe(true);
  const first = be.read(f.scenePath)!;
  expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
  await settle();
  expect(duplicateGuids()).toEqual([]);
  const { n } = frame();
  // At N's root while the anchor A is gone; once A comes back, under A — so then counted anywhere in N, and its parent
  // asserted by the caller (review: counting anywhere for every case let a misplacement under the nested R pass).
  const count = (name: string) => (anchorBack ? inSubtree(name, n.id) : byName(name, n.id)).length;
  expect(count('Extra'), 'one Extra under N').toBe(1);
  expect(count('R'), 'one nested P under N').toBe(1);
  expect(authored().some((e) => e.guid === deletedGuid), 'the scene\'s delete of QR holds').toBe(false);
  expect((await saveScene({ allowDialog: false })).saved).toBe(true);
  expect(be.read(f.scenePath)).toBe(first);
}

describe('a re-anchored template node pinned in a whole list is ONE node (#1872)', () => {
  it("6053's order: the anchor goes, then the scene edits inside the re-anchored reference node", async () => {
    const f = await startRun(be, async () => {}, 'reanchored-6053');
    await nestPInO(f, 'A');
    await deleteAInP(f);
    expect(frame().nested, 'premise: the nested P is re-anchored to N\'s root').toBeTruthy();
    const qr = await deleteInsideNested();
    await roundTripsAsOne(f, qr);
  });

  it('the reversed order: the scene pins the root\'s list while the anchor exists, then the anchor goes', async () => {
    const f = await startRun(be, async () => {}, 'reanchored-pinFirst');
    await nestPInO(f, 'root');
    const qr = await deleteInsideNested();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    await deleteAInP(f); // O's Extra, anchored at A, is re-anchored to N's root by the reload that leaving edit does
    await roundTripsAsOne(f, qr);
  });

  it('the anchor comes BACK (an outside edit restores the prefab): still one copy', async () => {
    const f = await startRun(be, async () => {}, 'reanchored-comesBack');
    await nestPInO(f, 'A');
    const pBefore = be.read(f.prefabs.P.path)!;
    await deleteAInP(f);
    const qr = await deleteInsideNested();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const before = be.snapshot();
    be.write(f.prefabs.P.path, pBefore); // a checkout of P from before the delete
    await flushWatcher(be, before);
    await settle();
    await roundTripsAsOne(f, qr, true);
    // The restore REACHED the editor: Extra is back under its anchor. Until the fuzz watcher keyed a mark by its bytes
    // (#2009), P's own earlier prefab-edit save left a mark that took this outside write for the editor's, nothing
    // reloaded, and the case ran with the anchor still gone.
    const parentName = (name: string) => { const e = inSubtree(name, frame().n.id)[0]!; return authored().find((x) => x.id === e.parentId)?.name; };
    expect(parentName('Extra')).toBe('A');
    expect(parentName('R'), 'the nested P, anchored at A too').toBe('A');
  });

  it('a rebuild in place (another O instance\'s Apply refreshes this frame): still one copy', async () => {
    const f = await startRun(be, async () => {}, 'reanchored-rebuild');
    await nestPInO(f, 'A');
    await deleteAInP(f);
    const qr = await deleteInsideNested();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    await applyFromSecondO(f);
    // The refresh, before any save: one copy in the live world.
    expect(duplicateGuids()).toEqual([]);
    expect(byName('Extra', frame().n.id).length).toBe(1);
    await roundTripsAsOne(f, qr);
  });

  // Since #1914 R3b a delete inside the template reference node is a row reaching into it, and N's list is not written
  // at all (`rows`); a key used twice in the frame, which no node row can name, still makes H write the list whole
  // (`whole`, as the case below).
  it("a TEMPLATE-form save (H's prefab edit nests O and deletes inside the re-anchored node): one copy in every H instance", async () => {
    // The list a prefab's own rows pin carries each node's KEY, so a removed row on that key removed the list's copy
    // too, and every instance of H lost Extra and the nested P (#1872 re-review). Template form states it by the key.
    // (Its `whole` mode — a key O's frame used twice — is refused at O's seat since #1937 C-A: the case below.)
    const f = await startRun(be, async () => {}, 'reanchored-templateForm-rows');
    await nestPInO(f, 'A');
    await deleteAInP(f);
    await editAndSave(f.prefabs.H.path, 'H', async () => {
      const hr = authored().find((e) => e.name === 'HR' && !e.parentId)!;
      expect(await placePrefabFromPath(f.prefabs.O.path, { tag: 'test', parentId: hr.id })).toBeTruthy();
      await settle();
      const or = authored().find((e) => e.name === 'OR')!;
      const n = byName('R', or.id)[0]!;
      const nested = byName('R', n.id)[0]!;
      deleteEntitiesWithUndo([byName('QR', nested.id)[0]!.id]);
      await settle();
    });
    const hDoc = be.read(f.prefabs.H.path)!;
    expect([hDoc.includes('"added"'), hDoc.includes('/a+')], 'premise: how H stated the delete').toEqual([false, true]);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const first = be.read(f.scenePath)!;
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(duplicateGuids()).toEqual([]);
    const hr = authored().find((e) => e.name === 'HR' && e.guid?.startsWith('ffffffff-0000-4000-8003-'))!;
    const or = byName('OR', hr.id)[0]!;
    const n = byName('R', or.id)[0]!;
    expect(byName('Extra', n.id).length, 'one Extra under the H instance\'s N').toBe(1);
    const nested = byName('R', n.id);
    expect(nested.length, 'one nested P under the H instance\'s N').toBe(1);
    expect(byName('QR', nested[0]!.id).length, "H's delete inside it holds").toBe(0);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath)).toBe(first);
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

  it("a TEMPLATE-form DELETE of a pinned-over node holds: H's edit deletes the re-anchored Extra (third review)", async () => {
    // Template form states a node the list HOLDS by its key; one the edit deleted is in no list, and without a removed
    // row the template's copy came back in H's edit and in every H instance. Mutation: skip the row for every
    // pinned-over key in template form — red.
    const f = await startRun(be, async () => {}, 'reanchored-templateDelete');
    await nestPInO(f, 'A');
    await deleteAInP(f);
    await editAndSave(f.prefabs.H.path, 'H', async () => {
      const hr = authored().find((e) => e.name === 'HR' && !e.parentId)!;
      expect(await placePrefabFromPath(f.prefabs.O.path, { tag: 'test', parentId: hr.id })).toBeTruthy();
      await settle();
      const n = byName('R', authored().find((e) => e.name === 'OR')!.id)[0]!;
      deleteEntitiesWithUndo([byName('QR', byName('R', n.id)[0]!.id)[0]!.id]); // pins N's root list whole
      await settle();
      deleteEntitiesWithUndo([byName('Extra', n.id)[0]!.id]);
      await settle();
    });
    expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' }, { confirmDiscard: async () => true })).toBeFalsy();
    expect(byName('Extra', byName('R', authored().find((e) => e.name === 'OR')!.id)[0]!.id).length, "in H's own edit").toBe(0);
    await exitPrefabEditing();
    await settle();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const first = be.read(f.scenePath)!;
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(byName('Extra', hInstanceN().id).length, 'in the scene\'s H instance').toBe(0);
    expect(byName('R', hInstanceN().id).length, 'the nested P stays').toBe(1);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath)).toBe(first);
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
