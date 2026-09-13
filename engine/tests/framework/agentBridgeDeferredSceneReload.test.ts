/** A scene/prefab hot reload held back by the suppressor is DEFERRED, not dropped (#1164), and a
 *  prefab change evicts the cached prefab before the reload it triggers (#1169).
 *
 *  Driven through the real `scene-changed` handler (`initAgentBridge` over a fake Electron bridge,
 *  the same seam `agentBridgeSceneChangedKindVocab.test.ts` uses). The prefab cache is REAL
 *  `meshTemplateCache`: an entry is seeded by a real `acquirePrefab` over a stubbed `fetch`, and the
 *  observable is `getCachedPrefab`. A mocked cache could not tell an eviction from none.
 *
 *  What is stubbed and why: `sceneManager.getCurrent`/`getLoadedScenes`/`loadScene` (a real load
 *  needs a renderer), and `fetch` (the handler re-reads the scene file before loading it).
 *
 *  The replay's TIMING (only after a Stop/Exit restore has landed) is pinned editor-side, in
 *  `engine/packages/modoki/tests/editor/authoringSettle.test.ts` and `timelinePreviewSession.test.ts`. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sceneManager, acquirePrefab, getCachedPrefab, releaseAllForScene, registerAsset, unregisterAsset,
} from '@modoki/engine/runtime';

type Handler = (data: unknown) => void;
type Win = typeof window & { __modokiElectron?: { bridge?: unknown } };

const SCENE_PATH = '/games/g/runtime/assets/Main.scene.json';
const PREFAB_GUID = 'c0ffee00-0000-4000-8000-00000000b1ce';
const PREFAB_PATH = '/games/g/runtime/assets/Crate.prefab.json';
/** The scene id that owns the seeded prefab entry; any id no real scene uses. */
const SEED_SCENE_ID = 987_654;

const bridgeMod = await import('../../app/debug/agentBridge');
const { initAgentBridge, setSceneReloadSuppressor, replaySuppressedSceneReloads, peekSuppressedSceneReloads, setPrefabSourceRefresher } = bridgeMod;

let handlers: Map<string, Handler[]>;
let fetchSuppressesOnScene = false;
const refreshed: string[] = [];
let loadScene: ReturnType<typeof vi.spyOn>;
const restores: (() => void)[] = [];

function emit(urlPath: string, kind: string): void {
  for (const cb of handlers.get('scene-changed') ?? []) cb({ urlPath, kind });
}
/** The handler is async; let its synchronous prefix and the awaits before `loadScene` run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  const win = window as Win;
  handlers = new Map();
  win.__modokiElectron = {
    bridge: {
      on: (event: string, cb: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), cb]); },
      send: vi.fn(),
    },
  };
  initAgentBridge();
  fetchSuppressesOnScene = false;
  refreshed.length = 0;
  setPrefabSourceRefresher(async (urlPath) => { refreshed.push(urlPath); });

  const getCurrent = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: SCENE_PATH } as never);
  const getLoaded = vi.spyOn(sceneManager, 'getLoadedScenes')
    .mockReturnValue(new Map([['main', { path: SCENE_PATH, role: 'primary', guid: 'main' }]]) as never);
  loadScene = vi.spyOn(sceneManager, 'loadScene').mockResolvedValue(undefined as never);
  const fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (fetchSuppressesOnScene && String(input).includes('.scene.json')) setSceneReloadSuppressor(() => 'game is playing');
    const body = String(input).includes('.prefab.json')
      ? { id: PREFAB_GUID, entities: [] }
      : { version: 7, entities: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  restores.push(() => { getCurrent.mockRestore(); getLoaded.mockRestore(); loadScene.mockRestore(); fetchStub.mockRestore(); });

  registerAsset(PREFAB_GUID, PREFAB_PATH, 'prefab');
  await acquirePrefab(SEED_SCENE_ID, PREFAB_GUID);
  expect(getCachedPrefab(PREFAB_GUID), 'fixture: the prefab is cached before each case').toBeDefined();
});

afterEach(async () => {
  fetchSuppressesOnScene = false;
  setSceneReloadSuppressor(null);
  await replaySuppressedSceneReloads(); // drain anything a failing case left behind
  setPrefabSourceRefresher(null);
  releaseAllForScene(SEED_SCENE_ID);
  unregisterAsset(PREFAB_GUID);
  for (const r of restores.splice(0)) r();
  delete (window as Win).__modokiElectron;
});

describe('suppressed scene hot reload is deferred, not dropped (#1164)', () => {
  it('a scene change while suppressed does not reload, and is held', async () => {
    setSceneReloadSuppressor(() => 'game is playing');
    emit(SCENE_PATH, 'scene');
    await settle();
    expect(loadScene).not.toHaveBeenCalled();
    expect(peekSuppressedSceneReloads()).toEqual([SCENE_PATH]);
  });

  it('once suppression lifts, the replay reloads the scene from disk', async () => {
    setSceneReloadSuppressor(() => 'game is playing');
    emit(SCENE_PATH, 'scene');
    await settle();
    setSceneReloadSuppressor(null);
    await expect(replaySuppressedSceneReloads()).resolves.toBe(1);
    expect(loadScene).toHaveBeenCalledTimes(1);
    expect(loadScene.mock.calls[0][0]).toBe(SCENE_PATH);
    // Fresh bytes, not a snapshot: the handler re-fetched the file and handed THAT to the load.
    expect((loadScene.mock.calls[0][1] as { preloaded?: unknown }).preloaded).toEqual({ version: 7, entities: [] });
    expect(peekSuppressedSceneReloads()).toEqual([]);
  });

  it('a replay attempted while STILL suppressed keeps the entry for the next one', async () => {
    setSceneReloadSuppressor(() => 'the editor is in scrub mode');
    emit(SCENE_PATH, 'scene');
    await settle();
    await expect(replaySuppressedSceneReloads()).resolves.toBe(0);
    expect(loadScene).not.toHaveBeenCalled();
    expect(peekSuppressedSceneReloads()).toEqual([SCENE_PATH]);
  });
});

describe('the replay runs its reloads one at a time (#1164)', () => {
  // Reloads started together supersede each other and the winner does not carry the loser's
  // options, so a prefab reload that wins over a BASE reload leaves the base stale — measured live
  // with the first, fired-together version of this replay.
  it('a base-scene change and prefab changes: the base reload finishes before the next starts, and the prefabs collapse to one', async () => {
    const BASE_PATH = '/games/g/runtime/assets/Base.scene.json';
    vi.mocked(sceneManager.getLoadedScenes).mockReturnValue(new Map([
      ['main', { path: SCENE_PATH, role: 'primary', guid: 'main' }],
      ['base', { path: BASE_PATH, role: 'base', guid: 'base-guid' }],
    ]) as never);
    let inFlight = 0;
    let maxInFlight = 0;
    loadScene.mockImplementation(async () => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    setSceneReloadSuppressor(() => 'game is playing');
    emit(BASE_PATH, 'scene');
    emit(PREFAB_PATH, 'prefab');
    emit('/games/g/runtime/assets/Other.prefab.json', 'prefab');
    await settle();
    setSceneReloadSuppressor(null);

    await expect(replaySuppressedSceneReloads()).resolves.toBe(3);
    expect(maxInFlight, 'two replay reloads overlapped, so one superseded the other').toBe(1);
    expect(loadScene, 'one base reload + ONE reload for both prefabs').toHaveBeenCalledTimes(2);
    expect(loadScene.mock.calls[0][1]).toMatchObject({ forceReloadBases: ['base-guid'] });
    expect(getCachedPrefab(PREFAB_GUID), 'the non-last prefab was evicted too').toBeUndefined();
  });
});

describe('a change that becomes suppressed DURING its fetch is deferred again (#1164 review)', () => {
  // The suppression check runs before the handler's `await fetch`, and a Play press, an envelope or a
  // scene open can begin inside that await. Loading anyway would supersede the scene open or land in
  // the new run, with the change already off the pending list.
  it('the reload does not run, the change is held again, and nothing is evicted', async () => {
    fetchSuppressesOnScene = true; // the stub arms the suppressor while the scene bytes are fetched
    setSceneReloadSuppressor(() => 'game is playing');
    emit(PREFAB_PATH, 'prefab');
    emit('/games/g/runtime/assets/Other.prefab.json', 'prefab');
    await settle();
    setSceneReloadSuppressor(null);
    await expect(replaySuppressedSceneReloads()).resolves.toBe(2);
    expect(loadScene).not.toHaveBeenCalled();
    expect(peekSuppressedSceneReloads().sort(), 'both prefabs held again, not only the one replayed')
      .toEqual(['/games/g/runtime/assets/Other.prefab.json', PREFAB_PATH].sort());
    expect(getCachedPrefab(PREFAB_GUID), 'evicted although the reload was deferred into a run').toBeDefined();
  });
});

describe('a prefab change evicts the cached prefab before its reload (#1169)', () => {
  it('while stopped: the cache entry is gone by the time the scene reloads', async () => {
    let cachedAtLoad: unknown = 'not-called';
    loadScene.mockImplementation(async () => { cachedAtLoad = getCachedPrefab(PREFAB_GUID); });
    emit(PREFAB_PATH, 'prefab');
    await settle();
    expect(loadScene).toHaveBeenCalledTimes(1);
    expect(cachedAtLoad, 'the reload would have re-instantiated the OLD prefab from the cache').toBeUndefined();
    expect(refreshed, "the editor's own prefab copy (the override diff base) was not re-read").toEqual([PREFAB_PATH]);
  });

  // ⚠️ ACCEPT SIDE. Evicting during Play breaks the runtime's synchronous `getCachedPrefab` spawns,
  // so the eviction must wait with the reload — an eviction placed before the suppressor check (or
  // in ASSET_CACHE_INVALIDATORS) would pass the case above and fail this one.
  it('while suppressed: the cache is left alone, and the replay evicts it', async () => {
    setSceneReloadSuppressor(() => 'game is playing');
    emit(PREFAB_PATH, 'prefab');
    await settle();
    expect(getCachedPrefab(PREFAB_GUID), 'evicted mid-Play').toBeDefined();
    expect(refreshed, 'editor copy touched while the reload was suppressed').toEqual([]);
    expect(loadScene).not.toHaveBeenCalled();

    setSceneReloadSuppressor(null);
    let cachedAtLoad: unknown = 'not-called';
    loadScene.mockImplementation(async () => { cachedAtLoad = getCachedPrefab(PREFAB_GUID); });
    await expect(replaySuppressedSceneReloads()).resolves.toBe(1);
    expect(cachedAtLoad).toBeUndefined();
  });
});
