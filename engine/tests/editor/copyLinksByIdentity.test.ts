/** A copy keeps a node's prefab link only while the frame the node is a ROW of is in the copy (#1756, I6).
 *
 *  Duplicate and paste used to decide link-or-strip ONCE, from the snapshot root, and apply that verdict to every node.
 *  A member moved (#1437) into a plain group was then copied still linked to the instance outside the copy: two live
 *  entities claimed one template row, the save wrote the copy's row, and the ORIGINAL member was lost on reload with its
 *  guid and its value. Now each node asks the identity resolver which frame it is a row of (`frameOf`):
 *  - that frame is in the copy → the link stays, and the guid derives through it;
 *  - an OWNED nested root whose owner is not → an independent instance (#1354's ruling, at any depth);
 *  - a member whose frame is not → a plain added node with a fresh guid.
 *  Driven through the real loader, `reparentEntity`, `duplicateEntity`, `serializeScene` and the device op. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async () => ({ ok: true, json: async () => ({}), text: async () => '' } as Response),
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import {
  setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, duplicateEntity,
} from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000001756';
const Q = 'cccccccc-0000-4000-8000-000000001757';
const PQ = 'cccccccc-0000-4000-8000-000000001755';
const HOLDER = 'dddddddd-0000-4000-8000-000000001750';
const INST = 'dddddddd-0000-4000-8000-000000001756';
const gR = 'eeeeeeee-0000-4000-8000-000000001751';
const gA = 'eeeeeeee-0000-4000-8000-000000001752';
const gQR = 'eeeeeeee-0000-4000-8000-000000001753';
const gQX = 'eeeeeeee-0000-4000-8000-000000001754';
const gQrow = 'eeeeeeee-0000-4000-8000-000000001755';

const row = (localId: number, name: string, parentId: number, nodeGuid: string) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** Q = QR → QX. */
const qDoc = () => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0, gQR), row(2, 'QX', 1, gQX)] });
/** PQ = R → A, and A → Qrow expanding Q: a nested instance held by a member. */
const pqDoc = () => ({ id: PQ, version: 5, name: 'PQ', rootLocalId: 1, entities: [
  row(1, 'R', 0, gR), row(2, 'A', 1, gA),
  { localId: 3, name: 'Qrow', nodeGuid: gQrow, prefab: Q, traits: { EntityAttributes: { name: 'Qrow', parentId: 2, guid: '' } } },
] });
const install = (...docs: Array<{ id?: string; [k: string]: unknown }>) => { for (const d of docs) { prefabs.set(d.id!, d); setPrefabCache(d.id!, d as never); } };

async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    onDeletePlaceholder: (id: number) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure) => {
      const id = instantiatePrefabIntoWorld(
        getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure,
      );
      if (id && rootGuid) {
        for (const e of getCurrentWorld().entities) {
          if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), guid: rootGuid });
        }
      }
      return id ?? undefined;
    },
  });
}

const meta = (t: string) => getTraitByName(t)!;
const idOf = (guid: string) => getAllEntities().find((e) => e.guid === guid)?.id;
const named = (name: string) => getAllEntities().filter((e) => e.name === name);
const x = (id: number) => (readTraitData(id, meta('Transform')) as { x: number }).x;
const pi = (id: number) => readTraitData(id, meta('PrefabInstance')) as { rootInstanceId?: number; parentLocalId?: number } | null;
const save = async () => JSON.parse(JSON.stringify(await serializeScene())) as SceneData;
/** Every guid two live entities share. */
const sharedGuids = () => {
  const seen = new Map<string, number>();
  for (const e of getAllEntities()) if (e.guid) seen.set(e.guid, (seen.get(e.guid) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([g]) => g);
};
/** Every `rootInstanceId` and every owner link (`ownerGuid`) a copy holds names an entity INSIDE the copy. One that names the source's frame is the id of
 *  another world's entity once the clipboard is pasted into a new world (#1756's READ-ONLY cross-world finding, from the
 *  #1722 review), which then names whatever holds that id there. */
const linksStayInside = (copyRoot: number): boolean => {
  const all = getAllEntities();
  const inCopy = new Set<number>([copyRoot]);
  for (let grew = true; grew;) { grew = false; for (const e of all) if (inCopy.has(e.parentId) && !inCopy.has(e.id)) { inCopy.add(e.id); grew = true; } }
  const guids = new Set(all.filter((e) => inCopy.has(e.id)).map((e) => e.guid));
  return [...inCopy].every((id) => {
    const p = pi(id) as { rootInstanceId?: number; ownerGuid?: string } | null;
    return (p?.rootInstanceId === undefined || inCopy.has(p.rootInstanceId)) && (!p?.ownerGuid || guids.has(p.ownerGuid));
  });
};
const scene = (prefab: string, extra: unknown[] = []): SceneData => ({
  id: 's1756', version: 16, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
    { id: 2, prefab, guid: INST, traits: { EntityAttributes: { name: 'Inst', parentId: HOLDER } } },
    ...extra,
  ],
} as unknown as SceneData);

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
});
afterAll(() => { for (const id of [P, Q, PQ]) setPrefabCache(id, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

describe('a copied member that holds a nested instance keeps that instance linked (#1756, Unity parity)', () => {
  it('the nested instance round-trips as an independent instance, its edits with it', async () => {
    install(qDoc(), pqDoc());
    await load(scene(PQ));
    const a = named('A')[0]!.id;
    writeTraitFieldWithUndo(named('QX')[0]!.id, meta('Transform'), 'x', 3);

    const copy = duplicateEntity(a, () => {})!;
    expect(pi(copy)).toBeNull(); // the member itself becomes an added node, as before
    const qCopy = getAllEntities().find((e) => e.parentId === copy && e.name === 'QR')!;
    // Promoted, not flattened: its own root, no row stamp, and its members linked to it.
    expect(pi(qCopy.id)).toMatchObject({ rootInstanceId: qCopy.id, parentLocalId: 0 });
    const qxCopy = getAllEntities().find((e) => e.parentId === qCopy.id && e.name === 'QX')!;
    expect(pi(qxCopy.id)?.rootInstanceId).toBe(qCopy.id);
    expect(sharedGuids()).toEqual([]);
    expect(linksStayInside(copy)).toBe(true);
    const qxGuid = qxCopy.guid;

    await load(await save());
    const reQ = getAllEntities().filter((e) => e.name === 'QR');
    expect(reQ).toHaveLength(2);
    for (const q of reQ) expect(pi(q.id)?.rootInstanceId).toBe(q.id);
    // The copy's member reloads with the guid the copy gave it, and the edit it copied.
    const reQx = getAllEntities().find((e) => e.guid === qxGuid);
    expect(reQx?.name).toBe('QX');
    expect(x(reQx!.id)).toBe(3);
  });
});

// ── The accept side of `ownerConfirmed` (#1756 close-out re-review) ──────────────────────────────────────────────
// A root whose owner IS in the copy must stay linked, or a duplicate of a whole instance turns its nested rows into
// independent instances and the save writes added reference nodes instead of the rows' expansions. Mutations: promote
// every root with an owner link (`if (pi.ownerGuid) return false`) — the first block goes red; promote a root that hangs
// under a root other than its owner — the second block goes red.
const piFull = (id: number) => readTraitData(id, meta('PrefabInstance')) as { rootInstanceId?: number; parentLocalId?: number; ownerGuid?: string; source?: string } | null;
const guidOfId = (id: number) => getAllEntities().find((e) => e.id === id)!.guid;
const underRoot = (id: number, root: number) => { for (let c = getAllEntities().find((e) => e.id === id); c; c = getAllEntities().find((e) => e.id === c!.parentId)) if (c.id === root) return true; return false; };

describe('a whole copy of O keeps a nested row under a nested row linked: owner the outer frame, hung under the inner root (#1756 close-out)', () => {
  const O7 = 'aaaaaaaa-0000-4000-8000-0000000007b1';
  const Q7 = 'aaaaaaaa-0000-4000-8000-0000000007b2';
  const Z7 = 'aaaaaaaa-0000-4000-8000-0000000007b3';
  const OROOT = 'bbbbbbbb-0000-4000-8000-0000000000c2';
  let n = 0;
  const ng = () => `dddddddd-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const r = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
    localId, nodeGuid: ng(), ...extra, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
  });
  // (It also ran with Z moved out of its row first; a nested prefab's root no longer moves, #1869.)
  it('a copy of O keeps the nested row under a nested row linked, and both reload', async () => {
    n = 0;
    install(
      { id: Q7, version: 5, rootLocalId: 1, entities: [r(1, 'QRoot', 0), r(2, 'QA', 1), r(3, 'QB', 2)] },
      { id: Z7, version: 5, rootLocalId: 1, entities: [r(1, 'ZRoot', 0), r(2, 'ZLeaf', 1)] },
      { id: O7, version: 5, rootLocalId: 1, entities: [r(1, 'ORoot', 0), r(2, 'QRow', 1, { prefab: Q7 }), r(3, 'ZRow', 2, { prefab: Z7 }), r(4, 'Plain', 2)] },
    );
    await load({ id: 'n7', version: 16, name: 'N7', resources: [], entities: [
      { id: 1, prefab: O7, guid: OROOT, traits: { EntityAttributes: { name: 'ORoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    ] } as unknown as SceneData);
    const z = named('ZRoot')[0]!.id;
    const zGuid = guidOfId(z);
    writeTraitFieldWithUndo(named('ZLeaf')[0]!.id, meta('Transform'), 'x', 9);

    const copy = duplicateEntity(idOf(OROOT)!, () => {})!;
    const zCopy = named('ZRoot').find((e) => e.id !== z)!;
    expect(underRoot(zCopy.id, copy)).toBe(true);
    expect(piFull(zCopy.id)).toMatchObject({ rootInstanceId: zCopy.id, parentLocalId: 3 });
    expect(linksStayInside(copy)).toBe(true);
    expect(sharedGuids()).toEqual([]);
    const copyGuids = getAllEntities().filter((e) => e.name === 'ZRoot' || e.name === 'ZLeaf').map((e) => e.guid).sort();

    await load(await save());
    expect(named('ZRoot')).toHaveLength(2);
    for (const q of named('ZRoot')) expect(piFull(q.id)?.parentLocalId).toBe(3);
    expect(getAllEntities().find((e) => e.guid === zGuid)?.name).toBe('ZRoot');
    for (const l of named('ZLeaf')) expect(x(l.id)).toBe(9);
    expect(getAllEntities().filter((e) => e.name === 'ZRoot' || e.name === 'ZLeaf').map((e) => e.guid).sort()).toEqual(copyGuids);
  });
});

