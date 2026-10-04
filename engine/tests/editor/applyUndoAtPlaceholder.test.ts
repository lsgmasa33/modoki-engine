/** #2001 S8b: the undo of an Apply restores, from its records, every other tree the Apply's fan-out reached — and one that a
 *  trashed prefab has left a Missing Prefab placeholder since (hunt seed 9405) gets its records seated as they stood
 *  before the Apply, fresh, for the prefab's return to reproject from: nothing projects a placeholder, which made the
 *  restore refuse it and mark it stale, to be re-seeded from the capture at the next write.
 *
 *  Mutation (measured), `restoreRecords`' fan-out loop: marking a placeholder tree stale (the old path) — red (the record
 *  is stale); leaving it as it stands — red (it keeps the pin the Apply's fan-out gave it). Both restore to green. */
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
import { boot, bridge, memoryStorage, startRun, settle, piOf, type Fixture } from './prefabFuzz/harness';
import { createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { deleteAssetFiles, deletionPathsFor, planDeleteOutcome } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { deletedPrefabsShown } from '../../packages/modoki/src/editor/scene/deletedPrefabsMissing';
import { isMissingPrefabPlaceholder } from '../../packages/modoki/src/editor/undo/placeholderGate';
import { getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';
import { storedInstance } from '../../packages/modoki/src/runtime/prefab/instanceStore';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const rootOf = (f: Fixture, k: 'P' | 'O') => getAllEntities().find((x) => x.parentId === 0 && x.name === (k === 'P' ? 'R' : 'OR') && (k === 'O' || piOf(x.id)?.source === f.prefabs.P.guid))!;
/** O1's record as it stands, in a stable form. */
function oRecord(f: Fixture): { list: string } {
  const st = storedInstance(getCurrentWorld(), rootOf(f, 'O').guid!);
  expect(st, 'O1 has a record').toBeDefined();
  return { list: JSON.stringify([...st!.record.list.rows].sort(([a], [b]) => (a < b ? -1 : 1))) };
}

describe('#2001 S8b: an Apply\'s undo restores a fanned tree at a placeholder from its records', () => {
  it('seats the record O1 had before the Apply, fresh, after O is trashed (hunt seed 9405)', async () => {
    const f = await startRun(be, async () => {}, 'apply-undo-placeholder');
    const p1 = rootOf(f, 'P').id;
    const a = getAllEntities().find((x) => x.name === 'A' && piOf(x.id)?.rootInstanceId === p1)!.id;
    const before = oRecord(f);
    expect(createEntityWithUndo('Add Mine', a, [{ name: 'EntityAttributes', data: { name: 'Mine', parentId: a } }, { name: 'Transform', data: { x: 3 } }], () => {})).not.toBeNull();
    await settle();
    const g = getAllEntities().find((x) => x.name === 'Mine')!.guid!;
    const r = await applyToPrefabWithUndo(p1, new Set([`+added.${g}`]));
    expect(r.applied, JSON.stringify({ refused: r.refused, skipped: r.skipped })).toBe(true);
    await settle();
    expect(oRecord(f).list, 'premise: the Apply\'s fan-out changed O1\'s record (a pin for the new member)').not.toBe(before.list);
    // Trash O, as the Assets panel's delete (no undo entry, #1868 D2): O1 becomes a Missing Prefab placeholder.
    const paths = deletionPathsFor(f.prefabs.O.path, 'prefab', null);
    const del = await deleteAssetFiles(paths);
    expect(del.ok).toBe(true);
    unbindDeletedAssetEditors(planDeleteOutcome(paths, [f.prefabs.O.path], del.failed).went);
    await deletedPrefabsShown();
    await settle();
    expect(isMissingPrefabPlaceholder(rootOf(f, 'O').id), 'premise: O1 is a placeholder').toBe(true);
    const u = await undoStep('undo');
    expect(u, 'the Apply\'s undo ran').toMatchObject({ did: true, label: 'Apply to Prefab', refused: null, failed: null });
    await settle();
    expect(getAllEntities().filter((x) => x.name === 'Mine' && x.parentId !== 0 && piOf(x.id)?.rootInstanceId === rootOf(f, 'P').id), 'P1 is back to its user\'s node').toHaveLength(0);
    expect(oRecord(f), 'O1\'s record as it stood before the Apply, fresh').toEqual(before);
  }, 60_000);
});
