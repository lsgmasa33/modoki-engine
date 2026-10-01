/** #1937 C-A step 2 (owner ruling F-A (1), F-C yes): every seat that takes a prefab document admits it
 *  (`admitPrefabDocument`). A document declaring an identifier twice is refused — a prefab that did not load (I18), so
 *  its instances are placeholders that keep every override, labelled "Damaged Prefab" with the reason — and a keyless
 *  template node gets one deterministic key at every seat. A scene's copy that cannot be admitted is kept for the save
 *  and never expanded (T13).
 *
 *  Driven through the REAL runtime cache (`acquirePrefab`, `replaceCachedPrefab`) and the real editor cache over a
 *  stubbed fetch, the real loader and the real `serializeScene`. Each case names the mutation that turns it red. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import {
  getCurrentWorld, setCurrentWorld, getAllEntities, setRunMode, loadSceneFile, instantiatePrefabIntoWorld, destroyEntity,
  type SceneData,
} from '@modoki/engine/runtime';
import { captureSceneCopies, restoreSceneCopies } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { clearManifest, registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { acquirePrefab, getCachedPrefab, replaceCachedPrefab, disposeAllCachedResources } from '../../packages/modoki/src/runtime/loaders/meshTemplateCache';
import { fetchPrefabSource, seatEditorPrefabCache, getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { damagedPrefabReason } from '../../packages/modoki/src/runtime/core/damagedPrefabs';
import { serializeScene } from '../../packages/modoki/src/editor/scene/serialize';
import { clearHistory } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const GUID = 'cccccccc-0000-4000-8000-000000001937';
const PATH = '/games/g/assets/D.prefab.json';
const ROOT = 'dddddddd-0000-4000-8000-000000001937';
const g = (n: number) => `eeeeeeee-0000-4000-8000-00000000193${n}`;
const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, name, nodeGuid: g(localId), traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } }, ...extra,
});
const clean = () => ({ id: GUID, version: 6, name: 'D', rootLocalId: 1, entities: [row(1, 'R', 0), row(2, 'A', 1)] });
/** Two rows given localId 2 (#1880 F3c's shape): refused under F-C. */
const repeatedLocalId = () => { const d = clean(); d.entities.push({ ...row(2, 'A2', 1), nodeGuid: g(3) }); return d; };
/** Two nodes keyed k1 in one frame (#1933 S1's shape). */
const node = (name: string, key?: string) => ({ parentLocalId: 1, name, ...(key ? { key } : {}), traits: { EntityAttributes: { name, parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } }, children: [] });
const repeatedKey = () => { const d = clean() as ReturnType<typeof clean> & { entities: Array<Record<string, unknown>> }; d.entities[0] = { ...d.entities[0], added: [node('K1', 'k1'), node('K2', 'k1')] }; return d; };
const keyless = () => { const d = clean() as ReturnType<typeof clean> & { entities: Array<Record<string, unknown>> }; d.entities[0] = { ...d.entities[0], added: [node('Loose')] }; return d; };
const addedOf = (doc: unknown) => ((doc as { entities: Array<{ added?: Array<{ key?: string }> }> }).entities[0]!.added ?? []);

let onDisk: unknown;
beforeEach(() => {
  setRunMode('stopped');
  clearHistory();
  clearManifest();
  registerAsset(GUID, PATH, 'prefab');
  onDisk = clean();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url) === PATH && onDisk !== undefined
    ? { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(onDisk), json: async () => JSON.parse(JSON.stringify(onDisk)) }
    : { ok: false, status: 404, statusText: 'Not Found', text: async () => '', json: async () => ({}) }) as unknown as Response));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of [GUID, PATH]) seatEditorPrefabCache(k, null);
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the runtime cache admits what it seats (#1937 C-A step 2)', () => {
  // Mutation: drop the `admitAtSeat` refusal in `fetchPrefab` (meshTemplateCache.ts) — the document is cached.
  it('a document giving two rows one localId is refused, and the reason is kept for the placeholder', async () => {
    onDisk = repeatedLocalId();
    await acquirePrefab(1, GUID);
    expect(getCachedPrefab(GUID)).toBeUndefined();
    expect(damagedPrefabReason(GUID)).toMatch(/localId 2 to two rows/);
    expect(damagedPrefabReason(PATH)).toBe(damagedPrefabReason(GUID));
  });

  // Accept side. Mutation: refuse every document at the seat — the clean one is not cached.
  it('a clean document is cached as the file states it, with no reason', async () => {
    await acquirePrefab(1, GUID);
    expect(getCachedPrefab(GUID)).toEqual(clean());
    expect(damagedPrefabReason(GUID)).toBeUndefined();
  });

  // Mutation: seat `parsed` instead of the admitted document — the node has no key.
  it('a keyless template node is seated with its minted key, the same one the editor cache gives it', async () => {
    onDisk = keyless();
    await acquirePrefab(1, GUID);
    const key = addedOf(getCachedPrefab(GUID))[0]?.key;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(addedOf(await fetchPrefabSource(GUID))[0]?.key).toBe(key);
  });

  // Mutation: return before the refusal in `replaceCachedPrefab` is judged (seat `data` as before) — it is cached.
  it('replaceCachedPrefab refuses the same document, and a clean write clears the reason', async () => {
    await acquirePrefab(1, GUID);
    replaceCachedPrefab(GUID, repeatedKey());
    expect(getCachedPrefab(GUID)).toBeUndefined();
    expect(damagedPrefabReason(GUID)).toMatch(/template key k1 to two nodes in one frame/);
    replaceCachedPrefab(GUID, clean());
    expect(getCachedPrefab(GUID)).toEqual(clean());
    expect(damagedPrefabReason(GUID)).toBeUndefined();
  });
});

describe('the editor cache admits what it seats (#1937 C-A step 2)', () => {
  // Mutations: drop the refusal in `fetchPrefabSource` — the document comes back; seat it in `seatEditorEntry` regardless.
  it('fetchPrefabSource and seatEditorEntry refuse a repeated key', async () => {
    onDisk = repeatedKey();
    expect(await fetchPrefabSource(GUID)).toBeNull();
    seatEditorPrefabCache(GUID, repeatedKey() as never);
    expect(getCachedPrefabSync(GUID)).toBeNull();
    seatEditorPrefabCache(GUID, clean() as never); // accept side
    expect(getCachedPrefabSync(GUID)).toEqual(clean());
  });
});

async function load(data: SceneData, freshWorld = true): Promise<void> {
  if (freshWorld) {
    const prev = getCurrentWorld();
    setCurrentWorld(createWorld());
    prev?.destroy();
  }
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => { await acquirePrefab(1, ref); return (getCachedPrefab(ref) as object | undefined) ?? null; },
    onDeletePlaceholder: (id: number) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, _rootGuid, _f, nestedStructure, ctx) => {
      const doc = ctx?.read?.(source) ?? getCachedPrefab(source);
      return instantiatePrefabIntoWorld(getCurrentWorld(), doc as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure) ?? undefined;
    },
  });
}
const entryOf = (s: SceneData) => (s.entities as unknown as Array<Record<string, unknown>>).find((e) => e.guid === ROOT);
const scene = (entry: Record<string, unknown>, extra: Record<string, unknown> = {}): SceneData => ({
  id: 's1937', version: 19, name: 'S', resources: [],
  entities: [{ id: 1, prefab: GUID, guid: ROOT, traits: { EntityAttributes: { name: 'Inst', parentId: 0 } }, ...entry }],
  ...extra,
} as unknown as SceneData);

describe('an instance of a refused prefab is a Damaged Prefab placeholder that keeps its record (#1937 T5, T7)', () => {
  // Mutation: drop the seat refusal — the instance expands, so there is no placeholder and no label.
  it('the edited instance: labelled with the reason, its row written back verbatim, byte-stable on a second save', async () => {
    onDisk = repeatedKey();
    const members = { [`/${g(2)}`]: { traits: { Transform: { x: 55 } } } };
    await load(scene({ members }));
    const placeholder = getAllEntities().find((e) => e.missingPrefab);
    expect(placeholder?.damagedPrefab).toMatch(/template key k1/);
    const s1 = await serializeScene() as unknown as SceneData;
    expect(entryOf(s1)?.members).toEqual(members);
    await load(s1);
    const s2 = await serializeScene() as unknown as SceneData;
    expect(JSON.stringify(s2.entities)).toBe(JSON.stringify(s1.entities));
  });

  // The control for the same mutation: a clean prefab expands (no placeholder), so the case above measures the refusal.
  it('control: the clean prefab expands', async () => {
    await load(scene({}));
    expect(getAllEntities().some((e) => e.missingPrefab)).toBe(false);
  });

  it('the untouched instance writes no members (S2: no whole list pinned onto it)', async () => {
    onDisk = repeatedKey();
    await load(scene({}));
    expect(getAllEntities().some((e) => e.missingPrefab)).toBe(true);
    expect(entryOf(await serializeScene() as unknown as SceneData)?.members).toBeUndefined();
  });
});

describe('a scene\'s copy that cannot be admitted is kept for the save and never expanded (#1937 T13)', () => {
  // Mutations: drop the damaged copy (today's `ignored`) — the save loses it; keep it in the expansion's store — the
  // instance expands from it.
  // With #1939's list (merged): the copy's "live at the save" list is written back as the file held it, too — nothing of a
  // refused copy is live, and a save writing the live ones alone turned it into []. Mutation: write the live list only
  // (`refusedCopyFrames` dropped from `collectEmbeddedPrefabs`) — the list is [].
  it('a copy giving two rows one localId, its prefab missing', async () => {
    onDisk = undefined;
    const damaged = repeatedLocalId();
    await load(scene({}, { embeddedPrefabs: { [GUID]: damaged }, embeddedPrefabFrames: { [GUID]: [ROOT] } }));
    expect(getAllEntities().some((e) => e.missingPrefab)).toBe(true);
    const s1 = await serializeScene() as unknown as SceneData & { embeddedPrefabs?: Record<string, unknown>; embeddedPrefabFrames?: Record<string, string[]> };
    expect(s1.embeddedPrefabs?.[GUID]).toEqual(damaged);
    expect(s1.embeddedPrefabFrames?.[GUID]).toEqual([ROOT]);
  });
  // Merged with #1939's swap carry: a world swap (an Apply's undo, Play→Stop) carries the scene's copies into the next
  // world. Mutation: carry the good-copy store only (drop the damaged loop in `captureSceneCopies`) — the swapped world's
  // save loses the copy.
  it('a world swap carries the refused copy: the next world\'s save still writes it', async () => {
    onDisk = undefined;
    const damaged = repeatedLocalId();
    // The scene key: '' for this file (its id is no guid), the key the save outside a scene manager writes.
    await load(scene({}, { embeddedPrefabs: { [GUID]: damaged }, embeddedPrefabFrames: { [GUID]: [ROOT] } }));
    const carry = captureSceneCopies(getCurrentWorld(), { of: () => '', keeps: (s) => s === '' });
    // The next world: the carry first, then a load of a file that carries no copy (a snapshot taken before the trash).
    const prev = getCurrentWorld();
    setCurrentWorld(createWorld());
    prev?.destroy();
    restoreSceneCopies(getCurrentWorld(), carry);
    await load(scene({}), false);
    const s = await serializeScene() as unknown as SceneData & { embeddedPrefabs?: Record<string, unknown>; embeddedPrefabFrames?: Record<string, string[]> };
    expect(s.embeddedPrefabs?.[GUID]).toEqual(damaged);
    expect(s.embeddedPrefabFrames?.[GUID]).toEqual([ROOT]);
  });
});
