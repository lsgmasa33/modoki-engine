/** #2001 S8b: a delete whose target is a scene-owned node BELOW the one an anchor's `own` links keeps the records: that node
 *  comes back from its snapshot and the tree around it from its records, so the undo and the redo seat the store exactly.
 *  Before, such a target sent the whole delete off records, and its undo marked every record stale, to be re-seeded from
 *  the capture at the next write (hunt seeds 8052: a user's node under one a Duplicate placed; 8059: under one an
 *  agent added).
 *
 *  Mutation (measured), `deleteTrees`: refusing a target below a linked node (the old guard) — both red (the undo leaves
 *  every record stale). `inTree` not excluding it (left to the records to bring back) — both red (the node does not come
 *  back: the reprojection keeps the linked node live and does not re-add what it lost). Restored: green. */
import { describe, it, expect, vi } from 'vitest';
import { getAllEntities, findEntity, getTraitByName } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, type Fixture } from './prefabFuzz/harness';
import { createEntityWithUndo, deleteEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { instanceTargetOf } from '../../packages/modoki/src/editor/instance/instanceKeys';
import { getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';
import { storedInstances } from '../../packages/modoki/src/runtime/prefab/instanceStore';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const byName = (n: string) => getAllEntities().filter((x) => x.name === n);
const p1 = (f: Fixture) => getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === x.id; })!;
const member = (f: Fixture, n: string) => getAllEntities().find((x) => x.name === n && piOf(x.id)?.rootInstanceId === p1(f).id)!;

/** Every record in the store, whether it is stale, in a stable form. */
function store(): string {
  const sorted = (m: Map<unknown, unknown>) => [...m].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1));
  return JSON.stringify([...storedInstances(getCurrentWorld())].sort(([a], [b]) => (a < b ? -1 : 1)).map(([g, s]) => [g, s.record]),
    (_k, v) => (v instanceof Map ? sorted(v) : v instanceof Set ? [...v].sort() : v));
}

/** A user's node `Mine` under P1's member A (linked by A's `own`), with `Sub` (x 5) under it and `Kid` under that. */
async function belowLink(key: string): Promise<Fixture> {
  const f = await startRun(be, async () => {}, key);
  const add = (name: string, parentId: number, x: number) => {
    expect(createEntityWithUndo(`Add ${name}`, parentId, [{ name: 'EntityAttributes', data: { name, parentId } }, { name: 'Transform', data: { x } }], () => {})).not.toBeNull();
  };
  add('Mine', member(f, 'A').id, 3);
  await settle();
  add('Sub', byName('Mine')[0]!.id, 5);
  await settle();
  add('Kid', byName('Sub')[0]!.id, 7);
  await settle();
  const sub = byName('Sub')[0]!.id;
  expect(instanceTargetOf(sub), 'premise: Sub is scene-owned below the linked node').toMatchObject({ kind: 'owned', linkId: byName('Mine')[0]!.id });
  return f;
}

/** The scene-owned nodes as they hang: each one's name, parent's name and x. */
const owned = () => ['Mine', 'Sub', 'Kid'].flatMap(byName).map((x) => [x.name, getAllEntities().find((p) => p.id === x.parentId)?.name, x.guid,
  (findEntity(x.id)?.get(getTraitByName('Transform')!.trait) as { x?: number } | undefined)?.x]);

/** Delete `ids`, then undo and redo it: each lands on the store exactly as it stood, every record fresh. */
async function deleteUndoRedo(ids: number[], gone: string[]) {
  const before = store();
  const nodes = owned();
  expect(nodes.map((n) => n[3]), 'premise: the values are read').toEqual([3, 5, 7]);
  deleteEntitiesWithUndo(ids);
  await settle();
  const after = store();
  for (const n of gone) expect(byName(n), `${n} deleted`).toHaveLength(0);
  expect(await undoStep('undo')).toMatchObject({ did: true, refused: null, failed: null });
  await settle();
  expect(store(), 'the undo seated the records as they stood before the delete').toBe(before);
  expect(owned(), 'every scene-owned node back once, where it was, with its values and guid').toEqual(nodes);
  expect(await undoStep('redo')).toMatchObject({ did: true, refused: null, failed: null });
  await settle();
  expect(store(), 'the redo seated the records the delete left').toBe(after);
  for (const n of gone) expect(byName(n), `${n} deleted again`).toHaveLength(0);
}

describe('#2001 S8b: a delete of a scene-owned node below a linked one keeps the records', () => {
  it('the node alone, with its child (hunt seeds 8052, 8059)', async () => {
    await belowLink('delete-below-link');
    await deleteUndoRedo([byName('Sub')[0]!.id], ['Sub', 'Kid']);
  }, 60_000);

  it('beside a member of the same tree, in one delete', async () => {
    const f = await belowLink('delete-below-link-and-member');
    expect(member(f, 'B'), 'premise: P1 has a member B').toBeDefined();
    const b = member(f, 'B').guid;
    await deleteUndoRedo([byName('Sub')[0]!.id, member(f, 'B').id], ['Sub', 'Kid']);
    expect(getAllEntities().find((x) => x.guid === b), 'B deleted again').toBeUndefined();
  }, 60_000);
});
