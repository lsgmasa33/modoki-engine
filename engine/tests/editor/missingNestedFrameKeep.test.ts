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
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, unexpandedRows, flushWatcher, placeholderGuids, type Fixture } from './prefabFuzz/harness';
import { deleteAssetFiles, deletionPathsFor } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import {
  getCachedPrefabSync, preloadNestedPrefabsForSubtree,
} from '../../packages/modoki/src/editor/scene/prefabCache';
import { instantiatePrefabInstance } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { previewApply } from '../../packages/modoki/src/editor/scene/prefabApply';
import { revertRefusal } from '../../packages/modoki/src/editor/scene/prefabRevert';
import { unregisterAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyTargetOptions } from '../../packages/modoki/src/editor/scene/prefabApplyOptions';
import { initialTargets, toApplyTargets } from '../../packages/modoki/src/editor/panels/applyDialogModel';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { revertOverridesWithUndo } from '../../packages/modoki/src/editor/undo/revertPrefabUndo';
import { writeTraitFieldWithUndo, createEntityWithUndo, deleteEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { keptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { commitPrefabWrite } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { readTraitData } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { runAgentOp } from '../../app/debug/agentBridge';

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

/** Q's file as it was when {@link trashQ} trashed it, per fixture — what the scene's copy must hold (#1867). */
const trashedQ = new Map<Fixture, unknown>();

/** `Assets.tsx`'s `executeDeletion` of Q, as the fuzzer's `trashPrefab` op runs it: no undo entry (#1868, D2). */
async function trashQ(f: Fixture, which: 'Q' | 'P' | 'H' = 'Q'): Promise<void> {
  const path = f.prefabs[which].path;
  if (which === 'Q') trashedQ.set(f, JSON.parse(be.read(path)!));
  const deletePaths = deletionPathsFor(path, 'prefab', null);
  const before = be.snapshot();
  const del = await deleteAssetFiles(deletePaths);
  if (!del.ok) throw new Error('trash of Q did not complete');
  unbindDeletedAssetEditors([path]);
  // The watcher's pass after it, as the fuzzer runs one after every op: the delete is the editor's own, so it raises
  // nothing, and a later outside write to the path (a hand restore) is then raised as one.
  await flushWatcher(be, before);
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

  it('(a) the scene save after the keep is the same Apply with Q never trashed, plus Q\'s copy (#1867)', async () => {
    // Mutation: drop a kept frame instead of re-seating it (`drop.push` for every kept root) — the saves differ.
    const control = await editTrashApply('keep-save-control', false);
    const s1 = await saveScene({ allowDialog: false });
    expect(s1.saved).toBe(true);
    const controlBytes = normalized(control, be.read(control.scenePath)!);
    expect(JSON.parse(be.read(control.scenePath)!).embeddedPrefabs).toBeUndefined(); // nothing missing, nothing copied
    const f = await editTrashApply('keep-save-trashed', true);
    const s2 = await saveScene({ allowDialog: false });
    expect(s2.saved).toBe(true);
    // #1914 F8 = A1: the one difference is the copy of Q, its document exactly as the frames were expanded from it. The
    // records are untouched (I2/I17: the copy is base, never a record).
    const { embeddedPrefabs, ...rest } = JSON.parse(be.read(f.scenePath)!) as { embeddedPrefabs?: Record<string, unknown> };
    expect(embeddedPrefabs).toEqual({ [f.prefabs.Q.guid]: trashedQ.get(f) });
    expect(normalized(f, `${JSON.stringify(rest, null, 2)}\n`)).toBe(controlBytes);
  });

  /** {@link editTrashApply}, save, then reload the scene while Q is still missing. */
  async function savedAndReloaded(key: string): Promise<{ f: Fixture; live: string[] }> {
    const f = await editTrashApply(key, true);
    const live = qFrameGuids(f);
    expect(live.length).toBe(4); // QR + M, under P1 and under O1's N
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    return { f, live };
  }

  it('(c) F8: a reload while Q is missing expands its frames from the scene\'s copy, as they were live', async () => {
    // #1914 F8 = A1 (owner, 2026-10-01; Unity's MergedAsMissingWithSceneBackup). Before it the frames were gone and their
    // rows unexpanded (#1790 ruling D). Mutation: drop the copy fallback in `runtimeReaderFor` — no Q frame comes back.
    // Mutation: write no copy (`collectEmbeddedPrefabs` returns undefined) — the same.
    const { f, live } = await savedAndReloaded('keep-reload-embedded');
    expect(qFrameGuids(f)).toEqual(live);
    expect([...unexpandedRows()]).toEqual([]);
    // Every layer still applies over the copy: P's row C moves M to x=4 and states M.z=9; O's row N states z=7, outermost.
    const pm = nestedQ(f, p1(f)).m;
    expect([tx(pm, 'x'), tx(pm, 'z')]).toEqual([4, 9]);
    const o1 = getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.O.guid && pi.rootInstanceId === x.id; })!.id;
    const om = nestedQ(f, o1).m;
    expect([tx(om, 'x'), tx(om, 'y'), tx(om, 'z')]).toEqual([4, 8, 7]);
  });

  it('(c) F8: a row the scene states under a frame the copy expanded is applied, not ALSO kept as an R2 orphan (hunt seed 1212)', async () => {
    // The load's orphan test read the runtime cache alone, so with Q trashed every row under a copy-expanded Q frame was
    // kept as well as applied, and once its mark was undone the save wrote the stale row back under the capture (the seed:
    // O's added node Extra, under a copy-expanded P). Mutation: drop `read: runtimeReaderFor(world)` from the load's
    // `settleEntryRows` — the row is kept as an orphan.
    const f = await editTrashApply('keep-reload-orphans', true);
    const m = nestedQ(f, p1(f)).m;
    expect(writeTraitFieldWithUndo(m, getTraitByName('Transform')!, 'y', 6)).toBeFalsy();
    await settle();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const p1Guid = getAllEntities().find((x) => x.id === p1(f))!.guid!;
    const mGuid = getAllEntities().find((x) => x.id === m)!.guid!;
    const entry = (JSON.parse(be.read(f.scenePath)!) as { entities: { guid?: string; members?: Record<string, { guid?: string; traits?: { Transform?: { y?: number } } }> }[] })
      .entities.find((e) => e.guid === p1Guid)!;
    const rowKey = Object.keys(entry.members ?? {}).find((k) => entry.members![k]!.traits?.Transform?.y === 6);
    expect(rowKey, 'premise: the scene states the edit on M\'s row').toBeTruthy();
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(tx(getAllEntities().find((x) => x.guid === mGuid)!.id, 'y')).toBe(6); // applied, from the copy-expanded frame
    expect(Object.keys(keptMemberOrphans(p1Guid) ?? {})).not.toContain(rowKey);
  });

  it('(c) F8, I23: save → reload → save while Q is missing is byte-identical', async () => {
    // No mutation of this change's own lines turns this red: measured, writing no copy keeps it green, since the records
    // survive the reload either way (I18). It pins I23 over a world expanded FROM a copy, which a change to the record
    // writer could break.
    const { f } = await savedAndReloaded('keep-reload-roundtrip');
    const first = be.read(f.scenePath)!;
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath)!).toBe(first);
  });

  it('(c) F8, I23: an instance made AFTER the trash (its Q row unexpanded live) round-trips byte-identically', async () => {
    // Hunt seeds 351 / 6030's shape: P1 and O1 keep live Q frames, so the save copies Q; P2, instantiated with Q already
    // gone, holds row C unexpanded. The copy restores only a frame that was live at the save (Unity's line: a backup is of
    // an instance merged before its asset went), so P2's row stays unexpanded and the reload is the saved world.
    // Mutation: `copyStandsIn` answers true — P2's row expands from the copy and the second save adds its QR and M rows.
    const f = await editTrashApply('keep-reload-late-instance', true);
    expect(await instantiatePrefabInstance(JSON.parse(be.read(f.prefabs.P.path)!), f.prefabs.P.path, 0)).toBeTruthy();
    await settle();
    expect([...unexpandedRows()].length).toBe(1);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const first = be.read(f.scenePath)!;
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(qFrameGuids(f).length).toBe(4); // P1's and O1's, from the copy
    expect([...unexpandedRows()].length).toBe(1); // P2's
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath)!).toBe(first);
  });

  it('(c) F8, I23: a missing TOP-level instance live at the save is copied with its nested missing prefab, and reloads expanded (#1935)', async () => {
    // P1's Q frames are live, then P goes too, so P1 is a live top-level instance of a missing prefab. The owner's F8 = A1
    // covers top level as well as nested (#1935; R7 had built only the nested half): the save copies P and the Q its
    // frame expanded, and the reload expands P1 from P's copy and its Q frame from Q's. Mutation: leave top-level frames
    // out of `collectEmbeddedPrefabs` again — the first save writes no copy and P1 reloads as a placeholder.
    const f = await startRun(be, noNest, 'keep-top-level-missing');
    const o1 = getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.O.guid && pi.rootInstanceId === x.id; })!.id;
    deleteEntitiesWithUndo([o1]);
    await settle();
    await trashQ(f);
    await trashQ(f, 'P');
    expect(qFrameGuids(f).length).toBe(2); // P1's, live
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const first = be.read(f.scenePath)!;
    expect(Object.keys(JSON.parse(first).embeddedPrefabs ?? {}).sort()).toEqual([f.prefabs.P.guid, f.prefabs.Q.guid].sort());
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(placeholderGuids().size).toBe(0);
    expect(qFrameGuids(f).length).toBe(2); // P1's, from the copies
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath)!).toBe(first);
  });

  it('(c) F8, I23: a ROOT-only prefab\'s top-level instance reloads from the copy too — no member rows to ask (#1935, hunt seed 1011)', async () => {
    // H is one entity, so its live instance H1 states no member rows; it holds a scene-added Q node. Mutation: let the
    // loader expand a top-level entry only when it states member rows (the first version of #1935) — H1 reloads as a
    // placeholder beside its own copy, and the Q node under it leaves the world.
    const f = await startRun(be, noNest, 'keep-top-level-root-only');
    const h1 = () => getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.H.guid && pi.rootInstanceId === x.id; });
    const h1Guid = h1()!.guid!;
    const liveCount = getAllEntities().length;
    await trashQ(f, 'H');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const first = be.read(f.scenePath)!;
    expect(Object.keys(JSON.parse(first).embeddedPrefabs ?? {})).toEqual([f.prefabs.H.guid]);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(placeholderGuids().has(h1Guid)).toBe(false);
    expect(h1()).toBeTruthy();
    expect(getAllEntities().length).toBe(liveCount);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath)!).toBe(first);
  });

  it('(c) F8, I3: a TOP-level instance expanded from the copy refuses Revert and Apply as a missing prefab does (#1935)', async () => {
    // The copy reaches only the expansion: Revert and Apply ask `getPrefabSource`, so the reloaded P1 is refused with the
    // missing-prefab reason, not reverted onto or applied into a copy. Mutation: let `getPrefabSource` answer from the
    // scene's copies — Revert finds a base and returns no refusal.
    const f = await startRun(be, noNest, 'keep-top-level-refusals');
    const o1 = getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.O.guid && pi.rootInstanceId === x.id; })!.id;
    deleteEntitiesWithUndo([o1]);
    await settle();
    expect(writeTraitFieldWithUndo(p1(f), getTraitByName('Transform')!, 'x', 7)).toBeFalsy();
    await settle();
    await trashQ(f, 'P');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(placeholderGuids().size).toBe(0); // premise: P1 expanded from the copy
    expect(await revertRefusal(p1(f))).toMatch(/is an instance of "P", a prefab that is missing \(/);
    const guid = getAllEntities().find((e) => e.id === p1(f))!.guid!;
    const err = await runAgentOp('prefab', { prefabAction: 'apply', entityGuid: guid }).catch((e: Error) => e) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/a prefab that is missing \(/);
  });

  it('(c) F8, I23: a copy only a top-level PLACEHOLDER nests is not written — hunt seed 1031', async () => {
    // A file saved before #1935 (no copy of P): P1 reloads as its placeholder. Its record names Q, but no load expands
    // it, so a copy reached through it is bytes nothing reads, and the save after the reload could not reach it: the
    // first save carried it and the second did not. Q's copy stays loaded, so it is a candidate only the reach leaves out.
    // Mutation: write every candidate whatever the reach (`collectEmbeddedPrefabs`) — the save after the reload writes
    // Q's copy. (With every copy stripped the store was empty and the reach never ran: the test could not fail.)
    const f = await startRun(be, noNest, 'keep-top-level-placeholder');
    const o1 = getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.O.guid && pi.rootInstanceId === x.id; })!.id;
    deleteEntitiesWithUndo([o1]);
    await settle();
    await trashQ(f);
    await trashQ(f, 'P');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const saved = JSON.parse(be.read(f.scenePath)!) as { embeddedPrefabs?: Record<string, unknown> };
    expect(Object.keys(saved.embeddedPrefabs ?? {}).sort()).toEqual([f.prefabs.P.guid, f.prefabs.Q.guid].sort());
    delete saved.embeddedPrefabs![f.prefabs.P.guid]; // Q's copy stays loaded: a candidate the reach has to leave out
    be.write(f.scenePath, `${JSON.stringify(saved, null, 2)}\n`);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(placeholderGuids().size).toBe(1); // P1
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const first = be.read(f.scenePath)!;
    expect(JSON.parse(first).embeddedPrefabs).toBeUndefined();
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath)!).toBe(first);
  });

  it('(c) F8: a SCENE-ADDED Q node reloads as its placeholder, the copy beside it notwithstanding', async () => {
    // A copy stands in for a template row's frame only; a missing reference node keeps #1699's placeholder.
    // Mutation: `spawnReferenceNode` reads through the copies — the node reloads expanded, not as a placeholder.
    const f = await startRun(be, noNest, 'keep-reload-added-node');
    const hr = getAllEntities().find((e) => { const pi = piOf(e.id); return pi?.source === f.prefabs.H.guid && pi.rootInstanceId === e.id; })!.id;
    expect(await instantiatePrefabInstance(JSON.parse(be.read(f.prefabs.Q.path)!), f.prefabs.Q.path, hr)).toBeTruthy();
    await settle();
    const nodeGuid = getAllEntities().find((e) => e.id === nestedQ(f, hr).qr)!.guid!;
    await trashQ(f);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(Object.keys(JSON.parse(be.read(f.scenePath)!).embeddedPrefabs)).toEqual([f.prefabs.Q.guid]); // P1's and O1's frames
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(placeholderGuids().has(nodeGuid)).toBe(true);
    expect(qFrameGuids(f).length).toBe(4); // P1's and O1's rows, from the copy
  });

  it('(c) F8, I3: a frame expanded from the copy is refused by Revert and Apply as a missing prefab is', async () => {
    // The copy stands in for the expansion only: the "is the prefab there" checks still ask for the real file.
    // Mutation: serve the copy from the editor cache too (a fallback in `getPrefabSource`) — both refusals go.
    const { f } = await savedAndReloaded('keep-reload-refuse');
    const { qr, m } = nestedQ(f, p1(f));
    expect(await revertRefusal(qr)).toMatch(/^"QR" is an instance of "Q", a prefab that is missing \(/);
    expect(writeTraitFieldWithUndo(m, getTraitByName('Transform')!, 'x', 42)).toBeFalsy();
    await settle();
    expect((await previewApply(qr, new Set(['x']))).refused).toMatch(/nothing to apply it to\. Restore the prefab to apply to it, or Detach Prefab/);
  });

  it('(c) F8, I18: every save while Q is missing carries the copy verbatim, and a scene that no longer reaches Q drops it', async () => {
    // Mutation: skip the reach (write every candidate) — the last save still holds Q's copy. (Dropping the
    // `embeddedPrefabGuids` loop stays green here, since the live frames hold the copy; the next case answers that loop.)
    // Mutation: serve the copy from `getPrefabSource` — Q reads as present, so no save copies it.
    const { f } = await savedAndReloaded('keep-reload-carry');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(JSON.parse(be.read(f.scenePath)!).embeddedPrefabs).toEqual({ [f.prefabs.Q.guid]: trashedQ.get(f) });
    // Delete both instances that expand Q (P1, and O1 through its row N): nothing in the file names Q any more.
    const o1 = getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.O.guid && pi.rootInstanceId === x.id; })!.id;
    deleteEntitiesWithUndo([p1(f), o1]);
    await settle();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(JSON.parse(be.read(f.scenePath)!).embeddedPrefabs).toBeUndefined();
  });

  it('(c) F8, I18: a row the copy could not expand keeps the copy the scene carried', async () => {
    // The loaded copy is written back even with no live frame holding it. Mutation: drop the `embeddedPrefabGuids` loop in
    // `collectEmbeddedPrefabs` — the second save writes no copy, and the row's next reload is unexpanded for good.
    const { f } = await savedAndReloaded('keep-reload-unexpanded');
    const file = JSON.parse(be.read(f.scenePath)!) as { embeddedPrefabs: Record<string, { rootLocalId?: number }> };
    // A copy whose root names no row expands to no root (#1768): the frames are not spawned, the rows stay unexpanded.
    file.embeddedPrefabs[f.prefabs.Q.guid]!.rootLocalId = 99;
    be.write(f.scenePath, `${JSON.stringify(file, null, 2)}\n`);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(qFrameGuids(f)).toEqual([]);
    expect([...unexpandedRows()].length).toBe(2);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(JSON.parse(be.read(f.scenePath)!).embeddedPrefabs).toEqual(file.embeddedPrefabs);
  });

  it('(b) F8: once Q is back, the RETURNED prefab wins over the copy, and the next save drops the copy', async () => {
    // Mutation: read the copy first in `runtimeReaderFor` — M.y reads the copy's 0, not the returned file's 6.
    const { f, live } = await savedAndReloaded('keep-reload-return');
    // Put back by hand (from the OS Trash — an Assets delete is not undoable, #1868 D2), CHANGED: M now stands at y=6.
    const q = trashedQ.get(f) as { entities: { name: string; traits: { Transform: { y: number } } }[] };
    const returned = JSON.parse(JSON.stringify(q)) as typeof q;
    returned.entities.find((r) => r.name === 'M')!.traits.Transform.y = 6;
    const before = be.snapshot();
    be.write(f.prefabs.Q.path, `${JSON.stringify(returned, null, 2)}\n`);
    await flushWatcher(be, before);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(qFrameGuids(f)).toEqual(live);
    expect([...unexpandedRows()]).toEqual([]);
    const m = nestedQ(f, p1(f)).m;
    expect([tx(m, 'x'), tx(m, 'y')]).toEqual([4, 6]);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(JSON.parse(be.read(f.scenePath)!).embeddedPrefabs).toBeUndefined();
  });

  it('a v18 file (no copies) still loads: the rows stay unexpanded and their records kept, as before v19', async () => {
    // Mutation: the gate's `minReadable` raised to the current version — the v18 file is refused. (Dropping the v18→v19
    // rung's stamp cannot fail here: the writer stamps the constant whatever the rung did.)
    const { f } = await savedAndReloaded('keep-reload-v18');
    const { embeddedPrefabs: _, ...v18 } = JSON.parse(be.read(f.scenePath)!) as Record<string, unknown>;
    be.write(f.scenePath, `${JSON.stringify({ ...v18, version: 18 }, null, 2)}\n`);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(qFrameGuids(f)).toEqual([]);
    expect([...unexpandedRows()].length).toBe(2);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const saved = JSON.parse(be.read(f.scenePath)!) as { version: number; embeddedPrefabs?: unknown };
    expect(saved.version).toBe(19);
    expect(saved.embeddedPrefabs).toBeUndefined(); // no frame holds Q and no loaded scene carried it: nothing to copy
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

  /** Edit M's `Transform.x` inside P1's nested Q frame (and A's `Transform.y` when `alsoA`), optionally trash Q, and run the
   *  dialog's Apply from P1 (default targets) over the M key, plus A's when `alsoA`. */
  async function applyNestedKey(key: string, trash: boolean, alsoA = false): Promise<{ f: Fixture; preview: Awaited<ReturnType<typeof previewApply>>; result: Awaited<ReturnType<typeof applyToPrefabWithUndo>> }> {
    const f = await startRun(be, noNest, key);
    expect(writeTraitFieldWithUndo(nestedQ(f, p1(f)).m, getTraitByName('Transform')!, 'x', 42)).toBeFalsy();
    if (alsoA) expect(writeTraitFieldWithUndo(member(p1(f), 'A'), getTraitByName('Transform')!, 'y', 9)).toBeFalsy();
    await settle();
    if (trash) await trashQ(f);
    await preloadNestedPrefabsForSubtree(p1(f));
    const prefab = getCachedPrefabSync(f.prefabs.P.guid)!;
    const keys = collectInstanceOverrideKeys(p1(f), prefab);
    const sel = new Set([...keys.all, ...keys.nested].filter((k) => /\.Transform\.x$/.test(k) || (alsoA && /\.Transform\.y$/.test(k))));
    expect(sel.size).toBe(alsoA ? 2 : 1);
    const targets = toApplyTargets(initialTargets(applyTargetOptions(p1(f), prefab, [...sel])), sel);
    const preview = await previewApply(p1(f), new Set(sel), targets);
    const result = await applyToPrefabWithUndo(p1(f), sel, targets, { expect: preview.fingerprint });
    await settle();
    return { f, preview, result };
  }
  const MISSING_Q = /^"QR" is an instance of "Q", a prefab that is missing \(.*\), so there is nothing to apply it to\. Restore the prefab to apply to it, or Detach Prefab to keep it as plain entities\.$/;

  it('a nested key into the kept frame is not applied, with the true reason (not "the template has changed")', async () => {
    // Mutation: drop the `missingNestedFrameKeys` filter in `planApply` — the key is skipped as "the template has changed
    // since the key was listed" again.
    const { preview, result } = await applyNestedKey('apply-nested-skip', true);
    expect(result.applied).toBe(false);
    expect(result.refused).toBeUndefined();
    expect(result.skipped?.length).toBe(1);
    expect(result.skipped![0]!.reason).toMatch(MISSING_Q);
    // The dialog's row says it before the click: the preview's effect for that key.
    expect(preview.effects.map((e) => e.effect)).toEqual([{ op: 'notApplied', reason: result.skipped![0]!.reason }]);
  });

  it('the agent\'s key-less apply over only a kept-frame key leads with that reason, not the "stopped being an instance" guess', async () => {
    // Mutation: put back the op's single throw that led with the guess — the message starts with "the apply produced no change".
    const f = await startRun(be, noNest, 'apply-nested-agent');
    expect(writeTraitFieldWithUndo(nestedQ(f, p1(f)).m, getTraitByName('Transform')!, 'x', 42)).toBeFalsy();
    await settle();
    await trashQ(f);
    const guid = getAllEntities().find((e) => e.id === p1(f))!.guid!;
    const err = await runAgentOp('prefab', { prefabAction: 'apply', entityGuid: guid }).catch((e: Error) => e) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^prefab apply: nothing was written\. Not applied: .*\("QR" is an instance of "Q", a prefab that is missing \(/);
  });

  it('Apply All with a kept-frame key still lands the other keys (the kept-frame key is skipped, not the whole Apply)', async () => {
    // Mutation: refuse the whole Apply when any key reaches into the kept frame (the first version of this fix) — A.y is
    // not written, and the dialog's default Apply All and the agent's key-less `apply` land nothing.
    const { f, result } = await applyNestedKey('apply-nested-mixed', true, true);
    expect(result.refused).toBeUndefined();
    expect(result.applied).toBe(true);
    expect(result.skipped?.map((x) => x.reason)).toEqual([expect.stringMatching(MISSING_Q)]);
    const a = JSON.parse(be.read(f.prefabs.P.path)!).entities.find((r: { name: string }) => r.name === 'A');
    expect(a.traits.Transform.y).toBe(9);
  });

  it('Apply All over a scene-added node that holds a kept frame skips that node with its reason and lands the rest — it used to write a reference to the trashed prefab and take the frame out of the world', async () => {
    // Mutation: drop the `keptAddedKeys` check in `planApply` — the node is promoted: H's file gains a row naming the
    // trashed Q, and QR and M leave the live world. Mutation: refuse the whole Apply for it — HR.y is not written.
    const f = await startRun(be, noNest, 'apply-added-kept');
    const hr = getAllEntities().find((e) => { const pi = piOf(e.id); return pi?.source === f.prefabs.H.guid && pi.rootInstanceId === e.id; })!.id;
    expect(await instantiatePrefabInstance(JSON.parse(be.read(f.prefabs.Q.path)!), f.prefabs.Q.path, hr)).toBeTruthy();
    await settle();
    const node = nestedQ(f, hr);
    const guids = [node.qr, node.m].map((id) => getAllEntities().find((e) => e.id === id)!.guid!);
    await trashQ(f);
    expect(writeTraitFieldWithUndo(hr, getTraitByName('Transform')!, 'y', 9)).toBeFalsy();
    await settle();
    const prefab = getCachedPrefabSync(f.prefabs.H.guid)!;
    const keys = collectInstanceOverrideKeys(hr, prefab);
    const sel = new Set([...keys.all, ...keys.nested]); // the dialog's default: every key
    const added = [...sel].filter((k) => k.startsWith('+added.'));
    expect(added.length).toBe(1);
    const targets = toApplyTargets(initialTargets(applyTargetOptions(hr, prefab, [...sel])), sel);
    const preview = await previewApply(hr, new Set(sel), targets);
    expect(preview.refused).toBeUndefined();
    const result = await applyToPrefabWithUndo(hr, sel, targets, { expect: preview.fingerprint });
    await settle();
    expect(result.refused).toBeUndefined();
    expect(result.applied).toBe(true);
    expect(result.skipped).toEqual([{ key: added[0], reason: expect.stringMatching(/^"QR" is an instance of "Q", a prefab that is missing \(.*\), so it cannot be written into a template until that prefab is back$/) }]);
    const h = JSON.parse(be.read(f.prefabs.H.path)!) as { entities: { prefab?: string; name: string; traits: { Transform?: { y?: number } } }[] };
    expect(h.entities.some((r) => r.prefab === f.prefabs.Q.guid)).toBe(false);
    expect(h.entities.find((r) => r.name === 'HR')!.traits.Transform!.y).toBe(9);
    for (const g of guids) expect(getAllEntities().some((e) => e.guid === g)).toBe(true);
  });

  // #1831 G1 M5's directed replay: seed 5104 turned a kept Q frame into a placeholder at an Apply, but only after a
  // reparent of an owned nested root, which Unity forbids (U7, #1869). This is the Unity-legal route the study asked
  // about: Q dropped under a scene-added PLAIN node, Q trashed, then Apply All. Mutation: drop the `keptAddedKeys` check
  // in `planApply` — the node is promoted with a reference to the trashed Q, and QR and M leave the live world.
  it('(M5) a Q frame under a scene-added plain node, Q trashed, Apply All: the node is skipped and the frame stays live, never a placeholder', async () => {
    const f = await startRun(be, noNest, 'apply-added-plain-kept');
    const hr = getAllEntities().find((e) => { const pi = piOf(e.id); return pi?.source === f.prefabs.H.guid && pi.rootInstanceId === e.id; })!.id;
    const x = createEntityWithUndo('Create', hr, [{ name: 'EntityAttributes', data: { name: 'X', parentId: hr } }, { name: 'Transform' }], () => {});
    expect(x).toBeTruthy();
    expect(await instantiatePrefabInstance(JSON.parse(be.read(f.prefabs.Q.path)!), f.prefabs.Q.path, x!)).toBeTruthy();
    await settle();
    const node = nestedQ(f, x!);
    const guids = [node.qr, node.m].map((id) => getAllEntities().find((e) => e.id === id)!.guid!);
    await trashQ(f);
    expect(writeTraitFieldWithUndo(hr, getTraitByName('Transform')!, 'y', 9)).toBeFalsy();
    await settle();
    const prefab = getCachedPrefabSync(f.prefabs.H.guid)!;
    const keys = collectInstanceOverrideKeys(hr, prefab);
    const sel = new Set([...keys.all, ...keys.nested]);
    const targets = toApplyTargets(initialTargets(applyTargetOptions(hr, prefab, [...sel])), sel);
    const preview = await previewApply(hr, new Set(sel), targets);
    expect(preview.refused).toBeUndefined();
    const result = await applyToPrefabWithUndo(hr, sel, targets, { expect: preview.fingerprint });
    await settle();
    expect(result.applied).toBe(true);
    expect(result.skipped?.map((s) => s.reason)).toEqual([expect.stringMatching(/^"QR" is an instance of "Q", a prefab that is missing \(.*\), so it cannot be written into a template until that prefab is back$/)]);
    const h = JSON.parse(be.read(f.prefabs.H.path)!) as { entities: { prefab?: string; name: string; traits: { Transform?: { y?: number } } }[] };
    expect(h.entities.some((r) => r.prefab === f.prefabs.Q.guid)).toBe(false);
    expect(h.entities.find((r) => r.name === 'HR')!.traits.Transform!.y).toBe(9);
    for (const g of guids) {
      const e = getAllEntities().find((y) => y.guid === g);
      expect(e).toBeTruthy();
      expect(placeholderGuids().has(g)).toBe(false);
    }
  });

  it('the same nested key with Q present applies (the check is not a refusal of every nested key)', async () => {
    const { f, preview, result } = await applyNestedKey('apply-nested-accept', false);
    expect(preview.refused).toBeUndefined();
    expect(result.refused).toBeUndefined();
    expect(result.applied).toBe(true);
    expect(tx(nestedQ(f, p1(f)).m, 'x')).toBe(42);
  });

  it('an Apply on the kept frame itself refuses, naming the missing prefab, where it answered a bare applied:false', async () => {
    // Mutation: put back the bare `NOOP_APPLY` for a source that does not load — `refused` is undefined again.
    const f = await editTrashApply('apply-kept-root', true);
    const { qr, m } = nestedQ(f, p1(f));
    expect(writeTraitFieldWithUndo(m, getTraitByName('Transform')!, 'x', 42)).toBeFalsy();
    await settle();
    const preview = await previewApply(qr, new Set(['x']));
    expect(preview.refused).toContain('"QR" is an instance of "Q", a prefab that is missing (');
    const result = await applyToPrefabWithUndo(qr, new Set(['x']));
    expect(result.applied).toBe(false);
    expect(result.refused).toBe(preview.refused);
    expect(result.refused).toMatch(/nothing to apply it to\. Restore the prefab to apply to it, or Detach Prefab/);
    // The agent op stops at its own load check, before either: it says the same, not a bare "could not load" guid.
    // Mutation: put back the op's `could not load prefab source` throw — these two go red.
    const guid = getAllEntities().find((e) => e.id === qr)!.guid!;
    for (const [op, tail] of [['apply', /nothing to apply it to\./], ['revert', /nothing to revert it to\./], ['overrides', /nothing to apply it to or revert it to\./]] as const) {
      const err = await runAgentOp('prefab', { prefabAction: op, entityGuid: guid }).catch((e: Error) => e) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain(`prefab ${op} refused: "QR" is an instance of "Q", a prefab that is missing (`);
      expect(err.message).toMatch(tail);
    }
  });
});

describe('#1877 L4: a kept reference node INSIDE another reference node is kept too', () => {
  // A scene-added P node under H1, and a Q node dropped under that P node's A: the Q node rides in the P node's rows,
  // not in any `children`. Mutation: `withoutKeptNodes` walks `children` only (`withoutKeptNodesInside` returns `n`) —
  // the Revert respawns Q as a placeholder beside the kept frame, M goes, and no undo brings it back.
  it('Q trashed, a Revert on H1: Q stays one live frame (no placeholder), M survives, and the undo keeps it', async () => {
    const f = await startRun(be, noNest, 'keep-1877-l4');
    const hr = getAllEntities().find((e) => { const pi = piOf(e.id); return pi?.source === f.prefabs.H.guid && pi.rootInstanceId === e.id; })!.id;
    const pNode = await instantiatePrefabInstance(JSON.parse(be.read(f.prefabs.P.path)!), f.prefabs.P.path, hr);
    await settle();
    const a = getAllEntities().find((e) => e.name === 'A' && piOf(e.id)?.rootInstanceId === pNode)!.id;
    const qNode = await instantiatePrefabInstance(JSON.parse(be.read(f.prefabs.Q.path)!), f.prefabs.Q.path, a);
    await settle();
    const qGuid = getAllEntities().find((e) => e.id === qNode)!.guid!;
    const mGuid = getAllEntities().find((e) => e.name === 'M' && e.parentId === qNode)!.guid!;
    await trashQ(f);
    expect(getAllEntities().filter((e) => e.guid === qGuid)).toHaveLength(1);
    expect(writeTraitFieldWithUndo(hr, getTraitByName('Transform')!, 'y', 9)).toBeFalsy();
    await settle();
    const sel = new Set(collectInstanceOverrideKeys(hr, getCachedPrefabSync(f.prefabs.H.guid)!).all.filter((k) => /\.Transform\.y$/.test(k)));
    expect(sel.size).toBe(1);
    expect(await revertOverridesWithUndo(hr, sel)).not.toBeNull();
    await settle();
    const alive = () => ({
      holders: getAllEntities().filter((e) => e.guid === qGuid).length,
      placeholder: placeholderGuids().has(qGuid),
      m: getAllEntities().some((e) => e.guid === mGuid),
    });
    expect(alive()).toEqual({ holders: 1, placeholder: false, m: true });
    const u = await undoStep('undo');
    await settle();
    expect(u.failed ?? null).toBeNull();
    expect(alive()).toEqual({ holders: 1, placeholder: false, m: true });
  });
});
