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
  setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, reparentEntity, duplicateEntity, undo, redo,
} from '@modoki/engine/editor';
import { createEntityWithUndo, snapshotEntity, copySnapshot, respawnFromSnapshot } from '../../packages/modoki/src/editor/undo/entityActions';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefab';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { duplicateEntityLive } from '../../app/debug/liveLifecycle';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000001756';
const Q = 'cccccccc-0000-4000-8000-000000001757';
const PQ = 'cccccccc-0000-4000-8000-000000001755';
const HOLDER = 'dddddddd-0000-4000-8000-000000001750';
const INST = 'dddddddd-0000-4000-8000-000000001756';
const QINST = 'dddddddd-0000-4000-8000-000000001757';
const gR = 'eeeeeeee-0000-4000-8000-000000001751';
const gA = 'eeeeeeee-0000-4000-8000-000000001752';
const gQR = 'eeeeeeee-0000-4000-8000-000000001753';
const gQX = 'eeeeeeee-0000-4000-8000-000000001754';
const gQrow = 'eeeeeeee-0000-4000-8000-000000001755';

const row = (localId: number, name: string, parentId: number, nodeGuid: string) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** P = R → A. */
const pDoc = () => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [row(1, 'R', 0, gR), row(2, 'A', 1, gA)] });
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
/** A plain group `name` under `parent`, returned by id. */
const group = (name: string, parent: number): number =>
  createEntityWithUndo('Create', parent, [{ name: 'EntityAttributes', data: { name, parentId: parent } }, { name: 'Transform', data: {} }], () => {})!;

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
});
afterAll(() => { for (const id of [P, Q, PQ]) setPrefabCache(id, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

describe('a member moved into a copied group is copied as a plain node (#1756)', () => {
  it('the original keeps its row, its guid and its value through save + reload', async () => {
    install(pDoc());
    await load(scene(P));
    const a = named('A')[0]!.id;
    writeTraitFieldWithUndo(a, meta('Transform'), 'x', 5);
    const n = group('N', idOf(INST)!);
    expect(reparentEntity(a, n)).toBe(true);
    const aGuid = getAllEntities().find((e) => e.id === a)!.guid;

    const copy = duplicateEntity(n, () => {})!;
    const copiedA = getAllEntities().find((e) => e.parentId === copy && e.name === 'A')!;
    // The copy is not a second claimant of row A: it is a plain added node with a guid of its own.
    expect(pi(copiedA.id)).toBeNull();
    expect(copiedA.guid).not.toBe(aGuid);
    expect(sharedGuids()).toEqual([]);
    expect(linksStayInside(copy)).toBe(true);

    await load(await save());
    const as = named('A');
    expect(as).toHaveLength(2);
    const original = as.find((e) => e.guid === aGuid);
    expect(original).toBeDefined();
    expect(x(original!.id)).toBe(5);
    expect(pi(original!.id)?.rootInstanceId).toBe(idOf(INST));
    expect(pi(as.find((e) => e !== original)!.id)).toBeNull();
  });

  it('a member moved under a copied user-added instance gets no guid of that instance\'s frame', async () => {
    install(pDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: HOLDER } } }]));
    const a = named('A')[0]!.id;
    const n = group('N', idOf(INST)!);
    expect(reparentEntity(idOf(QINST)!, n)).toBe(true);
    expect(reparentEntity(a, idOf(QINST)!)).toBe(true);
    const aGuid = getAllEntities().find((e) => e.id === a)!.guid;

    const copy = duplicateEntity(n, () => {})!;
    // A's own-frame step equals QX's step in Q: derived from the copied QInst's anchor they took ONE guid.
    expect(sharedGuids()).toEqual([]);
    const qCopy = getAllEntities().find((e) => e.parentId === copy && pi(e.id)?.rootInstanceId === e.id)!;
    expect(pi(qCopy.id)?.rootInstanceId).toBe(qCopy.id); // the copied nested instance is still an instance
    const copiedA = getAllEntities().find((e) => e.parentId === qCopy.id && e.name === 'A')!;
    expect(pi(copiedA.id)).toBeNull();
    expect(linksStayInside(copy)).toBe(true);

    await load(await save());
    expect(sharedGuids()).toEqual([]);
    expect(getAllEntities().find((e) => e.guid === aGuid)?.name).toBe('A');
    expect(named('A')).toHaveLength(2);
    expect(named('QX')).toHaveLength(2);
  });
});

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

describe('every copy entry point takes the same per-node links (#1756)', () => {
  it('paste (`copySnapshot` + respawn) of the group strips the moved member', async () => {
    install(pDoc());
    await load(scene(P));
    const a = named('A')[0]!.id;
    const n = group('N', idOf(INST)!);
    reparentEntity(a, n);
    const copy = respawnFromSnapshot(copySnapshot(snapshotEntity(n)!), 0);
    const copiedA = getAllEntities().find((e) => e.parentId === copy && e.name === 'A')!;
    expect(pi(copiedA.id)).toBeNull();
    expect(sharedGuids()).toEqual([]);
  });

  it('the device duplicate-entity op strips the moved member', async () => {
    install(pDoc());
    await load(scene(P));
    const a = named('A')[0]!.id;
    const n = group('N', idOf(INST)!);
    reparentEntity(a, n);
    const nGuid = getAllEntities().find((e) => e.id === n)!.guid;
    const r = duplicateEntityLive(nGuid ? { guid: nGuid } : { id: n }) as { ok: boolean; roots: Array<{ id: number }> };
    expect(r.ok).toBe(true);
    const copiedA = getAllEntities().find((e) => e.parentId === r.roots[0]!.id && e.name === 'A')!;
    expect(pi(copiedA.id)).toBeNull();
    expect(sharedGuids()).toEqual([]);
  });

  it('undo and redo of the duplicate replay the same links', async () => {
    install(pDoc());
    await load(scene(P));
    const a = named('A')[0]!.id;
    const n = group('N', idOf(INST)!);
    reparentEntity(a, n);
    duplicateEntity(n, () => {});
    await undo();
    expect(named('A')).toHaveLength(1);
    await redo();
    const as = named('A');
    expect(as).toHaveLength(2);
    expect(as.filter((e) => pi(e.id))).toHaveLength(1);
  });
});

/** O = ORoot → QRow (nests Q) → ZRow (nests Z, a row of O hung under Q's root: a nested row under a nested row, #1484).
 *  Copying Q's root copies Z's root, whose row is O's — O is not in the copy. The snapshot's resolver cannot see O: with
 *  an owner LINK it ignores the link, and without one it guesses the frame Z hangs in. Kept linked on that guess, the copy
 *  of Z was a second claimant of O's row: the save wrote O's member row with the COPY's guid and parent, and the original
 *  Z was gone after the reload, its guid and its members' with it (#1756 close-out review). Z's copy must be promoted.
 *  Mutation: drop the document confirmation, or the owner-link check, in `planCopyGuids`' `ownerConfirmed`. */
describe('a copied owned root whose owner is outside the copy is promoted, not kept on a guess (#1756 close-out)', () => {
  const O7 = 'aaaaaaaa-0000-4000-8000-0000000007b1';
  const Q7 = 'aaaaaaaa-0000-4000-8000-0000000007b2';
  const Z7 = 'aaaaaaaa-0000-4000-8000-0000000007b3';
  const OROOT = 'bbbbbbbb-0000-4000-8000-0000000000c2';
  let n = 0;
  const ng = () => `dddddddd-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const r = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
    localId, nodeGuid: ng(), ...extra, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
  });
  const setup = async () => {
    n = 0;
    install(
      { id: Q7, version: 5, rootLocalId: 1, entities: [r(1, 'QRoot', 0), r(2, 'QA', 1), r(3, 'QB', 2)] },
      { id: Z7, version: 5, rootLocalId: 1, entities: [r(1, 'ZRoot', 0), r(2, 'ZLeaf', 1)] },
      { id: O7, version: 5, rootLocalId: 1, entities: [r(1, 'ORoot', 0), r(2, 'QRow', 1, { prefab: Q7 }), r(3, 'ZRow', 2, { prefab: Z7 }), r(4, 'Plain', 2)] },
    );
    await load({ id: 'n7', version: 16, name: 'N7', resources: [], entities: [
      { id: 1, prefab: O7, guid: OROOT, traits: { EntityAttributes: { name: 'ORoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    ] } as unknown as SceneData);
  };

  it.each([
    ['where the template puts it (no owner link)', 'none'],
    ['moved out and back (its owner link names O)', 'back'],
    ['moved under a member of Q (its owner link names O)', 'underQA'],
  ])('Z %s: the original keeps its row, guid and edit through save + reload', async (_label, move) => {
    await setup();
    const z = named('ZRoot')[0]!.id;
    const zGuid = getAllEntities().find((e) => e.id === z)!.guid;
    const leafGuid = named('ZLeaf')[0]!.guid;
    writeTraitFieldWithUndo(named('ZLeaf')[0]!.id, meta('Transform'), 'x', 9);
    if (move === 'back') {
      expect(reparentEntity(z, named('ORoot')[0]!.id)).toBe(true);
      expect(reparentEntity(z, named('QRoot')[0]!.id)).toBe(true);
    } else if (move === 'underQA') expect(reparentEntity(z, named('QA')[0]!.id)).toBe(true);

    const copy = duplicateEntity(named('QRoot')[0]!.id, () => {})!;
    const zCopy = getAllEntities().find((e) => e.name === 'ZRoot' && e.id !== z)!;
    expect(pi(zCopy.id)).toMatchObject({ rootInstanceId: zCopy.id, parentLocalId: 0 }); // promoted: an instance of its own
    expect(linksStayInside(copy)).toBe(true);
    expect(sharedGuids()).toEqual([]);
    const copyGuids = getAllEntities().filter((e) => e.name === 'ZRoot' || e.name === 'ZLeaf').map((e) => e.guid).sort();

    await load(await save());

    expect(named('ZRoot')).toHaveLength(2);
    expect(getAllEntities().find((e) => e.guid === zGuid)?.name).toBe('ZRoot');
    const leaf = getAllEntities().find((e) => e.guid === leafGuid);
    expect(leaf?.name).toBe('ZLeaf');
    expect(x(leaf!.id)).toBe(9);
    expect(getAllEntities().filter((e) => e.name === 'ZRoot' || e.name === 'ZLeaf').map((e) => e.guid).sort()).toEqual(copyGuids);
  });
});

/** The same, where a DOCUMENT confirms the wrong guess: O2 nests MID twice, and MID nests Z at row 3. Z of the first MID,
 *  moved under the second MID's slot, hangs in a frame whose document really has a row 3 expanding Z — only its owner
 *  link says it belongs to the first MID, which the copy of the second leaves behind (`linkOwnerBeforeMove` writes the
 *  link for exactly this: two instances of one prefab share every row). Mutation: drop the owner-link check. */
describe('a copied owned root whose owner LINK names a frame outside the copy is promoted (#1756 close-out)', () => {
  it('the original keeps its row and guid through save + reload', async () => {
    const MID = 'aaaaaaaa-0000-4000-8000-0000000007c1';
    const Z8 = 'aaaaaaaa-0000-4000-8000-0000000007c2';
    const O8 = 'aaaaaaaa-0000-4000-8000-0000000007c3';
    const ng = (i: number) => `dddddddd-0000-4000-8000-0000000078${String(i).padStart(2, '0')}`;
    const r = (localId: number, name: string, parentId: number, nodeGuid: string, extra: Record<string, unknown> = {}) => ({
      localId, nodeGuid, ...extra, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
    });
    install(
      { id: Z8, version: 5, rootLocalId: 1, entities: [r(1, 'ZRoot', 0, ng(1)), r(2, 'ZLeaf', 1, ng(2))] },
      { id: MID, version: 5, rootLocalId: 1, entities: [r(1, 'MRoot', 0, ng(3)), r(2, 'MSlot', 1, ng(4)), r(3, 'ZRow', 1, ng(5), { prefab: Z8 })] },
      { id: O8, version: 5, rootLocalId: 1, entities: [r(1, 'ORoot', 0, ng(6)), r(2, 'M1', 1, ng(7), { prefab: MID }), r(3, 'M2', 1, ng(8), { prefab: MID })] },
    );
    await load({ id: 'n8', version: 16, name: 'N8', resources: [], entities: [
      { id: 1, prefab: O8, guid: 'bbbbbbbb-0000-4000-8000-0000000000c3', traits: { EntityAttributes: { name: 'ORoot', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    ] } as unknown as SceneData);
    const [m1, m2] = named('MRoot').map((e) => e.id);
    const under = (id: number, root: number) => { for (let c = getAllEntities().find((e) => e.id === id); c; c = getAllEntities().find((e) => e.id === c!.parentId)) if (c.id === root) return true; return false; };
    const z1 = named('ZRoot').find((e) => under(e.id, m1!))!.id;
    const slot2 = named('MSlot').find((e) => under(e.id, m2!))!.id;
    const z1Guid = getAllEntities().find((e) => e.id === z1)!.guid;
    expect(reparentEntity(z1, slot2)).toBe(true);

    const copy = duplicateEntity(m2!, () => {})!;
    const moved = getAllEntities().find((e) => e.name === 'ZRoot' && e.parentId !== slot2 && under(e.id, copy) && getAllEntities().find((p) => p.id === e.parentId)?.name === 'MSlot')!;
    expect(pi(moved.id)).toMatchObject({ rootInstanceId: moved.id, parentLocalId: 0 });
    expect(linksStayInside(copy)).toBe(true);
    expect(sharedGuids()).toEqual([]);

    await load(await save());

    expect(named('ZRoot')).toHaveLength(4);
    expect(getAllEntities().find((e) => e.guid === z1Guid)?.name).toBe('ZRoot');
    expect(sharedGuids()).toEqual([]);
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

describe('a whole-instance copy keeps a MOVED owned root linked: its owner link names the copied instance (#1756 close-out)', () => {
  it.each([
    ['duplicate of the instance', 'dup-inst'],
    ['duplicate of the group holding it', 'dup-holder'],
    ['paste of the instance', 'paste'],
    ['device op', 'device'],
  ])('%s', async (_l, how) => {
    install(qDoc(), pqDoc());
    await load(scene(PQ));
    const qr = named('QR')[0]!.id;
    writeTraitFieldWithUndo(named('QX')[0]!.id, meta('Transform'), 'x', 3);
    expect(reparentEntity(qr, idOf(INST)!)).toBe(true); // moved out of A, up to the instance root
    expect(piFull(qr)?.ownerGuid).toBe(INST);
    const qrGuid = guidOfId(qr);
    const qxGuid = named('QX')[0]!.guid;

    let copy: number;
    if (how === 'dup-inst') copy = duplicateEntity(idOf(INST)!, () => {})!;
    else if (how === 'dup-holder') copy = duplicateEntity(idOf(HOLDER)!, () => {})!;
    else if (how === 'paste') copy = respawnFromSnapshot(copySnapshot(snapshotEntity(idOf(INST)!)!), 0);
    else { const r = duplicateEntityLive({ guid: INST }) as { ok: boolean; roots: Array<{ id: number }> }; expect(r.ok).toBe(true); copy = r.roots[0]!.id; }
    const qrCopy = named('QR').find((e) => e.id !== qr)!;
    expect(underRoot(qrCopy.id, copy)).toBe(true);
    // KEEP: still a row of the copied instance.
    expect(piFull(qrCopy.id)).toMatchObject({ rootInstanceId: qrCopy.id, parentLocalId: 3 });
    expect(sharedGuids()).toEqual([]);
    expect(linksStayInside(copy)).toBe(true);
    const copyGuids = getAllEntities().filter((e) => e.name === 'QR' || e.name === 'QX').map((e) => e.guid).sort();

    await load(await save());
    expect(named('QR')).toHaveLength(2);
    for (const q of named('QR')) expect(piFull(q.id)?.parentLocalId).toBe(3);
    expect(getAllEntities().find((e) => e.guid === qrGuid)?.name).toBe('QR');
    expect(x(idOf(qxGuid!)!)).toBe(3);
    expect(getAllEntities().filter((e) => e.name === 'QR' || e.name === 'QX').map((e) => e.guid).sort()).toEqual(copyGuids);
    expect(sharedGuids()).toEqual([]);
  });
});

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
  it.each([['none'], ['back'], ['underQA'], ['underORoot']])('move=%s', async (move) => {
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
    if (move === 'back') { reparentEntity(z, named('ORoot')[0]!.id); reparentEntity(z, named('QRoot')[0]!.id); }
    else if (move === 'underQA') reparentEntity(z, named('QA')[0]!.id);
    else if (move === 'underORoot') reparentEntity(z, named('ORoot')[0]!.id);

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

