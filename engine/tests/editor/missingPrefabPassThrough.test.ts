/** A prefab reference that does not resolve at load keeps its authored record through a save (#1699).
 *
 *  Unity keeps a missing-asset instance's `PrefabInstance` data in the scene while the asset is gone, so the edits come
 *  back with it. Here the loader used to skip the reference, keep its record nowhere, and the next save wrote only what
 *  the live world held. One class, three members, one fixture each:
 *
 *  1. a TOP-LEVEL scene instance whose prefab is missing;
 *  2. a NESTED row whose child prefab is missing (the scene save, and the prefab-edit save of the outer template);
 *  3. a scene-ADDED reference node whose prefab is missing.
 *
 *  Each case saves once with every prefab present (the CONTROL), loads that save with one prefab missing, saves again,
 *  and asserts the second save writes the control's record. Then the prefab comes back and the reload shows the edits.
 *  Driven through the real loader and the real `serializeScene`. Each case names the mutation that turns it red. */


import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));
const writes: Array<{ path: string; content: string }> = [];
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string) => {
    writes.push({ path, content });
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  },
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import {
  setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, reparentEntity, deleteEntitiesWithUndo, undo, duplicateEntity,
} from '@modoki/engine/editor';
import { setPrefabCache, applyToPrefabSelective, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { buildPrefabEditScene, serializePrefabEditWorld, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { snapshotEntity, respawnFromSnapshot, regenerateSnapshotGuids } from '../../packages/modoki/src/editor/undo/entityActions';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { memberToken } from '../../packages/modoki/src/runtime/core/templateRefs';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);
registerEditorAgentOps();

const P = 'cccccccc-0000-4000-8000-000000001699';
const Q = 'cccccccc-0000-4000-8000-000000001698';
const PQ = 'cccccccc-0000-4000-8000-000000001697';
const INST = 'dddddddd-0000-4000-8000-000000001699';
const QINST = 'dddddddd-0000-4000-8000-000000001698';
const gR = 'eeeeeeee-0000-4000-8000-000000001691';
const gA = 'eeeeeeee-0000-4000-8000-000000001692';
const gQR = 'eeeeeeee-0000-4000-8000-000000001693';
const gQX = 'eeeeeeee-0000-4000-8000-000000001694';
const gQrow = 'eeeeeeee-0000-4000-8000-000000001695';

const row = (localId: number, name: string, parentId: number, nodeGuid: string, x = 0) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x, y: 0, z: 0 } },
});
/** P = R → A. */
const pDoc = () => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [row(1, 'R', 0, gR), row(2, 'A', 1, gA)] });
/** Q = QR → QX. */
const qDoc = () => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0, gQR), row(2, 'QX', 1, gQX)] });
/** PQ = R → A, plus row 3 (Qrow, under R) expanding Q. */
const pqDoc = () => ({ id: PQ, version: 5, name: 'PQ', rootLocalId: 1, entities: [
  row(1, 'R', 0, gR), row(2, 'A', 1, gA),
  { localId: 3, name: 'Qrow', nodeGuid: gQrow, prefab: Q, traits: { EntityAttributes: { name: 'Qrow', parentId: 1, guid: '' } } },
] });
const install = (...docs: Array<{ id?: string }>) => { for (const d of docs) { prefabs.set(d.id!, d); setPrefabCache(d.id!, d as never); } };
const uninstall = (id: string) => { prefabs.delete(id); setPrefabCache(id, null); };

async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  await loadInto(data);
}
/** Load `data` into the CURRENT world, beside what it holds (an additive load). */
async function loadInto(data: SceneData): Promise<void> {
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

const meta = (t: string) => getTraitByName(t)!;
const rootOf = (guid: string) => getAllEntities().find((e) => e.guid === guid)!.id;
/** The entity named `name` in the subtree rooted at the entity with guid `guid` (the root itself included). */
const inside = (guid: string, name: string): number => {
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const root = rootOf(guid);
  const hits = all.filter((e) => {
    if (e.name !== name) return false;
    for (let cur: typeof e | undefined = e; cur; cur = byId.get(cur.parentId)) if (cur.id === root) return true;
    return false;
  });
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} entities named ${name} under ${guid}`);
  return hits[0]!.id;
};
const x = (id: number) => (readTraitData(id, meta('Transform')) as { x: number }).x;
const save = async () => JSON.parse(JSON.stringify(await serializeScene())) as SceneData;
const entryOf = (s: SceneData, guid: string) => (s.entities as unknown as Array<Record<string, unknown>>).find((e) => e.guid === guid);

/** Holder → a scene instance of `prefab` (guid INST). */
const scene = (prefab: string, extra: unknown[] = []): SceneData => ({
  id: 's1699', version: 16, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: 'dddddddd-0000-4000-8000-000000001600' } } },
    { id: 2, prefab, guid: INST, traits: { EntityAttributes: { name: 'Inst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } },
    ...extra,
  ],
} as unknown as SceneData);

beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  writes.length = 0;
  // Nothing is on disk: a prefab the cache does not hold is MISSING, not merely cold.
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
});
afterAll(() => { for (const id of [P, Q, PQ]) setPrefabCache(id, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

describe('a top-level instance whose prefab is missing keeps its entry (#1699, 1)', () => {
  it('the save writes the entry it read, and the edits come back with the prefab', async () => {
    install(pDoc());
    await load(scene(P));
    writeTraitFieldWithUndo(rootOf(INST), meta('Transform'), 'x', 1);
    writeTraitFieldWithUndo(inside(INST, 'A'), meta('Transform'), 'x', 5);
    const control = await save();
    const entry = entryOf(control, INST)!;
    expect(entry.members ?? entry.overrides).toBeTruthy(); // precondition: the control carries the edits

    uninstall(P);
    await load(control);
    const missing = await save();
    expect(entryOf(missing, INST)).toEqual(entry);

    install(pDoc());
    await load(missing);
    expect(x(rootOf(INST))).toBe(1);
    expect(x(inside(INST, 'A'))).toBe(5);
  });
});

describe('a nested row whose child prefab is missing keeps the frame\'s scene edits (#1699, 2)', () => {
  it('the scene save writes the frame\'s edits it read, and they come back with the child', async () => {
    install(qDoc(), pqDoc());
    await load(scene(PQ));
    writeTraitFieldWithUndo(inside(INST, 'QX'), meta('Transform'), 'x', 8);
    writeTraitFieldWithUndo(inside(INST, 'QR'), meta('Transform'), 'x', 4);
    const control = await save();
    const entry = entryOf(control, INST)!;

    uninstall(Q);
    await load(control);
    const missing = await save();
    expect(entryOf(missing, INST)).toEqual(entry);

    install(qDoc());
    await load(missing);
    expect(x(inside(INST, 'QX'))).toBe(8);
    expect(x(inside(INST, 'QR'))).toBe(4);
  });
});

describe('a scene-added reference node whose prefab is missing keeps its node (#1699, 3)', () => {
  it('the save writes the node it read, and it comes back with its prefab', async () => {
    install(pDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    writeTraitFieldWithUndo(inside(QINST, 'QX'), meta('Transform'), 'x', 7);
    const control = await save();
    const entry = entryOf(control, INST)!;
    expect(JSON.stringify(entry.added ?? entry.members)).toContain(QINST); // precondition: saved as an added node

    uninstall(Q);
    await load(control);
    const missing = await save();
    expect(entryOf(missing, INST)).toEqual(entry);

    install(qDoc());
    await load(missing);
    expect(x(inside(QINST, 'QX'))).toBe(7);
  });
});

/** Case 1's control, then the load with P missing: the saved control entry and the scene it came from. */
const loadWithPMissing = async () => {
  install(pDoc());
  await load(scene(P));
  writeTraitFieldWithUndo(rootOf(INST), meta('Transform'), 'x', 1);
  writeTraitFieldWithUndo(inside(INST, 'A'), meta('Transform'), 'x', 5);
  const control = await save();
  uninstall(P);
  await load(control);
  clearHistory();
  return entryOf(control, INST)!;
};

describe('the placeholder reads as missing and keeps its record until it is re-expanded (#1699)', () => {
  it('is marked for the Hierarchy, and an expansion clears the mark', async () => {
    // Mutation: drop the `missingPrefab` flag in `getAllEntities` — the first expectation fails.
    await loadWithPMissing();
    expect(getAllEntities().find((e) => e.guid === INST)!.missingPrefab).toBe(true);
    expect(getAllEntities().find((e) => e.guid === INST)!.name).toBe('R');
    install(pDoc());
    await load(await save());
    expect(getAllEntities().find((e) => e.guid === INST)!.missingPrefab).toBeUndefined();
  });

  it('a prefab restored with no reload still saves the record, not the empty placeholder', async () => {
    // Mutation: in `serializeScene`, check the marker only while its source does not fetch — the save writes the bare
    // placeholder, and the members row and the pose are gone.
    const entry = await loadWithPMissing();
    install(pDoc());
    expect(entryOf(await save(), INST)).toEqual(entry);
  });

  it('a scene entity under the placeholder stays its own entry when the prefab is restored with no reload', async () => {
    // Mutation: keep `PrefabInstance` on the placeholder (`keepUnresolvedEntry`) — the scene save's structural pre-pass
    // captures it as an instance of the restored P and claims Kid as an added node of an entry written from the record,
    // so Kid is in neither.
    const KID = 'dddddddd-0000-4000-8000-000000001601';
    install(pDoc());
    await load(scene(P));
    const control = await save();
    (control.entities as unknown[]).push({ id: 99, traits: { EntityAttributes: { name: 'Kid', parentId: INST, guid: KID } } });
    uninstall(P);
    await load(control);
    install(pDoc());
    const kid = (await save()).entities.find((e) => (e as { name?: string }).name === 'Kid') as { traits: { EntityAttributes: { guid: string; parentId: string } } } | undefined;
    expect(kid?.traits.EntityAttributes).toMatchObject({ guid: KID, parentId: INST });
  });

  it('a restored child prefab with no reload keeps an added node', async () => {
    // Mutation: in `captureChild`, check the marker only when the child is not cached — the node is captured as a plain
    // added entity, and its record is gone.
    install(pDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    writeTraitFieldWithUndo(inside(QINST, 'QX'), meta('Transform'), 'x', 7);
    // The node's ROOT edit rides its `overrides`, which only the record carries: the orphan store keeps its member rows
    // under the placeholder's guid either way, so a node with member-row edits alone could not tell the two apart.
    writeTraitFieldWithUndo(rootOf(QINST), meta('Transform'), 'x', 2);
    const control = await save();
    expect(JSON.stringify(entryOf(control, INST))).toContain('"x":2'); // precondition: the root edit is in the node
    uninstall(Q);
    await load(control);
    install(qDoc());
    expect(entryOf(await save(), INST)).toEqual(entryOf(control, INST));
  });
});

describe('the placeholder\'s lifecycle (#1699)', () => {
  it('a deleted placeholder saves as gone, and its undo brings the record back', async () => {
    // Mutation: drop `UnresolvedPrefabRef` from `CARRIED_MARKER_TRAITS` — the undone placeholder saves bare.
    const entry = await loadWithPMissing();
    deleteEntitiesWithUndo([rootOf(INST)]);
    expect(entryOf(await save(), INST)).toBeUndefined();
    await undo();
    expect(entryOf(await save(), INST)).toEqual(entry);
  });

  it('a duplicate keeps the record under identities of its own, and both come back with the prefab', async () => {
    // Mutation: drop the `UnresolvedPrefabRef` carry in `regenerateSnapshotGuids` — the copy saves as a bare
    // placeholder. Dropping only the re-guiding (`copyUnresolvedRef` returning the data as is) fails the guid checks.
    const entry = await loadWithPMissing();
    const copyId = duplicateEntity(rootOf(INST), () => {})!;
    const copyGuid = getAllEntities().find((e) => e.id === copyId)!.guid!;
    expect(copyGuid).not.toBe(INST);
    const saved = await save();
    expect(entryOf(saved, INST)).toEqual(entry);
    const copy = entryOf(saved, copyGuid)!;
    expect(copy.overrides).toEqual(entry.overrides);
    const pinOf = (e: Record<string, unknown>) => Object.values(e.members as Record<string, { guid?: string; traits?: unknown }>)[0]!;
    expect(pinOf(copy).traits).toEqual(pinOf(entry).traits);
    expect(pinOf(copy).guid).toBeTruthy();
    expect(pinOf(copy).guid).not.toBe(pinOf(entry).guid);
    expect((copy.traits as { PrefabInstance: { rootInstanceId: string } }).PrefabInstance.rootInstanceId).toBe(copyGuid);

    install(pDoc());
    await load(saved);
    expect(x(inside(INST, 'A'))).toBe(5);
    expect(x(inside(copyGuid, 'A'))).toBe(5);
    expect(inside(copyGuid, 'A')).not.toBe(inside(INST, 'A'));
  });

  it('a rename and a move are kept: identity and placement come from the live placeholder', async () => {
    // Mutation: write the record's `name` in `asSceneEntry` — the rename is lost.
    const entry = await loadWithPMissing();
    writeTraitFieldWithUndo(rootOf(INST), meta('EntityAttributes'), 'name', 'Renamed');
    reparentEntity(rootOf(INST), 0);
    const saved = entryOf(await save(), INST)!;
    expect(saved.name).toBe('Renamed');
    expect((saved.traits as Record<string, unknown>).EntityAttributes).toBeUndefined();
    expect({ ...saved, name: entry.name, traits: entry.traits }).toEqual(entry);
  });
});

describe('a rebuild respawns a missing added node\'s placeholder (#1699, the editor twin)', () => {
  it('an Apply that rebuilds the instance keeps the node', async () => {
    // Mutation: drop `spawnUnresolvedReference` from the EDITOR's `spawnNestedInstance` — the rebuild spawns nothing
    // for the node, and the save loses it.
    install(pDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    writeTraitFieldWithUndo(inside(QINST, 'QX'), meta('Transform'), 'x', 7);
    const control = await save();
    uninstall(Q);
    await load(control);
    writeTraitFieldWithUndo(inside(INST, 'A'), meta('Transform'), 'z', 3);
    const keys = collectInstanceOverrideKeys(rootOf(INST), prefabs.get(P) as PrefabFile);
    expect((await applyToPrefabSelective(rootOf(INST), new Set(keys.fields))).applied).toBe(true);
    expect(getAllEntities().find((e) => e.guid === QINST)?.missingPrefab).toBe(true); // precondition: it was respawned
    const node = (entryOf(await save(), INST)!.members as Record<string, { added?: unknown[] }>)[`/${gA}`]!.added;
    expect(node).toEqual((entryOf(control, INST)!.members as Record<string, { added?: unknown[] }>)[`/${gA}`]!.added);
  });
});

describe('the prefab-edit save of a template whose reference row\'s child is missing (#1699, 2)', () => {
  /** PQ with its Qrow carrying an edit into Q. */
  const pqEdited = (): PrefabFile => {
    const d = pqDoc() as unknown as PrefabFile;
    (d.entities[2] as unknown as Record<string, unknown>).overrides = { 2: { Transform: { x: 3 } } };
    return d;
  };
  const openPQ = async (doc: PrefabFile) => {
    install(doc);
    await load(buildPrefabEditScene(doc) as SceneData);
    expect(getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)).toBeDefined();
  };

  it('writes the row as the file held it', async () => {
    // Mutation: pass no `unresolvedRows` to `serializePrefab` — Qrow is written as an empty plain row.
    const doc = pqEdited();
    await openPQ(doc);
    const out = serializePrefabEditWorld(PQ);
    if ('error' in out) throw new Error(out.error);
    expect(out.prefab.entities.find((e) => e.localId === 3)).toEqual(doc.entities[2]);
  });

  it('a row whose edits name a member of the prefab is written from the file, and a copy of it is refused', async () => {
    // Mutation: build the ORIGINAL's row from its record too (drop the baseline branch) — the member token comes back
    // as the edit world's own id for A. Dropping the refusal writes that id into the copy's row instead.
    const doc = pqEdited();
    const token = memberToken(1, [2]);
    (doc.entities[2] as unknown as Record<string, unknown>).overrides = { 2: { UIAction: { target: token } } };
    await openPQ(doc);
    const out = serializePrefabEditWorld(PQ);
    if ('error' in out) throw new Error(out.error);
    expect(out.prefab.entities.find((e) => e.localId === 3)).toEqual(doc.entities[2]);
    duplicateEntity(getAllEntities().find((e) => e.name === 'Qrow')!.id, () => {});
    const refused = serializePrefabEditWorld(PQ);
    expect('error' in refused && refused.error).toMatch(/copy of a reference to a missing prefab/);
  });

  it('a duplicate of the row is written as a second reference row with an identity of its own', async () => {
    const doc = pqEdited();
    await openPQ(doc);
    duplicateEntity(getAllEntities().find((e) => e.name === 'Qrow')!.id, () => {});
    const out = serializePrefabEditWorld(PQ);
    if ('error' in out) throw new Error(out.error);
    const rows = out.prefab.entities.filter((e) => e.prefab === Q);
    expect(rows.length).toBe(2);
    expect(rows[1]!.localId).not.toBe(rows[0]!.localId);
    expect(rows[1]!.nodeGuid).not.toBe(rows[0]!.nodeGuid);
    expect(rows[1]!.overrides).toEqual(rows[0]!.overrides);
  });
});

describe('a placeholder is not an instance of the prefab once it resolves (#1699 close-out review)', () => {
  const INST2 = 'dddddddd-0000-4000-8000-000000001602';
  const written = (id: string) => writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((p) => p.id === id).pop();

  it('an Apply on another instance does not rebuild the placeholder', async () => {
    // Mutation: keep `PrefabInstance` on the placeholder (`keepUnresolvedEntry`) — the Apply's fan-out captures it
    // empty against the restored P, rebuilds it, and the save writes a removed A and a removed root Transform.
    const entry = await loadWithPMissing();
    install(pDoc());
    await loadInto({ id: 's2', version: 16, name: 'S2', resources: [], entities: [{ id: 1, prefab: P, guid: INST2, traits: {} }] } as unknown as SceneData);
    writeTraitFieldWithUndo(inside(INST2, 'A'), meta('Transform'), 'y', 9);
    const keys = collectInstanceOverrideKeys(rootOf(INST2), prefabs.get(P) as PrefabFile);
    expect((await applyToPrefabSelective(rootOf(INST2), new Set(keys.fields))).applied).toBe(true);
    expect(entryOf(await save(), INST)).toEqual(entry);
    expect(getAllEntities().find((e) => e.guid === INST)!.missingPrefab).toBe(true);
  });

  it('the placeholder offers nothing to Apply, and nothing is written into the prefab', async () => {
    // Mutation: the same — the placeholder lists every member of P as removed, and applying that deletes A from P.
    await loadWithPMissing();
    install(pDoc());
    let applied = false;
    try {
      const keys = collectInstanceOverrideKeys(rootOf(INST), prefabs.get(P) as PrefabFile);
      applied = (await applyToPrefabSelective(rootOf(INST), new Set(keys.all))).applied;
    } catch { /* not an instance: nothing to list */ }
    expect(applied).toBe(false);
    expect(written(P)).toBeUndefined();
  });

  it('a node re-expanded from its record takes a later edit of its members', async () => {
    // Mutation: keep a node placeholder's rows in the loader's orphan store (drop the marker test before
    // `applyStoredMemberRows`) — the settle after the second Apply puts QX.x back to 7.
    install(pDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    writeTraitFieldWithUndo(inside(QINST, 'QX'), meta('Transform'), 'x', 7);
    const control = await save();
    uninstall(Q);
    await load(control);
    install(qDoc());
    writeTraitFieldWithUndo(inside(INST, 'A'), meta('Transform'), 'z', 3);
    let keys = collectInstanceOverrideKeys(rootOf(INST), prefabs.get(P) as PrefabFile);
    expect((await applyToPrefabSelective(rootOf(INST), new Set(keys.fields))).applied).toBe(true);
    expect(x(inside(QINST, 'QX'))).toBe(7); // precondition: the Apply re-expanded the node from its record
    writeTraitFieldWithUndo(inside(QINST, 'QX'), meta('Transform'), 'x', 20);
    writeTraitFieldWithUndo(inside(QINST, 'QX'), meta('Transform'), 'y', 1);
    keys = collectInstanceOverrideKeys(rootOf(QINST), prefabs.get(Q) as PrefabFile);
    const y = keys.fields.filter((k) => k.endsWith('.y'));
    expect(y.length).toBe(1);
    expect((await applyToPrefabSelective(rootOf(QINST), new Set(y))).applied).toBe(true);
    expect(x(inside(QINST, 'QX'))).toBe(20);
  });

  it('Apply refuses a key naming a missing reference, and Create Prefab refuses a tree holding one', async () => {
    // Mutations: drop the refusal in `planApply` — the node is taken out of the instance and promoted as nothing; drop
    // the one in `createPrefabFromEntity` — the template gets an empty row where the reference was.
    install(pDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    const control = await save();
    uninstall(Q);
    await load(control);
    const keys = collectInstanceOverrideKeys(rootOf(INST), prefabs.get(P) as PrefabFile);
    const all = keys.all;
    expect(all.some((k) => k.includes(QINST))).toBe(true); // precondition: the listing names the node
    const res = await applyToPrefabSelective(rootOf(INST), new Set(all));
    expect(res.applied).toBe(false);
    expect(res.refused).toMatch(/missing prefab/);
    expect(written(P)).toBeUndefined();
    const created = await createPrefabFromEntity(rootOf(INST), 'prefabs/New.prefab.json', 'New', async () => true);
    expect(created && typeof created === 'object' && 'refused' in created ? created.refused : '').toMatch(/missing prefab/);
  });
});

describe('the template writers refuse a missing reference wherever it sits (#1699 re-review)', () => {
  const N = 'dddddddd-0000-4000-8000-000000001603';
  const written = (id: string) => writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((p) => p.id === id).pop();
  /** INST of P with a plain scene node N under A, and QINST under N; QX.x = 7; reloaded with Q missing. */
  const underPlainNode = async () => {
    install(pDoc(), qDoc());
    await load(scene(P, [
      { id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } },
      { id: 4, traits: { EntityAttributes: { name: 'N', parentId: 'dddddddd-0000-4000-8000-000000001600', guid: N } } },
    ]));
    reparentEntity(rootOf(N), inside(INST, 'A'));
    reparentEntity(rootOf(QINST), rootOf(N));
    writeTraitFieldWithUndo(inside(QINST, 'QX'), meta('Transform'), 'x', 7);
    const control = await save();
    uninstall(Q);
    await load(control);
    return control;
  };

  it('Apply refuses an added node whose subtree holds one', async () => {
    // Mutation: match the placeholder's guid in the key TEXT again — the key is `+added.<N>`, which names no
    // placeholder, and Apply promotes an empty Q row into P and drops QINST.
    await underPlainNode();
    const keys = collectInstanceOverrideKeys(rootOf(INST), prefabs.get(P) as PrefabFile);
    expect(keys.all.some((k) => k.includes(N))).toBe(true); // precondition
    const res = await applyToPrefabSelective(rootOf(INST), new Set(keys.all));
    expect(res.refused).toMatch(/missing prefab/);
    expect(written(P)).toBeUndefined();
  });

  it('the agent prefab create op refuses a tree holding one', async () => {
    // Mutation: drop the refusal in the agent op — it writes a template with an empty row where the reference was.
    await underPlainNode();
    await expect(runAgentOp('prefab', { action: 'create', entityGuid: INST, path: 'prefabs/Made.prefab.json' })).rejects.toThrow(/missing prefab/);
    expect(writes.length).toBe(0);
  });

  it('the prefab-edit save refuses a pasted scene placeholder, whose record states scene guids', async () => {
    // Mutation: drop the stated-guid test in `serializePrefabEditWorld` — Q's template gets a member row pinning a
    // scene guid, which every instance of Q would then stamp on its member.
    await loadWithPMissing();
    const snap = snapshotEntity(rootOf(INST))!;
    install(qDoc());
    await load(buildPrefabEditScene(qDoc() as unknown as PrefabFile) as SceneData);
    const editRoot = getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!;
    respawnFromSnapshot(regenerateSnapshotGuids(snap), editRoot.id);
    const out = serializePrefabEditWorld(Q);
    expect('error' in out && out.error).toMatch(/cannot hold/);
  });

  it('a rebuild fetches a placeholder\'s prefab, so one restored on disk re-expands', async () => {
    // Mutation: drop the marker's source from `preloadNestedPrefabsForSubtree` — the editor cache stays cold for Q, the
    // rebuild respawns the placeholder, and QX is not there.
    registerAsset(Q, '/assets/q1699.prefab.json', 'prefab');
    install(pDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    writeTraitFieldWithUndo(inside(QINST, 'QX'), meta('Transform'), 'x', 7);
    const control = await save();
    uninstall(Q);
    await load(control);
    // Q is back on disk (the fetch answers it) and in the runtime cache, but the editor cache has not seen it.
    prefabs.set(Q, qDoc());
    vi.stubGlobal('fetch', async (url: string) => String(url).includes('q1699')
      ? { ok: true, status: 200, json: async () => qDoc(), text: async () => JSON.stringify(qDoc()) }
      : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
    writeTraitFieldWithUndo(inside(INST, 'A'), meta('Transform'), 'z', 3);
    const keys = collectInstanceOverrideKeys(rootOf(INST), prefabs.get(P) as PrefabFile);
    expect((await applyToPrefabSelective(rootOf(INST), new Set(keys.fields))).applied).toBe(true);
    expect(x(inside(QINST, 'QX'))).toBe(7);
  });
});

describe('the template refusals ask what is promoted or written, not the live tree (#1699 narrow review)', () => {
  const N = 'dddddddd-0000-4000-8000-000000001604';

  it('Apply promotes an added node while a placeholder under a member moved into it stays behind', async () => {
    // Mutation: walk the node's LIVE subtree in `planApply` — QINST hangs under A, which was moved into N, so the Apply
    // of N and the move is refused although promoting N leaves QINST with A.
    install(pDoc(), qDoc());
    await load(scene(P, [
      { id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } },
      { id: 4, traits: { EntityAttributes: { name: 'N', parentId: 'dddddddd-0000-4000-8000-000000001600', guid: N } } },
    ]));
    reparentEntity(rootOf(N), rootOf(INST));
    reparentEntity(inside(INST, 'A'), rootOf(N));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    writeTraitFieldWithUndo(inside(QINST, 'QX'), meta('Transform'), 'x', 7);
    const control = await save();
    uninstall(Q);
    await load(control);
    const keys = collectInstanceOverrideKeys(rootOf(INST), prefabs.get(P) as PrefabFile);
    const picked = keys.all.filter((k) => k === `+added.${N}` || k.startsWith('~moved.'));
    expect(picked.length).toBe(2); // precondition: N's key and A's move
    const res = await applyToPrefabSelective(rootOf(INST), new Set(picked));
    expect(res.refused).toBeUndefined();
    expect(res.applied).toBe(true);
    expect(getAllEntities().find((e) => e.guid === QINST)?.missingPrefab).toBe(true);
  });

  it('the prefab-edit save refuses an added reference node whose prefab is missing', async () => {
    // Mutation: skip node-kind placeholders in `serializePrefabEditWorld` again — the save succeeds and writes QR as a
    // plain row with no prefab and no record.
    install(pDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    writeTraitFieldWithUndo(inside(QINST, 'QX'), meta('Transform'), 'x', 7);
    const control = await save();
    uninstall(Q);
    await load(control);
    const snap = snapshotEntity(rootOf(QINST))!;
    await load(buildPrefabEditScene(pDoc() as unknown as PrefabFile) as SceneData);
    const editRoot = getAllEntities().find((e) => e.guid === PREFAB_EDIT_ROOT_GUID)!;
    respawnFromSnapshot(regenerateSnapshotGuids(snap), editRoot.id);
    const out = serializePrefabEditWorld(P);
    expect('error' in out && out.error).toMatch(/missing prefab/);
  });
});
