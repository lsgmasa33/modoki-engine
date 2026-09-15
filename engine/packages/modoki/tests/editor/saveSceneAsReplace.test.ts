/** Save Scene As over an EXISTING scene (#1264).
 *
 *  The first save of a scene asks for a name and wrote it with a plain, replacing write. On the
 *  Windows/Linux fallback nothing ever checked whether that name was taken, so an existing scene was
 *  silently replaced — under the NEW scene's id, dangling everything that pointed at the old one (a
 *  scene change, the build's scene list). Now it writes create-only, asks, and on a Replace the new
 *  scene takes the replaced one's id (owner 2026-09-15).
 *
 *  Runs the real `saveScene` and `serializeScene`; only the dialog, the SceneManager and the backend
 *  are stubbed. Setup mirrors prefabEditSaveGuard.test.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld } from 'koota';

vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: { getCurrent: () => null, getLoadedScenes: () => new Map() },
}));

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size; },
  } as Storage;
}

const TARGET = '/assets/scenes/level.json';
const asked: string[] = [];
let answer = true;
const chooseNewAssetPath = vi.fn(async () => ({ path: TARGET, confirmReplace: async (p: string) => { asked.push(p); return answer; } }));
vi.mock('../../src/editor/utils/saveDialog', () => ({ chooseNewAssetPath }));

const { EntityAttributes } = await import('../../src/runtime/core/traits/EntityAttributes');
const { setCurrentWorld, registerEntity, indexEntityGuid } = await import('../../src/runtime/core/ecs/world');
const { registerTrait } = await import('../../src/runtime/core/ecs/traitRegistry');
const { setRunMode } = await import('../../src/runtime/core/playState');
const { saveScene, setCurrentScenePath, getCurrentScenePath } = await import('../../src/editor/scene/serialize');
const { getGuidForPath, unregisterAsset, registerAsset } = await import('../../src/runtime/loaders/assetManifest');

const OLD = '44444444-4444-4444-8444-444444444444';
let onDisk = new Map<string, string>();
let writes: Array<{ path: string; content: string; createOnly: boolean }> = [];

beforeEach(() => {
  asked.length = 0;
  answer = true;
  onDisk = new Map();
  writes = [];
  chooseNewAssetPath.mockClear();
  setRunMode('stopped');
  setCurrentScenePath(null);
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'enum' }, guid: { type: 'string' } },
  });
  const w = createWorld();
  setCurrentWorld(w);
  const e = w.spawn(EntityAttributes({ name: 'Thing', guid: 'g-thing' }));
  registerEntity(e); indexEntityGuid(e);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.endsWith('/api/write-file')) {
      const b = JSON.parse(init?.body ?? '{}') as { path: string; content: string; ifNoneMatch?: string };
      if (b.ifNoneMatch === '*' && onDisk.has(b.path)) return { ok: false, status: 409, json: async () => ({}) } as unknown as Response;
      writes.push({ path: b.path, content: b.content, createOnly: b.ifNoneMatch === '*' });
      onDisk.set(b.path, b.content);
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }
    const served = [...onDisk.entries()].find(([p]) => u.endsWith(p));
    if (served) return { ok: true, status: 200, json: async () => JSON.parse(served[1]) } as unknown as Response;
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }));
});
// The manifest is a module global: a guid one test registered for TARGET would otherwise be "the replaced
// scene's id" in the next.
afterEach(() => { vi.unstubAllGlobals(); for (let g = getGuidForPath(TARGET); g; g = getGuidForPath(TARGET)) unregisterAsset(g); });

const idOf = (text: string) => (JSON.parse(text) as { id: string }).id;

describe('Save Scene As', () => {
  it('a free name writes create-only and asks nothing', async () => {
    const r = await saveScene();
    expect(r).toMatchObject({ saved: true, path: TARGET });
    expect(asked).toEqual([]);
    expect(writes.map((w) => w.createOnly)).toEqual([true]);
    expect(getGuidForPath(TARGET)).toBe(idOf(writes[0].content));
  });

  it('a TAKEN name asks, and a no writes nothing and leaves the scene untitled', async () => {
    onDisk.set(TARGET, `{"id":"${OLD}","entities":[]}\n`);
    answer = false;
    const r = await saveScene();
    expect(r).toMatchObject({ saved: false, reason: 'cancelled' });
    expect(asked).toEqual([TARGET]);
    expect(writes).toEqual([]);
    expect(idOf(onDisk.get(TARGET)!)).toBe(OLD);
    expect(getCurrentScenePath()).toBeNull();
  });

  it('a taken name that is NOT a scene (Enemy.prefab.json is `.json` too) is refused — its guid never becomes a scene', async () => {
    onDisk.set(TARGET, `{"id":"${OLD}","entities":[]}\n`);
    registerAsset(OLD, TARGET, 'prefab');
    const r = await saveScene();
    expect(r).toMatchObject({ saved: false, reason: 'cancelled' });
    expect(asked, 'refused before any question').toEqual([]);
    expect(writes).toEqual([]);
    expect(getGuidForPath(TARGET)).toBe(OLD);
  });

  it('a Replace keeps the replaced scene\'s id — and the NEXT save still writes it', async () => {
    onDisk.set(TARGET, `{"id":"${OLD}","entities":[]}\n`);
    const r = await saveScene();
    expect(r).toMatchObject({ saved: true, path: TARGET });
    expect(writes).toHaveLength(1);
    expect(idOf(writes[0].content)).toBe(OLD);
    expect(getGuidForPath(TARGET)).toBe(OLD);
    // The live scene took over that identity: a plain Cmd+S afterwards must not mint a new one.
    await saveScene();
    expect(writes).toHaveLength(2);
    expect(idOf(writes[1].content)).toBe(OLD);
  });
});
