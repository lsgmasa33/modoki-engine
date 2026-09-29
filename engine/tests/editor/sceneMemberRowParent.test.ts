/** #1468 Phase 3 — `SceneMemberRow.parent`: a member moved inside its instance is stored on its own
 *  row, and the localId-keyed `moved` map it replaces is on its way out.
 *
 *  The rule under test is that `parent` is a DIFF against the member's own frame template, never
 *  "the live parent, always". The two halves are tested against each other on purpose: the moved
 *  member must carry a `parent`, and a member the TEMPLATE re-parents must NOT — an always-write
 *  writer passes the first and fails the second, which is the failure that would otherwise ship as
 *  "the template edit did nothing".
 */

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

beforeEach(() => { setRunMode('stopped'); prefabs.clear(); clearKeptMemberOrphans(); });
afterAll(() => { getCurrentWorld()?.destroy(); });

const rowNamed = (entry: SceneEntityEntry, name: string) =>
  Object.entries(entry.members ?? {}).find(([, r]) => r.name === name)?.[1];

const parentNameOf = (name: string): string => {
  const pid = (readTraitData(idOf(name), getTraitByName('EntityAttributes')!) as { parentId?: number }).parentId ?? 0;
  return getAllEntities().find((e) => e.id === pid)?.name ?? '';
};

describe('SceneMemberRow.parent — a member moved inside its instance (#1468 Phase 3)', () => {

  it('lets a TEMPLATE re-parent move an un-moved member — R4, the case always-writing would break', async () => {
    await placedInstance();
    const before = guidOf('Badge');
    const saved = await serializeScene() as unknown as SceneData;
    // Nobody moved anything in the instance, so no row states a parent…
    expect(rowNamed(instanceEntry(saved as unknown as { entities: unknown[] }), 'Badge')?.parent).toBeUndefined();

    // …and now the TEMPLATE moves Badge under Panel — the most common template edit there is.
    const edited = JSON.parse(JSON.stringify(prefabs.get(PREFAB))) as PrefabFile;
    const badge = rowOf(edited, 'Badge');
    (badge.traits['EntityAttributes'] as Record<string, unknown>).parentId = rowOf(edited, 'Panel').localId;
    prefabs.set(PREFAB, edited);
    setPrefabCache(PREFAB, edited as never);

    await load(saved);
    // The instance FOLLOWS the template. A `parent` written unconditionally would have pinned Badge
    // under Root for ever and this would read 'Root' — the silent defeat R4 exists to prevent.
    expect(parentNameOf('Badge')).toBe('Panel');
    expect(guidOf('Badge')).toBe(before);
  });
});

// A file written before Phase 3 carries its moves in the localId-keyed `moved` map and nowhere else.
// It is written now only for moves no row can carry, but the loader always APPLIES one: dropping it — even with a
// warning, which is what Phase 3 first shipped — moves the member back to its template row on load and
// rewrites the file without the move, the failure this plan exists to end. #1437 is on main, so real
// scenes carry these.
describe('a pre-Phase-3 `moved` map still applies, and migrates onto the row on save (#1468)', () => {
  /** The placed instance's saved scene, rewritten as a v15 file: no rows, the move in `moved`. */
  async function legacyScene(): Promise<SceneData> {
    const { template, scene } = await placedInstance();
    const entry = instanceEntry(scene) as SceneEntityEntry & { moved?: Record<number, string> };
    delete entry.members;
    entry.moved = { [rowOf(template, 'Badge').localId]: guidOf('Panel') };
    return { ...(scene as unknown as SceneData), version: 15 } as SceneData;
  }

  // Mutation: stop passing `entry.moved` at the top-level composition site.
  it('a v15 entry`s `moved` puts the member under its parent, and a save states it on the row', async () => {
    const legacy = await legacyScene();
    const panel = guidOf('Panel');
    await load(legacy);
    expect(parentNameOf('Badge')).toBe('Panel');
    const entry = instanceEntry(await serializeScene() as unknown as { entities: unknown[] });
    expect((entry as { moved?: unknown }).moved).toBeUndefined();
    expect(rowNamed(entry, 'Badge')?.parent).toBe(panel);
  });

  // Mutation: let `structure.moved` win over a row in applyStructureCore.
  it('a row that also moves the member wins over the legacy map', async () => {
    const legacy = await legacyScene();
    const entry = instanceEntry(legacy as unknown as { entities: unknown[] });
    const { scene } = await placedInstance();
    entry.members = instanceEntry(scene).members;
    const badge = Object.values(entry.members!).find((r) => r.name === 'Badge')!;
    badge.parent = guidOf('Label');
    await load(legacy);
    expect(parentNameOf('Badge')).toBe('Label');
  });
});
