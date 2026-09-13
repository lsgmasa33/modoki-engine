/** The editor's wiring of the deferred hot reload (#1164/#1169), through the REAL
 *  `registerEditorAgentOps` — the unit suites call `replaySuppressedSceneReloads` and subscribe spy
 *  listeners directly, so deleting any of the three lines below failed nothing (close-out review):
 *   - the suppressor also defers while a world-replacement token is held (a scene open or restore);
 *   - "authoring settled" drives the replay;
 *   - the editor's own prefab copy is RE-READ (not left empty) on an external prefab write.
 *  Driven through the `scene-changed` handler over a fake Electron bridge; `sceneManager` is stubbed
 *  only where a real load would need a renderer. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sceneManager, setRunMode, registerAsset, unregisterAsset } from '@modoki/engine/runtime';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { initAgentBridge, peekSuppressedSceneReloads, replaySuppressedSceneReloads } from '../../app/debug/agentBridge';
import { beginWorldReplacement } from '../../packages/modoki/src/editor/scene/authoringSettle';
import { setPrefabCache, getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefab';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';

registerEditorAgentOps();

type Handler = (data: unknown) => void;
type Win = typeof window & { __modokiElectron?: { bridge?: unknown } };
const SCENE_PATH = '/games/g/runtime/assets/Main.scene.json';
const PREFAB_GUID = 'c0ffee00-0000-4000-8000-0000000a1b2d';
const PREFAB_PATH = '/games/g/runtime/assets/Wired.prefab.json';

let handlers: Map<string, Handler[]>;
const restores: (() => void)[] = [];
let loadScene: ReturnType<typeof vi.spyOn>;
/** Per-case override of what a prefab fetch answers — null means the file reads back unparsable. */
let prefabFetch: (() => Response | Promise<Response>) | null = null;

function emit(urlPath: string, kind: string): void {
  for (const cb of handlers.get('scene-changed') ?? []) cb({ urlPath, kind });
}
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  setRunMode('stopped');
  handlers = new Map();
  (window as Win).__modokiElectron = {
    bridge: {
      on: (event: string, cb: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), cb]); },
      send: vi.fn(),
    },
  };
  initAgentBridge();
  const getCurrent = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: SCENE_PATH } as never);
  const getLoaded = vi.spyOn(sceneManager, 'getLoadedScenes')
    .mockReturnValue(new Map([['main', { path: SCENE_PATH, role: 'primary', guid: 'main' }]]) as never);
  loadScene = vi.spyOn(sceneManager, 'loadScene').mockResolvedValue(undefined as never);
  prefabFetch = null;
  const fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).includes('.prefab.json') && prefabFetch) return prefabFetch();
    return new Response(JSON.stringify(String(input).includes('.prefab.json')
      ? { id: PREFAB_GUID, name: 'New', entities: [] }
      : { version: 7, entities: [] }), { status: 200 });
  });
  restores.push(() => { getCurrent.mockRestore(); getLoaded.mockRestore(); loadScene.mockRestore(); fetchStub.mockRestore(); });
});

afterEach(async () => {
  setRunMode('stopped');
  await replaySuppressedSceneReloads();
  for (const r of restores.splice(0)) r();
  delete (window as Win).__modokiElectron;
});

describe('registerEditorAgentOps wires the deferred hot reload', () => {
  it('a change during Play is held, and the Stop edge replays it', async () => {
    setRunMode('playing');
    emit(SCENE_PATH, 'scene');
    await settle();
    expect(loadScene).not.toHaveBeenCalled();
    expect(peekSuppressedSceneReloads()).toEqual([SCENE_PATH]);
    setRunMode('stopped'); // no token held → settles → the installed listener replays
    await settle();
    expect(loadScene, 'nothing replayed the held change on settle').toHaveBeenCalledTimes(1);
  });

  it('while stopped, a held world-replacement token defers the change until it is released', async () => {
    const release = beginWorldReplacement();
    emit(SCENE_PATH, 'scene');
    await settle();
    expect(loadScene, 'reloaded under a scene open / restore').not.toHaveBeenCalled();
    release();
    await settle();
    expect(loadScene).toHaveBeenCalledTimes(1);
  });

  // ⚠️ RE-READ, not deleted: the sync readers (`serializePrefab`, the prefab-edit save) treat a miss as
  // "not a prefab" and flatten a nested instance. Prefab-edit mode is the case that bites, because no
  // reload follows there to refill a hole — so it is driven explicitly.
  for (const [label, current] of [['scene', SCENE_PATH], ['prefab-edit', '/__prefab-edit__/some-guid']] as const) {
    it(`an external prefab write re-reads the editor's own prefab copy in ${label} mode`, async () => {
      vi.mocked(sceneManager.getCurrent).mockReturnValue({ path: current } as never);
      registerAsset(PREFAB_GUID, PREFAB_PATH, 'prefab');
      try {
        setPrefabCache(PREFAB_GUID, { id: PREFAB_GUID, name: 'Old', entities: [] } as never);
        emit(PREFAB_PATH, 'prefab');
        await settle();
        expect(getCachedPrefabSync(PREFAB_GUID)?.name, 'stale diff base, or a hole a sync reader flattens').toBe('New');
      } finally {
        setPrefabCache(PREFAB_GUID, null);
        unregisterAsset(PREFAB_GUID);
      }
    });
  }

  async function withSeededOld(body: () => Promise<void>): Promise<void> {
    registerAsset(PREFAB_GUID, PREFAB_PATH, 'prefab');
    try {
      setPrefabCache(PREFAB_GUID, { id: PREFAB_GUID, name: 'Old', entities: [] } as never);
      await body();
    } finally {
      setPrefabCache(PREFAB_GUID, null);
      unregisterAsset(PREFAB_GUID);
      useEditorStore.setState({ editingPrefab: null });
    }
  }

  it('an unreadable file (a half-typed hand edit) keeps the old copy, and the fixed file is read next time', async () => {
    await withSeededOld(async () => {
      prefabFetch = () => new Response('{ "id": "trailing comma", }', { status: 200 });
      emit(PREFAB_PATH, 'prefab');
      await settle();
      expect(getCachedPrefabSync(PREFAB_GUID)?.name, 'a failed read left a hole').toBe('Old');
      prefabFetch = null; // the author fixes the typo and saves again
      emit(PREFAB_PATH, 'prefab');
      await settle();
      expect(getCachedPrefabSync(PREFAB_GUID)?.name, 'the key was skipped as cold after the failed read').toBe('New');
    });
  });

  it('an entry replaced DURING the refresh fetch (an Apply-to-Prefab) is not overwritten by the older bytes', async () => {
    await withSeededOld(async () => {
      prefabFetch = () => {
        setPrefabCache(PREFAB_GUID, { id: PREFAB_GUID, name: 'Applied', entities: [] } as never);
        return new Response(JSON.stringify({ id: PREFAB_GUID, name: 'New', entities: [] }), { status: 200 });
      };
      emit(PREFAB_PATH, 'prefab');
      await settle();
      expect(getCachedPrefabSync(PREFAB_GUID)?.name).toBe('Applied');
    });
  });

  it('the prefab OPEN in prefab-edit mode keeps the copy its save diffs against', async () => {
    await withSeededOld(async () => {
      vi.mocked(sceneManager.getCurrent).mockReturnValue({ path: '/__prefab-edit__/x' } as never);
      useEditorStore.setState({ editingPrefab: { guid: PREFAB_GUID, path: PREFAB_PATH, name: 'P' } });
      emit(PREFAB_PATH, 'prefab');
      await settle();
      expect(getCachedPrefabSync(PREFAB_GUID)?.name).toBe('Old');
    });
  });

  it('a prefab nobody has read stays cold — the refresh does not warm it', async () => {
    registerAsset(PREFAB_GUID, PREFAB_PATH, 'prefab');
    try {
      setPrefabCache(PREFAB_GUID, null);
      emit(PREFAB_PATH, 'prefab');
      await settle();
      expect(getCachedPrefabSync(PREFAB_GUID)).toBeNull();
    } finally {
      unregisterAsset(PREFAB_GUID);
    }
  });
});
