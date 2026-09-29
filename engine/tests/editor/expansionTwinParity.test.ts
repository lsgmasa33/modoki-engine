/** #1707 — the two EXPANSIONS of a prefab document agree: the runtime's `instantiatePrefabIntoWorld` and the editor's
 *  `instantiatePrefab` (I1's expansion side, docs/prefabs.md § "Model and invariants").
 *
 *  The editor walk is a twin of the runtime one, and #1683 found it dropping what the runtime hands a nested row. This
 *  pins the two against each other in their real callers' shapes, over one matrix of channels:
 *    - TOP: a prefab dropped into the scene (the editor's plain top call) against the runtime's top call;
 *    - NODE: a scene-form reference node re-expanded by the editor (`spawnNestedInstance`, which every rebuild, Apply
 *      and Revert of the instance around it runs) against the runtime's expansion of the same node;
 *    - REFRESH: a nested frame rebuilt under what its enclosing layers forward (`frameForward`, #1737) against the load
 *      that built it.
 *  Each is compared as a TREE after the derive: every entity by guid, its parent's guid, and every trait's data. What
 *  that cannot see (trait spawn order, dirty marks, how `noteFrameDoc` is keyed, the move queue's order) is listed as
 *  harness-blind in the unification's issue. This is the before/after pin for that unification.
 *
 *  Found red by it, both at the editor's nested-row apply, which is where the frame's removals run: a slot's `moved` (a
 *  pre-v5 member's move, `InstanceStructure.unrowed`) was dropped, so the member went back to its row on every rebuild of
 *  the instance around the node; and the outermost layer's member rows were not handed down, so a member moved OUT from
 *  under a member the frame removes was deleted with it (close-out review 2 — the first version of this matrix had no
 *  such case and "measured" passing the rows as changing nothing). The last describe drives both through the real
 *  path: a scene load, then a Refresh of the host that rebuilds the node. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, getAllTraits, setRunMode, readTraitData,
  loadSceneFile, instantiatePrefabIntoWorld, deriveInstanceMemberGuids, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setPrefabCache, setPrefabSource } from '../../packages/modoki/src/editor/scene/prefabCache';
import {
  instantiatePrefab, applyStructureByRootInstance,
} from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { rebaseStaleInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { frameRootDoc } from '../../packages/modoki/src/runtime/core/ecs/identityParents';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const Q = 'cccccccc-0000-4000-8000-000000017072';
const P = 'cccccccc-0000-4000-8000-000000017071';
const O = 'cccccccc-0000-4000-8000-000000017070';
const H = 'cccccccc-0000-4000-8000-000000017079';
const ROOT = 'dddddddd-0000-4000-8000-000000017071';
const HOST = 'dddddddd-0000-4000-8000-000000017079';
const EXTRA = 'dddddddd-0000-4000-8000-000000017075';
const g = (n: number) => `eeeeeeee-0000-4000-8000-0000000170${String(n).padStart(2, '0')}`;
const [gQR, gM, gR, gA, gB, gC, gOR, gN, gHR] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(g);

const row = (localId: number, name: string, parentId: number, nodeGuid: string, x = 0) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x, y: 0, z: 0 } },
});
/** Q: QR → M. */
const qDoc = () => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0, gQR), row(2, 'M', 1, gM, 1)] });
/** P: R → A → B, and R → C, a row expanding Q whose own overrides move M. */
const pDoc = () => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
  row(1, 'R', 0, gR), row(2, 'A', 1, gA, 2), row(3, 'B', 2, gB, 3),
  { localId: 4, name: 'C', nodeGuid: gC, prefab: Q, traits: { EntityAttributes: { name: 'C', parentId: 1, guid: '' } },
    overrides: { 2: { Transform: { x: 4 } } } },
] });
/** O: OR → N, a row expanding P that states something through every channel a template row carries. */
const oDoc = () => ({ id: O, version: 6, name: 'O', rootLocalId: 1, entities: [
  row(1, 'OR', 0, gOR),
  {
    localId: 2, name: 'N', nodeGuid: gN, prefab: P, traits: { EntityAttributes: { name: 'N', parentId: 1, guid: '' } },
    overrides: { 2: { Transform: { y: 5 }, Rotate3D: { axis: 'y', speed: 2 } } },
    removedTraits: { 3: ['Transform'] },
    added: [{ parentLocalId: 2, guid: '', key: 'k-extra', name: 'Extra', traits: { EntityAttributes: { name: 'Extra', parentId: 0 }, Transform: { x: 6, y: 0, z: 0 } }, children: [] }],
    nestedOverrides: { 4: { 2: { Transform: { z: 7 } } } },
    members: { [`/${gC}/${gM}`]: { traits: { Transform: { y: 8 } } } },
  },
] });
/** H: one entity, the host a reference node hangs under. */
const hDoc = () => ({ id: H, version: 5, name: 'H', rootLocalId: 1, entities: [row(1, 'HR', 0, gHR)] });

const install = (...docs: Array<{ id: string }>) => { for (const d of docs) { prefabs.set(d.id, d); setPrefabCache(d.id, d as never); } };

beforeEach(() => {
  setRunMode('stopped');
  prefabs.clear();
  clearKeptMemberOrphans();
  install(qDoc(), pDoc(), oDoc(), hDoc());
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
});
afterAll(() => { for (const id of [Q, P, O, H]) setPrefabCache(id, null); getCurrentWorld()?.destroy(); });

const fresh = () => { const prev = getCurrentWorld(); setCurrentWorld(createWorld()); prev?.destroy(); };
const stampGuid = (id: number, guid: string) => {
  const ea = getTraitByName('EntityAttributes')!;
  for (const e of getCurrentWorld().entities) if (e.id() === id) e.set(ea.trait, { ...(e.get(ea.trait) as object), guid });
};

/** The world as a tree: per entity (by guid), its parent's guid and every trait's data, ECS ids read as guids. */
function tree(): Record<string, Record<string, unknown>> {
  const all = getAllEntities();
  const guidOf = new Map(all.map((e) => [e.id, e.guid || `<no guid: ${e.name}>`]));
  const out: Record<string, Record<string, unknown>> = {};
  for (const e of all) {
    const traits: Record<string, unknown> = {};
    for (const meta of getAllTraits()) {
      if (!e.traits.includes(meta.name)) continue;
      const data = readTraitData(e.id, meta);
      if (!data) { traits[meta.name] = true; continue; }
      const d = { ...(data as Record<string, unknown>) };
      if (meta.name === 'EntityAttributes') d.parentId = guidOf.get(d.parentId as number) ?? 0;
      if (meta.name === 'PrefabInstance') d.rootInstanceId = guidOf.get(d.rootInstanceId as number) ?? 0;
      traits[meta.name] = d;
    }
    const key = guidOf.get(e.id)!;
    if (out[key]) throw new Error(`fixture: two entities with guid ${key}`);
    out[key] = traits;
  }
  return out;
}
const parentName = (t: ReturnType<typeof tree>, name: string): string | undefined => {
  const hit = Object.values(t).filter((x) => (x.EntityAttributes as { name?: string })?.name === name);
  if (hit.length !== 1) throw new Error(`fixture: ${hit.length} entities named ${name}`);
  const parent = t[(hit[0]!.EntityAttributes as { parentId: string }).parentId];
  return (parent?.EntityAttributes as { name?: string } | undefined)?.name;
};

// ── TOP: the prefab's own content ────────────────────────────────────────────────────────────────
function runtimeTop(): ReturnType<typeof tree> {
  const id = instantiatePrefabIntoWorld(getCurrentWorld(), prefabs.get(O) as never, 0, undefined, O);
  stampGuid(id, ROOT);
  deriveInstanceMemberGuids(getCurrentWorld());
  return tree();
}
function editorTop(): ReturnType<typeof tree> {
  const id = instantiatePrefab(prefabs.get(O) as never);
  setPrefabSource(id, { id: O });
  stampGuid(id, ROOT);
  deriveInstanceMemberGuids(getCurrentWorld());
  return tree();
}

// ── NODE: a scene-form reference node of O under H, carrying `channels` ──────────────────────────
type NodeChannels = Record<string, unknown>;
const refNode = (channels: NodeChannels) => ({
  parentLocalId: 1, prefab: O, guid: ROOT, name: 'OR', traits: { EntityAttributes: { name: 'OR', parentId: 0 } }, children: [], ...channels,
});
function runtimeNode(channels: NodeChannels): ReturnType<typeof tree> {
  const id = instantiatePrefabIntoWorld(getCurrentWorld(), prefabs.get(H) as never, 0, undefined, H, undefined, { added: [refNode(channels)] } as never);
  stampGuid(id, HOST);
  deriveInstanceMemberGuids(getCurrentWorld());
  return tree();
}
function editorNode(channels: NodeChannels): ReturnType<typeof tree> {
  const host = instantiatePrefab(prefabs.get(H) as never);
  setPrefabSource(host, { id: H });
  stampGuid(host, HOST);
  applyStructureByRootInstance(host, prefabs.get(H) as never, { added: [refNode(channels) as never] });
  deriveInstanceMemberGuids(getCurrentWorld());
  return tree();
}
const both = (channels: NodeChannels) => {
  const runtime = runtimeNode(channels);
  fresh();
  return { runtime, editor: editorNode(channels) };
};

/** What a scene can state inside the reference node — one case per channel, each reaching the nested frames. */
const NODE_CASES: Record<string, NodeChannels> = {
  'no channels': {},
  'overrides on its own member': { overrides: { 1: { Transform: { x: 9 } } } },
  'nestedOverrides into N and into N.C': { nestedOverrides: { 2: { 2: { Transform: { z: 3 } } }, '2.4': { 2: { Transform: { y: 7 } } } } },
  'a nestedStructure slot owning N': { nestedStructure: { 2: {
    added: [{ parentLocalId: 2, guid: EXTRA, name: 'SceneExtra', traits: { EntityAttributes: { name: 'SceneExtra', parentId: 0 } }, children: [] }],
    removed: [3], removedTraits: {},
  } } },
  'member rows: a deep field row and a deep removal': { members: {
    [`/${gN}/${gA}`]: { guid: '', traits: { Transform: { x: 11 } } },
    [`/${gN}/${gC}/${gM}`]: { removed: true },
  } },
  'a member row moving a nested member (v5 carrier)': { members: { [`/${gN}/${gA}`]: { guid: '', parent: ROOT } } },
  // A member moved OUT from under a member the same frame removes: the removal cascade stops at a moved member only when
  // the apply that removes is told about the move (`applyStructureCore`'s `movedSet`). The editor's nested row was not
  // handed the rows, so B went with A (close-out review 2).
  'member rows: B moved out from under A, and A removed': { members: {
    [`/${gN}/${gA}`]: { removed: true }, [`/${gN}/${gB}`]: { guid: '', parent: ROOT },
  } },
  'a slot removing A, and a member row moving B out from under it': {
    nestedStructure: { 2: { added: [], removed: [2], removedTraits: {} } },
    members: { [`/${gN}/${gB}`]: { guid: '', parent: ROOT } },
  },
  // The pre-v5 carrier: `captureNestedChannels` writes a slot's `moved` only for a member no row can key
  // (`InstanceStructure.unrowed`). The editor's nested row dropped it (#1707).
  'a nestedStructure slot moving a nested member (pre-v5 carrier)': { nestedStructure: { 2: { added: [], removed: [], removedTraits: {}, moved: { 2: ROOT } } } },
};

describe('#1707: the editor and runtime expansions build the same tree', () => {
  it('TOP: a prefab dropped in, every template-row channel (overrides, removedTraits, added, nestedOverrides, members)', () => {
    const runtime = runtimeTop();
    fresh();
    const editor = editorTop();
    expect(editor).toEqual(runtime);
    // Not an inert fixture: the row's channels reached the nested frames.
    const named = (n: string) => Object.values(runtime).find((t) => (t.EntityAttributes as { name?: string }).name === n)!;
    expect(Object.keys(runtime)).toHaveLength(7); // OR, R, A, B, QR, M, Extra
    expect(parentName(runtime, 'Extra')).toBe('A');
    expect(named('A').Rotate3D).toBeTruthy();
    expect(named('B').Transform).toBeUndefined();
    expect(named('M').Transform).toMatchObject({ x: 4, y: 8, z: 7 });
  });

  for (const [name, channels] of Object.entries(NODE_CASES)) {
    it(`NODE: ${name}`, () => {
      const { runtime, editor } = both(channels);
      expect(editor).toEqual(runtime);
    });
  }

  it('NODE, pre-v5 slot move: the moved member sits where the runtime puts it (the case #1707 found red)', () => {
    // Mutation: drop `moved: structDirect?.moved` from the editor's nested-row apply (`instantiatePrefab`) — A goes
    // back under R in the editor tree only.
    const { runtime, editor } = both(NODE_CASES['a nestedStructure slot moving a nested member (pre-v5 carrier)']!);
    expect(parentName(runtime, 'A')).toBe('OR');
    expect(parentName(editor, 'A')).toBe('OR');
  });
});

// ── REFRESH: a nested frame rebuilt under its enclosing layers' forward state ─────────────────────
const sceneOf = (): SceneData => ({
  id: 'twin', version: 17, name: 'S', resources: [],
  entities: [{ id: 1, prefab: O, guid: ROOT, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } } }],
} as unknown as SceneData);
async function load(data: SceneData): Promise<void> {
  fresh();
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
      if (id && rootGuid) stampGuid(id, rootGuid);
      return id ?? undefined;
    },
  });
}

describe('#1707: a Refresh of a nested frame rebuilds it as the load built it (frameForward, #1737)', () => {
  // A template edit no enclosing layer touches — each document's root x. ⚠️ It has to differ BY VALUE: the rebase compares
  // document text (`sameDocument`), so an equal copy is not stale, and a case that rebuilds nothing compares the load with
  // itself (close-out review 2 found the first version of these doing exactly that). So each asserts a rebuild ran.
  const rootX = <T extends { entities: ReadonlyArray<{ traits: object }> }>(d: T): T => {
    ((d.entities[0]!.traits as Record<string, Record<string, number>>).Transform!).x = 13;
    return d;
  };
  for (const [label, edited] of [['P (depth 1, under O\'s row N)', () => rootX(pDoc())], ['Q (depth 2, under P\'s row C)', () => rootX(qDoc())]] as const) {
    it(`a template edit to ${label}: the Refresh gives what a load of the edited document gives`, async () => {
      await load(sceneOf());
      install(edited());
      expect(await rebaseStaleInstances()).toBeGreaterThan(0);
      const refreshed = tree();
      await load(sceneOf());
      expect(refreshed).toEqual(tree());
    });
  }

  it('a row the template GAINS: the new frame gets what O\'s row states in it, as a load of the new P gives it', async () => {
    // A frame the Refresh GAINS has no live capture at all, and gets O's statements in it (N's `nestedOverrides` and member
    // row into C) only through `frameForward`.
    // Mutation: expand the rebuild as a plain top call (`rebuildInstance`'s `forward` ignored) — M loses z 7 and y 8 (the P
    // edit above goes red with it; the Q edit cannot see it, Q's frame having no nested row to forward into).
    const withoutC = () => { const d = pDoc(); d.entities = d.entities.filter((e) => e.localId !== 4); return d; };
    install(withoutC());
    await load(sceneOf());
    install(pDoc());
    await rebaseStaleInstances();
    const refreshed = tree();
    await load(sceneOf());
    expect(refreshed).toEqual(tree());
    const m = Object.values(refreshed).find((t) => (t.EntityAttributes as { name?: string }).name === 'M')!;
    expect(m.Transform).toMatchObject({ x: 4, y: 8, z: 7 });
  });
});

// ── End to end: the rebuild of a HOST re-expands the reference node inside it through the editor walk ─────────────────
/** A scene holding one instance of H, whose scene-added reference node of O carries `channels`. */
const hostScene = (channels: NodeChannels): SceneData => ({
  id: 'twin-host', version: 17, name: 'S', resources: [],
  entities: [{ id: 1, prefab: H, guid: HOST, traits: { EntityAttributes: { name: 'Host', parentId: 0 } }, added: [refNode(channels)] }],
} as unknown as SceneData);
/** H with a row it did not have: stale by value, so a Refresh rebuilds the host, and with it the node. */
const hGained = () => { const d = hDoc(); d.entities.push(row(2, 'HExtra', 1, g(10))); return d; };

describe('#1707: a host Refresh keeps what the scene stated inside the reference node (the real path, end to end)', () => {
  /** P as a pre-v5 template writes it: no `nodeGuid` on R, A or B, so the capture can key A's move to no row and states it
   *  in the slot (`InstanceStructure.unrowed`). With a v5 P the rebuild re-keys the move onto a member row, and this case
   *  cannot see the slot carrier at all (close-out review 2's point; the first version of it was green without the fix). */
  const pPreV5 = () => { const d = pDoc(); for (const e of d.entities) if (e.localId !== 4) delete (e as { nodeGuid?: string }).nodeGuid; return d; };
  const cases: Record<string, { channels: NodeChannels; docs?: () => Array<{ id: string }>; check: (t: ReturnType<typeof tree>) => void }> = {
    'a pre-v5 slot move: A stays under OR': {
      docs: () => [pPreV5()],
      channels: NODE_CASES['a nestedStructure slot moving a nested member (pre-v5 carrier)']!,
      check: (t) => expect(parentName(t, 'A')).toBe('OR'),
    },
    'B moved out from under A, A removed: B is still there, under OR': {
      channels: NODE_CASES['member rows: B moved out from under A, and A removed']!,
      check: (t) => expect(parentName(t, 'B')).toBe('OR'),
    },
  };
  for (const [name, { channels, docs, check }] of Object.entries(cases)) {
    it(name, async () => {
      if (docs) install(...docs());
      // Mutations: drop `moved: structDirect?.moved` (the first goes red) or `members` (the second) from the editor's
      // nested-row apply in `instantiatePrefab`.
      await load(hostScene(channels));
      check(tree());
      install(hGained());
      expect(await rebaseStaleInstances()).toBeGreaterThan(0);
      const refreshed = tree();
      check(refreshed);
      await load(hostScene(channels));
      expect(refreshed).toEqual(tree());
    });
  }
});

// ── #1812: the frame RECORD, which the tree comparison above cannot see ──────────────────────────
describe('#1812: both expansions record the same rows they could not expand, on the same frames', () => {
  // The save reads `FrameRootRecord.unexpanded` to tell a row the frame never had from one the user removed, so the two
  // expansions must write it alike. Mutation: record `[]` in either twin's `noteFrameDoc` — the missing-Q cases differ.
  /** Every frame root's record, by the root's guid: what it says it could not expand. */
  const records = (): Record<string, readonly number[] | undefined> => {
    const world = getCurrentWorld();
    const out: Record<string, readonly number[] | undefined> = {};
    for (const e of world.entities) {
      const rec = frameRootDoc(world, e as never);
      if (!rec) continue;
      const guid = getAllEntities().find((x) => x.id === e.id())?.guid || `<no guid ${e.id()}>`;
      out[guid] = rec.unexpanded;
    }
    return out;
  };
  const dropQ = () => { prefabs.delete(Q); setPrefabCache(Q, null); };
  const recordsOf = (build: () => unknown) => { build(); return records(); };

  it('TOP, Q missing: N\'s frame lists row C on both sides', () => {
    dropQ();
    const runtime = recordsOf(runtimeTop);
    fresh();
    const editor = recordsOf(editorTop);
    expect(Object.values(runtime).some((u) => u?.includes(4))).toBe(true); // not inert: the runtime listed C
    expect(editor).toEqual(runtime);
  });

  it('NODE, Q missing, and a member row removing C: the removal takes C off the list on both sides', () => {
    dropQ();
    const channels = { members: { [`/${gN}/${gC}`]: { removed: true } } };
    const runtime = recordsOf(() => runtimeNode(channels));
    fresh();
    const editor = recordsOf(() => editorNode(channels));
    expect(Object.values(runtime).some((u) => u?.includes(4))).toBe(false);
    expect(editor).toEqual(runtime);
  });

  it('every prefab present: every record lists nothing', () => {
    const runtime = recordsOf(runtimeTop);
    fresh();
    const editor = recordsOf(editorTop);
    expect(Object.values(runtime).every((u) => u !== undefined && u.length === 0)).toBe(true);
    expect(editor).toEqual(runtime);
  });
});
