// @vitest-environment jsdom
/** #1702 — a prefab change hot-reloads the open scene only when a loaded scene FILE uses that prefab.
 *
 *  The reload rebuilds the world from disk and discards the open scene's unsaved edits and undo stack (disk wins, #1164 —
 *  a ruling scoped to "the open scene or a prefab it uses"). For a prefab no loaded scene uses, it rebuilt nothing and
 *  only lost that work: any external write, duplicate or import of an unrelated prefab did it. Both prefab caches are
 *  still brought up to date either way.
 *
 *  "Uses" is `LoadedSceneEntry.prefabRefs`, recorded by `SceneManager` at load (direct, nested, control-track), by ref
 *  AND by the path it resolved to then — pinned SceneManager-side in `sceneManagerPrefabRefs.test.ts`. Here the loaded
 *  entries are stubbed with it, through the real `scene-changed` handler (the harness of
 *  `agentBridgeDeferredSceneReload.test.ts`).
 *
 *  Mutations, each checked red:
 *  - drop the filter: "an unused prefab", and nothing else.
 *  - `prefabPaths.some` → `[msg.urlPath].some`: "a deferred replay", and nothing else.
 *  - drop the guid lookup: "a prefab MISSING when the scene loaded", plus the two cases whose refs are guid-only.
 *  - drop the path comparison: "a DELETED prefab the scene used", and nothing else.
 *  - drop the live-instance half: "a prefab gained AFTER load", and nothing else.
 *  - an entry without `prefabRefs` counts as not using it: "an entry that does not know". (Every production entry has
 *    `prefabRefs`; `agentBridgeDeferredSceneReload.test.ts` stubs its entries WITH them, so it runs the real path.) */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sceneManager, acquirePrefab, getCachedPrefab, releaseAllForScene, registerAsset, unregisterAsset, getTraitByName, getCurrentWorld,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

type Handler = (data: unknown) => void;
type Win = typeof window & { __modokiElectron?: { bridge?: unknown } };

const SCENE_PATH = '/games/g/runtime/assets/Main.scene.json';
const BASE_PATH = '/games/g/runtime/assets/Base.scene.json';
const PREFAB_GUID = 'c0ffee00-0000-4000-8000-00000000d702';
const PREFAB_PATH = '/games/g/runtime/assets/Crate.prefab.json';
const OTHER_PATH = '/games/g/runtime/assets/Unrelated.prefab.json';
const SEED_SCENE_ID = 987_655;

const { initAgentBridge, setSceneReloadSuppressor, replaySuppressedSceneReloads, setPrefabSourceRefresher } = await import('../../app/debug/agentBridge');

let handlers: Map<string, Handler[]>;
const refreshed: string[] = [];
let loadScene: ReturnType<typeof vi.spyOn>;
type Entry = { path: string; role: 'primary' | 'base'; guid: string; prefabRefs?: ReadonlySet<string> };
let loaded: Map<string, Entry>;
const restores: (() => void)[] = [];

const emit = (urlPath: string, kind = 'prefab') => { for (const cb of handlers.get('scene-changed') ?? []) cb({ urlPath, kind }); };
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
const primary = (prefabRefs?: Iterable<string>) => ({ path: SCENE_PATH, role: 'primary' as const, guid: 'main', ...(prefabRefs ? { prefabRefs: new Set(prefabRefs) } : {}) });

beforeEach(async () => {
  const win = window as Win;
  handlers = new Map();
  win.__modokiElectron = { bridge: { on: (event: string, cb: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), cb]); }, send: vi.fn() } };
  initAgentBridge();
  refreshed.length = 0;
  setPrefabSourceRefresher(async (urlPath) => { refreshed.push(urlPath); });
  loaded = new Map<string, Entry>([['main', primary([])]]);
  const getCurrent = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: SCENE_PATH } as never);
  const getLoaded = vi.spyOn(sceneManager, 'getLoadedScenes').mockImplementation(() => loaded as never);
  loadScene = vi.spyOn(sceneManager, 'loadScene').mockImplementation(async () => ({ world: (await import('../../packages/modoki/src/runtime/core/ecs/world')).getCurrentWorld(), keptBaseGuids: new Set<string>() }));
  const fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => new Response(JSON.stringify(
    String(input).includes('.prefab.json') ? { id: PREFAB_GUID, entities: [] } : { version: 7, entities: [] },
  ), { status: 200, headers: { 'content-type': 'application/json' } }));
  restores.push(() => { getCurrent.mockRestore(); getLoaded.mockRestore(); loadScene.mockRestore(); fetchStub.mockRestore(); });
  registerAsset(PREFAB_GUID, PREFAB_PATH, 'prefab');
  await acquirePrefab(SEED_SCENE_ID, PREFAB_GUID);
});

afterEach(async () => {
  setSceneReloadSuppressor(null);
  await replaySuppressedSceneReloads();
  setPrefabSourceRefresher(null);
  releaseAllForScene(SEED_SCENE_ID);
  unregisterAsset(PREFAB_GUID);
  for (const r of restores.splice(0)) r();
  delete (window as Win).__modokiElectron;
});

describe('#1702: a prefab change reloads only a scene that uses it', () => {
  it('an unused prefab: no reload — but both caches are still brought up to date', async () => {
    loaded = new Map<string, Entry>([['main', primary(['dddddddd-0000-4000-8000-000000000001'])]]);
    expect(getCachedPrefab(PREFAB_GUID), 'premise: cached').toBeDefined();
    emit(PREFAB_PATH);
    await settle();
    expect(loadScene).not.toHaveBeenCalled();
    expect(getCachedPrefab(PREFAB_GUID), 'the runtime copy was not evicted').toBeUndefined();
    expect(refreshed).toEqual([PREFAB_PATH]);
  });

  it('ACCEPT SIDE: a prefab the primary uses, by guid, reloads', async () => {
    loaded = new Map<string, Entry>([['main', primary([PREFAB_GUID])]]);
    emit(PREFAB_PATH);
    await settle();
    expect(loadScene).toHaveBeenCalledTimes(1);
  });

  it('a prefab a BASE scene uses reloads', async () => {
    loaded = new Map<string, Entry>([['main', primary([])], ['base', { path: BASE_PATH, role: 'base', guid: 'base', prefabRefs: new Set([PREFAB_GUID, PREFAB_PATH]) }]]);
    emit(PREFAB_PATH);
    await settle();
    expect(loadScene).toHaveBeenCalledTimes(1);
  });

  it('a DELETED prefab the scene used reloads — matched by its load-time path, the manifest no longer knows it', async () => {
    loaded = new Map<string, Entry>([['main', primary([PREFAB_GUID, PREFAB_PATH])]]);
    unregisterAsset(PREFAB_GUID); // the watcher rebuilt the manifest before it broadcast
    emit(PREFAB_PATH);
    await settle();
    expect(loadScene).toHaveBeenCalledTimes(1);
  });

  it('a prefab MISSING when the scene loaded, now back: matched by its guid, which only the manifest can give', async () => {
    loaded = new Map<string, Entry>([['main', primary([PREFAB_GUID])]]); // no path: it did not resolve at load
    emit(PREFAB_PATH);
    await settle();
    expect(loadScene).toHaveBeenCalledTimes(1);
  });

  it('a prefab gained AFTER load — a live instance no scene file named at load — reloads (close-out review)', async () => {
    loaded = new Map<string, Entry>([['main', primary([])]]); // Main.scene named no prefab when it loaded
    const { trait } = getTraitByName('PrefabInstance')!;
    const instance = getCurrentWorld().spawn(trait({ source: PREFAB_GUID }));
    try {
      emit(PREFAB_PATH);
      await settle();
      expect(loadScene, 'skipped, the instance stays built from the old prefab and the next save writes it back').toHaveBeenCalledTimes(1);
    } finally { instance.destroy(); }
  });

  it('an entry that does not know what it uses counts as using it — the old behaviour, not a skipped reload', async () => {
    loaded = new Map<string, Entry>([['main', primary()]]);
    emit(OTHER_PATH);
    await settle();
    expect(loadScene).toHaveBeenCalledTimes(1);
  });

  it('a deferred replay reloads when ANY of the prefabs it collapses is used, not only the last', async () => {
    loaded = new Map<string, Entry>([['main', primary([PREFAB_GUID])]]);
    setSceneReloadSuppressor(() => 'game is playing');
    emit(PREFAB_PATH);
    emit(OTHER_PATH); // the LAST one, unused
    await settle();
    setSceneReloadSuppressor(null);
    await replaySuppressedSceneReloads();
    expect(loadScene).toHaveBeenCalledTimes(1);
  });
});
