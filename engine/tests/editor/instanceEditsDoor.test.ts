/** The S4 door's census (#2001, #2014; design § 10.1, review § Census): every writer to a prefab-supplied entity writes
 *  the instance record through `instanceEdits`, beside the old marks. Each case drives the REAL writer (the one the
 *  Inspector, the Hierarchy and the agent call) on an instance whose record the LOAD parsed, and asserts what the record
 *  now says. Each names the mutation that turns it red: the writer's door call, removed.
 *
 *  Rules cited per case: docs/prefabs.md § High-level rules. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { peekUndo } from '../../packages/modoki/src/editor/undo/undoManager';
import {
  setActionCallback, pushAction, clearHistory, undo, redo, writeTraitFieldWithUndo, reparentEntity, duplicateEntity,
  addTraitToEntitiesWithUndo, removeTraitFromEntitiesWithUndo, createEntityWithUndo, deleteEntitiesWithUndo,
} from '@modoki/engine/editor';
import { clipEntity, pasteEntityCopy } from '../../packages/modoki/src/editor/undo/entityActions';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { instantiatePrefabInstance } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { writeTraitField } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { preV5NodeGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { fillInstanceStore } from '../../packages/modoki/src/runtime/prefab/instanceLoad';
import { storedRecord, storedInstance, storedInstances } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { instanceDrift } from '../../packages/modoki/src/editor/instance/instanceDrift';
import { capturedRecordsOf } from '../../packages/modoki/src/editor/instance/instanceSync';
import { captureEntrySide, rebuildEntrySide } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { inFieldGesture } from '../../packages/modoki/src/editor/undo/fieldGesture';
import { setTemplateKey } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { allStoredRoots, instanceKeyMap } from '../../packages/modoki/src/editor/instance/instanceKeys';
import { dropInstanceRecord, liveStoredRootGuids, setInstanceRecord } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000002014';
const ROOT1 = 'dddddddd-0000-4000-8000-000000002014';
const OTHER = 'dddddddd-0000-4000-8000-000000002015';
const g = (n: number) => `eeeeeeee-0000-4000-8000-00000000201${n}`;
const key = (n: number) => `/${g(n)}`;

/** P: R → A, B (B → C). A authors Rotate3D. */
const pDoc = () => {
  const row = (localId: number, name: string, parentId: number, sortOrder: number, traits: Record<string, unknown> = {}) => ({
    localId, name, nodeGuid: g(localId),
    traits: { EntityAttributes: { name, parentId, guid: '', sortOrder }, Transform: { x: 0, y: 0, z: 0 }, ...traits },
  });
  return {
    id: P, version: 5, name: 'P', rootLocalId: 1,
    entities: [row(1, 'R', 0, 0), row(2, 'A', 1, 0, { Rotate3D: { axis: 'x', speed: 3 } }), row(3, 'B', 1, 10), row(4, 'C', 3, 0)],
  };
};

/** One top-level instance of P beside a plain entity "Other" at x = 5. */
const scene = (): SceneData => ({
  id: 's2014', version: 14, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Other', parentId: 0, guid: OTHER, sortOrder: 3 }, Transform: { x: 5, y: 0, z: 0 } } },
    { id: 2, prefab: P, guid: ROOT1, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } } },
  ],
} as unknown as SceneData);

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
      const id = instantiatePrefabIntoWorld(getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
      if (id && rootGuid) {
        for (const e of getCurrentWorld().entities) {
          if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), guid: rootGuid });
        }
      }
      return id ?? undefined;
    },
  });
  // The store fill SceneManager runs after each file (`fillInstanceStoreReporting`): the record the LOAD parsed.
  fillInstanceStore(getCurrentWorld(), JSON.parse(JSON.stringify(data)) as SceneData);
}

const meta = (t: string) => getTraitByName(t)!;
const rootId = () => getAllEntities().find((e) => e.guid === ROOT1)!.id;
const byName = (name: string) => { const hits = getAllEntities().filter((e) => e.name === name); if (hits.length !== 1) throw new Error(`fixture: ${hits.length} named ${name}`); return hits[0]!.id; };
const guidOf = (id: number) => getAllEntities().find((e) => e.id === id)!.guid;
const rec = () => { const r = storedRecord(getCurrentWorld(), ROOT1); if (!r) throw new Error('no fresh record'); return r; };
const row = (k: string) => rec().list.rows.get(k);
const ownOf = (k: string) => (row(k)?.own ?? []).map((o) => o.guid);

/** The record equals what the old capture states (I25 for one case), modulo identity pins. */
const strip = (r: { list: { rows: Map<string, Record<string, unknown>> } }) => [...r.list.rows]
  .map(([k, { guid: _g, name: _n, ...rest }]) => [k, rest] as const).filter(([, v]) => Object.keys(v).length)
  .sort(([a], [b]) => (a < b ? -1 : 1));
const matchesCapture = () => {
  const cap = capturedRecordsOf(rootId())!.find((r) => r.rootGuid === ROOT1)!;
  expect(strip(rec() as never)).toEqual(strip(cap as never));
};

beforeEach(async () => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  const d = pDoc();
  prefabs.set(d.id, d); setPrefabCache(d.id, d as never);
  await load(scene());
});
afterAll(() => { setPrefabCache(P, null); getCurrentWorld()?.destroy(); });

describe('the load parses every instance into the store (S4 build 1)', () => {
  it('a loaded instance has a fresh record with an empty list and its placement', () => {
    expect(rec().source).toBe(P);
    expect(rec().list.rows.size).toBe(0);
    expect(rec().placement).toMatchObject({ parent: '', sortOrder: 0 });
  });
});

// A plain entity a file parents INTO an instance by its parentId (a file-direct agent write): no owner's parse sees the
// link, so the LOADER builds it on the record, at the key of the node the file names (hub ruling 2026-10-02, design § 10.7;
// #2028, hunt seed 1061). Before S5 the load marked the records stale and the door re-seeded them from the capture.
// Mutation: make `buildParentLinks` mark the records stale instead (its pre-S5 body) — no fresh record, red.
describe('a file that parents a plain entity into an instance', () => {
  const KID = 'ffffffff-0000-4000-8000-000000002099';
  const withKid = (parentId: string): SceneData => {
    const d = scene() as unknown as { entities: unknown[] };
    d.entities.push({ id: 3, traits: { EntityAttributes: { name: 'Kid', parentId, guid: KID, sortOrder: 0 }, Transform: { x: 0, y: 0, z: 0 } } });
    return d as unknown as SceneData;
  };
  it('links it on the root\'s row: the record stays fresh and states what the capture does', async () => {
    await load(withKid(ROOT1));
    expect(ownOf('/')).toEqual([KID]);
    matchesCapture();
  });
  it('links it on a member\'s row, keyed through the live instance', async () => {
    const b = guidOf(byName('B'))!;
    await load(withKid(b));
    expect(ownOf(key(3))).toEqual([KID]);
    matchesCapture();
  });
  it('one parented to a plain entity links nothing', async () => {
    await load(withKid(OTHER));
    expect([...rec().list.rows.values()].some((r) => (r.own ?? []).some((o) => o.guid === KID))).toBe(false);
  });
});

// `Placement.sourceScene` holds ONLY what the file stated (design § 10.4b, #2008): the load-time stamp that marks a BASE
// scene's entities (SceneManager's post-pass) never reaches a record, or the writer would persist base-scene provenance
// into the scene that saves the root. The live stamp is the rebuild's to keep (`rebuildFromEntry` re-stamps).
describe('a base scene\'s sourceScene stamp (#2028, § 10.4b)', () => {
  const BASE = 'abababab-0000-4000-8000-000000002028';
  const stamp = () => {
    for (const e of getAllEntities()) if (e.guid !== OTHER) writeTraitField(e.id, meta('EntityAttributes'), 'sourceScene', BASE);
  };
  const stampOf = (id: number) => (findEntity(id)!.get(meta('EntityAttributes').trait) as { sourceScene?: string }).sourceScene;
  it('the parsed record and a rebuild leave it out of the record; the rebuild keeps it live', () => {
    stamp();
    fillInstanceStore(getCurrentWorld(), JSON.parse(JSON.stringify(scene())) as SceneData);
    expect(rec().placement.sourceScene).toBeUndefined();
    const side = captureEntrySide(rootId())!;
    expect(rebuildEntrySide(side)).toBeGreaterThan(0);
    expect(stampOf(rootId())).toBe(BASE);
    expect(stampOf(byName('C'))).toBe(BASE);
    expect(rec().placement.sourceScene).toBeUndefined();
  });
});

describe('field writes: setFields through the recorder (rules 3 and 10)', () => {
  // Mutation: drop `instanceEdits.setFields` in `recordOverridesByDiff` — no row.
  it('a field the gesture made differ is recorded at its value', () => {
    writeTraitFieldWithUndo(byName('A'), meta('Transform'), 'x', 7);
    expect(row(key(2))?.traits?.Transform).toEqual({ x: 7 });
    matchesCapture();
  });
  // F2: typing the base's own value into an unrecorded field records nothing. Mutation: `off` always true.
  it('typing the base value records nothing (F2)', () => {
    writeTraitFieldWithUndo(byName('A'), meta('Transform'), 'x', 0);
    expect(row(key(2))).toBeUndefined();
  });
  // F3 / rule 3: a record is never dropped because its value came back to the base (#1914).
  it('a record stays when its value returns to the base (F3)', () => {
    writeTraitFieldWithUndo(byName('A'), meta('Transform'), 'x', 7);
    writeTraitFieldWithUndo(byName('A'), meta('Transform'), 'x', 0);
    expect(row(key(2))?.traits?.Transform).toEqual({ x: 0 });
  });
  // A field GESTURE (an Inspector edit session) records what its FINAL value differs in (#1914, the hub's #1922): a
  // number field commits per keystroke, so retyping the base's 0 as "1", "10", "0" writes 1 and 10 first. Mutation:
  // drop `instanceEdits.putFieldRecord` in `resumeGesture` — F3 keeps the first keystroke's record.
  it('a field gesture that ends on the base records nothing; one that ends off it records its final value', () => {
    inFieldGesture('g1', () => { for (const v of [1, 10, 0]) writeTraitFieldWithUndo(byName('A'), meta('Transform'), 'x', v); });
    expect(row(key(2))).toBeUndefined();
    matchesCapture();
    inFieldGesture('g2', () => { for (const v of [1, 10, 5]) writeTraitFieldWithUndo(byName('A'), meta('Transform'), 'x', v); });
    expect(row(key(2))?.traits?.Transform).toEqual({ x: 5 });
    matchesCapture();
  });
  // Rotation is one record (#1880 F5). Mutation: take only the axis written.
  it('one rotation axis records the whole orientation', () => {
    writeTraitFieldWithUndo(byName('A'), meta('Transform'), 'ry', 0.5);
    expect(Object.keys(row(key(2))?.traits?.Transform as object).sort()).toEqual(['rx', 'ry', 'rz']);
    matchesCapture();
  });
  // The root's name is a default override, held by the placement (§ 10.4: one home).
  it('a root rename goes to the placement, never a "/" row', () => {
    writeTraitFieldWithUndo(rootId(), meta('EntityAttributes'), 'name', 'Renamed');
    expect(rec().placement.name).toBe('Renamed');
    expect(row('/')).toBeUndefined();
  });
});

describe('components (§ 2.5)', () => {
  // Mutation: drop `instanceEdits.addComponent` in `addTraitToEntitiesWithUndo`.
  it('a component the base lacks is recorded whole, by value', () => {
    addTraitToEntitiesWithUndo([byName('B')], meta('Rotate3D'), { axis: 'z', speed: 2 });
    expect(row(key(3))?.traits?.Rotate3D).toMatchObject({ axis: 'z', speed: 2 });
    matchesCapture();
  });
  // A tag has no fields for the recorder to diff, so only the door's `addComponent` records it. Mutation: drop it.
  it('an added tag is recorded', () => {
    addTraitToEntitiesWithUndo([byName('B')], meta('Paused'));
    expect(row(key(3))?.traits?.Paused).toEqual({});
    matchesCapture();
  });
  // Re-adding a component this list removed clears the removal, as today's save states it (RULE GAP raised with the hub:
  // Unity keeps a removed-component override beside an added one). Mutation: drop the door's `addComponent`.
  it('re-adding a removed component clears its removal', () => {
    removeTraitFromEntitiesWithUndo([byName('A')], meta('Rotate3D'));
    addTraitToEntitiesWithUndo([byName('A')], meta('Rotate3D'), { axis: 'x', speed: 3 });
    expect(row(key(2))?.traitRemovals).toBeUndefined();
    matchesCapture();
  });
  // Mutation: drop the `beginRemoveComponent` commit in `removeTraitFromEntitiesWithUndo`.
  it('removing a component the base has records the removal', () => {
    removeTraitFromEntitiesWithUndo([byName('A')], meta('Rotate3D'));
    expect(row(key(2))?.traitRemovals).toEqual({ Rotate3D: true });
    matchesCapture();
  });
  // Hub ruling G2: the field records on a removed base component stay, inert. Mutation: delete `traits[T]` on removal.
  it('removing a base component KEEPS its field records beside the removal (G2)', () => {
    writeTraitFieldWithUndo(byName('A'), meta('Rotate3D'), 'speed', 9);
    removeTraitFromEntitiesWithUndo([byName('A')], meta('Rotate3D'));
    expect(row(key(2))).toMatchObject({ traitRemovals: { Rotate3D: true }, traits: { Rotate3D: { speed: 9 } } });
  });
  // G3 wording: the gesture deletes the very thing the record IS.
  it('removing a component this list added takes its record away (§ 2.5, rule 3 G3)', () => {
    addTraitToEntitiesWithUndo([byName('B')], meta('Rotate3D'), { axis: 'z', speed: 2 });
    removeTraitFromEntitiesWithUndo([byName('B')], meta('Rotate3D'));
    expect(row(key(3))).toBeUndefined();
    matchesCapture();
  });
});

describe('children (§ 2.5)', () => {
  // Mutation: drop `instanceEdits.addChild` in `createEntityWithUndo`.
  it('a node created under a member is linked in that member\'s own', () => {
    const id = createEntityWithUndo('Create', byName('A'), [{ name: 'EntityAttributes', data: { name: 'Kid', parentId: byName('A') } }, { name: 'Transform' }], () => {})!;
    expect(ownOf(key(2))).toEqual([guidOf(id)]);
    matchesCapture();
  });
  it('a node created under a scene-owned node is content, not a link', () => {
    const kid = createEntityWithUndo('Create', byName('A'), [{ name: 'EntityAttributes', data: { name: 'Kid', parentId: byName('A') } }, { name: 'Transform' }], () => {})!;
    createEntityWithUndo('Create', kid, [{ name: 'EntityAttributes', data: { name: 'Grand', parentId: kid } }, { name: 'Transform' }], () => {});
    expect(ownOf(key(2))).toEqual([guidOf(kid)]);
  });
  // Mutation: drop `addChild` in `seatCopy` (the record path, #2046 S7.4) — and in `afterCopy`, the stale path.
  it('a duplicate of a scene-owned node is linked beside it', () => {
    const kid = createEntityWithUndo('Create', byName('A'), [{ name: 'EntityAttributes', data: { name: 'Kid', parentId: byName('A') } }, { name: 'Transform' }], () => {})!;
    const copy = duplicateEntity(kid, () => {})!;
    expect(ownOf(key(2)).sort()).toEqual([guidOf(kid), guidOf(copy)].sort());
    matchesCapture();
  });
  it('a paste under a member is linked in its own', () => {
    const kid = createEntityWithUndo('Create', byName('A'), [{ name: 'EntityAttributes', data: { name: 'Kid', parentId: byName('A') } }, { name: 'Transform' }], () => {})!;
    const pasted = pasteEntityCopy(clipEntity(kid, 'copy')!, byName('B'), () => {})!;
    expect(ownOf(key(3))).toEqual([guidOf(pasted)]);
    matchesCapture();
  });
});

describe('a prefab placed (§ 3.2, the placement row; review § Census: a drop on a member)', () => {
  const Q = 'cccccccc-0000-4000-8000-000000002016';
  const qDoc = () => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [
    { localId: 1, name: 'QR', nodeGuid: 'eeeeeeee-0000-4000-8000-000000002020', traits: { EntityAttributes: { name: 'QR', parentId: 0, guid: '', sortOrder: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
  ] });
  // Mutation: drop `instanceEdits.place` in `instantiatePrefabInstance` — no record, no link.
  it('a drop on a member mints the new instance\'s record (an empty list) and links it in the member\'s own', async () => {
    const q = qDoc(); prefabs.set(Q, q); setPrefabCache(Q, q as never);
    const id = await instantiatePrefabInstance(q as never, 'q.prefab.json', byName('A'));
    const placed = storedRecord(getCurrentWorld(), guidOf(id)!);
    expect(placed?.source).toBe(Q);
    expect(placed?.list.rows.size).toBe(0);
    expect(placed?.placement.parent).toBe(''); // a reference node: its link places it (`parseReferenceNode`)
    expect(ownOf(key(2))).toEqual([guidOf(id)]);
    matchesCapture();
  });
  // Mutation: let `instanceKeyMap`'s climb pass an unkeyed instance entity — Q's own node keys into P's record.
  it('a template-added node of the placed instance keys into ITS record, never the instance it hangs under (#2009, #2026)', async () => {
    const q = qDoc(); prefabs.set(Q, q); setPrefabCache(Q, q as never);
    const id = await instantiatePrefabInstance(q as never, 'q.prefab.json', byName('A'));
    const kid = createEntityWithUndo('Create', id, [{ name: 'EntityAttributes', data: { name: 'QKid', parentId: id } }, { name: 'Transform' }], () => {})!;
    setTemplateKey([...getCurrentWorld().entities].find((e) => e.id() === kid) as never, 'k-x');
    expect(instanceKeyMap(rootId()).has(kid)).toBe(false);
    expect(instanceKeyMap(id).get(kid)).toBe('/a+k-x');
  });
  // #2037 (hunt seed 1094) staged a copy that could not go on records stale (`afterCopy`), with every record enclosing it.
  // Since #2001 S8b such a copy is REFUSED, before anything spawns: here a copy of QM3, a member of the Q3 node, whose
  // record holds data the copy cannot restate (`copyRecordsOf` null for a member copy with held data).
  // Mutations: drop the `!records` refusal in `duplicateEntity` / in `pasteEntityCopy` — each throws past the refusal.
  it('a copy whose records cannot be restated for it is refused before anything spawns, and every record stays as it was', async () => {
    const Q3 = 'cccccccc-0000-4000-8000-000000002018';
    const q3 = { id: Q3, version: 5, name: 'Q3', rootLocalId: 1, entities: [
      { localId: 1, name: 'QR3', nodeGuid: 'eeeeeeee-0000-4000-8000-000000002023', traits: { EntityAttributes: { name: 'QR3', parentId: 0, guid: '', sortOrder: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      { localId: 2, name: 'QM3', nodeGuid: 'eeeeeeee-0000-4000-8000-000000002024', traits: { EntityAttributes: { name: 'QM3', parentId: 1, guid: '', sortOrder: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    ] };
    const q = qDoc();
    prefabs.set(Q3, q3); setPrefabCache(Q3, q3 as never); prefabs.set(Q, q); setPrefabCache(Q, q as never);
    const node = await instantiatePrefabInstance(q3 as never, 'q3.prefab.json', byName('A'));
    await instantiatePrefabInstance(q as never, 'q.prefab.json', 0);
    await instantiatePrefabInstance(q as never, 'q.prefab.json', byName('QM3'));
    const world = getCurrentWorld();
    storedInstance(world, guidOf(node)!)!.record.held = { pendingLegacy: { overrides: { 9: { Unknown: { a: 1 } } } } } as never;
    const store = () => JSON.stringify([...storedInstances(world)], (_k, v: unknown) => v instanceof Map ? [...v] : v);
    const before = { store: store(), count: getAllEntities().length };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(duplicateEntity(byName('QM3'), () => {})).toBeNull();
      expect(pasteEntityCopy(clipEntity(byName('QM3'), 'copy')!, 0, () => {})).toBeNull();
      expect(errors.mock.calls.filter((c) => String(c[0]).includes('was not copied'))).toHaveLength(2);
    } finally { errors.mockRestore(); }
    expect(getAllEntities().length).toBe(before.count);
    expect(store()).toBe(before.store);
  });
  // The same copy on records (#2001 S8b): its held instance gets a record of its own, and every record stays fresh.
  // Mutation: return null from `copyRecordsOf` — the copy is refused, and no copied instance is seated.
  it('the same copy, its records restatable, keeps every record fresh and seats the copied instance\'s', async () => {
    const Q3 = 'cccccccc-0000-4000-8000-000000002018';
    const q3 = { id: Q3, version: 5, name: 'Q3', rootLocalId: 1, entities: [
      { localId: 1, name: 'QR3', nodeGuid: 'eeeeeeee-0000-4000-8000-000000002023', traits: { EntityAttributes: { name: 'QR3', parentId: 0, guid: '', sortOrder: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      { localId: 2, name: 'QM3', nodeGuid: 'eeeeeeee-0000-4000-8000-000000002024', traits: { EntityAttributes: { name: 'QM3', parentId: 1, guid: '', sortOrder: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    ] };
    const q = qDoc();
    prefabs.set(Q3, q3); setPrefabCache(Q3, q3 as never); prefabs.set(Q, q); setPrefabCache(Q, q as never);
    await instantiatePrefabInstance(q3 as never, 'q3.prefab.json', byName('A'));
    const held = await instantiatePrefabInstance(q as never, 'q.prefab.json', byName('QM3'));
    const world = getCurrentWorld();
    const copy = duplicateEntity(byName('QM3'), () => {})!;
    const copiedHeld = getAllEntities().find((e) => e.parentId === copy && e.guid !== guidOf(held))!;
    expect(storedInstance(world, copiedHeld.guid!)?.record.source).toBe(Q);
  });
  const handle = (id: number) => [...getCurrentWorld().entities].find((e) => e.id() === id)!;
  // Mutation: run `instanceKeyMap`'s template pass once (no fixpoint) — X is reached before T keys its member M.
  it('a template-added node under a MOVED member of a template-added reference node keys in that node\'s frame (fixpoint)', async () => {
    const Q2 = 'cccccccc-0000-4000-8000-000000002017';
    const q2 = { id: Q2, version: 5, name: 'Q2', rootLocalId: 1, entities: [
      { localId: 1, name: 'T', nodeGuid: 'eeeeeeee-0000-4000-8000-000000002021', traits: { EntityAttributes: { name: 'T', parentId: 0, guid: '', sortOrder: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      { localId: 2, name: 'QM', nodeGuid: 'eeeeeeee-0000-4000-8000-000000002022', traits: { EntityAttributes: { name: 'QM', parentId: 1, guid: '', sortOrder: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    ] };
    prefabs.set(Q2, q2); setPrefabCache(Q2, q2 as never);
    const t = await instantiatePrefabInstance(q2 as never, 'q2.prefab.json', byName('C'));
    setTemplateKey(handle(t) as never, 'k-t');
    const m = byName('QM');
    const ea = meta('EntityAttributes').trait;
    handle(m).set(ea, { ...(handle(m).get(ea) as object), parentId: rootId() });
    const x = createEntityWithUndo('Create', m, [{ name: 'EntityAttributes', data: { name: 'X', parentId: m } }, { name: 'Transform' }], () => {})!;
    setTemplateKey(handle(x) as never, 'k-x');
    const keys = instanceKeyMap(rootId());
    expect(keys.get(m)).toBe('/a+k-t/eeeeeeee-0000-4000-8000-000000002022');
    expect(keys.get(x)).toBe('/a+k-t/a+k-x');
  });
  // A pre-v5 row's member is keyed by the identity the parse gives it (`preV5NodeGuid`, #2001 S8b), and a template-added
  // node under it keys in its frame. Mutation: `instanceKeyMap` without `derivePreV5` — B is unkeyed (and X still keys,
  // through the climb that takes a pre-v5 frame's unkeyed member as this instance's own).
  it('a pre-v5 row\'s member keys by its derived identity, and a template-added node under it keys here', async () => {
    const d = pDoc();
    d.entities = d.entities.map((r) => (r.name === 'B' ? { ...r, nodeGuid: '' } : r));
    prefabs.set(d.id, d); setPrefabCache(d.id, d as never);
    await load(scene());
    const b = byName('B');
    const x = createEntityWithUndo('Create', b, [{ name: 'EntityAttributes', data: { name: 'X', parentId: b } }, { name: 'Transform' }], () => {})!;
    setTemplateKey(handle(x) as never, 'k-x');
    const keys = instanceKeyMap(rootId());
    expect(keys.get(b)).toBe(`/${preV5NodeGuid(d.id, 3)}`);
    expect(keys.get(x)).toBe('/a+k-x');
  });
});

describe('delete (rule 3, § 10.4)', () => {
  // Mutation: drop the `beginDelete` commit in `deleteEntitiesWithUndo`.
  it('deleting a member writes removed and KEEPS the records on and under it', () => {
    writeTraitFieldWithUndo(byName('B'), meta('Transform'), 'x', 4);
    writeTraitFieldWithUndo(byName('C'), meta('Transform'), 'y', 2);
    deleteEntitiesWithUndo([byName('B')]);
    expect(row(key(3))).toMatchObject({ removed: true, traits: { Transform: { x: 4 } } });
    expect(row(`${key(3)}`)?.removed).toBe(true);
    expect(row(key(4))?.traits?.Transform).toEqual({ y: 2 });
  });
  // Keys are flat within a frame, so "under the deleted member" is the live tree's, not a key prefix (review). Mutation:
  // `keyedSubtree` → the key-prefix test — C's row keeps a link to the deleted Kid.
  it('a user child of a member UNDER the deleted member loses its link too', () => {
    createEntityWithUndo('Create', byName('C'), [{ name: 'EntityAttributes', data: { name: 'Kid', parentId: byName('C') } }, { name: 'Transform' }], () => {});
    expect(row(key(4))?.own?.length).toBe(1);
    deleteEntitiesWithUndo([byName('B')]);
    expect(row(key(4))?.own).toBeUndefined();
  });
  it('the user\'s children under a deleted member go with it, links included (rule 3, hub refinement)', () => {
    const kid = createEntityWithUndo('Create', byName('B'), [{ name: 'EntityAttributes', data: { name: 'Kid', parentId: byName('B') } }, { name: 'Transform' }], () => {})!;
    deleteEntitiesWithUndo([byName('B')]);
    void kid;
    expect(row(key(3))?.own).toBeUndefined();
    expect(row(key(3))?.removed).toBe(true);
  });
  // …and undo restores them (rule 3). At S4 undo is not a door yet: it marks the record stale, and the next door write
  // re-seeds it from the live tree, where the undo put the child back.
  it('undoing the delete brings the member and its user-added child back', async () => {
    const kid = createEntityWithUndo('Create', byName('B'), [{ name: 'EntityAttributes', data: { name: 'Kid', parentId: byName('B') } }, { name: 'Transform' }], () => {})!;
    const kidGuid = guidOf(kid);
    deleteEntitiesWithUndo([byName('B')]);
    await undo();
    writeTraitFieldWithUndo(byName('A'), meta('Transform'), 'x', 1); // a door write: re-seeds the stale record
    expect(row(key(3))?.removed).toBeUndefined();
    expect(ownOf(key(3))).toEqual([kidGuid]);
  });
  it('deleting a scene-owned node takes its link away (§ 2.5)', () => {
    const kid = createEntityWithUndo('Create', byName('A'), [{ name: 'EntityAttributes', data: { name: 'Kid', parentId: byName('A') } }, { name: 'Transform' }], () => {})!;
    deleteEntitiesWithUndo([kid]);
    expect(row(key(2))).toBeUndefined();
    matchesCapture();
  });
  it('deleting the instance root drops its record', () => {
    deleteEntitiesWithUndo([rootId()]);
    expect(storedInstance(getCurrentWorld(), ROOT1)).toBeUndefined();
  });
});

describe('reparent (review R4: the keep-world pose)', () => {
  // Mutation: drop the `beginReparent` commit in `reparentEntity`.
  it('an instance root moved under a moved parent records its keep-world pose on "/" and its new placement', () => {
    expect(reparentEntity(rootId(), byName('Other'))).toBe(true);
    expect(rec().placement.parent).toBe(OTHER);
    expect(row('/')?.traits?.Transform).toMatchObject({ x: -5 });
    matchesCapture();
  });
  it('a scene-owned node moved between members moves its link', () => {
    const kid = createEntityWithUndo('Create', byName('A'), [{ name: 'EntityAttributes', data: { name: 'Kid', parentId: byName('A') } }, { name: 'Transform' }], () => {})!;
    expect(reparentEntity(kid, byName('B'))).toBe(true);
    expect(ownOf(key(2))).toEqual([]);
    expect(ownOf(key(3))).toEqual([guidOf(kid)]);
    matchesCapture();
  });
});

// Hub, 2026-10-02: a template-added REFERENCE node's root is a supplied node of its frame and owns no record. The editor's
// keys and the store's list of live stored roots both say so. Mutation: drop `!templateKeyOf` in `ownsRecord`
// (instanceKeys.ts) or in `liveStoredRootGuids` (instanceStore.ts).
describe('who owns a record', () => {
  it('a stored root carrying a template key owns no record: not a record-owning root', () => {
    const root = rootId();
    expect(allStoredRoots()).toContain(root);
    setTemplateKey(findEntity(root) as never, 'k-ref');
    expect(allStoredRoots()).not.toContain(root);
  });
  it('…and the store does not list a template-keyed root among the live roots a record is kept for', async () => {
    expect(liveStoredRootGuids(getCurrentWorld()), 'premise').toContain(ROOT1);
    setTemplateKey(findEntity(rootId()) as never, 'k-ref');
    dropInstanceRecord(getCurrentWorld(), ROOT1);
    expect(liveStoredRootGuids(getCurrentWorld())).not.toContain(ROOT1);
  });
});

// A throw inside the door (a parser or fold defect) must not fail the gesture. Mutation: export `rowsOfImpl` unshielded —
// the write throws out of `writeTraitFieldWithUndo` (since #2046 S7.2 the first door call a field write makes is `rowsOf`).
// #2001 S8b (hub decision A): the door is no longer a shadow. A throw inside it fails the gesture, rolled back
// (`instanceRollback.ts`): it propagates, the gesture pushes no undo entry, and no record is left stale for a re-seed.
// Mutation: catch and swallow the throw in `shielded` again — the write does not throw (red).
describe('the shield: a door that throws fails the gesture', () => {
  it('a door that throws rolls back and propagates: no undo entry', async () => {
    setInstanceRecord(getCurrentWorld(), { ...rec(), list: null as never });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const top = peekUndo()?.label;
    try {
      expect(() => writeTraitFieldWithUndo(byName('A'), meta('Transform'), 'x', 7)).toThrow();
      expect(errors.mock.calls.some((c) => /^\[instanceRollback\] the instance door's \w+ threw part-way/.test(String(c[0])))).toBe(true);
      expect(peekUndo()?.label, 'no undo entry').toBe(top);
    } finally { errors.mockRestore(); }
  });
});

// #2046 S7.2 (rule 8): a field step's undo and redo put back the EXACT rows it found and left, and the records stay fresh.
describe('undo of a field edit restores the exact list', () => {
  it('the undo leaves the record fresh with the row it found, the redo with the row it left', async () => {
    writeTraitFieldWithUndo(byName('A'), meta('Transform'), 'x', 7);
    const left = structuredClone(row(key(2)));
    await undo();
    expect(row(key(2))).toBeUndefined();
    await redo();
    expect(row(key(2))).toEqual(left);
  });
  // Mutation: `putRows` without its fold patch — the undo shows the value the field had before the edit (0), not the
  // template's value now (#1800: Unity shows the current asset's value for a field the instance does not override).
  it('a field the restored row does not record shows the fold\'s value now, not the value it had before', async () => {
    writeTraitFieldWithUndo(byName('A'), meta('Transform'), 'x', 7);
    // The template's x moves to 3 behind the step (as an Apply on another instance would).
    const doc = pDoc();
    (doc.entities.find((e) => e.localId === 2)!.traits.Transform as { x: number }).x = 3;
    prefabs.set(P, doc); setPrefabCache(P, doc as never);
    await undo();
    expect(row(key(2))).toBeUndefined();
    expect((readTraitData(byName('A'), meta('Transform')) as { x: number }).x).toBe(3);
  });
});

describe('the save-time drift check (§ 10.2, review R3(b))', () => {
  it('a write through the door leaves no drift', () => {
    writeTraitFieldWithUndo(byName('A'), meta('Transform'), 'x', 7);
    expect(instanceDrift(rootId())).toEqual([]);
  });
  // Mutation: return [] from `instanceDrift` — the bypass goes unreported.
  it('a write that bypasses the door is reported with its entity and field', () => {
    writeTraitField(byName('A'), meta('Transform'), 'x', 9); // a raw write: no door, no mark
    const lines = instanceDrift(rootId());
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('A');
    expect(lines[0]).toContain('Transform.x');
  });
});

void readTraitData;

// #2046 S7.4 (D-8c; § 3.2's duplicate/paste row): a copy of a whole instance carries the source's records — its list,
// verbatim, under the copy's guid, placed where the copy is — and its redo (or a paste of a clipboard that outlived a
// template change) rebuilds the copy from them onto the template's CURRENT document. Before, the copy's records were
// marked stale and re-seeded from a capture, and a respawn was rebased from it.
describe('a duplicate or paste of an instance carries its records (#2046 S7.4)', () => {
  const kids = (id: number) => getAllEntities().filter((e) => e.parentId === id);
  /** Member `name` under instance root `root` (the copy and the source both hold one). */
  const memberOf = (root: number, name: string): number => {
    const walk = (id: number): number | undefined => {
      for (const k of kids(id)) { if (k.name === name) return k.id; const d = walk(k.id); if (d) return d; }
      return undefined;
    };
    return walk(root)!;
  };
  const tfOf = (id: number) => readTraitData(id, meta('Transform')) as { x: number; y: number };
  const recOf = (guid: string) => storedRecord(getCurrentWorld(), guid);
  /** The template's B, retuned: a change the undo stack does not hold (a saved prefab edit, an outside edit). */
  const retuneB = (y: number) => {
    const d = pDoc();
    (d.entities[2]!.traits.Transform as { y: number }).y = y;
    prefabs.set(d.id, d); setPrefabCache(d.id, d as never);
  };
  const editSource = () => {
    writeTraitFieldWithUndo(byName('B'), meta('Transform'), 'x', 4);
    removeTraitFromEntitiesWithUndo([byName('A')], meta('Rotate3D'));
    expect(row(key(2))?.traitRemovals, 'premise: the source records a removal').toBeTruthy();
  };

  // Mutation: `copyRecordsOf` returning null (the stale path) — the copy has no fresh record.
  it('the copy holds the source\'s list, fresh, under its own guid and placement; undo drops it, redo seats it again', async () => {
    editSource();
    const copy = duplicateEntity(rootId(), () => {})!;
    const cg = guidOf(copy)!;
    expect(strip(recOf(cg)! as never)).toEqual(strip(rec() as never));
    expect(recOf(cg)!.placement).toMatchObject({ parent: '', sortOrder: (readTraitData(copy, meta('EntityAttributes')) as { sortOrder: number }).sortOrder });
    const cap = capturedRecordsOf(copy)!.find((r) => r.rootGuid === cg)!;
    expect(strip(recOf(cg)! as never)).toEqual(strip(cap as never));

    await undo();
    expect(getAllEntities().some((e) => e.guid === cg)).toBe(false);
    expect(storedInstance(getCurrentWorld(), cg), 'the undo drops the copy\'s record').toBeUndefined();
    await redo();
    expect(strip(recOf(cg)! as never)).toEqual(strip(rec() as never));
  });

  // Mutation: `spawnOnRecords` returning right after the seat (no reprojection) — the copy keeps the old template's y.
  it('a redo after a template change rebuilds the copy onto the current document, under its own overrides', async () => {
    editSource();
    const copy = duplicateEntity(rootId(), () => {})!;
    const cg = guidOf(copy)!;
    const before = structuredClone(recOf(cg));
    expect(before, 'premise: the copy is on records').toBeTruthy();
    await undo();
    retuneB(7);
    await redo();
    const live = getAllEntities().find((e) => e.guid === cg)!.id;
    expect(tfOf(memberOf(live, 'B'))).toMatchObject({ x: 4, y: 7 });
    expect(recOf(cg)).toEqual(before);
  });

  it('a paste of a clipboard that outlived a template change shows the current document under the copied overrides', async () => {
    editSource();
    const clip = clipEntity(rootId(), 'copy')!;
    expect(clip.records?.size, 'premise: the clipboard carries the record').toBe(1);
    retuneB(7);
    const pasted = pasteEntityCopy(clip, 0, () => {})!;
    const pg = guidOf(pasted)!;
    expect(tfOf(memberOf(pasted, 'B'))).toMatchObject({ x: 4, y: 7 });
    expect(strip(recOf(pg)! as never)).toEqual(strip(rec() as never));
    await undo();
    expect(storedInstance(getCurrentWorld(), pg)).toBeUndefined();
  });
});
