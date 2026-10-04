/** #2144 seed 8043 — P's template places its own member B under M, a member of its nested Q frame (QR). In O1's N (a P
 *  frame nested in O), deleting QR took B with it on the live tree, but the record only marked QR's row removed. The
 *  fold's lift rule (a failed move lifts to the nearest surviving ancestor) then built B again under N's root: the record
 *  disagreed with the screen, and a save + reload brought B back. The delete now marks B removed in its own right.
 *
 *  Driven through the prefab fuzzer's harness, on its fixture. Mutation: drop the loop in `beginDeleteImpl` that marks
 *  the lifted members removed — B's row stays unmarked and B is back after the reload. */

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
import { boot, bridge, memoryStorage, startRun, settle, authored, piOf } from './prefabFuzz/harness';
import { planReparent, applyReparent, deleteEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { getCurrentWorld } from '@modoki/engine/runtime';
import { storedRecord } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { whyWorldNotAuthored } from '../../packages/modoki/src/editor/scene/authoredWorld';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

describe('#2144 8043: deleting a nested frame removes a member its enclosing prefab placed under it', () => {
  it('B goes on the live tree, in O1\'s record, and after a save + reload', async () => {
    const f = await startRun(be, async () => {}, 'delete-lifted-member');
    const tag = f.prefabs.P.guid.slice(-12);
    const gN = `eeeeeeee-0000-4000-8008-${tag}`;
    const gB = `eeeeeeee-0000-4000-8005-${tag}`;
    const o1Guid = `ffffffff-0000-4000-8001-${tag}`;

    // In P's edit: B (P's own member) moves under M (a member of P's nested Q frame, QR).
    expect(await openPrefabForEditing({ path: f.prefabs.P.path, name: 'P' }, { confirmDiscard: async () => true })).toBeFalsy();
    const bEdit = authored().find((e) => e.name === 'B')!;
    const mEdit = authored().find((e) => e.name === 'M')!;
    expect(planReparent(bEdit.id, mEdit.id).kind, 'premise: the move is allowed in the prefab\'s own edit').not.toBe('refused');
    expect(applyReparent(bEdit.id, mEdit.id).ok).toBe(true);
    expect((await savePrefabEditReport({})).saved).toBe(true);
    await exitPrefabEditing();
    await settle();

    // O1's N: P's frame nested in O. Its B now hangs under QR > M.
    const nRoot = () => authored().find((e) => piOf(e.id)?.rootInstanceId === e.id && piOf(e.id)?.source === f.prefabs.P.guid
      && !e.guid?.startsWith('ffffffff-0000-4000-8002-'));
    const inN = (name: string) => authored().filter((e) => e.name === name).find((e) => {
      for (let a: number | undefined = e.id; a; a = authored().find((x) => x.id === a)?.parentId || undefined) if (a === nRoot()?.id) return true;
      return false;
    });
    expect(nRoot(), 'premise: O1 holds the P frame N').toBeTruthy();
    const qr = inN('QR')!;
    const b = inN('B')!;
    expect(b, 'premise: N shows B').toBeTruthy();
    expect(authored().find((e) => e.id === b.parentId)?.name, 'premise: B hangs under M').toBe('M');

    deleteEntitiesWithUndo([qr.id]);
    await settle();
    expect(inN('QR')).toBeUndefined();
    expect(inN('B'), 'B went with QR on the live tree').toBeUndefined();
    const row = storedRecord(getCurrentWorld(), o1Guid)!.list.rows.get(`/${gN}/${gB}`);
    expect(row?.removed, 'O1\'s record marks B removed in its own right').toBe(true);
    expect(whyWorldNotAuthored()).toBeNull();

    const saved = await saveScene({ allowDialog: false });
    expect(saved.saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(inN('QR')).toBeUndefined();
    expect(inN('B'), 'the reload does not bring B back').toBeUndefined();
  }, 120_000);
});
