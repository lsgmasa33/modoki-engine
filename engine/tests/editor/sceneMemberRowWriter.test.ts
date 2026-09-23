/** #1468 Phase 4 — the WRITER puts a member's edits on its row, and the round trip survives a
 *  template renumber.
 *
 *  Each case edits an instance through the editor's own gestures, saves with the real
 *  `serializeScene`, then RENUMBERS the template (same members, same `nodeGuid`s, localIds rotated) and
 *  reloads. An edit stored by localId would land on whichever member now holds that number; one stored
 *  on the row lands on the member it names. The legacy channel is asserted EMPTY where a row carried the
 *  edit, so a writer that wrote both could not pass. */

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
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData, type SceneEntityEntry,
} from '@modoki/engine/runtime';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import {
  setActionCallback, pushAction, writeTraitFieldWithUndo, deleteEntitiesWithUndo, removeTraitFromEntitiesWithUndo,
  createEntityWithUndo, reparentEntity,
} from '@modoki/engine/editor';
import {
  setPrefabCache, instantiatePrefab, setPrefabSource, rebuildInstance, captureInstanceOverrides, captureInstanceStructure,
  revertOverridesSelective, applyToPrefabSelective, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { collectInstanceOverrideKeys, canonicalOverrideKey } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000000b01';
const O = 'cccccccc-0000-4000-8000-000000000b02';
const HOLDER = 'dddddddd-0000-4000-8000-000000000b01';
const ROOT = 'dddddddd-0000-4000-8000-000000000b02';
const gR = 'eeeeeeee-0000-4000-8000-000000000b01';
const gA = 'eeeeeeee-0000-4000-8000-000000000b02';
const gB = 'eeeeeeee-0000-4000-8000-000000000b03';
const gC = 'eeeeeeee-0000-4000-8000-000000000b04';
const gOR = 'eeeeeeee-0000-4000-8000-000000000b05';
const gSlot = 'eeeeeeee-0000-4000-8000-000000000b06';
const gN = 'eeeeeeee-0000-4000-8000-000000000b07';

const row = (localId: number, name: string, parentId: number, nodeGuid: string | undefined, extra: Record<string, unknown> = {}) => ({
  localId, name, ...(nodeGuid ? { nodeGuid } : {}), ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 }, Renderable3DPrimitive: {} },
});
/** R with three flat children. `ids` gives A, B, C their localIds; `minted` false makes it pre-v5. */
const template = (ids: [number, number, number] = [2, 3, 4], minted = true) => ({
  id: P, version: minted ? 5 : 4, name: 'P', rootLocalId: 1, entities: [
    row(1, 'R', 0, minted ? gR : undefined),
    row(ids[0], 'A', 1, minted ? gA : undefined), row(ids[1], 'B', 1, minted ? gB : undefined), row(ids[2], 'C', 1, minted ? gC : undefined),
  ],
});
/** The same members after a re-save RENUMBERED them. */
const renumbered = () => template([4, 2, 3]);
/** OR → Slot, plus (unless `plain`) a nested row N under Slot expanding P. */
const outer = (plain = false) => ({ id: O, version: 5, name: 'O', rootLocalId: 1, entities: [
  row(1, 'OR', 0, gOR), row(2, 'Slot', 1, gSlot),
  ...(plain ? [] : [row(3, 'N', 2, gN, { prefab: P })]),
] });
const install = (...docs: { id: string }[]) => {
  for (const d of docs) { prefabs.set(d.id, d); setPrefabCache(d.id, d as never); }
};

const scene = (source: string, entry: Record<string, unknown> = {}): SceneData => ({
  id: 'row-writer', version: SCENE_FORMAT_VERSION, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
    { id: 2, prefab: source, guid: ROOT, traits: { EntityAttributes: { name: 'Root', parentId: HOLDER } }, ...entry },
  ],
} as unknown as SceneData);

async function load(data: unknown): Promise<void> {
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
        getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source,
        overrides, structure, undefined, nested, nestedStructure,
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

const one = (name: string) => {
  const hits = getAllEntities().filter((e) => e.name === name);
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} entities named ${name}`);
  return hits[0]!;
};
const count = (name: string) => getAllEntities().filter((e) => e.name === name).length;
const tf = (name: string) => readTraitData(one(name).id, getTraitByName('Transform')!) as { x: number } | null;
const has = (name: string, trait: string) => !!readTraitData(one(name).id, getTraitByName(trait)!);
const parentName = (name: string) => getAllEntities().find((e) => e.id === one(name).parentId)?.name;
const meta = (t: string) => getTraitByName(t)!;
const entryOf = async (): Promise<SceneEntityEntry> => {
  const saved = await serializeScene() as unknown as { entities: SceneEntityEntry[] };
  return saved.entities.find((e) => !!e.prefab)!;
};
const addChild = (parent: string, name: string) =>
  createEntityWithUndo('Create', one(parent).id, [{ name: 'EntityAttributes', data: { name, parentId: one(parent).id } }], () => {});

beforeEach(() => { setRunMode('stopped'); prefabs.clear(); clearKeptMemberOrphans(); });
afterAll(() => { getCurrentWorld()?.destroy(); });

describe('the writer puts a member`s edits on its row (#1468 Phase 4)', () => {
  it('top frame: each channel goes on the row, the root`s own edit stays legacy — and survives a renumber', async () => {
    install(template());
    await load(scene(P));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    writeTraitFieldWithUndo(one('R').id, meta('Transform'), 'x', 9);
    removeTraitFromEntitiesWithUndo([one('B').id], meta('Renderable3DPrimitive'));
    deleteEntitiesWithUndo([one('C').id]);
    addChild('A', 'Extra');

    const entry = await entryOf();
    // The root has no row: its edit is the only thing left in `overrides`, under the root's localId.
    expect(Object.keys(entry.overrides ?? {})).toEqual(['1']);
    expect(entry.removed).toBeUndefined();
    expect(entry.removedTraits).toBeUndefined();
    expect(entry.added).toBeUndefined();
    expect(entry.members![`/${gA}`]!.traits).toEqual({ Transform: { x: 5 } });
    expect(entry.members![`/${gA}`]!.added!.map((n) => n.name)).toEqual(['Extra']);
    expect(entry.members![`/${gB}`]!.removedTraits).toEqual(['Renderable3DPrimitive']);
    expect(entry.members![`/${gC}`]).toEqual({ removed: true });

    install(renumbered());
    await load(scene(P, entry as never));
    expect(tf('A')?.x).toBe(5);
    expect(tf('B')?.x).toBe(0);
    expect(tf('R')?.x).toBe(9);
    expect(has('B', 'Renderable3DPrimitive')).toBe(false);
    expect(has('A', 'Renderable3DPrimitive')).toBe(true);
    expect(count('C')).toBe(0);
    expect(count('B')).toBe(1);
    expect(parentName('Extra')).toBe('A');
  });

  it('a row override that EQUALS the base survives a re-save — the load re-seeds its mark from the row', async () => {
    // #1468 Phase 2B's third mechanism: a stored override is a recorded override, even once it
    // coincides with the template's value, and only its MARK can say so (the value diff cannot).
    install(template());
    await load(scene(P, { members: { [`/${gA}`]: { guid: 'ffffffff-0000-4000-8000-00000000b0a1', traits: { Transform: { x: 0 } } } } }));
    const entry = await entryOf();
    expect(entry.members![`/${gA}`]!.traits).toEqual({ Transform: { x: 0 } });
  });

  it('a PRE-v5 template`s members have no row, so their edits stay in the legacy channels', async () => {
    install(template([2, 3, 4], false));
    await load(scene(P));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    deleteEntitiesWithUndo([one('C').id]);
    const entry = await entryOf();
    expect(entry.overrides?.[2]).toEqual({ Transform: { x: 5 } });
    expect(entry.removed).toEqual([4]);
    expect(entry.members).toBeUndefined();
  });

  it('nested frame: a nested member`s edit, a removal and an addition at the nested ROOT all go on rows', async () => {
    install(template(), outer());
    await load(scene(O));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    deleteEntitiesWithUndo([one('B').id]);
    addChild('R', 'Extra');

    const entry = await entryOf();
    expect(entry.nestedOverrides).toBeUndefined();
    expect(entry.nestedStructure).toBeUndefined();
    expect(entry.members![`/${gN}/${gA}`]!.traits).toEqual({ Transform: { x: 5 } });
    expect(entry.members![`/${gN}/${gB}`]).toEqual({ removed: true });
    expect(entry.members![`/${gN}`]!.added!.map((n) => n.name)).toEqual(['Extra']);

    install(renumbered(), outer());
    await load(scene(O, entry as never));
    expect(tf('A')?.x).toBe(5);
    expect(count('B')).toBe(0);
    expect(count('C')).toBe(1);
    expect(parentName('Extra')).toBe('R');
  });

  it('a nested frame whose template is PRE-v5 keeps its structure in the legacy slot, whole', async () => {
    // The outer row N has an identity, so the frame itself is keyable — but the inner template minted
    // none, so a removed inner member has no key. A nested frame's structure goes all-rows or
    // all-legacy (`moveChannelsOntoRows`), and here it must be all legacy.
    install(template([2, 3, 4], false), outer());
    await load(scene(O));
    deleteEntitiesWithUndo([one('B').id]);
    const entry = await entryOf();
    expect(entry.nestedStructure?.['3']?.removed).toEqual([3]);
    expect(Object.values(entry.members ?? {}).some((r) => r.removed)).toBe(false);
    await load(scene(O, entry as never));
    expect(count('B')).toBe(0);
    expect(count('A')).toBe(1);
  });

  it('a user-added REFERENCE node carries its own edits on its own rows, and itself hangs on a row', async () => {
    install(template(), outer(true));
    await load(scene(O));
    const refRoot = instantiatePrefab(prefabs.get(P) as PrefabFile, one('Slot').id);
    setPrefabSource(refRoot, P);
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);

    const entry = await entryOf();
    expect(entry.added).toBeUndefined();
    const ref = entry.members![`/${gSlot}`]!.added![0]!;
    expect(ref.prefab).toBe(P);
    expect(ref.overrides).toBeUndefined();
    expect(ref.members![`/${gA}`]!.traits).toEqual({ Transform: { x: 5 } });

    install(renumbered(), outer(true));
    await load(scene(O, entry as never));
    expect(tf('A')?.x).toBe(5);
    expect(tf('B')?.x).toBe(0);
    expect(parentName('R')).toBe('Slot');
  });

  it('a reference node on a row INSIDE another reference node keeps its members` stored guids', async () => {
    // Q is dragged under Slot, and P under Q's own QSlot: P's node rides on a row of Q's node, which
    // rides on a row of the entry. The loader must reach P's rows through BOTH, or its members fall
    // back to derivation — which, after a renumber, is a different guid.
    const Q = 'cccccccc-0000-4000-8000-000000000b03';
    const q = { id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [
      row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000000b08'), row(2, 'QSlot', 1, 'eeeeeeee-0000-4000-8000-000000000b09'),
    ] };
    install(template(), outer(true), q);
    await load(scene(O));
    const x = instantiatePrefab(q as unknown as PrefabFile, one('Slot').id);
    setPrefabSource(x, Q);
    const y = instantiatePrefab(prefabs.get(P) as PrefabFile, one('QSlot').id);
    setPrefabSource(y, P);
    // A fresh editor spawn carries RUNTIME guids, which no row may state (#1210); one save and reload
    // gives every member the durable guid a session that has ever saved has.
    await load(await serializeScene());
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    const guidA = one('A').guid;

    const entry = await entryOf();
    const xNode = entry.members![`/${gSlot}`]!.added![0]!;
    const yNode = xNode.members![`/eeeeeeee-0000-4000-8000-000000000b09`]!.added![0]!;
    expect(yNode.members![`/${gA}`]).toMatchObject({ guid: guidA, traits: { Transform: { x: 5 } } });

    install(renumbered(), outer(true), q);
    await load(scene(O, entry as never));
    expect(tf('A')?.x).toBe(5);
    expect(one('A').guid).toBe(guidA);
  });
});

describe('a REBUILD across two versions of the template translates what it carries by identity (#1468 Phase 4)', () => {
  // `rebuildInstance` accepts a `baseline` — the document the live tree was expanded from — other than
  // the one it rebuilds from. What it carries was captured in the baseline's numbering. (No caller
  // renumbers across it today: Apply is additive. This pins the function's own contract.)
  it('every channel lands on the member it was captured from, not on the one holding its old number', async () => {
    install(template());
    await load(scene(P));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    removeTraitFromEntitiesWithUndo([one('B').id], meta('Renderable3DPrimitive'));
    deleteEntitiesWithUndo([one('C').id]);
    addChild('A', 'Extra');
    const old = prefabs.get(P) as PrefabFile;
    const root = one('R').id;
    const next = renumbered() as unknown as PrefabFile;
    install(next as never);
    rebuildInstance(root, P, next, captureInstanceOverrides(root, old), captureInstanceStructure(root, old), old);
    expect(tf('A')?.x).toBe(5);
    expect(tf('B')?.x).toBe(0);
    expect(has('B', 'Renderable3DPrimitive')).toBe(false);
    expect(has('A', 'Renderable3DPrimitive')).toBe(true);
    expect(count('C')).toBe(0);
    expect(count('B')).toBe(1);
    expect(parentName('Extra')).toBe('A');
  });

  it('a MOVE is carried by identity too — the moved member stays where it was put', async () => {
    install(template());
    await load(scene(P));
    reparentEntity(one('A').id, one('B').id);
    const old = prefabs.get(P) as PrefabFile;
    const root = one('R').id;
    const next = renumbered() as unknown as PrefabFile;
    install(next as never);
    rebuildInstance(root, P, next, captureInstanceOverrides(root, old), captureInstanceStructure(root, old), old);
    expect(parentName('A')).toBe('B');
    expect(parentName('C')).toBe('R');
  });

  it('a member the new template DROPPED takes its edit with it, instead of handing it on', async () => {
    install(template());
    await load(scene(P));
    writeTraitFieldWithUndo(one('C').id, meta('Transform'), 'x', 7);
    const old = prefabs.get(P) as PrefabFile;
    const root = one('R').id;
    // C gone; A and B keep their identities, B now holding C's old number.
    const next = { id: P, version: 5, name: 'P', rootLocalId: 1, entities: [row(1, 'R', 0, gR), row(2, 'A', 1, gA), row(4, 'B', 1, gB)] } as unknown as PrefabFile;
    install(next as never);
    rebuildInstance(root, P, next, captureInstanceOverrides(root, old), captureInstanceStructure(root, old), old);
    expect(count('C')).toBe(0);
    expect(tf('B')?.x).toBe(0);
  });

  it('a NESTED capture`s chain is translated at its first link, so the nested edit comes back', async () => {
    install(template(), outer());
    await load(scene(O));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    const old = prefabs.get(O) as PrefabFile;
    const root = one('OR').id;
    // N's row renumbered 3 → 2 (Slot 2 → 3); nothing else changed.
    const next = { id: O, version: 5, name: 'O', rootLocalId: 1, entities: [
      row(1, 'OR', 0, gOR), row(3, 'Slot', 1, gSlot), row(2, 'N', 3, gN, { prefab: P }),
    ] } as unknown as PrefabFile;
    install(next as never);
    rebuildInstance(root, O, next, captureInstanceOverrides(root, old), captureInstanceStructure(root, old), old);
    expect(tf('A')?.x).toBe(5);
  });
});

describe('Apply/Revert keys name a member by identity (#1468 Phase 4)', () => {
  it('lists every key shape with the member`s nodeGuid, not its localId', async () => {
    install(template());
    await load(scene(P));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    removeTraitFromEntitiesWithUndo([one('B').id], meta('Renderable3DPrimitive'));
    deleteEntitiesWithUndo([one('C').id]);
    reparentEntity(one('B').id, one('A').id);
    const keys = collectInstanceOverrideKeys(one('R').id, prefabs.get(P) as PrefabFile);
    expect(keys.fields).toContain(`${gA}.Transform.x`);
    expect(keys.removedTraits).toEqual([`-trait.${gB}.Renderable3DPrimitive`]);
    expect(keys.removedEntities).toEqual([`-removed.${gC}`]);
    expect(keys.moved).toEqual([`~moved.${gB}`]);
  });

  it('a key listed BEFORE the template renumbered still reverts the member it named', async () => {
    install(template());
    await load(scene(P));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    writeTraitFieldWithUndo(one('B').id, meta('Transform'), 'x', 6);
    const listed = collectInstanceOverrideKeys(one('R').id, prefabs.get(P) as PrefabFile).fields.find((k) => k.startsWith(gA))!;
    const entry = await entryOf();
    // A re-save renumbers the template; the scene reloads from its file — what an external write does.
    install(renumbered());
    await load(scene(P, entry as never));
    await revertOverridesSelective(one('R').id, new Set([listed]));
    expect(tf('A')?.x).toBe(0);
    expect(tf('B')?.x).toBe(6);
  });

  it('a listed key acts on the member the CAPTURE meant — even while the cached template is newer than the live tree', async () => {
    // A kept base scene carried across a prefab reload, or a deferred reload, leaves the live tree in the
    // OLD numbering while the cache holds the new document. The capture then diffs each live localId
    // against the cache (#1169's class), and the consumers resolve keys in the cache too — so the key must
    // come from the cache as well. The close-out tried the live member's own nodeGuid instead and this
    // reddened: reverting every listed key moved A's override onto B (review of 50e489303).
    install(template());
    await load(scene(P));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    install(renumbered());                                  // cache renumbered; live tree NOT reloaded
    const keys = collectInstanceOverrideKeys(one('R').id, prefabs.get(P) as PrefabFile);
    await revertOverridesSelective(one('R').id, new Set(keys.fields.filter((k) => k.endsWith('.Transform.x'))));
    expect([tf('A')?.x, tf('B')?.x, tf('C')?.x]).toEqual([0, 0, 0]);
  });

  it('still ACCEPTS the localId spelling — and both spellings of one key compare equal', async () => {
    install(template());
    await load(scene(P));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    const doc = prefabs.get(P) as PrefabFile;
    expect(canonicalOverrideKey('2.Transform.x', doc)).toBe(canonicalOverrideKey(`${gA}.Transform.x`, doc));
    expect(canonicalOverrideKey('3.Transform.x', doc)).not.toBe(canonicalOverrideKey(`${gA}.Transform.x`, doc));
    await revertOverridesSelective(one('R').id, new Set(['2.Transform.x']));
    expect(tf('A')?.x).toBe(0);
  });

  it('a NESTED instance`s member moved out of it is keyed by identity at every depth, and reverts by that key', async () => {
    install(template(), outer());
    await load(scene(O));
    reparentEntity(one('A').id, one('Slot').id);
    const keys = collectInstanceOverrideKeys(one('OR').id, prefabs.get(O) as PrefabFile);
    expect(keys.moved).toEqual([`~moved.${gN}:${gA}`]);
    await revertOverridesSelective(one('OR').id, new Set(keys.moved));
    expect(parentName('A')).toBe('R');
  });

  it('Apply reports a key it skips in the CALLER`s spelling, not the internal one it turned it into', async () => {
    install(template());
    await load(scene(P));
    addChild('R', 'Extra');
    reparentEntity(one('A').id, one('Extra').id);
    const key = `~moved.${gA}`;
    const result = await applyToPrefabSelective(one('R').id, new Set([key]));
    expect(result.skipped?.map((x) => x.key)).toEqual([key]);
  });

  it('a key naming a member the template no longer has is REPORTED by Apply, never handed to another', async () => {
    install(template());
    await load(scene(P));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    const gone = 'eeeeeeee-0000-4000-8000-00000000dead';
    const result = await applyToPrefabSelective(one('R').id, new Set([`${gone}.Transform.x`]));
    expect(result.skipped?.map((x) => x.key)).toEqual([`${gone}.Transform.x`]);
    expect(result.applied).toBe(false);
  });
});

describe('a NESTED frame restates each member against the PREFAB baseline (#1468 Phase 4 close-out)', () => {
  // What `moveChannelsOntoRows` writes as `removed: false`, `removedTraits: []` and `added: []`: the
  // statement "the outer prefab row's list no longer applies to this member". The loader side of each is
  // in `sceneMemberRowChannels.test.ts`, which hand-writes the row and so cannot see the writer drop it.
  // Found by the close-out review: deleting the baseline half of the writer's `touch` left the whole
  // editor suite green. (Adapted from the reviewer's probes T1, T2, T7, T8.)
  const M = 'cccccccc-0000-4000-8000-000000000b0a';
  const gMR = 'eeeeeeee-0000-4000-8000-000000000b0a';
  const gK = 'eeeeeeee-0000-4000-8000-000000000b0b';
  const strip = (e: unknown) => JSON.parse(JSON.stringify(e)) as SceneEntityEntry;

  it('a member the prefab row deletes and the scene un-deletes stays, and the round trip is idempotent', async () => {
    const o = outer(); (o.entities[2] as Record<string, unknown>).removed = [4];
    install(template(), o);
    await load(scene(O));
    expect(count('C')).toBe(0);                             // the prefab layer alone deletes it
    await load(scene(O, { nestedStructure: { '3': { added: [], removed: [], removedTraits: {} } } }));
    expect(count('C')).toBe(1);
    await load(await serializeScene());
    writeTraitFieldWithUndo(one('C').id, meta('Transform'), 'x', 3);
    const e1 = strip(await entryOf());
    expect(e1.nestedStructure).toBeUndefined();
    expect(e1.members![`/${gN}/${gC}`]).toMatchObject({ removed: false, traits: { Transform: { x: 3 } } });
    await load(scene(O, e1 as never));
    expect(count('C')).toBe(1);
    expect(tf('C')?.x).toBe(3);
    expect(strip(await entryOf())).toEqual(e1);
  });

  it('two frames down, under a prefab row`s OWN nestedStructure (the loader`s structDirect)', async () => {
    const m = { id: M, version: 5, name: 'M', rootLocalId: 1, entities: [row(1, 'MR', 0, gMR), row(2, 'K', 1, gK, { prefab: P })] };
    const o = { id: O, version: 5, name: 'O', rootLocalId: 1, entities: [
      row(1, 'OR', 0, gOR), row(2, 'N', 1, gN, { prefab: M, nestedStructure: { '2': { added: [], removed: [3], removedTraits: {} } } }),
    ] };
    install(template(), m, o);
    await load(scene(O));
    expect(count('B')).toBe(0);
    await load(scene(O, { nestedStructure: { '2.2': { added: [], removed: [], removedTraits: {} } } }));
    expect(count('B')).toBe(1);
    await load(await serializeScene());
    deleteEntitiesWithUndo([one('A').id]);
    const e1 = strip(await entryOf());
    expect(e1.members![`/${gN}/${gK}/${gB}`]).toMatchObject({ removed: false });
    expect(e1.members![`/${gN}/${gK}/${gA}`]).toMatchObject({ removed: true });
    await load(scene(O, e1 as never));
    expect(count('A')).toBe(0);
    expect(count('B')).toBe(1);
    expect(strip(await entryOf())).toEqual(e1);
  });

  it('a node the prefab row ADDED and the scene deleted stays deleted', async () => {
    const fromPrefab = { parentLocalId: 1, guid: '', key: 'k-extra', name: 'PrefabExtra', traits: { EntityAttributes: { name: 'PrefabExtra' } }, children: [] };
    const o = outer(); (o.entities[2] as Record<string, unknown>).added = [fromPrefab];
    install(template(), o);
    await load(scene(O));
    await load(await serializeScene());
    expect(count('PrefabExtra')).toBe(1);
    deleteEntitiesWithUndo([one('PrefabExtra').id]);
    const e1 = strip(await entryOf());
    expect(e1.members![`/${gN}`]).toMatchObject({ added: [] });
    await load(scene(O, e1 as never));
    expect(count('PrefabExtra')).toBe(0);
  });

  it('a component the prefab row REMOVED and the scene restored stays restored', async () => {
    const o = outer(); (o.entities[2] as Record<string, unknown>).removedTraits = { 2: ['Renderable3DPrimitive'] };
    install(template(), o);
    await load(scene(O));
    expect(has('A', 'Renderable3DPrimitive')).toBe(false);
    await load(scene(O, { nestedStructure: { '3': { added: [], removed: [], removedTraits: {} } } }));
    expect(has('A', 'Renderable3DPrimitive')).toBe(true);
    await load(await serializeScene());
    const e1 = strip(await entryOf());
    expect(e1.members![`/${gN}/${gA}`]).toMatchObject({ removedTraits: [] });
    await load(scene(O, e1 as never));
    expect(has('A', 'Renderable3DPrimitive')).toBe(true);
  });
});
