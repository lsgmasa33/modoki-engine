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

import { ownNodes } from './v10Rows';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    getCachedPrefab: (ref: string) => prefabs.get(ref),
    // A write the editor lands replaces the loader's copy, as the real cache does for a prefab a loaded scene owns: a
    // stand-in that kept the old document had every reader after a Replace fold the tree against it (#2001 S8b).
    replaceCachedPrefab: (ref: string, data: unknown) => {
      (real.replaceCachedPrefab as (r: string, d: unknown) => void)(ref, data);
      for (const k of [ref, (data as { id?: string } | null)?.id]) if (k && prefabs.has(k)) prefabs.set(k, JSON.parse(JSON.stringify(data)));
    },
    loadModelTemplates: async () => {},
  };
});
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
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache, getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { withKeptStateBake, bakingKeptStateForTest } from '../../packages/modoki/src/editor/scene/prefabTokens';
import { instantiatePrefab } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { refreshInstances, rebaseStaleInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { serializePrefab } from '../../packages/modoki/src/editor/scene/prefabSerialize';
import { applyToPrefabSelective } from '../../packages/modoki/src/editor/scene/prefabApply';
import { revertOverridesSelective } from '../../packages/modoki/src/editor/scene/prefabRevert';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { expandsToRoot } from '../../packages/modoki/src/runtime/loaders/prefabRoot';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { buildPrefabEditScene, serializePrefabEditWorld, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { applyAssetPathMoves } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { snapshotEntity, respawnFromSnapshot, copySnapshot, pasteEntityCopy, clipEntity, siblingDropRefusal } from '../../packages/modoki/src/editor/undo/entityActions';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { redo } from '../../packages/modoki/src/editor/undo/undoManager';
import { tagCreatedPrefab } from '../../packages/modoki/src/editor/scene/prefabLink';
import { registerAsset, resolveRef, resolveGuidToPath, getGuidForPath } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { asAddedNode, nodePlacement } from '../../packages/modoki/src/runtime/loaders/unresolvedPrefabRefs';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { memberToken } from '../../packages/modoki/src/runtime/core/templateRefs';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { overrideKeysOf } from '../../packages/modoki/src/editor/instance/instanceOverrideView';
import { placeholderWriteRefusal } from '../../packages/modoki/src/editor/undo/placeholderGate';

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
/** What the disk holds at `url` (#1880 W: every write reads its file first): the last write there, else an INSTALLED
 *  prefab's document — installed means on disk. Null for anything else: a prefab the cache does not hold is MISSING. */
const onDisk = (url: string): Response | null => {
  const last = writes.filter((w) => url.endsWith(w.path)).pop();
  if (last) return new Response(last.content, { status: 200 });
  const id = [...prefabs.keys()].find((k) => url.endsWith(k));
  return id ? new Response(JSON.stringify(prefabs.get(id)), { status: 200 }) : null;
};

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
    // The load's reader serves the scene's copy of a missing prefab (#1935): a top-level instance live at the save expands
    // from it, so this harness reads its own map first and the handed reader after it, as `SceneManager` reads its cache.
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure, load) => {
      const id = instantiatePrefabIntoWorld(
        getCurrentWorld(), (prefabs.get(source) ?? load?.read(source)) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure,
        { frame: load?.frame, sceneVersion: load?.sceneVersion },
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
/** The record a missing-prefab save writes, compared BYTE for byte with the control's: `toEqual` ignores key order, and a
 *  re-emit that reorders a node's keys churned every no-edit save of the file (#1722). */
const expectSameBytes = (got: unknown, want: unknown) => expect(JSON.stringify(got)).toBe(JSON.stringify(want));
const entryOf = (s: SceneData, guid: string) => (s.entities as unknown as Array<Record<string, unknown>>).find((e) => e.guid === guid);
type Rows = Record<string, { guid?: string; name?: string; traits?: Record<string, Record<string, unknown>> } & Record<string, unknown>>;
const rowsOf = (entry: Record<string, unknown>) => (entry.members ?? {}) as Rows;
/** What a scene v20 entry states of its root's `EntityAttributes` (#2001 S6): the placement on the entry's own traits (its
 *  order; `parentId` left out), and the other fields on the `/` row (the name left out: that row states it always). */
const rootEa = (entry: Record<string, unknown>): Record<string, unknown> => {
  const { parentId: _p, ...placed } = ((entry.traits as Record<string, Record<string, unknown>> | undefined)?.EntityAttributes ?? {});
  const { name: _n, ...row } = (rowsOf(entry)['/']?.traits?.EntityAttributes ?? {});
  return { ...row, ...placed };
};
/** The `EntityAttributes` fields the `/` row states beside the name. */
const rootRowEa = (entry: Record<string, unknown>): Record<string, unknown> => {
  const { name: _n, ...row } = (rowsOf(entry)['/']?.traits?.EntityAttributes ?? {});
  return row;
};

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
  // Nothing but the installed prefabs is on disk: a prefab the cache does not hold is MISSING, not merely cold.
  vi.stubGlobal('fetch', async (url: string) => onDisk(String(url)) ?? ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
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
    expectSameBytes(entryOf(missing, INST), entry);

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
    expectSameBytes(entryOf(missing, INST), entry);

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
    expectSameBytes(entryOf(missing, INST), entry);

    install(qDoc());
    await load(missing);
    expect(x(inside(QINST, 'QX'))).toBe(7);
  });
});

// Both branches of the re-emit write `captureNestedRef`'s key order, so a no-edit save writes the bytes it read (#1722).
// Case 3 above drives the NODE branch through the save; this pins the ENTRY branch (a top-level placeholder dragged
// under a member), whose record is a scene entry. Mutation: the old `{ ...base, parentLocalId, ...identity, name, prefab }`.
describe('a missing-prefab reference node is re-emitted in the writer\'s key order (#1722)', () => {
  it('an entry record dragged under a member: identity first, then the channels in their own order', () => {
    const entry = { name: 'Old', traits: { EntityAttributes: { name: 'Old' } }, prefab: Q, overrides: { 1: { Transform: { x: 2 } } }, members: { '/g': { name: 'QX' } }, guid: QINST };
    const node = asAddedNode('entry', entry, Q, { name: 'QInst', parentLocalId: 2, identity: { guid: QINST }, order: { sortOrder: 0, isActive: true } });
    expect(Object.keys(node)).toEqual(['parentLocalId', 'guid', 'name', 'traits', 'children', 'prefab', 'overrides', 'members']);
    expect(node.traits).toEqual({}); // an entry's root traits are not a node's (docs/prefabs.md § A missing prefab keeps its record)
  });

  it('a node record keeps its traits\' key order, with the live order written in place (#1901)', () => {
    // Mutation: build the node's EntityAttributes from the live order first, then the record's — a record stating
    // isActive before sortOrder is re-emitted the other way round, and a no-edit save churns the file.
    const rec = { parentLocalId: 1, guid: QINST, name: 'QInst', traits: { EntityAttributes: { isActive: false, sortOrder: 2 } }, children: [], prefab: Q };
    const node = asAddedNode('node', rec, Q, { name: 'QInst', parentLocalId: 1, identity: { guid: QINST }, order: { sortOrder: 4, isActive: false } });
    expect(JSON.stringify(node.traits)).toBe(JSON.stringify({ EntityAttributes: { isActive: false, sortOrder: 4 } }));
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

  it('a scene entity under the placeholder is kept when the prefab is restored with no reload', async () => {
    // A user's node at a placeholder is the record's own content (§ 10.4b, #2001 S8b): the save states it once, by guid,
    // on the entry's "/" row, and a reload hangs it back under the instance. The load links it there (`buildParentLinks`).
    // Mutation: that link not written — Kid is in neither the entry nor an entity of its own. (Before S8b's records the
    // guard was `keepUnresolvedEntry` dropping `PrefabInstance` from the placeholder; the save no longer reaches it here.)
    const KID = 'dddddddd-0000-4000-8000-000000001601';
    install(pDoc());
    await load(scene(P));
    const control = await save();
    (control.entities as unknown[]).push({ id: 99, traits: { EntityAttributes: { name: 'Kid', parentId: INST, guid: KID } } });
    uninstall(P);
    await load(control);
    install(pDoc());
    const saved = await save();
    const own = ((entryOf(saved, INST) as { members?: Record<string, { own?: Array<{ guid: string }> }> }).members?.['/']?.own ?? []);
    expect(own.map((n) => n.guid)).toEqual([KID]);
    expect(saved.entities.filter((e) => (e as { name?: string }).name === 'Kid')).toEqual([]);
    await load(saved);
    expect(getAllEntities().find((e) => e.guid === KID)?.parentId).toBe(getAllEntities().find((e) => e.guid === INST)!.id);
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
    // Mutation: drop the `UnresolvedPrefabRef` carry in `copySnapshot` — the copy saves as a bare
    // placeholder. Dropping only the re-guiding (`copyUnresolvedRef` returning the data as is) fails the guid checks.
    const entry = await loadWithPMissing();
    const copyId = duplicateEntity(rootOf(INST), () => {})!;
    const copyGuid = getAllEntities().find((e) => e.id === copyId)!.guid!;
    expect(copyGuid).not.toBe(INST);
    const saved = await save();
    expect(entryOf(saved, INST)).toEqual(entry);
    const copy = entryOf(saved, copyGuid)!;
    // The same records but the copy's own place: the root's order is the entry's placement, which the duplicate's position sets.
    expect(rowsOf(copy)['/']).toEqual(rowsOf(entry)['/']);
    expect(rootEa(copy).sortOrder).not.toBe(rootEa(entry).sortOrder);
    const pinOf = (e: Record<string, unknown>) => rowsOf(e)[`/${gA}`]!;
    expect(pinOf(copy).traits).toEqual(pinOf(entry).traits);
    expect(pinOf(copy).guid).toBeTruthy();
    expect(pinOf(copy).guid).not.toBe(pinOf(entry).guid);
    expect(copy.prefab).toBe(P);

    install(pDoc());
    await load(saved);
    expect(x(inside(INST, 'A'))).toBe(5);
    expect(x(inside(copyGuid, 'A'))).toBe(5);
    expect(inside(copyGuid, 'A')).not.toBe(inside(INST, 'A'));
  });

  it('a duplicate\'s refs between its record and the entities copied with it follow the copy, both ways (#1763)', async () => {
    // Member A (in the record) targets Kid, a plain child of the placeholder; Kid targets A's pinned guid. It is also the
    // test of the save's own rule that a guid inside a component's VALUE states no node (#2001 S6, `consumedBy` in
    // `instanceSave.ts`): read as a statement, Kid was written nowhere and one Kid of two reloaded (measured). Mutations:
    // `copyUnresolvedRef` given only the record's own mints (the pre-fix remap) — the copy's A still drives the original
    // Kid; the trait loop given `planCopyGuids`' `remap` — the copy's Kid still drives the original's A.
    const KID = 'dddddddd-0000-4000-8000-000000001607';
    const UIA = (target: string) => ({ bindings: [{ event: 'click', kind: 'call', action: 'noop', target }] });
    const targetOf = (id: number) => (readTraitData(id, meta('UIAction')) as { bindings: { target: string }[] }).bindings[0]!.target;
    install(pDoc());
    await load(scene(P));
    writeTraitFieldWithUndo(inside(INST, 'A'), meta('Transform'), 'x', 5);
    const control = await save();
    const entry = entryOf(control, INST)! as { members: Record<string, { guid: string; traits: Record<string, unknown> }> };
    const pinA = entry.members[`/${gA}`]!;
    pinA.traits.UIAction = UIA(KID);
    (control.entities as unknown[]).push({ id: 99, traits: { EntityAttributes: { name: 'Kid', parentId: INST, guid: KID }, UIAction: UIA(pinA.guid) } });
    uninstall(P);
    await load(control);
    clearHistory();
    const copyId = duplicateEntity(rootOf(INST), () => {})!;
    const copyGuid = getAllEntities().find((e) => e.id === copyId)!.guid!;
    const saved = await save();

    install(pDoc());
    await load(saved);
    const kids = getAllEntities().filter((e) => e.name === 'Kid');
    const copyKid = kids.find((e) => e.guid !== KID)!;
    expect(kids.map((e) => e.guid).sort()).toEqual([KID, copyKid.guid].sort());
    expect(targetOf(inside(INST, 'A'))).toBe(KID);
    expect(targetOf(inside(copyGuid, 'A'))).toBe(copyKid.guid);
    expect(targetOf(rootOf(KID))).toBe(getAllEntities().find((e) => e.id === inside(INST, 'A'))!.guid);
    expect(targetOf(copyKid.id)).toBe(getAllEntities().find((e) => e.id === inside(copyGuid, 'A'))!.guid);
  });

  it('a duplicate of a MEMBER holding a node placeholder keeps the placeholder\'s record (#1762)', async () => {
    // The member copy is stripped of `PrefabInstance` (it becomes an added node); the placeholder under it must keep its
    // record through that (#1756 removed the strip that dropped it). Mutation: in `copySnapshot.markersOf`, skip
    // `UnresolvedPrefabRef` on a node under a 'strip'-linked one — the copy's QInst saves bare and only the original's QX
    // comes back.
    install(pDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    writeTraitFieldWithUndo(inside(QINST, 'QX'), meta('Transform'), 'x', 7);
    const control = await save();
    uninstall(Q);
    await load(control);
    clearHistory();
    const copyA = duplicateEntity(inside(INST, 'A'), () => {})!;
    const copyKids = getAllEntities().filter((e) => e.parentId === copyA);
    expect(copyKids.map((e) => e.missingPrefab)).toEqual([true]);
    const saved = await save();

    install(qDoc());
    await load(saved);
    const qx = getAllEntities().filter((e) => e.name === 'QX');
    expect(qx.map((e) => x(e.id))).toEqual([7, 7]);
    expect(new Set(qx.map((e) => e.guid)).size).toBe(2);
  });

  it('a rename and a move are kept: identity and placement come from the live placeholder', async () => {
    // Mutation: write the record's `name` in `asSceneEntry` — the rename is lost.
    const entry = await loadWithPMissing();
    writeTraitFieldWithUndo(rootOf(INST), meta('EntityAttributes'), 'name', 'Renamed');
    reparentEntity(rootOf(INST), 0);
    const saved = entryOf(await save(), INST)!;
    expect(saved.name).toBe('Renamed');
    expect(rowsOf(saved)['/']!.traits!.EntityAttributes).toEqual({ name: 'Renamed' });
    expect((saved.traits as Record<string, unknown>).EntityAttributes, 'the top level: no parent stated').toEqual({ sortOrder: 0 });
    const rootRow = { ...rowsOf(saved)['/'], traits: { ...rowsOf(saved)['/']!.traits, EntityAttributes: { name: entry.name } } };
    expect({ ...saved, name: entry.name, traits: entry.traits, members: { ...rowsOf(saved), '/': rootRow } }).toEqual(entry);
  });
});

describe('a placeholder takes the sibling position its entry states as a ROOT override (#1850)', () => {
  const sortOrder = (id: number) => (readTraitData(id, meta('EntityAttributes')) as { sortOrder: number }).sortOrder;
  const rootOverride = rootEa;
  async function reorderedThenMissing() {
    install(pDoc());
    await load(scene(P));
    writeTraitFieldWithUndo(rootOf(INST), meta('EntityAttributes'), 'sortOrder', 3);
    const control = await save();
    const entry = entryOf(control, INST)!;
    expect(rootOverride(entry)?.sortOrder).toBe(3); // precondition: a live instance's save states its root's order
    expect(rootRowEa(entry).sortOrder, 'in one home: the entry\'s placement, not the / row').toBeUndefined();
    uninstall(P);
    await load(control);
    clearHistory();
    return entry;
  }

  it('the placeholder loads with it, so the save orders it as the live instance was ordered, byte for byte', async () => {
    // Mutation: drop the root-override seat in `keepUnresolvedEntry` — the placeholder loads at sortOrder 0.
    const entry = await reorderedThenMissing();
    expect(sortOrder(rootOf(INST))).toBe(3);
    expectSameBytes(entryOf(await save(), INST), entry);
  });

  it('a reorder of the placeholder is written INTO the root override, and the prefab\'s return keeps it', async () => {
    // Mutation: write the live value into the traits in `asSceneEntry` (skip the override branch) — the override (3)
    // stays beside it, and wins again once the prefab re-expands.
    await reorderedThenMissing();
    writeTraitFieldWithUndo(rootOf(INST), meta('EntityAttributes'), 'sortOrder', 5);
    const saved = await save();
    const entry = entryOf(saved, INST)!;
    expect(rootOverride(entry)?.sortOrder).toBe(5);
    expect(rootRowEa(entry).sortOrder).toBeUndefined();
    install(pDoc());
    await load(saved);
    expect(sortOrder(rootOf(INST))).toBe(5);
  });

  it('both fields changed on the placeholder are both written: the second does not undo the first', async () => {
    // Mutation: build `withRootOverride` from `record.overrides` instead of what the loop wrote so far — the isActive pass
    // writes the record's sortOrder (3) back over the reorder (close-out review).
    install(pDoc());
    await load(scene(P));
    writeTraitFieldWithUndo(rootOf(INST), meta('EntityAttributes'), 'sortOrder', 3);
    writeTraitFieldWithUndo(rootOf(INST), meta('EntityAttributes'), 'isActive', false);
    const control = await save();
    expect(rootOverride(entryOf(control, INST)!)).toMatchObject({ sortOrder: 3, isActive: false }); // precondition
    uninstall(P);
    await load(control);
    clearHistory();
    writeTraitFieldWithUndo(rootOf(INST), meta('EntityAttributes'), 'sortOrder', 5);
    writeTraitFieldWithUndo(rootOf(INST), meta('EntityAttributes'), 'isActive', true);
    expect(rootOverride(entryOf(await save(), INST)!)).toMatchObject({ sortOrder: 5, isActive: true });
  });
});

describe('a live instance of a TRASHED prefab keeps its place across save → reload (#1895)', () => {
  const HOLDER = 'dddddddd-0000-4000-8000-000000001600';
  const SIB = 'dddddddd-0000-4000-8000-000000001895';
  const ea = (id: number) => readTraitData(id, meta('EntityAttributes')) as { sortOrder: number; isActive: boolean };
  const traitsEa = (entry: Record<string, unknown>) => (entry.traits as Record<string, unknown>).EntityAttributes as Record<string, unknown> | undefined;
  const rootOverrideEa = rootEa;
  /** P whose ROOT row states `fields` (a Create Prefab copies the entity's `EntityAttributes` into it, #1895's route). */
  const pWith = (fields: Record<string, unknown>) => {
    const d = pDoc();
    Object.assign(d.entities[0]!.traits.EntityAttributes, fields);
    return d;
  };
  /** Holder → [Sib (sortOrder 1), an instance of P]: the instance takes its root's fields from the template, unmarked. */
  async function liveThenTrashed(fields: Record<string, unknown>) {
    install(pWith(fields));
    await load(scene(P, [{ id: 3, guid: SIB, traits: { EntityAttributes: { name: 'Sib', parentId: HOLDER, sortOrder: 1 } } }]));
    clearHistory();
    uninstall(P); // the Assets trash, mid-session: the instance stays live (#1738)
  }
  const entitiesText = (s: SceneData) => JSON.stringify(s.entities);
  /** `s` as a build before #1935 wrote it: no copy of a missing TOP-level prefab, so the instance reloads as its Missing
   *  Prefab placeholder and `placementForMissing` seats it. Since #1935 the live instance's save carries the copy and
   *  the reload expands it instead; the placeholder path stays for such a file, and for an instance that was already a
   *  placeholder at its save. */
  const beforeTopCopies = (s: SceneData): SceneData => {
    const c = JSON.parse(JSON.stringify(s)) as SceneData;
    delete c.embeddedPrefabs;
    return c;
  };

  /** Is the instance's member A live (expanded), rather than the instance a Missing Prefab placeholder? */
  const expanded = () => getAllEntities().some((e) => e.name === 'A');
  // With the copy: the file a #1935 build writes. Owner ruling B (#2001 S5, #2028): the copy no longer expands, so both
  // files reload as the placeholder, seated by `placementForMissing`; the copy is still written back until S6.
  for (const [how, asLoaded, isExpanded] of [['with the copy: a placeholder (ruling B)', (s: SceneData) => s, false], ['as a placeholder (no copy)', beforeTopCopies, false]] as const) {
    it(`a root at its template's sortOrder reloads there, and save → reload → save writes the same bytes: ${how}`, async () => {
      // Since F7 (#1914 R6) the order is the root override every scene instance records, not the traits #1895 wrote; before
      // F7, mutation: drop `unresolvedRoots.add` in `serializeScene` — the placeholder reloaded at 0, before Sib, and the
      // second save reordered /entities (hunt seed 3129's failure). The inactive twin below still reaches the traits path.
      await liveThenTrashed({ sortOrder: 3 });
      expect(ea(rootOf(INST)).sortOrder).toBe(3); // precondition: from the template
      const first = await save();
      // Scene v20: the root's order is the entry's placement, its one home (not the `/` row).
      expect(traitsEa(entryOf(first, INST)!)).toEqual({ parentId: HOLDER, sortOrder: 3 });
      expect(rootRowEa(entryOf(first, INST)!)).toEqual({});
      await load(asLoaded(first));
      expect(expanded()).toBe(isExpanded);
      expect(ea(rootOf(INST)).sortOrder).toBe(3);
      expect(entitiesText(await save())).toBe(entitiesText(first));
    });

    it(`an inactive root the same way: ${how}`, async () => {
      // Mutation (the placeholder): `PLACEHOLDER_ORDER_FIELDS` loop in `placementForMissing` skips isActive — the
      // placeholder reloads active.
      await liveThenTrashed({ isActive: false });
      const first = await save();
      expect(traitsEa(entryOf(first, INST)!)).toEqual({ isActive: false, parentId: HOLDER, sortOrder: 0 });
      await load(asLoaded(first));
      expect(expanded()).toBe(isExpanded);
      expect(ea(rootOf(INST)).isActive).toBe(false);
      expect(entitiesText(await save())).toBe(entitiesText(first));
    });
  }

  it('the prefab\'s return seeds no mark: the root takes the template\'s value, as it did before the trash', async () => {
    // Mutation: state the fields as a ROOT OVERRIDE (#1850's channel) instead — the reload marks
    // EntityAttributes.isActive, which the live instance never had (the fuzz's restored-prefab identity check). The
    // root's sortOrder is recorded on every scene instance (F7, #1914 R6), so isActive carries this now.
    await liveThenTrashed({ isActive: false });
    const first = await save();
    install(pWith({ isActive: false }));
    await load(first);
    expect(ea(rootOf(INST)).isActive).toBe(false);
    const marks = [...(overrideKeysOf(getCurrentWorld().entities.find((e) => e.id() === rootOf(INST))!) ?? [])];
    expect(marks.filter((k) => k.startsWith('EntityAttributes.'))).toEqual(['EntityAttributes.sortOrder']);
  });

  it('a field the entry already states as a root override is not stated twice', async () => {
    // Mutation: drop the `hasOwn(stated, k)` skip in `placementForMissing` — the traits carry sortOrder beside the override.
    await liveThenTrashed({});
    install(pWith({}));
    await load(scene(P, [{ id: 3, guid: SIB, traits: { EntityAttributes: { name: 'Sib', parentId: HOLDER, sortOrder: 1 } } }]));
    writeTraitFieldWithUndo(rootOf(INST), meta('EntityAttributes'), 'sortOrder', 3); // a marked reorder: an override
    uninstall(P);
    const first = await save();
    expect(traitsEa(entryOf(first, INST)!)).toEqual({ parentId: HOLDER, sortOrder: 3 });
    expect(rootRowEa(entryOf(first, INST)!)).toEqual({});
    await load(beforeTopCopies(first)); // the placeholder's placement is what is asked
    expect(entitiesText(await save())).toBe(entitiesText(first));
  });

  it('a root at the default writes nothing new: the entry is the one the live prefab wrote', async () => {
    // Mutation: drop the `PLACEMENT_DEFAULTS` skip in `placementForMissing` — the entry gains sortOrder: 0, isActive: true.
    install(pDoc());
    await load(scene(P));
    const control = await save();
    uninstall(P);
    expectSameBytes(entryOf(await save(), INST), entryOf(control, INST));
  });

  // Was OBSERVED (#1818's channel): a placeholder reordered while its prefab was missing stated the new order in the
  // entry's own traits, which a resolving root's load reads nothing of but `parentId`, so the prefab's return dropped it.
  // F7 (#1914 R6) fixes it for the entry: the order is the root override the live save wrote, and the reorder lands there
  // (`asSceneEntry`, #1850), where the return reads it. Not falsifiable alone: F7's falsifier is recordedOverrideList's.
  it('a reorder made while the prefab is missing survives the prefab\'s return (F7)', async () => {
    await liveThenTrashed({ sortOrder: 3 });
    await load(beforeTopCopies(await save())); // a reorder of the PLACEHOLDER (`asSceneEntry`)
    writeTraitFieldWithUndo(rootOf(INST), meta('EntityAttributes'), 'sortOrder', 5);
    const reordered = await save();
    expect(rootOverrideEa(entryOf(reordered, INST)!)?.sortOrder).toBe(5);
    install(pWith({ sortOrder: 3 }));
    await load(reordered);
    expect(ea(rootOf(INST)).sortOrder).toBe(5);
  });

  // #1897 (owner ruling A, 2026-09-30), #1895's nested twin: a scene-added reference NODE whose prefab is trashed states
  // its TEMPLATE's sortOrder / isActive in its own traits, and its placeholder is spawned with them. Since #1901 a user
  // edit of either on the node placeholder is kept the same way (I21).
  const nodeUnderA = async (qFields: Record<string, unknown>) => {
    const q = qDoc();
    Object.assign(q.entities[0]!.traits.EntityAttributes, qFields);
    install(pDoc(), q);
    await load(scene(P, [
      { id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: HOLDER } } },
      { id: 4, guid: SIB, traits: { EntityAttributes: { name: 'Sib', parentId: HOLDER, sortOrder: 1 } } },
    ]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    reparentEntity(getAllEntities().find((e) => e.guid === SIB)!.id, inside(INST, 'A'));
    clearHistory();
    uninstall(Q);
  };
  /** The nodes the scene hung under A: a v20 row's `own` links. */
  const addedUnderA = (sc: SceneData) => Object.values(entryOf(sc, INST)!.members as Record<string, { own?: Array<{ guid: string; traits?: Record<string, unknown> }> }>)
    .flatMap((m) => m.own ?? []);

  it('a scene-added reference NODE of a trashed prefab keeps its place: save → reload → save writes the same bytes (#1897)', async () => {
    // Mutation: `spawnUnresolvedReference` seats nothing — the placeholder reloads at 0, and A's added list reads [QR, Sib]
    // on the second save.
    await nodeUnderA({ sortOrder: 2 });
    const first = await save();
    const node = addedUnderA(first).find((n) => n.guid === QINST)!;
    expect(node.traits).toEqual({ EntityAttributes: { sortOrder: 2 } });
    expect(addedUnderA(first).map((n) => n.guid).sort()).toEqual([SIB, QINST].sort());
    await load(first);
    expect(ea(rootOf(QINST)).sortOrder).toBe(2);
    expect(entitiesText(await save())).toBe(entitiesText(first));
  });

  it('an inactive node the same way (#1897)', async () => {
    // Mutation: the capture's `placement` is always `{}` — the node's traits are empty and the placeholder reloads active.
    await nodeUnderA({ isActive: false });
    const first = await save();
    expect(addedUnderA(first).find((n) => n.guid === QINST)!.traits).toEqual({ EntityAttributes: { isActive: false } });
    await load(first);
    expect(ea(rootOf(QINST)).isActive).toBe(false);
    expect(entitiesText(await save())).toBe(entitiesText(first));
  });

  it('the node\'s prefab returning seeds no mark: the root takes the template\'s value (#1897)', async () => {
    // Mutation: a resolving reference node's load applying its own traits' EntityAttributes as overrides would mark it.
    // isActive: the sortOrder of a node the scene added is recorded on every one (F7, #1914 R6).
    await nodeUnderA({ isActive: false });
    const first = await save();
    const q = qDoc();
    Object.assign(q.entities[0]!.traits.EntityAttributes, { isActive: false });
    install(q);
    await load(first);
    expect(ea(rootOf(QINST)).isActive).toBe(false);
    const marks = [...(overrideKeysOf(getCurrentWorld().entities.find((e) => e.id() === rootOf(QINST))!) ?? [])];
    expect(marks.filter((k) => k.startsWith('EntityAttributes.'))).toEqual(['EntityAttributes.sortOrder']);
  });

  it('a node reordered while its prefab was live keeps that order once it is trashed; the override still applies on return (#1897 review F2)', async () => {
    // Mutation: in `nodePlacement`, skip a field a root override states even when the prefab is missing (the resolving
    // rule applied to the missing case) — the node's traits are empty, the placeholder reloads at 0 and A's added list reorders.
    await nodeUnderA({});
    install(qDoc());
    writeTraitFieldWithUndo(rootOf(QINST), meta('EntityAttributes'), 'sortOrder', 5); // a marked reorder: a root override
    const liveMarks = [...(overrideKeysOf(getCurrentWorld().entities.find((e) => e.id() === rootOf(QINST))!) ?? [])];
    uninstall(Q);
    const first = await save();
    expect(addedUnderA(first).find((n) => n.guid === QINST)!.traits).toEqual({ EntityAttributes: { sortOrder: 5 } });
    await load(first);
    expect(ea(rootOf(QINST)).sortOrder).toBe(5);
    expect(entitiesText(await save())).toBe(entitiesText(first));
    install(qDoc());
    await load(first);
    expect(ea(rootOf(QINST)).sortOrder).toBe(5);
    expect([...(overrideKeysOf(getCurrentWorld().entities.find((e) => e.id() === rootOf(QINST))!) ?? [])]).toEqual(liveMarks);
  });

  it('a node placeholder moved under another member keeps its sortOrder, and reloads at it (#1897 review F1, #1901)', async () => {
    // Mutation: give a placeholder moved into an instance a seat of 0 in `reparentEntity` (#1897's premise, before #1901
    // let the node keep what it shows) — it shows at 0, not 2.
    await nodeUnderA({ sortOrder: 2 });
    await load(await save());
    const R = rootOf(INST);
    reparentEntity(getAllEntities().find((e) => e.guid === SIB)!.id, R);
    reparentEntity(rootOf(QINST), R);
    expect(ea(rootOf(QINST)).sortOrder).toBe(2);
    const first = await save();
    await load(first);
    expect(ea(rootOf(QINST)).sortOrder).toBe(2);
    expect(entitiesText(await save())).toBe(entitiesText(first));
  });

  it('a node at the template default states nothing; a user edit of the placeholder\'s order is let through (I21, #1897, #1901)', async () => {
    // Mutation: drop the `PLACEMENT_DEFAULTS` skip in `nodePlacement` — the node's traits gain sortOrder: 0, isActive: true.
    await nodeUnderA({});
    const first = await save();
    expect(addedUnderA(first).find((n) => n.guid === QINST)!.traits).toEqual({});
    await nodeUnderA({ sortOrder: 2 });
    // A node of a missing prefab reloads as its placeholder (ruling B, #2028).
    await load(await save());
    // #1901 (owner ruling, shape 2): the node shape keeps both now, so the gate lets them through.
    expect(placeholderWriteRefusal(rootOf(QINST), 'EntityAttributes', 'sortOrder')).toBeNull();
    expect(placeholderWriteRefusal(rootOf(QINST), 'EntityAttributes', 'isActive')).toBeNull();
    expect(placeholderWriteRefusal(rootOf(QINST), 'Transform', 'x')).toMatch(/Missing Prefab/); // the rest stays refused
  });
});

// #1901 (owner ruling 2026-10-01, shape 2: the placeholder keeps what it shows). A Missing Prefab placeholder that lands
// INSIDE an instance is saved as an added node (`asAddedNode`), which states its live `sortOrder` / `isActive` in the
// node's own traits, and the reload seats them (`nodeSpawnPlacement`). One test per route the issue names.
describe('a Missing Prefab placeholder that lands inside an instance reloads as it is shown (#1901)', () => {
  const BOX = 'dddddddd-0000-4000-8000-000000001901';
  const SIB = 'dddddddd-0000-4000-8000-000000001902';
  const ea = (id: number) => readTraitData(id, meta('EntityAttributes')) as { sortOrder: number; isActive: boolean };
  const idOf = (guid: string) => getAllEntities().find((e) => e.guid === guid)!.id;
  const placement = (id: number) => ({ sortOrder: ea(id).sortOrder, isActive: ea(id).isActive });
  const entitiesText = (s: SceneData) => JSON.stringify(s.entities);
  /** Holder → Inst (P = R → A); Box, a plain top-level entity, holding an ENTRY of the missing Q loaded at sortOrder 3,
   *  inactive; Sib, a plain top-level entity. */
  async function loadWithQMissing() {
    install(pDoc()); // Q is not installed: missing
    await load(scene(P, [
      { id: 3, guid: BOX, traits: { EntityAttributes: { name: 'Box', parentId: 0 } } },
      { id: 4, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: BOX, sortOrder: 3, isActive: false } } },
      { id: 5, guid: SIB, traits: { EntityAttributes: { name: 'Sib', parentId: 0 } } },
    ]));
    clearHistory();
    expect(getAllEntities().find((e) => e.guid === QINST)?.missingPrefab).toBe(true); // precondition
    expect(placement(idOf(QINST))).toEqual({ sortOrder: 3, isActive: false });
  }
  /** Save, reload, and assert a second save writes the first's bytes. Returns the first save. */
  async function roundTrip(): Promise<SceneData> {
    const first = await save();
    await load(first);
    expect(entitiesText(await save())).toBe(entitiesText(first));
    return first;
  }

  it('T1: a placeholder inside a MOVED subtree keeps its order and flag', async () => {
    // Mutation: `asAddedNode` ignores `live.order` — the entry record is written as a node with no traits, and the
    // placeholder reloads at {0, true}.
    await loadWithQMissing();
    expect(reparentEntity(idOf(BOX), inside(INST, 'A'))).toBe(true);
    expect(placement(idOf(QINST))).toEqual({ sortOrder: 3, isActive: false });
    await roundTrip();
    expect(placement(idOf(QINST))).toEqual({ sortOrder: 3, isActive: false });
  });

  it('T2: a paste and a duplicate into an instance take a fresh sortOrder, and reload at it', async () => {
    // Mutation: return early from `assignFreshSortOrder` for every placeholder (`isMissingPrefabPlaceholder`, #1818's
    // shape) — the paste keeps the copied 3, and a sibling at 4 sorts after it.
    await loadWithQMissing();
    const A = inside(INST, 'A');
    expect(reparentEntity(idOf(SIB), A, 4)).toBe(true);
    const pasted = pasteEntityCopy(clipEntity(idOf(QINST), 'copy')!, A, () => {})!;
    const pastedGuid = getAllEntities().find((e) => e.id === pasted)!.guid!;
    expect(placement(pasted)).toEqual({ sortOrder: 5, isActive: false });
    const dup = duplicateEntity(pasted, () => {})!;
    const dupGuid = getAllEntities().find((e) => e.id === dup)!.guid!;
    expect(placement(dup)).toEqual({ sortOrder: 6, isActive: false });
    await roundTrip();
    expect(placement(idOf(pastedGuid))).toEqual({ sortOrder: 5, isActive: false });
    expect(placement(idOf(dupGuid))).toEqual({ sortOrder: 6, isActive: false });
  });

  it('T3: a placeholder moved INTO an instance keeps its flag, and takes the sortOrder it was dropped at', async () => {
    // Mutation: restore `reparentEntity`'s placeholder seat (`sortOrderAsNode`) — it shows at 0, not 7.
    await loadWithQMissing();
    expect(reparentEntity(idOf(QINST), inside(INST, 'A'), 7)).toBe(true);
    expect(placement(idOf(QINST))).toEqual({ sortOrder: 7, isActive: false });
    await roundTrip();
    expect(placement(idOf(QINST))).toEqual({ sortOrder: 7, isActive: false });
  });

  it('T4: once inside, a toggle and a reorder of the placeholder are let through, and kept', async () => {
    // Mutation: restore the gate's node-shape refusal of sortOrder / isActive — both writes are refused.
    await loadWithQMissing();
    const A = inside(INST, 'A');
    expect(reparentEntity(idOf(QINST), A, 7)).toBe(true);
    expect(writeTraitFieldWithUndo(idOf(QINST), meta('EntityAttributes'), 'isActive', true)).toBeNull();
    expect(writeTraitFieldWithUndo(idOf(QINST), meta('EntityAttributes'), 'sortOrder', 9)).toBeNull();
    expect(siblingDropRefusal(idOf(QINST), A)).toBeNull();
    await roundTrip();
    expect(placement(idOf(QINST))).toEqual({ sortOrder: 9, isActive: true });
  });

  it('a placeholder at the defaults moved inside states nothing, so its node is the bytes a live save wrote', async () => {
    // Mutation: drop the `PLACEMENT_DEFAULTS` test in `asAddedNode` — the node gains sortOrder: 0, isActive: true.
    await loadWithQMissing();
    writeTraitFieldWithUndo(idOf(QINST), meta('EntityAttributes'), 'sortOrder', 0);
    writeTraitFieldWithUndo(idOf(QINST), meta('EntityAttributes'), 'isActive', true);
    expect(reparentEntity(idOf(QINST), inside(INST, 'A'))).toBe(true);
    const node = (entryOf(await save(), INST)!.members as Record<string, { own?: Array<{ guid: string; traits?: unknown }> }>)[`/${gA}`]!
      .own!.find((n) => n.guid === QINST)!;
    expect(node.traits).toEqual({});
  });

  it('cold load: a node reordered and deactivated while live, its prefab deleted outside the editor, loads as it was', async () => {
    // Mutation: `nodePlacement` states nothing while the prefab resolves (the #1897 rule) — the live save carries only
    // the root override, which a node placeholder cannot read, and it loads at {0, true}.
    install(pDoc(), qDoc());
    await load(scene(P, [
      { id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } },
      { id: 4, guid: SIB, traits: { EntityAttributes: { name: 'Sib', parentId: 'dddddddd-0000-4000-8000-000000001600', sortOrder: 1 } } },
    ]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    reparentEntity(idOf(SIB), inside(INST, 'A'), 1);
    writeTraitFieldWithUndo(rootOf(QINST), meta('EntityAttributes'), 'sortOrder', 5);
    writeTraitFieldWithUndo(rootOf(QINST), meta('EntityAttributes'), 'isActive', false);
    const liveMarks = [...(overrideKeysOf(getCurrentWorld().entities.find((e) => e.id() === rootOf(QINST))!) ?? [])].sort();
    const live = await save();
    uninstall(Q); // deleted outside the editor: the next load is cold
    await load(live);
    expect(getAllEntities().find((e) => e.guid === QINST)?.missingPrefab).toBe(true); // precondition
    expect(placement(rootOf(QINST))).toEqual({ sortOrder: 5, isActive: false });
    expect(entitiesText(await save())).toBe(entitiesText(live));
    install(qDoc()); // the prefab's return: the root override applies, and the marks are the live instance's
    await load(live);
    expect(placement(rootOf(QINST))).toEqual({ sortOrder: 5, isActive: false });
    expect([...(overrideKeysOf(getCurrentWorld().entities.find((e) => e.id() === rootOf(QINST))!) ?? [])].sort()).toEqual(liveMarks);
  });

  // #1901 close-out review F1: a node the TEMPLATE declares (a keyed node, supplied by the prefab) is the template's, and
  // its frame's save states nothing of it, so the gate refuses every field there — a toggle, a reorder and a rename
  // (the rename was dropped before #1901 too). PK = R → row 3 expanding P, whose `added` authors QK (Q) under P's A.
  it('a placeholder of a TEMPLATE-keyed node takes no edit: the gate refuses, and the save still writes what the file said', async () => {
    // Mutation: drop the `isSuppliedByPrefab` branch of `placeholderSavedFields` — the toggle is accepted, shows, and is
    // gone after the reload.
    const PK = 'cccccccc-0000-4000-8000-000000001740';
    const pk = { id: PK, version: 5, name: 'PK', rootLocalId: 1, entities: [
      row(1, 'KR', 0, 'eeeeeeee-0000-4000-8000-000000001741'),
      { localId: 3, name: 'Prow', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001742', prefab: P,
        added: [{ parentLocalId: 2, key: 'eeeeeeee-0000-4000-8000-000000001743', name: 'QK', prefab: Q, traits: {}, children: [] }],
        traits: { EntityAttributes: { name: 'Prow', parentId: 1, guid: '' } } },
    ] };
    install(pDoc(), pk);
    await load(scene(PK));
    const qk = getAllEntities().find((e) => e.name === 'QK')!;
    expect(qk.missingPrefab).toBe(true); // precondition
    const before = await save();
    for (const [field, value] of [['isActive', false], ['sortOrder', 4], ['name', 'Renamed']] as const) {
      expect(writeTraitFieldWithUndo(qk.id, meta('EntityAttributes'), field, value)).toMatch(/Missing Prefab/);
    }
    expect(placement(qk.id)).toEqual({ sortOrder: 0, isActive: true });
    expect(entitiesText(await save())).toBe(entitiesText(before));
    // (The accept side, a node the SCENE added, is T4 above.)
  });

  // NOT FIXED (#1918, pre-existing, recorded as observed): in PREFAB EDIT the row writer takes only the name (and a parent
  // inside the document) off a row placeholder, while the gate asks the scene writers' list, so a reorder and a toggle
  // are accepted and the saved row states neither. When #1918 lands, this pin flips.
  it('OBSERVED: a prefab-edit ROW placeholder takes a reorder and a toggle that the row writer drops', async () => {
    const doc = pqDoc() as unknown as PrefabFile;
    install(doc);
    await load(buildPrefabEditScene(doc) as SceneData);
    const editWorld = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: `/__prefab-edit__/${PQ}` } as never);
    try {
      const q = getAllEntities().find((e) => e.name === 'Qrow')!;
      expect(q.missingPrefab).toBe(true); // precondition
      expect(writeTraitFieldWithUndo(q.id, meta('EntityAttributes'), 'sortOrder', 9)).toBeNull();
      expect(writeTraitFieldWithUndo(q.id, meta('EntityAttributes'), 'isActive', false)).toBeNull();
      expect(writeTraitFieldWithUndo(q.id, meta('EntityAttributes'), 'name', 'QrowRenamed')).toBeNull();
      const out = serializePrefabEditWorld(PQ);
      if ('error' in out) throw new Error(out.error);
      expect(out.prefab.entities.find((e) => e.prefab === Q)!.traits.EntityAttributes).toEqual({ name: 'QrowRenamed', parentId: 1, guid: '' });
    } finally {
      editWorld.mockRestore();
    }
  });

  // Review F3: the resolving rule on its own, so #1916's fix flipping the OBSERVED pin below does not leave it unguarded.
  it('nodePlacement: while the prefab resolves only a root override\'s fields are stated; while it is missing, every non-default one', () => {
    // Mutation: delete `if (resolves && !hasOwn(rootOverride, k)) continue;` — the first line states both fields.
    const live = { sortOrder: 2, isActive: false };
    expect(nodePlacement(true, undefined, live)).toEqual({});
    expect(nodePlacement(true, { sortOrder: 2 }, live)).toEqual({ sortOrder: 2 });
    expect(nodePlacement(false, undefined, live)).toEqual({ sortOrder: 2, isActive: false });
    expect(nodePlacement(false, undefined, { sortOrder: 0, isActive: true })).toEqual({});
  });

  // F7 (#1914 R6, seed 7078's cold route) closes it for the ORDER, in both shapes: a scene instance's root records its
  // sortOrder, so the save states it while the prefab resolves and the cold placeholder spawns there. Still OBSERVED for
  // the ACTIVE flag, which is not one of Unity's default overrides: a value the template gives it carries no record, and
  // the placeholder loads active. docs/prefabs.md I21 names it.
  it('OBSERVED: a root placed by its TEMPLATE, its prefab deleted outside the editor, loads cold at its order but active', async () => {
    const q = qDoc();
    Object.assign(q.entities[0]!.traits.EntityAttributes, { sortOrder: 2, isActive: false });
    install(pDoc(), q);
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    expect(placement(rootOf(QINST))).toEqual({ sortOrder: 2, isActive: false }); // precondition: from the template, unmarked
    const live = await save();
    uninstall(Q);
    await load(live);
    expect(placement(rootOf(QINST))).toEqual({ sortOrder: 2, isActive: true });
  });
  it('OBSERVED: the same for a top-level ENTRY placed by its template', async () => {
    const p = pDoc();
    Object.assign(p.entities[0]!.traits.EntityAttributes, { sortOrder: 2, isActive: false });
    install(p);
    await load(scene(P));
    expect(placement(rootOf(INST))).toEqual({ sortOrder: 2, isActive: false }); // precondition: from the template, unmarked
    const live = await save();
    uninstall(P);
    await load(live);
    expect(placement(rootOf(INST))).toEqual({ sortOrder: 2, isActive: true });
  });
});

describe('a rebuild respawns a missing added node\'s placeholder (#1699, the editor\'s rebuild)', () => {
  it('an Apply that rebuilds the instance keeps the node', async () => {
    // Mutation: drop `spawnUnresolvedReference` from `spawnReferenceNode` (the one spawner since #1783) — the rebuild spawns
    // nothing for the node, and the save loses it.
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

  it('Apply skips a key naming a missing reference, and Create Prefab refuses a tree holding one', async () => {
    // Mutations: drop the skip in `planApply` — the node is taken out of the instance and promoted as nothing; drop
    // the refusal in `createPrefabFromEntity` — the template gets an empty row where the reference was.
    install(pDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    const control = await save();
    uninstall(Q);
    await load(control);
    const keys = collectInstanceOverrideKeys(rootOf(INST), prefabs.get(P) as PrefabFile);
    const all = keys.all.filter((k) => !keys.defaultOverrides.includes(k)); // Apply All: F7's root order left
    expect(all.some((k) => k.includes(QINST))).toBe(true); // precondition: the listing names the node
    const res = await applyToPrefabSelective(rootOf(INST), new Set(all));
    expect(res.applied).toBe(false); // the node was the only key: nothing is left to apply
    expect(res.skipped?.find((x) => x.key.includes(QINST))?.reason).toMatch(/^"QR" is a reference to a missing prefab/);
    expect(written(P)).toBeUndefined();
    expect(getAllEntities().some((e) => e.guid === QINST)).toBe(true); // it stays in the instance
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

  it('Apply skips an added node whose subtree holds one, naming it, and lands the other keys (Apply All, #1831)', async () => {
    // Mutation: match the placeholder's guid in the key TEXT again — the key is `+added.<N>`, which names no
    // placeholder, and Apply promotes an empty Q row into P and drops QINST. Mutation: refuse the whole Apply for it
    // again — the Transform edit on A is not written.
    await underPlainNode();
    writeTraitFieldWithUndo(inside(INST, 'A'), meta('Transform'), 'y', 9);
    const keys = collectInstanceOverrideKeys(rootOf(INST), prefabs.get(P) as PrefabFile);
    expect(keys.all.some((k) => k.includes(N))).toBe(true); // precondition
    const res = await applyToPrefabSelective(rootOf(INST), new Set(keys.all));
    expect(res.refused).toBeUndefined();
    expect(res.applied).toBe(true);
    expect(res.skipped).toEqual([{ key: expect.stringContaining(N), reason: expect.stringMatching(/^"QR" \(inside "N"\) is a reference to a missing prefab/) }]);
    const p = written(P)!;
    expect(p.entities.some((r) => (r as { prefab?: string }).prefab === Q)).toBe(false);
    expect((p.entities.find((r) => r.name === 'A')!.traits as { Transform?: { y?: number } }).Transform?.y).toBe(9);
    expect(getAllEntities().some((e) => e.guid === QINST)).toBe(true);
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
    respawnFromSnapshot(copySnapshot(snap), editRoot.id);
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
      : onDisk(String(url)) ?? { ok: false, status: 404, json: async () => ({}), text: async () => '' });
    writeTraitFieldWithUndo(inside(INST, 'A'), meta('Transform'), 'z', 3);
    const keys = collectInstanceOverrideKeys(rootOf(INST), prefabs.get(P) as PrefabFile);
    expect((await applyToPrefabSelective(rootOf(INST), new Set(keys.fields))).applied).toBe(true);
    expect(x(inside(QINST, 'QX'))).toBe(7);
  });
});

describe('the template refusals ask what is promoted or written, not the live tree (#1699 narrow review)', () => {

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
    respawnFromSnapshot(copySnapshot(snap), editRoot.id);
    const out = serializePrefabEditWorld(P);
    // The reason names the prefab and says the paste exists only in this edit (#1738 member 2's refusal, sharpened).
    expect('error' in out && out.error).toContain(`pasted reference to the prefab ${resolveRef(Q) ?? Q}, which is missing or has no root, so this save cannot write it, and it exists only in this edit`);
  });

  it('the refusal of a node the TEMPLATE declares says the file still has it (#1738, 2)', async () => {
    // PK = R → row 3 expanding P, whose `added` authors the keyed reference node QK (Q) under P's A. Q is missing.
    // Mutation: test `onDisk` as false — the reason claims the node exists only in this edit, which would send the human
    // to delete a node the file still holds.
    const PK = 'cccccccc-0000-4000-8000-000000001740';
    const pk = { id: PK, version: 5, name: 'PK', rootLocalId: 1, entities: [
      row(1, 'KR', 0, 'eeeeeeee-0000-4000-8000-000000001741'),
      { localId: 3, name: 'Prow', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001742', prefab: P,
        added: [{ parentLocalId: 2, key: 'eeeeeeee-0000-4000-8000-000000001743', name: 'QK', prefab: Q, traits: {}, children: [] }],
        traits: { EntityAttributes: { name: 'Prow', parentId: 1, guid: '' } } },
    ] };
    install(pDoc(), pk);
    await load(buildPrefabEditScene(pk as unknown as PrefabFile) as SceneData);
    expect(getAllEntities().find((e) => e.name === 'QK')?.missingPrefab).toBe(true); // precondition: the node placeholder
    const out = serializePrefabEditWorld(PK);
    expect('error' in out && out.error).toContain(`"QK" references the prefab ${resolveRef(Q) ?? Q}, which is missing or has no root, so this save cannot write it. The prefab file on disk still has it`);
  });
});

// #1768: a document that LOADS but expands to no root is a reference the load cannot expand (I18), exactly as one that
// does not load. V is variant-shaped: its root row 1 references L, and L is missing.
const V = 'cccccccc-0000-4000-8000-000000001768';
const L = 'cccccccc-0000-4000-8000-000000001767';
const lDoc = () => ({ id: L, version: 5, name: 'L', rootLocalId: 1, entities: [row(1, 'LA', 0, 'eeeeeeee-0000-4000-8000-000000001761')] });
const vDoc = () => ({ id: V, version: 5, name: 'V', rootLocalId: 1, entities: [
  { localId: 1, name: 'LRow', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001762', prefab: L, traits: { EntityAttributes: { name: 'LRow', parentId: 0, guid: '' } } },
  row(2, 'VExtra', 1, 'eeeeeeee-0000-4000-8000-000000001763'),
] });

describe('a scene entry whose prefab loads but expands to no root keeps its entry (#1768)', () => {
  it('nothing is spawned for it, and every save writes the entry it read', async () => {
    // Mutation: drop `fetchedExpandsToRoot` at the entry site in `loadSceneFile` — the placeholder is deleted and the
    // expansion replaces it with nothing, so the save writes no entry at all (its guid, overrides and name gone).
    install(vDoc());
    const input = scene(V);
    const entry = (input.entities as unknown as Array<Record<string, unknown>>)[1]!;
    entry.overrides = { 2: { Transform: { x: 5 } } };
    await load(input);
    expect(getAllEntities().filter((e) => e.name === 'VExtra')).toEqual([]);
    expect(getAllEntities().find((e) => e.guid === INST)?.missingPrefab).toBe(true);
    const s1 = await save();
    // Scene v20: the record of V's row 2 is the row keyed by that row's node guid (V loads, so the key can be formed).
    expect(entryOf(s1, INST)).toMatchObject({ prefab: V, members: { '/eeeeeeee-0000-4000-8000-000000001763': { traits: { Transform: { x: 5 } } } } });
    expect(entryOf(s1, INST)!.overrides).toBeUndefined();
    await load(s1);
    expectSameBytes(entryOf(await save(), INST), entryOf(s1, INST));
  });

  it('an added reference node to it keeps its node through a load and through a rebuild (the one spawner, from both callers)', async () => {
    // Mutation: drop `expandsToRoot` from `spawnReferenceNode` — the node is dropped at the load and at the Apply's
    // rebuild, one spawner serving both since #1783.
    install(pDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    const control = JSON.parse(JSON.stringify(await save()).split(Q).join(V)) as SceneData;
    const nodeOf = (sd: SceneData) => (entryOf(sd, INST)!.members as Record<string, { own?: unknown[] }>)[`/${gA}`]!.own;
    expect(JSON.stringify(nodeOf(control))).toContain(V); // precondition: the node now references V
    uninstall(Q);
    install(vDoc());
    await load(control);
    expect(getAllEntities().find((e) => e.guid === QINST)?.missingPrefab).toBe(true);
    expect(getAllEntities().filter((e) => e.name === 'VExtra')).toEqual([]);
    expect(nodeOf(await save())).toEqual(nodeOf(control));
    writeTraitFieldWithUndo(inside(INST, 'A'), meta('Transform'), 'z', 3);
    const keys = collectInstanceOverrideKeys(rootOf(INST), prefabs.get(P) as PrefabFile);
    expect((await applyToPrefabSelective(rootOf(INST), new Set(keys.fields))).applied).toBe(true);
    expect(getAllEntities().find((e) => e.guid === QINST)?.missingPrefab).toBe(true);
    expect(nodeOf(await save())).toEqual(nodeOf(control));
  });

  it('a rebuild onto a document with no root leaves the live instance standing', async () => {
    // Mutation: drop the `expandsToRoot` check in `reprojectFromStore` (the records route, #2001 S8b) or in
    // `rebuildTargetsByEntry` (the capture route) — the refresh counts an instance it did not rebuild (and dropping
    // `rebuildFromEntry`'s own guard as well tears R and A down with nothing spawned in their place).
    install(pDoc());
    await load(scene(P));
    const root = rootOf(INST);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(refreshInstances(P, [root], pDoc() as never, { ...pDoc(), rootLocalId: 9 } as never)).toBe(0);
    expect(getAllEntities().find((e) => e.guid === INST)?.id).toBe(root);
    expect(x(inside(INST, 'A'))).toBe(0);
    // Said once, with its reason — not a second time as "no scene entry could be loaded" (#1880 F7d close-out review 6).
    // Mutation: the no-root skip does not add to `said` — the false warning comes back.
    const said = warn.mock.calls.map((c) => String(c[0]));
    expect(said.some((w) => w.includes('expands to no root'))).toBe(true);
    expect(said.some((w) => w.includes('not refreshing'))).toBe(false);
    warn.mockRestore();
  });

  it('a template ROW whose child loads but expands to no root keeps the frame\'s scene edits, as a missing child does (close-out F1)', async () => {
    // Mutations: drop `expandsToRoot` from `nestedRowPresent` — the save writes the row as REMOVED; from the reader
    // `rowBackedTest` hands `resolveMemberChain` — QX's row reads as backed, is not kept, and is dropped.
    install(pqDoc(), qDoc());
    await load(scene(PQ));
    writeTraitFieldWithUndo(inside(INST, 'QX'), meta('Transform'), 'x', 7);
    const control = await save();
    const rootless = { ...qDoc(), rootLocalId: 9 };
    install(rootless);
    await load(control);
    expect(getAllEntities().filter((e) => e.name === 'QX')).toEqual([]); // precondition: nothing expanded
    const saved = await save();
    expectSameBytes(entryOf(saved, INST), entryOf(control, INST));
    install(qDoc());
    await load(saved);
    expect(x(inside(INST, 'QX'))).toBe(7);
  });

  it('the predicate agrees with both expansions on every shape (the twin pin)', () => {
    // `expandsToRoot` is a second spelling of the expansion's root rule; this holds the three together. Mutation: make
    // it answer true for a reference root — the three reference shapes disagree;
    // drop either expansion's early return — "no root row" spawns P's A parentless, and its last column goes false.
    const self = 'cccccccc-0000-4000-8000-000000001766';
    const shapes: Array<[string, () => void, { id: string }]> = [
      ['plain root', () => install(pDoc()), pDoc()],
      ['no root row', () => {}, { ...pDoc(), rootLocalId: 9 } as never],
      ['reference root, child present', () => install(lDoc(), vDoc()), vDoc()],
      ['reference root, child missing', () => install(vDoc()), vDoc()],
      ['reference root naming itself', () => {}, { id: self, version: 5, name: 'S', rootLocalId: 1, entities: [
        { localId: 1, name: 'Me', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001764', prefab: self, traits: { EntityAttributes: { name: 'Me', parentId: 0, guid: '' } } }] } as never],
    ];
    const verdicts = shapes.map(([name, setup, doc]) => {
      prefabs.clear();
      for (const id of [P, L, V, self]) setPrefabCache(id, null);
      setup();
      if (doc.id === self) install(doc);
      setCurrentWorld(createWorld());
      // Each expansion either spawns a root or spawns NOTHING — never a root-less scatter of rows.
      const count = () => getCurrentWorld().entities.length;
      const b0 = count();
      const runtime = instantiatePrefabIntoWorld(getCurrentWorld(), doc as never, 0, undefined, doc.id) > 0;
      const b1 = count();
      const editor = instantiatePrefab(doc as never, 0) > 0;
      const clean = (runtime || b1 === b0) && (editor || count() === b1);
      return [name, expandsToRoot(doc as never, (s) => prefabs.get(s) as never), runtime, editor, clean];
    });
    expect(verdicts).toEqual([
      ['plain root', true, true, true, true],
      ['no root row', false, false, false, true],
      // The Prefab Variant form: not expanded since #2001 S5 (owner ruling (b), #2042), by the predicate or either expansion.
      ['reference root, child present', false, false, false, true],
      ['reference root, child missing', false, false, false, true],
      ['reference root naming itself', false, false, false, true],
    ]);
  });
});

// #1738 member 1: an EXPANDED instance whose prefab stops resolving mid-session (both caches evicted, no reload) is a
// reference its writers cannot read, and I18 says they write back the record it was loaded with — the frame record.
describe('a live instance whose prefab vanished mid-session is written from its frame record (#1738, 1)', () => {
  const HOLDER = 'dddddddd-0000-4000-8000-000000001600';
  const loaded = async () => {
    install(pDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: HOLDER } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    writeTraitFieldWithUndo(inside(INST, 'A'), meta('Transform'), 'x', 5);
    writeTraitFieldWithUndo(inside(QINST, 'QX'), meta('Transform'), 'x', 7);
    clearHistory();
  };

  it('the scene save writes the instance and its nested node byte for byte as it did before the eviction', async () => {
    // Mutations: drop the entry-site `levelDoc` fallback in `serializeScene` — no instance entry is written at all; drop
    // the pre-pass one — the nested node is lost from `A`'s row; make `captureDoc` read the cache only — the nested node is dropped from `A`'s row.
    await loaded();
    const control = await save();
    uninstall(P); uninstall(Q);
    expectSameBytes(entryOf(await save(), INST), entryOf(control, INST));
  });

  it('Create Prefab over a tree holding it refuses, and writes nothing (#2001 S8b)', async () => {
    // It wrote a REFERENCE row for the instance (#1738), but the new prefab's instance record folds that row from P, which
    // no cache holds: a placeholder, not the members the tree has, so the record could not state the tree it was made
    // from. Create Prefab keeps the records exact or does not run. Mutation: drop the `unreadFramesInTreeRefusal` call in
    // `createPrefabFromEntity` — the create lands, and the first expect goes red.
    await loaded();
    uninstall(P); uninstall(Q);
    const holder = getAllEntities().find((e) => e.guid === HOLDER)!.id;
    const before = getAllEntities().map((e) => e.guid).sort();
    const created = await createPrefabFromEntity(holder, 'prefabs/Held.prefab.json', 'Held', async () => true);
    expect(created && typeof created === 'object' && 'refused' in created ? created.refused : created).toMatch(/is an instance of .*, which the editor can no longer read/);
    expect(writes.some((w) => w.path.endsWith('Held.prefab.json'))).toBe(false);
    expect(getAllEntities().map((e) => e.guid).sort()).toEqual(before);
  });
});

// #1738 member 3: a PRE-v5 template (no `nodeGuid`, so no member rows) states a nested frame's edits in the legacy
// path-keyed channels. One addressing a frame whose prefab is missing reaches no live frame, and R2's legacy half keeps
// it (the #1780 store), on the scene side and in the template's own prefab-edit save.
describe('a pre-v5 legacy channel into a missing nested frame is written back (#1738, 3)', () => {
  const T = 'cccccccc-0000-4000-8000-000000001738';
  const T2 = 'cccccccc-0000-4000-8000-000000001739';
  const bare = (r: Record<string, unknown>) => { const { nodeGuid: _g, ...rest } = r; return rest; };
  /** PQ's shape, pre-v5: R → A, and row 3 expanding Q. */
  const tDoc = () => ({ ...pqDoc(), id: T, version: 4, name: 'T', entities: pqDoc().entities.map((e) => bare(e as Record<string, unknown>)) });
  const channel = { 3: { 2: { Transform: { x: 7 } } } };

  it('the scene side: the entry keeps it with Q missing, and it applies once Q is back', async () => {
    // Mutation: skip `keepUnreachedLegacy` in the loader — the save drops the channel, and QX comes back at Q's 0.
    install(tDoc());
    const sc = scene(T);
    (sc.entities as unknown as Array<Record<string, unknown>>)[1]!.nestedOverrides = channel;
    await load(sc);
    const saved = await save();
    expect(entryOf(saved, INST)!.nestedOverrides).toEqual(channel);
    install(qDoc());
    await load(saved);
    expect(x(inside(INST, 'QX'))).toBe(7);
  });

  it('a scene-added reference NODE keeps its own legacy channel the same way', async () => {
    // A node is a stored root of its own (`collectReferenceNodeRows`). Mutation: `captureNestedRef` merges nothing for a
    // scene node (`nodeGuid` = '') — the node is written without its channel.
    install(pDoc(), tDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: T, guid: QINST, traits: { EntityAttributes: { name: 'TInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    const control = await save();
    const nodeOf = (sd: SceneData) => (entryOf(sd, INST)!.members as Record<string, { own?: Array<Record<string, unknown>> }>)[`/${gA}`]!.own![0]!;
    nodeOf(control).nestedOverrides = channel;
    uninstall(Q);
    await load(control);
    const saved = await save();
    expect(nodeOf(saved).nestedOverrides).toEqual(channel);
    install(qDoc());
    await load(saved);
    expect(x(inside(QINST, 'QX'))).toBe(7);
  });

  it('the template side: a keyed template reference NODE keeps its own channel through a prefab-edit save', async () => {
    // T3 = R3 → row 2 expanding P, whose `added` authors the keyed node TK (T) under P's A; TK's channel reaches into
    // T's row 3, whose Q is missing. Mutation (before #2001 S8b deleted the kept stores): keep no legacy for a keyed node in `keepTemplateNodeOrphans` — the node is
    // written without its channel. (Its writer is `captureRowChannels`, through `finishTemplateReferenceNode`.)
    const T3 = 'cccccccc-0000-4000-8000-000000001741';
    uninstall(Q); // an earlier case left it installed; resolved, a v10 save states the channel as rows instead
    install(pDoc(), tDoc());
    const t3 = { id: T3, version: 5, name: 'T3', rootLocalId: 1, entities: [
      row(1, 'R3', 0, 'eeeeeeee-0000-4000-8000-000000001745'),
      { localId: 2, name: 'Prow', nodeGuid: 'eeeeeeee-0000-4000-8000-000000001746', prefab: P,
        added: [{ parentLocalId: 2, key: 'eeeeeeee-0000-4000-8000-000000001747', name: 'TK', prefab: T, traits: {}, children: [], nestedOverrides: channel }],
        traits: { EntityAttributes: { name: 'Prow', parentId: 1, guid: '' } } },
    ] };
    install(t3);
    const editWorld = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: `/__prefab-edit__/${T3}` } as never);
    await load(buildPrefabEditScene(t3 as never) as SceneData);
    const out = serializePrefabEditWorld(T3);
    editWorld.mockRestore();
    if ('error' in out) throw new Error(out.error);
    // Prefab v10 (#2001 S6): the node is the row's `own` under P's A; its channel names a frame that did not resolve, so
    // it is written back as it was read (the one legacy form a v10 writer keeps, docs/prefabs.md § Format rule).
    const node = ownNodes(out.prefab.entities.find((e) => e.localId === 2))[0] as Record<string, unknown> | undefined;
    expect(node?.nestedOverrides).toEqual(channel);
  });

  it('the template side: a prefab-edit save of a template whose row reaches into it keeps the row\'s channel', async () => {
    // T2 = R2 → row 2 expanding T, whose own row 3 expands the missing Q. Mutation: drop the kept-channel merge in
    // `captureRowChannels` — the row is written without its `nestedOverrides`.
    uninstall(Q);
    install(tDoc());
    const t2 = { id: T2, version: 4, name: 'T2', rootLocalId: 1, entities: [
      bare(row(1, 'R2', 0, 'x')),
      { localId: 2, name: 'Trow', prefab: T, nestedOverrides: channel, traits: { EntityAttributes: { name: 'Trow', parentId: 1, guid: '' } } },
    ] };
    install(t2);
    const editWorld = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: `/__prefab-edit__/${T2}` } as never);
    await load(buildPrefabEditScene(t2 as never) as SceneData);
    const out = serializePrefabEditWorld(T2);
    editWorld.mockRestore();
    if ('error' in out) throw new Error(out.error);
    expect(out.prefab.entities.find((e) => e.localId === 2)?.nestedOverrides).toEqual(channel);
  });
});

// #1738 (comment member, #1722 lens 4): a child the scene puts under a missing prefab's NODE placeholder is written
// top-level, parented by the placeholder's guid. That guid is the node root's, which only the node's expansion spawns —
// after pass 2 resolves parents — so the load used to put the child at the scene root for good.
describe('a child under a node placeholder keeps its parent across a reload (#1738)', () => {
  it('the saved parent guid resolves once the expansion has spawned it, with the prefab missing and once it is back', async () => {
    // Mutations: drop `retryGuidParents` from the loader — PhKid lands at the root; `buildParentLinks` writes no link —
    // the save states PhKid nowhere under QInst.
    const KID = 'dddddddd-0000-4000-8000-000000001609';
    install(pDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 'dddddddd-0000-4000-8000-000000001600' } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    const control = await save();
    uninstall(Q);
    (control.entities as unknown[]).push({ id: 99, traits: { EntityAttributes: { name: 'PhKid', parentId: QINST, guid: KID } } });
    await load(control);
    const kid = () => getAllEntities().find((e) => e.guid === KID)!;
    expect(kid().parentId).toBe(rootOf(QINST));
    // Saved where it hangs (#2001 S8b): QInst's node (own content of R's A row) links PhKid on its "/" row (§ 10.4b).
    const nodeWithGuid = (v: unknown, g: string): Record<string, unknown> | undefined => {
      if (Array.isArray(v)) { for (const x of v) { const hit = nodeWithGuid(x, g); if (hit) return hit; } return undefined; }
      if (!v || typeof v !== 'object') return undefined;
      const o = v as Record<string, unknown>;
      if (o.guid === g && typeof o.prefab === 'string') return o;
      for (const x of Object.values(o)) { const hit = nodeWithGuid(x, g); if (hit) return hit; }
      return undefined;
    };
    const kidLink = (sd: SceneData) => ((nodeWithGuid(sd.entities, QINST) as { members?: Record<string, { own?: Array<{ guid?: string }> }> } | undefined)?.members?.['/']?.own ?? []).find((n) => n.guid === KID);
    const s3 = await save();
    expect(kidLink(s3)).toBeDefined();
    expect(JSON.stringify(s3.entities).split(KID).length - 1).toBe(2); // stated once: its link's guid and its own EntityAttributes.guid
    await load(s3);
    expectSameBytes(kidLink(await save()), kidLink(s3)); // S3 == S4: the placement round-trips with the prefab missing
    install(qDoc());
    await load(s3);
    expect(kid().parentId).toBe(rootOf(QINST));
    expect(getAllEntities().find((e) => e.id === rootOf(QINST))!.missingPrefab).toBeUndefined();
  });
});

// #1788 (the store this names was deleted in #2001 S8b: the record holds this state, and the snapshot's `kept` is read
// from it): R2's kept store (orphan member rows, unreached legacy channels) was keyed by a stored root's guid BESIDE the
// tree, so a duplicate — a new root guid — used to carry none of it: the copy saved with neither, and only the original
// took the scene's edit once the template brought the member (or frame) back. The kept state now rides in the entity
// snapshot (`EntitySnapshot.kept`), with every identity it states re-minted for the copy.
describe('a duplicate carries its stored roots\' kept R2 state, under identities of its own (#1788)', () => {
  const DEAD = 'eeeeeeee-0000-4000-8000-00000000dead';
  const BEEF = 'eeeeeeee-0000-4000-8000-00000000beef';
  const KID = 'dddddddd-0000-4000-8000-000000001788';
  const T = 'cccccccc-0000-4000-8000-000000001788';
  const bare = (r: Record<string, unknown>) => { const { nodeGuid: _g, ...rest } = r; return rest; };
  /** PQ's shape, pre-v5 (no `nodeGuid`): R → A, and row 3 expanding Q. */
  const tDoc = () => ({ ...pqDoc(), id: T, version: 4, name: 'T', entities: pqDoc().entities.map((e) => bare(e as Record<string, unknown>)) });
  const channel = { 3: { 2: { Transform: { x: 7 } } } };
  /** P with the member the orphan row names brought back: R → Gone. */
  const pBack = () => ({ ...pDoc(), entities: [...pDoc().entities, row(3, 'Gone', 1, DEAD)] });
  const UIA = (target: string) => ({ bindings: [{ event: 'click', kind: 'call', action: 'noop', target }] });
  const targetOf = (id: number) => (readTraitData(id, meta('UIAction')) as { bindings: { target: string }[] }).bindings[0]!.target;
  const guidOfId = (id: number) => getAllEntities().find((e) => e.id === id)!.guid!;
  const orphanOf = (sd: SceneData, guid: string) => (entryOf(sd, guid)?.members as Record<string, { guid?: string; traits?: Record<string, unknown> }> | undefined)?.[`/${DEAD}`];
  /** An instance of P whose entry holds an orphan row for DEAD (x = 4). */
  const withOrphan = (extra: Record<string, unknown> = {}): SceneData => {
    const sc = scene(P);
    (sc.entities as unknown as Array<Record<string, unknown>>)[1]!.members = { [`/${DEAD}`]: { guid: BEEF, name: 'Gone', traits: { Transform: { x: 4 }, ...extra } } };
    return sc;
  };
  const duplicate = () => guidOfId(duplicateEntity(rootOf(INST), () => {})!);

  it('an orphan member row: the copy saves it under a fresh member guid, and both take the edit when the member returns', async () => {
    // Mutation: drop `kept` from the snapshot (`snapshotEntity`) — the copy saves no orphan row, and its Gone comes back at
    // P's 0. Mutation: skip the kept mints (`collectKeptMints`) — the copy's row pins BEEF too, two members one guid (#1293).
    install(pDoc());
    await load(withOrphan());
    const copyGuid = duplicate();
    const saved = await save();
    expect(orphanOf(saved, INST)).toEqual({ guid: BEEF, name: 'Gone', traits: { Transform: { x: 4 } } });
    const copyRow = orphanOf(saved, copyGuid)!;
    expect(copyRow.traits).toEqual({ Transform: { x: 4 } });
    expect(copyRow.guid).toBeTruthy();
    expect(copyRow.guid).not.toBe(BEEF);
    install(pBack());
    await load(saved);
    expect([x(inside(INST, 'Gone')), x(inside(copyGuid, 'Gone'))]).toEqual([4, 4]);
    expect(guidOfId(inside(INST, 'Gone'))).toBe(BEEF);
    expect(guidOfId(inside(copyGuid, 'Gone'))).toBe(copyRow.guid);
  });

  // Hunt seed 7191: a MEMBER nested root (PQ's Qrow) holds no kept state of its own — its owner's entry keeps the orphan
  // rows under its key. A duplicate promotes the copy to a stored root of its own (#1756), which must take that share.
  it('a duplicated member nested root takes its owner\'s kept rows under its key, re-keyed and re-minted', async () => {
    // Mutation: drop `ownerKept` in `copySnapshot`'s `keptOf` — the copy saves no orphan row, and its Gone comes back at
    // Q's 0. Mutation: skip it in `collectKeptMints` — the copy's row pins BEEF too (two members, one guid, #1293).
    install(pqDoc(), qDoc());
    const sc = scene(PQ);
    (sc.entities as unknown as Array<Record<string, unknown>>)[1]!.members = { [`/${gQrow}/${DEAD}`]: { guid: BEEF, name: 'Gone', traits: { Transform: { x: 4 } } } };
    await load(sc);
    const copyGuid = guidOfId(duplicateEntity(inside(INST, 'QR'), () => {})!);
    const saved = await save();
    const find = (v: unknown): Record<string, unknown> | undefined => {
      if (!v || typeof v !== 'object') return undefined;
      if ((v as { guid?: unknown }).guid === copyGuid && (v as { prefab?: unknown }).prefab) return v as Record<string, unknown>;
      for (const c of Object.values(v)) { const hit = find(c); if (hit) return hit; }
      return undefined;
    };
    const copyRow = (find(saved)?.members as Record<string, { guid?: string; name?: string; traits?: unknown }> | undefined)?.[`/${DEAD}`];
    expect(copyRow?.traits).toEqual({ Transform: { x: 4 } });
    expect(copyRow?.name).toBe('Gone');
    expect(copyRow?.guid).toBeTruthy();
    expect(copyRow?.guid).not.toBe(BEEF);
    const withGone = { ...qDoc(), entities: [...qDoc().entities, row(3, 'Gone', 1, DEAD)] };
    install(withGone);
    await load(saved);
    expect(x(inside(copyGuid, 'Gone'))).toBe(4);
    expect(guidOfId(inside(copyGuid, 'Gone'))).toBe(copyRow!.guid);
  });

  it('a legacy channel into a missing frame: the copy saves it too, and both apply it once the frame is back', async () => {
    // Mutation: drop `kept` from the snapshot — the copy saves no `nestedOverrides`, and its QX comes back at Q's 0.
    install(tDoc());
    uninstall(Q); // from the EDITOR cache too: a Q an earlier case left there reads as present, and the capture writes row 3 removed
    const sc = scene(T);
    (sc.entities as unknown as Array<Record<string, unknown>>)[1]!.nestedOverrides = channel;
    await load(sc);
    const copyGuid = duplicate();
    const saved = await save();
    expect(entryOf(saved, INST)!.nestedOverrides).toEqual(channel);
    expect(entryOf(saved, copyGuid)!.nestedOverrides).toEqual(channel);
    install(qDoc());
    await load(saved);
    expect([x(inside(INST, 'QX')), x(inside(copyGuid, 'QX'))]).toEqual([7, 7]);
  });

  it('refs between the kept row and the entities copied with it follow the copy, both ways (#1338)', async () => {
    // The orphan row's Gone targets member A; Kid (a plain child of the instance) targets Gone's pinned BEEF. Mutation:
    // rewrite `kept` with planCopyGuids' `remap` instead of `fullRemap` — the copy's Kid still targets the ORIGINAL's Gone.
    // Mutation: leave `kept` un-remapped — the copy's Gone still targets the original's A.
    install(pDoc());
    await load(scene(P));
    const pinA = (entryOf(await save(), INST)!.members as Record<string, { guid: string }>)[`/${gA}`]!.guid;
    const sc = withOrphan({ UIAction: UIA(pinA) });
    (sc.entities as unknown[]).push({ id: 99, traits: { EntityAttributes: { name: 'Kid', parentId: INST, guid: KID }, UIAction: UIA(BEEF) } });
    await load(sc);
    const copyGuid = duplicate();
    const saved = await save();
    install(pBack());
    await load(saved);
    const copyKid = getAllEntities().find((e) => e.name === 'Kid' && e.guid !== KID)!;
    expect(targetOf(inside(INST, 'Gone'))).toBe(guidOfId(inside(INST, 'A')));
    expect(targetOf(inside(copyGuid, 'Gone'))).toBe(guidOfId(inside(copyGuid, 'A')));
    expect(targetOf(rootOf(KID))).toBe(BEEF);
    expect(targetOf(copyKid.id)).toBe(guidOfId(inside(copyGuid, 'Gone')));
  });

  it('an undone duplicate writes nothing of the copy\'s kept state, and its redo brings the same identities back', async () => {
    // The undo leaves the copy's kept entry in the store under a guid nothing holds; the writers read the store only for
    // a LIVE root, so no save writes it.
    install(pDoc());
    await load(withOrphan());
    clearHistory();
    const copyGuid = duplicate();
    const minted = orphanOf(await save(), copyGuid)!.guid!;
    await undo();
    const afterUndo = JSON.stringify(await save());
    expect(afterUndo).not.toContain(copyGuid);
    expect(afterUndo).not.toContain(minted);
    expect(afterUndo.split(BEEF).length - 1).toBe(1);
    await redo();
    expect(orphanOf(await save(), copyGuid)!.guid).toBe(minted);
  });

  it('delete + undo keeps an instance\'s kept state', async () => {
    // ⚠️ Not falsifiable against the snapshot carry TODAY: a delete leaves the store entry in place, so the undo finds it
    // either way. It pins the outcome against a later prune of a deleted root's entry, which the carry then makes safe.
    install(pDoc());
    await load(withOrphan());
    const before = entryOf(await save(), INST);
    expect(orphanOf(await save(), INST)?.guid).toBe(BEEF); // precondition: the row is kept
    clearHistory();
    deleteEntitiesWithUndo([rootOf(INST)]);
    expect(entryOf(await save(), INST)).toBeUndefined();
    await undo();
    expect(entryOf(await save(), INST)).toEqual(before);
  });
});

// #1790, owner ruling D (relayed by the hub): Create Prefab follows Unity over what R2 keeps. (1) A tree holding an
// instance whose NESTED prefab could not be expanded is refused, naming the member and the prefab — Unity will not save a
// missing prefab instance into an asset. (2) Kept UNUSED overrides (a readable template that dropped a member, or has no
// row yet for a legacy channel) travel with the instance INTO the new template; only their identity stays in the scene.
// Before, both kinds were written by nobody: the template gate kept scene rows out, and the swallowed root was no longer
// a stored root for the scene writer to read.
describe('Create Prefab over R2 kept state: refuse a missing nested frame, bake unused overrides (#1790)', () => {
  const HOLDER = 'dddddddd-0000-4000-8000-000000001600';
  const SECOND = 'dddddddd-0000-4000-8000-000000001790';
  const DEAD = 'eeeeeeee-0000-4000-8000-00000000d790';
  const BEEF = 'eeeeeeee-0000-4000-8000-00000000b790';
  const T = 'cccccccc-0000-4000-8000-000000001790';
  const bare = (r: Record<string, unknown>) => { const { nodeGuid: _g, ...rest } = r; return rest; };
  /** PQ's shape, pre-v5; `withQ` false leaves out row 3 (the frame a legacy channel names). */
  const tDoc = (withQ = true) => ({ ...pqDoc(), id: T, version: 4, name: 'T', entities: pqDoc().entities.slice(0, withQ ? 3 : 2).map((e) => bare(e as Record<string, unknown>)) });
  const channel = { 3: { 2: { Transform: { x: 7 } } } };
  const pBack = () => ({ ...pDoc(), entities: [...pDoc().entities, row(3, 'Gone', 1, DEAD)] });
  const holder = () => rootOf(HOLDER);
  const create = () => createPrefabFromEntity(holder(), 'prefabs/Held.prefab.json', 'Held', async () => true);
  const refusalOf = (r: Awaited<ReturnType<typeof create>>) => (r && typeof r === 'object' && 'refused' in r ? r.refused : '');
  const heldDoc = () => JSON.parse(writes.filter((w) => w.path.endsWith('Held.prefab.json')).pop()!.content) as PrefabFile;
  /** The saved scene with a SECOND instance of the new prefab dropped in beside the first. */
  const withSecond = (sd: SceneData, prefab: string): SceneData => ({
    ...sd, entities: [...(sd.entities as unknown[]), { id: 90, prefab, guid: SECOND, traits: { EntityAttributes: { name: 'Held2', parentId: 0 } } }],
  } as unknown as SceneData);

  it('(1) refuses a tree whose nested frame could not be expanded, naming the member and the prefab — with or without a kept statement', async () => {
    // Mutation: drop the refusal in `createPrefabFromEntity` — the file is written, and (a)'s channel is lost for good.
    for (const withChannel of [true, false]) {
      install(tDoc());
      uninstall(Q); // from the EDITOR cache too: an earlier case can leave Q there
      const sc = scene(T);
      if (withChannel) (sc.entities as unknown as Array<Record<string, unknown>>)[1]!.nestedOverrides = channel;
      await load(sc);
      writes.length = 0;
      const refused = refusalOf(await create());
      expect(refused).toMatch(/"Qrow" in "R" is a nested prefab that could not be loaded/);
      expect(refused).toContain(resolveRef(Q) ?? Q); // the prefab named by its path when the manifest knows it
      expect(writes.length).toBe(0);
    }
  });

  it('(1) a v5 instance whose nested prefab went missing after a save is refused too (the issue\'s (b))', async () => {
    install(pqDoc(), qDoc());
    await load(scene(PQ));
    writeTraitFieldWithUndo(inside(INST, 'QX'), meta('Transform'), 'x', 7);
    const control = await save();
    uninstall(Q);
    await load(control);
    expect(refusalOf(await create())).toMatch(/"Qrow"/);
  });

  it('(1) the agent prefab create op refuses the same tree, with the same words', async () => {
    // Mutation: drop the refusal in the agent op — it writes the template.
    install(tDoc());
    uninstall(Q);
    await load(scene(T));
    await expect(runAgentOp('prefab', { action: 'create', entityGuid: HOLDER, path: 'prefabs/Made.prefab.json' })).rejects.toThrow(/"Qrow" in "R" is a nested prefab that could not be loaded/);
    expect(writes.length).toBe(0);
  });

  it('(1) a nested prefab the editor cache has merely not warmed is NOT refused: the check runs after the warm', async () => {
    // Mutation: ask `unexpandedNestedRefusal` before `preloadNestedPrefabsForSubtree` — Create Prefab refuses a readable Q.
    registerAsset(Q, '/assets/q1790.prefab.json', 'prefab');
    install(pqDoc(), qDoc());
    await load(scene(PQ));
    setPrefabCache(Q, null); // cold in the editor; readable on disk
    vi.stubGlobal('fetch', async (url: string) => String(url).includes('q1790')
      ? { ok: true, status: 200, json: async () => qDoc(), text: async () => JSON.stringify(qDoc()) }
      : onDisk(String(url)) ?? { ok: false, status: 404, json: async () => ({}), text: async () => '' });
    expect(refusalOf(await create())).toBe('');
    expect(heldDoc().entities.filter((e) => e.prefab).map((e) => e.prefab)).toEqual([PQ]);
  });

  it('(2) an orphan row\'s EDIT goes into the new template and its identity stays in the scene; a SECOND instance gets the edit', async () => {
    // Mutation: drop `bakingKeptState` from the gate in `captureRowChannels` — the template has no row, and neither
    // instance's Gone gets x = 4. Mutation (before #2001 S8b deleted the kept stores): skip `settleSwallowedKeptState` — the scene writes no identity row, and the
    // first instance's Gone comes back under a derived guid, not BEEF.
    install(pDoc());
    const sc = scene(P);
    (sc.entities as unknown as Array<Record<string, unknown>>)[1]!.members = { [`/${DEAD}`]: { guid: BEEF, name: 'Gone', traits: { Transform: { x: 4 } } } };
    await load(sc);
    const created = await create();
    expect(refusalOf(created)).toBe('');
    const doc = heldDoc();
    const rowR = doc.entities.find((e) => e.prefab === P)!;
    expect((rowR.members as Record<string, unknown>)[`/${DEAD}`]).toEqual({ traits: { Transform: { x: 4 } } }); // no guid (#1293)
    const saved = await save();
    const heldEntry = entryOf(saved, HOLDER)! as { members: Record<string, { guid?: string; traits?: unknown }> };
    const identity = Object.entries(heldEntry.members).find(([k]) => k.endsWith(`/${DEAD}`));
    expect(identity?.[1]).toEqual({ guid: BEEF, name: 'Gone' }); // identity only: a scene edit too would pin the old value
    expect(JSON.stringify(saved)).not.toContain('"x":4');

    install(pBack(), doc);
    await load(withSecond(saved, doc.id!));
    expect(x(inside(HOLDER, 'Gone'))).toBe(4);
    expect(x(inside(SECOND, 'Gone'))).toBe(4);
    expect(guidOfEntity(inside(HOLDER, 'Gone'))).toBe(BEEF);
    expect(guidOfEntity(inside(SECOND, 'Gone'))).not.toBe(BEEF);
  });

  // #2001 S8b: the bake reads what is kept from the RECORD (`keptFromRecord`). A LIVE member's row can hold a part its
  // member does not take, too (#1914 R4: here a field its component has no such field for): that part travels as well.
  it('(2) the part of a LIVE member\'s row its member does not take goes into the new template (#1914 R4)', async () => {
    // Mutation: in `keptFromRecord`, collect a live row's unused part nowhere — the template's row for A has no `bogus`.
    install(pDoc());
    const sc = scene(P);
    (sc.entities as unknown as Array<Record<string, unknown>>)[1]!.members = { [`/${gA}`]: { traits: { Transform: { bogus: 9 } } } };
    await load(sc);
    expect(refusalOf(await create())).toBe('');
    const rowR = heldDoc().entities.find((e) => e.prefab === P)!;
    expect((rowR.members as Record<string, unknown>)[`/${gA}`]).toEqual({ traits: { Transform: { bogus: 9 } } });
    expect(JSON.stringify(await save())).not.toContain('bogus');
  });

  it('(2) a legacy channel into a row the template does not have yet goes into the new template, and a SECOND instance gets it', async () => {
    // Mutation: drop `bakingKeptState` from the gate — the template row has no `nestedOverrides`, and QX comes in at 0.
    install(tDoc(false));
    const sc = scene(T);
    (sc.entities as unknown as Array<Record<string, unknown>>)[1]!.nestedOverrides = channel;
    await load(sc);
    expect(refusalOf(await create())).toBe('');
    const doc = heldDoc();
    expect(doc.entities.find((e) => e.prefab === T)!.nestedOverrides).toEqual(channel);
    const saved = await save();
    expect(JSON.stringify(saved)).not.toContain('nestedOverrides');
    install(tDoc(), qDoc(), doc);
    await load(withSecond(saved, doc.id!));
    expect([x(inside(HOLDER, 'QX')), x(inside(SECOND, 'QX'))]).toEqual([7, 7]);
  });

  it('(2) a swallowed scene-added REFERENCE node keeps its edit on this instance too (close-out review F3)', async () => {
    // It stays a stored root, and the scene save writes it whole over the template's node — so its rows must stay whole.
    // Mutation: reduce a still-stored root's rows to identity (the first cut) — this instance's Gone comes back at 0.
    const DEAD2 = 'eeeeeeee-0000-4000-8000-00000000d791';
    const BEEF2 = 'eeeeeeee-0000-4000-8000-00000000b791';
    const qBack = () => ({ ...qDoc(), entities: [...qDoc().entities, row(3, 'Gone', 1, DEAD2)] });
    install(pDoc(), qDoc());
    await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, members: { [`/${DEAD2}`]: { guid: BEEF2, name: 'Gone', traits: { Transform: { x: 4 } } } },
      traits: { EntityAttributes: { name: 'QInst', parentId: HOLDER } } }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    expect(refusalOf(await create())).toBe('');
    const doc = heldDoc();
    const saved = await save();
    install(qBack(), doc);
    await load(withSecond(saved, doc.id!));
    const gones = getAllEntities().filter((e) => e.name === 'Gone');
    expect(gones.map((e) => x(e.id))).toEqual([4, 4]);
    expect(gones.map((e) => e.guid)).toContain(BEEF2);
  });

  it('(2) a baked legacy slot states no scene identity: its node\'s guid is not written into the template (close-out review F4)', async () => {
    // Mutation (before #2001 S8b deleted the kept stores): bake the kept legacy channels verbatim (`withKeptLegacy`) — the template states SG, and both instances
    // spawn SN under that one guid (#1293).
    const SG = 'dddddddd-0000-4000-8000-00000000f004';
    install(tDoc(false));
    const sc = scene(T);
    (sc.entities as unknown as Array<Record<string, unknown>>)[1]!.nestedStructure = { 3: { added: [
      { parentLocalId: 1, guid: SG, name: 'SN', traits: { EntityAttributes: { name: 'SN', parentId: 0, guid: SG }, Transform: { x: 3, y: 0, z: 0 } }, children: [] },
    ] } };
    await load(sc);
    expect(refusalOf(await create())).toBe('');
    const doc = heldDoc();
    expect(JSON.stringify(doc)).not.toContain(SG);
    install(tDoc(), qDoc(), doc);
    await load(withSecond(await save(), doc.id!));
    const sns = getAllEntities().filter((e) => e.name === 'SN');
    expect(sns.map((e) => x(e.id))).toEqual([3, 3]);
    expect(new Set(sns.map((e) => e.guid)).size).toBe(2);
  });

  it('(1) a nested row the scene REMOVED, readable but cold (live nowhere), is not refused (close-out review F5)', async () => {
    // Mutation: drop the nested-document warm in `preloadNestedPrefabsForSubtree` — Create Prefab names Q as missing.
    registerAsset(Q, '/assets/q1790f5.prefab.json', 'prefab');
    install(pqDoc(), qDoc());
    await load(scene(PQ));
    deleteEntitiesWithUndo([inside(INST, 'QR')]);
    const saved = await save();
    await load(saved);
    setPrefabCache(Q, null); // live nowhere, so no warm has seen it; readable on disk
    vi.stubGlobal('fetch', async (url: string) => String(url).includes('q1790f5')
      ? { ok: true, status: 200, json: async () => qDoc(), text: async () => JSON.stringify(qDoc()) }
      : onDisk(String(url)) ?? { ok: false, status: 404, json: async () => ({}), text: async () => '' });
    expect(refusalOf(await create())).toBe('');
  });

  it('(2) a tag that REFUSED settles nothing: the unlinked instance keeps its edit (close-out review F6)', async () => {
    // Mutation: settle whatever the tag did (drop `linked` in `tagCreatedPrefab`) — the orphan row is cut to identity.
    install(pDoc());
    const sc = scene(P);
    (sc.entities as unknown as Array<Record<string, unknown>>)[1]!.members = { [`/${DEAD}`]: { guid: BEEF, name: 'Gone', traits: { Transform: { x: 4 } } } };
    await load(sc);
    const mismatched = { id: 'cccccccc-0000-4000-8000-00000000f006', version: 8, name: 'X', rootLocalId: 1, entities: [] } as unknown as PrefabFile;
    tagCreatedPrefab(holder(), 'prefabs/X.prefab.json', mismatched);
    const members = entryOf(await save(), INST)!.members as Record<string, unknown>;
    expect(members[`/${DEAD}`]).toEqual({ guid: BEEF, name: 'Gone', traits: { Transform: { x: 4 } } });
  });

  it('(2) undo puts the kept state back on the instance as it was, and redo bakes it again', async () => {
    // Mutation: drop `undoKept()` from the undo's `unstamp` — after the undo the scene saves the instance with only the
    // identity row: the edit x = 4 is gone from the scene, and the file that held it is trashed.
    install(pDoc());
    const sc = scene(P);
    (sc.entities as unknown as Array<Record<string, unknown>>)[1]!.members = { [`/${DEAD}`]: { guid: BEEF, name: 'Gone', traits: { Transform: { x: 4 } } } };
    await load(sc);
    const before = entryOf(await save(), INST);
    clearHistory();
    // The undo's precondition re-reads the file (serve what the create wrote), then trashes it.
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/api/delete-asset')) return { ok: true, status: 200, json: async () => ({ ok: true, trashed: 1, missing: [], failed: [] }) };
      const last = writes.filter((w) => String(url).includes('Held.prefab.json') && w.path.endsWith('Held.prefab.json')).pop();
      return last ? new Response(last.content, { status: 200 }) : { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    });
    const created = await create();
    pushAction((created as { action: Parameters<typeof pushAction>[0] }).action);
    await undo();
    expect(entryOf(await save(), INST)).toEqual(before);
    await redo();
    const heldEntry = entryOf(await save(), HOLDER)! as { members: Record<string, unknown> };
    expect(Object.entries(heldEntry.members).find(([k]) => k.endsWith(`/${DEAD}`))?.[1]).toEqual({ guid: BEEF, name: 'Gone' });
  });
});
const guidOfEntity = (id: number) => getAllEntities().find((e) => e.id === id)!.guid!;

describe('a nested frame the load could not expand is not written as removed once the cache holds its prefab (#1812, #1805)', () => {
  /** PQ with A moved (x 1): a template change that makes a Refresh rebuild the frame. */
  const pqMovedA = () => ({ ...pqDoc(), entities: pqDoc().entities.map((e) => e.localId === 2 ? row(2, 'A', 1, gA, 1) : e) });
  // The save asked the editor CACHE whether a nested row expanded. A frame built while its child was unreadable, saved once
  // the cache held the child, read as unclaimed and wrote `removed: [3]`: after a reload the nested instance and its edits
  // were gone for good. Now the frame record lists the rows its expansion could not expand (`FrameRootRecord.unexpanded`).
  // Mutation for every case here: in `captureInstanceStructure`, drop the record read (`unexpandedRowsOf` → undefined).
  /** Does the save state row 3 (Qrow) removed — as a member row (v8+) or in the legacy list? */
  const qrowRemoved = (s: SceneData): boolean => {
    const e = entryOf(s, INST)! as { removed?: number[]; members?: Record<string, { removed?: boolean }> };
    return !!e.members?.[`/${gQrow}`]?.removed || !!e.removed?.includes(3);
  };
  /** A save of PQ's instance with QX edited, made with every prefab present. */
  const controlSave = async () => {
    install(qDoc(), pqDoc());
    await load(scene(PQ));
    writeTraitFieldWithUndo(inside(INST, 'QX'), meta('Transform'), 'x', 8);
    return save();
  };

  it('Q restored mid-session, with nothing rebuilding the instance (#1812, 1)', async () => {
    const control = await controlSave();
    uninstall(Q);
    await load(control);
    expect(getAllEntities().filter((e) => e.name === 'QX')).toEqual([]); // precondition: row 3 did not expand
    install(qDoc()); // back on disk and in both caches; the live frame is still the one built without it
    const saved = await save();
    expect(qrowRemoved(saved)).toBe(false);
    expectSameBytes(entryOf(saved, INST), entryOf(control, INST));
    await load(saved);
    expect(x(inside(INST, 'QX'))).toBe(8);
  });

  it('a leftover EDITOR cache entry while the load could not fetch Q — #1805\'s stale entry after an Assets delete (#1812, 2)', async () => {
    const control = await controlSave();
    prefabs.delete(Q); // the loader's fetch fails; the editor's sync cache still answers (setPrefabCache is untouched)
    await load(control);
    expect(getAllEntities().filter((e) => e.name === 'QX')).toEqual([]); // precondition: row 3 did not expand
    const saved = await save();
    expect(qrowRemoved(saved)).toBe(false);
    install(qDoc());
    await load(saved);
    expect(x(inside(INST, 'QX'))).toBe(8);
  });

  it('load cold, warm, save keeps the row; a Refresh then expands it, the record clears, and the save is still right', async () => {
    const control = await controlSave();
    uninstall(Q);
    await load(control);
    install(qDoc());
    expect(qrowRemoved(await save())).toBe(false);
    // A template change makes the frame stale, and the Refresh rebuilds it — now with Q readable, so row 3 expands.
    install(pqMovedA());
    await rebaseStaleInstances();
    expect(x(inside(INST, 'A'))).toBe(1); // precondition: the Refresh did rebuild
    expect(x(inside(INST, 'QX'))).toBe(8); // row 3 expanded, with the frame's kept edit
    const saved = await save();
    expect(qrowRemoved(saved)).toBe(false);
    await load(saved);
    expect(x(inside(INST, 'QX'))).toBe(8);
  });

  it('a row the user DID delete is still written removed, even once its prefab stops resolving (the control)', async () => {
    // Mutation: answer "present" for every row the record knows (`unexpanded.has(...) || true`) — the removal is lost.
    install(qDoc(), pqDoc());
    await load(scene(PQ));
    deleteEntitiesWithUndo([inside(INST, 'QR')]);
    expect(qrowRemoved(await save())).toBe(true);
    uninstall(Q); // evicted mid-session: the record still says the frame expanded row 3, so its absence is the user's
    expect(qrowRemoved(await save())).toBe(true);
  });

  it('a scene removal of a row that could not expand is written again (a layer removal leaves the record\'s list)', async () => {
    // Mutation: drop `noteRowsRemoved` from `applyStructureCore` — the row reads as unexpanded, and the save drops the
    // scene's removal, so the row comes back once Q does.
    install(qDoc(), pqDoc());
    await load(scene(PQ));
    deleteEntitiesWithUndo([inside(INST, 'QR')]);
    const control = await save();
    uninstall(Q);
    await load(control);
    const saved = await save();
    expect(qrowRemoved(saved)).toBe(true);
    install(qDoc());
    await load(saved);
    expect(getAllEntities().filter((e) => e.name === 'QX')).toEqual([]);
  });

  it('a LEGACY removal list naming a row that could not expand is written again (no member row keeps it)', async () => {
    // A v8+ removal is a member row, which R2 keeps when it names nothing live; the legacy `removed` list has no such
    // keeper, so only the record says the row was removed. Mutation: drop `noteRowsRemoved` from `applyStructureCore`.
    install(pqDoc());
    const sc = scene(PQ);
    (sc.entities as unknown as Array<Record<string, unknown>>)[1]!.removed = [3];
    await load(sc); // Q missing: row 3 cannot expand, and the entry removes it
    install(qDoc());
    expect(qrowRemoved(await save())).toBe(true);
  });

  it('the EDITOR expansion records it too: a Refresh while Q is still missing, then Q comes back', async () => {
    // Mutation: record `[]` in `instantiatePrefab`'s `noteFrameDoc` — the rebuilt frame lists nothing, and the save writes
    // row 3 removed once Q is readable.
    const control = await controlSave();
    uninstall(Q);
    await load(control);
    install(pqMovedA());
    await rebaseStaleInstances();
    expect(x(inside(INST, 'A'))).toBe(1); // precondition: the Refresh rebuilt the frame, with Q still missing
    install(qDoc());
    expect(qrowRemoved(await save())).toBe(false);
  });

  it('Create Prefab refuses a frame that never expanded its row, though the cache holds the child now (#1790\'s refusal)', async () => {
    // Mutation: drop the record read from `unexpandedNestedRows` (`skipped` → undefined) — the cache reads Q as fine, the
    // create goes ahead, and the new template writes the instance with its frame's row missing.
    const control = await controlSave();
    uninstall(Q);
    await load(control);
    install(qDoc());
    const created = await createPrefabFromEntity(rootOf(INST), 'prefabs/New1812.prefab.json', 'New', async () => true);
    expect(created && typeof created === 'object' && 'refused' in created ? created.refused : '').toMatch(/could not be loaded/);
  });

  // Close-out review: the runtime cache and the editor's hold SEPARATE copies of one file (an editor write stores a clone
  // in the runtime's), and the record keeps the loader's. Every case above installs ONE object in both, so none could see
  // that a record read by object identity answered nothing here. Mutation: back to `rec.doc === doc` in `unexpandedRowsOf`.
  describe('the runtime and editor caches holding separate copies of PQ', () => {
    /** The control loaded with Q missing, then Q restored, the editor cache holding its OWN copy of PQ. */
    const loadedApart = async () => {
      const control = await controlSave();
      uninstall(Q);
      await load(control);
      setPrefabCache(PQ, JSON.parse(JSON.stringify(pqDoc())) as never);
      install(qDoc());
      writeTraitFieldWithUndo(inside(INST, 'A'), meta('Transform'), 'x', 3); // an unrelated edit, for Revert and Apply
    };
    /** The editor cache's own copy — what the Apply dialog and the agent's key listing pass. */
    const editorPq = () => getCachedPrefabSync(PQ) as PrefabFile;

    it('Apply\'s key list offers no removal of the row, and Apply All leaves it in the template', async () => {
      await loadedApart();
      const keys = collectInstanceOverrideKeys(rootOf(INST), editorPq());
      expect(keys.all.some((k) => k.includes(gQrow) || k.startsWith('-removed.'))).toBe(false);
      writes.length = 0;
      await applyToPrefabSelective(rootOf(INST), new Set(keys.all));
      const pq = writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((d) => d.id === PQ).pop();
      expect(pq?.entities.some((e) => e.localId === 3)).toBe(true);
    });

    it('a Revert of an unrelated field does not write the row removed', async () => {
      await loadedApart();
      await revertOverridesSelective(rootOf(INST), new Set([`${gA}.Transform.x`]));
      expect(qrowRemoved(await save())).toBe(false);
    });

    it('Create Prefab is refused', async () => {
      await loadedApart();
      const created = await createPrefabFromEntity(rootOf(INST), 'prefabs/Apart1812.prefab.json', 'Apart', async () => true);
      expect(created && typeof created === 'object' && 'refused' in created ? created.refused : '').toMatch(/could not be loaded/);
    });
  });

  it('the record is runtime-only: no save carries it', async () => {
    const control = await controlSave();
    uninstall(Q);
    await load(control);
    install(qDoc());
    expect(JSON.stringify(await save())).not.toContain('unexpanded');
  });
});

// #1802: Apply's promotion of a scene-added reference node follows owner ruling D as Create Prefab does (#1790): what R2
// kept for the node (an orphan member row) is baked into the promoted row in template form, and its identity stays in the
// scene, on the stored root the node is now a member of. Before, the row wrote no `members` and the scene lost the guid.
describe('Apply\'s promotion of a scene-added reference node keeps its kept R2 state (#1802, owner ruling D)', () => {
  const DEAD = 'eeeeeeee-0000-4000-8000-00000000a790';
  const BEEF = 'eeeeeeee-0000-4000-8000-00000000a791';
  const HOLDER = 'dddddddd-0000-4000-8000-000000001600';
  const written = (id: string) => writes.map((w) => JSON.parse(w.content) as PrefabFile).filter((p) => p.id === id).pop();
  /** Q with a member Q never had until now, at the orphan row's node guid. */
  const qBack = () => ({ ...qDoc(), entities: [...qDoc().entities, row(3, 'Gone', 1, DEAD)] });
  /** P's instance with QINST, an instance of Q holding an orphan row, added under A. */
  const setUp = async () => {
    install(pDoc(), qDoc());
    await load(scene(P, [{
      id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: HOLDER } },
      members: { [`/${DEAD}`]: { guid: BEEF, name: 'Gone', traits: { Transform: { x: 4 } } } },
    }]));
    reparentEntity(rootOf(QINST), inside(INST, 'A'));
    const before = await save();
    expect(JSON.stringify(entryOf(before, INST))).toContain(BEEF); // precondition: the node stores the orphan row
    writes.length = 0;
    const key = collectInstanceOverrideKeys(rootOf(INST), prefabs.get(P) as PrefabFile).all.find((k) => k.endsWith(`+added.${QINST}`));
    expect(key).toBeTruthy();
    return { before, key: key! };
  };
  /** The scene's member rows of INST whose key ends at the orphan node. */
  const orphanRow = (sd: SceneData) => Object.entries((entryOf(sd, INST)!.members ?? {}) as Record<string, unknown>).find(([k]) => k.endsWith(`/${DEAD}`))?.[1];

  it('the promoted row carries the edit in template form, and the scene keeps only its identity', async () => {
    // Mutations: drop `withKeptStateBake` around the promotion's recapture — the row has no `members`; drop the settle after
    // the refresh (before #2001 S8b deleted the kept stores) — the scene save no longer holds BEEF.
    const { key } = await setUp();
    expect((await applyToPrefabSelective(rootOf(INST), new Set([key]))).applied).toBe(true);
    const promoted = written(P)!.entities.find((e) => e.prefab === Q)!;
    // Beside the row's own `"/"` row (prefab v10: the nested root's name and order).
    expect(Object.keys(promoted.members ?? {})).toEqual(['/', `/${DEAD}`]);
    expect(promoted.members?.[`/${DEAD}`]).toEqual({ traits: { Transform: { x: 4 } } });
    expect(JSON.stringify(promoted)).not.toContain(BEEF); // no scene identity in a template (#1293)
    const saved = await save();
    expect(orphanRow(saved)).toEqual({ guid: BEEF, name: 'Gone' });
    // …and when Q gains the member, a reload gives it the scene's guid and the template's edit.
    install(qBack(), written(P) as never);
    await load(saved);
    const gone = inside(INST, 'Gone');
    expect(x(gone)).toBe(4);
    expect(getAllEntities().find((e) => e.id === gone)!.guid).toBe(BEEF);
  });

  it('the undo gives the scene back as it was before the Apply (sceneBefore), orphan row and all', async () => {
    const { before, key } = await setUp();
    clearHistory();
    const res = await applyToPrefabWithUndo(rootOf(INST), new Set([key]));
    expect(res.applied).toBe(true);
    await undo();
    expect(entryOf(await save(), INST)).toEqual(entryOf(before, INST));
  });

  it('the bake scope is restored when the write inside it throws', () => {
    // Mutation: set the flag without try/finally in `withKeptStateBake` — it stays set, and every later write bakes.
    expect(() => withKeptStateBake(true, () => { throw new Error('boom'); })).toThrow('boom');
    expect(bakingKeptStateForTest()).toBe(false);
    withKeptStateBake(true, () => {
      expect(() => withKeptStateBake(false, () => { throw new Error('inner'); })).toThrow('inner');
      expect(bakingKeptStateForTest()).toBe(true); // a nested scope restores the outer one, not "off"
    });
    expect(bakingKeptStateForTest()).toBe(false);
  });
});

// #1807: Create Prefab's undo right after a Rename's undo. The rename's undo moves the file back, but the manifest follows
// only at its next push (debounced), so it still maps the prefab's guid to the RENAMED path. The undo untagged by resolving
// its path through that manifest, got nothing, looked for the raw path no entity carries, and left the tree linked to the
// prefab it had just trashed: a Missing Prefab on the next load. It now untags by the document's own guid.
describe('Create Prefab\'s undo untags by the prefab document\'s guid, not through a manifest lagging a move (#1807)', () => {
  const PLAIN = 'dddddddd-0000-4000-8000-000000001807';
  const plainScene = (): SceneData => ({
    id: 's1807', version: 16, name: 'S', resources: [],
    entities: [
      { id: 1, traits: { EntityAttributes: { name: 'Plain', parentId: 0, guid: PLAIN } } },
      { id: 2, traits: { EntityAttributes: { name: 'Leaf', parentId: PLAIN, guid: 'dddddddd-0000-4000-8000-000000001808' } } },
    ],
  } as unknown as SceneData);
  const piOf = (name: string) => readTraitData(getAllEntities().find((e) => e.name === name)!.id, meta('PrefabInstance')) as { source?: string } | null;
  /** Serve the created file to the undo's precondition, and trash it on request. */
  const serveCreated = () => vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).includes('/api/delete-asset')) return { ok: true, status: 200, json: async () => ({ ok: true, trashed: 1, missing: [], failed: [] }) };
    const last = writes.filter((w) => w.path.endsWith('Plain.prefab.json')).pop();
    return last && String(url).includes('Plain.prefab.json') ? new Response(last.content, { status: 200 }) : { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  });

  it('the undo untags the tree while the manifest still names the renamed path, and a reload gives the plain tree', async () => {
    // Mutation: drop the document in `instanceSourceRef` (resolve by path alone) — the untag matches nothing, logs
    // "the tree was left tagged", and Plain and Leaf keep their link to the trashed prefab.
    await load(plainScene());
    clearHistory();
    serveCreated();
    const created = await createPrefabFromEntity(rootOf(PLAIN), 'prefabs/Plain.prefab.json', 'Plain', async () => true);
    const doc = (created as { prefab: PrefabFile }).prefab;
    pushAction((created as { action: Parameters<typeof pushAction>[0] }).action);
    expect(piOf('Plain')?.source).toBe(doc.id); // precondition: tagged by its guid
    // The rename's undo has moved the file back, and the manifest has not caught up: it names the renamed path.
    const landed = resolveGuidToPath(doc.id!)!;
    registerAsset(doc.id!, landed.replace('Plain.prefab.json', 'R56.prefab.json'), 'prefab');
    expect(getGuidForPath(landed)).toBeUndefined(); // precondition: a lookup by the path answers nothing
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await undo();
    const leftTagged = error.mock.calls.some((c) => String(c[0]).includes('untagEntityTreeAsInstance'));
    error.mockRestore();
    expect(leftTagged).toBe(false);
    expect(piOf('Plain')).toBeNull();
    expect(piOf('Leaf')).toBeNull();
    const saved = await save();
    uninstall(doc.id!);
    await load(saved);
    expect(getAllEntities().map((e) => e.name).sort()).toEqual(['Leaf', 'Plain']);
    expect(piOf('Plain')).toBeNull();
  });

  it('the agent create\'s undo does the same (its link-only undo)', async () => {
    // Mutation: as above, or drop the document from the agent undo's `untagEntityTreeAsInstance` call.
    await load(plainScene());
    clearHistory();
    serveCreated();
    await runAgentOp('prefab', { action: 'create', entityGuid: PLAIN, path: 'prefabs/Plain.prefab.json' });
    const source = piOf('Plain')?.source;
    expect(source).toBeTruthy(); // precondition: tagged
    registerAsset(source!, resolveGuidToPath(source!)!.replace('Plain.prefab.json', 'R56.prefab.json'), 'prefab');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await undo();
    const leftTagged = error.mock.calls.some((c) => String(c[0]).includes('untagEntityTreeAsInstance'));
    error.mockRestore();
    expect(leftTagged).toBe(false);
    expect(piOf('Plain')).toBeNull();
    expect(piOf('Leaf')).toBeNull();
  });
});

describe('Create Prefab refuses a tree holding a frame built from other rows than the cache holds (#1815, I3)', () => {
  // The capture measures a frame through `captureDoc`, which reads the CACHE first. INST was expanded from a PQ with row 3
  // (Qrow → Q); the cache then holds a newer PQ without it. Nothing refused, and the new template wrote the live Qrow
  // expansion as a template-ADDED reference node — a row only the OLD document had, brought back.
  // Mutation for every case here: drop `staleFramesInTreeRefusal` from both callers (or make it return null).
  const HOLDER = 'dddddddd-0000-4000-8000-000000001600';
  /** PQ as a later write left it: row 3 gone. */
  const pqWithoutQ = () => ({ ...pqDoc(), entities: pqDoc().entities.slice(0, 2) });
  const refusalOf = (r: unknown) => (r && typeof r === 'object' && 'refused' in r ? (r as { refused: string }).refused : '');
  /** INST expanded from PQ with row 3; the editor cache then holds PQ without it (the frame is not rebased). */
  const loadStale = async () => {
    install(pqDoc(), qDoc());
    await load(scene(PQ));
    expect(getAllEntities().some((e) => e.name === 'QR')).toBe(true); // precondition: row 3 expanded
    setPrefabCache(PQ, pqWithoutQ() as never);
    writes.length = 0;
  };

  it('the human path refuses over the holder and over the instance root, and writes nothing', async () => {
    for (const guid of [HOLDER, INST]) {
      await loadStale();
      const refused = refusalOf(await createPrefabFromEntity(rootOf(guid), 'prefabs/Stale.prefab.json', 'Stale', async () => true));
      expect(refused).toMatch(/built from a different version of .* than the editor now holds/);
      expect(refused).toMatch(/Reload the scene/);
      expect(writes.length).toBe(0);
    }
  });

  it('the agent prefab create op refuses the same tree, with the same words', async () => {
    await loadStale();
    await expect(runAgentOp('prefab', { action: 'create', entityGuid: HOLDER, path: 'prefabs/Stale.prefab.json' }))
      .rejects.toThrow(/built from a different version of .* than the editor now holds/);
    expect(writes.length).toBe(0);
  });

  it('the control: a frame built from the document the cache holds is not refused, whatever its values', async () => {
    // A VALUE change is not a row change (`rowsMeanTheSame`): refusing it would block over any byte difference.
    install(pqDoc(), qDoc());
    await load(scene(PQ));
    setPrefabCache(PQ, { ...pqDoc(), entities: pqDoc().entities.map((e) => e.localId === 2 ? row(2, 'A', 1, gA, 5) : e) } as never);
    const created = await createPrefabFromEntity(rootOf(HOLDER), 'prefabs/Fresh.prefab.json', 'Fresh', async () => true);
    expect(refusalOf(created)).toBe('');
  });
});

describe('Create Prefab from an instance ROOT drops the old prefab\'s kept rows on it — an unpack (#1814, hub ruling)', () => {
  // INST, an instance of P, keeps an orphan member row `/DEAD` (a member P dropped). Create Prefab over INST makes an
  // ORIGINAL and relinks INST to it; the row stayed on INST, keyed in P's identity, and every save wrote it again. Unity
  // drops an unpacked instance's unused overrides. Mutation for the drop cases (before #2001 S8b deleted the kept stores): make `dropUnpackedRootKeptState` return
  // before clearing — the scene save still writes `/DEAD` on INST.
  const DEAD = 'eeeeeeee-0000-4000-8000-00000000d814';
  const BEEF = 'eeeeeeee-0000-4000-8000-00000000b814';
  const orphan = { guid: BEEF, name: 'Gone', traits: { Transform: { x: 4 } } };
  const loadWithOrphan = async () => {
    install(pDoc());
    const sc = scene(P);
    (sc.entities as unknown as Array<Record<string, unknown>>)[1]!.members = { [`/${DEAD}`]: orphan };
    await load(sc);
  };
  const membersOf = (s: SceneData) => (entryOf(s, INST)!.members ?? {}) as Record<string, unknown>;
  const create = () => createPrefabFromEntity(rootOf(INST), 'prefabs/Unpacked.prefab.json', 'Unpacked', async () => true);
  const lastWritten = () => JSON.parse(writes.filter((w) => w.path.endsWith('Unpacked.prefab.json')).pop()!.content) as PrefabFile;

  it('neither the scene nor the new template keeps the row, and a reload keeps it gone', async () => {
    await loadWithOrphan();
    expect(membersOf(await save())[`/${DEAD}`]).toEqual(orphan); // precondition: the row is kept before the create
    const created = await create();
    expect(created && typeof created === 'object' && 'refused' in created).toBe(false);
    const doc = lastWritten();
    expect(JSON.stringify(doc)).not.toContain(DEAD);
    const saved = await save();
    expect(entryOf(saved, INST)!.prefab).toBe(doc.id); // precondition: INST is an instance of the new original
    expect(JSON.stringify(entryOf(saved, INST))).not.toContain(DEAD);
    install(doc);
    await load(saved);
    expect(JSON.stringify(entryOf(await save(), INST))).not.toContain(DEAD);
  });

  it('undo puts the row back on the instance, and redo drops it again', async () => {
    // Mutation: drop `undoUnpack()` from `tagCreatedPrefab`'s undo — after the undo INST saves as an instance of P with the
    // orphan row gone, for good.
    await loadWithOrphan();
    const before = entryOf(await save(), INST);
    clearHistory();
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/api/delete-asset')) return { ok: true, status: 200, json: async () => ({ ok: true, trashed: 1, missing: [], failed: [] }) };
      const last = writes.filter((w) => String(url).includes('Unpacked.prefab.json') && w.path.endsWith('Unpacked.prefab.json')).pop();
      return last ? new Response(last.content, { status: 200 }) : { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    });
    const created = await create();
    pushAction((created as { action: Parameters<typeof pushAction>[0] }).action);
    await undo();
    expect(entryOf(await save(), INST)).toEqual(before);
    await redo();
    expect(JSON.stringify(entryOf(await save(), INST))).not.toContain(DEAD);
  });

  it('KEPT: a Replace of the root\'s OWN prefab is no unpack — the instance stays connected, with its unused override', async () => {
    // Mutation: drop the `instanceSourceRef(before) === written` clause — the Replace strips the row.
    await loadWithOrphan();
    const replaced = { ...serializePrefab(rootOf(INST), P, { replacing: pDoc() })!, id: P };
    tagCreatedPrefab(rootOf(INST), 'prefabs/P.prefab.json', replaced);
    expect(entryOf(await save(), INST)!.prefab).toBe(P); // precondition: still an instance of P
    expect(membersOf(await save())[`/${DEAD}`]).toEqual(orphan);
  });

  it('KEPT: a tag that refused leaves the root linked to its old prefab, with its row', async () => {
    // Mutation: drop the `instanceSourceRef(now) !== written` clause — a refused tag strips the row of an unchanged instance.
    await loadWithOrphan();
    const mismatched = { id: 'cccccccc-0000-4000-8000-00000000f814', version: 8, name: 'X', rootLocalId: 1, entities: [] } as unknown as PrefabFile;
    tagCreatedPrefab(rootOf(INST), 'prefabs/X.prefab.json', mismatched);
    expect(entryOf(await save(), INST)!.prefab).toBe(P); // precondition: the tag refused
    expect(membersOf(await save())[`/${DEAD}`]).toEqual(orphan);
  });
});

describe('an Assets delete of a prefab a live instance uses (#1805, I9 — the explicit choice)', () => {
  // The delete now evicts the editor cache (`applyAssetPathMoves`' delete branch). The live instance is left EXPANDED —
  // #1738's evicted state — and every writer captures it from its frame record, so the save writes what it wrote before
  // the delete (no copy of P: scene v20, #2001 S6). Owner ruling B (#2001 S5, #2028): the reload shows the instance as
  // its Missing Prefab placeholder, keeping its edit as a record, and the next save writes the same bytes.
  // Mutation: drop `evictDeletedEditorPrefabs` from the delete branch — the editor cache still answers for the deleted
  // prefab.
  const P_PATH = '/assets/p1805.prefab.json';
  it('the editor cache forgets it, the live instance stays, and the save writes the entry byte for byte', async () => {
    registerAsset(P, P_PATH, 'prefab');
    install(pDoc());
    await load(scene(P));
    writeTraitFieldWithUndo(inside(INST, 'A'), meta('Transform'), 'x', 6);
    const before = entryOf(await save(), INST);
    prefabs.delete(P); // gone from disk
    applyAssetPathMoves([{ from: P_PATH, to: null }]);
    expect(getCachedPrefabSync(P)).toBeNull();
    expect(x(inside(INST, 'A'))).toBe(6); // still expanded
    const saved = await save();
    expectSameBytes(entryOf(saved, INST), before);
    expect(saved.embeddedPrefabs).toBeUndefined(); // scene v20 writes no copy of P (#2001 S6)
    // The editor saves under the id its load read (`ownLoadedEntry`), so the copies the load kept pair with the save's. This
    // harness keeps no loaded entry and saves under '' — reloaded under a non-guid id, the load keys them '' too. Before S5
    // the reload expanded the copy, and the live frame carried it whatever the key.
    await load({ ...saved, id: 's1699' });
    expect(getAllEntities().some((e) => e.name === 'A'), 'the reload: a placeholder, not expanded (ruling B)').toBe(false);
    const body = (sc: SceneData) => JSON.stringify([sc.entities, sc.embeddedPrefabs]); // this harness mints the scene id per save
    expect(body(await save())).toBe(body(saved)); // I23
    install(pDoc());
    await load(saved);
    expect(x(inside(INST, 'A'))).toBe(6); // and the edit stays with the returned prefab
    expect((await save()).embeddedPrefabs).toBeUndefined(); // which wins: the copy goes
  });
});

// #1914 close-out review: F7 implies a scene instance root's order record from its ROLE; a copy carried that view as a
// STORED mark, so an unedited instance of Q pasted into P's prefab edit wrote `sortOrder: 0` as a nested row's override
// — a record nobody made, in a world F7 says records nothing. Two sources: a fresh instance (the order only implied), and
// one reopened from a save, whose file states the order its root records (the load marks what the file states).
// Mutations (before #2001 S8b): capture the view in `snapshotEntity` — both red; carry the stored set whole — the reopened
// one red. Since S8b a snapshot carries no override set at all, so the case pins the outcome.
describe("a scene instance copied into prefab edit carries no implied root order (#1914 close-out review)", () => {
  for (const reopened of [false, true]) {
    it(`an unedited instance${reopened ? ', reopened from its save,' : ''} pasted into P's edit writes no override`, async () => {
      install(pDoc(), qDoc());
      await load(scene(P, [{ id: 3, prefab: Q, guid: QINST, traits: { EntityAttributes: { name: 'QInst', parentId: 0 } } }]));
      if (reopened) await load(await save());
      const clip = clipEntity(rootOf(QINST), 'copy')!;
      await load(buildPrefabEditScene(pDoc() as unknown as PrefabFile) as SceneData);
      // Under A, which has no children, so the paste's place is the template root's own (0) and records nothing.
      const a = getAllEntities().find((e) => e.name === 'A')!;
      const editWorld = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: `/__prefab-edit__/${P}` } as never);
      try {
        expect(pasteEntityCopy(clip, a.id, () => {})).toBeGreaterThan(0);
        const out = serializePrefabEditWorld(P);
        if ('error' in out) throw new Error(out.error);
        const nested = out.prefab.entities.find((e) => e.prefab === Q)!;
        expect(nested).toBeDefined();
        expect((nested as { overrides?: unknown }).overrides).toBeUndefined();
      } finally {
        editWorld.mockRestore();
      }
    });
  }
});
