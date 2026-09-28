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
import { setActionCallback, pushAction, clearHistory, createEntityWithUndo, reparentEntity } from '@modoki/engine/editor';
import { isRuntimeGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { setPrefabCache, serializePrefab, detachPrefabInstance, instantiatePrefab, setPrefabSource, getCachedPrefabSync, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { buildPrefabEditScene, savePrefabEditReport, PREFAB_EDIT_ROOT_GUID, _resetPrefabEditSessionRows } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { deleteEntitiesWithUndo, undo } from '@modoki/engine/editor';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const O = 'cccccccc-0000-4000-8000-000000169101';
const P = 'cccccccc-0000-4000-8000-000000169102';
const INST = 'dddddddd-0000-4000-8000-000000169101';

const row = (localId: number, name: string, parentId: number, nodeGuid: string, prefab?: string) => ({
  localId, name, nodeGuid, ...(prefab ? { prefab } : {}),
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** P: R → A. */
const pDoc = () => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
  row(1, 'R', 0, 'eeeeeeee-0000-4000-8000-000000169111'), row(2, 'A', 1, 'eeeeeeee-0000-4000-8000-000000169112'),
] });
/** O: OR → Slot → N (a nested row of P), and OR → Slot2. */
const oDoc = () => ({ id: O, version: 5, name: 'O', rootLocalId: 1, entities: [
  row(1, 'OR', 0, 'eeeeeeee-0000-4000-8000-000000169121'), row(2, 'Slot', 1, 'eeeeeeee-0000-4000-8000-000000169122'),
  row(3, 'N', 2, 'eeeeeeee-0000-4000-8000-000000169123', P), row(4, 'Slot2', 1, 'eeeeeeee-0000-4000-8000-000000169124'),
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
const duplicateGuids = () => {
  const seen = new Map<string, number>();
  for (const e of getAllEntities()) if (e.guid && !isRuntimeGuid(e.guid)) seen.set(e.guid, (seen.get(e.guid) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([g]) => g);
};
const add = (label: string, parent: number, name: string) =>
  createEntityWithUndo(label, parent, [{ name: 'Transform', data: {} }, { name: 'EntityAttributes', data: { name, parentId: parent } }], () => {})!;
const parentName = (id: number) => getAllEntities().find((e) => e.id === getAllEntities().find((x) => x.id === id)?.parentId)?.name;

beforeEach(() => {
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

describe('#1687: the save partitions instance roots by identity, not by live parent', () => {
  const scene = (): SceneData => ({
    id: 'identity-owner', version: 16, name: 'S', resources: [],
    entities: [{ id: 1, prefab: O, guid: INST, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } } }],
  } as unknown as SceneData);

  for (const under of ['Slot2', 'OR'] as const) {
    it(`an owned nested root moved under a plain node added under ${under} is saved once, and stays once over two rounds`, async () => {
      // Mutation: partition by the LIVE parent again (`parentInfo?.traits.includes('PrefabInstance') && parentLocalId`)
      // — the root is written as its own top-level scene entry as well, and every round adds a copy: R 1 → 2 → 3.
      install(oDoc(), pDoc());
      await load(scene());
      const plain = add('Add Plain', one(under), 'Plain');
      expect(reparentEntity(one('R'), plain)).toBe(true);
      for (let round = 1; round <= 2; round++) {
        const saved = await serializeScene() as unknown as SceneData;
        expect(saved.entities.filter((e) => (e as { prefab?: string }).prefab === P)).toEqual([]);
        await load(saved);
        expect(byName('R')).toHaveLength(1);
        expect(byName('A')).toHaveLength(1);
        expect(parentName(one('R'))).toBe('Plain');
        expect(duplicateGuids()).toEqual([]);
      }
    });
  }

  it('control: the same root moved under Slot2 itself was already saved once', async () => {
    install(oDoc(), pDoc());
    await load(scene());
    expect(reparentEntity(one('R'), one('Slot2'))).toBe(true);
    const saved = await serializeScene() as unknown as SceneData;
    expect(saved.entities.filter((e) => (e as { prefab?: string }).prefab === P)).toEqual([]);
    await load(saved);
    expect(byName('R')).toHaveLength(1);
    expect(parentName(one('R'))).toBe('Slot2');
  });
});

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
    await runAgentOp('prefab', { action: 'create', entityGuid: getAllEntities().find((e) => e.id === root)!.guid, path: XPATH });
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
    await runAgentOp('prefab', { action: 'create', entityGuid: getAllEntities().find((e) => e.id === root)!.guid, path: XPATH });
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
      expect(res).toEqual({ refused: expect.stringMatching(/^Create Prefab refused — /) }); // shown, as the gate above is
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
  /** Leave and re-open P: a NEW edit world built from the last save, with the undo history kept (U27, `swapHistory`). */
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
    await undo(); // Add Y — recorded against Y's old guid, which the re-open replaced with a sentinel: a no-op (U27)
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
    await undo(); // the delete of X, from the kept history
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

describe('Detach strips the instance\'s IDENTITY subtree: a member of another frame dragged under it stays linked (#1691, I6)', () => {
  const Q = 'cccccccc-0000-4000-8000-000000169141';
  const O2 = 'cccccccc-0000-4000-8000-000000169142';
  /** Q: QR → QA. O2: OR → Slot, Keep. */
  const qDoc = () => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [
    row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000169141'), row(2, 'QA', 1, 'eeeeeeee-0000-4000-8000-000000169142'),
  ] });
  const o2Doc = () => ({ id: O2, version: 5, name: 'O2', rootLocalId: 1, entities: [
    row(1, 'OR', 0, 'eeeeeeee-0000-4000-8000-000000169143'), row(2, 'Slot', 1, 'eeeeeeee-0000-4000-8000-000000169144'),
    row(3, 'Keep', 1, 'eeeeeeee-0000-4000-8000-000000169145'),
  ] });
  const piOf = (id: number) => readTraitData(id, getTraitByName('PrefabInstance')!) as { rootInstanceId?: number } | null;

  it('detaching a user-added instance leaves the outer instance\'s member that was dragged under it linked, and it survives the reload', async () => {
    // Mutation: strip the LIVE tree again (`collectTree` without the identity filter) — Keep loses its link to O2, and
    // the save records O2's row as removed and Keep as a plain node.
    install(o2Doc(), qDoc());
    await load({ id: 'detach', version: 16, name: 'S', resources: [],
      entities: [{ id: 1, prefab: O2, guid: INST, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } } }] } as unknown as SceneData);
    const qRoot = instantiatePrefab(getCachedPrefabSync(Q) as PrefabFile, one('Slot'));
    setPrefabSource(qRoot, Q);
    await load(await serializeScene() as unknown as SceneData);
    expect(reparentEntity(one('Keep'), one('QA'))).toBe(true);
    const or = idOfGuid(INST);
    expect(piOf(one('Keep'))?.rootInstanceId).toBe(or); // precondition: still O2's member
    detachPrefabInstance(one('QR'));
    expect(piOf(one('QR'))).toBeNull();
    expect(piOf(one('QA'))).toBeNull();
    expect(piOf(one('Keep'))?.rootInstanceId).toBe(or);
    await load(await serializeScene() as unknown as SceneData);
    expect(byName('Keep')).toHaveLength(1);
    expect(piOf(one('Keep'))?.rootInstanceId).toBe(idOfGuid(INST));
    expect(parentName(one('Keep'))).toBe('QA');
    expect(duplicateGuids()).toEqual([]);
  });
});
