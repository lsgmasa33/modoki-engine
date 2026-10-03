/** #2001 S8: an undo or redo that keeps the instance store's records exact leaves them fresh.
 *
 *  - A selection change and an asset-file edit that rebuilds no live frame touch no instance, and used to mark every
 *    record stale on each undo and redo (the hunt tally's commonest causes after Instantiate, "undo:selection").
 *  - An agent's batch (`Set Traits`, `Mutate Scene`) is one entry of sub-steps that each put back their own records:
 *    the batch keeps them when every sub does, and used to drop the flag whatever its subs did.
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
import { boot, bridge, memoryStorage, startRun, authored } from './prefabFuzz/harness';
import { getCurrentWorld, getTraitByName } from '@modoki/engine/runtime';
import { pushAction, undoStep, keepsRecords, type UndoAction } from '../../packages/modoki/src/editor/undo/undoManager';
import { runAsCompositeAction, composeUndoActions } from '../../packages/modoki/src/editor/undo/compositeAction';
import { writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { storedInstance } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const p1 = () => authored().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;
const staleness = () => storedInstance(getCurrentWorld(), p1().guid!)?.stale;
const noop = (flags: Partial<UndoAction>): UndoAction => ({ label: 'step', undo: () => {}, redo: () => {}, ...flags });
/** The member called `name` under P1. */
function inP1(name: string): number {
  const top = p1().id;
  const under = (id: number): boolean => { for (let at = id; at; at = authored().find((e) => e.id === at)?.parentId ?? 0) if (at === top) return true; return false; };
  return authored().find((e) => e.name === name && under(e.id))!.id;
}

describe('#2001 S8: steps that keep the records exact leave them fresh', () => {
  it('which steps keep them', () => {
    expect(keepsRecords(noop({ maintainsRecords: true }))).toBe(true);
    expect(keepsRecords(noop({ _isSelection: true }))).toBe(true);
    expect(keepsRecords(noop({ _isFileDirect: true }))).toBe(true);
    expect(keepsRecords(noop({ _isFileDirect: true, _rebasesLiveFrames: true }))).toBe(false);
    expect(keepsRecords(noop({}))).toBe(false);
  });

  it.each([
    ['a selection change', { _isSelection: true }, undefined],
    ['an asset-file edit', { _isFileDirect: true }, undefined],
    // The accept side: a step that says nothing still marks them, so the cases above are not passing for free.
    ['a step that maintains nothing', {}, 'undo'],
  ] as const)('the undo of %s', async (_what, flags, expected) => {
    await startRun(be, async () => {}, `keeps-${Object.keys(flags).join('') || 'none'}`);
    expect(staleness(), 'premise: fresh after the load').toBeUndefined();
    pushAction(noop(flags));
    expect((await undoStep('undo')).did).toBe(true);
    expect(staleness()).toBe(expected);
  }, 60_000);

  it('a batch keeps them when every sub-step does, and not when one does not', async () => {
    expect(composeUndoActions([noop({ maintainsRecords: true }), noop({ _isSelection: true })], { label: 'b' })?.maintainsRecords).toBe(true);
    expect(composeUndoActions([noop({ maintainsRecords: true }), noop({})], { label: 'b' })?.maintainsRecords).toBeUndefined();

    await startRun(be, async () => {}, 'keeps-batch');
    const tf = getTraitByName('Transform')!;
    const a = inP1('A');
    await runAsCompositeAction({ label: 'Set Traits' }, () => {
      writeTraitFieldWithUndo(a, tf, 'x', 11);
      writeTraitFieldWithUndo(a, tf, 'y', 12);
    });
    const after = structuredClone(storedInstance(getCurrentWorld(), p1().guid!)!.record.list);
    expect((await undoStep('undo')).did).toBe(true);
    expect(staleness()).toBeUndefined();
    expect((await undoStep('redo')).did).toBe(true);
    expect(staleness()).toBeUndefined();
    expect(storedInstance(getCurrentWorld(), p1().guid!)!.record.list).toEqual(after);
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
    expect(storedInstance(getCurrentWorld(), qGuid)?.stale).toBeUndefined();

    expect((await undoStep('undo')).did).toBe(true);
    expect(staleness()).toBeUndefined();
    expect(list()).toEqual(before);
    expect(storedInstance(getCurrentWorld(), qGuid), 'the dropped instance\'s record goes with it').toBeUndefined();

    expect((await undoStep('redo')).did).toBe(true);
    expect(staleness()).toBeUndefined();
    expect(list()).toEqual(after);
    expect(storedInstance(getCurrentWorld(), qGuid)?.stale).toBeUndefined();
  }, 60_000);
});
