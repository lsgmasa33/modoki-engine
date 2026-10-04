/** #2001 S8b: a delete of a Missing Prefab placeholder that holds a live instance keeps the records: the placeholder's are
 *  seated and the instance's tree, which projects on its own under it, is restored from its records, so the undo and the
 *  redo seat the store exactly. Before, the projecting tree under the placeholder sent the whole delete off records, and
 *  its undo marked every record stale, to be re-seeded from the capture at the next write (hunt seed 9454, where the
 *  stale records then sent an Apply's undo to its snapshot path).
 *
 *  Mutation (measured), `deleteTrees`: refusing a node whose tree projects under a placeholder (the old guard) — red (the
 *  undo leaves every record stale): the first red. Taking a tree that projects under a placeholder that STAYS as well
 *  (`deleted.has(outer)` dropped): the second red (the undo leaves the placeholder's record fresh and wrong). Restored:
 *  green. Not filtering the projecting tree's roots out of the placeholder's seat was GREEN (the seat re-states the same
 *  records), so the seat states them. */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

// The OS trash, stubbed to delete from the scratch directory as `prefabFuzz.test.ts` does.
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { getAllEntities } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf } from './prefabFuzz/harness';
import { instantiatePrefabInstance } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { deleteEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { deleteAssetFiles, deletionPathsFor, planDeleteOutcome } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { deletedPrefabsShown } from '../../packages/modoki/src/editor/scene/deletedPrefabsMissing';
import { isMissingPrefabPlaceholder } from '../../packages/modoki/src/editor/undo/placeholderGate';
import { projectionRootOf } from '../../packages/modoki/src/editor/instance/instanceKeys';
import { getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';
import { storedInstances } from '../../packages/modoki/src/runtime/prefab/instanceStore';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const byName = (n: string) => getAllEntities().filter((x) => x.name === n);
/** H1's root: an H instance, or the placeholder H's trash left. */
const hr = () => byName('HR').find((x) => x.parentId === 0);
/** The Q instance placed under H1. */
const qUnderH = () => byName('QR').find((x) => x.parentId === hr()?.id);

/** `v` in a stable form, its Maps and Sets written out (a record holds both). */
function canon(v: unknown): string {
  const sorted = (m: Map<unknown, unknown>) => [...m].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1));
  return JSON.stringify(v, (_k, x) => (x instanceof Map ? sorted(x) : x instanceof Set ? [...x].sort() : x));
}
/** Every record in the store, whether it is stale, in a stable form. */
const store = () => canon([...storedInstances(getCurrentWorld())].sort(([a], [b]) => (a < b ? -1 : 1)).map(([g, s]) => [g, s.record]));

/** H1's subtree as it hangs: each node's name, parent's name and guid. */
function underH(): string[][] {
  const all = getAllEntities();
  const top = hr();
  if (!top) return [];
  const inIt = (id: number): boolean => { for (let a = id; a; a = all.find((x) => x.id === a)?.parentId ?? 0) if (a === top.id) return true; return false; };
  return all.filter((x) => inIt(x.id)).map((x) => [x.name, all.find((p) => p.id === x.parentId)?.name ?? '', x.guid ?? '']).sort((a, b) => (a.join() < b.join() ? -1 : 1));
}

/** The fixture with a Q instance placed under H1, and H trashed as the Assets panel's delete does: H1 is a placeholder. */
async function qUnderPlaceholder(key: string): Promise<void> {
  const f = await startRun(be, async (fx) => {
    const host = getAllEntities().find((e) => piOf(e.id)?.source === fx.prefabs.H.guid && piOf(e.id)!.rootInstanceId === e.id)!;
    const q = JSON.parse(await (await fetch(fx.prefabs.Q.path)).text());
    expect(await instantiatePrefabInstance(q, fx.prefabs.Q.path, host.id)).toBeTruthy();
  }, key);
  const paths = deletionPathsFor(f.prefabs.H.path, 'prefab', null);
  const del = await deleteAssetFiles(paths);
  expect(del.ok).toBe(true);
  unbindDeletedAssetEditors(planDeleteOutcome(paths, [f.prefabs.H.path], del.failed).went);
  await deletedPrefabsShown();
  await settle();
  expect(isMissingPrefabPlaceholder(hr()!.id), 'premise: H1 is a placeholder').toBe(true);
  expect(projectionRootOf(qUnderH()!.id), 'premise: the Q under it projects on its own').toBe(qUnderH()!.id);
}

describe('#2001 S8b: a delete of a Missing Prefab placeholder holding a live instance keeps the records', () => {
  it('H1\'s placeholder, with the Q instance under it (hunt seed 9454)', async () => {
    await qUnderPlaceholder('delete-placeholder-tree');
    const h = hr()!.id;
    const nodes = underH();
    expect(nodes.length, 'premise: Q\'s members hang under it').toBeGreaterThan(2);

    const before = store();
    deleteEntitiesWithUndo([h]);
    await settle();
    const after = store();
    expect(hr(), 'H1 deleted').toBeUndefined();
    expect(await undoStep('undo')).toMatchObject({ did: true, refused: null, failed: null });
    await settle();
    expect(store(), 'the undo seated the records as they stood before the delete').toBe(before);
    expect(underH(), 'the placeholder and the instance under it back, with their guids').toEqual(nodes);
    expect(await undoStep('redo')).toMatchObject({ did: true, refused: null, failed: null });
    await settle();
    expect(store(), 'the redo seated the records the delete left').toBe(after);
    expect(hr(), 'H1 deleted again').toBeUndefined();
  }, 60_000);

  // The accept side's bound: a placeholder that STAYS is not stated by the delete (its record links the instance, which
  // the delete unlinks), so the delete stays on the snapshot and its undo leaves the records stale for the re-seed —
  // never fresh and wrong.
  it('the Q alone, under the placeholder that stays: no record the undo leaves fresh is wrong', async () => {
    await qUnderPlaceholder('delete-tree-under-placeholder');
    const nodes = underH();
    const before = new Map([...storedInstances(getCurrentWorld())].map(([g, s]) => [g, canon(s.record)]));
    deleteEntitiesWithUndo([qUnderH()!.id]);
    await settle();
    expect(qUnderH(), 'Q deleted').toBeUndefined();
    expect(await undoStep('undo')).toMatchObject({ did: true, refused: null, failed: null });
    await settle();
    expect(underH(), 'the Q back under the placeholder, with its guids').toEqual(nodes);
    const wrong = [...storedInstances(getCurrentWorld())].filter(([g, s]) => canon(s.record) !== before.get(g)).map(([g]) => g);
    expect(before.size, 'premise: the records are read').toBeGreaterThan(0);
    expect([...before.values()].every((r) => r.includes('"list"')), 'premise: a record is written out whole').toBe(true);
    expect(wrong, 'every fresh record as it stood before the delete').toEqual([]);
  }, 60_000);
});
