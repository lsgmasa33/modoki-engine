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
// The undo's prefab half is ONE `commitPrefabWrite` (#1692): installed here with no disk, then its rebuild (the world
// restore) runs, as the real step runs it once the write lands.
vi.mock('../../packages/modoki/src/editor/scene/prefabCommit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  commitPrefabWrite: async (src: string, doc: { id?: string }, opts: { rebuild?: (l: { path: string }) => unknown }) => {
    install(doc);
    await opts.rebuild?.({ path: src });
    return { ok: true, path: src };
  },
}));
// The restore's path write goes through the adoption owner (#1698), which writes through `serialize.ts`'s own setter —
// not the mocked export above — and that persists the path.
vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
// #2046 S7.3: the undo restores from records in place and its rebase reprojects every other instance from its own — the
// real rebase, so the stub the snapshot reload's cases used (a no-op `loadScene` left the primary for it) is gone.
vi.mock('../../packages/modoki/src/editor/scene/prefabApply', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../packages/modoki/src/editor/scene/prefabApply')>();
  return {
    ...real,
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
      // The instance applied FROM is named, as the real Apply names it (`appliedFrom`): it is rebuilt from its capture,
      // every other one is reprojected from its record (#2046 S7.3).
      for (const id of roots) {
        const from = rootGuidOf(id) === ROOT ? [{ rootId: id, rootGuid: ROOT, fields: new Set<string>() }] : undefined;
        refreshInstances(KIT, [id], kitDoc as never, kitAfter as never, new Map(), from);
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
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { refreshInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { isSceneDirty, clearSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { markOverride } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { clearDirtyAssets } from '../../packages/modoki/src/editor/scene/dirtyAssets';

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
  clearDirtyAssets(); // a document an undo parked (#1868) belongs to its own case
  setRunMode('stopped');
  clearHistory();
  clearSceneDirty(BASE);
  prefabs.clear();
  install(innerDoc);
  install(kitDoc);
  await load(sceneWith());
  const slot = slotOf(ROOT);
  getCurrentWorld().spawn(eaMeta().trait({ name: 'Mine', parentId: slot, guid: ADDED }), getTraitByName('Transform')!.trait());
  vi.spyOn(sceneManager, 'loadScene').mockImplementation(async () => ({ world: (await import('../../packages/modoki/src/runtime/core/ecs/world')).getCurrentWorld(), keptBaseGuids: new Set<string>() }) as never);
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

  // #2046 S7.3: the undo restores a primary instance from its records in place, as it does a base's — no world reload.
  it('a PRIMARY instance dirties no base, and the undo restores it in place', async () => {
    await applyToPrefabWithUndo(rootId(), new Set(['+added.x']));
    expect(isSceneDirty(BASE)).toBe(false);
    await undo();
    expect(mine()).toHaveLength(1);
    expect(promoted()).toHaveLength(0);
    expect(isSceneDirty(BASE)).toBe(false);
  });

  // Mutation (#2046 S7.3): drop `restoreRecords`' `restoreSide` — the applied instance keeps its post-apply shape (no
  // Mine) after undo, and the dirty base would be saved without it (this case, the primary's and the minted-guid one).
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

  // Mutation (#2046 S7.3): drop `restoreRecords`' rebase — the OTHER base instance keeps the member of the prefab being
  // undone, which the dirty base's save would write as a structural diff against the restored prefab (this case and the
  // primary's). Its own override is kept by its record, which the reprojection reads.
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
