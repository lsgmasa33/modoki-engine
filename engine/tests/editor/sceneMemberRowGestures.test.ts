/** #1468 Phase 2B — the GESTURES, one test each (#1468 Phase 2B's list of ten).
 *
 *  A member's guid is stored in the scene now, so every gesture that rebuilds, copies or respawns an
 *  instance has to be asked what it does to that identity. Each test names its gesture and the
 *  mechanism it drives; the save→load round trip and the reconciliation rules live next door in
 *  `sceneMemberRows.test.ts`.
 *
 *  ⚠️ Where a gesture CANNOT lose identity for a structural reason, the test says which reason and
 *  asserts it — not the absence of a symptom. A test that only checks "the guid is still there"
 *  passes on a build where the gesture never ran. */

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
import { setActionCallback, pushAction } from '@modoki/engine/editor';
import {
  setPrefabCache, serializePrefab, tagEntityTreeAsInstance, type PrefabFile,
} from '../../packages/modoki/src/editor/scene/prefab';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const HOLDER = 'ffffffff-0000-4000-8000-000000000001';
const ROOT = 'ffffffff-0000-4000-8000-000000000002';
const PREFAB = 'ffffffff-0000-4000-8000-00000000000f';

const ent = (id: number, name: string, parentId: number | string, guid: string) => ({
  id, traits: { EntityAttributes: { name, parentId, guid }, Transform: { x: 0, y: 0, z: 0 } },
});

/** Root with three FLAT children — flat so deleting the FIRST one renumbers the other two without
 *  taking either with it, which is what makes derivation give a different answer. */
const authored = (): SceneData => ({
  id: 'member-rows', version: 1, name: 'M', resources: [],
  entities: [
    ent(1, 'Holder', 0, HOLDER),
    ent(2, 'Root', HOLDER, ROOT),
    ent(3, 'Panel', ROOT, 'ffffffff-0000-4000-8000-000000000003'),
    ent(4, 'Label', ROOT, 'ffffffff-0000-4000-8000-000000000004'),
    ent(5, 'Badge', ROOT, 'ffffffff-0000-4000-8000-000000000005'),
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
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure) => {
      const id = instantiatePrefabIntoWorld(
        getCurrentWorld(), prefabs.get(source) as never, parentId, rootTf, source,
        overrides, structure, undefined, nested, nestedStructure,
      );
      if (id && rootGuid) {
        const eaMeta = getTraitByName('EntityAttributes')!;
        for (const e of getCurrentWorld().entities) {
          if (e.id() !== id) continue;
          e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), guid: rootGuid });
        }
      }
      return id ?? undefined;
    },
  });
}

const idOf = (name: string): number => getAllEntities().find((e) => e.name === name)!.id;
const guidOf = (name: string): string =>
  (readTraitData(idOf(name), getTraitByName('EntityAttributes')!) as { guid?: string }).guid ?? '';
const rowOf = (f: PrefabFile, name: string) => f.entities.find((e) => e.name === name)!;
const instanceEntry = (scene: { entities: unknown[] }): SceneEntityEntry =>
  (scene.entities as SceneEntityEntry[]).find((e) => !!e.prefab)!;

/** A v5 template of Root's subtree, cached and tagged onto the live tree. */
function makeTemplate(): PrefabFile {
  const file = serializePrefab(idOf('Root'), PREFAB)!;
  prefabs.set(PREFAB, file);
  setPrefabCache(PREFAB, file as never);
  tagEntityTreeAsInstance(idOf('Root'), PREFAB, file);
  return file;
}

/** A scene holding one instance of PREFAB, as `serializeScene` writes it (so it carries the rows). */
async function placedInstance(): Promise<{ template: PrefabFile; scene: { entities: unknown[] } }> {
  await load(authored());
  const template = makeTemplate();
  await load({
    id: 's', version: 1, name: 'S', resources: [],
    entities: [{ id: 1, prefab: PREFAB, guid: ROOT, traits: { EntityAttributes: { name: 'Root', parentId: 0 } } }],
  } as unknown as SceneData);
  const scene = await serializeScene() as unknown as { entities: unknown[] };
  return { template, scene };
}

/** Re-save the template from the live instance with `name` deleted — the renumbering re-save. */
function templateWithout(name: string): PrefabFile {
  const world = getCurrentWorld();
  const doomed = [...world.entities].find((e) => e.id() === idOf(name))!;
  destroyEntity(doomed, world);
  const file = serializePrefab(idOf('Root'), PREFAB)!;
  prefabs.set(PREFAB, file);
  setPrefabCache(PREFAB, file as never);
  return file;
}

beforeEach(() => { setRunMode('stopped'); prefabs.clear(); clearKeptMemberOrphans(); });
afterAll(() => { getCurrentWorld()?.destroy(); });

describe('gesture: REFRESH (rebuildInstance) — the instance re-expands from a changed template', () => {
  it('keeps every member`s identity across the rebuild instead of re-deriving it', async () => {
    // The gesture #1468 exists for (#1468 design record, the root cause): an artist changes the prefab, the designer refreshes,
    // and the members must not be re-identified. A rebuild destroys them and expands fresh ones,
    // which take DERIVED guids — so the identity has to be carried across explicitly.
    //
    // ⚠️ The carry reads the rows off the LIVE tree, not off the scene file, so it preserves whatever
    // the instance is holding — a guid a row pinned at load, or one derivation produced. That makes
    // Refresh identity-preserving for any v5 template, which is strictly more than the rows alone
    // buy. It also means there is no way to switch it off from the scene input: the control here is
    // the WRONG ANSWER, and the mechanism is pinned by mutation.
    const { scene } = await placedInstance();
    await load(scene as unknown as SceneData);
    const badgeGuid = guidOf('Badge');
    const labelGuid = guidOf('Label');
    const panelsGuid = guidOf('Panel');

    // The template loses its first child, so Badge inherits Panel's localId — and a rebuild that
    // re-derived would hand Badge the guid PANEL used to answer to.
    const second = templateWithout('Panel');
    const { rebuildInstance } = await import('../../packages/modoki/src/editor/scene/prefab');
    rebuildInstance(idOf('Root'), PREFAB, second, {}, {});

    expect(guidOf('Badge')).toBe(badgeGuid);
    expect(guidOf('Badge')).not.toBe(panelsGuid);   // …and specifically not the repointed one
    expect(guidOf('Label')).toBe(labelGuid);
    // …and it is still resolvable by guid, which is how the rest of the rebuild (and every external
    // ref) reaches it. ⚠️ Holds via `findEntityByGuid`'s self-healing rescan even if the carry forgot
    // to re-index, so read this as a property and not as a test of the indexing.
    const { findEntityByGuid } = await import('@modoki/engine/runtime');
    expect(findEntityByGuid(badgeGuid)?.id()).toBe(idOf('Badge'));
  });

  it('writes the carried identity back into the rows on the next save', async () => {
    // The other half: carrying it live is only worth anything if the save records it, or the NEXT
    // load re-derives and the refresh's work is undone one reload later.
    const { template, scene } = await placedInstance();
    await load(scene as unknown as SceneData);
    const badgeGuid = guidOf('Badge');
    const badgeNode = rowOf(template, 'Badge').nodeGuid!;
    const second = templateWithout('Panel');
    const { rebuildInstance } = await import('../../packages/modoki/src/editor/scene/prefab');
    rebuildInstance(idOf('Root'), PREFAB, second, {}, {});

    const resaved = await serializeScene() as unknown as { entities: unknown[] };
    expect(instanceEntry(resaved).members![`/${badgeNode}`]?.guid).toBe(badgeGuid);
  });
});

describe('gesture: DUPLICATE / PASTE — the copy must not share identity with the original', () => {
  it('gives the copy`s members fresh guids and fresh rows (D3/R6, live side)', async () => {
    // The live twin of the scene-file duplicate (`remintSceneEntityGuids`). Two entities answering to
    // one guid is #1293, and with rows the collision would be written down rather than re-derived
    // away on the next load — so it has to be right here, not merely absent from the file.
    const { template, scene } = await placedInstance();
    await load(scene as unknown as SceneData);
    const originalBadge = guidOf('Badge');
    const badgeNode = rowOf(template, 'Badge').nodeGuid!;

    const { duplicateEntity } = await import('../../packages/modoki/src/editor/undo/entityActions');
    const copyId = duplicateEntity(idOf('Root'), () => {});
    expect(copyId).toBeTruthy();

    const saved = await serializeScene() as unknown as { entities: SceneEntityEntry[] };
    const instances = saved.entities.filter((e) => !!e.prefab);
    expect(instances.length).toBe(2);
    const guids = instances.map((e) => e.members![`/${badgeNode}`]?.guid);
    // Same key — both copies instantiate the same template node — and DIFFERENT guids.
    expect(guids[0]).toBeTruthy();
    expect(guids[1]).toBeTruthy();
    expect(guids[0]).not.toBe(guids[1]);
    expect(guids).toContain(originalBadge);
  });
});

describe('gesture: DETACH — the members stop being members', () => {
  it('leaves them as plain entities keeping their guids, and writes no rows for them', async () => {
    // A detached member is not a member, so it has no row — and it keeps its guid, which is what
    // makes every reference into the former instance survive the detach.
    const { scene } = await placedInstance();
    await load(scene as unknown as SceneData);
    const badgeGuid = guidOf('Badge');

    const { detachPrefabInstance } = await import('../../packages/modoki/src/editor/scene/prefab');
    detachPrefabInstance(idOf('Root'), { strip: true });

    expect(guidOf('Badge')).toBe(badgeGuid);
    const saved = await serializeScene() as unknown as { entities: SceneEntityEntry[] };
    expect(saved.entities.some((e) => !!e.prefab)).toBe(false);          // no instance left
    expect(saved.entities.every((e) => e.members === undefined)).toBe(true);
    // …and the guid is written on the plain entity instead, which is where it now belongs.
    expect(JSON.stringify(saved)).toContain(badgeGuid);
  });
});

describe('gesture: DELETE THE OWNER — the rows go with the instance', () => {
  it('writes no orphaned members map once the instance root is gone', async () => {
    const { scene } = await placedInstance();
    await load(scene as unknown as SceneData);
    const world = getCurrentWorld();
    const root = [...world.entities].find((e) => e.id() === idOf('Root'))!;
    destroyEntity(root, world);

    const saved = await serializeScene() as unknown as { entities: SceneEntityEntry[] };
    expect(saved.entities.some((e) => !!e.prefab)).toBe(false);
    expect(saved.entities.every((e) => e.members === undefined)).toBe(true);
  });
});

describe('gesture: UNDO / REDO RESPAWN — delete an instance, put it back', () => {
  it('respawns every member under the guid it had, so the rows still name them', async () => {
    // `respawnFromSnapshot` rebuilds the subtree from a snapshot taken before the delete. The
    // members' guids come from that snapshot rather than from a fresh derive, which is what lets the
    // scene's rows still name them — and what makes undo of a delete identity-preserving.
    const { template, scene } = await placedInstance();
    await load(scene as unknown as SceneData);
    const badgeGuid = guidOf('Badge');
    const badgeNode = rowOf(template, 'Badge').nodeGuid!;
    const parentId = 0;

    const { snapshotEntity, respawnFromSnapshot } = await import('../../packages/modoki/src/editor/undo/entityActions');
    const snapshot = snapshotEntity(idOf('Root'))!;
    const world = getCurrentWorld();
    const root = [...world.entities].find((e) => e.id() === idOf('Root'))!;
    destroyEntity(root, world);
    respawnFromSnapshot(snapshot, parentId);

    expect(guidOf('Badge')).toBe(badgeGuid);
    const saved = await serializeScene() as unknown as { entities: unknown[] };
    expect(instanceEntry(saved).members![`/${badgeNode}`]?.guid).toBe(badgeGuid);
  });

  it('gives a DUPLICATE`s respawn fresh guids — the same primitive, the opposite requirement', async () => {
    // `regenerateSnapshotGuids` is what separates the two uses of one snapshot: undo must reproduce
    // identity, a duplicate must not. Both go through `respawnFromSnapshot`, so the distinction lives
    // entirely in whether the snapshot was regenerated — worth pinning, because a future caller
    // reaching for the wrong one produces #1293 with no error.
    const { template, scene } = await placedInstance();
    await load(scene as unknown as SceneData);
    const badgeGuid = guidOf('Badge');
    const badgeNode = rowOf(template, 'Badge').nodeGuid!;

    const { snapshotEntity, respawnFromSnapshot, regenerateSnapshotGuids } = await import('../../packages/modoki/src/editor/undo/entityActions');
    const fresh = regenerateSnapshotGuids(snapshotEntity(idOf('Root'))!);
    respawnFromSnapshot(fresh, 0);

    const saved = await serializeScene() as unknown as { entities: SceneEntityEntry[] };
    const guids = saved.entities.filter((e) => !!e.prefab).map((e) => e.members?.[`/${badgeNode}`]?.guid);
    expect(guids.length).toBe(2);
    expect(guids[0]).not.toBe(guids[1]);
    expect(guids).toContain(badgeGuid);
  });
});

describe('gesture: RIGGED MODEL RE-IMPORT — the prefab is regenerated from the GLB', () => {
  // Rigged re-import is one of the five renumbering paths in the #1468 design record's root cause, and arguably the most load-bearing: a rigged prefab is
  // REGENERATED on every import, so `localId`s are only kept by a name match (`riggedEntityIdentity`)
  // and `alien-animal` already shows what a mass miss costs — 513 bones reallocated above the old max.
  //
  // What v16 changes is the blast radius, not the hit rate. A match carries the node guid, so every
  // scene row still names its member. A MISS mints a fresh identity, so the row DANGLES (R2: one
  // orphan, logged) instead of silently naming whichever node inherited the number.
  const ROOT_NODE = 'ffffffff-0000-4000-8000-00000000d001';
  const BONE_NODE = 'ffffffff-0000-4000-8000-00000000d002';
  const FRESH_NODE = 'ffffffff-0000-4000-8000-00000000d003';
  /** ⚠️ BOTH sides carry node guids, because both documents have them in production: the fresh side
   *  is `serializePrefab(rootId, existingId)` (`ModelAssetView`), which mints for every row it cannot
   *  carry. `mergeRiggedPrefab` only decides WHICH identity survives — it is not a minting site, and
   *  a fixture whose fresh side had none tests a document the importer cannot produce. */
  const rigged = (boneName: string, boneNode: string): PrefabFile => ({
    id: PREFAB, version: 5, name: 'Rig', rootLocalId: 1,
    entities: [
      { localId: 1, nodeGuid: ROOT_NODE, name: 'Rig', traits: { EntityAttributes: { name: 'Rig', parentId: 0, guid: '' } } },
      { localId: 2, nodeGuid: boneNode, name: boneName, traits: { EntityAttributes: { name: boneName, parentId: 1, guid: '' }, Bone: { name: boneName } } },
    ],
  });

  it('carries the node guid through a re-import that MATCHES, so the scene rows still name the member', async () => {
    const { mergeRiggedPrefab } = await import('../../packages/modoki/src/editor/scene/prefab');
    // The regenerated side comes from the GLB and carries no modoki identity — that is the honest
    // limit the #1468 design record states (nothing survives a DCC rename). The merge is what puts it back, matched by bone NAME.
    const merged = mergeRiggedPrefab(rigged('Spine', FRESH_NODE), rigged('Spine', BONE_NODE));
    expect(merged.entities.find((e) => e.name === 'Spine')!.nodeGuid).toBe(BONE_NODE);
  });

  it('lets the FRESH identity stand on a rename, so the row dangles rather than naming another node', async () => {
    const { mergeRiggedPrefab } = await import('../../packages/modoki/src/editor/scene/prefab');
    // An artist renames a bone. Neither part of the design survives that and nothing can (#1468 design record, the node guid) —
    // the containment is that the renamed node keeps the identity the fresh import minted for it, so
    // the old row matches nothing instead of naming whichever node inherited the localId.
    const merged = mergeRiggedPrefab(rigged('Spine_01', FRESH_NODE), rigged('Spine', BONE_NODE));
    const bone = merged.entities.find((e) => e.name === 'Spine_01')!;
    expect(bone.nodeGuid).toBeTruthy();
    expect(bone.nodeGuid).not.toBe(BONE_NODE);

    // …and the scene's row for the old node orphans, loudly, rather than re-pointing onto the
    // renamed bone — which is what a localId-keyed row would have done.
    prefabs.set(PREFAB, merged);
    setPrefabCache(PREFAB, merged as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await load({
      id: 's', version: 1, name: 'S', resources: [],
      entities: [{ id: 1, prefab: PREFAB, guid: ROOT, members: { [`/${BONE_NODE}`]: { guid: 'ffffffff-0000-4000-8000-00000000d0aa', name: 'Spine' } }, traits: { EntityAttributes: { name: 'Rig', parentId: 0 } } }],
    } as unknown as SceneData);
    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('name no node the template still declares'));
    expect(line).toBeDefined();
    expect(line).toContain('"Spine"');
    warn.mockRestore();
    expect(guidOf('Spine_01')).not.toBe('ffffffff-0000-4000-8000-00000000d0aa');
  });
});

describe('gesture: CREATE PREFAB — a live tree becomes an instance of a new prefab', () => {
  // ⚠️ This is the PROPERTY `stampDerivedMemberGuids` was built to hold (#1461), tested without
  // naming the mechanism: after Create Prefab, a save and a reload must leave every member under the
  // guid it had, and every reference into the tree still pointing at the member it named.
  //
  // #1461's window was that the tagged members kept their plain-entity guids while the file said
  // `guid: ''` on every row, so the RELOAD derived different ones and anything written in between
  // named a guid that would never exist again. The stamp closed it by renaming eagerly. Stored rows
  // close it the other way: the save writes the guids the members actually have, and the reload
  // pins them. The property is the same either way, which is what makes it the right test.
  it('keeps every member`s guid and every ref into it across save and reload', async () => {
    await load({
      id: 'cp', version: 1, name: 'C', resources: [],
      entities: [
        ent(1, 'Holder', 0, HOLDER),
        ent(2, 'Root', HOLDER, ROOT),
        ent(3, 'Panel', ROOT, 'ffffffff-0000-4000-8000-00000000e101'),
        ent(4, 'Badge', ROOT, 'ffffffff-0000-4000-8000-00000000e102'),
        { id: 5, traits: {
          EntityAttributes: { name: 'Watcher', parentId: 0, guid: 'ffffffff-0000-4000-8000-00000000e1aa' },
          UIAction: { bindings: [{ target: 'ffffffff-0000-4000-8000-00000000e102' }] },
        } },
      ],
    } as unknown as SceneData);

    const file = serializePrefab(idOf('Root'), PREFAB)!;
    prefabs.set(PREFAB, file);
    setPrefabCache(PREFAB, file as never);
    tagEntityTreeAsInstance(idOf('Root'), PREFAB, file);

    // Whatever the tag did to the guids, the ref and the member must agree from here on.
    const badgeAfterTag = guidOf('Badge');
    const refAfterTag = (readTraitData(idOf('Watcher'), getTraitByName('UIAction')!) as { bindings: { target: string }[] }).bindings[0].target;
    expect(refAfterTag).toBe(badgeAfterTag);

    const scene = await serializeScene() as unknown as { entities: unknown[] };
    await load(scene as unknown as SceneData);

    expect(guidOf('Badge')).toBe(badgeAfterTag);
    const refAfterReload = (readTraitData(idOf('Watcher'), getTraitByName('UIAction')!) as { bindings: { target: string }[] }).bindings[0].target;
    expect(refAfterReload).toBe(badgeAfterTag);
    const { findEntityByGuid } = await import('@modoki/engine/runtime');
    expect(findEntityByGuid(refAfterReload)?.id()).toBe(idOf('Badge'));
  });
});
