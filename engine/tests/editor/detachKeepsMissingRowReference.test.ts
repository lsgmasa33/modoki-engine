/** #2099 (owner 2026-10-03, option (a), per the hub's record on the issue): Detach of an instance whose content holds a
 *  Missing Prefab ROW placeholder leaves that row a Missing Prefab placeholder that KEEPS its reference and the records
 *  the scene held under it, and it is an instance again once the prefab returns. Before, the unpacked placeholder was
 *  saved as a plain node: the reference to the prefab and every record under the row were lost on that save.
 *
 *  The route: an edit inside the nested instance (a record under the row), the nested prefab to the trash, a reload (the
 *  row is a placeholder), Detach of the instance holding it, save, reload, then the prefab restored.
 *
 *  Mutation: in `detachPrefabInstanceUnmarked` (`prefabLink.ts`) drop the `markUnresolved` that makes the row placeholder
 *  a reference placeholder — red at the saved entry (no `prefab`), and QR never comes back as an instance. Keep it but
 *  return the bare node from `detachedRowRecord` (no `members`) — red at M's kept edit only. Drop the `markRowPlaceholder`
 *  loop in `reattachPrefabInstanceUnmarked` — the undo test goes red (the placeholder stays a reference one). */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { getAllEntities, getTraitByName } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, flushWatcher, type Fixture } from './prefabFuzz/harness';
import { deleteAssetFiles, deletionPathsFor } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { detachPrefabInstance, reattachPrefabInstance } from '../../packages/modoki/src/editor/scene/prefabLink';
import { unresolvedRefOf, rowPlaceholderOf } from '../../packages/modoki/src/runtime/core/unresolvedPrefabRef';

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
const tf = (id: number) => findEntity(id)!.get(getTraitByName('Transform')!.trait) as Record<string, number>;
const byGuid = (guid: string) => getAllEntities().find((x) => x.guid === guid);

describe('#2099: Detach keeps a missing nested row as a Missing Prefab placeholder with its reference', () => {
  it('detach → save → reload → the prefab restored: the row is an instance again, with the scene\'s record under it', async () => {
    const f = await startRun(be, async () => {}, 'detach-row-ref');
    const root = p1(f);
    const inP1 = (name: string) => getAllEntities().find((x) => under(p1(f)).has(x.id) && x.name === name)!;
    const qr = inP1('QR');
    const qrGuid = qr.guid!;
    // A record UNDER the row: the nested instance's member M moved.
    const m = getAllEntities().find((x) => under(qr.id).has(x.id) && x.name === 'M')!;
    writeTraitFieldWithUndo(m.id, getTraitByName('Transform')!, 'x', 42);
    await settle();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);

    // Q to the trash, then a reload: QR is a Missing Prefab ROW placeholder inside P1.
    const qPath = f.prefabs.Q.path;
    const q = be.read(qPath)!;
    let before = be.snapshot();
    expect((await deleteAssetFiles(deletionPathsFor(qPath, 'prefab', null))).ok).toBe(true);
    unbindDeletedAssetEditors([qPath]);
    await flushWatcher(be, before); await settle();
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded'); await settle();
    expect(rowPlaceholderOf(findEntity(byGuid(qrGuid)!.id) as never)?.source).toBe(f.prefabs.Q.guid);

    // Detach the instance holding it: still a Missing Prefab placeholder, now one that carries its own reference.
    detachPrefabInstance(p1(f)); await settle();
    const live = findEntity(byGuid(qrGuid)!.id);
    expect(rowPlaceholderOf(live as never)).toBeUndefined();
    expect(unresolvedRefOf(live as never)?.source).toBe(f.prefabs.Q.guid);
    expect(root).toBeGreaterThan(0);

    // The save keeps the reference (today: a plain node, the reference lost).
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const saved = (JSON.parse(be.read(f.scenePath)!) as { entities: Array<{ guid?: string; prefab?: string; members?: Record<string, unknown> }> }).entities.find((e) => e.guid === qrGuid);
    expect(saved?.prefab).toBe(f.prefabs.Q.guid);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded'); await settle();
    expect(unresolvedRefOf(findEntity(byGuid(qrGuid)!.id) as never)?.source).toBe(f.prefabs.Q.guid);

    // Q comes back: QR is an instance of it again, and M shows the scene's edit.
    before = be.snapshot(); be.write(qPath, q); await flushWatcher(be, before); await settle();
    const back = byGuid(qrGuid)!;
    expect(unresolvedRefOf(findEntity(back.id) as never)).toBeUndefined();
    expect(piOf(back.id)).toMatchObject({ source: f.prefabs.Q.guid, rootInstanceId: back.id });
    const mBack = getAllEntities().find((x) => under(back.id).has(x.id) && x.name === 'M')!;
    expect(tf(mBack.id).x).toBe(42);
  }, 60_000);

  it('the undo of the detach makes it the row\'s placeholder again', async () => {
    const f = await startRun(be, async () => {}, 'detach-row-undo');
    const qrGuid = getAllEntities().find((x) => under(p1(f)).has(x.id) && x.name === 'QR')!.guid!;
    const qPath = f.prefabs.Q.path;
    const before = be.snapshot();
    expect((await deleteAssetFiles(deletionPathsFor(qPath, 'prefab', null))).ok).toBe(true);
    unbindDeletedAssetEditors([qPath]);
    await flushWatcher(be, before); await settle();
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded'); await settle();
    const root = p1(f);
    const snapshot = detachPrefabInstance(root); await settle();
    expect(unresolvedRefOf(findEntity(byGuid(qrGuid)!.id) as never)?.kind).toBe('node');
    expect(reattachPrefabInstance(snapshot, { rootEcsId: root })).toBe(0); await settle();
    const live = findEntity(byGuid(qrGuid)!.id);
    expect(rowPlaceholderOf(live as never)?.source).toBe(f.prefabs.Q.guid);
    expect(unresolvedRefOf(live as never)).toBeUndefined();
  }, 60_000);
});
