/** Owner 2 of #1683 (#1691): which entities belong to a frame, and which row a live node is, come from IDENTITY
 *  (I6) and correspondence (I5) — never from where a node hangs live, never from a fresh mint where a real
 *  correspondence exists. One regression per absorbed bug; #1682's live in `promotionGuidCarry.test.ts`.
 *
 *  Driven through the real loader, the real save and the reload. Each case names the mutation that turns it red. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));
/** Files on disk, path → text: a create-only write over one answers 409 as the real route does, and a GET serves it. */
const onDisk = new Map<string, string>();
/** Run once, inside the next file write — an edit landing while a save awaits its write. */
const duringWrite: { fn: null | (() => void) } = { fn: null };
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string, _x?: unknown, opts?: { createOnly?: boolean }) => {
    if (opts?.createOnly && onDisk.has(path)) return { ok: false, status: 409, json: async () => ({ existingPath: path }), text: async () => '' } as Response;
    onDisk.set(path, content);
    if (duringWrite.fn) { const f = duringWrite.fn; duringWrite.fn = null; f(); }
    const doc = JSON.parse(content) as { id?: string };
    if (doc.id && prefabs.has(doc.id)) prefabs.set(doc.id, doc);
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  },
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { setActionCallback, pushAction, clearHistory, createEntityWithUndo } from '@modoki/engine/editor';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache, getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { serializePrefab } from '../../packages/modoki/src/editor/scene/prefabSerialize';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { buildPrefabEditScene, savePrefabEditReport, PREFAB_EDIT_ROOT_GUID, _resetPrefabEditSessionRows } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { resetPrefabMarkRecord } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { deleteEntitiesWithUndo, undo } from '@modoki/engine/editor';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { clearDirtyAssets, peekDirtyAsset, flushDirtyAssets } from '../../packages/modoki/src/editor/scene/dirtyAssets';

registerAllTraits();
setActionCallback(pushAction);

const O = 'cccccccc-0000-4000-8000-000000169101';
const P = 'cccccccc-0000-4000-8000-000000169102';

const row = (localId: number, name: string, parentId: number, nodeGuid: string, prefab?: string) => ({
  localId, name, nodeGuid, ...(prefab ? { prefab } : {}),
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** P: R → A. */
const pDoc = () => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
  row(1, 'R', 0, 'eeeeeeee-0000-4000-8000-000000169111'), row(2, 'A', 1, 'eeeeeeee-0000-4000-8000-000000169112'),
] });
const install = (...docs: Array<{ id?: string }>) => { for (const d of docs) { prefabs.set(d.id!, d); setPrefabCache(d.id!, d as never); } };

async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id: number) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
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

const byName = (name: string) => getAllEntities().filter((e) => e.name === name);
const one = (name: string) => {
  const hits = byName(name);
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} entities named ${name}`);
  return hits[0]!.id;
};
const add = (label: string, parent: number, name: string) =>
  createEntityWithUndo(label, parent, [{ name: 'Transform', data: {} }, { name: 'EntityAttributes', data: { name, parentId: parent } }], () => {})!;

beforeEach(() => {
  resetPrefabMarkRecord(); // the session's mark record (#1880) belongs to its own case
  clearDirtyAssets(); // a document an undo parked (#1868) belongs to its own case
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  clearKeptMemberOrphans();
  _resetPrefabEditSessionRows();
  onDisk.clear();
  vi.stubGlobal('fetch', async (url: string) => {
    // Create Prefab asks the route what is at the path before it asks the human (#1692).
    if (String(url).includes('/api/exists')) {
      const asked = decodeURIComponent(String(url).split('path=')[1] ?? '');
      return { ok: true, status: 200, json: async () => (onDisk.has(asked) ? { exists: true, path: asked } : { exists: false }) };
    }
    const hit = [...onDisk].find(([p]) => String(url).endsWith(p));
    // A real Response: the prior-bytes read takes `arrayBuffer()` (#1692, a BOM is kept for the verbatim undo).
    if (hit) return new Response(hit[1], { status: 200 });
    return { ok: true, json: async () => ({ files: [] }), text: async () => '' };
  });
});
afterAll(() => { for (const id of [O, P]) setPrefabCache(id, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

describe('#1686: Create Prefab → Replace carries each row\'s nodeGuid — by live identity, then by a unique name (Unity U22)', () => {
  const X = 'cccccccc-0000-4000-8000-000000169131';
  const XPATH = '/prefabs/X.prefab.json';
  const I0 = 'dddddddd-0000-4000-8000-000000169131';
  const I1 = 'dddddddd-0000-4000-8000-000000169132';
  const G = { XR: 'eeeeeeee-0000-4000-8000-000000169131', XA: 'eeeeeeee-0000-4000-8000-000000169132',
    XB: 'eeeeeeee-0000-4000-8000-000000169133', XC: 'eeeeeeee-0000-4000-8000-000000169134' };
  /** X: XR → XA, XB, XC. */
  const xDoc = () => ({ id: X, version: 5, name: 'X', rootLocalId: 1, entities: [
    row(1, 'XR', 0, G.XR), row(2, 'XA', 1, G.XA), row(3, 'XB', 1, G.XB), row(4, 'XC', 1, G.XC),
  ] });
  const tf = (id: number) => readTraitData(id, getTraitByName('Transform')!) as { x: number; y: number };
  /** The entity named `name` below the instance root `guid`. */
  const inInst = (guid: string, name: string) => {
    const all = getAllEntities();
    const root = all.find((e) => e.guid === guid)!.id;
    const hits = all.filter((e) => e.name === name && e.parentId === root);
    if (hits.length !== 1) throw new Error(`fixture: ${hits.length} ${name} under ${guid}`);
    return hits[0]!;
  };

  it('over an instance of the prefab it replaces: every row keeps its nodeGuid, so another instance keeps its edits and its member guids', async () => {
    // Mutation: build the kept-id document from the draft again (no re-serialize) — every row re-mints, and I1's member
    // rows dangle: XC.x and XB.y reload at the template's values, and each member reloads under another member's guid.
    // Or serialize it without the kept id (`serializePrefab(entityId, undefined, …)`) — the name rule still carries XA
    // and XC, but the renamed XB mints, and I1's XB.y is lost.
    const doc = xDoc();
    install(doc);
    onDisk.set(XPATH, JSON.stringify(doc));
    registerAsset(X, XPATH, 'prefab');
    await load({
      id: 'replace', version: 16, name: 'S', resources: [],
      entities: [
        { id: 1, prefab: X, guid: I0, traits: { EntityAttributes: { name: 'I0', parentId: 0 } } },
        { id: 2, prefab: X, guid: I1, traits: { EntityAttributes: { name: 'I1', parentId: 0 } } },
      ],
    } as unknown as SceneData);
    const tfMeta = getTraitByName('Transform')!;
    const xc = inInst(I1, 'XC').id;
    const xb = inInst(I1, 'XB').id;
    const { writeTraitFieldWithUndo } = await import('@modoki/engine/editor');
    writeTraitFieldWithUndo(xc, tfMeta, 'x', 5);
    writeTraitFieldWithUndo(xb, tfMeta, 'y', 9);
    const before = { XA: inInst(I1, 'XA').guid, XB: inInst(I1, 'XB').guid, XC: inInst(I1, 'XC').guid };
    const saved = await serializeScene() as unknown as SceneData; // the scene file, keyed by X's node guids
    add('Add New', idOfGuid(I0), 'New');
    // Renamed on I0, so only its live `nodeGuid` can say which row it is: the name rule cannot rescue it.
    writeTraitFieldWithUndo(inInst(I0, 'XB').id, getTraitByName('EntityAttributes')!, 'name', 'XB renamed');

    const res = await createPrefabFromEntity(idOfGuid(I0), XPATH, 'Create Prefab "X"', async () => true);
    if (!res || res === 'declined' || 'refused' in res) throw new Error(`fixture: ${JSON.stringify(res)}`);
    expect(res.prefab.id).toBe(X); // precondition: a Replace that kept the id
    const written = JSON.parse(onDisk.get(XPATH)!) as PrefabFile;
    const guidOfRow = (name: string) => written.entities.find((e) => e.name === name)?.nodeGuid;
    expect({ XR: guidOfRow('XR'), XA: guidOfRow('XA'), XB: guidOfRow('XB renamed'), XC: guidOfRow('XC') }).toEqual(G);
    expect(Object.values(G)).not.toContain(guidOfRow('New'));

    prefabs.set(X, written);
    await load(saved);
    expect(tf(inInst(I1, 'XC').id).x).toBe(5);
    expect(tf(inInst(I1, 'XB renamed').id).y).toBe(9); // the row's name is the template's now; its identity is not
    expect({ XA: inInst(I1, 'XA').guid, XB: inInst(I1, 'XB renamed').guid, XC: inInst(I1, 'XC').guid }).toEqual(before);
  });

  it('a plain tree takes the nodeGuid of the ONE row sharing its name; a name two nodes share, on either side, mints', async () => {
    // Mutation: drop the name match (`replacing` ignored in `nodeGuidsFor`) — XA and XC mint. Drop either half of the
    // uniqueness test — the two "Dup" nodes claim the one Dup row, or "XB" (twice in the old document) takes one of its
    // rows. Collapse the kind key to plain — the plain "Nest" takes the nested row's identity.
    const old = { entities: [
      { name: 'XR', nodeGuid: G.XR }, { name: 'XA', nodeGuid: G.XA }, { name: 'XB', nodeGuid: G.XB }, { name: 'XB', nodeGuid: 'eeeeeeee-0000-4000-8000-0000001691b2' },
      { name: 'XC', nodeGuid: G.XC }, { name: 'Dup', nodeGuid: 'eeeeeeee-0000-4000-8000-0000001691d1' },
      { name: 'Nest', nodeGuid: 'eeeeeeee-0000-4000-8000-0000001691e1', prefab: P }, // a NESTED row: no plain node takes it
    ] };
    await load({ id: 'plain', version: 16, name: 'S', resources: [], entities: [] } as unknown as SceneData);
    const root = add('Add XR', 0, 'XR');
    for (const n of ['XA', 'XB', 'XC', 'Dup', 'Dup', 'Nest']) add(`Add ${n}`, root, n);
    const doc = serializePrefab(root, X, { replacing: old })!;
    const byName = (n: string) => doc.entities.filter((e) => e.name === n).map((e) => e.nodeGuid);
    expect(byName('XR')).toEqual([G.XR]);
    expect(byName('XA')).toEqual([G.XA]);
    expect(byName('XC')).toEqual([G.XC]);
    // Ambiguous in the old document: neither of its two XB rows is taken (the lookup keeps one of them, so both are named).
    expect([G.XB, 'eeeeeeee-0000-4000-8000-0000001691b2']).not.toContain(byName('XB')[0]);
    expect(byName('Nest')).not.toContain('eeeeeeee-0000-4000-8000-0000001691e1'); // a plain node, a nested row
    expect(byName('Dup')).not.toContain('eeeeeeee-0000-4000-8000-0000001691d1'); // ambiguous in the new tree
    expect(new Set(doc.entities.map((e) => e.nodeGuid)).size).toBe(doc.entities.length);
    // …and a prefab-edit save never name-matches: without `replacing` everything with no identity mints.
    expect(serializePrefab(root, X)!.entities.map((e) => e.nodeGuid)).not.toContain(G.XA);
  });
});
const idOfGuid = (guid: string) => getAllEntities().find((e) => e.guid === guid)?.id ?? 0;

describe('#1837: a Replace from a DIFFERENT entity keeps the root\'s identity — the new root takes the old root\'s nodeGuid (hub ruling, Unity)', () => {
  const Z = 'cccccccc-0000-4000-8000-000000183701';
  const ZPATH = '/prefabs/Z.prefab.json';
  const I0 = 'dddddddd-0000-4000-8000-000000183701';
  const G = { R: 'eeeeeeee-0000-4000-8000-000000183701', A: 'eeeeeeee-0000-4000-8000-000000183702', B: 'eeeeeeee-0000-4000-8000-000000183703' };
  /** Z: R → A (2), B (3). */
  const zDoc = () => ({ id: Z, version: 5, name: 'Z', rootLocalId: 1, entities: [row(1, 'R', 0, G.R), row(2, 'A', 1, G.A), row(3, 'B', 1, G.B)] });

  const lidGuids = (doc: PrefabFile) => Object.fromEntries(doc.entities.map((e) => [e.localId, e.nodeGuid]));
  /** One instance I0 of Z with its ROOT moved (an override keyed by localId 1) and its member A moved (keyed by A's
   *  nodeGuid), and a plain tree Other → A, R, C beside it: a different entity, whose root is named like no row. */
  const setup = async () => {
    const doc = zDoc();
    install(doc);
    onDisk.set(ZPATH, JSON.stringify(doc));
    registerAsset(Z, ZPATH, 'prefab');
    await load({ id: 'r1837', version: 16, name: 'S', resources: [], entities: [
      { id: 1, prefab: Z, guid: I0, traits: { EntityAttributes: { name: 'I0', parentId: 0 } } },
    ] } as unknown as SceneData);
    const { writeTraitFieldWithUndo } = await import('@modoki/engine/editor');
    const tfMeta = getTraitByName('Transform')!;
    writeTraitFieldWithUndo(idOfGuid(I0), tfMeta, 'x', 7);
    const i0A = getAllEntities().find((e) => e.name === 'A' && e.parentId === idOfGuid(I0))!.id;
    writeTraitFieldWithUndo(i0A, tfMeta, 'y', 3);
    const saved = await serializeScene() as unknown as SceneData;
    const other = add('Add Other', 0, 'Other');
    for (const n of ['A', 'R', 'C']) add(`Add ${n}`, other, n);
    return { saved, other };
  };

  it('the new root is written at localId 1 with the OLD root\'s nodeGuid; a child matches by name; one named like the old root is a new node', async () => {
    // Mutation: drop the root binding in `nodeGuidsFor` — the root row mints a fresh nodeGuid at localId 1 (the I4 re-bind
    // the fuzzer reported), and the child "R" takes the old root's nodeGuid by the name rule, a second re-bind.
    const { saved, other } = await setup();
    const warn = vi.spyOn(console, 'warn');
    const res = await createPrefabFromEntity(other, ZPATH, 'Create Prefab "Z"', async () => true);
    const twice = warn.mock.calls.filter((c) => String(c[0]).includes('two rows claim'));
    warn.mockRestore();
    if (!res || res === 'declined' || 'refused' in res) throw new Error(`fixture: ${JSON.stringify(res)}`);
    expect(res.prefab.id).toBe(Z); // precondition: a Replace that kept the id
    const written = JSON.parse(onDisk.get(ZPATH)!) as PrefabFile;
    const rowOf = (name: string) => written.entities.find((e) => e.name === name)!;
    expect(written.rootLocalId).toBe(1);
    expect({ lid: rowOf('Other').localId, guid: rowOf('Other').nodeGuid }).toEqual({ lid: 1, guid: G.R });
    expect({ lid: rowOf('A').localId, guid: rowOf('A').nodeGuid }).toEqual({ lid: 2, guid: G.A }); // U22: by name
    expect([G.R, G.A, G.B]).not.toContain(rowOf('R').nodeGuid); // named like the old root, but the root is the root
    expect([G.R, G.A, G.B]).not.toContain(rowOf('C').nodeGuid);
    expect([rowOf('R').localId, rowOf('C').localId].every((l) => l! > 3)).toBe(true); // above the old document's numbers
    expect(twice).toEqual([]); // the old root's identity is not a damaged document's duplicate
    // I4 across the write: every localId the old document bound still names the node it named, or is not written.
    const after = lidGuids(written);
    for (const [lid, g] of Object.entries(lidGuids(zDoc() as unknown as PrefabFile))) if (after[lid]) expect(after[lid]).toBe(g);
    // The live tag names the same root: the new instance's root is the document's root node.
    const piMeta = getTraitByName('PrefabInstance')!;
    expect((readTraitData(other, piMeta) as { nodeGuid?: string }).nodeGuid).toBe(G.R);

    // An existing instance keeps its ROOT override and its member's across the Replace, and its root names a node the
    // document states.
    prefabs.set(Z, written);
    await load(saved);
    const root = idOfGuid(I0);
    expect((readTraitData(root, getTraitByName('Transform')!) as { x: number }).x).toBe(7);
    expect((readTraitData(root, piMeta) as { nodeGuid?: string }).nodeGuid).toBe(G.R);
    const a = getAllEntities().find((e) => e.name === 'A' && e.parentId === root)!.id;
    expect((readTraitData(a, getTraitByName('Transform')!) as { y: number }).y).toBe(3);
  });

  it('a Replace from a MEMBER of an instance of the target: the root takes the root\'s nodeGuid, not the member\'s', async () => {
    // Mutation: drop `nodeGuidsFor`'s `carried.has` early-out in `take` — the live identity pass re-binds the root to A's
    // nodeGuid, so localId 1 names A's node.
    await setup();
    const i0A = getAllEntities().find((e) => e.name === 'A' && e.parentId === idOfGuid(I0))!.id;
    add('Add D', i0A, 'D');
    const doc = serializePrefab(i0A, Z, { replacing: zDoc() })!;
    expect(lidGuids(doc)[1]).toBe(G.R);
    expect(doc.entities.map((e) => e.nodeGuid)).not.toContain(G.A);
    expect(new Set(doc.entities.map((e) => e.nodeGuid)).size).toBe(doc.entities.length);
  });

  it('undo puts the old document back — localId 1 bound as it was, and Save keeps the mark — and redo brings the old root\'s identity again', async () => {
    // Mutation: drop the root binding — redo's row at localId 1 carries a fresh nodeGuid, not G.R.
    const { other } = await setup();
    const before = onDisk.get(ZPATH)!;
    const res = await createPrefabFromEntity(other, ZPATH, 'Create Prefab "Z"', async () => true);
    if (!res || res === 'declined' || 'refused' in res) throw new Error(`fixture: ${JSON.stringify(res)}`);
    pushAction(res.action); // as both panels do with the returned step
    expect(await undo()).toBe(true);
    const old = JSON.parse(before) as PrefabFile;
    // #1868: the old document is back IN MEMORY, parked; Save writes its rows with the high-water mark the Replace raised
    // kept (#1774: a number is never handed out twice) and the commit's format stamp.
    expect((peekDirtyAsset(ZPATH)?.data as PrefabFile | undefined)?.entities).toEqual(old.entities);
    expect(readTraitData(other, getTraitByName('PrefabInstance')!) ?? null).toBeNull(); // the source tree is plain again
    expect((await flushDirtyAssets()).failed).toEqual([]);
    const restored = JSON.parse(onDisk.get(ZPATH)!) as PrefabFile & { nextLocalId?: number };
    expect({ rows: restored.entities, root: restored.rootLocalId, mark: restored.nextLocalId }).toEqual({ rows: old.entities, root: 1, mark: 6 });
    const { redo } = await import('@modoki/engine/editor');
    expect(await redo()).toBe(true);
    expect(lidGuids(peekDirtyAsset(ZPATH)?.data as PrefabFile)[1]).toBe(G.R);
  });
});

describe('#1761: a template\'s member token resolves AFTER the pins are final — a dropped pin does not take the token with it', () => {
  const T = 'cccccccc-0000-4000-8000-000000176101';
  const INST_T = 'dddddddd-0000-4000-8000-000000176101';
  const gA = 'eeeeeeee-0000-4000-8000-000000176102';
  /** T: R → A (2), B (3); B's UIAction targets A by token. */
  const tDoc = () => {
    const d = { id: T, version: 5, name: 'T', rootLocalId: 1, entities: [
      row(1, 'R', 0, 'eeeeeeee-0000-4000-8000-000000176101'), row(2, 'A', 1, gA), row(3, 'B', 1, 'eeeeeeee-0000-4000-8000-000000176103'),
    ] };
    (d.entities[2]!.traits as Record<string, unknown>).UIAction = { bindings: [{ event: 'click', action: 'noop', target: '@member:2' }] };
    return d;
  };
  const sceneWith = (members?: Record<string, unknown>) => ({ id: 't1761', version: 16, name: 'S', resources: [], entities: [
    { id: 1, prefab: T, guid: INST_T, traits: { EntityAttributes: { name: 'I', parentId: 0 } }, ...(members ? { members } : {}) },
  ] } as unknown as SceneData);
  const target = () => (readTraitData(one('B'), getTraitByName('UIAction')!) as { bindings: Array<{ target: string }> }).bindings[0]!.target;

  it('A and B pinned to ONE guid are both dropped, and B\'s token names A by its FINAL guid', async () => {
    // Two pins on one guid is the collision left to `dropCollidingPins` since #1882 (a pin meeting a DERIVATION salts the
    // derivation instead, `sceneMemberRows.test.ts`): both pins are suspect, both drop, both re-derive. The token must be
    // resolved after that. Mutation: settle inside the first derive (`settleDerivedGuids` right after the first
    // `deriveMemberGuidsOnly` in `deriveMemberGuidsAfterPins`) — the token keeps the dropped guid, which nothing holds.
    install(tDoc());
    await load(sceneWith());
    const derivedB = getAllEntities().find((e) => e.id === one('B'))!.guid!;
    expect(target()).toBe(getAllEntities().find((e) => e.id === one('A'))!.guid); // precondition: the token resolves
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A damaged pair: A and B both pinned to B's derivation.
    await load(sceneWith({ [`/${gA}`]: { guid: derivedB, name: 'A' }, '/eeeeeeee-0000-4000-8000-000000176103': { guid: derivedB, name: 'B' } }));
    const dropped = warn.mock.calls.filter((c) => String(c[0]).includes('dropping the pin')).length;
    warn.mockRestore();
    expect(dropped).toBe(2); // precondition: both pins yield
    const guidA = getAllEntities().find((e) => e.id === one('A'))!.guid;
    const guidB = getAllEntities().find((e) => e.id === one('B'))!.guid;
    expect(new Set([guidA, guidB]).size).toBe(2);
    expect(target()).toBe(guidA);
  });
});

describe('#1759: a Replace keeps every matched row\'s localId, and numbers a new row above the old document (owner option 1, Unity fileIDs)', () => {
  const Y = 'cccccccc-0000-4000-8000-000000175901';
  const YPATH = '/prefabs/Y.prefab.json';
  const I0 = 'dddddddd-0000-4000-8000-000000175901';
  const I1 = 'dddddddd-0000-4000-8000-000000175902';
  const G = { R: 'eeeeeeee-0000-4000-8000-000000175901', A: 'eeeeeeee-0000-4000-8000-000000175902', B: 'eeeeeeee-0000-4000-8000-000000175903' };
  /** Y: R → A (2), B (3). */
  const yDoc = () => ({ id: Y, version: 5, name: 'Y', rootLocalId: 1, entities: [row(1, 'R', 0, G.R), row(2, 'A', 1, G.A), row(3, 'B', 1, G.B)] });
  const inInst = (guid: string, name: string) => {
    const all = getAllEntities();
    const root = all.find((e) => e.guid === guid)!.id;
    const hits = all.filter((e) => e.name === name && e.parentId === root);
    if (hits.length !== 1) throw new Error(`fixture: ${hits.length} ${name} under ${guid}`);
    return hits[0]!;
  };
  const twoInstances = async () => {
    const doc = yDoc();
    install(doc);
    onDisk.set(YPATH, JSON.stringify(doc));
    registerAsset(Y, YPATH, 'prefab');
    await load({ id: 'r1759', version: 16, name: 'S', resources: [], entities: [
      { id: 1, prefab: Y, guid: I0, traits: { EntityAttributes: { name: 'I0', parentId: 0 } } },
      { id: 2, prefab: Y, guid: I1, traits: { EntityAttributes: { name: 'I1', parentId: 0 } } },
    ] } as unknown as SceneData);
  };

  it('the #1759 repro: delete A and add X on I0, Replace — I1\'s B keeps its guid, X takes neither A\'s nor B\'s, and no pin is dropped', async () => {
    // Mutation: return null from `replaceNumbering` (positional numbering) — B is written at 2 and X at 3, and the
    // numbering assert goes red (measured). Before #1882 B then derived A's old guid, its stored pin was dropped, and I1's
    // B reloaded under A's guid; since #1882 the colliding derivation salts instead, so the numbering is what is left.
    await twoInstances();
    const before = { A: inInst(I1, 'A').guid, B: inInst(I1, 'B').guid };
    const saved = await serializeScene() as unknown as SceneData; // I1's member rows pin A's and B's guids
    deleteEntitiesWithUndo([inInst(I0, 'A').id]);
    add('Add X', idOfGuid(I0), 'X');
    const res = await createPrefabFromEntity(idOfGuid(I0), YPATH, 'Create Prefab "Y"', async () => true);
    if (!res || res === 'declined' || 'refused' in res) throw new Error(`fixture: ${JSON.stringify(res)}`);
    const written = JSON.parse(onDisk.get(YPATH)!) as PrefabFile;
    const lidOf = (name: string) => written.entities.find((e) => e.name === name)?.localId;
    expect({ R: lidOf('R'), B: lidOf('B'), X: lidOf('X'), root: written.rootLocalId }).toEqual({ R: 1, B: 3, X: 4, root: 1 });
    // The live tag names the same rows the file does (#1278's bar: the world after Create Prefab = after save + reload).
    const piMeta = getTraitByName('PrefabInstance')!;
    const liveLid = (name: string) => (readTraitData(inInst(I0, name).id, piMeta) as { localId: number }).localId;
    expect({ B: liveLid('B'), X: liveLid('X') }).toEqual({ B: 3, X: 4 });

    prefabs.set(Y, written);
    const warn = vi.spyOn(console, 'warn');
    await load(saved);
    const dropped = warn.mock.calls.filter((c) => String(c[0]).includes('dropping the pin'));
    warn.mockRestore();
    expect(dropped).toEqual([]);
    expect(inInst(I1, 'B').guid).toBe(before.B);
    expect([before.A, before.B]).not.toContain(inInst(I1, 'X').guid);
  });

  it('a pre-v5 document (no nodeGuid anywhere) keeps its positional numbering — its numbers are its only identity', async () => {
    // Mutation: drop the `!oldLocal.size` early-out — every non-root row of a same-tree Replace renumbers above 3, and
    // each scene override keyed on the old numbers dangles.
    await load({ id: 'legacy', version: 16, name: 'S', resources: [], entities: [] } as unknown as SceneData);
    const root = add('Add R', 0, 'R');
    add('Add A', root, 'A');
    add('Add B', root, 'B');
    const legacy = { rootLocalId: 1, entities: [{ name: 'R', localId: 1 }, { name: 'A', localId: 2 }, { name: 'B', localId: 3 }] };
    const doc = serializePrefab(root, Y, { replacing: legacy })!;
    expect(doc.entities.map((e) => [e.name, e.localId])).toEqual([['R', 1], ['A', 2], ['B', 3]]);
  });

  it('the tag REFUSES when the entity at a row is not the one written there — same count, same names (planMatchesFile)', async () => {
    // Mutation: drop the recorded-plan check in `planMatchesFile` — the names match position by position, so d2 is tagged
    // with d1's row and the newcomer with d2's.
    const { tagEntityTreeAsInstance } = await import('../../packages/modoki/src/editor/scene/prefabLink');
    await load({ id: 'swap', version: 16, name: 'S', resources: [], entities: [] } as unknown as SceneData);
    const root = add('Add R', 0, 'R');
    const d1 = add('Add Dup', root, 'Dup');
    const d2 = add('Add Dup', root, 'Dup');
    const file = serializePrefab(root, Y)!;
    // While the write awaited, d1 was deleted and a new "Dup" added: the count and the names still match row for row,
    // but d2 now sits where d1 was written, and the newcomer where d2 was.
    deleteEntitiesWithUndo([d1]);
    const d3 = add('Add Dup', root, 'Dup');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const remap = tagEntityTreeAsInstance(root, Y, file);
    const refused = err.mock.calls.some((c) => String(c[0]).includes('not tagging'));
    err.mockRestore();
    expect(refused).toBe(true);
    expect(remap.size).toBe(0);
    expect([d2, d3].map((id) => readTraitData(id, getTraitByName('PrefabInstance')!) ?? null)).toEqual([null, null]);
  });

  it('the human Create Prefab refuses to tag a tree changed during its write — it tags a COPY of the file (review F1)', async () => {
    // `createPrefabFromEntity` tags `{ ...draft, id }`, not the object `serializePrefab` returned. Mutation: key
    // `writtenRows` by the file object again — the record is never found on this path, and d2 is tagged with d1's row.
    await load({ id: 'human', version: 16, name: 'S', resources: [], entities: [] } as unknown as SceneData);
    const root = add('Add R', 0, 'R');
    const d1 = add('Add Dup', root, 'Dup');
    const d2 = add('Add Dup', root, 'Dup');
    let d3 = 0;
    duringWrite.fn = () => { deleteEntitiesWithUndo([d1]); d3 = add('Add Dup', root, 'Dup'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await createPrefabFromEntity(root, '/prefabs/Human.prefab.json', 'Create Prefab "Human"', async () => true);
    const refused = err.mock.calls.some((c) => String(c[0]).includes('not tagging'));
    err.mockRestore();
    if (!res || res === 'declined' || 'refused' in res) throw new Error(`fixture: ${JSON.stringify(res)}`);
    expect(d3).toBeGreaterThan(0); // precondition: the tree changed inside the write
    expect(refused).toBe(true);
    expect([d2, d3].map((id) => readTraitData(id, getTraitByName('PrefabInstance')!) ?? null)).toEqual([null, null]);
  });

  it('a RENAME during the write still tags: it reorders nothing, and the file numbering is right (review F5)', async () => {
    // Mutation: refuse in `planMatchesFile` when a row's name differs from the live one — the tree is left unlinked.
    await load({ id: 'rename', version: 16, name: 'S', resources: [], entities: [] } as unknown as SceneData);
    const root = add('Add R', 0, 'R');
    const a = add('Add A', root, 'A');
    const { writeTraitFieldWithUndo } = await import('@modoki/engine/editor');
    duringWrite.fn = () => { writeTraitFieldWithUndo(a, getTraitByName('EntityAttributes')!, 'name', 'A renamed'); };
    const res = await createPrefabFromEntity(root, '/prefabs/Rename.prefab.json', 'Create Prefab "Rename"', async () => true);
    if (!res || res === 'declined' || 'refused' in res) throw new Error(`fixture: ${JSON.stringify(res)}`);
    expect(getAllEntities().find((e) => e.id === a)?.name).toBe('A renamed'); // precondition: renamed inside the write
    expect((readTraitData(a, getTraitByName('PrefabInstance')!) as { localId?: number } | null)?.localId).toBe(2);
  });

  it('accept side: an unmoved tree is tagged with the FILE\'s numbering, kept ids included', async () => {
    // Mutation: tag with the positional plan (`plan.ecsToLocal`) again — B is live-tagged 2 while its row is 3.
    const { tagEntityTreeAsInstance } = await import('../../packages/modoki/src/editor/scene/prefabLink');
    await load({ id: 'accept', version: 16, name: 'S', resources: [], entities: [] } as unknown as SceneData);
    const root = add('Add R', 0, 'R');
    const b = add('Add B', root, 'B');
    const file = serializePrefab(root, Y, { replacing: { rootLocalId: 1, entities: [
      { name: 'R', localId: 1, nodeGuid: G.R }, { name: 'A', localId: 2, nodeGuid: G.A }, { name: 'B', localId: 3, nodeGuid: G.B },
    ] } })!;
    expect(file.entities.find((e) => e.name === 'B')?.localId).toBe(3); // B carried by its unique name
    tagEntityTreeAsInstance(root, Y, file);
    expect((readTraitData(b, getTraitByName('PrefabInstance')!) as { localId: number }).localId).toBe(3);
  });
});

describe('#1686 close-out: the Replace\'s second serialize, and the agent create op', () => {
  const X = 'cccccccc-0000-4000-8000-000000169151';
  const XPATH = '/prefabs/X2.prefab.json';
  const OLD = { XR: 'eeeeeeee-0000-4000-8000-000000169151', Old: 'eeeeeeee-0000-4000-8000-000000169152', Keep: 'eeeeeeee-0000-4000-8000-000000169153' };
  const old = () => ({ id: X, version: 5, name: 'X2', rootLocalId: 1, entities: [
    row(1, 'XR', 0, OLD.XR), row(2, 'Old', 1, OLD.Old), row(3, 'Keep', 1, OLD.Keep),
  ] });

  it('the agent create op over an existing, uncached prefab matches by name, and leaves the editor cache as it found it', async () => {
    // Mutation: read the replaced rows with `getPrefabSource` again — the editor cache is left holding the OLD document
    // after the write. Or pass no `replacing` — "Keep" mints.
    const { registerEditorAgentOps } = await import('../../app/editor/agentEditorOps');
    const { runAgentOp } = await import('../../app/debug/agentBridge');
    registerEditorAgentOps();
    onDisk.set(XPATH, JSON.stringify(old()));
    registerAsset(X, XPATH, 'prefab');
    setPrefabCache(X, null);
    await load({ id: 'a', version: 16, name: 'S', resources: [], entities: [] } as unknown as SceneData);
    const root = add('Add XR', 0, 'XR');
    add('Add Keep', root, 'Keep');
    add('Add New', root, 'New');
    expect(getCachedPrefabSync(X)).toBeFalsy(); // precondition: cold
    await runAgentOp('prefab', { action: 'create', entityGuid: getAllEntities().find((e) => e.id === root)!.guid, path: XPATH, replace: true });
    const written = JSON.parse(onDisk.get(XPATH)!) as PrefabFile;
    expect(written.entities.find((e) => e.name === 'Keep')?.nodeGuid).toBe(OLD.Keep);
    expect(written.entities.find((e) => e.name === 'XR')?.nodeGuid).toBe(OLD.XR);
    expect(getCachedPrefabSync(X)?.entities.map((e) => e.name) ?? null).not.toEqual(['XR', 'Old', 'Keep']);
  });

  it('the agent create op matches against the FILE it replaces, not a stale editor-cache copy', async () => {
    // Mutation: build the agent op's `replacing` from the editor cache instead of the `prior` bytes it read — "Keep"
    // matches the stale copy's row.
    const { registerEditorAgentOps } = await import('../../app/editor/agentEditorOps');
    const { runAgentOp } = await import('../../app/debug/agentBridge');
    registerEditorAgentOps();
    onDisk.set(XPATH, JSON.stringify(old()));
    registerAsset(X, XPATH, 'prefab');
    setPrefabCache(X, { ...old(), entities: [row(1, 'XR', 0, OLD.XR), row(2, 'Keep', 1, 'eeeeeeee-0000-4000-8000-0000001691ff')] } as never);
    await load({ id: 'a', version: 16, name: 'S', resources: [], entities: [] } as unknown as SceneData);
    const root = add('Add XR', 0, 'XR');
    add('Add Keep', root, 'Keep');
    await runAgentOp('prefab', { action: 'create', entityGuid: getAllEntities().find((e) => e.id === root)!.guid, path: XPATH, replace: true });
    expect((JSON.parse(onDisk.get(XPATH)!) as PrefabFile).entities.find((e) => e.name === 'Keep')?.nodeGuid).toBe(OLD.Keep);
    setPrefabCache(X, null);
  });

  it('a Play started while the Replace dialog is open is refused, not written', async () => {
    // Mutation: drop the second `whyWorldNotAuthored()` in the build callback — the played pose (x = 42) reaches the file.
    // Or return null without saying why — the caller gets a silent `null`, and the human sees nothing happen.
    const doc = old();
    install(doc);
    onDisk.set(XPATH, JSON.stringify(doc));
    registerAsset(X, XPATH, 'prefab');
    await load({ id: 'r', version: 16, name: 'S', resources: [], entities: [] } as unknown as SceneData);
    const root = add('Add XR', 0, 'XR');
    const { writeTraitField } = await import('@modoki/engine/runtime');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await createPrefabFromEntity(root, XPATH, 'Create Prefab "X2"', async () => {
        setRunMode('playing');
        writeTraitField(root, getTraitByName('Transform')!, 'x', 42);
        return true;
      });
      expect(res).toEqual({ refused: expect.stringMatching(/^Create Prefab refused — /), notAuthored: expect.any(String) }); // shown, as the gate above is
      expect(JSON.parse(onDisk.get(XPATH)!)).toEqual(doc);
    } finally { err.mockRestore(); setRunMode('stopped'); }
  });
});

describe('#1662: a prefab-edit save keeps the row and the nodeGuid of a member ADDED during the session', () => {
  afterAll(() => { useEditorStore.setState({ editingPrefab: null }); });

  it('save, save again, delete a sibling, undo the delete: X and Y keep their localIds and nodeGuids through all of them', async () => {
    // Mutation: stop recording the rows a save wrote (`noteSessionRows` not called) — every save re-mints X and Y, and
    // after deleting X, Y is renumbered 4 → 3 (the reported F5 sequence).
    install(pDoc());
    useEditorStore.setState({ editingPrefab: { guid: P, name: 'P', path: '/prefabs/P.prefab.json' } });
    await load(buildPrefabEditScene(pDoc() as never));
    const root = getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!.id;
    add('Add X', root, 'X');
    add('Add Y', root, 'Y');
    const save = async () => {
      const report = await savePrefabEditReport();
      expect(report.saved).toBe(true);
      const doc = prefabs.get(P) as PrefabFile;
      return Object.fromEntries(doc.entities.map((e) => [e.name, `${e.localId}:${e.nodeGuid}`]));
    };
    const first = await save();
    expect(first.X!.split(':')[0]).toBe('3'); // precondition: the numbering the report measured
    expect(first.Y!.split(':')[0]).toBe('4');
    expect(await save()).toEqual(first);
    deleteEntitiesWithUndo([one('X')]);
    const afterDelete = await save();
    expect(afterDelete.Y).toBe(first.Y);
    expect(afterDelete.X).toBeUndefined();
    await undo();
    expect(await save()).toEqual(first);
  });

  /** Open P in a prefab-edit world; the edit root's ecs id. */
  const openP = async () => {
    install(pDoc());
    useEditorStore.setState({ editingPrefab: { guid: P, name: 'P', path: '/prefabs/P.prefab.json' } });
    await load(buildPrefabEditScene(pDoc() as never));
    return getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!.id;
  };
  const rowsOf = () => Object.fromEntries((prefabs.get(P) as PrefabFile).entities.map((e) => [e.name, `${e.localId}:${e.nodeGuid}`]));
  const uniqueIds = () => {
    const ids = (prefabs.get(P) as PrefabFile).entities.map((e) => e.localId);
    return new Set(ids).size === ids.length;
  };

  it('a number a delete freed is not handed to a new member: undoing the delete brings the opened row back at its own number and nodeGuid', async () => {
    // Close-out review, finding 1. Mutation: drop `localIdFloor` (number new members above the preserved ids only) — X
    // takes A's freed 2, the undone A comes back at 2 as well, and the file holds two rows numbered 2.
    const root = await openP();
    add('Add X', root, 'X');
    deleteEntitiesWithUndo([one('A')]);
    expect((await savePrefabEditReport()).saved).toBe(true);
    const x = rowsOf().X!;
    expect(x.split(':')[0]).toBe('3');
    await undo();
    expect((await savePrefabEditReport()).saved).toBe(true);
    expect(uniqueIds()).toBe(true);
    expect(rowsOf().A).toBe('2:eeeeeeee-0000-4000-8000-000000169112'); // the opened row's own identity, not a mint
    expect(rowsOf().X).toBe(x);
  });

  it('what a save records is read when it SERIALIZES: an entity made during the write does not inherit a deleted one\'s row', async () => {
    // Close-out review, finding 4. Mutation: key the recorded rows by ecs id and read their guids after the write — Z,
    // created on X's recycled id during the write, is written at X's localId with X's nodeGuid.
    const root = await openP();
    const x = add('Add X', root, 'X');
    const { deleteEntities } = await import('@modoki/engine/runtime');
    let z = 0;
    duringWrite.fn = () => { deleteEntities([x]); z = add('Add Z', root, 'Z'); };
    expect((await savePrefabEditReport()).saved).toBe(true);
    const xRow = rowsOf().X!;
    expect(z).toBe(x); // precondition: Z took X's recycled id, the case an id read after the await gets wrong
    expect((await savePrefabEditReport()).saved).toBe(true);
    expect(rowsOf().Z).not.toBe(xRow);
    expect(rowsOf().Z!.split(':')[1]).not.toBe(xRow.split(':')[1]);
  });

  /** P: R → A, B. */
  const p3 = () => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
    row(1, 'R', 0, 'eeeeeeee-0000-4000-8000-000000169111'), row(2, 'A', 1, 'eeeeeeee-0000-4000-8000-000000169112'),
    row(3, 'B', 1, 'eeeeeeee-0000-4000-8000-000000169113'),
  ] });
  /** Leave and re-open P: a NEW edit world built from the last save, with the undo history KEPT. The real re-open no
   *  longer keeps it (U27, #1704: the adoption owner drops a prefab-edit stack on leave, `sceneAdoption.test.ts`), and
   *  this helper bypasses that owner, so the cases using it pin the record's OWN defence against a history that outlives
   *  its world, should one ever do so again (Stop's rebuild inside one visit is the live case). */
  const reopen = async () => {
    const saved = JSON.parse(JSON.stringify(prefabs.get(P))) as PrefabFile;
    setPrefabCache(P, saved);
    await load(buildPrefabEditScene(saved as never));
    return getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!.id;
  };

  it('a Play/Stop rebuild of the edit world keeps what the saves recorded', async () => {
    // Close-out review 2, REVIEW-4. Mutation: key the record by the edit WORLD again — the rebuilt world has none, and X
    // is renumbered and re-minted: #1662 itself.
    const root = await openP();
    add('Add X', root, 'X');
    expect((await savePrefabEditReport()).saved).toBe(true);
    const x = rowsOf().X;
    await load(await serializeScene() as unknown as SceneData); // what Stop's revert does: the snapshot into a new world
    void root;
    expect((await savePrefabEditReport()).saved).toBe(true);
    expect(rowsOf().X).toBe(x);
  });

  it('an undone delete from an EARLIER visit comes back at its own number and identity, not a later newcomer\'s', async () => {
    // Close-out review 2, REVIEW-1 and REVIEW-2. Mutation: re-seed the floor from each opened file (or key the record by
    // world) — visit 2 numbers Y at B's freed 3, and the undone B is written with Y's nodeGuid; in a third visit Y wears
    // the sentinel for 3 and B comes back at 3 too: two rows at one localId.
    install(p3());
    useEditorStore.setState({ editingPrefab: { guid: P, name: 'P', path: '/prefabs/P.prefab.json' } });
    await load(buildPrefabEditScene(p3() as never));
    deleteEntitiesWithUndo([one('B')]);
    expect((await savePrefabEditReport()).saved).toBe(true);
    let root = await reopen();
    add('Add Y', root, 'Y');
    expect((await savePrefabEditReport()).saved).toBe(true);
    const y = rowsOf().Y!;
    expect(y.split(':')[0]).toBe('4');
    root = await reopen();
    void root;
    await undo(); // Add Y — recorded against Y's old guid, which the re-open replaced with a sentinel: a no-op
    await undo(); // delete B, from visit 1
    expect((await savePrefabEditReport()).saved).toBe(true);
    expect(uniqueIds()).toBe(true);
    expect(rowsOf().B).toBe('3:eeeeeeee-0000-4000-8000-000000169113');
    expect(rowsOf().Y).toBe(y);
  });

  it('a member deleted and brought back after a newcomer was saved keeps its own nodeGuid', async () => {
    // Close-out review 2, REVIEW-3. Mutation: stop raising the floor on a save (`rec.floor = …` in noteSessionRows) —
    // Z takes X's freed 3, and the undone X is written with Z's nodeGuid.
    const root = await openP();
    add('Add X', root, 'X');
    expect((await savePrefabEditReport()).saved).toBe(true);
    const x = rowsOf().X;
    deleteEntitiesWithUndo([one('X')]);
    expect((await savePrefabEditReport()).saved).toBe(true);
    add('Add Z', root, 'Z');
    expect((await savePrefabEditReport()).saved).toBe(true);
    await undo(); await undo();
    expect((await savePrefabEditReport()).saved).toBe(true);
    expect(rowsOf().X).toBe(x);
  });

  it('two live entities claiming one remembered row: neither keeps it, and the save stays unique', async () => {
    // Mutation: drop the `claims.get(lid) === 1` half in `collectPreservedLocalIds` — both are preserved at 3, and the
    // last-line check refuses the save.
    const root = await openP();
    const x = add('Add X', root, 'X');
    expect((await savePrefabEditReport()).saved).toBe(true);
    const twin = add('Add X twin', root, 'Twin');
    const { writeTraitField } = await import('@modoki/engine/runtime');
    writeTraitField(twin, getTraitByName('EntityAttributes')!, 'guid', getAllEntities().find((e) => e.id === x)!.guid!);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect((await savePrefabEditReport()).saved).toBe(true); } finally { err.mockRestore(); }
    expect(uniqueIds()).toBe(true);
  });

  it('a save that would put two rows at one localId is refused, and the file is left as it was', async () => {
    // The last line under the numbering (close-out review 2, finding 2): two forged sentinels for 2.
    // Mutation: drop the duplicate check at the end of serializePrefabEditWorld — the file is written with [1, 2, 2].
    const root = await openP();
    const before = JSON.stringify(prefabs.get(P));
    const forged = add('Add F', root, 'F');
    const { writeTraitField } = await import('@modoki/engine/runtime');
    writeTraitField(forged, getTraitByName('EntityAttributes')!, 'guid', '__prefab_edit_local__2');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await savePrefabEditReport()).saved).toBe(false);
      expect(String(err.mock.calls[0]?.[0])).toMatch(/two rows would share localId 2/);
    } finally { err.mockRestore(); }
    expect(JSON.stringify(prefabs.get(P))).toBe(before);
  });

  it('a remembered added member yields a number an Apply gave another row between two visits', async () => {
    // Close-out review 3, R1. Mutation: trust a remembered number whatever the current document holds there (drop the
    // `current` test in `collectPreservedLocalIds`) — the undone X is written at 3 with the nodeGuid the Apply gave Z,
    // and every scene key for Z lands on X.
    const NZ = 'eeeeeeee-0000-4000-8000-0000001699ff';
    const root = await openP();
    add('Add X', root, 'X');
    expect((await savePrefabEditReport()).saved).toBe(true);
    const x = rowsOf().X!;
    expect(x.split(':')[0]).toBe('3'); // precondition
    deleteEntitiesWithUndo([one('X')]);
    expect((await savePrefabEditReport()).saved).toBe(true);
    // An Apply from a scene instance, between the visits: a new row Z at max(localId)+1 = 3.
    const cur = JSON.parse(JSON.stringify(prefabs.get(P))) as PrefabFile;
    cur.entities.push(row(3, 'Z', 1, NZ) as never);
    prefabs.set(P, cur);
    await reopen();
    await undo(); // the delete of X, from a history the helper kept (the real re-open drops it, #1704)
    deleteEntitiesWithUndo([one('Z')]);
    expect((await savePrefabEditReport()).saved).toBe(true);
    expect(rowsOf().X).not.toBe(`3:${NZ}`);
    expect(rowsOf().X!.split(':')[1]).not.toBe(NZ);
    expect(uniqueIds()).toBe(true);
  });

  it('a number two entities claim goes to the opened row\'s sentinel, never to both', async () => {
    // The floor under `localIdFloor`. Mutation: drop the `held` test in `collectPreservedLocalIds` — a forged sentinel
    // for 3 and the remembered X at 3 are both preserved at 3.
    const root = await openP();
    add('Add X', root, 'X');
    expect((await savePrefabEditReport()).saved).toBe(true);
    expect(rowsOf().X!.split(':')[0]).toBe('3'); // precondition
    const forged = add('Add F', root, 'F');
    const { writeTraitField } = await import('@modoki/engine/runtime');
    writeTraitField(forged, getTraitByName('EntityAttributes')!, 'guid', '__prefab_edit_local__3');
    expect((await savePrefabEditReport()).saved).toBe(true);
    expect(uniqueIds()).toBe(true);
    expect(rowsOf().F!.split(':')[0]).toBe('3');
  });
});
