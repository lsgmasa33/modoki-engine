/** #2001 S8b: a copy of PART of an instance keeps the instance records. A nested frame the copy carries becomes an
 *  instance of its own (#1756's link rules), and its record states what every layer OUTSIDE the frame stated
 *  (`promotedRecord`): the copy shows what the frame showed, from records, with nothing re-derived from a capture.
 *
 *  The fuzzer's fixture: O1 is an instance of O, whose row N expands P, whose row C expands Q (QR → M). The layers
 *  outside C give M three fields: x = 4 (P's row C), and z = 7, y = 8 (O's row N, through two carriers). Through the real
 *  undo manager, store and scene save. */
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
import { serializeScene } from '@modoki/engine/editor';
import { readTraitData } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { duplicateEntity, createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { storedInstance, setInstanceRecord } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { instanceKeyMap } from '../../packages/modoki/src/editor/instance/instanceKeys';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const O1 = () => authored().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8001-'))!;
const under = (id: number, top: number): boolean => {
  for (let a = id; a; a = authored().find((e) => e.id === a)?.parentId ?? 0) if (a === top) return true;
  return false;
};
const inO1 = (name: string) => authored().filter((e) => e.name === name && under(e.id, O1().id));
const xyz = (id: number) => {
  const t = readTraitData(id, getTraitByName('Transform')!) as { x: number; y: number; z: number };
  return [t.x, t.y, t.z];
};

describe('#2001 S8b: a copy of a nested frame keeps the records', () => {
  it('the copy is an instance of its own prefab whose list states what the layers outside it gave it', async () => {
    const f = await startRun(be, async () => {}, 'promoted-copy');
    const c = inO1('QR'); // row C's frame root, named by Q's root
    expect(c, 'premise: one QR in O1').toHaveLength(1);
    const m = inO1('M').find((e) => under(e.id, c[0]!.id))!;
    expect(xyz(m.id), 'premise: the layers outside C give M x 4, y 8, z 7').toEqual([4, 8, 7]);
    // The user's node under M: plain content of the copy, linked from M's row.
    const user = createEntityWithUndo('Add U', m.id, [{ name: 'EntityAttributes', data: { name: 'U', parentId: m.id } }, { name: 'Transform', data: {} }], () => {})!;
    expect(user).toBeTruthy();

    const copy = duplicateEntity(c[0]!.id, () => {});
    expect(copy).toBeTruthy();
    const copyGuid = authored().find((e) => e.id === copy)!.guid!;
    const stored = storedInstance(getCurrentWorld(), copyGuid);
    expect(stored!.record.source).toBe(f.prefabs.Q.guid);
    const rows = [...stored!.record.list.rows];
    expect(rows).toHaveLength(1);
    expect(rows[0]![1].traits).toEqual({ Transform: { x: 4, z: 7, y: 8 } });
    const copyU = authored().find((e) => e.name === 'U' && under(e.id, copy!))!;
    expect(copyU.guid, 'the user node was copied with a fresh guid').not.toBe(authored().find((e) => e.id === user)!.guid);
    expect(rows[0]![1].own).toEqual([{ guid: copyU.guid }]);
    const copyM = authored().find((e) => e.name === 'M' && under(e.id, copy!))!;
    expect(xyz(copyM.id)).toEqual([4, 8, 7]);

    // The save writes the copy inline under N, with its own list.
    const saved = await serializeScene() as { entities: { guid?: string; members?: Record<string, { own?: { guid?: string; prefab?: string; members?: Record<string, { traits?: unknown }> }[] }> }[] };
    const o1 = saved.entities.find((e) => e.guid === O1().guid)!;
    const node = Object.values(o1.members ?? {}).flatMap((r) => r.own ?? []).find((n) => n.guid === copyGuid);
    expect(node?.prefab).toBe(f.prefabs.Q.guid);
    expect(Object.values(node!.members ?? {}).map((r) => r.traits)).toContainEqual({ Transform: { x: 4, z: 7, y: 8 } });

    expect((await undoStep('undo')).did).toBe(true);
    expect(storedInstance(getCurrentWorld(), copyGuid), 'the copy\'s record goes with it').toBeUndefined();
    expect((await undoStep('redo')).did).toBe(true);
    expect(storedInstance(getCurrentWorld(), copyGuid)?.record.list.rows.size).toBe(1);
  }, 60_000);
  // A removal of a component the template no longer has is a part of the list the fold does not use (R2 keeps it). It
  // names no node, so the copy carries it as the source states it, on records.
  it('an instance whose list keeps a removal the template no longer has: the copy is on records and keeps it', async () => {
    await startRun(be, async () => {}, 'copy-unused-removal');
    const src = storedInstance(getCurrentWorld(), O1().guid!)!.record;
    const rec = structuredClone(src);
    const root = rec.list.rows.get('/') ?? {};
    rec.list.rows.set('/', { ...root, traitRemovals: { ...(root as { traitRemovals?: Record<string, true> }).traitRemovals, Gone: true } } as never);
    setInstanceRecord(getCurrentWorld(), rec);

    const copy = duplicateEntity(O1().id, () => {})!;
    const copyGuid = authored().find((e) => e.id === copy)!.guid!;
    const stored = storedInstance(getCurrentWorld(), copyGuid);
    expect((stored!.record.list.rows.get('/') as { traitRemovals?: Record<string, unknown> }).traitRemovals?.Gone, 'with the removal').toBe(true);
    expect((await undoStep('undo')).did).toBe(true);
  }, 60_000);
  // A removal of a component the template no longer has, on a member inside the copied frame (R2 keeps it): the copy is on
  // records and keeps it as its own, under the frame's key (#1788's rule, on records).
  it('a copy of a frame whose member keeps a removal the template no longer has carries it on records', async () => {
    await startRun(be, async () => {}, 'promoted-unused');
    const c = inO1('QR')[0]!;
    const m = inO1('M').find((e) => under(e.id, c.id))!;
    const keys = instanceKeyMap(O1().id);
    const mKey = keys.get(m.id)!, cKey = keys.get(c.id)!;
    const rec = structuredClone(storedInstance(getCurrentWorld(), O1().guid!)!.record);
    const row = rec.list.rows.get(mKey) ?? {};
    rec.list.rows.set(mKey, { ...row, traitRemovals: { Gone: true } } as never);
    setInstanceRecord(getCurrentWorld(), rec);

    const copy = duplicateEntity(c.id, () => {})!;
    const copyGuid = authored().find((e) => e.id === copy)!.guid!;
    const stored = storedInstance(getCurrentWorld(), copyGuid);
    const relKey = mKey.slice(cKey.length);
    expect((stored!.record.list.rows.get(relKey as never) as { traitRemovals?: Record<string, unknown> } | undefined)?.traitRemovals?.Gone, 'with the removal, under the frame\'s key').toBe(true);
  }, 60_000);
});
