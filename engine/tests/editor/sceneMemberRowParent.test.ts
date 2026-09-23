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
import { setActionCallback, pushAction, reparentEntity } from '@modoki/engine/editor';
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


/** Move `name` under `to` the way the editor does, inside the instance. */
function move(name: string, to: string): void {
  reparentEntity(idOf(name), idOf(to));
}

const rowNamed = (entry: SceneEntityEntry, name: string) =>
  Object.entries(entry.members ?? {}).find(([, r]) => r.name === name)?.[1];

const parentNameOf = (name: string): string => {
  const pid = (readTraitData(idOf(name), getTraitByName('EntityAttributes')!) as { parentId?: number }).parentId ?? 0;
  return getAllEntities().find((e) => e.id === pid)?.name ?? '';
};

describe('SceneMemberRow.parent — a member moved inside its instance (#1468 Phase 3)', () => {
  it('stores the new parent on the moved member`s row, and nothing on its siblings`', async () => {
    await placedInstance();
    const before = guidOf('Badge');
    move('Badge', 'Panel');
    const scene = await serializeScene() as unknown as { entities: unknown[] };
    const entry = instanceEntry(scene);

    // The moved member names where it now sits — by GUID, the only kind of entity reference this
    // format has (docs/prefab-structural-overrides.md § A move is stored on the member's row).
    expect(rowNamed(entry, 'Badge')).toEqual({ guid: before, name: 'Badge', parent: guidOf('Panel') });
    // …and the members that did NOT move say nothing, which is what makes `parent` an override.
    expect(rowNamed(entry, 'Panel')).toEqual({ guid: guidOf('Panel'), name: 'Panel' });
    expect(rowNamed(entry, 'Label')).toEqual({ guid: guidOf('Label'), name: 'Label' });
  });

  it('puts the member back under that parent on reload, with the guid it had', async () => {
    await placedInstance();
    const before = guidOf('Badge');
    move('Badge', 'Panel');
    const saved = await serializeScene() as unknown as SceneData;

    // ⚠️ The row is now the ONLY thing that can put Badge back: `moved` was deleted from the format
    // in the same phase, so nothing else in this document says where Badge sits. This assertion is
    // what keeps that true — the day a second channel reappears, the round trip below would be
    // green whether or not `row.parent` is read at all.
    const entry = instanceEntry(saved as unknown as { entities: unknown[] });
    expect((entry as { moved?: unknown }).moved).toBeUndefined();

    await load(saved);
    // ⚠️ Names the WRONG ANSWER, not merely "it is somewhere": a reload that ignored `parent` puts
    // Badge back under Root, where its template row hangs, and the move is silently undone.
    expect(parentNameOf('Badge')).toBe('Panel');
    expect(parentNameOf('Badge')).not.toBe('Root');
    expect(guidOf('Badge')).toBe(before);
  });

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

  it('re-keys nothing when the member moves — the flat key is what survives it (D1(a))', async () => {
    await placedInstance();
    const keyBefore = Object.entries(instanceEntry(await serializeScene() as unknown as { entities: unknown[] }).members ?? {})
      .find(([, r]) => r.name === 'Badge')![0];
    move('Badge', 'Panel');
    const keyAfter = Object.entries(instanceEntry(await serializeScene() as unknown as { entities: unknown[] }).members ?? {})
      .find(([, r]) => r.name === 'Badge')![0];
    // Under an ancestor-chain key this would change and the stored row would orphan on the next
    // load. The whole point of D1(a) is that a move touches `parent` and nothing else.
    expect(keyAfter).toBe(keyBefore);
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

// Close-out review finding 1: a member of a PRE-v5 template has no row — no `nodeGuid`, no key — so the
// row cannot carry its move, and Phase 3 first wrote it nowhere: moved, saved, reloaded at its template
// row. Every prefab the released editor wrote is pre-v5, so that was every project outside this repo.
// The capture now splits its moves: a row states a keyed member's, and the legacy map carries the rest.
describe('a move inside an instance of a PRE-v5 template survives save + reload (#1468)', () => {
  // Mutation: have noteMove put every move into `rowed` (never into `unrowed`).
  it('is written to the legacy `moved` map, and reloads where it was put', async () => {
    const { template } = await placedInstance();
    const v4 = JSON.parse(JSON.stringify(template)) as PrefabFile & { entities: Array<{ nodeGuid?: string }> };
    v4.version = 4;
    for (const r of v4.entities) delete r.nodeGuid;
    prefabs.set(PREFAB, v4);
    setPrefabCache(PREFAB, v4 as never);
    await load({
      id: 's', version: 1, name: 'S', resources: [],
      entities: [{ id: 1, prefab: PREFAB, guid: ROOT, traits: { EntityAttributes: { name: 'Root', parentId: 0 } } }],
    } as unknown as SceneData);
    move('Badge', 'Panel');
    const saved = await serializeScene() as unknown as SceneData;
    const entry = instanceEntry(saved as unknown as { entities: unknown[] }) as SceneEntityEntry & { moved?: Record<number, string> };
    expect(entry.members).toBeUndefined(); // the premise: no row exists to carry it
    expect(entry.moved).toEqual({ [rowOf(v4, 'Badge').localId]: guidOf('Panel') });
    await load(saved);
    expect(parentNameOf('Badge')).toBe('Panel');
  });
});
