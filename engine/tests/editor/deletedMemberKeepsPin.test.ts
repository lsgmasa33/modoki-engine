/** #2001 S6: a deleted member keeps its identity pin in the instance's record, so the saved row states it and a Revert of
 *  the removal brings the member back under the guid it had (design § 10.4: a pin is never derived away while its member
 *  is gone).
 *
 *  While a member is live the save states its pin from the live tree, so the record need not hold it. Once it is deleted
 *  the record is the pin's only home. A DUPLICATED instance is the case that shows it: its members carry minted guids,
 *  which no reload can derive again.
 *
 *  Two routes: an instance placed this session, and a duplicate (its members carry minted guids, which no reload derives
 *  again; that case goes on through the reload and a Revert of the removal).
 *
 *  Mutation (measured): in `serializeInstanceRecord.ts` write a row's pin from the live identity alone (`r?.guid ??
 *  id?.guid` → `id?.guid`) — both cases red: a deleted member is not live, so its row loses the guid.
 *  ⚠️ NOT the mutation: the delete's own copy of the pin onto the row (`instanceEdits.ts`, the `item.pins` loop). Removed,
 *  both cases stay green (measured): in both routes the record already holds the pin. That loop is kept for a record
 *  that holds none, which no route here reaches. */
import { describe, it, expect, vi } from 'vitest';
import { getAllEntities } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, type Fixture } from './prefabFuzz/harness';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { deleteEntitiesWithUndo, duplicateEntity } from '../../packages/modoki/src/editor/undo/entityActions';
import { revertOverridesWithUndo } from '../../packages/modoki/src/editor/undo/revertPrefabUndo';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { instantiatePrefabInstance } from '../../packages/modoki/src/editor/scene/prefabInstantiate';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const p1 = (f: Fixture): number => getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === x.id; })!.id;
const memberB = (root: number) => getAllEntities().find((x) => x.name === 'B' && piOf(x.id)?.rootInstanceId === root);
type Row = { guid?: string; name?: string; removed?: boolean };
const rowsOf = (f: Fixture, guid: string) => (JSON.parse(be.read(f.scenePath)!) as { entities: Array<{ guid?: string; members?: Record<string, Row> }> })
  .entities.find((e) => e.guid === guid)!.members ?? {};

describe('#2001 S6: a deleted member keeps its pin', () => {
  it('an instance placed this session: the removed row states the member\'s pin', async () => {
    const f = await startRun(be, async () => {}, 'deleted-member-pin-fresh');
    const placed = await instantiatePrefabInstance(JSON.parse(be.read(f.prefabs.P.path)!), f.prefabs.P.path, 0);
    expect(placed).toBeTruthy();
    await settle();
    const root = getAllEntities().filter((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === x.id; }).find((x) => x.id !== p1(f))!;
    const b = memberB(root.id)!;
    const bGuid = b.guid!;
    const bKey = `/${piOf(b.id)!.nodeGuid}`;
    deleteEntitiesWithUndo([b.id]);
    await settle();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(rowsOf(f, root.guid!)[bKey]).toEqual({ guid: bGuid, name: 'B', removed: true });
  }, 60_000);

  it('a duplicate (minted member guids): the saved row states the pin, and a Revert of the removal after a reload brings the member back under that guid', async () => {
    const f = await startRun(be, async () => {}, 'deleted-member-pin');
    const copy = duplicateEntity(p1(f), () => {})!;
    await settle();
    const copyGuid = getAllEntities().find((e) => e.id === copy)!.guid!;
    const b = memberB(copy)!;
    const bGuid = b.guid!;
    const bKey = `/${piOf(b.id)!.nodeGuid}`;
    expect(memberB(p1(f))!.guid, 'premise: the copy\'s member carries a guid of its own').not.toBe(bGuid);

    deleteEntitiesWithUndo([b.id]);
    await settle();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(rowsOf(f, copyGuid)[bKey]).toEqual({ guid: bGuid, name: 'B', removed: true });

    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    const root = getAllEntities().find((e) => e.guid === copyGuid)!.id;
    expect(memberB(root), 'premise: B is still deleted after the reload').toBeUndefined();
    const keys = collectInstanceOverrideKeys(root, getCachedPrefabSync(f.prefabs.P.guid)!);
    const removal = new Set(keys.all.filter((k) => k.startsWith('-removed.')));
    expect(removal.size, 'premise: one removal to revert').toBe(1);
    expect(await revertOverridesWithUndo(root, removal)).not.toBeNull();
    await settle();
    expect(memberB(root)?.guid).toBe(bGuid);
  }, 60_000);
});
