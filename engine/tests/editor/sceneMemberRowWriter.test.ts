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
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, findEntity, type SceneData, type SceneEntityEntry,
} from '@modoki/engine/runtime';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import {
  setActionCallback, pushAction, writeTraitFieldWithUndo, deleteEntitiesWithUndo, removeTraitFromEntitiesWithUndo,
  createEntityWithUndo, reparentEntity, duplicateEntity, staleInstanceRefusal,
} from '@modoki/engine/editor';
import { Transient } from '../../packages/modoki/src/runtime/core/traits/Transient';
import {
  setPrefabCache, instantiatePrefab, setPrefabSource, rebuildInstance, captureInstanceOverrides, captureInstanceStructure,
  revertOverridesSelective, applyToPrefabSelective, framesBuiltFromOtherRows, rebaseStaleInstances, getCachedPrefabSync, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { collectInstanceOverrideKeys, canonicalOverrideKey } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { serializeScene, adoptWorldReloadedFromDisk } from '../../packages/modoki/src/editor/scene/serialize';
import { captureSide, rederiveBaseInstances } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
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

async function load(data: unknown, opts: { keepPrevious?: boolean } = {}): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  if (!opts.keepPrevious) prev?.destroy();
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

  it('Revert REFUSES while the cached template numbers the live tree`s rows differently (#1483)', async () => {
    // A kept base scene carried across a prefab reload, or a deferred reload, leaves the live tree in the
    // OLD numbering while the cache holds the new document. Every capture diffs a live localId against the
    // cache, so each member is compared with another member's row. Before #1483 this case asserted the
    // keys and the revert at least AGREED in that state; they agreed on the wrong rows, and Apply wrote A's
    // value into B's row. A frame built from other rows is now refused, and nothing moves.
    install(template());
    await load(scene(P));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    install(renumbered());                                  // cache renumbered; live tree NOT reloaded
    expect(framesBuiltFromOtherRows(one('R').id)).toEqual([P]);
    expect(await revertOverridesSelective(one('R').id, new Set([`${gA}.Transform.x`]))).toBeNull();
    expect([tf('A')?.x, tf('B')?.x, tf('C')?.x]).toEqual([5, 0, 0]);
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

describe('a live frame built from another version of its template (#1483)', () => {
  const written: unknown[] = [];
  beforeEach(() => {
    written.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') written.push(init.body);
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }));
  });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('Apply REFUSES, and writes nothing — it would put A`s value into the row B now holds', async () => {
    install(template());
    await load(scene(P));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    install(renumbered());
    const result = await applyToPrefabSelective(one('R').id, new Set([`${gA}.Transform.x`]));
    expect(result.applied).toBe(false);
    expect(result.refused).toMatch(/different version/);
    expect(written).toEqual([]);
  });

  it('a template whose VALUES changed but whose rows did not is NOT refused', async () => {
    install(template());
    await load(scene(P));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    const retuned = template();
    (retuned.entities[2]!.traits.Transform as { x: number }).x = 7;   // B's base moved; same numbering
    install(retuned);
    expect(framesBuiltFromOtherRows(one('R').id)).toEqual([]);
    const result = await applyToPrefabSelective(one('R').id, new Set([`${gA}.Transform.x`]));
    expect(result.applied).toBe(true);
  });

  it('a template that GAINED a row IS refused — the structure capture would read the new row as removed', async () => {
    // Close-out review 2: every row of the cached document with no live member is captured as one this
    // instance REMOVED, so a gained row is a false removal on the next save or Revert. (An earlier version let
    // it through, on the evidence of a fixture that split the two caches production keeps in step.)
    install(template());
    await load(scene(P));
    const grown = template();
    grown.entities.push(row(5, 'D', 1, 'eeeeeeee-0000-4000-8000-000000000b08'));
    install(grown);
    expect(framesBuiltFromOtherRows(one('R').id)).toEqual([P]);
  });

  it('a template that DROPPED a row the live tree has IS refused — that member has no row to be read against', async () => {
    install(template());
    await load(scene(P));
    const shrunk = template();
    shrunk.entities = shrunk.entities.filter((e) => e.name !== 'C');
    install(shrunk);
    expect(framesBuiltFromOtherRows(one('R').id)).toEqual([P]);
  });

  it('a NESTED frame built from other rows is reported too', async () => {
    install(template(), outer());
    await load(scene(O));
    install(renumbered());                                  // the nested template changed; the outer did not
    expect(framesBuiltFromOtherRows(one('OR').id)).toEqual([P]);
  });

  it('rebaseStaleInstances rebuilds it from the document it WAS expanded from — the edit stays on A', async () => {
    install(template());
    await load(scene(P));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    install(renumbered());
    expect(await rebaseStaleInstances()).toBe(1);
    expect([tf('A')?.x, tf('B')?.x, tf('C')?.x]).toEqual([5, 0, 0]);
    expect(framesBuiltFromOtherRows(one('R').id)).toEqual([]);
    const keys = collectInstanceOverrideKeys(one('R').id, prefabs.get(P) as PrefabFile);
    expect(keys.fields).toEqual([`${gA}.Transform.x`]);    // no false override on any other member
  });

  it('a hot reload rebuilds a carried stale instance WHATEVER scene owns it — a kept base`s, or a Persistent root`s', async () => {
    // The primary is re-expanded from disk by the reload and compares equal; only a carried root is stale, and
    // a Persistent one belongs to no kept base (review of 4f0b839d0: the first version looked at kept bases only).
    install(template());
    await load(scene(P));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    install(renumbered());
    await adoptWorldReloadedFromDisk('/scenes/level.json', new Set());
    expect(framesBuiltFromOtherRows(one('R').id)).toEqual([]);
    expect([tf('A')?.x, tf('B')?.x, tf('C')?.x]).toEqual([5, 0, 0]);
  });

  it('a world replaced while the rebuild waits for its prefabs rebuilds nothing', async () => {
    // The replacement is the SAME scene reloaded from the new template — the root has the same id and guid
    // there, so only the world check keeps the rebuild (from the OLD document) off a frame that is current.
    install(template());
    await load(scene(P));
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
    const entry = await entryOf();
    install(renumbered());
    await load(scene(P, entry as never));
    const fresh = getCurrentWorld();                          // built from the renumbered template
    install(template());
    await load(scene(P, entry as never), { keepPrevious: true }); // built from the old one: stale once…
    const staleWorld = getCurrentWorld();
    install(renumbered());                                    // …the cache moves on
    const pending = rebaseStaleInstances();                   // collects synchronously, then awaits preloads
    setCurrentWorld(fresh);
    expect(await pending).toBe(0);
    staleWorld.destroy();
    expect([tf('A')?.x, tf('B')?.x, tf('C')?.x]).toEqual([5, 0, 0]);
  });

  it('a DUPLICATE keeps the record of the document its source was expanded from', async () => {
    // A respawn is a new entity, so the record keyed by the old one did not reach it: the copy read as
    // current, was never rebuilt or refused, and Apply wrote B's value into A's row (review of 4f0b839d0).
    install(template());
    await load(scene(P));
    const copy = duplicateEntity(one('R').id, () => {})!;
    install(renumbered());
    expect(framesBuiltFromOtherRows(copy)).toEqual([P]);
  });

  it('a delete + UNDO keeps the record too', async () => {
    install(template());
    await load(scene(P));
    const { undo } = await import('@modoki/engine/editor');
    deleteEntitiesWithUndo([one('R').id]);
    await undo();
    install(renumbered());
    expect(framesBuiltFromOtherRows(one('R').id)).toEqual([P]);
  });

  it('a stale nested frame under a RUNTIME subtree is not authoring input, and refuses nothing', async () => {
    install(template(), outer());
    await load(scene(O));
    findEntity(one('R').id)!.add(Transient);               // the nested P frame's root (named after P's root row)
    install(renumbered());
    expect(framesBuiltFromOtherRows(one('OR').id)).toEqual([]);
  });

  it('the refusal names each stale source once, however many of its frames are stale', async () => {
    const two = { ...outer(), entities: [...outer().entities, row(4, 'N2', 2, 'eeeeeeee-0000-4000-8000-000000000b09', { prefab: P })] };
    install(template(), two);
    await load(scene(O));
    install(renumbered());
    expect(framesBuiltFromOtherRows(one('OR').id)).toEqual([P]);
    expect(staleInstanceRefusal(one('OR').id)).toMatch(new RegExp(`^this instance was built from a different version of "${P}" than`));
  });

  it('an Apply on ANOTHER instance refreshes a stale nested P frame from the document IT was built from (review of 4f0b839d0)', async () => {
    // Root1 = an O instance with P nested, built before the cache renumbered P; Root2 = a plain P instance made
    // after, so it is current. No rebase runs (since #1493 one would rebuild the nested frame itself, and this
    // case is about the fan-out). The Apply fan-out from Root2 lists the nested P root itself, and captured it
    // against the CACHED rows — moving A's edit onto B for good. Each root is now captured against its own record.
    install(template(), outer());
    await load(scene(O));
    const under = (topId: number, name: string) => {
      const all = getAllEntities();
      const inside = (id: number): boolean => { const e = all.find((x) => x.id === id); return !!e && (e.parentId === topId || inside(e.parentId)); };
      return all.find((e) => e.name === name && inside(e.id))!;
    };
    const orId = () => getAllEntities().find((e) => e.name === 'OR')!.id;
    writeTraitFieldWithUndo(under(orId(), 'A').id, meta('Transform'), 'x', 5);
    install(renumbered());
    const plainRoot = instantiatePrefab(getCachedPrefabSync(P)!, one('Holder').id);
    setPrefabSource(plainRoot, P);
    expect(framesBuiltFromOtherRows(orId())).toEqual([P]);       // the premise: only the nested frame is stale
    expect(framesBuiltFromOtherRows(plainRoot)).toEqual([]);
    writeTraitFieldWithUndo(under(plainRoot, 'B').id, meta('Transform'), 'x', 7);
    const result = await applyToPrefabSelective(plainRoot, new Set([`${gB}.Transform.x`]));
    expect(result.applied).toBe(true);
    const nestedTf = (name: string) => readTraitData(under(orId(), name).id, meta('Transform')) as { x: number };
    expect([nestedTf('A').x, nestedTf('B').x]).toEqual([5, 7]); // A keeps its edit; B follows the applied template
    expect(framesBuiltFromOtherRows(orId())).toEqual([]);       // and the frame is current now
  });

  it('an Apply fan-out SKIPS an instance whose stale frame is NESTED — its capture would read the wrong rows', async () => {
    // Root1 = an O instance built before P renumbered (its nested P frame is stale); Root2 = an O instance
    // made after. An Apply of O from Root2 refreshes every O instance; Root1's nested capture reads the
    // cached P, so rebuilding it would move A's edit onto B. It is left alone, and stays refused.
    install(template(), outer());
    await load(scene(O));
    const r1 = one('OR').id;
    const nestedA = () => getAllEntities().filter((e) => e.name === 'A');
    writeTraitFieldWithUndo(nestedA()[0]!.id, meta('Transform'), 'x', 5);
    install(renumbered());
    const r2 = instantiatePrefab(getCachedPrefabSync(O)!, one('Holder').id);
    setPrefabSource(r2, O);
    expect(framesBuiltFromOtherRows(r2)).toEqual([]);
    const slot2 = getAllEntities().find((e) => e.name === 'Slot' && e.parentId === r2)!.id;
    writeTraitFieldWithUndo(slot2, meta('Transform'), 'x', 3);
    const result = await applyToPrefabSelective(r2, new Set([`${gSlot}.Transform.x`]));
    expect(result.applied).toBe(true);
    const inR1 = (name: string) => {
      const all = getAllEntities();
      const inside = (id: number): boolean => { const e = all.find((x) => x.id === id); return !!e && (e.parentId === r1 || inside(e.parentId)); };
      return readTraitData(all.find((e) => e.name === name && inside(e.id))!.id, meta('Transform')) as { x: number };
    };
    expect([inR1('A').x, inR1('B').x]).toEqual([5, 0]);        // not rebuilt against the wrong rows
    expect(inR1('Slot').x).toBe(0);                             // …so not refreshed at all: that is the cost
    expect(framesBuiltFromOtherRows(r1)).toEqual([P]);         // and it is still refused
  });
});

describe('a P instance dropped inside another P instance, through an Apply fan-out (#1483 close-out review 2)', () => {
  // The outer rebuild captures the inner instance through `captureNestedRef`, which reads the CACHED document,
  // so the inner one must be refreshed first. Outer first, a node the apply had just promoted was captured as
  // REMOVED in whichever instance was not current yet, and the save made it permanent.
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response)); });
  afterAll(() => { vi.unstubAllGlobals(); });
  const ROOT2 = 'dddddddd-0000-4000-8000-000000000b03';
  const gD = 'eeeeeeee-0000-4000-8000-000000000b0d';
  const twoP = (order: 'outer-first' | 'inner-first'): SceneData => {
    const a = { id: 2, prefab: P, guid: ROOT, traits: { EntityAttributes: { name: 'Root', parentId: HOLDER } } };
    const b = { id: 3, prefab: P, guid: ROOT2, traits: { EntityAttributes: { name: 'Root2', parentId: HOLDER } } };
    return {
      id: 'row-writer', version: SCENE_FORMAT_VERSION, name: 'S', resources: [],
      entities: [{ id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } }, ...(order === 'outer-first' ? [a, b] : [b, a])],
    } as unknown as SceneData;
  };
  const guidOf = (id: number) => (readTraitData(id, meta('EntityAttributes')) as { guid: string }).guid;
  const idOfGuid = (g: string) => getAllEntities().find((e) => guidOf(e.id) === g)!.id;
  /** Load both, drop ROOT2's instance under ROOT's A, and add a plain node D under ROOT's root. */
  const setUp = async (order: 'outer-first' | 'inner-first') => {
    install(template());
    await load(twoP(order));
    const outer = idOfGuid(ROOT);
    const a = getAllEntities().find((e) => e.name === 'A' && e.parentId === outer)!.id;
    reparentEntity(idOfGuid(ROOT2), a);
    createEntityWithUndo('Create', outer, [{ name: 'EntityAttributes', data: { name: 'D', parentId: outer, guid: gD } }], () => {});
  };
  const noneRemoved = async () => {
    const saved = await serializeScene() as unknown as { entities: SceneEntityEntry[] };
    return JSON.stringify(saved.entities.filter((e) => !!e.prefab)).includes('"removed":true');
  };

  it('undoing an Apply made from the INNER base instance re-derives the outer one too (#1483 review 3)', async () => {
    // Both instances belong to a carried base. The undo rebuilds the applied (inner) one from its capture and
    // re-derives every OTHER base instance; the outer one was judged while the inner was still built from the
    // applied prefab, read as holding a stale nested frame, and skipped — keeping the promoted member.
    await setUp('outer-first');
    const BASE = 'ffffffff-0000-4000-8000-000000001483';
    const stampAll = () => getCurrentWorld().query(meta('EntityAttributes').trait).updateEach(([d]) => { (d as { sourceScene: string }).sourceScene = BASE; });
    stampAll();
    const inner = idOfGuid(ROOT2);
    const gE = 'eeeeeeee-0000-4000-8000-000000000b0f';
    createEntityWithUndo('Create', inner, [{ name: 'EntityAttributes', data: { name: 'E', parentId: inner, guid: gE, sourceScene: BASE } }], () => {});
    const before = prefabs.get(P) as PrefabFile;
    const side = captureSide(idOfGuid(ROOT2), ROOT2, before);
    const result = await applyToPrefabSelective(idOfGuid(ROOT2), new Set([`+added.${gE}`]));
    expect(getAllEntities().filter((e) => e.name === 'E')).toHaveLength(2);   // the premise: both expanded it
    stampAll();
    setPrefabCache(P, before as never);                     // the undo's prefab restore
    await rederiveBaseInstances(P, result.prefabAfter!, before, side);
    expect(getAllEntities().filter((e) => e.name === 'E')).toHaveLength(1);   // back on the inner one only
    expect(framesBuiltFromOtherRows(idOfGuid(ROOT))).toEqual([]);
    expect(framesBuiltFromOtherRows(idOfGuid(ROOT2))).toEqual([]);
  });

  for (const order of ['outer-first', 'inner-first'] as const) {
    it(`a REBASE after the template gained a row rebuilds both, inner first (${order})`, async () => {
      await setUp(order);
      const grown = template();
      grown.entities.push(row(5, 'E', 1, 'eeeeeeee-0000-4000-8000-000000000b0e'));
      install(grown);                                       // an external write; both instances were built before it
      expect(await rebaseStaleInstances()).toBe(2);
      expect(getAllEntities().filter((e) => e.name === 'E')).toHaveLength(2);
      expect(await noneRemoved()).toBe(false);
    });

    it(`Apply of the promoted node from the OUTER instance reaches both (${order})`, async () => {
      await setUp(order);
      const result = await applyToPrefabSelective(idOfGuid(ROOT), new Set([`+added.${gD}`]));
      expect(result.applied).toBe(true);
      expect(getAllEntities().filter((e) => e.name === 'D')).toHaveLength(2);
      expect(await noneRemoved()).toBe(false);
      expect(framesBuiltFromOtherRows(idOfGuid(ROOT))).toEqual([]);
    });

    it(`Apply of a field from the INNER instance refreshes the outer too (${order})`, async () => {
      await setUp(order);
      const innerB = getAllEntities().find((e) => e.name === 'B' && e.parentId === idOfGuid(ROOT2))!.id;
      writeTraitFieldWithUndo(innerB, meta('Transform'), 'x', 7);
      await applyToPrefabSelective(idOfGuid(ROOT2), new Set([`${gB}.Transform.x`]));
      const outerB = getAllEntities().find((e) => e.name === 'B' && e.parentId === idOfGuid(ROOT))!.id;
      expect((readTraitData(outerB, meta('Transform')) as { x: number }).x).toBe(7);
      expect(getAllEntities().filter((e) => e.name === 'D')).toHaveLength(1);   // the unapplied addition stays
      expect(await noneRemoved()).toBe(false);
    });
  }
});


describe('a carried instance whose NESTED frame was built from another version of its template (#1493)', () => {
  // The nested capture (a save's `captureNestedChannels`, a rebuild's nested re-apply) reads the CACHED child
  // document, so a nested frame built from other rows must be current before anything captures it. The hot
  // reload's rebase now rebuilds such a frame by itself, from its own record.
  const written: unknown[] = [];
  beforeEach(() => {
    written.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') written.push(init.body);
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }));
  });
  afterAll(() => { vi.unstubAllGlobals(); });
  /** P with a distinct base x per member, so a member read against another's row shows a false override. */
  const valued = (ids: [number, number, number]) => {
    const t = template(ids);
    for (const [name, x] of [['A', 1], ['B', 2], ['C', 3]] as const) (t.entities.find((e) => e.name === name)!.traits.Transform as { x: number }).x = x;
    return t;
  };
  /** An O instance whose nested P frame carries two edits: C deleted, A moved to x=5. */
  const edited = async () => {
    install(valued([2, 3, 4]), outer());
    await load(scene(O));
    deleteEntitiesWithUndo([one('C').id]);
    writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
  };

  it('the reload`s rebase rebuilds it from the document it WAS built from — both edits stay on their members', async () => {
    await edited();
    install(valued([4, 2, 3]));                              // an external write renumbered P; O did not change
    expect(framesBuiltFromOtherRows(one('OR').id)).toEqual([P]);
    await adoptWorldReloadedFromDisk('/scenes/level.json', new Set());
    expect(framesBuiltFromOtherRows(one('OR').id)).toEqual([]);
    expect([count('A'), count('B'), count('C')]).toEqual([1, 1, 0]);
    expect([tf('A')?.x, tf('B')?.x]).toEqual([5, 2]);
  });

  it('…so the SAVE that follows writes each edit on its own member, and a reload from the new P agrees', async () => {
    // Before #1493 the save captured the nested frame against the cached rows: C's removal was keyed by the
    // nodeGuid of the member now holding C's old number (A), so the reload deleted A and brought C back.
    await edited();
    install(valued([4, 2, 3]));
    await adoptWorldReloadedFromDisk('/scenes/level.json', new Set());
    const entry = await entryOf();
    await load(scene(O, entry as never));
    expect([count('A'), count('B'), count('C')]).toEqual([1, 1, 0]);
    expect([tf('A')?.x, tf('B')?.x]).toEqual([5, 2]);
    expect(JSON.stringify(entry)).not.toMatch(/"x":2/);     // no false override pinned on B
  });

  it('a template whose VALUES changed is rebuilt too — the new base reaches every member the scene did not edit', async () => {
    await edited();
    const retuned = valued([2, 3, 4]);
    (retuned.entities.find((e) => e.name === 'B')!.traits.Transform as { x: number }).x = 9;
    install(retuned);
    expect(await rebaseStaleInstances()).toBe(1);
    expect([tf('A')?.x, tf('B')?.x, count('C')]).toEqual([5, 9, 0]);
  });

  it('Apply and Revert are no longer refused once it is rebuilt — the refusal`s "reload" now clears it', async () => {
    await edited();
    install(valued([4, 2, 3]));
    expect(staleInstanceRefusal(one('OR').id)).toMatch(/different version/);
    await adoptWorldReloadedFromDisk('/scenes/level.json', new Set());
    expect(staleInstanceRefusal(one('OR').id)).toBeNull();
    writeTraitFieldWithUndo(one('Slot').id, meta('Transform'), 'x', 3);
    const result = await applyToPrefabSelective(one('OR').id, new Set([`${gSlot}.Transform.x`]));
    expect(result.applied).toBe(true);
    expect([count('A'), count('C'), tf('A')?.x]).toEqual([1, 0, 5]);
  });

  it('when the OUTER template renumbered too, the nested frame is rebuilt first and both frames come back current', async () => {
    await edited();
    install(valued([4, 2, 3]));
    const o2 = outer();                                      // O renumbered as well: Slot 2→3, N 3→2
    o2.entities = [row(1, 'OR', 0, gOR), row(3, 'Slot', 1, gSlot), row(2, 'N', 3, gN, { prefab: P })];
    install(o2);
    expect(await rebaseStaleInstances()).toBe(2);
    expect(framesBuiltFromOtherRows(one('OR').id)).toEqual([]);
    expect([count('A'), count('B'), count('C')]).toEqual([1, 1, 0]);
    expect([tf('A')?.x, tf('B')?.x]).toEqual([5, 2]);
  });

  it('a Q frame moved to the scene ROOT (unlinked: a stored root now) and the nested P frame it left are both rebuilt', async () => {
    // P nests Q; both renumber. Reparenting QR out of the O instance to the Holder unlinks it (it becomes its own
    // stored root, and the save writes its row as removed), so the P frame no longer owns it: two independent
    // stale frames, each rebuilt from its own record.
    const Q = 'cccccccc-0000-4000-8000-000000000b03';
    const q = (ids: [number, number]) => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [
      row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000000b21'),
      row(ids[0], 'QX', 1, 'eeeeeeee-0000-4000-8000-000000000b22'), row(ids[1], 'QY', 1, 'eeeeeeee-0000-4000-8000-000000000b23'),
    ] });
    const withQ = (ids: [number, number, number]) => {
      const t = valued(ids);
      t.entities.push(row(5, 'Qrow', 1, 'eeeeeeee-0000-4000-8000-000000000b24', { prefab: Q }));
      return t;
    };
    install(q([2, 3]), withQ([2, 3, 4]), outer());
    await load(scene(O));
    writeTraitFieldWithUndo(one('QX').id, meta('Transform'), 'x', 8);
    reparentEntity(one('QR').id, one('Holder').id);
    install(q([3, 2]), withQ([4, 2, 3]));
    expect(framesBuiltFromOtherRows(one('OR').id)).toEqual([P]);
    expect(framesBuiltFromOtherRows(one('QR').id)).toEqual([Q]);   // the premise: the moved-out frame is stale too
    await rebaseStaleInstances();
    expect([count('QR'), count('QX'), count('QY'), count('A')]).toEqual([1, 1, 1, 1]);
    expect(parentName('QR')).toBe('Holder');
    expect([tf('QX')?.x, tf('QY')?.x]).toEqual([8, 0]);
    expect(framesBuiltFromOtherRows(one('OR').id)).toEqual([]);
    expect(framesBuiltFromOtherRows(one('QR').id)).toEqual([]);
  });

  describe('a frame MOVED within its instance is rebuilt with what it carries (#1499 — #1493 left it stale)', () => {
    // O = OR → Slot → N(P); P nests Q at row 5. QR is moved under OR and stays OWNED by the P frame (its row
    // writes `parent: OR`). Rebuilding the P frame alone destroyed the moved Q frame and its edit; rebuilding
    // QR alone unlinked it from its row (review of d8de97f8f), so #1493 skipped both. #1499 fixed the rebuild
    // (capture from the teardown's set; carry `ownerGuid`), and the rebase rebuilds them.
    const Q = 'cccccccc-0000-4000-8000-000000000b03';
    const q = (ids: [number, number]) => ({ id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [
      row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000000b21'),
      row(ids[0], 'QX', 1, 'eeeeeeee-0000-4000-8000-000000000b22'), row(ids[1], 'QY', 1, 'eeeeeeee-0000-4000-8000-000000000b23'),
    ] });
    const withQ = (bumpRoot = false) => {
      const t = template();
      t.entities.push(row(5, 'Qrow', 1, 'eeeeeeee-0000-4000-8000-000000000b24', { prefab: Q }));
      if (bumpRoot) (t.entities[0]!.traits.Transform as { y: number }).y = 1;   // a values-only change
      return t;
    };
    const setUp = async () => {
      install(q([2, 3]), withQ(), outer());
      await load(scene(O));
      writeTraitFieldWithUndo(one('QX').id, meta('Transform'), 'x', 8);
      reparentEntity(one('QR').id, one('OR').id);
    };
    const qLinked = (entry: SceneEntityEntry) => !JSON.stringify(entry).includes('"removed":true');

    it('the P frame that OWNS the moved Q frame: rebuilt, and the Q edit survives it, a save and a reload', async () => {
      await setUp();
      install(withQ(true));
      expect(await rebaseStaleInstances()).toBe(1);
      expect((tf('R') as { y?: number } | undefined)?.y).toBe(1); // the P frame really was rebuilt
      expect([tf('QX')?.x, parentName('QR')]).toEqual([8, 'OR']);
      const entry = await entryOf();
      await load(scene(O, entry as never));
      expect([count('QX'), tf('QX')?.x, parentName('QR')]).toEqual([1, 8, 'OR']);
    });

    it('the moved Q frame itself: rebuilt alone, and the save keeps it linked to its row', async () => {
      await setUp();
      install(q([3, 2]));
      expect(await rebaseStaleInstances()).toBe(1);
      expect(framesBuiltFromOtherRows(one('OR').id)).toEqual([]);   // current: Apply/Revert no longer refused
      expect([tf('QX')?.x, parentName('QR')]).toEqual([8, 'OR']);
      const entry = await entryOf();
      expect(qLinked(entry)).toBe(true);
      await load(scene(O, entry as never));
      expect([count('QX'), tf('QX')?.x, parentName('QR')]).toEqual([1, 8, 'OR']);
    });

    it('a member moved WITHIN the stale frame`s own subtree does not stop the rebuild — the save stays right', async () => {
      // Review 2 of this close-out: a guard that skipped ANY moved member left this frame stale, and the save
      // then wrote C's deletion onto A's row (reload: A gone, C back).
      install(valued([2, 3, 4]), outer());
      await load(scene(O));
      deleteEntitiesWithUndo([one('C').id]);
      writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
      reparentEntity(one('B').id, one('A').id);
      install(valued([4, 2, 3]));
      expect(await rebaseStaleInstances()).toBe(1);
      const entry = await entryOf();
      await load(scene(O, entry as never));
      expect([count('A'), count('C'), tf('A')?.x, parentName('B')]).toEqual([1, 0, 5, 'A']);
    });

    for (const [qrTo, qxTo] of [['B', 'A'], ['A', 'A'], ['A', 'B']] as const) {
      it(`a nested root AND its member both moved within the frame (QR→${qrTo}, QX→${qxTo}): rebuilt once, no stray copy`, async () => {
        // Review 3 of this close-out: the teardown unparked in ONE pass, before its fixpoint, so a member parked
        // under another of our members whose frame joined the teardown later survived beside its respawned self —
        // its link stripped, and the save kept it as a plain node.
        await setUp();
        reparentEntity(one('QR').id, one(qrTo).id);
        reparentEntity(one('QX').id, one(qxTo).id);
        install(withQ(true));
        expect(await rebaseStaleInstances()).toBe(1);
        const state = () => [count('QR'), count('QX'), parentName('QR'), parentName('QX'), tf('QX')?.x, !!readTraitData(one('QX').id, meta('PrefabInstance'))];
        expect(state()).toEqual([1, 1, qrTo, qxTo, 8, true]);
        const entry = await entryOf();
        await load(scene(O, entry as never));
        expect(state()).toEqual([1, 1, qrTo, qxTo, 8, true]);
      });
    }

    // A USER-ADDED Q instance dropped inside O (a stored root) whose member QX is moved out of it, still inside O:
    // the rebuild of whatever owns QX reaches outside its own subtree. Review 2 of this close-out drove both.
    const W = 'cccccccc-0000-4000-8000-000000000b04';
    const ROOTQ = 'dddddddd-0000-4000-8000-000000000b03';
    const withQ2 = (): SceneData => ({ ...scene(O), entities: [...scene(O).entities,
      { id: 3, prefab: Q, guid: ROOTQ, traits: { EntityAttributes: { name: 'Root2', parentId: HOLDER } } }] } as unknown as SceneData);

    it('a STORED frame whose member was moved out is not rebuilt — its teardown would recycle a later entry`s id', async () => {
      // O = OR → Slot → Deep; Q = QR → QX → Prow(P). QR is dropped under Deep, QX moved to OR: QR sorts first,
      // and its rebuild destroyed QX and the P frame under it. The P entry then rebuilt that id, recycled onto
      // the new W root, as a P instance — a second A, and W gone.
      const deepO = { id: O, version: 5, name: 'O', rootLocalId: 1, entities: [row(1, 'OR', 0, gOR), row(2, 'Slot', 1, gSlot), row(3, 'Deep', 2, 'eeeeeeee-0000-4000-8000-000000000b08')] };
      const qDoc = (ids: [number, number, number], withW = false) => {
        const rows = [row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000000b21'), row(ids[0], 'QX', 1, 'eeeeeeee-0000-4000-8000-000000000b22'),
          row(ids[1], 'QY', 1, 'eeeeeeee-0000-4000-8000-000000000b23'), row(ids[2], 'Prow', ids[0], 'eeeeeeee-0000-4000-8000-000000000b24', { prefab: P })];
        if (withW) rows.splice(3, 0, row(9, 'Wrow', 1, 'eeeeeeee-0000-4000-8000-000000000b26', { prefab: W }));
        return { id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: rows };
      };
      const w = { id: W, version: 5, name: 'W', rootLocalId: 1, entities: [row(1, 'WR', 0, 'eeeeeeee-0000-4000-8000-000000000b31'), row(2, 'WX', 1, 'eeeeeeee-0000-4000-8000-000000000b32')] };
      install(valued([2, 3, 4]), qDoc([2, 3, 4]), deepO, w);
      await load(withQ2());
      reparentEntity(one('QR').id, one('Deep').id);
      writeTraitFieldWithUndo(one('A').id, meta('Transform'), 'x', 5);
      reparentEntity(one('QX').id, one('OR').id);
      install(qDoc([3, 2, 4], true), valued([4, 2, 3]));
      await rebaseStaleInstances();
      expect([count('QR'), count('QX'), count('R'), count('A'), parentName('QX'), tf('A')?.x]).toEqual([1, 1, 1, 1, 'OR', 5]);
    });

    it('an OWNED frame holding that node is not rebuilt — its teardown would reach a stale frame under the moved member', async () => {
      // O = OR → Slot → Deep → N(P); Q = QR → QX → Wrow(W). QR dropped under A (inside the nested P frame), QX
      // moved to OR. N's rebuild tore down QX with the W frame under it and re-expanded W against the cached,
      // renumbered rows: WX's edit landed on WY, and the frame then read as current.
      const deepO = { id: O, version: 5, name: 'O', rootLocalId: 1, entities: [row(1, 'OR', 0, gOR), row(2, 'Slot', 1, gSlot), row(3, 'Deep', 2, 'eeeeeeee-0000-4000-8000-000000000b08'), row(4, 'N', 3, gN, { prefab: P })] };
      const w = (ids: [number, number]) => ({ id: W, version: 5, name: 'W', rootLocalId: 1, entities: [row(1, 'WR', 0, 'eeeeeeee-0000-4000-8000-000000000b31'), row(ids[0], 'WX', 1, 'eeeeeeee-0000-4000-8000-000000000b32'), row(ids[1], 'WY', 1, 'eeeeeeee-0000-4000-8000-000000000b33')] });
      const qDoc = { id: Q, version: 5, name: 'Q', rootLocalId: 1, entities: [
        row(1, 'QR', 0, 'eeeeeeee-0000-4000-8000-000000000b21'), row(2, 'QX', 1, 'eeeeeeee-0000-4000-8000-000000000b22'),
        row(3, 'QY', 1, 'eeeeeeee-0000-4000-8000-000000000b23'), row(4, 'Wrow', 2, 'eeeeeeee-0000-4000-8000-000000000b26', { prefab: W }),
      ] };
      install(valued([2, 3, 4]), qDoc, w([2, 3]), deepO);
      await load(withQ2());
      reparentEntity(one('QR').id, one('A').id);
      writeTraitFieldWithUndo(one('WX').id, meta('Transform'), 'x', 8);
      reparentEntity(one('QX').id, one('OR').id);
      install(valued([4, 2, 3]), w([3, 2]));
      await rebaseStaleInstances();
      expect([count('WX'), count('WY'), tf('WX')?.x, tf('WY')?.x, parentName('QX')]).toEqual([1, 1, 8, 0, 'OR']);
    });
  });
});
