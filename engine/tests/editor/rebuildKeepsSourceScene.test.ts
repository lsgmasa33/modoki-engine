/** #1431 — `rebuildInstance` carries the instance's scene OWNERSHIP (`EntityAttributes.sourceScene`)
 *  across its teardown + respawn, as it already carries the root's guid.
 *
 *  A base scene's instance that came back primary-owned left the base file on the next Save All
 *  (`serializeScene({scene: base})` keeps only entities stamped with the base's guid), so it vanished
 *  from every other level using that base. Refresh after a prefab save, Revert and Apply all rebuild,
 *  so all three reached it. Each case names the mutation that turns it red. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));
import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData, writeTraitField,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { clearHistory, setActionCallback, pushAction, undo, redo } from '@modoki/engine/editor';
import {
  setPrefabCache, rebuildInstance, captureInstanceOverrides, captureInstanceStructure, revertOverridesSelective,
} from '../../packages/modoki/src/editor/scene/prefab';
import { isSceneDirty, clearSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);

const INNER = 'aaaaaaaa-0000-4000-8000-0000000001d1';
const KIT = 'aaaaaaaa-0000-4000-8000-0000000001d2';
const ROOT = 'bbbbbbbb-0000-4000-8000-0000000001d2';
const ADDED = 'bbbbbbbb-0000-4000-8000-0000000001d3';
/** The base scene's guid: what `loadAdditive` stamps on every entity a base scene spawned. */
const BASE = 'cccccccc-0000-4000-8000-0000000001d1';

const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, name, ...extra,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const innerDoc = { id: INNER, version: 3, name: 'Inner', rootLocalId: 1, entities: [row(1, 'InnerRoot', 0), row(2, 'Leaf', 1)] };
/** Kit → Slot, plus an owned nested INNER row under Slot. */
const kitDoc = { id: KIT, version: 3, name: 'Kit', rootLocalId: 1, entities: [
  row(1, 'Kit', 0), row(2, 'Slot', 1), row(3, 'InnerRoot', 2, { prefab: INNER }),
] };
const install = (doc: { id?: string }) => { prefabs.set(doc.id!, doc); setPrefabCache(doc.id!, doc as never); };

async function load(scene: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(scene)), {
    loadModels: false,
    fetchPrefab: async (ref) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _old, extra, overrides, structure, nested, rootGuid, _folder, nestedStructure) => {
      const world = getCurrentWorld();
      const rootId = instantiatePrefabIntoWorld(world, prefabs.get(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
      if (!rootId) return undefined;
      for (const e of world.entities) {
        if (e.id() !== rootId) continue;
        for (const [name, data] of Object.entries(extra ?? {})) {
          const meta = getTraitByName(name);
          if (meta) e.add(meta.trait(data as never));
        }
        if (rootGuid) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid: rootGuid });
      }
      return rootId;
    },
  });
}


const sceneWith = (): SceneData => ({
  id: 'base-kit', version: 14, name: 'S', resources: [],
  entities: [
    { id: 1, prefab: KIT, guid: ROOT, traits: { EntityAttributes: { name: 'Kit', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
  ],
} as unknown as SceneData);

const eaMeta = () => getTraitByName('EntityAttributes')!;
const sourceOf = (id: number) => (readTraitData(id, eaMeta())?.sourceScene as string) || '';
const rootId = () => getAllEntities().find((e) => e.name === 'Kit')!.id;
/** Every entity in the instance's subtree, by name → its sourceScene. */
const stamps = () => Object.fromEntries(getAllEntities().map((e) => [e.name, sourceOf(e.id)]));
const stampAll = (guid: string) => { for (const e of getAllEntities()) writeTraitField(e.id, eaMeta(), 'sourceScene', guid); };

/** What `refreshInstances` does per instance: capture against the old prefab, then rebuild. */
function refresh(): void {
  const id = rootId();
  rebuildInstance(id, KIT, kitDoc as never, captureInstanceOverrides(id, kitDoc as never), captureInstanceStructure(id, kitDoc as never), kitDoc as never);
}

beforeEach(async () => {
  setRunMode('stopped');
  clearHistory();
  clearSceneDirty(BASE);
  prefabs.clear();
  install(innerDoc);
  install(kitDoc);
  await load(sceneWith());
  // A node the scene added under the instance's Slot — captured as `added` and respawned by the rebuild.
  const slot = getAllEntities().find((e) => e.name === 'Slot')!.id;
  getCurrentWorld().spawn(eaMeta().trait({ name: 'Mine', parentId: slot, guid: ADDED }), getTraitByName('Transform')!.trait());
});
afterAll(() => { for (const id of [INNER, KIT]) setPrefabCache(id, null); getCurrentWorld()?.destroy(); });

describe('a rebuild keeps the instance in the scene that owns it (#1431)', () => {
  // Mutations: drop the sourceScene carry in `rebuildInstance` — every entity reads '' (primary); or
  // stamp only the new ROOT — the members, the nested expansion and the added node stay ''.
  it('a BASE scene\'s instance: members, the nested instance and the scene-added node keep the base stamp', () => {
    stampAll(BASE);
    expect(Object.keys(stamps()).sort()).toEqual(['InnerRoot', 'Kit', 'Leaf', 'Mine', 'Slot']); // precondition: the whole tree is here
    refresh();
    expect(stamps()).toEqual({ Kit: BASE, Slot: BASE, InnerRoot: BASE, Leaf: BASE, Mine: BASE });
  });

  // Mutation: stamp unconditionally (e.g. with the old root's raw value || some default) — the
  // primary's instance must stay unstamped, or it would leave the primary for a base.
  it('a PRIMARY instance stays primary-owned', () => {
    refresh();
    expect(stamps()).toEqual({ Kit: '', Slot: '', InnerRoot: '', Leaf: '', Mine: '' });
  });
});

/** Carrying the stamp is half the chain: Save All writes a base only when it is DIRTY, and a Revert
 *  never marked it — so the reverted instance stayed in the base but the base file was never
 *  rewritten, and the revert was lost on reload. The dialog and the agent op both push
 *  `result.affectedScenes` as the action's `affectedScenes`; this drives that exact shape. */
describe('a revert on a base\'s instance dirties the base (#1431)', () => {
  const xOf = (name: string) => readTraitData(getAllEntities().find((e) => e.name === name)!.id, getTraitByName('Transform')!)?.x as number;
  async function revertSlotX() {
    writeTraitField(getAllEntities().find((e) => e.name === 'Slot')!.id, getTraitByName('Transform')!, 'x', 5);
    const result = (await revertOverridesSelective(rootId(), new Set(['2.Transform.x'])))!;
    expect(xOf('Slot')).toBe(0); // precondition: the revert happened
    pushAction({ label: 'Revert prefab overrides', undo: () => {}, redo: () => {}, affectedScenes: result.affectedScenes });
    return result;
  }

  // Mutation: return `affectedScenes: []` from `revertOverridesSelective` — the base stays clean.
  it('a BASE instance: the result names the base, and pushing it dirties the base on push, undo and redo', async () => {
    stampAll(BASE);
    const result = await revertSlotX();
    expect(result.affectedScenes).toEqual([BASE]);
    expect(stamps().Slot).toBe(BASE);
    expect(isSceneDirty(BASE)).toBe(true);
    for (const step of [undo, redo]) {
      clearSceneDirty(BASE);
      await step();
      expect(isSceneDirty(BASE)).toBe(true);
    }
  });

  it('a PRIMARY instance names no scene', async () => {
    const result = await revertSlotX();
    expect(result.affectedScenes).toEqual([]);
    expect(isSceneDirty(BASE)).toBe(false);
  });
});
