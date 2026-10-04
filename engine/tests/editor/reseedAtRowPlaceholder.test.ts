/** #2058 review, finding 1: a stale record re-seeded from the capture at a Missing Prefab ROW placeholder. The re-seed drops
 *  a field of an added component that the live node does not mark and that holds the schema default (#1829's widening,
 *  `instanceSync.ts` `withoutUnstatedAddedFields`). A placeholder has no marks and no base the fold can state, so the first
 *  cut dropped real statements there: a rotation recorded whole (rotation is one value, #1880 F5) lost its default axes,
 *  and once the prefab returned with its root turned, the instance showed the prefab's axis instead of the override.
 *  Driven the way production gets there: a Detach of another instance marks every record stale, and the next door write
 *  (a rename) re-seeds the tree.
 *  Mutation: make `baseHas` answer false for a key the fold does not reach (the first cut) — red. Until #2001 S6 a second
 *  guard in `withoutUnstatedAddedFields` skipped a live placeholder, and this went red only with both gone. */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { getAllEntities, getTraitByName, getCurrentWorld } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, flushWatcher, type Fixture } from './prefabFuzz/harness';
import { deleteAssetFiles, deletionPathsFor } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { storedRecord } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { detachPrefabInstance } from '../../packages/modoki/src/editor/scene/prefabLink';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const p1 = (f: Fixture): number => getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === x.id; })!.id;
function under(root: number): Set<number> {
  const all = getAllEntities();
  const s = new Set<number>([root]);
  for (let grew = true; grew;) { grew = false; for (const e of all) if (!s.has(e.id) && s.has(e.parentId)) { s.add(e.id); grew = true; } }
  return s;
}
const named = (f: Fixture, name: string) => getAllEntities().find((x) => under(p1(f)).has(x.id) && x.name === name)!.id;
const tf = (id: number) => findEntity(id)!.get(getTraitByName('Transform')!.trait) as Record<string, number>;

describe('#2058 review: a re-seed at a Missing Prefab row placeholder keeps every stated field', () => {
  it('a rotation recorded on the nested row keeps all three axes, and wins once the prefab returns turned', async () => {
    const f = await startRun(be, async () => {}, 'reseed-ph');
    writeTraitFieldWithUndo(named(f, 'QR'), getTraitByName('Transform')!, 'rx', 0.5);
    await settle();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    // Q to the trash, then a reload: QR is a Missing Prefab ROW placeholder.
    const qPath = f.prefabs.Q.path;
    const q = be.read(qPath)!;
    let before = be.snapshot();
    expect((await deleteAssetFiles(deletionPathsFor(qPath, 'prefab', null))).ok).toBe(true);
    unbindDeletedAssetEditors([qPath]);
    await flushWatcher(be, before); await settle();
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded'); await settle();
    // Every record stale (a Detach of another instance), then a door write re-seeds P1's tree from the capture.
    detachPrefabInstance(getAllEntities().find((x) => x.name === 'HR')!.id); await settle();
    writeTraitFieldWithUndo(named(f, 'A'), getTraitByName('EntityAttributes')!, 'name', 'A2'); await settle();
    const rootGuid = getAllEntities().find((e) => e.id === p1(f))!.guid!;
    const rows = [...storedRecord(getCurrentWorld(), rootGuid)!.list.rows.values()];
    expect(rows.map((r) => r.traits?.Transform).find((t) => t && typeof t === 'object' && 'rx' in t)).toEqual({ rx: 0.5, ry: 0, rz: 0 });
    // Q comes back with its root turned about y: the override (all three axes) still wins.
    const doc = JSON.parse(q); doc.entities[0].traits.Transform.ry = 1;
    before = be.snapshot(); be.write(qPath, JSON.stringify(doc)); await flushWatcher(be, before); await settle();
    expect([tf(named(f, 'QR')).rx, tf(named(f, 'QR')).ry, tf(named(f, 'QR')).rz]).toEqual([0.5, 0, 0]);
  }, 60_000);
});
