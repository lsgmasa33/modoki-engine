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
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import {
  setActionCallback, pushAction, clearHistory, undo, writeTraitFieldWithUndo, reparentEntity, duplicateEntity,
  addTraitToEntitiesWithUndo, removeTraitFromEntitiesWithUndo, createEntityWithUndo, deleteEntitiesWithUndo,
} from '@modoki/engine/editor';
import { pasteEntityCopy, snapshotEntity } from '../../packages/modoki/src/editor/undo/entityActions';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { instantiatePrefabInstance } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { writeTraitField } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { fillInstanceStore } from '../../packages/modoki/src/runtime/prefab/instanceLoad';
import { freshInstanceRecord, storedInstance } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { instanceDrift } from '../../packages/modoki/src/editor/instance/instanceDrift';
import { capturedRecordsOf, reseedFromCapture } from '../../packages/modoki/src/editor/instance/instanceSync';
import { captureEntrySide, rebuildEntrySide } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { inFieldGesture } from '../../packages/modoki/src/editor/undo/fieldGesture';
import { s4Seams } from './prefabFuzz/s4Seams';
import { listDiff } from './prefabFuzz/shadow';
import type { OverrideList } from '../../packages/modoki/src/runtime/prefab/instanceRecord';
import { setTemplateKey } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { allStoredRoots, instanceKeyMap } from '../../packages/modoki/src/editor/instance/instanceKeys';
import { dropInstanceRecord, markStale, setInstanceRecord, unrecordedBy } from '../../packages/modoki/src/runtime/prefab/instanceStore';
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
const rec = () => { const r = freshInstanceRecord(getCurrentWorld(), ROOT1); if (!r) throw new Error('no fresh record'); return r; };
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
  clearKeptMemberOrphans();
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
    expect(storedInstance(getCurrentWorld(), ROOT1)?.stale).toBeUndefined();
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
    expect(storedInstance(getCurrentWorld(), ROOT1)?.stale).toBeUndefined();
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
  it('the parsed record, a capture re-seed and a rebuild leave it out of the record; the rebuild keeps it live', () => {
    stamp();
    fillInstanceStore(getCurrentWorld(), JSON.parse(JSON.stringify(scene())) as SceneData);
    expect(rec().placement.sourceScene).toBeUndefined();
    markStale(getCurrentWorld(), 'test');
    expect(reseedFromCapture(rootId())).toBe(true);
    expect(rec().placement.sourceScene).toBeUndefined();
    const side = captureEntrySide(rootId())!;
    expect(rebuildEntrySide(side)).toBeGreaterThan(0);
    expect(stampOf(rootId())).toBe(BASE);
    expect(stampOf(byName('C'))).toBe(BASE);
    markStale(getCurrentWorld(), 'test');
    expect(reseedFromCapture(rootId())).toBe(true);
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
  // Mutation: drop `instanceEdits.afterCopy` in `duplicateEntity` / `pasteEntityCopy`.
  it('a duplicate of a scene-owned node is linked beside it', () => {
    const kid = createEntityWithUndo('Create', byName('A'), [{ name: 'EntityAttributes', data: { name: 'Kid', parentId: byName('A') } }, { name: 'Transform' }], () => {})!;
    const copy = duplicateEntity(kid, () => {})!;
    expect(ownOf(key(2)).sort()).toEqual([guidOf(kid), guidOf(copy)].sort());
    matchesCapture();
  });
  it('a paste under a member is linked in its own', () => {
    const kid = createEntityWithUndo('Create', byName('A'), [{ name: 'EntityAttributes', data: { name: 'Kid', parentId: byName('A') } }, { name: 'Transform' }], () => {})!;
    const pasted = pasteEntityCopy(snapshotEntity(kid)!, byName('B'), () => {});
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
    const placed = freshInstanceRecord(getCurrentWorld(), guidOf(id)!);
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
  // #2037 (hunt seed 1094): a copy holding an instance, landing under a scene-added reference node nested in an instance,
  // is staged stale (S7 moves instance copies onto records). The record it changes is the NODE's, which owns one of its
  // own inside Inst's (§ 2.5), so every enclosing record goes stale — and only those: an unrelated instance stays fresh.
  // Mutations: mark `outermostStoredRoot` alone in `afterCopyImpl` (the node's record stays fresh); mark every record.
  it('a copy holding an instance under a nested reference node stales every record enclosing it, and no other (#2037)', async () => {
    const Q3 = 'cccccccc-0000-4000-8000-000000002018';
    const q3 = { id: Q3, version: 5, name: 'Q3', rootLocalId: 1, entities: [
      { localId: 1, name: 'QR3', nodeGuid: 'eeeeeeee-0000-4000-8000-000000002023', traits: { EntityAttributes: { name: 'QR3', parentId: 0, guid: '', sortOrder: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
      { localId: 2, name: 'QM3', nodeGuid: 'eeeeeeee-0000-4000-8000-000000002024', traits: { EntityAttributes: { name: 'QM3', parentId: 1, guid: '', sortOrder: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    ] };
    const q = qDoc();
    prefabs.set(Q3, q3); setPrefabCache(Q3, q3 as never); prefabs.set(Q, q); setPrefabCache(Q, q as never);
    const node = await instantiatePrefabInstance(q3 as never, 'q3.prefab.json', byName('A'));
    const unrelated = await instantiatePrefabInstance(q as never, 'q.prefab.json', 0);
    await instantiatePrefabInstance(q as never, 'q.prefab.json', byName('QM3')); // the instance the copy will hold
    const world = getCurrentWorld();
    expect(storedInstance(world, guidOf(node)!)?.stale).toBeUndefined();
    expect(storedInstance(world, guidOf(unrelated)!)?.stale).toBeUndefined();
    duplicateEntity(byName('QM3'), () => {}); // QM3's frame root is not in the copy: a PLAIN node under QR3, holding the instance
    expect(storedInstance(world, guidOf(node)!)?.stale).toBe('duplicateInstance');
    expect(storedInstance(world, ROOT1)?.stale).toBe('duplicateInstance');
    expect(storedInstance(world, guidOf(unrelated)!)?.stale).toBeUndefined();
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
  // Mutation: stop the climb at ANY unkeyed instance entity — a pre-v5 frame's unkeyed member is this instance's own.
  it('a template-added node under this instance\'s UNKEYED member (a pre-v5 row) still keys here', async () => {
    const d = pDoc();
    d.entities = d.entities.map((r) => (r.name === 'B' ? { ...r, nodeGuid: '' } : r));
    prefabs.set(d.id, d); setPrefabCache(d.id, d as never);
    await load(scene());
    const b = byName('B');
    const x = createEntityWithUndo('Create', b, [{ name: 'EntityAttributes', data: { name: 'X', parentId: b } }, { name: 'Transform' }], () => {})!;
    setTemplateKey(handle(x) as never, 'k-x');
    const keys = instanceKeyMap(rootId());
    expect(keys.has(b)).toBe(false);
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
    // I25 for this case, through the fuzzer's seams: C (`/g4`) is under B (`/g3`) though its key is flat (§ 2.1).
    // Mutation: ask `removedDescendants` by key prefix in s4Seams — C's kept row reads as the capture's miss.
    const judged = s4Seams.judge!(rec());
    expect('skip' in judged).toBe(false);
    expect(listDiff(judged as OverrideList, s4Seams.captureList!(ROOT1)!)).toBeNull();
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

describe('reparent (review R4: markCompensatedTransform)', () => {
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
// keys and the store's unrecorded scan both say so. Mutation: drop `!templateKeyOf` in `ownsRecord` (instanceKeys.ts) or
// in `liveStoredRootGuids` (instanceStore.ts).
describe('who owns a record', () => {
  it('a stored root carrying a template key owns no record: not a record-owning root, never "unrecorded"', () => {
    const root = rootId();
    expect(allStoredRoots()).toContain(root);
    dropInstanceRecord(getCurrentWorld(), ROOT1);
    markStale(getCurrentWorld(), 'probe');
    expect(unrecordedBy(getCurrentWorld(), ROOT1)).toBe('probe');
    setTemplateKey(findEntity(root) as never, 'k-ref');
    expect(allStoredRoots()).not.toContain(root);
  });
  it('…and the store does not list a template-keyed root as unrecorded', async () => {
    setTemplateKey(findEntity(rootId()) as never, 'k-ref');
    dropInstanceRecord(getCurrentWorld(), ROOT1);
    markStale(getCurrentWorld(), 'probe');
    expect(unrecordedBy(getCurrentWorld(), ROOT1)).toBeUndefined();
  });
});

// The door is a shadow at S4: a throw inside it (a parser or fold defect) must not fail the gesture. Mutation: export
// `setFieldsImpl` unshielded — the write throws out of `writeTraitFieldWithUndo`.
describe('the shield: the door never fails a gesture', () => {
  it('a door that throws reports, marks the record stale, and the write and its undo still land', async () => {
    setInstanceRecord(getCurrentWorld(), { ...rec(), list: null as never });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => writeTraitFieldWithUndo(byName('A'), meta('Transform'), 'x', 7)).not.toThrow();
      expect((readTraitData(byName('A'), meta('Transform')) as { x: number }).x).toBe(7);
      expect(errors.mock.calls.some((c) => String(c[0]).includes('[instanceEdits] setFields threw'))).toBe(true);
      expect(storedInstance(getCurrentWorld(), ROOT1)?.stale).toBe('doorError');
      await undo();
      expect((readTraitData(byName('A'), meta('Transform')) as { x: number }).x).toBe(0);
    } finally { errors.mockRestore(); }
  });
});

describe('stale marks: the ops S7 has not moved yet', () => {
  // Mutation: drop `markStale` in `undoStep`.
  it('an undo leaves every record stale, and the next door write re-seeds it from the capture first', async () => {
    writeTraitFieldWithUndo(byName('A'), meta('Transform'), 'x', 7);
    await undo();
    expect(storedInstance(getCurrentWorld(), ROOT1)?.stale).toBe('undo');
    writeTraitFieldWithUndo(byName('B'), meta('Transform'), 'x', 1);
    expect(row(key(2))?.traits).toBeUndefined(); // the undone edit is gone: the re-seed read the live tree
    expect(row(key(3))?.traits?.Transform).toEqual({ x: 1 });
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
