/** #1468 Phase 2A — a prefab row carries a MINTED node identity (`PrefabEntity.nodeGuid`, v5).
 *
 *  The defect it closes is not that `localId` moves — it is that a freed `localId` is REUSED.
 *  `planPrefabRows` allocates above the max over SURVIVING members, so deleting the top-numbered
 *  member hands its number to a different node on the next save, and every stored key naming it
 *  silently REPOINTS at the wrong member — the cost `serializePrefab`'s `preserveLocalIds` docblock
 *  spells out. A dangling key can be noticed; a repointed one cannot. A minted guid is never recycled, so it can only ever dangle.
 *
 *  Every assertion here is against what the real serializer and the real tagger produce. The
 *  renumbering case is driven by actually deleting a member and re-saving, not by handing
 *  `serializePrefab` a contrived preserve map — the carry has to work through the path that
 *  forgets, which is the whole complaint (§ 3.4: four of five callers pass no preserve map). */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction } from '@modoki/engine/editor';
import {
  setPrefabCache, serializePrefab, tagEntityTreeAsInstance, PREFAB_FORMAT_VERSION, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const HOLDER = 'ffffffff-0000-4000-8000-000000000001';
const ROOT = 'ffffffff-0000-4000-8000-000000000002';
const PANEL = 'ffffffff-0000-4000-8000-000000000003';
const LABEL = 'ffffffff-0000-4000-8000-000000000004';
const BADGE = 'ffffffff-0000-4000-8000-000000000005';
const PREFAB = 'ffffffff-0000-4000-8000-00000000000f';
const OTHER = 'ffffffff-0000-4000-8000-00000000001f';

const ent = (id: number, name: string, parentId: number | string, guid: string) => ({
  id, traits: { EntityAttributes: { name, parentId, guid }, Transform: { x: 0, y: 0, z: 0 } },
});

/** Root with three FLAT children, so deleting the first one frees its number without taking any
 *  other member with it — and `planPrefabRows`' positional branch then hands that number to the
 *  next survivor. A nested child would cascade and prove nothing about reuse. */
const scene = (): SceneData => ({
  id: 'node-identity', version: 1, name: 'N', resources: [],
  entities: [
    ent(1, 'Holder', 0, HOLDER),
    ent(2, 'Root', HOLDER, ROOT),
    ent(3, 'Panel', ROOT, PANEL),
    ent(4, 'Label', ROOT, LABEL),
    ent(5, 'Badge', ROOT, BADGE),
  ],
} as unknown as SceneData);

async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id: number) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, _rg, _f, nestedStructure) =>
      instantiatePrefabIntoWorld(
        getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source,
        overrides, structure, undefined, nested, nestedStructure,
      ) ?? undefined,
  });
}

const idOf = (name: string): number => getAllEntities().find((e) => e.name === name)!.id;
const rowOf = (f: PrefabFile, name: string) => f.entities.find((e) => e.name === name)!;
const piOf = (name: string): Record<string, unknown> => {
  const meta = getTraitByName('PrefabInstance')!;
  const e = [...getCurrentWorld().entities].find((x) => x.id() === idOf(name))!;
  return e.get(meta.trait) as Record<string, unknown>;
};

/** Create Prefab, exactly as both production callers do it: serialize, cache, then tag. */
function createPrefabFrom(rootName: string, target = PREFAB): PrefabFile {
  const rootId = idOf(rootName);
  const file = serializePrefab(rootId, target)!;
  prefabs.set(target, file);
  setPrefabCache(target, file as never);
  tagEntityTreeAsInstance(rootId, target, file);
  return file;
}

beforeEach(() => { setRunMode('stopped'); prefabs.clear(); });
afterAll(() => { getCurrentWorld()?.destroy(); });

describe('a prefab row carries a minted node identity (#1468)', () => {
  it('gives every row a distinct guid and stamps the file at the current version', async () => {
    await load(scene());
    const file = serializePrefab(idOf('Root'), PREFAB)!;
    expect(file.version).toBe(PREFAB_FORMAT_VERSION);
    const guids = file.entities.map((e) => e.nodeGuid);
    expect(guids.every((g) => typeof g === 'string' && /^[0-9a-f-]{36}$/.test(g!))).toBe(true);
    expect(new Set(guids).size).toBe(file.entities.length);
  });

  it('is not the row name, the localId or the entity guid in disguise', async () => {
    // Two serializations of the SAME tree mint different identities, because neither call has a
    // document to carry one from. That is the minting rule stated as an observation: identity is
    // assigned at a write, never derived from content — a derived one would be positional again.
    await load(scene());
    const a = serializePrefab(idOf('Root'), PREFAB)!;
    const b = serializePrefab(idOf('Root'), PREFAB)!;
    expect(rowOf(a, 'Panel').nodeGuid).not.toBe(rowOf(b, 'Panel').nodeGuid);
    // …and it is nothing the file already held.
    expect(JSON.stringify(a.entities.map((e) => e.nodeGuid))).not.toContain(PANEL);
  });

  it('stamps the live tree with the identity the written file gave each row', async () => {
    await load(scene());
    const file = createPrefabFrom('Root');
    expect(piOf('Panel').nodeGuid).toBe(rowOf(file, 'Panel').nodeGuid);
    expect(piOf('Badge').nodeGuid).toBe(rowOf(file, 'Badge').nodeGuid);
    expect(piOf('Root').nodeGuid).toBe(rowOf(file, 'Root').nodeGuid);
  });

  it('carries identity through the re-save that RENUMBERS — the case localId cannot survive', async () => {
    await load(scene());
    const first = createPrefabFrom('Root');
    const panelLocalId = rowOf(first, 'Panel').localId;
    const labelGuid = rowOf(first, 'Label').nodeGuid;
    const badgeGuid = rowOf(first, 'Badge').nodeGuid;
    expect(rowOf(first, 'Label').localId).not.toBe(panelLocalId); // fixture: they start apart

    // Delete a member, then re-save over the same file — Create-Prefab-Replace, the agent's
    // `create` over an existing path, Skin Editor's "Update prefab". None of them passes a preserve
    // map, which is exactly why the carry must not depend on one.
    const world = getCurrentWorld();
    const panel = [...world.entities].find((e) => e.id() === idOf('Panel'))!;
    destroyEntity(panel, world);
    const second = serializePrefab(idOf('Root'), PREFAB)!;

    // The freed number really is handed to a DIFFERENT node — measured, not assumed, and asserted
    // without naming which survivor gets it, because that follows world iteration order and this
    // test is not about that. Every scene key written against `panelLocalId` now names that node
    // instead: silently, plausibly, and with nothing to report it.
    const inherited = second.entities.find((e) => e.localId === panelLocalId)!;
    expect(inherited).toBeDefined();
    expect(inherited.name).not.toBe('Panel');
    // …and identity does not move with the number. Every surviving row still answers to the guid
    // the first save gave it, the one it inherited a localId from included.
    for (const row of second.entities) expect(row.nodeGuid).toBe(rowOf(first, row.name).nodeGuid);
    expect(rowOf(second, 'Label').nodeGuid).toBe(labelGuid);
    expect(rowOf(second, 'Badge').nodeGuid).toBe(badgeGuid);
  });

  it('refuses identity from a member of a DIFFERENT prefab, which holds it in another frame', async () => {
    await load(scene());
    const other = createPrefabFrom('Root', OTHER);
    // The live tree is now an instance of OTHER. Saving it as PREFAB must not copy OTHER's node
    // identities into a second document: two files would then name one node, and a scene row keyed
    // on it could not say which frame it meant.
    const mine = serializePrefab(idOf('Root'), PREFAB)!;
    const theirs = new Set(other.entities.map((e) => e.nodeGuid));
    for (const row of mine.entities) expect(theirs.has(row.nodeGuid)).toBe(false);
  });

  it('hands each spawned member the identity its row carries, on a real instantiate', async () => {
    // The other half of the round trip: the tagger stamps a tree the editor just made a prefab OF,
    // and this stamps a tree expanded FROM one. Without it a member has no identity until something
    // saves the prefab again, so the carry in `nodeGuidsFor` would have nothing to read.
    await load(scene());
    const file = serializePrefab(idOf('Root'), PREFAB)!;
    prefabs.set(PREFAB, file);
    setPrefabCache(PREFAB, file as never);
    await load({
      id: 's', version: 1, name: 'S', resources: [],
      entities: [{ id: 1, prefab: PREFAB, guid: ROOT, traits: { EntityAttributes: { name: 'Root', parentId: 0 } } }],
    } as unknown as SceneData);
    expect(piOf('Label').nodeGuid).toBe(rowOf(file, 'Label').nodeGuid);
    expect(piOf('Badge').nodeGuid).toBe(rowOf(file, 'Badge').nodeGuid);
    expect(piOf('Label').nodeGuid).not.toBe(piOf('Badge').nodeGuid);
  });

  it('mints for the rows of a pre-v5 document, which has no identity to keep', async () => {
    // How a file migrates: on the next SAVE, never on a load (plan § 4 Phase 5). The fixture is a
    // v4 document — rows with a localId and no nodeGuid — instantiated and then saved back.
    const v4: PrefabFile = {
      id: PREFAB, version: 4, name: 'Old', rootLocalId: 1,
      entities: [
        { localId: 1, name: 'Old', traits: { EntityAttributes: { name: 'Old', parentId: 0, guid: '' } } },
        { localId: 2, name: 'Leaf', traits: { EntityAttributes: { name: 'Leaf', parentId: 1, guid: '' } } },
      ],
    };
    prefabs.set(PREFAB, v4);
    setPrefabCache(PREFAB, v4 as never);
    await load({
      id: 's', version: 1, name: 'S', resources: [],
      entities: [{ id: 1, prefab: PREFAB, guid: ROOT, traits: { EntityAttributes: { name: 'Old', parentId: 0 } } }],
    } as unknown as SceneData);
    expect(piOf('Leaf').nodeGuid).toBe('');          // nothing invented at load
    const saved = serializePrefab(idOf('Old'), PREFAB)!;
    expect(saved.version).toBe(PREFAB_FORMAT_VERSION);
    expect(rowOf(saved, 'Leaf').nodeGuid).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('a NESTED REFERENCE ROW carries its identity too (#1468 Phase 2B)', () => {
  // The hole Phase 2A left on purpose. A nested row's live entity is the CHILD instance's root,
  // whose `nodeGuid` is its identity in the CHILD document — so the outer document had nothing to
  // carry and minted a fresh identity for that row on every re-save, dangling every scene key
  // naming anything inside the expansion. `PrefabInstance.parentNodeGuid` is what it reads now.
  const CHILD = 'ffffffff-0000-4000-8000-00000000002f';
  const OUTER = 'ffffffff-0000-4000-8000-00000000003f';

  /** Root → [Panel, Label, Badge (an instance of CHILD)], saved as OUTER and tagged.
   *
   *  ⚠️ The nested instance is the LAST child on purpose. `planPrefabRows`' positional branch
   *  numbers by tree order, so only a member deleted BEFORE it shifts its localId — make it the
   *  first child and the renumber case below passes while renumbering nothing. */
  async function outerWithNestedRow(): Promise<PrefabFile> {
    await load(scene());
    createPrefabFrom('Badge', CHILD);     // Badge becomes a stored root of its own prefab
    return createPrefabFrom('Root', OUTER); // …which planPrefabRows then writes as a reference row
  }
  const nestedRow = (f: PrefabFile) => f.entities.find((e) => e.prefab === CHILD)!;

  it('writes the nested instance as a reference row and stamps the outer row identity on it', async () => {
    const outer = await outerWithNestedRow();
    const row = nestedRow(outer);
    expect(row.nodeGuid).toMatch(/^[0-9a-f-]{36}$/);
    // The stamp is `parentNodeGuid`, NOT `nodeGuid`: the live root keeps answering for the CHILD
    // frame, and the outer row's identity rides beside `parentLocalId` exactly as it does.
    expect(piOf('Badge').parentNodeGuid).toBe(row.nodeGuid);
    expect(piOf('Badge').parentLocalId).toBe(row.localId);
  });

  it('keeps that identity across a re-save that renumbers, with no preserve map', async () => {
    const first = await outerWithNestedRow();
    const before = nestedRow(first).nodeGuid;
    const rowLocalId = nestedRow(first).localId;

    // Delete an EARLIER member so the positional branch renumbers the nested row, then re-save over
    // the same file — the four callers that pass no preserve map (§ 3.4).
    const world = getCurrentWorld();
    const panel = [...world.entities].find((e) => e.id() === idOf('Panel'))!;
    destroyEntity(panel, world);
    const second = serializePrefab(idOf('Root'), OUTER)!;

    expect(nestedRow(second).nodeGuid).toBe(before);
    // The renumber really happened, so the carry is not passing for lack of a change to survive.
    expect(nestedRow(second).localId).not.toBe(rowLocalId);
  });

  it('does not copy the CHILD document`s own identity into the outer row', async () => {
    await outerWithNestedRow();
    // ⚠️ Asserted on the RE-save, not the first one. The first save of OUTER happens while the tree
    // is not yet an instance of OUTER, so the tree gate is closed and NOTHING carries — a version of
    // this test that read the first file passed while the mechanism it names was inert (found by
    // mutating the carry to `pi.nodeGuid`: this test stayed green and a different one went red).
    const outer = serializePrefab(idOf('Root'), OUTER)!;
    // Two documents naming one node is the failure the `source === existingId` gate exists to stop,
    // and a nested row is the one place where the obvious carry (`pi.nodeGuid`) would cause it.
    const child = prefabs.get(CHILD) as PrefabFile;
    const theirs = new Set(child.entities.map((e) => e.nodeGuid));
    expect(theirs.size).toBeGreaterThan(0);            // the child really has identities to steal
    expect(theirs.has(nestedRow(outer).nodeGuid)).toBe(false);
    expect(piOf('Badge').nodeGuid).not.toBe(nestedRow(outer).nodeGuid);
  });

  it('refuses to carry when the live tree is an instance of some OTHER document', async () => {
    // The gate is asked of the TREE, because a nested root`s own `source` names the child prefab and
    // can never equal `existingId`. Saving this tree as a THIRD prefab must mint: the nested row`s
    // `parentNodeGuid` is an identity in OUTER`s frame, and copying it would name one node twice.
    const outer = await outerWithNestedRow();
    const third = serializePrefab(idOf('Root'), PREFAB)!;
    expect(nestedRow(third).nodeGuid).not.toBe(nestedRow(outer).nodeGuid);
  });
});
