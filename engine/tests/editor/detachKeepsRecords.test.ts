/** #2001 S8b: a Detach (Unpack Completely) keeps the instance records exact. The records of the instances it unpacks
 *  go — the instance's own and those of the instances the scene added under it — and every other record stays fresh:
 *  an enclosing instance's `own` link still names the unpacked root, which is plain content now under the same guid.
 *  Its undo seats the dropped records back exactly; its redo drops them again.
 *
 *  The fuzzer's fixture (O1, P1, H1 placed), through the real undo manager and store. */
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
import { boot, bridge, memoryStorage, startRun, authored, piOf } from './prefabFuzz/harness';
import { getCurrentWorld } from '@modoki/engine/runtime';
import { serializeScene } from '@modoki/engine/editor';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { detachPrefabInstanceWithUndo } from '../../packages/modoki/src/editor/undo/detachPrefabUndo';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { storedInstance, storedInstances } from '../../packages/modoki/src/runtime/prefab/instanceStore';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const byPrefix = (p: string) => () => authored().find((e) => e.guid?.startsWith(p))!;
const P1 = byPrefix('ffffffff-0000-4000-8002-');
const store = () => new Map([...storedInstances(getCurrentWorld())].map(([g, s]) => [g, structuredClone(s)]));
function inP1(name: string): number {
  const top = P1().id;
  const under = (id: number): boolean => { for (let at = id; at; at = authored().find((e) => e.id === at)?.parentId ?? 0) if (at === top) return true; return false; };
  return authored().find((e) => e.name === name && under(e.id))!.id;
}

describe('#2001 S8b: a Detach keeps the instance records exact', () => {
  it('an instance the scene added under a member: its record goes, the enclosing link stays, undo and redo exact', async () => {
    const f = await startRun(be, async () => {}, 'detach-added');
    const placed = (await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: inP1('A') }))!;
    expect(placed, 'premise: placed').toBeTruthy();
    const qGuid = authored().find((e) => e.id === placed)!.guid!;
    const before = store();
    expect(before.get(qGuid), 'premise: the placed instance has a record').toBeTruthy();
    const p1Before = structuredClone(before.get(P1().guid!)!.record);

    detachPrefabInstanceWithUndo(placed, 'Detach', '[test]');
    expect(piOf(placed), 'premise: unpacked').toBeUndefined();
    expect(storedInstance(getCurrentWorld(), qGuid), 'the unpacked instance\'s record goes').toBeUndefined();
    // The member still links the root, which is plain content now under the same guid.
    expect(storedInstance(getCurrentWorld(), P1().guid!)!.record).toEqual(p1Before);
    const saved = await serializeScene() as { entities: { guid?: string; members?: Record<string, { own?: { guid?: string; prefab?: string }[] }> }[] };
    const node = Object.values(saved.entities.find((e) => e.guid === P1().guid)!.members ?? {}).flatMap((r) => r.own ?? []).find((n) => n.guid === qGuid);
    expect(node, 'the save writes the unpacked root inline where it hangs').toBeTruthy();
    expect(node!.prefab, 'as plain content').toBeUndefined();
    const after = store();

    expect((await undoStep('undo')).did).toBe(true);
    expect(store(), 'the undo seats back the exact records, fresh').toEqual(before);
    expect(piOf(placed)?.rootInstanceId).toBe(placed);

    expect((await undoStep('redo')).did).toBe(true);
    expect(store()).toEqual(after);
  }, 60_000);

  it('an instance with one the scene added inside it: both records go, and come back on undo', async () => {
    const f = await startRun(be, async () => {}, 'detach-outer');
    const placed = (await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: inP1('A') }))!;
    const qGuid = authored().find((e) => e.id === placed)!.guid!;
    const p1Guid = P1().guid!;
    const before = store();

    detachPrefabInstanceWithUndo(P1().id, 'Detach', '[test]');
    expect(storedInstance(getCurrentWorld(), p1Guid)).toBeUndefined();
    expect(storedInstance(getCurrentWorld(), qGuid), 'Unpack Completely: the instance inside is unpacked too').toBeUndefined();
    expect(piOf(placed)).toBeUndefined();
    expect(storedInstances(getCurrentWorld()).size).toBe(before.size - 2);

    expect((await undoStep('undo')).did).toBe(true);
    expect(store()).toEqual(before);
    expect((await undoStep('redo')).did).toBe(true);
    expect(storedInstance(getCurrentWorld(), p1Guid)).toBeUndefined();
  }, 60_000);
});
