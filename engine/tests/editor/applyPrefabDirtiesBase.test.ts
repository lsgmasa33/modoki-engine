/** #1431 — Apply to Prefab on a BASE scene's instance: dirties the base, and its undo/redo rebuild
 *  the base instance rather than trusting the world restore.
 *
 *  The apply consumes the instance's overrides/additions into the prefab, so the base's file is
 *  stale too; the only write it does is `saveScene()` — the PRIMARY — and Save All writes a base only
 *  when dirty. So `applyToPrefabWithUndo` reads the owning scene BEFORE the apply tears the instance
 *  down, and carries it as the undo action's `affectedScenes`.
 *
 *  That makes the undo load-bearing: `restoreSnapshot` rebuilds the primary from a primary-only
 *  snapshot, and a base loaded with it is CARRIED live — so without a rebuild the dirty base would be
 *  written from the post-apply instance, and a promoted added node would exist nowhere.
 *
 *  Mocked: the apply itself (modelled as the real one's scene half: the promoted live node deleted,
 *  the new prefab installed, every instance refreshed), the prefab install, the scene I/O, and
 *  `sceneManager.loadScene` as a no-op. ⚠️ A no-op is NOT the real carry: that re-spawns the base
 *  with fresh ids and re-seeds marks and markers, so a regression THERE cannot show up in this file.
 *  The undo manager, the capture, the refresh and the rebuild are real. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));
vi.mock('../../packages/modoki/src/editor/scene/serialize', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  serializeScene: async () => ({ entities: [] }),
  saveScene: async () => ({ saved: true }),
  getCurrentScenePath: () => '/scenes/level.json',
  setCurrentScenePath: () => {},
  setCurrentBaseScene: () => {},
}));
vi.mock('../../packages/modoki/src/editor/scene/prefab', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../packages/modoki/src/editor/scene/prefab')>();
  return {
    ...real,
    // The restore rebases carried stale roots (#1483). In production the world restore re-expands the primary
    // from the restored prefab, so the rebase finds nothing there; here `loadScene` is a no-op that leaves the
    // primary built from the prefab being undone, and a real rebase would rebuild it — masking the
    // `refreshBaseInstances` filter this file pins. No root here is carried, so the stub loses nothing.
    rebaseStaleInstances: async () => 0,
    installPrefabSnapshot: async (_src: string, doc: { id?: string }) => { install(doc); },
    // The real apply promotes `Mine` into the prefab (here: member `Promoted`), deletes the live node,
    // installs the new prefab and REFRESHES every instance of it from the old one. Modelled so.
    applyToPrefabSelective: async () => {
      const { destroyEntity, getCurrentWorld } = await import('@modoki/engine/runtime');
      const world = getCurrentWorld();
      for (const e of world.entities) {
        const ea = getTraitByName('EntityAttributes')!;
        if (e.has(ea.trait) && (e.get(ea.trait) as { name: string }).name === 'Mine') destroyEntity(e, world);
      }
      install(kitAfter);
      const pi = getTraitByName('PrefabInstance')!;
      const roots = getAllEntities().filter((e) => (readTraitData(e.id, pi)?.rootInstanceId as number) === e.id && readTraitData(e.id, pi)?.source === KIT).map((e) => e.id);
      for (const id of roots) {
        real.rebuildInstance(id, KIT, kitAfter as never, real.captureInstanceOverrides(id, kitDoc as never), real.captureInstanceStructure(id, kitDoc as never), kitDoc as never);
      }
      return { applied: true, source: KIT, prefabBefore: kitDoc, prefabAfter: kitAfter, promotedAdditions: 0 };
    },
  };
});
import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode, readTraitData, writeTraitField,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, findEntity, type SceneData,
} from '@modoki/engine/runtime';
import { clearHistory, setActionCallback, pushAction, undo, redo } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefab';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { isSceneDirty, clearSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { markOverride } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
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
/** Kit after the apply promoted `Mine`: a new member under Slot. */
const kitAfter = { ...kitDoc, entities: [...kitDoc.entities, row(4, 'Promoted', 2)] };
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


const ROOT2 = 'bbbbbbbb-0000-4000-8000-0000000001d4';
const sceneWith = (): SceneData => ({
  id: 'base-kit', version: 14, name: 'S', resources: [],
  entities: [
    { id: 1, prefab: KIT, guid: ROOT, traits: { EntityAttributes: { name: 'Kit', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    { id: 2, prefab: KIT, guid: ROOT2, traits: { EntityAttributes: { name: 'Kit', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
  ],
} as unknown as SceneData);

const eaMeta = () => getTraitByName('EntityAttributes')!;
const sourceOf = (id: number) => (readTraitData(id, eaMeta())?.sourceScene as string) || '';
const rootId = () => getAllEntities().find((e) => e.name === 'Kit' && rootOf(e.id) === e.id && rootGuidOf(e.id) === ROOT)!.id;
const stampAll = (guid: string) => { for (const e of getAllEntities()) writeTraitField(e.id, eaMeta(), 'sourceScene', guid); };


const mine = () => getAllEntities().filter((e) => e.name === 'Mine');
const promoted = () => getAllEntities().filter((e) => e.name === 'Promoted');
const rootOf = (id: number) => readTraitData(id, getTraitByName('PrefabInstance')!)?.rootInstanceId as number;
/** Which instance an entity belongs to, by its root's guid — both roots are named 'Kit' (the prefab's
 *  name), and a rebuild keeps the root's durable guid but not its id. */
const rootGuidOf = (id: number) => readTraitData(rootOf(id), getTraitByName('EntityAttributes')!)?.guid as string;
const slotOf = (rootGuid: string) => getAllEntities().find((e) => e.name === 'Slot' && rootGuidOf(e.id) === rootGuid)!.id;

beforeEach(async () => {
  setRunMode('stopped');
  clearHistory();
  clearSceneDirty(BASE);
  prefabs.clear();
  install(innerDoc);
  install(kitDoc);
  await load(sceneWith());
  const slot = slotOf(ROOT);
  getCurrentWorld().spawn(eaMeta().trait({ name: 'Mine', parentId: slot, guid: ADDED }), getTraitByName('Transform')!.trait());
  vi.spyOn(sceneManager, 'loadScene').mockResolvedValue(undefined as never);
  vi.spyOn(sceneManager, 'getCurrentBaseScene').mockReturnValue(null as never);
});
afterAll(() => { for (const id of [INNER, KIT]) setPrefabCache(id, null); getCurrentWorld()?.destroy(); vi.restoreAllMocks(); });

describe('Apply to Prefab on a base\'s instance (#1431)', () => {
  // Mutation: drop `affectedScenes` from `makeApplyPrefabAction` — the base stays clean.
  // ⚠️ NOT pinned here: reading it AFTER the apply. koota recycles ids LIFO, so the rebuilt root
  // usually gets the old id back and a late read still answers; reading first does not depend on it.
  it('dirties the base', async () => {
    stampAll(BASE);
    await applyToPrefabWithUndo(rootId(), new Set(['+added.x']));
    expect(isSceneDirty(BASE)).toBe(true);
  });

  // Mutation: drop the `sourceScene` filter in `refreshBaseInstances` — the undo then re-derives the
  // primary instances too, against a prefab the real restore did not build them from.
  it('a PRIMARY instance dirties no base, and the undo leaves primary instances to the world restore', async () => {
    await applyToPrefabWithUndo(rootId(), new Set(['+added.x']));
    expect(isSceneDirty(BASE)).toBe(false);
    await undo();
    // The primary comes back from `sceneBefore` — mocked away here, so both stay as the apply left them.
    expect(mine()).toHaveLength(0);
    expect(promoted()).toHaveLength(2);
  });

  // Mutation: drop `restoreBaseInstance` from the undo (or the redo) closure — the applied instance
  // keeps its post-apply shape (no Mine) after undo, and the dirty base would be saved without it.
  it('undo brings the promoted node back into the base instance, still base-owned; redo takes it away', async () => {
    stampAll(BASE);
    await applyToPrefabWithUndo(rootId(), new Set(['+added.x']));
    expect(mine()).toHaveLength(0); // precondition: the apply removed the live node…
    expect(promoted()).toHaveLength(2); // …and every instance gained the promoted member
    clearSceneDirty(BASE);
    await undo();
    expect(mine()).toHaveLength(1);
    expect(sourceOf(mine()[0]!.id)).toBe(BASE);
    expect(sourceOf(rootId())).toBe(BASE);
    expect(isSceneDirty(BASE)).toBe(true);
    await redo();
    expect(mine()).toHaveLength(0);
    expect(sourceOf(rootId())).toBe(BASE);
  });

  // Mutation: drop `refreshBaseInstances` from the undo (or the redo) closure — the OTHER base
  // instance keeps the member of the prefab being undone, which the dirty base's save would write
  // as a structural diff against the restored prefab.
  //   And: pass `{}` as the refresh's overrides — the other instance's OWN marked override is lost.
  it('undo/redo re-derive the OTHER base instances of the prefab too, keeping their own overrides', async () => {
    stampAll(BASE);
    const slot2 = () => slotOf(ROOT2);
    writeTraitField(slot2(), getTraitByName('Transform')!, 'x', 7);
    markOverride(findEntity(slot2())!, 'Transform', 'x');
    const x2 = () => readTraitData(slot2(), getTraitByName('Transform')!)?.x as number;
    await applyToPrefabWithUndo(rootId(), new Set(['+added.x']));
    expect(x2()).toBe(7); // precondition: the apply's own refresh kept it
    await undo();
    expect(promoted()).toHaveLength(0);
    expect(x2()).toBe(7);
    await redo();
    expect(promoted()).toHaveLength(2);
    expect(x2()).toBe(7);
    expect(promoted().every((e) => sourceOf(e.id) === BASE)).toBe(true);
  });

  // Mutation: capture with `guidForEntityId` instead of `ensureGuid` — a runtime guid is not carried
  // by the rebuild, the root is not found again, and undo silently leaves the post-apply instance.
  it('a base root holding NO durable guid is still found again (a durable one is minted)', async () => {
    stampAll(BASE);
    const id = rootId();
    writeTraitField(id, eaMeta(), 'guid', '');
    await applyToPrefabWithUndo(id, new Set(['+added.x']));
    await undo();
    expect(mine()).toHaveLength(1);
  });
});
