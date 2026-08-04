/** Composite undo actions (mcp-persistence.md — the composite undo primitive).
 *
 *  Locks the contract Phase 2b depends on: N `*WithUndo` helper calls inside one
 *  `runAsCompositeAction` become exactly ONE undo entry whose undo reverts ALL of
 *  them, in reverse order — the thing `coalesceKey` cannot do for a heterogeneous
 *  batch (it keeps only the FIRST action's undo and silently strands the rest). */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCurrentWorld, getAllEntities, getTraitByName, readTraitData, findEntity,
  EntityAttributes, Transform, spawnEntity as engineSpawnEntity,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import {
  runAsCompositeAction, composeUndoActions, isCapturingActions,
  pushAction, setActionCallback, clearHistory, undo, redo, canUndo, canRedo,
  undoLabel, getEditVersion,
  writeTraitFieldWithUndo, createEntityWithUndo, deleteEntitiesWithUndo,
  readEditorJournal, clearEditorJournal,
} from '@modoki/engine/editor';

registerAllTraits();
setActionCallback(pushAction);

const noSelect = () => {};

/** Live undo-stack depth, measured by draining it (the manager exposes only canUndo). */
async function drainUndo(): Promise<number> {
  let n = 0;
  while (await undo()) n++;
  return n;
}

function spawnEntity(name: string, x = 0): number {
  const e = engineSpawnEntity(getCurrentWorld(), Transform({ x, y: 0, z: 0 }), EntityAttributes({ name }));
  return e.id();
}

function tfX(id: number): number {
  return readTraitData(id, getTraitByName('Transform')!)!.x as number;
}

function nameOf(id: number): string | undefined {
  return getAllEntities().find((e) => e.id === id)?.name;
}

beforeEach(() => {
  clearHistory();
  clearEditorJournal();
});

describe('runAsCompositeAction — one batch, one entry', () => {
  it('collapses a heterogeneous 3-op batch into ONE undo entry that reverts ALL of it', async () => {
    const a = spawnEntity('CompA', 1);
    const b = spawnEntity('CompB', 2);
    const tf = getTraitByName('Transform')!;
    let created: number | null = null;

    await runAsCompositeAction({ label: 'Mutate Scene (3 ops)' }, () => {
      writeTraitFieldWithUndo(a, tf, 'x', 11);
      writeTraitFieldWithUndo(b, tf, 'x', 22);
      created = createEntityWithUndo('Create', 0, [
        { name: 'Transform', data: { x: 7 } },
        { name: 'EntityAttributes', data: { name: 'CompNew' } },
      ], noSelect);
    });

    expect(tfX(a)).toBe(11);
    expect(tfX(b)).toBe(22);
    expect(created).not.toBeNull();
    expect(findEntity(created!)).toBeTruthy();

    // ONE entry — not three.
    expect(canUndo()).toBe(true);
    expect(undoLabel()).toBe('Mutate Scene (3 ops)');

    expect(await undo()).toBe(true);
    // Every sub-op reverted, not just the first.
    expect(tfX(a)).toBe(1);
    expect(tfX(b)).toBe(2);
    expect(findEntity(created!)).toBeFalsy();
    expect(await undo()).toBe(false); // the batch really was a single entry
  });

  it('redo re-applies every sub-op, in FORWARD order', async () => {
    const a = spawnEntity('RedoA', 0);
    const tf = getTraitByName('Transform')!;

    await runAsCompositeAction({ label: 'Batch' }, () => {
      writeTraitFieldWithUndo(a, tf, 'x', 5);
      createEntityWithUndo('Create', 0, [
        { name: 'Transform', data: {} },
        { name: 'EntityAttributes', data: { name: 'RedoSpawn' } },
      ], noSelect);
    });

    await undo();
    expect(tfX(a)).toBe(0);
    expect(getAllEntities().some((e) => e.name === 'RedoSpawn')).toBe(false);

    expect(await redo()).toBe(true);
    expect(tfX(a)).toBe(5);
    expect(getAllEntities().some((e) => e.name === 'RedoSpawn')).toBe(true);
    expect(canRedo()).toBe(false); // one entry, fully redone
  });

  it('undoes sub-actions in REVERSE order and redoes them FORWARD, sequentially', async () => {
    const order: string[] = [];
    const step = (tag: string, delayUndo = false) => pushAction({
      label: tag,
      undo: async () => {
        order.push(`${tag}:undo:start`);
        if (delayUndo) await new Promise((r) => setTimeout(r, 5));
        order.push(`${tag}:undo:end`);
      },
      redo: () => { order.push(`${tag}:redo`); },
    });

    await runAsCompositeAction({ label: 'Ordered' }, () => {
      step('1', true); step('2'); step('3');
    });

    await undo();
    // Reverse order, and each awaited before the next starts (1's slow undo finishes
    // before the loop ends — no interleaving).
    expect(order).toEqual([
      '3:undo:start', '3:undo:end',
      '2:undo:start', '2:undo:end',
      '1:undo:start', '1:undo:end',
    ]);

    order.length = 0;
    await redo();
    expect(order).toEqual(['1:redo', '2:redo', '3:redo']);
  });

  it('deletes inside a batch undo back into existence along with the rest', async () => {
    const keep = spawnEntity('BatchKeep', 3);
    const doomed = spawnEntity('BatchDoomed', 9);
    const tf = getTraitByName('Transform')!;

    await runAsCompositeAction({ label: 'Delete + edit' }, () => {
      writeTraitFieldWithUndo(keep, tf, 'x', 30);
      deleteEntitiesWithUndo([doomed]);
    });

    expect(nameOf(doomed)).toBeUndefined();
    await undo();
    expect(tfX(keep)).toBe(3);
    expect(getAllEntities().some((e) => e.name === 'BatchDoomed')).toBe(true);
  });

  it('pushes exactly ONE entry per batch, not one per sub-op', async () => {
    const a = spawnEntity('CountA');
    const tf = getTraitByName('Transform')!;
    await runAsCompositeAction({ label: 'Batch1' }, () => {
      for (let i = 0; i < 5; i++) writeTraitFieldWithUndo(a, tf, 'x', i);
    });
    await runAsCompositeAction({ label: 'Batch2' }, () => {
      for (let i = 0; i < 5; i++) writeTraitFieldWithUndo(a, tf, 'y', i);
    });
    expect(await drainUndo()).toBe(2);
  });

  it('bumps the edit version ONCE per batch (one dirty commit, not N)', async () => {
    const a = spawnEntity('VersionA');
    const tf = getTraitByName('Transform')!;
    const before = getEditVersion();
    await runAsCompositeAction({ label: 'Batch' }, () => {
      writeTraitFieldWithUndo(a, tf, 'x', 1);
      writeTraitFieldWithUndo(a, tf, 'y', 2);
      writeTraitFieldWithUndo(a, tf, 'z', 3);
    });
    expect(getEditVersion()).toBe(before + 1);
  });

  it('returns the body result and pushes nothing for an empty batch', async () => {
    const r = await runAsCompositeAction({ label: 'Nothing' }, () => 'value');
    expect(r).toBe('value');
    expect(canUndo()).toBe(false);
    expect(isCapturingActions()).toBe(false);
  });

  it('clears the redo stack, like any normal push', async () => {
    const a = spawnEntity('RedoClear');
    const tf = getTraitByName('Transform')!;
    pushAction({ label: 'Prior', undo: () => {}, redo: () => {} });
    await undo();
    expect(canRedo()).toBe(true);
    await runAsCompositeAction({ label: 'Batch' }, () => { writeTraitFieldWithUndo(a, tf, 'x', 1); });
    expect(canRedo()).toBe(false);
  });
});

describe('runAsCompositeAction — failure aborts the whole batch', () => {
  it('rolls back applied sub-ops and pushes NOTHING when a later op throws', async () => {
    const a = spawnEntity('FailA', 4);
    const tf = getTraitByName('Transform')!;
    let created: number | null = null;

    await expect(runAsCompositeAction({ label: 'Bad batch' }, () => {
      writeTraitFieldWithUndo(a, tf, 'x', 44);
      created = createEntityWithUndo('Create', 0, [
        { name: 'Transform', data: {} },
        { name: 'EntityAttributes', data: { name: 'FailSpawn' } },
      ], noSelect);
      throw new Error('op 3 is invalid');
    })).rejects.toThrow('op 3 is invalid');

    // Nothing half-applied…
    expect(tfX(a)).toBe(4);
    expect(findEntity(created!)).toBeFalsy();
    // …and no undo entry claiming a batch that did not happen.
    expect(canUndo()).toBe(false);
    expect(isCapturingActions()).toBe(false);
  });

  it('closes the capture frame on throw so later pushes reach the real stack', async () => {
    await expect(runAsCompositeAction({ label: 'Boom' }, () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    pushAction({ label: 'After', undo: () => {}, redo: () => {} });
    expect(canUndo()).toBe(true);
    expect(undoLabel()).toBe('After');
  });

  it('surfaces the ORIGINAL error even when a rollback step also fails', async () => {
    await expect(runAsCompositeAction({ label: 'Bad' }, () => {
      pushAction({ label: 'unrollbackable', undo: () => { throw new Error('rollback failed'); }, redo: () => {} });
      throw new Error('original');
    })).rejects.toThrow('original');
    expect(canUndo()).toBe(false);
  });
});

describe('runAsCompositeAction — re-entrancy and the _executing guard', () => {
  it('a sub-action pushed during the batch never reaches the stack directly', async () => {
    const seen: boolean[] = [];
    await runAsCompositeAction({ label: 'Batch' }, () => {
      pushAction({ label: 'sub', undo: () => {}, redo: () => {} });
      seen.push(canUndo()); // still empty mid-batch — the push was captured
    });
    expect(seen).toEqual([false]);
    expect(await drainUndo()).toBe(1);
  });

  it('a push attempted from INSIDE the composite undo is refused (_executing), not captured', async () => {
    await runAsCompositeAction({ label: 'Batch' }, () => {
      pushAction({
        label: 'sub',
        undo: () => { pushAction({ label: 'illegal', undo: () => {}, redo: () => {} }); },
        redo: () => {},
      });
    });
    expect(await undo()).toBe(true);
    expect(isCapturingActions()).toBe(false);
    expect(canUndo()).toBe(false);       // the illegal push landed nowhere
    expect(canRedo()).toBe(true);        // the batch itself moved to redo intact
  });

  it('nests: an inner composite becomes ONE sub-action of the outer one', async () => {
    const order: string[] = [];
    const step = (tag: string) => pushAction({
      label: tag, undo: () => { order.push(`u${tag}`); }, redo: () => { order.push(`r${tag}`); },
    });

    await runAsCompositeAction({ label: 'Outer' }, async () => {
      step('A');
      await runAsCompositeAction({ label: 'Inner' }, () => { step('B'); step('C'); });
      step('D');
    });

    expect(await drainUndo()).toBe(1); // one entry total
    expect(order).toEqual(['uD', 'uC', 'uB', 'uA']); // reverse, inner flattened in place
  });
});

describe('composite journal event', () => {
  it('emits ONE batch event carrying every sub-action payload, not N events', async () => {
    const a = spawnEntity('JournalA', 0);
    const tf = getTraitByName('Transform')!;
    clearEditorJournal();

    await runAsCompositeAction({ label: 'Mutate Scene (2 ops)' }, () => {
      writeTraitFieldWithUndo(a, tf, 'x', 12);
      createEntityWithUndo('Create', 0, [
        { name: 'Transform', data: {} },
        { name: 'EntityAttributes', data: { name: 'JournalSpawn' } },
      ], noSelect);
    });

    // No per-sub-op !edit/!create events — the batch is the commit.
    expect(readEditorJournal({ type: '!edit' })).toHaveLength(0);
    expect(readEditorJournal({ type: '!create' })).toHaveLength(0);

    const batch = readEditorJournal({ type: '!batch' });
    expect(batch).toHaveLength(1);
    const payload = batch[0].payload as { label: string; count: number; ops: Record<string, unknown>[] };
    expect(payload.label).toBe('Mutate Scene (2 ops)');
    expect(payload.count).toBe(2);
    expect(payload.ops).toHaveLength(2);
    // Sub-action detail is preserved, nested under the one commit.
    expect(payload.ops[0].kind).toBe('!edit');
    expect(payload.ops[0].detail).toMatchObject({ trait: 'Transform', field: 'x', new: [12] });
    expect(payload.ops[1].kind).toBe('!create');
    expect(payload.ops[1]).toHaveProperty('entity');
  });

  it('honours a caller-supplied kind and merges extra journal payload over the summary', async () => {
    clearEditorJournal();
    await runAsCompositeAction({ label: 'Agent ops', kind: '!mutate', journalPayload: { source: 'mcp' } }, () => {
      pushAction({ label: 'sub', undo: () => {}, redo: () => {} });
    });
    const ev = readEditorJournal({ type: '!mutate' });
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ source: 'mcp', count: 1 });
  });

  it('survives an unserializable trait value in a sub-action detail', async () => {
    clearEditorJournal();
    await runAsCompositeAction({ label: 'Weird' }, () => {
      pushAction({
        label: 'sub', undo: () => {}, redo: () => {},
        detail: { trait: 'T', field: 'f', entities: ['g'], old: [null], new: [() => 0] },
      });
    });
    const ev = readEditorJournal({ type: '!batch' });
    expect(ev).toHaveLength(1);
    expect((ev[0].payload as { ops: { detail: { new: unknown } }[] }).ops[0].detail.new).toBe('<unserializable>');
  });
});

describe('composeUndoActions', () => {
  it('returns null for an empty batch — nothing should occupy an undo slot', () => {
    expect(composeUndoActions([], { label: 'Empty' })).toBeNull();
  });

  it('inherits _isFileDirect / _isSelection only when EVERY sub carries it', () => {
    const fd = { label: 'f', undo: () => {}, redo: () => {}, _isFileDirect: true as const };
    const live = { label: 'l', undo: () => {}, redo: () => {} };
    expect(composeUndoActions([fd, fd], { label: 'B' })!._isFileDirect).toBe(true);
    expect(composeUndoActions([fd, live], { label: 'B' })!._isFileDirect).toBeUndefined();
    const sel = { label: 's', undo: () => {}, redo: () => {}, _isSelection: true as const };
    expect(composeUndoActions([sel], { label: 'B' })!._isSelection).toBe(true);
    expect(composeUndoActions([sel, live], { label: 'B' })!._isSelection).toBeUndefined();
  });

  /** REGRESSION (independent review, 2026-07-30). `pushAction` diverts a sub-action into
   *  the capture frame BEFORE `markAffectedScenesDirty` runs, so a captured sub never marks
   *  its own scene dirty. The composite therefore has to carry the union — and did not, so a
   *  live agent edit to a BASE-scene entity was dirty nowhere, and `saveAll` (which writes a
   *  non-primary scene only `if (isSceneDirty(guid))`) silently never saved it. */
  it('unions affectedScenes from its subs, so a base-scene edit survives to saveAll', () => {
    const inBase = (guid: string) => ({ label: 'e', undo: () => {}, redo: () => {}, affectedScenes: [guid] });
    const act = composeUndoActions([inBase('base-1'), inBase('base-2'), inBase('base-1')], { label: 'B' })!;
    expect([...(act.affectedScenes ?? [])].sort()).toEqual(['base-1', 'base-2']); // deduped
  });

  it('omits affectedScenes contributed by a selection or file-direct sub', () => {
    // Those subs are skipped by markAffectedScenesDirty when pushed alone; batching must
    // not smuggle their scenes in — over-reporting dirty here would mean a spurious refusal.
    const sel = { label: 's', undo: () => {}, redo: () => {}, _isSelection: true as const, affectedScenes: ['s1'] };
    const fd = { label: 'f', undo: () => {}, redo: () => {}, _isFileDirect: true as const, affectedScenes: ['f1'] };
    const live = { label: 'l', undo: () => {}, redo: () => {}, affectedScenes: ['live-1'] };
    expect(composeUndoActions([sel, fd, live], { label: 'B' })!.affectedScenes).toEqual(['live-1']);
    expect(composeUndoActions([sel, fd], { label: 'B' })!.affectedScenes).toBeUndefined();
  });

  it('defaults to NO coalesceKey — every batch is its own undo step', () => {
    const act = composeUndoActions([{ label: 'a', undo: () => {}, redo: () => {} }], { label: 'B' })!;
    expect(act.coalesceKey).toBeUndefined();
    expect(act.kind).toBe('!batch');
  });

  it('rejects with an AggregateError when a sub-undo fails, having still run the others', async () => {
    const ran: string[] = [];
    const act = composeUndoActions([
      { label: 'a', undo: () => { ran.push('a'); }, redo: () => {} },
      { label: 'b', undo: () => { throw new Error('nope'); }, redo: () => {} },
      { label: 'c', undo: () => { ran.push('c'); }, redo: () => {} },
    ], { label: 'B' })!;
    await expect(act.undo()).rejects.toThrow(AggregateError);
    expect(ran).toEqual(['c', 'a']); // the failure did not abort the remaining undos
  });
});
