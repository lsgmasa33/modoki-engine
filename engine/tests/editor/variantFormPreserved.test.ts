/** The Prefab Variant form (a prefab whose ROOT row is a reference to another prefab, #1031's shape) is not supported
 *  until a variants stage (owner ruling, 2026-10-02, #2028; #2042): the load shows a Damaged Prefab placeholder and the
 *  scene's list for it round-trips VERBATIM (rule 9), where expanding it let the first save write the instance as its base
 *  and lose the variant's own nodes (#2042, measured on the pre-S5 tree).
 *
 *  Mutation: drop `rootReferenceRefusal` from `frameRepeatRefusal` (`runtime/loaders/frameRepeat.ts`): the load expands
 *  the document again, and the save no longer writes the entry as the file held it. */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getTraitByName, setRunMode, loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { clearKeptMemberOrphans } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

beforeAll(() => setRunMode('stopped'));
afterAll(() => {
  for (const id of prefabs.keys()) setPrefabCache(id, null);
  getCurrentWorld()?.destroy();
});

const install = (docs: Iterable<unknown>) => {
  for (const id of prefabs.keys()) setPrefabCache(id, null);
  prefabs.clear();
  for (const doc of docs) {
    const id = (doc as { id?: unknown }).id;
    if (typeof id !== 'string' || !id) continue;
    prefabs.set(id, doc);
    setPrefabCache(id, doc as never);
  }
};

/** The load, through a callback shaped as SceneManager's `onInstantiatePrefab` (root guid, editor folder, root extra
 *  traits), with everything the loader hands the callback passed on to the spawner. */
async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  clearKeptMemberOrphans();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id: number) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _old, rootExtraTraits, overrides, structure, nested, rootGuid, rootEditorFolder, nestedStructure, ld) => {
      const read = (ld as { read?: (g: string) => unknown } | undefined)?.read;
      const cached = (read ?? ((g: string) => prefabs.get(g)))(source);
      if (!cached) return undefined;
      const id = instantiatePrefabIntoWorld(
        getCurrentWorld(), cached as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure,
        { ...(ld as object | undefined) } as never,
      );
      const root = id ? [...getCurrentWorld().entities].find((e) => e.id() === id) : undefined;
      if (!root) return id ?? undefined;
      if (rootGuid || rootEditorFolder) {
        root.set(eaMeta.trait, { ...(root.get(eaMeta.trait) as object), ...(rootGuid ? { guid: rootGuid } : {}), ...(rootEditorFolder ? { editorFolder: rootEditorFolder } : {}) });
      }
      for (const [name, d] of Object.entries(rootExtraTraits ?? {})) {
        const meta = getTraitByName(name);
        if (!meta) continue;
        const isTag = meta.category === 'tag' || d === true;
        if (root.has(meta.trait)) { if (!isTag) root.set(meta.trait, d as Record<string, unknown>); }
        else root.add(isTag ? (meta.trait as unknown as () => never)() : (meta.trait as unknown as (x: unknown) => never)(d));
      }
      return id;
    },
  });
}


import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { unresolvedRefOf } from '../../packages/modoki/src/runtime/core/unresolvedPrefabRef';

const C = 'cccccccc-0000-4000-8000-00000000c031', P = 'cccccccc-0000-4000-8000-00000000a031', G = 'dddddddd-0000-4000-8000-0000000000d3';
const child = { id: C, version: 5, name: 'Child', rootLocalId: 1, entities: [
  { localId: 1, nodeGuid: 'eeeeeeee-0000-4000-8000-0000000c0031', traits: { EntityAttributes: { name: 'ChildRoot', parentId: 0 }, Transform: { x: 1, y: 0, z: 0 }, UIElement: { width: 30 } } },
  { localId: 2, nodeGuid: 'eeeeeeee-0000-4000-8000-0000000c0032', traits: { EntityAttributes: { name: 'ChildKid', parentId: 1 }, Transform: { x: 2, y: 0, z: 0 } } },
] };
/** The variant: its root row is a reference to Child, with overrides on it and a node of its own under the root. */
const variant = { id: P, version: 5, name: 'Variant', rootLocalId: 1, entities: [
  { localId: 1, nodeGuid: 'eeeeeeee-0000-4000-8000-0000000a0031', prefab: C, traits: { EntityAttributes: { name: 'VariantRef', parentId: 0 } },
    overrides: { 1: { UIElement: { height: 50 } }, 2: { Transform: { x: 9 } } } },
  { localId: 2, nodeGuid: 'eeeeeeee-0000-4000-8000-0000000a0032', traits: { EntityAttributes: { name: 'VariantKid', parentId: 1 }, Transform: { x: 3, y: 0, z: 0 } } },
] };
const ENTRY = { id: 1, prefab: P, guid: G, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } }, overrides: { 1: { UIElement: { marginBottom: 4 } } } };

describe('the Prefab Variant form loads as a Damaged Prefab placeholder and round-trips verbatim (#2042)', () => {
  it('load → save → reload → save: the entry is written as the file held it, both times; nothing is expanded', async () => {
    install([child, variant]);
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
    try {
      await load({ id: 'ssssssss-0000-4000-8000-000000002042', version: 19, name: 'S', resources: [], entities: [ENTRY] } as unknown as SceneData);
      const ea = getTraitByName('EntityAttributes')!.trait;
      const live = [...getCurrentWorld().entities].filter((e) => e.has(ea));
      // Only the placeholder: none of the variant's or its base's nodes were built.
      expect(live.map((e) => (e.get(ea) as { name: string }).name)).toEqual(['Inst']);
      expect(unresolvedRefOf(live[0] as never)).toMatchObject({ source: P, kind: 'entry' });
      const first = (await serializeScene()).entities;
      await load({ id: 'ssssssss-0000-4000-8000-000000002042', version: 19, name: 'S', resources: [], entities: first } as unknown as SceneData);
      const second = (await serializeScene()).entities;
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ prefab: P, guid: G, overrides: ENTRY.overrides, traits: { EntityAttributes: { name: 'Inst' } } });
      expect(first[0]).not.toHaveProperty('added');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
