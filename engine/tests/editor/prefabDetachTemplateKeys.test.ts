/** #1874 — Detach (Unpack Completely, the one mode there is) strips the TEMPLATE KEY off every node it unpacks, and its
 *  undo puts the keys back.
 *
 *  A node a template adds (O's Extra, on its N row's `added`) carries its key as `TemplateAddedKey` and no link, so the
 *  strip of `PrefabInstance` never visited it. Unpacked and moved under another instance of O (O2), it still read as O's
 *  node: its next move was refused as a restructure of O2, and an edit of O2's own Extra saved both nodes on one guid
 *  (I7). Unity: an unpacked object refers to no prefab. Its guid stays — Unity keeps references across an unpack — and
 *  nothing re-derives the key from it: key recovery anchors only at a prefab instance (`templateKeyRecovery.ts`), and the
 *  roots the unpacked nodes derived from are plain now. Before that rule, a node the template adds DIRECTLY under a
 *  template reference root (no member step between) got its key back from the unpacked root's guid, live and at the
 *  next load's heal (the close-out review's F1).
 *
 *  Mutations: the strip removed — every stripping case (the I7 one through its first run key); the undo's restore
 *  removed — the undo case; plain ancestors allowed as a recovery anchor — the reference-root case, through its live,
 *  scene-level half; `detachRefusal`'s refusal of a target that is not an instance removed — the two not-an-instance
 *  cases (an agent `detach` of a plain template node stripped its own key and unpacked the instance under it, and the
 *  node then moved out of its instance: reviews F2 and the close-out); the supplied branch removed (a node a template
 *  adds refused as "not a prefab instance", with no root to act on) — the template-node case.
 *
 *  Driven through the prefab fuzzer's harness: the real backend route, SceneManager, both caches, the undo stack and
 *  the simulated watcher. */

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
import { getTraitByName, getCurrentWorld } from '@modoki/engine/runtime';
import { storedInstances } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored, type Fixture } from './prefabFuzz/harness';
import { checkWorld } from './prefabFuzz/checks';
import { applyReparent, clipEntity, pasteEntityCopy, planReparent, writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { detachPrefabInstanceWithUndo } from '../../packages/modoki/src/editor/undo/detachPrefabUndo';
import { revertOverridesWithUndo } from '../../packages/modoki/src/editor/undo/revertPrefabUndo';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { previewApply } from '../../packages/modoki/src/editor/scene/prefabApply';
import { applyTargetOptions } from '../../packages/modoki/src/editor/scene/prefabApplyOptions';
import { initialTargets, toApplyTargets } from '../../packages/modoki/src/editor/panels/applyDialogModel';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { getCachedPrefabSync, preloadNestedPrefabsForSubtree, recoverTemplateKey } from '../../packages/modoki/src/editor/scene/prefabCache';
import { isSuppliedByPrefab } from '../../packages/modoki/src/editor/scene/restructureRefusal';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { runAgentOp } from '../../app/debug/agentBridge';
import { createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { templateKeyOf } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { findEntity, readTraitData } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

/** A fixture entity by name and the scene guid it loads with (`ffffffff-…-8<id>-…`): a rebuild re-mints ids. */
const fixture = (name: string, id: number) => authored().find((e) => e.name === name && e.guid?.startsWith(`ffffffff-0000-4000-800${id}-`))!;
const kid = (name: string, parentId: number) => authored().find((e) => e.name === name && e.parentId === parentId)!;
const byGuid = (guid: string) => authored().find((e) => e.guid === guid);
const keyOf = (guid: string) => templateKeyOf(findEntity(byGuid(guid)!.id));
/** O's Extra in the O instance rooted at `orId`: OR → R (N row) → A → Extra, the node O's N row adds. */
const extraOf = (orId: number) => kid('Extra', kid('A', kid('R', orId).id).id);
/** O2's own Extra: under its A beside the moved one. */
const ownExtra = (o2: number, moved: string) => authored().find((e) => e.name === 'Extra' && e.parentId === kid('A', kid('R', o2).id).id && e.guid !== moved)!;

/** The fixture's O1 detached, its Extra moved under a second O instance's A. Returns O2's root and the Extra's guid. */
async function detachAndMoveIntoO2(f: Fixture): Promise<{ o2: () => number; moved: string }> {
  const o2Id = (await placePrefabFromPath(f.prefabs.O.path, { tag: 'test', parentId: 0 }))!;
  await settle();
  const o2g = authored().find((e) => e.id === o2Id)!.guid!;
  const o1 = fixture('OR', 1);
  const moved = extraOf(o1.id).guid!;
  expect(keyOf(moved), 'precondition: the template node is keyed').toBe('k-extra');
  detachPrefabInstanceWithUndo(o1.id, 'Detach prefab', '[test]');
  await settle();
  const o2 = () => byGuid(o2g)!.id;
  expect(applyReparent(byGuid(moved)!.id, kid('A', kid('R', o2()).id).id).ok).toBe(true);
  await settle();
  return { o2, moved };
}

async function saveAndReload(f: Fixture): Promise<void> {
  expect((await saveScene({ allowDialog: false })).saved).toBe(true);
  expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
  await settle();
}

/** The world after it: no invariant broken (I7 among them), each Extra once, the moved one plain. */
function holdsAsPlain(moved: string): void {
  expect(checkWorld(), 'invariants').toEqual([]);
  expect(authored().filter((e) => e.guid === moved), 'the moved node, once').toHaveLength(1);
  expect(keyOf(moved), 'the moved node carries no template key').toBe('');
  expect(isSuppliedByPrefab(byGuid(moved)!.id), 'nothing supplies it').toBe(false);
}

/** O's template, edited: under its N row's A, Q placed (a template REFERENCE node, keyed on the row's `added`), and a
 *  plain Z created directly under that node's root — a node the template adds whose guid derives from the reference
 *  root's with no member step between (the close-out review's F1 shape). */
async function authorZUnderReference(f: Fixture): Promise<void> {
  expect(await openPrefabForEditing({ path: f.prefabs.O.path, name: 'O' }, { confirmDiscard: async () => true })).toBeFalsy();
  const aEdit = kid('A', kid('R', authored().find((e) => e.name === 'OR')!.id).id);
  expect(await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: aEdit.id })).toBeTruthy();
  await settle();
  const qr = kid('QR', aEdit.id);
  expect(createEntityWithUndo('Create Z', qr.id, [{ name: 'EntityAttributes', data: { name: 'Z', parentId: qr.id } }, { name: 'Transform', data: { x: 0, y: 0, z: 0 } }] as never, () => {})).toBeTruthy();
  await settle();
  expect((await savePrefabEditReport({})).saved).toBe(true);
  await exitPrefabEditing();
  await settle();
}
/** Z in the O instance rooted at `orId`: OR → R → A → QR (the reference node) → Z. */
const zOf = (orId: number) => kid('Z', kid('QR', kid('A', kid('R', orId).id).id).id);

describe('Detach strips the template keys of the nodes it unpacks (#1874)', () => {
  it('an unpacked template node moved under another instance of the prefab is plain: it moves again', async () => {
    const f = await startRun(be, async () => {}, 'detach-keys-move');
    const { moved } = await detachAndMoveIntoO2(f);
    holdsAsPlain(moved);
    expect(planReparent(byGuid(moved)!.id, 0).kind).not.toBe('refused');
  });

  // Which node the save pairs with the template's key follows the run's guids, so the I7 shows under some runs only:
  // the first key below reaches it without the strip (measured), the others do not. All must hold.
  it("an edit of that instance's own node saves each node on its own guid (the issue's symptom 1: I7)", async () => {
    for (const run of ['s1874-live-editO2Extra', 'detach-keys-i7', 'detach-keys-i7-b', 'detach-keys-i7-c']) {
      const f = await startRun(be, async () => {}, run);
      const { o2, moved } = await detachAndMoveIntoO2(f);
      const own = ownExtra(o2(), moved);
      expect(writeTraitFieldWithUndo(own.id, getTraitByName('Transform')!, 'y', 4)).toBeFalsy();
      await settle();
      await saveAndReload(f);
      holdsAsPlain(moved);
      expect(keyOf(own.guid!), `${run}: O2's own node is still O's`).toBe('k-extra');
      expect((readTraitData(byGuid(own.guid!)!.id, getTraitByName('Transform')!) as { y: number }).y).toBe(4);
    }
  });

  it('a rebuild of that instance (Revert, then Apply) keeps the moved node, once and plain, across a reload', async () => {
    const f = await startRun(be, async () => {}, 'detach-keys-rebuild');
    const { o2, moved } = await detachAndMoveIntoO2(f);
    const own = ownExtra(o2(), moved).guid!;
    // Something for O2 to revert and to apply: its root's y.
    expect(writeTraitFieldWithUndo(o2(), getTraitByName('Transform')!, 'y', 2)).toBeFalsy();
    await settle();
    await preloadNestedPrefabsForSubtree(o2());
    let prefab = getCachedPrefabSync(f.prefabs.O.guid)!;
    expect(await revertOverridesWithUndo(o2(), new Set(collectInstanceOverrideKeys(o2(), prefab).all.filter((k) => k.endsWith('.Transform.y'))))).toBeTruthy();
    await settle();
    holdsAsPlain(moved);
    expect(writeTraitFieldWithUndo(o2(), getTraitByName('Transform')!, 'y', 2)).toBeFalsy();
    await settle();
    await preloadNestedPrefabsForSubtree(o2());
    prefab = getCachedPrefabSync(f.prefabs.O.guid)!;
    const sel = new Set(collectInstanceOverrideKeys(o2(), prefab).all.filter((k) => k.endsWith('.Transform.y')));
    expect(sel.size).toBe(1);
    const targets = toApplyTargets(initialTargets(applyTargetOptions(o2(), prefab, [...sel])), sel);
    const pv = await previewApply(o2(), new Set(sel), targets);
    expect((await applyToPrefabWithUndo(o2(), sel, targets, { expect: pv.fingerprint })).applied).toBe(true);
    await settle();
    holdsAsPlain(moved);
    await saveAndReload(f);
    holdsAsPlain(moved);
    expect(keyOf(own), "O2's own node is still O's").toBe('k-extra');
  });

  it("Detach's undo puts the keys back and its redo strips them again, each clean across a reload", async () => {
    const f = await startRun(be, async () => {}, 'detach-keys-undo');
    const o1 = fixture('OR', 1);
    const extra = extraOf(o1.id).guid!;
    detachPrefabInstanceWithUndo(o1.id, 'Detach prefab', '[test]');
    await settle();
    expect(keyOf(extra)).toBe('');
    expect((await undoStep('undo')).did, 'the undo ran').toBe(true);
    await settle();
    expect(keyOf(extra), 'the undo restored the key').toBe('k-extra');
    expect(isSuppliedByPrefab(byGuid(extra)!.id), 'O supplies it again').toBe(true);
    await saveAndReload(f);
    expect(checkWorld()).toEqual([]);
    expect(keyOf(extra)).toBe('k-extra');
    expect((await undoStep('redo')).did, 'the redo ran').toBe(true);
    await settle();
    expect(keyOf(extra), 'the redo stripped it again').toBe('');
  });

  // #2001 S8b: the undo seats the records the Detach took, so every node whose template key it puts back must still be
  // there, asked with the links before anything changes. Put back on nothing, the tree was unlike the records it seated
  // (the old path marked them stale for the re-seed). Mutation: drop the key loop from `requireDetachedLinks` — the undo
  // is not refused (the reattach then misses the key and throws, and the step rolls back instead).
  it("Detach's undo is refused, changing nothing, when a node whose key it puts back is gone", async () => {
    await startRun(be, async () => {}, 'detach-keys-gone');
    const o1 = fixture('OR', 1);
    const extra = extraOf(o1.id);
    detachPrefabInstanceWithUndo(o1.id, 'Detach prefab', '[test]');
    await settle();
    // Another identity, given where no step records it: the key's ref (by guid) names nothing now.
    const ea = getTraitByName('EntityAttributes')!;
    const e = findEntity(extra.id)!;
    e.set(ea.trait, { ...(e.get(ea.trait) as object), guid: 'eeeeeeee-0000-4000-8000-000000002001' });
    const store = () => JSON.stringify([...storedInstances(getCurrentWorld())], (_k, v: unknown) => (v instanceof Map ? [...v] : v));
    const before = store();
    const step = await undoStep('undo');
    expect(step.failed?.refused, 'the undo refused').toBe(true);
    expect(readTraitData(o1.id, getTraitByName('PrefabInstance')!), 'OR is still detached').toBeFalsy();
    expect(store()).toBe(before);
  });

  // #1914 R3a: a template's plain node records its own edits, and the save writes only what it records. Detach's undo must
  // give the record back with the key: after a reload in between, the plain node it became holds none, so the node came
  // back the template's with z 2 unrecorded and the next save dropped it (hunt seed 1032). Mutation: drop `seat()` from
  // `reattachDetachedInstanceSeating` (the records the Detach dropped) — red.
  it("Detach's undo across a reload gives the node its record back with its key", async () => {
    const f = await startRun(be, async () => {}, 'detach-keys-record');
    const o1 = fixture('OR', 1);
    const extra = extraOf(o1.id).guid!;
    const z = () => (readTraitData(byGuid(extra)!.id, getTraitByName('Transform')!) as { z: number }).z;
    expect(z(), 'precondition: the template gives it z 0').toBe(0);
    expect(writeTraitFieldWithUndo(byGuid(extra)!.id, getTraitByName('Transform')!, 'z', 2)).toBeFalsy();
    await settle();
    detachPrefabInstanceWithUndo(o1.id, 'Detach prefab', '[test]');
    await settle();
    await saveAndReload(f);
    expect((await undoStep('undo')).did, 'the undo ran').toBe(true);
    await settle();
    expect(keyOf(extra)).toBe('k-extra');
    await saveAndReload(f);
    expect(checkWorld()).toEqual([]);
    expect(z()).toBe(2);
  });

  it('nothing recovers the key after a reload: the detached tree at scene level, and inside another instance', async () => {
    for (const where of ['scene', 'inside P1'] as const) {
      const f = await startRun(be, async () => {}, `detach-keys-recover-${where}`);
      const root = where === 'scene'
        ? fixture('OR', 1).id
        : pasteEntityCopy(clipEntity(fixture('OR', 1).id, 'copy')!, kid('A', fixture('R', 2).id).id, () => {})!;
      await settle();
      const extra = extraOf(root).guid!;
      expect(keyOf(extra), `${where}: precondition, keyed`).toBe('k-extra');
      detachPrefabInstanceWithUndo(root, 'Detach prefab', '[test]');
      await settle();
      expect(keyOf(extra), `${where}: stripped`).toBe('');
      expect(recoverTemplateKey(byGuid(extra)!.id), `${where}: not recovered live`).toBe('');
      await saveAndReload(f);
      expect(keyOf(extra), `${where}: not re-keyed by the load`).toBe('');
      expect(recoverTemplateKey(byGuid(extra)!.id), `${where}: not recovered after the reload`).toBe('');
      expect(isSuppliedByPrefab(byGuid(extra)!.id)).toBe(false);
    }
  });

  // Only the live, scene-level recovery measures the anchor rule since #1809 (a keyed node's walk starts at its frame root,
  // which carries a link, and the load's heal needs a stored root above it): the other assertions are regression checks
  // on the same outcome, green under either rule (the close-out review, instrumented).
  it('a node directly under a template REFERENCE root: nothing re-derives its key from the root, live or at a load (review F1)', async () => {
    for (const where of ['scene', 'inside P1'] as const) {
      const f = await startRun(be, async () => {}, `detach-keys-ref-root-${where}`);
      await authorZUnderReference(f);
      const root = where === 'scene'
        ? fixture('OR', 1).id
        : pasteEntityCopy(clipEntity(fixture('OR', 1).id, 'copy')!, kid('A', fixture('R', 2).id).id, () => {})!;
      await settle();
      const z = zOf(root).guid!;
      expect(keyOf(z), `${where}: precondition, keyed`).not.toBe('');
      detachPrefabInstanceWithUndo(root, 'Detach prefab', '[test]');
      await settle();
      expect(recoverTemplateKey(byGuid(z)!.id), `${where}: not recovered live`).toBe('');
      await saveAndReload(f);
      expect(keyOf(z), `${where}: not re-keyed by the load's heal`).toBe('');
      expect(recoverTemplateKey(byGuid(z)!.id), `${where}: not recovered after the reload`).toBe('');
      // Moved beside another O instance's own Z, under its reference root: still plain, so it moves again.
      const o2 = (await placePrefabFromPath(f.prefabs.O.path, { tag: 'test', parentId: 0 }))!;
      await settle();
      expect(applyReparent(byGuid(z)!.id, kid('QR', kid('A', kid('R', o2).id).id).id).ok).toBe(true);
      await settle();
      expect(isSuppliedByPrefab(byGuid(z)!.id), `${where}: nothing supplies it`).toBe(false);
      expect(planReparent(byGuid(z)!.id, 0).kind).not.toBe('refused');
    }
  });

  // The key comes from a NESTED document into the frame, not the frame's own prefab (work-ai's variant, area 3a): H nests O
  // as a row, and O's N row adds Extra into that P frame. Detach H1 and move its Extra under H2's P-frame A: with the
  // stale key, that frame read Extra as its own template node (listed as nothing added) and a reload gave two nodes on
  // one guid. Mutation: the strip removed.
  it("a key a NESTED document declares into the frame: the unpacked node is listed as added there, and reloads on its own guid", async () => {
    // A run key whose guid order reaches the two-on-one-guid reload without the strip (7 of 9 keys tried did; this one's
    // did not before it was chosen): the listing half fails under every key.
    const f = await startRun(be, async () => {}, 'nd-a');
    expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' }, { confirmDiscard: async () => true })).toBeFalsy();
    expect(await placePrefabFromPath(f.prefabs.O.path, { tag: 'test', parentId: authored().find((e) => e.name === 'HR')!.id })).toBeTruthy();
    await settle();
    expect((await savePrefabEditReport({})).saved).toBe(true);
    await exitPrefabEditing();
    await settle();
    const h2Id = (await placePrefabFromPath(f.prefabs.H.path, { tag: 'test', parentId: 0 }))!;
    await settle();
    const h2g = authored().find((e) => e.id === h2Id)!.guid!;
    const h1 = fixture('HR', 3);
    const moved = extraOf(kid('OR', h1.id).id).guid!;
    expect(keyOf(moved), 'precondition: keyed').toBe('k-extra');
    detachPrefabInstanceWithUndo(h1.id, 'Detach prefab', '[test]');
    await settle();
    const h2 = () => byGuid(h2g)!.id;
    const pFrame = () => kid('R', kid('OR', h2()).id); // H2 → O row → N (a P frame)
    expect(applyReparent(byGuid(moved)!.id, kid('A', pFrame().id).id).ok).toBe(true);
    await settle();
    holdsAsPlain(moved);
    await preloadNestedPrefabsForSubtree(h2());
    const listed = collectInstanceOverrideKeys(pFrame().id, getCachedPrefabSync(f.prefabs.P.guid)!).added;
    expect(listed.some((k) => k.includes(moved)), 'listed as an added node of the frame').toBe(true);
    await saveAndReload(f);
    holdsAsPlain(moved);
    expect(authored().filter((e) => e.name === 'Extra' && e.parentId === kid('A', pFrame().id).id).map((e) => e.guid).sort(),
      "the frame's own Extra and the moved one, each on its own guid").toEqual([moved, extraOf(kid('OR', h2()).id).guid].sort());
  });

  it('a Detach aimed at a plain scene entity nothing supplies is refused as not an instance, with no root to offer', async () => {
    await startRun(be, async () => {}, 'detach-keys-plain');
    const plain = fixture('Plain', 4);
    expect(() => detachPrefabInstanceWithUndo(plain.id, 'Detach prefab', '[test]')).toThrow('"Plain" is not a prefab instance');
    const err = await runAgentOp('prefab', { prefabAction: 'detach', entityGuid: plain.guid }).catch((e: Error) => e) as Error & { code?: string; options?: string[] };
    expect(err.code).toBe('REFUSED_BY_OP');
    expect(err.message).toBe(`prefab detach refused: "Plain" is not a prefab instance: Detach unpacks an instance from its root, as Unity's Unpack does. Nothing was detached.`);
    expect(err.options).toBeUndefined();
  });

  it('a Detach aimed at a node a template adds (the agent `detach`) is refused naming its root, and changes nothing (reviews F2, and the close-out)', async () => {
    const f = await startRun(be, async () => {}, 'detach-keys-not-instance');
    // Extra holding an instance of Q: O's prefab edit places Q under it, a template reference node.
    expect(await openPrefabForEditing({ path: f.prefabs.O.path, name: 'O' }, { confirmDiscard: async () => true })).toBeFalsy();
    const extraEdit = kid('Extra', kid('A', kid('R', authored().find((e) => e.name === 'OR')!.id).id).id);
    expect(await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: extraEdit.id })).toBeTruthy();
    await settle();
    expect((await savePrefabEditReport({})).saved).toBe(true);
    await exitPrefabEditing();
    await settle();
    const extra = extraOf(fixture('OR', 1).id);
    const qr = kid('QR', extra.id);
    const qrKey = keyOf(qr.guid!);
    expect(qrKey, 'precondition: Q under Extra is a keyed template node').not.toBe('');
    // Refused up front, naming the root as a member's refusal does (Extra is part of O1's instance): by the wrapper both
    // surfaces call, and by the agent op, with the root to act on instead.
    const or1 = fixture('OR', 1);
    expect(() => detachPrefabInstanceWithUndo(extra.id, 'Detach prefab', '[test]')).toThrow(`Detach the instance root "OR" instead: "Extra" is a node it adds`);
    const err = await runAgentOp('prefab', { prefabAction: 'detach', entityGuid: extra.guid }).catch((e: Error) => e) as Error & { code?: string; options?: string[] };
    expect(err.code).toBe('REFUSED_BY_OP');
    expect(err.message).toContain('Detach the instance root "OR" instead: "Extra" is a node it adds');
    expect(err.options).toEqual([`modoki_prefab {action:'detach', entityGuid:'${or1.guid}'} — the instance root`]);
    await settle();
    // …and nothing changed: Extra is still O's node, Q still an instance.
    expect(keyOf(extra.guid!), "Extra keeps O's key").toBe('k-extra');
    expect(isSuppliedByPrefab(byGuid(extra.guid!)!.id), 'still refused a move out of its instance').toBe(true);
    expect(planReparent(byGuid(extra.guid!)!.id, 0).kind).toBe('refused');
    expect(keyOf(qr.guid!), 'Q keeps its key').toBe(qrKey);
    expect(readTraitData(byGuid(qr.guid!)!.id, getTraitByName('PrefabInstance')!), 'Q is still an instance').toBeTruthy();
  });
});
