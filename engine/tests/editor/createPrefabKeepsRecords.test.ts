/** #2001 S8b: Create Prefab keeps the instance records exact (`beginCreatePrefab`). The document is written from the tree,
 *  so the instance the tree becomes starts with an empty modification list (Unity's `SaveAsPrefabAssetAndConnect`): its
 *  record states its members' identity and links the scene's own nodes, nothing else. The instances the tree held are
 *  rows of the new document, so their records go. The undo seats back the records the create replaced; the redo tags
 *  again through the door.
 *
 *  The fuzzer's fixture: Plain is a plain tree (Plain → Leaf), with an instance of H placed under Leaf; O1, P1 and H1 are
 *  placed instances. Driven
 *  through the real routes: Create Prefab, undo and redo. */
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
import { boot, bridge, memoryStorage, startRun, settle, authored, piOf, flushWatcher } from './prefabFuzz/harness';
import { createPrefabFromEntity, deleteAssetFiles, deletionPathsFor } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { deletedPrefabsShown } from '../../packages/modoki/src/editor/scene/deletedPrefabsMissing';
import { pushAction } from '@modoki/engine/editor';
import { getCurrentWorld, getTraitByName } from '@modoki/engine/runtime';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { createEntityWithUndo, writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { tagCreatedPrefab } from '../../packages/modoki/src/editor/scene/prefabLink';
import { storedInstance, storedInstances } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const byName = (name: string) => authored().find((e) => e.name === name)!;
const P1 = () => authored().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;
const H1 = () => authored().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8003-'))!;
const store = () => new Map([...storedInstances(getCurrentWorld())].map(([g, s]) => [g, structuredClone(s)]));
function inP1(name: string): number {
  const top = P1().id;
  const under = (id: number): boolean => { for (let at = id; at; at = authored().find((e) => e.id === at)?.parentId ?? 0) if (at === top) return true; return false; };
  return authored().find((e) => e.name === name && under(e.id))!.id;
}
async function create(id: number, path: string, replace = false): Promise<void> {
  const r = await createPrefabFromEntity(id, path, 'Save prefab', async () => replace);
  if (!r || r === 'declined' || 'refused' in r) throw new Error(`create: ${r && r !== 'declined' ? r.refused : r}`);
  pushAction(r.action);
  await settle();
}

describe('#2001 S8b: Create Prefab keeps the instance records exact', () => {
  it('a plain tree holding an instance: its record pins its members, the swallowed instance\'s record goes', async () => {
    // An instance of H placed under Leaf, in the plain tree.
    const f = await startRun(be, async (fx) => { await placePrefabFromPath(fx.prefabs.H.path, { tag: 'test', parentId: byName('Leaf').id }); }, 'create-keeps');
    const plain = byName('Plain');
    const hr = authored().filter((e) => e.name === 'HR').find((e) => { for (let at = e.id; at; at = authored().find((x) => x.id === at)?.parentId ?? 0) if (at === plain.id) return true; return false; })!;
    const leafGuid = hr.guid!;
    expect(storedInstance(getCurrentWorld(), leafGuid), 'premise: the H under Leaf is a stored instance').toBeTruthy();
    const before = store();

    await create(plain.id, `${f.root}/prefabs/NewPlain.prefab.json`);
    expect(piOf(plain.id)?.rootInstanceId, 'premise: Plain is an instance now').toBe(plain.id);
    const rec = storedInstance(getCurrentWorld(), plain.guid!)!.record;
    expect(rec.source).toBe(piOf(plain.id)!.source);
    // An empty modification list: identity pins, and nothing else.
    for (const row of rec.list.rows.values()) expect(Object.keys(row).filter((k) => k !== 'guid' && k !== 'name')).toEqual([]);
    expect(rec.list.rows.size).toBeGreaterThan(1);
    expect(storedInstance(getCurrentWorld(), leafGuid), 'the H instance is a row of the new prefab').toBeUndefined();
    const after = store();

    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(store(), 'the undo seats back the exact records, fresh').toEqual(before);

    expect((await undoStep('redo')).did).toBe(true);
    await settle();
    expect(store()).toEqual(after);
  }, 60_000);

  // Dropped on a NESTED frame's member, the prefab's serialize writes it as that row's added node and keys it before the
  // tag, so it no longer reads as a stored root: its record is still one the create replaces and the undo must put back.
  it('an instance holding one the scene dropped on a nested member: the undo puts both records back', async () => {
    const f = await startRun(be, async () => {}, 'create-instance');
    const placed = (await placePrefabFromPath(f.prefabs.H.path, { tag: 'test', parentId: inP1('M') }))!;
    const qGuid = authored().find((e) => e.id === placed)!.guid!;
    await settle();
    expect(storedInstance(getCurrentWorld(), qGuid), 'premise: the dropped instance has a record').toBeTruthy();
    const before = store();

    await create(P1().id, `${f.root}/prefabs/P1.prefab.json`);
    expect([...storedInstances(getCurrentWorld()).keys()], 'the dropped instance is a node of the new prefab').not.toContain(qGuid);

    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(store()).toEqual(before);
  }, 60_000);

  // A tag that lands nothing (the document no longer plans to the tree) leaves the instance as it was: its record is not
  // rebuilt as the new prefab's, which would state only identity and drop the instance's own overrides.
  it('a tag that lands nothing leaves the instance\'s record as it was', async () => {
    await startRun(be, async () => {}, 'create-unlanded');
    expect(writeTraitFieldWithUndo(inP1('A'), getTraitByName('Transform')!, 'x', 5)).toBeNull();
    const before = structuredClone(storedInstance(getCurrentWorld(), P1().guid!)!.record);
    const mismatched = { id: 'cccccccc-0000-4000-8000-00000000f2a1', version: 8, name: 'X', rootLocalId: 1, entities: [] } as never;
    tagCreatedPrefab(P1().id, 'prefabs/X.prefab.json', mismatched);
    // Exactly as it was — never a record that lost the override.
    expect(storedInstance(getCurrentWorld(), P1().guid!)!.record).toEqual(before);
  }, 60_000);

  it('a plain node under a member: the enclosing record still links it, and the new instance has a record', async () => {
    const f = await startRun(be, async () => {}, 'create-in-member');
    const a = inP1('A');
    const made = createEntityWithUndo('Create U', a, [{ name: 'EntityAttributes', data: { name: 'U', parentId: a } }, { name: 'Transform', data: {} }], () => {})!;
    const uGuid = authored().find((e) => e.id === made)!.guid!;
    const p1Before = structuredClone(storedInstance(getCurrentWorld(), P1().guid!)!.record);
    const before = store();

    await create(made, `${f.root}/prefabs/U.prefab.json`);
    expect(storedInstance(getCurrentWorld(), P1().guid!)!.record, 'the member still links U').toEqual(p1Before);
    expect(storedInstance(getCurrentWorld(), uGuid)?.record.placement.parent, 'placed by its link').toBe('');

    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(store()).toEqual(before);
  }, 60_000);
});

// A Replace's undo restores the replaced document in memory (#1868) and unlinks the tree: the records the Replace's tag
// replaced are seated back exactly, as a create's undo seats them, before the park's rebase reads the store. They used to
// be left stale by the untag and relink, and re-seeded from the capture at the next write (hunt seeds 9302, 9314, 9329,
// 9333). Mutation: drop the Replace undo's seat → red at 'fresh after the undo'.
describe('#2001 S8b: a Replace\'s undo keeps the records exact', () => {
  it('Create Prefab of P1 over H\'s file, undone: every record back exactly, fresh', async () => {
    const f = await startRun(be, async () => {}, 'create-replace');
    expect(writeTraitFieldWithUndo(inP1('A'), getTraitByName('Transform')!, 'y', 4)).toBeNull();
    const before = store();

    await create(P1().id, f.prefabs.H.path, true);
    expect(piOf(P1().id)?.source, 'premise: P1 is an instance of the replaced file').toBe(f.prefabs.H.guid);

    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(store(), 'the undo seats back the exact records').toEqual(before);
  }, 60_000);
});

// An instance placed under a Missing Prefab placeholder (H trashed): the placeholder's record links it (§ 10.4b), and the
// tag and its undo mark the records of every stored root above the tree, the placeholder's included. Create Prefab takes
// that record with the tree's, so the undo seats it back, fresh (hunt seed 9344: it stayed stale, and the next write
// re-seeded H1 from its capture). Mutation: take no record above the tree in `takeRecordsAround` → red at 'fresh after
// the undo'.
describe('#2001 S8b: Create Prefab under a Missing Prefab placeholder keeps the placeholder\'s record', () => {
  it('an O placed under H1, H trashed, then Create Prefab of the O and undo: H1\'s record back exactly, fresh', async () => {
    const f = await startRun(be, async (fx) => { await placePrefabFromPath(fx.prefabs.O.path, { tag: 'test', parentId: H1().id }); }, 'create-under-missing');
    const h1 = H1().guid!;
    const o = authored().filter((e) => piOf(e.id)?.rootInstanceId === e.id).find((e) => e.parentId === H1().id)!;
    const files = be.snapshot();
    expect((await deleteAssetFiles(deletionPathsFor(f.prefabs.H.path, 'prefab', null))).ok).toBe(true);
    unbindDeletedAssetEditors([f.prefabs.H.path]);
    await deletedPrefabsShown();
    await flushWatcher(be, files);
    await settle();
    expect(storedInstance(getCurrentWorld(), h1), 'premise: H1 holds a record').toBeTruthy();
    expect(storedInstance(getCurrentWorld(), o.guid!), 'premise: the O under it holds one').toBeTruthy();
    const before = store();

    await create(o.id, `${f.root}/prefabs/NewO.prefab.json`);
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(store(), 'the undo seats back the exact records').toEqual(before);
  }, 60_000);
});
