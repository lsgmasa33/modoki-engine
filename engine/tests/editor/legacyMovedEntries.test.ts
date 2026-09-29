/** A scene file that already holds a member MOVE (#1437) keeps loading and saving as it did (#1869).
 *
 *  Since #1869 no gesture moves or reorders an object a prefab supplies (Unity's rule, `restructureRefusal`), so a moved
 *  member exists only in a file written before it. Such a file is not migrated or rewritten: it loads, a no-op save is
 *  byte-identical, the instance survives a rebuild, and the move stays an override the Apply/Revert dialog lists — so the
 *  owner of an old file can revert it. Apply does NOT write it into the prefab (#1868, hub ruling B): a prefab keeps its
 *  objects where it places them, as Unity's does, and applying a move re-pathed the member in every other file. This is the representative set for that path; the
 *  authoring-path tests went with the gesture.
 *
 *  The file is made the way the old editor made it: the member's parent is written raw (what a move left in the live
 *  world), then the real save writes it. Every assertion then runs on the world RELOADED from that file. */

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
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, deleteEntitiesWithUndo, reparentEntity } from '@modoki/engine/editor';
import { spawnEntity, Transform, EntityAttributes } from '@modoki/engine/runtime';
import { serializePrefab } from '../../packages/modoki/src/editor/scene/prefab';
import { detachPrefabInstanceWithUndo } from '../../packages/modoki/src/editor/undo/detachPrefabUndo';
import { restructureRefusal } from '../../packages/modoki/src/editor/scene/restructureRefusal';
import { setPrefabCache, applyToPrefabSelective, revertOverridesSelective, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { planReparent } from '../../packages/modoki/src/editor/undo/entityActions';
import { writeTraitField, markStructureDirty } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const P = 'cccccccc-0000-4000-8000-000000001869';
const ROOT1 = 'dddddddd-0000-4000-8000-000000001869';
const g = (n: number) => `eeeeeeee-0000-4000-8000-00000000186${n}`;

/** P: R → A, B → C. The file below moves C from under B to under A. */
const pDoc = () => {
  const row = (localId: number, name: string, parentId: number) => ({
    localId, name, nodeGuid: g(localId),
    traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: localId, y: 0, z: 0 } },
  });
  return { id: P, version: 5, name: 'P', rootLocalId: 1, entities: [row(1, 'R', 0), row(2, 'A', 1), row(3, 'B', 1), row(4, 'C', 3)] };
};
const install = (d: { id: string }) => { prefabs.set(d.id, d); setPrefabCache(d.id, d as never); };
const scene = (): SceneData => ({
  id: 's1869', version: 14, name: 'S', resources: [],
  entities: [{ id: 1, prefab: P, guid: ROOT1, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } } }],
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
const rootId = () => getAllEntities().find((e) => e.guid === ROOT1)!.id;
const named = (name: string) => getAllEntities().find((e) => e.name === name)!;
const parentName = (name: string) => getAllEntities().find((e) => e.id === named(name).parentId)?.name;
const linkedTo = (name: string) => (readTraitData(named(name).id, meta('PrefabInstance')) as { rootInstanceId?: number } | null)?.rootInstanceId;
const saved = async () => serializeScene() as unknown as Promise<SceneData>;

/** The pre-#1869 file: C moved under A, written by the real save. */
let legacy: SceneData;
/** C's guid while it sat in the world that wrote the file. */
let movedGuid: string;

beforeEach(async () => {
  setRunMode('stopped');
  clearHistory();
  prefabs.clear();
  writes.length = 0;
  clearKeptMemberOrphans();
  install(pDoc());
  await load(scene());
  writeTraitField(named('C').id, meta('EntityAttributes'), 'parentId', named('A').id);
  markStructureDirty();
  movedGuid = named('C').guid!;
  legacy = await saved();
  // Precondition: the file really holds the move, as a member row naming its new parent (#1437) — or every case below
  // would pass on a file with no move in it.
  expect(JSON.stringify(legacy)).toContain(`"parent":"${named('A').guid}"`);
  await load(legacy);
  clearHistory();
});
afterAll(() => { setPrefabCache(P, null); getCurrentWorld()?.destroy(); });

describe('a file holding a member move (#1437) loads and saves unchanged (#1869)', () => {
  // Mutation: drop the member row's `parent` in the loader's member-row apply — C reloads under B.
  it('loads with the member where the file put it, still linked, under its guid', () => {
    expect(parentName('C')).toBe('A');
    expect(linkedTo('C')).toBe(rootId());
    expect(named('C').guid).toBe(movedGuid);
  });

  // A no-op save of the loaded file writes what it read. Mutation: stop writing `parent` on a moved member row — the
  // move is gone from the re-save.
  it('a no-op save is byte-identical to the file it loaded', async () => {
    expect(JSON.stringify((await saved()).entities)).toBe(JSON.stringify(legacy.entities));
    await load(await saved());
    expect(JSON.stringify((await saved()).entities)).toBe(JSON.stringify(legacy.entities));
  });

  // A Revert of an unrelated edit tears the instance down and re-expands it. Mutation: rebuild without the capture's
  // moves — C comes back under B.
  it('the move survives a rebuild of the instance', async () => {
    writeTraitFieldWithUndo(named('B').id, meta('Transform'), 'x', 9);
    const key = collectInstanceOverrideKeys(rootId(), prefabs.get(P) as PrefabFile).fields.find((k) => k.endsWith('.Transform.x'))!;
    expect(key).toBeTruthy();
    await revertOverridesSelective(rootId(), new Set([key]));
    expect(parentName('C')).toBe('A');
    expect(linkedTo('C')).toBe(rootId());
    expect(JSON.stringify((await saved()).entities)).toBe(JSON.stringify(legacy.entities));
  });

  // The move is still the instance's own edit, listed by the dialog, and Revert takes it back.
  it('the move is listed as an override, and Revert puts the member back at its row', async () => {
    const keys = collectInstanceOverrideKeys(rootId(), prefabs.get(P) as PrefabFile);
    expect(keys.moved).toEqual([`~moved.${g(4)}`]);
    await revertOverridesSelective(rootId(), new Set(keys.moved));
    expect(parentName('C')).toBe('B');
    expect(JSON.stringify(await saved())).not.toContain('"parent"');
  });

  // Apply does NOT write the move into the prefab (#1868, hub ruling B): the key is skipped, naming Revert, nothing is
  // written, and the move stays a scene statement. Mutation: drop the `~moved.` skip in `planApply` — the key falls through,
  // and the skip reason is gone.
  it('Apply leaves the move out, naming Revert, and writes nothing', async () => {
    const before = writes.length;
    const res = await applyToPrefabSelective(rootId(), new Set([`~moved.${g(4)}`]));
    expect(res.applied).toBe(false);
    expect(res.skipped).toEqual([{ key: `~moved.${g(4)}`, reason: expect.stringMatching(/Revert the move/) }]);
    expect(writes.length).toBe(before);
    expect(parentName('C')).toBe('A');
    expect(JSON.stringify(await saved())).toContain('"parent"');
  });

  // The file is loaded as it is, but it cannot be restructured further: its moved member is still the prefab's.
  it('the moved member still does not move', () => {
    expect(planReparent(named('C').id, named('B').id)).toEqual({ kind: 'refused', reason: 'restructure' });
  });
});

describe('what else a file holding a move meets (#1869 close-out review)', () => {
  // The member's ROW parent is deleted: the move keeps it where the file put it. (This block's mutation, for all three:
  // drop the loader's parent write in `moveMember` — C loads back under B, and each case goes red.)
  it('deleting the row the member was moved out of keeps the member, through a reload', async () => {
    await deleteEntitiesWithUndo([named('B').id]);
    await load(await saved());
    expect(parentName('C')).toBe('A');
    expect(linkedTo('C')).toBe(rootId());
    expect(named('C').guid).toBe(movedGuid);
  });

  // Detach unpacks the whole instance, the moved member with it, where it sits.
  it('Detach of the instance leaves the moved member plain where the file put it, through a reload', async () => {
    expect(detachPrefabInstanceWithUndo(rootId(), 'Detach', '[t]').links.length).toBeGreaterThan(0);
    await load(await saved());
    expect(parentName('C')).toBe('A');
    expect(linkedTo('C')).toBeUndefined();
  });

  // Create Prefab from the instance root writes the rows as they sit: C under A, and every row's chain ends at the root.
  it('a prefab written from the instance holds the move as its row parent, with no parent loop', () => {
    const doc = serializePrefab(rootId()) as PrefabFile;
    const byLocal = new Map(doc.entities.map((e) => [e.localId, e]));
    const parentOfRow = (l: number) => Number((byLocal.get(l)!.traits?.EntityAttributes as { parentId?: number }).parentId ?? 0);
    const row = (name: string) => doc.entities.find((e) => e.name === name)!;
    expect(parentOfRow(row('C').localId)).toBe(row('A').localId);
    for (const e of doc.entities) {
      const seen = new Set<number>();
      for (let l = e.localId; l && l !== doc.rootLocalId; l = parentOfRow(l)) { expect(seen.has(l)).toBe(false); seen.add(l); }
    }
  });
});

describe('a member a file moved under a node the scene added (#1869 close-out review, finding 4)', () => {
  // The file: C moved under N, a node the scene added under R. N may move within the instance, taking C along — C stays
  // inside its instance — but not out of it. Mutation: require C's supplier to move WITH the subtree (drop `landsUnder`)
  // — the move within the instance is refused.
  it('the node moves within its instance, with the member, and not out of it', async () => {
    const n = spawnEntity(getCurrentWorld(), Transform(), EntityAttributes({ name: 'N', parentId: rootId(), guid: 'eeeeeeee-0000-4000-8000-0000000018a1' })).id();
    writeTraitField(named('C').id, meta('EntityAttributes'), 'parentId', n);
    markStructureDirty();
    const file = await saved();
    expect(JSON.stringify(file)).toContain('"parent":"eeeeeeee-0000-4000-8000-0000000018a1"'); // precondition: the move is in the file
    await load(file);
    const node = named('N').id;
    expect(restructureRefusal({ id: node, parentId: 0 })).not.toBeNull();
    expect(reparentEntity(node, named('A').id)).toBe(true);
    expect([parentName('N'), parentName('C')]).toEqual(['A', 'N']);
    await load(await saved());
    expect([parentName('N'), parentName('C'), linkedTo('C')]).toEqual(['A', 'N', rootId()]);
  });
});
