/** #1862: an in-place rebuild (Apply's fan-out, Revert, their undos) over an instance whose NESTED prefab was trashed.
 *  The respawn cannot expand that nested row (#1790 ruling D), so before the fix the teardown took the nested frame's live
 *  members with it and nothing came back in their place: 37 such rebuilds in a 300-seed hunt (6000–6299), invisible to the
 *  fuzzer because the save writes the frame's record either way (I18). The frame is KEPT now, as Unity keeps the objects of
 *  a missing instance it merged before the asset went (`MergeStatus.NormalMerge`, `PrefabUtility.cs`), and a Revert of the
 *  kept frame itself refuses, naming the missing prefab: there is no base to revert to.
 *
 *  Driven through the real editor over the fuzzer's in-process backend (`prefabFuzz/harness.ts`): #1707's fixture, where P
 *  is R → A → B plus row C expanding Q (QR → M), and O nests P. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { getTraitByName, getAllEntities } from '@modoki/engine/runtime';
import { pushAction } from '@modoki/engine/editor';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, unexpandedRows, type Fixture } from './prefabFuzz/harness';
import { deleteAssetFiles, deletionPathsFor } from '../../packages/modoki/src/editor/panels/assetOps';
import { makeDeleteUndo, snapshotFromBytes, type DeleteResult } from '../../packages/modoki/src/editor/panels/assetUndo';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { getCachedPrefabSync, preloadNestedPrefabsForSubtree, previewApply, revertRefusal, instantiatePrefabInstance, reexpandRestoredRows } from '../../packages/modoki/src/editor/scene/prefab';
import { unregisterAsset, getGuidForPath } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyTargetOptions } from '../../packages/modoki/src/editor/scene/prefabApplyOptions';
import { initialTargets, toApplyTargets } from '../../packages/modoki/src/editor/panels/applyDialogModel';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { revertOverridesWithUndo } from '../../packages/modoki/src/editor/undo/revertPrefabUndo';
import { writeTraitFieldWithUndo, applyReparent } from '../../packages/modoki/src/editor/undo/entityActions';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { reannounceRestoredFiles } from '../../packages/modoki/src/editor/panels/assetRestore';
import { commitPrefabWrite } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { readTraitData } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const noNest = async () => {};

/** The top-level instance of P (named "P1" in the scene). */
function p1(f: Fixture): number {
  const e = getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === x.id; });
  if (!e) throw new Error('fixture: no top-level P instance');
  return e.id;
}
/** Every live entity of a Q frame (QR and M), anywhere in the scene, by guid. */
function qFrameGuids(f: Fixture): string[] {
  return getAllEntities().filter((x) => { const pi = piOf(x.id); return pi?.source === f.prefabs.Q.guid; }).map((x) => x.guid!).sort();
}
function member(root: number, name: string): number {
  const e = getAllEntities().find((x) => x.name === name && piOf(x.id)?.rootInstanceId === root);
  if (!e) throw new Error(`fixture: no member ${name}`);
  return e.id;
}
/** The Q frame nested in `root`'s subtree: its root QR (an owned nested root) and its member M. */
function nestedQ(f: Fixture, root: number): { qr: number; m: number } {
  const all = getAllEntities();
  const under = new Set<number>([root]);
  for (let grew = true; grew;) { grew = false; for (const e of all) if (!under.has(e.id) && under.has(e.parentId)) { under.add(e.id); grew = true; } }
  const qr = all.find((x) => under.has(x.id) && piOf(x.id)?.source === f.prefabs.Q.guid && piOf(x.id)?.rootInstanceId === x.id);
  if (!qr) throw new Error('fixture: no nested Q frame');
  return { qr: qr.id, m: member(qr.id, 'M') };
}
const tx = (id: number, field: string) => (readTraitData(id, getTraitByName('Transform')!) as Record<string, number> | null)?.[field];

/** `Assets.tsx`'s `executeDeletion` of Q, as the fuzzer's `trashPrefab` op runs it. */
async function trashQ(f: Fixture): Promise<void> {
  const path = f.prefabs.Q.path;
  const bytes = be.read(path)!;
  const deletePaths = deletionPathsFor(path, 'prefab', null);
  const del = await deleteAssetFiles(deletePaths);
  if (!del.ok) throw new Error('trash of Q did not complete');
  unbindDeletedAssetEditors([path]);
  const results: DeleteResult[] = [{ asset: { path, name: 'Q', type: 'prefab' }, snapshots: [snapshotFromBytes(path, new TextEncoder().encode(bytes))], deletePaths }];
  pushAction(makeDeleteUndo(results, () => {}, { missing: del.missing, failed: del.failed }));
  await settle();
}

/** The Apply dialog's path for the keys of `root` that `pick` selects, with its default targets. */
async function apply(root: number, pick: (k: string) => boolean): Promise<void> {
  const source = piOf(root)!.source;
  await preloadNestedPrefabsForSubtree(root);
  const prefab = getCachedPrefabSync(source)!;
  const keys = collectInstanceOverrideKeys(root, prefab);
  const sel = new Set([...keys.all, ...keys.nested].filter(pick));
  expect(sel.size).toBeGreaterThan(0);
  const targets = toApplyTargets(initialTargets(applyTargetOptions(root, prefab, [...sel])), sel);
  const preview = await previewApply(root, new Set(sel), targets);
  const result = await applyToPrefabWithUndo(root, sel, targets, { expect: preview.fingerprint });
  expect(result.refused ?? null).toBeNull();
  expect(result.applied).toBe(true);
  await settle();
}

/** Edit A's `Transform.y` on P1, optionally trash Q, then Apply that one edit (its fan-out rebuilds every P frame). */
async function editTrashApply(key: string, trash: boolean): Promise<Fixture> {
  const f = await startRun(be, noNest, key);
  expect(writeTraitFieldWithUndo(member(p1(f), 'A'), getTraitByName('Transform')!, 'y', 9)).toBeFalsy();
  await settle();
  if (trash) await trashQ(f);
  await apply(p1(f), (k) => /\.Transform\.y$/.test(k));
  return f;
}

/** The scene file's bytes with this run's identity taken out: its tag (every fixture guid's and path's last group) read as
 *  `TAG`, then every guid renamed by first appearance — a derived member guid hashes the run's tag, so two runs agree on
 *  WHICH entity holds a guid, never on its value. */
function normalized(f: Fixture, text: string): string {
  const seen = new Map<string, string>();
  return text.split(f.sceneGuid.split('-').pop()!).join('TAG')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-(?:[0-9a-f]{12}|TAG)/g, (g) => {
      if (!seen.has(g)) seen.set(g, `G${seen.size}`);
      return seen.get(g)!;
    });
}

describe('#1862: an in-place rebuild keeps a nested frame whose prefab is missing', () => {
  it('an Apply fans out over both P frames: each nested Q frame stays live, and comes off the unexpanded list', async () => {
    // Mutation: never keep in `rebuildTeardown` (drop the `unexpandable` branch) — every Q frame goes with the teardown.
    const f = await startRun(be, noNest, 'keep-live');
    const before = qFrameGuids(f);
    expect(before.length).toBe(4); // QR + M, under P1 and under O1's N
    expect(writeTraitFieldWithUndo(member(p1(f), 'A'), getTraitByName('Transform')!, 'y', 9)).toBeFalsy();
    await settle();
    await trashQ(f);
    await apply(p1(f), (k) => /\.Transform\.y$/.test(k));
    expect(qFrameGuids(f)).toEqual(before);
    // Mutation: skip the `unexpanded` rewrite in `seatKeptFrames` — the P frames' records still list row C.
    expect([...unexpandedRows()]).toEqual([]);
    // The kept frame hangs where it did: M under QR under P1's root.
    const { qr, m } = nestedQ(f, p1(f));
    expect(getAllEntities().find((e) => e.id === qr)?.parentId).toBe(p1(f));
    expect(getAllEntities().find((e) => e.id === m)?.parentId).toBe(qr);
  });

  it('a Revert of a field outside the frame keeps it too, and the Revert\'s undo is not refused on its members', async () => {
    const f = await startRun(be, noNest, 'keep-revert');
    const before = qFrameGuids(f);
    expect(writeTraitFieldWithUndo(member(p1(f), 'A'), getTraitByName('Transform')!, 'y', 9)).toBeFalsy();
    await settle();
    await trashQ(f);
    expect(await revertRefusal(p1(f))).toBeNull();
    const prefab = getCachedPrefabSync(f.prefabs.P.guid)!;
    const sel = new Set([...collectInstanceOverrideKeys(p1(f), prefab).all].filter((k) => /\.Transform\.y$/.test(k)));
    expect(await revertOverridesWithUndo(p1(f), sel)).not.toBeNull();
    await settle();
    expect(tx(member(p1(f), 'A'), 'y')).not.toBe(9);
    expect(qFrameGuids(f)).toEqual(before);
    const u = await undoStep('undo');
    expect(u.failed ?? null).toBeNull();
    expect(u.label).toBe('Revert prefab overrides');
    await settle();
    expect(tx(member(p1(f), 'A'), 'y')).toBe(9);
    expect(qFrameGuids(f)).toEqual(before);
  });

  it('(a) the scene save after the keep is byte-identical to the same Apply with Q never trashed', async () => {
    // Mutation: drop a kept frame instead of re-seating it (`drop.push` for every kept root) — the saves differ.
    const control = await editTrashApply('keep-save-control', false);
    const s1 = await saveScene({ allowDialog: false });
    expect(s1.saved).toBe(true);
    const controlBytes = normalized(control, be.read(control.scenePath)!);
    const f = await editTrashApply('keep-save-trashed', true);
    const s2 = await saveScene({ allowDialog: false });
    expect(s2.saved).toBe(true);
    expect(normalized(f, be.read(f.scenePath)!)).toBe(controlBytes);
  });

  it('(c) a reload while Q is missing leaves row C unexpanded; (b) once Q is back, a reload re-expands it with its edits', async () => {
    const f = await editTrashApply('keep-reload', true);
    const { m } = nestedQ(f, p1(f));
    expect(tx(m, 'x')).toBe(4); // P's row C moves M to x=4
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    // (c) Ruling D, unchanged: the loader spawns nothing for a nested row whose prefab is gone. Unity keeps a scene backup
    // of such a frame's objects; Modoki keeps only its record (the gap is #1867, not fixed here).
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(qFrameGuids(f)).toEqual([]);
    expect([...unexpandedRows()].length).toBe(2);
    // (b) The record was kept, so the frame comes back whole once the prefab does.
    const bytes = JSON.stringify({ id: f.prefabs.Q.guid, version: 5, name: 'Q', rootLocalId: 1, entities: [
      { localId: 1, name: 'QR', nodeGuid: `eeeeeeee-0000-4000-8001-${f.sceneGuid.split('-').pop()}`, traits: { EntityAttributes: { name: 'QR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
      { localId: 2, name: 'M', nodeGuid: `eeeeeeee-0000-4000-8002-${f.sceneGuid.split('-').pop()}`, traits: { EntityAttributes: { name: 'M', parentId: 1, guid: '' }, Transform: { x: 1, y: 0, z: 0 } } },
    ] }, null, 2);
    be.write(f.prefabs.Q.path, `${bytes}\n`);
    // The restore owner every undo that puts a file back runs (#1844): the manifest, and the loader forgetting the 404 the
    // reload above remembered.
    expect((await reannounceRestoredFiles([f.prefabs.Q.path])).ok).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(qFrameGuids(f).length).toBe(4);
    expect([...unexpandedRows()]).toEqual([]);
    expect(tx(nestedQ(f, p1(f)).m, 'x')).toBe(4);
  });

  it('#1864: a restore re-expands in place, with no reload, every frame that recorded the prefab\'s row as unexpanded', async () => {
    // Mutation: drop the `reexpandRestoredRows` call from `reannounceRestoredFiles` — the rows stay unexpanded and empty.
    const f = await editTrashApply('reexpand-restore', true);
    const saved = qFrameGuids(f);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(qFrameGuids(f)).toEqual([]);
    expect([...unexpandedRows()].length).toBe(2);
    const tag = f.sceneGuid.split('-').pop();
    be.write(f.prefabs.Q.path, `${JSON.stringify({ id: f.prefabs.Q.guid, version: 5, name: 'Q', rootLocalId: 1, entities: [
      { localId: 1, name: 'QR', nodeGuid: `eeeeeeee-0000-4000-8001-${tag}`, traits: { EntityAttributes: { name: 'QR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
      { localId: 2, name: 'M', nodeGuid: `eeeeeeee-0000-4000-8002-${tag}`, traits: { EntityAttributes: { name: 'M', parentId: 1, guid: '' }, Transform: { x: 1, y: 0, z: 0 } } },
    ] }, null, 2)}\n`);
    expect((await reannounceRestoredFiles([f.prefabs.Q.path])).ok).toBe(true);
    await settle();
    expect([...unexpandedRows()]).toEqual([]);
    // The same entities the save recorded, by guid: the scene's rows for the frame came back with it.
    expect(qFrameGuids(f)).toEqual(saved);
    expect(tx(nestedQ(f, p1(f)).m, 'x')).toBe(4);
  });

  it('a SCENE-ADDED reference node is kept too: no placeholder beside it, and a later undo that requires its member resolves', async () => {
    // Mutation: never keep a stored root (drop the `unexpandable(c, false)` branch) — the node respawns as a placeholder and
    // M is gone. Mutation: keep it but do not skip its respawn (`withoutKeptNodes` returns `added` whole) — two entities
    // carry the node's guid.
    const f = await startRun(be, noNest, 'keep-added-node');
    const hr = getAllEntities().find((e) => { const pi = piOf(e.id); return pi?.source === f.prefabs.H.guid && pi.rootInstanceId === e.id; })!.id;
    expect(await instantiatePrefabInstance(JSON.parse(be.read(f.prefabs.Q.path)!), f.prefabs.Q.path, hr)).toBeTruthy();
    await settle();
    const node = nestedQ(f, hr);
    const nodeGuid = getAllEntities().find((e) => e.id === node.qr)!.guid!;
    const mGuid = getAllEntities().find((e) => e.id === node.m)!.guid!;
    await trashQ(f);
    // An entry that will REQUIRE M, recorded while the prefab is gone, then the gesture that rebuilds H1 around it.
    expect(writeTraitFieldWithUndo(node.m, getTraitByName('Transform')!, 'z', 3)).toBeFalsy();
    expect(writeTraitFieldWithUndo(hr, getTraitByName('Transform')!, 'y', 9)).toBeFalsy();
    await settle();
    const prefab = getCachedPrefabSync(f.prefabs.H.guid)!;
    const sel = new Set([...collectInstanceOverrideKeys(hr, prefab).all].filter((k) => /\.Transform\.y$/.test(k)));
    expect(sel.size).toBe(1);
    expect(await revertOverridesWithUndo(hr, sel)).not.toBeNull();
    await settle();
    expect(getAllEntities().filter((e) => e.guid === nodeGuid).length).toBe(1);
    expect(getAllEntities().some((e) => e.guid === mGuid)).toBe(true);
    // The Revert's undo (and its selection), the H1 edit's, then M's own, which requires M: none refused.
    for (const label of ['Revert prefab overrides', 'Select entity', 'Edit Transform.y', 'Edit Transform.z']) {
      const u = await undoStep('undo');
      expect(u.failed ?? null).toBeNull();
      expect(u.label).toBe(label);
      await settle();
    }
    const m = getAllEntities().find((e) => e.guid === mGuid)!.id;
    expect(tx(m, 'z')).toBe(0);
    expect(getAllEntities().filter((e) => e.guid === nodeGuid).length).toBe(1);
  });

  it('a Revert of the scene-added node\'s own add removes it: a kept frame the structure no longer names goes', async () => {
    // Mutation: ignore `unnamed` in `seatKeptFrames` — the reverted node stays live, re-seated under H1.
    const f = await startRun(be, noNest, 'keep-added-revert');
    const hr = getAllEntities().find((e) => { const pi = piOf(e.id); return pi?.source === f.prefabs.H.guid && pi.rootInstanceId === e.id; })!.id;
    expect(await instantiatePrefabInstance(JSON.parse(be.read(f.prefabs.Q.path)!), f.prefabs.Q.path, hr)).toBeTruthy();
    await settle();
    const nodeGuid = getAllEntities().find((e) => e.id === nestedQ(f, hr).qr)!.guid!;
    await trashQ(f);
    const sel = new Set([...collectInstanceOverrideKeys(hr, getCachedPrefabSync(f.prefabs.H.guid)!).all].filter((k) => k.startsWith('+added')));
    expect(sel.size).toBe(1);
    expect(await revertOverridesWithUndo(hr, sel)).not.toBeNull();
    await settle();
    expect(getAllEntities().filter((e) => e.guid === nodeGuid)).toEqual([]);
    expect(qFrameGuids(f).length).toBe(4); // the two P frames' Q rows, untouched
  });

  for (const [what, back] of [['moved under a member and left there', false], ['moved away and back to its template spot', true]] as const) {
    it(`a kept frame that was ${what} survives the rebuild (its owner link does not get it promoted)`, async () => {
      // Mutation: drop `relinkDetachedMembers` after the teardown's delete — the moved frame's `ownerGuid` names the root
      // torn down, `promoteOwnedRoots` promotes it, and `seatKeptFrames` finds no owner and drops it (close-out review, S3/S4).
      const f = await startRun(be, noNest, `keep-moved-${back}`);
      const root = p1(f);
      const { qr } = nestedQ(f, root);
      const before = qFrameGuids(f);
      expect(applyReparent(qr, member(root, 'B')).ok).toBe(true);
      if (back) expect(applyReparent(qr, root).ok).toBe(true);
      await settle();
      expect(writeTraitFieldWithUndo(member(root, 'A'), getTraitByName('Transform')!, 'y', 9)).toBeFalsy();
      await settle();
      await trashQ(f);
      const sel = new Set([...collectInstanceOverrideKeys(p1(f), getCachedPrefabSync(f.prefabs.P.guid)!).all].filter((k) => /\.Transform\.y$/.test(k)));
      expect(await revertOverridesWithUndo(p1(f), sel)).not.toBeNull();
      await settle();
      expect(qFrameGuids(f)).toEqual(before);
      expect([...unexpandedRows()]).toEqual([]);
      const now = nestedQ(f, p1(f));
      expect(getAllEntities().find((e) => e.id === now.qr)!.parentId).toBe(back ? p1(f) : member(p1(f), 'B'));
    });
  }

  it('#1864: the restore finds a guid-named row even when the manifest has no guid for the file (a failed rescan)', async () => {
    // Mutation: drop the read by path in `reexpandRestoredRows` (`getPrefabSource(p)`, whose read registers the file's own guid)
    // — the row names Q by a guid nothing maps, and nothing is found.
    const f = await editTrashApply('reexpand-noguid', true);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect([...unexpandedRows()].length).toBe(2);
    const tag = f.sceneGuid.split('-').pop();
    be.write(f.prefabs.Q.path, `${JSON.stringify({ id: f.prefabs.Q.guid, version: 5, name: 'Q', rootLocalId: 1, entities: [
      { localId: 1, name: 'QR', nodeGuid: `eeeeeeee-0000-4000-8001-${tag}`, traits: { EntityAttributes: { name: 'QR', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } },
      { localId: 2, name: 'M', nodeGuid: `eeeeeeee-0000-4000-8002-${tag}`, traits: { EntityAttributes: { name: 'M', parentId: 1, guid: '' }, Transform: { x: 1, y: 0, z: 0 } } },
    ] }, null, 2)}\n`);
    // The manifest as a pruning rescan after the delete left it: no entry for Q, as when the restore's own rescan fails.
    unregisterAsset(f.prefabs.Q.guid);
    expect(getGuidForPath(f.prefabs.Q.path)).toBeFalsy(); // precondition
    await reexpandRestoredRows([f.prefabs.Q.path]);
    await settle();
    expect([...unexpandedRows()]).toEqual([]);
    expect(qFrameGuids(f).length).toBe(4);
  });

  it('a kept frame goes when the rebuilt row now names ANOTHER missing prefab, even with both guids pruned', async () => {
    // Mutation: compare `resolveRef` of the two refs unguarded in `seatKeptFrames` — both pruned, `undefined === undefined`
    // seats the Q frame as the expansion of a row naming R, and takes that row off `unexpanded` (close-out review 2).
    const f = await startRun(be, noNest, 'keep-repointed');
    await trashQ(f);
    unregisterAsset(f.prefabs.Q.guid); // the dev editor's pruning push after the delete
    const p = getCachedPrefabSync(f.prefabs.P.guid)!;
    const R = `cccccccc-0000-4000-8099-${f.sceneGuid.split('-').pop()}`; // a prefab nothing registers
    const repointed = JSON.parse(JSON.stringify(p)) as typeof p;
    const c = repointed.entities.find((r) => r.prefab === f.prefabs.Q.guid)!;
    c.prefab = R;
    expect((await commitPrefabWrite(f.prefabs.P.guid, repointed, { expected: p })).ok).toBe(true);
    await settle();
    expect(qFrameGuids(f)).toEqual([]);
    expect([...unexpandedRows()].length).toBe(2); // row C, now naming R, in P1 and in O1's N: neither is expanded
  });

  it('a Revert of the kept frame itself refuses, naming the missing prefab', async () => {
    // Mutation: drop the missing-prefab branch of `revertRefusal` — it answers null and the Revert would run.
    const f = await editTrashApply('keep-refuse', true);
    const { qr } = nestedQ(f, p1(f));
    const why = await revertRefusal(qr);
    expect(why).toContain('"QR" is an instance of "Q", a prefab that is missing (');
    expect(why).toMatch(/Restore the prefab to revert it, or Detach Prefab/);
    // …and the outer instance, whose own prefab loads, is not refused.
    expect(await revertRefusal(p1(f))).toBeNull();
  });
});
