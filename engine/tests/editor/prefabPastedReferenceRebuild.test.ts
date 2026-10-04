/** #1826 — a rebuild respawns a SCENE-ADDED reference node as the save writes it, so what it shows live is what a reload
 *  shows.
 *
 *  O's N row states its deep member M through a MEMBER ROW (`/C/M`: `Transform.y = 8`, a v6 template row). Paste a copy
 *  of an O instance under P1 (a scene-added reference node), and every rebuild of P1 — Revert, Apply, their undo, a
 *  refresh of a frame holding the copy — captured the copy in the in-memory transport form: its scene edits inside its
 *  nested frames as `nestedOverrides` and whole-frame `nestedStructure` slots, where the save writes member rows. Respawned
 *  through the loader's one expansion, that form folds differently from the rows:
 *  - a second copy pasted under the first copy's M gives the node a slot for M's frame; a slot owns its frame, so the
 *    fold skipped O's member row there, and M showed y = 0 until a reload brought 8 back (win's seed 6068,
 *    in `prefabFuzz/knownOpen.ts` REGRESSIONS);
 *  - a scene edit of that M (y = 3) rode `nestedOverrides`, which merge UNDER every layer's rows, so O's row beat it: 8
 *    live, and the next save wrote 8. The edit was lost.
 *  The same held for a reference node a TEMPLATE adds (H's row adds O under its P row's A): a scene edit inside it was
 *  lost by a partial Revert of H1, live and saved. The fix made what a rebuild RESPAWNED take its reference nodes in the
 *  save's rows form, by hand; since #1880 F6 a rebuild is the load of the entry the save's own writer states, so it does
 *  by construction, and F7d deleted the hand-made respawn form with the old route. A capture that is READ keeps the
 *  legacy form — the comparisons against the chain's nodes, and Apply's promotion, whose case here is the close-out
 *  review's F1 (capturing every scene-added node as rows at the source dropped the members' edits of a node Apply
 *  promoted). Each node is asserted to come back WHERE it sat, not only with its values (`placedAt`).
 *
 *  Mutations: the capture made in rows at the source (the first fix) reddens the promotion and the template-added node.
 *  The old route's own mutations (no swap at its respawn, none on a node row's `own`, the placement dropped) went with
 *  it. (The save's legacy comparison of a template reference node — in rows it restated the node on every save — is
 *  pinned by nestedRowFieldSave / templateReferenceNodeRows, not here.)
 *
 *  Driven through the prefab fuzzer's harness: the real backend route, SceneManager, both caches, prefab edit, the undo
 *  stack and the simulated watcher. */

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
import { getTraitByName } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored, type Fixture } from './prefabFuzz/harness';
import { applyReparent, clipEntity, pasteEntityCopy, writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { revertOverridesWithUndo } from '../../packages/modoki/src/editor/undo/revertPrefabUndo';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { previewApply } from '../../packages/modoki/src/editor/scene/prefabApply';
import { applyTargetOptions } from '../../packages/modoki/src/editor/scene/prefabApplyOptions';
import { initialTargets, toApplyTargets } from '../../packages/modoki/src/editor/panels/applyDialogModel';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { getCachedPrefabSync, preloadNestedPrefabsForSubtree } from '../../packages/modoki/src/editor/scene/prefabCache';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { findEntity, readTraitData } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { overrideKeysOf } from '../../packages/modoki/src/editor/instance/instanceOverrideView';
import { templateKeyOf } from '../../packages/modoki/src/runtime/core/templateIdentity';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

/** A fixture entity by name and the scene guid it loads with (`ffffffff-…-8<id>-…`): a rebuild re-mints ids. */
const fixture = (name: string, id: number) => authored().find((e) => e.name === name && e.guid?.startsWith(`ffffffff-0000-4000-800${id}-`))!;
const p1 = () => fixture('R', 2);
const o1 = () => fixture('OR', 1);
const kid = (name: string, parentId: number) => authored().find((e) => e.name === name && e.parentId === parentId)!;
/** The deep M of the O instance rooted at `orId`: OR → R (the N row) → QR (P's C row) → M, which O's member row sets. */
const deepM = (orId: number) => kid('M', kid('QR', kid('R', orId).id).id);
const transformY = (id: number) => (readTraitData(id, getTraitByName('Transform')!) as { y: number }).y;
const marks = (id: number) => [...(overrideKeysOf(findEntity(id) as never) ?? [])].sort();
/** The guids from the entity holding `guid` up to its scene root: where it sits, by identity. */
const ancestry = (guid: string): string[] => {
  const out: string[] = [];
  for (let e = authored().find((x) => x.guid === guid); e; e = authored().find((x) => x.id === e!.parentId)) out.push(e.guid ?? '?');
  return out;
};
/** Where each M sat before the rebuild, per M guid: the rebuild must respawn it there (its placement, not only its values). */
const placedAt = new Map<string, string[]>();

/** Give P1 something to revert: the fixture's Leaf moved under it (an added node). */
async function moveLeafUnderP1(): Promise<void> {
  expect(applyReparent(fixture('Leaf', 5).id, p1().id).ok).toBe(true);
  await settle();
}

/** Paste a copy of O1 under `hostId`; `edit` sets its deep M's y to 3; `second` pastes the copy again under that M.
 *  Returns the M's guid, which every rebuild keeps. */
async function pasteCopy(hostId: number, opts: { edit?: boolean; second?: boolean }): Promise<string> {
  const clip = clipEntity(o1().id, 'copy')!;
  const first = pasteEntityCopy(clip, hostId, () => {})!;
  await settle();
  const m = deepM(first);
  if (opts.edit) { expect(writeTraitFieldWithUndo(m.id, getTraitByName('Transform')!, 'y', 3)).toBeFalsy(); await settle(); }
  if (opts.second) { pasteEntityCopy(clip, m.id, () => {}); await settle(); }
  placedAt.set(m.guid!, ancestry(m.guid!));
  return m.guid!;
}

async function revert(rootId: number, source: string, pick: (keys: string[]) => string[] = (k) => k): Promise<void> {
  await preloadNestedPrefabsForSubtree(rootId);
  const keys = new Set(pick(collectInstanceOverrideKeys(rootId, getCachedPrefabSync(source)!).all));
  expect(keys.size).toBeGreaterThan(0);
  expect(await revertOverridesWithUndo(rootId, keys)).toBeTruthy();
  await settle();
}

/** P1's Apply of its added keys (the Leaf), to its own prefab P: every P frame refreshes, P1's and O1's N among them. */
async function applyP1(f: Fixture): Promise<void> {
  await preloadNestedPrefabsForSubtree(p1().id);
  const prefab = getCachedPrefabSync(f.prefabs.P.guid)!;
  const sel = new Set(collectInstanceOverrideKeys(p1().id, prefab).all.filter((k) => k.startsWith('+')));
  expect(sel.size).toBeGreaterThan(0);
  const targets = toApplyTargets(initialTargets(applyTargetOptions(p1().id, prefab, [...sel])), sel);
  const pv = await previewApply(p1().id, new Set(sel), targets);
  expect((await applyToPrefabWithUndo(p1().id, sel, targets, { expect: pv.fingerprint })).applied).toBe(true);
  await settle();
}

/** O's member row's value for M: the copy's BASE, so unrecorded (#1914); the scene's own edit (3) is recorded. */
const ROW_Y = 8;

/** M (by guid) shows `y` live — recorded when it is the scene's own edit, not when it is O's row's (`ROW_Y`) — and a
 *  save → reload shows the same value and marks. */
async function holdsLiveAndSaved(f: Fixture, mGuid: string, y: number): Promise<void> {
  const live = authored().find((e) => e.guid === mGuid)!;
  const before = { y: transformY(live.id), marks: marks(live.id) };
  expect(before.y, 'live').toBe(y);
  if (y === ROW_Y) expect(before.marks, 'live marks').not.toContain('Transform.y');
  else expect(before.marks, 'live marks').toContain('Transform.y');
  const where = placedAt.get(mGuid);
  if (where) expect(ancestry(mGuid), 'live: respawned where it sat').toEqual(where);
  expect((await saveScene({ allowDialog: false })).saved).toBe(true);
  expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
  await settle();
  const reloaded = authored().find((e) => e.guid === mGuid)!;
  expect({ y: transformY(reloaded.id), marks: marks(reloaded.id) }, 'live == saved').toEqual(before);
  if (where) expect(ancestry(mGuid), 'saved where it sat').toEqual(where);
}

/** H's template, edited: P nested as a ROW under HR (an instance placed under the root becomes one), and under that row's A
 *  a plain `T` (`withT`) and/or O (`withO`) — nodes the H template ADDS, keyed on the row's `added`. */
async function authorH(f: Fixture, opts: { withT?: boolean; withO?: boolean }): Promise<void> {
  expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' }, { confirmDiscard: async () => true })).toBeFalsy();
  const hrEdit = authored().find((e) => e.name === 'HR')!;
  expect(await placePrefabFromPath(f.prefabs.P.path, { tag: 'test', parentId: hrEdit.id })).toBeTruthy();
  await settle();
  const aEdit = kid('A', kid('R', hrEdit.id).id);
  if (opts.withT) {
    expect(createEntityWithUndo('Create T', aEdit.id, [{ name: 'EntityAttributes', data: { name: 'T', parentId: aEdit.id } }, { name: 'Transform', data: { x: 0, y: 0, z: 0 } }] as never, () => {})).toBeTruthy();
    await settle();
  }
  if (opts.withO) { expect(await placePrefabFromPath(f.prefabs.O.path, { tag: 'test', parentId: aEdit.id })).toBeTruthy(); await settle(); }
  expect((await savePrefabEditReport({})).saved).toBe(true);
  await exitPrefabEditing();
  await settle();
}
const h1 = () => fixture('HR', 3);
/** H1's A inside its P row: where the H template's nodes hang. */
const h1A = () => kid('A', kid('R', h1().id).id);
/** Revert only H1's Leaf (moved under it): a partial Revert, which rebuilds H1 and leaves every other edit to the re-apply. */
const revertLeafOnH1 = (f: Fixture) => revert(h1().id, f.prefabs.H.guid, (keys) => keys.filter((k) => k.startsWith('+added.') && k.includes(fixture('Leaf', 5).guid!)));

describe('a rebuild respawns a pasted reference node as the save writes it (#1826)', () => {
  it("the hub's user path: Revert All on P1 keeps the copy's M at O's row value, unrecorded (seed 6068)", async () => {
    const f = await startRun(be, async () => {}, 'pasted-ref-revert');
    await moveLeafUnderP1();
    const m = await pasteCopy(kid('QR', p1().id).id, { second: true });
    await revert(p1().id, f.prefabs.P.guid);
    await holdsLiveAndSaved(f, m, ROW_Y);
  });

  it("the data-loss sibling: Revert All on P1 keeps the scene's own edit of the copy's M (no second paste)", async () => {
    const f = await startRun(be, async () => {}, 'pasted-ref-edit');
    await moveLeafUnderP1();
    const m = await pasteCopy(kid('QR', p1().id).id, { edit: true });
    await revert(p1().id, f.prefabs.P.guid);
    await holdsLiveAndSaved(f, m, 3);
  });

  it("P1's Apply rebuilds P1 around the copy", async () => {
    const f = await startRun(be, async () => {}, 'pasted-ref-apply');
    await moveLeafUnderP1();
    const m = await pasteCopy(kid('QR', p1().id).id, { second: true });
    await applyP1(f);
    await holdsLiveAndSaved(f, m, ROW_Y);
  });

  it("Revert All's undo rebuilds P1 from its capture", async () => {
    const f = await startRun(be, async () => {}, 'pasted-ref-revert-undo');
    await moveLeafUnderP1();
    const m = await pasteCopy(kid('QR', p1().id).id, { second: true });
    await revert(p1().id, f.prefabs.P.guid);
    expect((await undoStep('undo')).did, 'the undo ran').toBe(true);
    await settle();
    await holdsLiveAndSaved(f, m, ROW_Y);
  });

  it("P1's Apply refreshes another frame holding the copy: O1's N (a P frame), the copy under its A", async () => {
    const f = await startRun(be, async () => {}, 'pasted-ref-refresh');
    await moveLeafUnderP1();
    const m = await pasteCopy(kid('A', kid('R', o1().id).id).id, { second: true });
    await applyP1(f);
    await holdsLiveAndSaved(f, m, ROW_Y);
  });

  it("Apply promotes a pasted reference node into O with its members' edits (the close-out review's F1)", async () => {
    const f = await startRun(be, async () => {}, 'pasted-ref-promote');
    const copy = pasteEntityCopy(clipEntity(p1().id, 'copy')!, o1().id, () => {})!;
    await settle();
    const copyGuid = authored().find((e) => e.id === copy)!.guid!;
    expect(writeTraitFieldWithUndo(kid('A', copy).id, getTraitByName('Transform')!, 'x', 9)).toBeFalsy();
    await settle();
    await preloadNestedPrefabsForSubtree(o1().id);
    const prefab = getCachedPrefabSync(f.prefabs.O.guid)!;
    const sel = new Set(collectInstanceOverrideKeys(o1().id, prefab).all.filter((k) => k === `+added.${copyGuid}`));
    expect(sel.size).toBe(1);
    const targets = toApplyTargets(initialTargets(applyTargetOptions(o1().id, prefab, [...sel])), sel);
    const pv = await previewApply(o1().id, new Set(sel), targets);
    expect((await applyToPrefabWithUndo(o1().id, sel, targets, { expect: pv.fingerprint })).applied).toBe(true);
    await settle();
    const xs = () => authored().filter((e) => e.name === 'R' && e.parentId === o1().id).map((r) => (readTraitData(kid('A', r.id).id, getTraitByName('Transform')!) as { x: number }).x);
    expect(xs(), 'live: the promoted row states A.x').toContain(9);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(xs(), 'after a reload').toContain(9);
  });

  // The nested re-apply's third respawn channel: a node row's `own`, the scene's nodes under a template node it matched
  // (the close-out re-review's F1: `applyNodeRowsLive` spawned the copy from its legacy channels).
  for (const shape of ['edit', 'second paste'] as const) {
    it(`a copy pasted under a plain node the H template adds (a node row's own), ${shape}: a partial Revert of H1 keeps M`, async () => {
      const f = await startRun(be, async () => {}, `pasted-ref-node-row-own-${shape}`);
      await authorH(f, { withT: true });
      expect(applyReparent(fixture('Leaf', 5).id, h1().id).ok).toBe(true);
      await settle();
      const m = await pasteCopy(kid('T', h1A().id).id, shape === 'edit' ? { edit: true } : { second: true });
      await revertLeafOnH1(f);
      await holdsLiveAndSaved(f, m, shape === 'edit' ? 3 : ROW_Y);
    });
  }

  it('a reference node a TEMPLATE adds (H\'s P row adds O under A) keeps a scene edit inside it across a partial Revert of H1', async () => {
    const f = await startRun(be, async () => {}, 'pasted-ref-template-node');
    // H nests P as a ROW (an instance placed under the root becomes one), and O dropped under that row's A is a reference
    // node the H template ADDS: keyed, on the row's `added`.
    expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' }, { confirmDiscard: async () => true })).toBeFalsy();
    const hrEdit = authored().find((e) => e.name === 'HR')!;
    expect(await placePrefabFromPath(f.prefabs.P.path, { tag: 'test', parentId: hrEdit.id })).toBeTruthy();
    await settle();
    const aEdit = kid('A', kid('R', hrEdit.id).id);
    expect(await placePrefabFromPath(f.prefabs.O.path, { tag: 'test', parentId: aEdit.id })).toBeTruthy();
    await settle();
    expect((await savePrefabEditReport({})).saved).toBe(true);
    await exitPrefabEditing();
    await settle();
    const hr = () => fixture('HR', 3);
    const node = kid('OR', kid('A', kid('R', hr().id).id).id);
    expect(templateKeyOf(findEntity(node.id)), 'precondition: a keyed template node').not.toBe('');
    expect(applyReparent(fixture('Leaf', 5).id, hr().id).ok).toBe(true);
    await settle();
    const m = deepM(kid('OR', kid('A', kid('R', hr().id).id).id).id);
    expect(writeTraitFieldWithUndo(m.id, getTraitByName('Transform')!, 'y', 3)).toBeFalsy();
    await settle();
    placedAt.set(m.guid!, ancestry(m.guid!));
    // Only the Leaf: Revert All would revert the edit inside the template node too.
    await revert(hr().id, f.prefabs.H.guid, (keys) => keys.filter((k) => k.startsWith('+')).slice(0, 1));
    await holdsLiveAndSaved(f, m.guid!, 3);
  });
});
