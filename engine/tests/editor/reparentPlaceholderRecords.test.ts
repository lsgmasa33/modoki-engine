/** #2001 S8b: a move that carries a Missing Prefab placeholder keeps the records, so its undo and its redo seat them back
 *  exactly. The placeholder is a root no tree projects; the move takes its record as it stands, with the trees it
 *  touches. Before, the move found no records it could take and left its undo and redo to mark
 *  every record stale, to be re-seeded from the capture at the next write (hunt seeds 9401: the placeholder is the mover;
 *  8039: the placeholder holds an instance).
 *
 *  Mutation (measured), `takeRecordsAround`: returning null for any root that does not project (the old guard) — both
 *  red (the undo leaves every record stale). Restored: green. Taking the records a placeholder links by a held `own`
 *  link as well was GREEN (nothing here changes them), so the fix does not take them. */
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
import { instantiatePrefabInstance } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { applyReparent } from '../../packages/modoki/src/editor/undo/entityActions';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { deleteAssetFiles, deletionPathsFor, planDeleteOutcome } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { deletedPrefabsShown } from '../../packages/modoki/src/editor/scene/deletedPrefabsMissing';
import { isMissingPrefabPlaceholder } from '../../packages/modoki/src/editor/undo/placeholderGate';
import { getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';
import { storedInstances } from '../../packages/modoki/src/runtime/prefab/instanceStore';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const byName = (n: string) => getAllEntities().filter((x) => x.name === n);
const p1 = (f: Fixture) => getAllEntities().find((x) => x.parentId === 0 && piOf(x.id)?.source === f.prefabs.P.guid)!;
/** H1's root: an H instance, or the placeholder H's trash left. */
const hr = () => byName('HR').find((x) => x.parentId === 0)!;
/** The Q instance nested under H1 (the hunt's `setupNest`). */
const qUnderH = () => byName('QR').find((x) => x.parentId === hr().id)!;

/** Every record in the store, whether it is stale, in a stable form. */
function store(): string {
  const sorted = (m: Map<unknown, unknown>) => [...m].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1));
  return JSON.stringify([...storedInstances(getCurrentWorld())].sort(([a], [b]) => (a < b ? -1 : 1)).map(([g, s]) => [g, s.record]),
    (_k, v) => (v instanceof Map ? sorted(v) : v instanceof Set ? [...v].sort() : v));
}

/** The fixture with Q nested under H1 (as the hunt runs it), and `prefab` trashed as the Assets panel's delete does. */
async function trashed(key: string, prefab: 'Q' | 'H'): Promise<Fixture> {
  const f = await startRun(be, async (fx) => {
    const host = getAllEntities().find((e) => piOf(e.id)?.source === fx.prefabs.H.guid && piOf(e.id)!.rootInstanceId === e.id)!;
    const q = JSON.parse(await (await fetch(fx.prefabs.Q.path)).text());
    expect(await instantiatePrefabInstance(q, fx.prefabs.Q.path, host.id)).toBeTruthy();
  }, key);
  const paths = deletionPathsFor(f.prefabs[prefab].path, 'prefab', null);
  const del = await deleteAssetFiles(paths);
  expect(del.ok).toBe(true);
  unbindDeletedAssetEditors(planDeleteOutcome(paths, [f.prefabs[prefab].path], del.failed).went);
  await deletedPrefabsShown();
  await settle();
  return f;
}

/** Move `id` under `parent`, then undo and redo it: each lands on the store exactly as it stood, every record fresh. */
async function moveUndoRedo(id: number, parent: number, back: () => number | undefined) {
  const from = back();
  const before = store();
  expect(applyReparent(id, parent).ok).toBe(true);
  await settle();
  const after = store();
  expect(after, 'premise: the move changed a record').not.toBe(before);
  expect(await undoStep('undo')).toMatchObject({ did: true, refused: null, failed: null });
  await settle();
  expect(store(), 'the undo seated the records as they stood before the move').toBe(before);
  expect(back(), 'back where it was').toBe(from);
  expect(await undoStep('redo')).toMatchObject({ did: true, refused: null, failed: null });
  await settle();
  expect(store(), 'the redo seated the records the move left').toBe(after);
  expect(getAllEntities().find((x) => x.id === id)?.parentId, 'moved again').toBe(parent);
}

describe('#2001 S8b: a move that carries a Missing Prefab placeholder keeps the records', () => {
  it('the placeholder is the mover: Q\'s, out of H1 to P1\'s root (hunt seed 9401)', async () => {
    const f = await trashed('reparent-placeholder-mover', 'Q');
    const q = qUnderH().id;
    expect(isMissingPrefabPlaceholder(q), 'premise: H1\'s Q is a placeholder').toBe(true);
    await moveUndoRedo(q, p1(f).id, () => qUnderH()?.id);
  }, 60_000);

  it('the placeholder holds an instance: H1\'s, with its Q, under Plain (hunt seed 8039)', async () => {
    await trashed('reparent-placeholder-holding', 'H');
    const h = hr().id;
    expect(isMissingPrefabPlaceholder(h), 'premise: H1 is a placeholder').toBe(true);
    expect(piOf(qUnderH().id)?.rootInstanceId, 'premise: the Q under it is a live instance').toBe(qUnderH().id);
    const plain = byName('Plain')[0]!.id;
    await moveUndoRedo(h, plain, () => hr()?.id);
  }, 60_000);
});
