/** #2010 with prefab content — a composite entry's pre-pass over deletes of instance members and roots.
 *
 *  Driven through the prefab fuzzer's harness, as deleteUndoSurvivingFrame.test.ts is, on its fixture: P1 is an instance
 *  of P (R → A → B, R → C). The pre-pass reads each delete's undo checks against what the earlier subs of the pass bring
 *  back: a member's instance root that an earlier sub respawns is not gone (accept side), and the rows such a root will
 *  hold are its prefab's CURRENT ones, so a row a saved edit dropped refuses the whole entry before anything respawns. */

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
import { boot, bridge, memoryStorage, startRun, settle, authored, piOf, worldTree, type Fixture } from './prefabFuzz/harness';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { runAsCompositeAction } from '../../packages/modoki/src/editor/undo/compositeAction';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { deleteEntitiesWithUndo, writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { findEntityByGuid, getCurrentWorld, spawnEntity } from '../../packages/modoki/src/runtime/core/ecs/world';
import { getTraitByName } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import { deleteEntity, writeTraitField, markStructureDirty } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const P1_GUID = 'ffffffff-0000-4000-8002-';
const p1 = () => authored().find((e) => e.guid?.startsWith(P1_GUID))!;
/** P1's member named `name` (O1's nested P has members of the same names). */
function memberOfP1(name: string): { id: number; guid: string } {
  const root = p1();
  const e = authored().find((x) => x.name === name && piOf(x.id)?.rootInstanceId === root.id)!;
  expect(e, `P1's ${name}`).toBeTruthy();
  return { id: e.id, guid: e.guid! };
}

/** Edit P in prefab edit (`edit` gets P's live member of that name), save, leave. */
async function savedEditOfP(f: Fixture, edit: (member: (name: string) => number) => void): Promise<void> {
  expect(await openPrefabForEditing({ path: f.prefabs.P.path, name: 'P' }, { confirmDiscard: async () => true })).toBeFalsy();
  edit((name) => authored().find((e) => e.name === name)!.id);
  expect((await savePrefabEditReport({})).saved).toBe(true);
  await exitPrefabEditing();
  await settle();
}

/** One entry: delete P1's member B, then P1 itself. */
async function deleteMemberThenRoot(): Promise<{ b: string; root: string }> {
  const b = memberOfP1('B');
  const root = p1().guid!;
  await runAsCompositeAction({ label: 'Batch' }, () => {
    deleteEntitiesWithUndo([b.id]);
    deleteEntitiesWithUndo([findEntityByGuid(root)!.id()]);
  });
  await settle();
  expect(findEntityByGuid(b.guid)).toBeFalsy();
  expect(findEntityByGuid(root)).toBeFalsy();
  return { b: b.guid, root };
}

describe('a composite of instance deletes (#2010)', () => {
  // Mutation: drop `pass` from the delete check's `requireRootLinks` call → the undo refuses: B's instance root P1 is gone
  // at the start of the pass, though P1's own delete-undo brings it back first.
  it('accept side: delete a member, then its instance root — the entry undoes and redoes in full', async () => {
    await startRun(be, async () => {}, 'composite-member-root');
    const { b, root } = await deleteMemberThenRoot();

    const u = await undoStep('undo');
    await settle();
    expect(u.failed).toBeNull();
    expect(findEntityByGuid(root)).toBeTruthy();
    expect(findEntityByGuid(b)).toBeTruthy();

    const r = await undoStep('redo');
    await settle();
    expect(r.failed).toBeNull();
    expect(findEntityByGuid(root)).toBeFalsy();
    expect(findEntityByGuid(b)).toBeFalsy();
  }, 120_000);

  // Mutation: ask `requireDetachedMembers` with the delete's own respawns only (not the pass's arrivals) → the undo
  // refuses: B, which P1's delete unlinked where it stood, is gone at the start of the pass, though B's own delete-undo
  // brings it back first.
  it('accept side: delete an instance whose moved-out member is then deleted too — the entry undoes in full', async () => {
    await startRun(be, async () => {}, 'composite-root-then-moved-member');
    const b = memberOfP1('B');
    const root = p1().guid!;
    const holder = spawnEntity(getCurrentWorld(), getTraitByName('Transform')!.trait(), getTraitByName('EntityAttributes')!.trait({ guid: 'aaaaaaaa-0000-4000-8000-0000000020a1', name: 'Holder' })).id();
    // Out of P1's subtree, still its member: the shape a loaded scene can hold (#1437), which an editor move refuses now.
    writeTraitField(b.id, getTraitByName('EntityAttributes')!, 'parentId', holder);
    markStructureDirty();
    await settle();
    expect(piOf(findEntityByGuid(b.guid)!.id())?.rootInstanceId, 'B still linked to P1').toBe(findEntityByGuid(root)!.id());
    await runAsCompositeAction({ label: 'Batch' }, () => {
      deleteEntitiesWithUndo([findEntityByGuid(root)!.id()]);
      deleteEntitiesWithUndo([findEntityByGuid(b.guid)!.id()]);
    });
    await settle();
    expect(findEntityByGuid(b.guid)).toBeFalsy();

    const u = await undoStep('undo');
    await settle();
    expect(u.failed).toBeNull();
    expect(findEntityByGuid(root)).toBeTruthy();
    expect(findEntityByGuid(b.guid)).toBeTruthy();
  }, 120_000);

  // Mutation: in `prepare`, treat a root an earlier sub brings back as gone (skip the `pass.arriving` branch) → the
  // pre-pass passes, P1 respawns, and B's own undo refuses after it: a CompositeStepError, P1 back.
  it('a saved edit dropped B\'s row: the undo refuses whole, and P1 does not come back', async () => {
    const f = await startRun(be, async () => {}, 'composite-member-root-refuse');
    const { b, root } = await deleteMemberThenRoot();
    await savedEditOfP(f, (member) => { deleteEntitiesWithUndo([member('B')]); });

    const before = JSON.stringify(worldTree());
    const u = await undoStep('undo');
    await settle();
    expect(u.failed?.refused).toBe(true);
    expect(u.failed?.error).toContain('is no longer in its prefab');
    expect(findEntityByGuid(root)).toBeFalsy();
    expect(findEntityByGuid(b)).toBeFalsy();
    expect(JSON.stringify(worldTree())).toBe(before);
  }, 120_000);

  // Mutation: go blind on any delete that touched an instance (`rootLinks.length || …`) → the redo deletes B again before
  // the write refuses.
  it('redo: a member delete beside a write whose target is gone refuses whole, and B is not deleted again', async () => {
    await startRun(be, async () => {}, 'composite-member-redo');
    const b = memberOfP1('B');
    const plain = spawnEntity(getCurrentWorld(), getTraitByName('Transform')!.trait(), getTraitByName('EntityAttributes')!.trait({ guid: 'aaaaaaaa-0000-4000-8000-0000000020a0', name: 'Plain' })).id();
    await runAsCompositeAction({ label: 'Batch' }, () => {
      deleteEntitiesWithUndo([b.id]);
      expect(writeTraitFieldWithUndo(plain, getTraitByName('Transform')!, 'x', 4)).toBeNull();
    });
    await settle();
    expect((await undoStep('undo')).failed).toBeNull();
    await settle();
    expect(findEntityByGuid(b.guid)).toBeTruthy();
    deleteEntity(findEntityByGuid('aaaaaaaa-0000-4000-8000-0000000020a0')!.id());

    const r = await undoStep('redo');
    await settle();
    expect(r.failed?.refused).toBe(true);
    expect(findEntityByGuid(b.guid)).toBeTruthy();
  }, 120_000);
});
