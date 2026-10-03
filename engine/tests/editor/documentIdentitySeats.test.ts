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
/** The rows a saved entry states beside its root's own `"/"` row (scene v20, #2001 S6: that one names the root, always). */
const statedRows = (s: SceneData) => { const { '/': _root, ...rest } = (entryOf(s)?.members ?? {}) as Record<string, unknown>; return rest; };
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
    expect(statedRows(s1)).toEqual(members);
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
    expect(statedRows(await serializeScene() as unknown as SceneData)).toEqual({});
  });
});

/** #1948 F3 (hub ruling 2026-10-02, fork (b)): a malformed channel on a prefab document's NESTED row. The S3 split covers
 *  scene owners only, and the fold read the prefab's row raw: `removed: 3` crashed the load of every scene placing it
 *  ("(lower.removed ?? []) is not iterable"). The seat now refuses such a document, so its instance is a Damaged Prefab
 *  placeholder keeping its entry. */
describe('a malformed channel on a prefab\'s nested row refuses the instance (#1948 F3)', () => {
  const NESTED = 'cccccccc-0000-4000-8000-000000019482';
  const withNestedRow = (channels: Record<string, unknown>) => { const d = clean() as ReturnType<typeof clean> & { entities: Array<Record<string, unknown>> }; d.entities.push(row(3, 'N', 1, { prefab: NESTED, ...channels })); return d; };
  const members = { [`/${g(2)}`]: { traits: { Transform: { x: 55 } } } };
  // Mutation: drop admission's `malformedOwnerRefusal` (documentIdentity.ts) — each load throws (the fold's TypeError), or
  // expands with the value dropped.
  for (const [what, channels] of [
    ['removed: 3', { removed: 3 }], ['added: "xy"', { added: 'xy' }], ['added: [3]', { added: [3] }],
    ['a member row that is a string', { members: { '/x': 'y' } }], ['overrides: 3', { overrides: 3 }],
  ] as const) {
    it(`${what}: a Damaged Prefab placeholder naming it, the entry written back verbatim, byte-stable`, async () => {
      onDisk = withNestedRow(channels);
      await load(scene({ members }));
      const placeholder = getAllEntities().find((e) => e.missingPrefab);
      expect(placeholder?.damagedPrefab).toMatch(/nested row N \(localId 3\) states .* in a shape no reader takes/);
      expect(getAllEntities().some((e) => e.name === 'R'), 'nothing of D expanded').toBe(false);
      const s1 = await serializeScene() as unknown as SceneData;
      expect(statedRows(s1)).toEqual(members);
      await load(s1);
      expect(JSON.stringify((await serializeScene() as unknown as SceneData).entities)).toBe(JSON.stringify(s1.entities));
    });
  }

  // A REFERENCE node is a nested owner too. Before, `removed: 3` on one loaded, then crashed the scene's SAVE ("number 3
  // is not iterable", prefabCapture's `stateFrame`). Mutation: visit rows only (no walk into the template lists) — red.
  it('a reference node in a template list: the same placeholder, and the scene saves', async () => {
    const d = clean() as ReturnType<typeof clean> & { entities: Array<Record<string, unknown>> };
    d.entities[0] = { ...d.entities[0], added: [{ ...node('Ref', 'k-ref'), prefab: NESTED, removed: 3 }] };
    onDisk = d;
    await load(scene({ members }));
    expect(getAllEntities().find((e) => e.missingPrefab)?.damagedPrefab).toMatch(/reference node Ref \(key k-ref\) states removed in a shape no reader takes/);
    expect(statedRows(await serializeScene() as unknown as SceneData)).toEqual(members);
  });

  // #1948 close-out R2: a reference node under a plain node's `children` states no `parentLocalId` (the spawner does not
  // need one there). Mutation: ask for a numeric `localId`/`parentLocalId` again — admitted, and the open and the save
  // read `removed: 3` raw.
  it('a reference node in `children`, stating no parentLocalId: refused too', async () => {
    const d = clean() as ReturnType<typeof clean> & { entities: Array<Record<string, unknown>> };
    const { parentLocalId: _p, ...ref } = { ...node('Ref', 'k-ref'), prefab: NESTED, removed: 3 };
    d.entities[0] = { ...d.entities[0], added: [{ ...node('Holder', 'k-h'), children: [ref] }] };
    onDisk = d;
    await load(scene({ members }));
    expect(getAllEntities().find((e) => e.missingPrefab)?.damagedPrefab).toMatch(/reference node Ref \(key k-ref\) states removed/);
  });

  // The accept side: the same channels well-formed. Mutation: refuse every nested row that states a channel.
  it('the same channels well-formed: D expands, no Damaged placeholder', async () => {
    onDisk = withNestedRow({ removed: [3], added: [], members: { '/x': { traits: { Transform: { x: 2 } } } } });
    await load(scene({ members }));
    expect(getAllEntities().some((e) => e.damagedPrefab)).toBe(false);
    expect(getAllEntities().some((e) => e.name === 'R')).toBe(true);
    // NESTED is on no disk here: its row shows a Missing Prefab placeholder (rule 9, ruling D; #2028), the one placeholder.
    expect(getAllEntities().filter((e) => e.missingPrefab).map((e) => e.name)).toEqual(['N']);
  });
});

/** #1937 T13 kept a scene's refused copy for the save. Scene v20 (#2001 S6) writes NO prefab copies: the instance's own
 *  list is the record, and a prefab that is missing shows a Missing Prefab placeholder that keeps it. So a refused copy
 *  in an older file is read (never expanded), and the save leaves it out with every other copy. */
describe('a scene\'s copy that cannot be admitted is never expanded, and a v20 save writes no copy (#1937 T13, #2001 S6)', () => {
  it('a copy giving two rows one localId, its prefab missing: a placeholder, its entry kept, no copy written', async () => {
    onDisk = undefined;
    const damaged = repeatedLocalId();
    await load(scene({}, { embeddedPrefabs: { [GUID]: damaged }, embeddedPrefabFrames: { [GUID]: [ROOT] } }));
    expect(getAllEntities().some((e) => e.missingPrefab)).toBe(true);
    const s1 = await serializeScene() as unknown as SceneData & { embeddedPrefabs?: unknown; embeddedPrefabFrames?: unknown };
    expect(entryOf(s1)?.prefab).toBe(GUID);
    expect(s1.embeddedPrefabs).toBeUndefined();
    expect(s1.embeddedPrefabFrames).toBeUndefined();
  });
});
