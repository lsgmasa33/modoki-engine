/** #2001 S8: an undo or redo keeps the instance store's records exact.
 *
 *  - A selection change and an asset-file edit that rebuilds no live frame touch no instance, and used to mark every
 *    record stale on each undo and redo (the hunt tally's commonest causes after Instantiate, "undo:selection"; the mark
 *    is gone since #2001 S8b).
 *  - An agent's batch (`Set Traits`, `Mutate Scene`) is one entry of sub-steps that each put back their own records.
 *  - An Instantiate's undo is the door's delete of the root it placed, and its redo the placement again: the dropped
 *    instance's record and the link of the member it landed on come and go with it (the tally's commonest cause).
 *  The fixture is the fuzzer's (O1, P1, H1 placed), through the real undo manager and store. */
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
import { boot, bridge, memoryStorage, startRun, authored, settle, flushWatcher } from './prefabFuzz/harness';
import { deleteAssetFiles, deletionPathsFor } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { deletedPrefabsShown } from '../../packages/modoki/src/editor/scene/deletedPrefabsMissing';
import { saveScene } from '../../packages/modoki/src/editor/scene/serialize';
import { getCurrentWorld, getTraitByName } from '@modoki/engine/runtime';
import { pushAction, undoStep, type UndoAction } from '../../packages/modoki/src/editor/undo/undoManager';
import { runAsCompositeAction } from '../../packages/modoki/src/editor/undo/compositeAction';
import { UndoRefusedError } from '../../packages/modoki/src/editor/undo/undoFailure';
import { writeTraitFieldWithUndo, createEntityWithUndo, reparentEntity, deleteEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { storedInstance, storedInstances, dropInstanceRecord } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { storeStatesTheWorld } from '../../packages/modoki/src/editor/instance/instanceHistory';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const p1 = () => authored().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;
const p1Record = () => JSON.stringify(storedInstance(getCurrentWorld(), p1().guid!)?.record, (_k, v: unknown) => (v instanceof Map ? [...v] : v));
const noop = (flags: Partial<UndoAction>): UndoAction => ({ label: 'step', undo: () => {}, redo: () => {}, ...flags });
/** The member called `name` under P1. */
function inP1(name: string): number {
  const top = p1().id;
  const under = (id: number): boolean => { for (let at = id; at; at = authored().find((e) => e.id === at)?.parentId ?? 0) if (at === top) return true; return false; };
  return authored().find((e) => e.name === name && under(e.id))!.id;
}

describe('#2001 S8: steps keep the records exact', () => {
  it.each([
    ['a selection change', { _isSelection: true }],
    ['an asset-file edit', { _isFileDirect: true }],
    ['a step that changes no instance', {}],
  ] as const)('the undo of %s leaves every record as it was', async (_what, flags) => {
    await startRun(be, async () => {}, `keeps-${Object.keys(flags).join('') || 'none'}`);
    const before = p1Record();
    pushAction(noop(flags));
    expect((await undoStep('undo')).did).toBe(true);
    expect(p1Record()).toBe(before);
  }, 60_000);

  // A step that keeps them and REFUSES applied nothing (I19), so the records are still exact; one that throws part-way
  // may have applied anything, and rolls back (#2001 S8b, `instanceRollback.ts`): its record as the step found it. The throwing step writes the record before it throws, so the rollback has something to put back.
  // Mutation: the rollback's restore dropped — the record keeps the step's half write (red).
  it.each([
    ['refuses', () => { throw new UndoRefusedError('gone', 'gone'); }],
    ['throws part-way', () => {
      const s = storedInstance(getCurrentWorld(), p1().guid!)!;
      s.record.placement.name = 'half written';
      throw new Error('half done');
    }],
  ] as const)('the undo of a step that keeps them and %s', async (what, undo) => {
    await startRun(be, async () => {}, `keeps-failed-${what === 'refuses' ? 'refused' : 'undo'}`);
    const name = storedInstance(getCurrentWorld(), p1().guid!)!.record.placement.name;
    pushAction(noop({ undo }));
    expect((await undoStep('undo')).did).toBe(false);
    expect(storedInstance(getCurrentWorld(), p1().guid!)!.record.placement.name, 'the record as the step found it').toBe(name);
  }, 60_000);

  it('a batch keeps them: each sub-step puts back its own', async () => {
    await startRun(be, async () => {}, 'keeps-batch');
    const tf = getTraitByName('Transform')!;
    const a = inP1('A');
    await runAsCompositeAction({ label: 'Set Traits' }, () => {
      writeTraitFieldWithUndo(a, tf, 'x', 11);
      writeTraitFieldWithUndo(a, tf, 'y', 12);
    });
    const after = structuredClone(storedInstance(getCurrentWorld(), p1().guid!)!.record.list);
    expect((await undoStep('undo')).did).toBe(true);
    expect((await undoStep('redo')).did).toBe(true);
    expect(storedInstance(getCurrentWorld(), p1().guid!)!.record.list).toEqual(after);
  }, 60_000);

  it('a node created under a member: the undo takes its link away, the redo puts it back', async () => {
    await startRun(be, async () => {}, 'keeps-create');
    const list = () => structuredClone(storedInstance(getCurrentWorld(), p1().guid!)?.record.list);
    const before = list();
    const a = inP1('A');
    const made = createEntityWithUndo('Create U', a, [{ name: 'EntityAttributes', data: { name: 'U', parentId: a } }, { name: 'Transform', data: {} }], () => {});
    expect(made, 'premise: created').toBeTruthy();
    const after = list();
    expect(after, 'premise: the member links the new node').not.toEqual(before);

    expect((await undoStep('undo')).did).toBe(true);
    expect(list()).toEqual(before);
    expect((await undoStep('redo')).did).toBe(true);
    expect(list()).toEqual(after);
  }, 60_000);

  it('an Instantiate dropped on a member: the undo takes its record and link away, the redo puts them back', async () => {
    const f = await startRun(be, async () => {}, 'keeps-instantiate');
    const list = () => structuredClone(storedInstance(getCurrentWorld(), p1().guid!)?.record.list);
    const before = list();
    const placed = await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: inP1('A') });
    expect(placed, 'premise: placed').toBeTruthy();
    const qGuid = authored().find((e) => e.id === placed)!.guid!;
    const after = list();
    expect(after, 'premise: the member links the new instance').not.toEqual(before);

    expect((await undoStep('undo')).did).toBe(true);
    expect(list()).toEqual(before);
    expect(storedInstance(getCurrentWorld(), qGuid), 'the dropped instance\'s record goes with it').toBeUndefined();

    expect((await undoStep('redo')).did).toBe(true);
    expect(list()).toEqual(after);
  }, 60_000);
  // A move between trees: the old tree's member unlinks the mover, the new one links it, and a moved instance's record
  // takes its new placement and the Transform the move compensated. The undo's live writes put back the tree the
  // records before it state, so it seats those exactly; the redo, the ones the move left.
  for (const [what, make] of [
    ['an instance', async (q: string, a: number) => (await placePrefabFromPath(q, { tag: 'test', parentId: a }))!],
    ['a plain node', async (_q: string, a: number) => createEntityWithUndo('Create U', a, [{ name: 'EntityAttributes', data: { name: 'U', parentId: a } }, { name: 'Transform', data: { x: 1 } }], () => {})!],
  ] as const) {
    it(`${what} moved from a member of one instance to another instance: undo and redo seat the exact records`, async () => {
      const f = await startRun(be, async () => {}, `keeps-reparent-${what.length}`);
      const mover = await make(f.prefabs.Q.path, inP1('A'));
      const o1 = authored().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8001-'))!.id;
      const store = () => new Map([...storedInstances(getCurrentWorld())].map(([g, st]) => [g, structuredClone(st)]));
      const before = store();

      expect(reparentEntity(mover, o1), 'premise: moved').toBe(true);
      const after = store();
      expect(after, 'premise: the move changed the records').not.toEqual(before);

      expect((await undoStep('undo')).did).toBe(true);
      expect(store(), 'the undo seats back the exact records, fresh').toEqual(before);
      expect((await undoStep('redo')).did).toBe(true);
      expect(store(), 'the redo seats the ones the move left').toEqual(after);
    }, 60_000);
  }
  // A user's node an anchor links itself: the delete unlinks it, and its undo brings it back from the tree's records and
  // the content they hold, rather than respawning a snapshot around records it then leaves stale.
  it('a user\'s node linked under a member, deleted: undo and redo keep the records exact', async () => {
    await startRun(be, async () => {}, 'keeps-delete-owned');
    const a = inP1('A');
    const made = createEntityWithUndo('Create U', a, [{ name: 'EntityAttributes', data: { name: 'U', parentId: a } }, { name: 'Transform', data: { x: 7 } }], () => {})!;
    const uGuid = authored().find((e) => e.id === made)!.guid!;
    const store = () => new Map([...storedInstances(getCurrentWorld())].map(([g, st]) => [g, structuredClone(st)]));
    const before = store();

    deleteEntityWithUndo(made);
    expect(authored().some((e) => e.guid === uGuid), 'premise: deleted').toBe(false);
    const after = store();
    expect(after, 'premise: the member no longer links it').not.toEqual(before);

    expect((await undoStep('undo')).did).toBe(true);
    expect(store(), 'the undo seats back the exact records, fresh').toEqual(before);
    const back = authored().find((e) => e.guid === uGuid);
    expect(back?.parentId, 'U is back under A').toBe(inP1('A'));
    expect(((getCurrentWorld().query(getTraitByName('Transform')!.trait).find((e) => e.id() === back!.id)?.get(getTraitByName('Transform')!.trait)) as { x?: number } | undefined)?.x, 'with its content').toBe(7);
    expect((await undoStep('redo')).did).toBe(true);
    expect(store()).toEqual(after);
  }, 60_000);

  // #2001 S8b: a Delete undone after the deleted instance's prefab was trashed. Its records cannot reproject (the prefab is
  // gone), so the snapshot rebuilds the tree; its records are then seated exactly as before the delete. They used to be
  // marked stale (with every other record in the world) and re-seeded from the capture at the next save.
  // Mutation: drop the seat → red at 'exact records' (P1 has no record).
  it('a Delete undone after its prefab was trashed seats the exact records, and the save writes P1 as it was', async () => {
    const f = await startRun(be, async () => {}, 'keeps-delete-trashed');
    expect(writeTraitFieldWithUndo(inP1('A'), getTraitByName('Transform')!, 'y', 9)).toBeNull();
    const guid = p1().guid!;
    const entryOf = (text: string) => JSON.stringify((JSON.parse(text) as { entities: { guid?: string }[] }).entities.find((e) => e.guid === guid));
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const savedBefore = entryOf(be.read(f.scenePath)!);
    const before = structuredClone(storedInstance(getCurrentWorld(), guid));

    deleteEntityWithUndo(p1().id);
    expect(storedInstance(getCurrentWorld(), guid), 'premise: the delete drops the record').toBeUndefined();
    const files = be.snapshot();
    expect((await deleteAssetFiles(deletionPathsFor(f.prefabs.P.path, 'prefab', null))).ok).toBe(true);
    unbindDeletedAssetEditors([f.prefabs.P.path]);
    await deletedPrefabsShown();
    await flushWatcher(be, files);
    await settle();

    expect((await undoStep('undo')).did).toBe(true);
    const back = storedInstance(getCurrentWorld(), guid);
    expect(back, 'exact records').toEqual(before);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(entryOf(be.read(f.scenePath)!), 'P1 saved as before the delete').toBe(savedBefore);
  }, 60_000);

  // #2001 S8b review G1: a member's Delete undone after an outside edit took away the member a user's node hangs under,
  // and changed C's prefab. The records cannot reproject (P1's links U under B, which the template no longer places), so
  // the snapshot respawns C, stale against Q; its frame rebase reprojects from the store, which still held the delete's
  // after-record, and removed C again.
  // Mutation: seat the before-records only AFTER the snapshot (the old order) — red at 'C is back'.
  it('a member\'s Delete undone after the template dropped another member keeps the member it brought back', async () => {
    const f = await startRun(be, async () => {}, 'keeps-delete-unplaced');
    const b = inP1('B');
    createEntityWithUndo('Create U', b, [{ name: 'EntityAttributes', data: { name: 'U', parentId: b } }, { name: 'Transform', data: {} }], () => {});
    const guid = p1().guid!;
    const before = structuredClone(storedInstance(getCurrentWorld(), guid)!.record);
    deleteEntityWithUndo(inP1('QR'));
    expect(authored().filter((e) => e.name === 'QR'), 'premise: C deleted (its root is QR live)').toHaveLength(1);
    const files = be.snapshot();
    const d = JSON.parse(be.read(f.prefabs.P.path)!) as { entities: { name?: string }[] };
    d.entities = d.entities.filter((e) => e.name !== 'B');
    be.write(f.prefabs.P.path, `${JSON.stringify(d, null, 2)}\n`);
    const q = JSON.parse(be.read(f.prefabs.Q.path)!) as { entities: { name?: string; traits: { Transform?: { x?: number } } }[] };
    q.entities.find((e) => e.name === 'M')!.traits.Transform!.x = 5;
    be.write(f.prefabs.Q.path, `${JSON.stringify(q, null, 2)}\n`);
    await flushWatcher(be, files);
    await settle();

    expect((await undoStep('undo')).did).toBe(true);
    expect(authored().filter((e) => e.name === 'QR'), 'C is back').toHaveLength(2);
    expect(storedInstance(getCurrentWorld(), guid)!.record, 'exact records').toEqual(before);
  }, 60_000);

  // #2001 S8b: an Apply undone after its prefab was trashed. The applied tree is a placeholder now, so the undo takes the
  // snapshot path, whose park refuses before anything changes ("was deleted since this step"). That path marked every
  // record stale, before and after, refusal or not, and each was re-seeded from the capture at the next save (hunt seeds
  // 9303, 9344: 7 of the 10 re-seeds left).
  it('an Apply undone after its prefab was trashed is refused and leaves every record exact', async () => {
    const f = await startRun(be, async () => {}, 'keeps-apply-trashed');
    expect(writeTraitFieldWithUndo(inP1('A'), getTraitByName('Transform')!, 'y', 9)).toBeNull();
    await settle();
    const keys = collectInstanceOverrideKeys(p1().id, getCachedPrefabSync(f.prefabs.P.guid)!);
    expect((await applyToPrefabWithUndo(p1().id, new Set(keys.all.filter((k) => k.includes('Transform'))))).applied, 'premise: applied').toBe(true);
    await settle();
    const files = be.snapshot();
    expect((await deleteAssetFiles(deletionPathsFor(f.prefabs.P.path, 'prefab', null))).ok).toBe(true);
    unbindDeletedAssetEditors([f.prefabs.P.path]);
    await deletedPrefabsShown();
    await flushWatcher(be, files);
    await settle();
    const store = () => new Map([...storedInstances(getCurrentWorld())].map(([g, s]) => [g, structuredClone(s)]));
    const before = store();
    expect(before.size, 'premise: records').toBeGreaterThan(0);

    const r = await undoStep('undo');
    expect(r.failed?.refused, 'premise: the undo is refused (the prefab is gone)').toBe(true);
    expect(store(), 'exact records').toEqual(before);
  }, 60_000);

  // #2001 S8b part 29: the SNAPSHOT path (taken when the store cannot state the world: here O1's record is missing)
  // reloads the scene from the side's snapshot, which parses every record exact. The prefab commit then marked every
  // record stale after the reload (its 'prefabWrite' mark for a `rebuild` that did not say it kept the records), and the
  // next write re-seeded them from the live trees.
  it('an Apply undone and redone through the scene snapshot leaves every record exact', async () => {
    const f = await startRun(be, async () => {}, 'keeps-apply-snapshot');
    expect(writeTraitFieldWithUndo(inP1('A'), getTraitByName('Transform')!, 'y', 9)).toBeNull();
    await settle();
    const store = () => new Map([...storedInstances(getCurrentWorld())].map(([g, s]) => [g, structuredClone(s)]));
    const before = store();
    const keys = collectInstanceOverrideKeys(p1().id, getCachedPrefabSync(f.prefabs.P.guid)!);
    expect((await applyToPrefabWithUndo(p1().id, new Set(keys.all.filter((k) => k.includes('Transform'))))).applied, 'premise: applied').toBe(true);
    await settle();
    const after = store();
    expect(after.get(p1().guid!), 'premise: the Apply changed P1\'s record').not.toEqual(before.get(p1().guid!));
    const o1 = authored().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8001-'))!.guid!;
    expect(storedInstance(getCurrentWorld(), o1), 'premise: O1 has a record').toBeDefined();

    dropInstanceRecord(getCurrentWorld(), o1);
    expect(storeStatesTheWorld(), 'premise: the undo takes the snapshot').toBe(false);
    expect((await undoStep('undo')).failed, 'undone').toBeFalsy();
    await settle();
    expect(store(), 'the records before the Apply').toEqual(before);

    dropInstanceRecord(getCurrentWorld(), o1);
    expect((await undoStep('redo')).failed, 'redone').toBeFalsy();
    await settle();
    expect(store(), 'the records after the Apply').toEqual(after);
  }, 60_000);
});
