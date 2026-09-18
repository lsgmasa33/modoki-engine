// @vitest-environment jsdom
/** #1409 (close-out sibling): a scene HOT-RELOAD replaces the world from disk outside `loadScene`,
 *  and disk wins over unsaved edits (#1164). So it owes `loadScene`'s two rules: a dirty world's
 *  undo entries are dropped, and the reloaded world is the new clean baseline. Observed live before
 *  the fix on games/3d-test: reparent Fog → rewrite the scene file byte-identically → Fog back at the
 *  root, yet `undoLabel` still said 'Reparent "Fog" → Camera' and `unsavedChanges` stayed true.
 *
 *  Driven through the real `scene-changed` handler, over the fake Electron bridge
 *  `agentBridgeDeferredSceneReload.test.ts` uses. The real undo manager and the real
 *  `adoptWorldReloadedFromDisk` are installed through the real hook. Only the SceneManager load and
 *  `fetch` are stubbed, because a real load needs a renderer. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sceneManager, setRunMode } from '@modoki/engine/runtime';
import {
  pushAction, canUndo, undoLabel, hasUnsavedChanges, markSceneSaved, adoptWorldReloadedFromDisk,
} from '@modoki/engine/editor';
import { swapHistory, _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';
import { markSceneDirty, isSceneDirty, clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';

type Handler = (data: unknown) => void;
type Win = typeof window & { __modokiElectron?: { bridge?: unknown } };

const SCENE_PATH = '/games/g/runtime/assets/Main.scene.json';

const { initAgentBridge, setSceneReloadSuppressor, setWorldReloadedFromDiskHook, replaySuppressedSceneReloads } =
  await import('../../app/debug/agentBridge');

let handlers: Map<string, Handler[]>;
let loadScene: ReturnType<typeof vi.spyOn>;
const restores: (() => void)[] = [];
const noop = () => {};
const edit = (label: string) => pushAction({ label, undo: noop, redo: noop });

async function hotReload(): Promise<void> {
  for (const cb of handlers.get('scene-changed') ?? []) cb({ urlPath: SCENE_PATH, kind: 'scene' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  const win = window as Win;
  handlers = new Map();
  win.__modokiElectron = {
    bridge: {
      on: (event: string, cb: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), cb]); },
      send: vi.fn(),
    },
  };
  initAgentBridge();
  setWorldReloadedFromDiskHook(adoptWorldReloadedFromDisk);
  const getCurrent = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: SCENE_PATH } as never);
  const getLoaded = vi.spyOn(sceneManager, 'getLoadedScenes')
    .mockReturnValue(new Map([['main', { path: SCENE_PATH, role: 'primary', guid: 'main' }]]) as never);
  loadScene = vi.spyOn(sceneManager, 'loadScene').mockResolvedValue(undefined as never);
  const fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ version: 7, entities: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  restores.push(() => { getCurrent.mockRestore(); getLoaded.mockRestore(); loadScene.mockRestore(); fetchStub.mockRestore(); });

  setRunMode('stopped');
  _resetHistoryContexts();
  swapHistory(SCENE_PATH);
  markSceneSaved();
  clearAllSceneDirty();
});

afterEach(async () => {
  setSceneReloadSuppressor(null);
  await replaySuppressedSceneReloads();
  setWorldReloadedFromDiskHook(null);
  for (const r of restores.splice(0)) r();
  delete (window as Win).__modokiElectron;
});

describe('a hot reload over a dirty world drops its undo history (#1409)', () => {
  it('drops the dirty world\'s entries and rebaselines to clean', async () => {
    edit('Reparent "Fog" → Camera');
    expect(hasUnsavedChanges()).toBe(true);
    await hotReload();
    expect(loadScene, 'fixture: the reload ran').toHaveBeenCalledTimes(1);
    expect(canUndo()).toBe(false);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('keeps a CLEAN world\'s history — the file it reloaded still matches it', async () => {
    edit('Move');
    markSceneSaved();
    await hotReload();
    expect(undoLabel()).toBe('Move');
  });

  it('a DIRTY BASE scene keeps everything — its edits survive the reload live (second review)', async () => {
    // SceneManager KEEPS a base whose guid is unchanged, snapshotting its entities from the live
    // world, so its unsaved edits outlive a primary/prefab reload (pinned by the A7 case in
    // sceneManagerBaseSceneChain.test.ts). Clearing its flag made saveAll skip it: silent loss.
    const BASE = 'bbbbbbbb-0000-4000-8000-00000000ba5e';
    edit('Move base Camera');
    markSceneDirty(BASE);
    await hotReload();
    expect(loadScene, 'fixture: the reload ran').toHaveBeenCalledTimes(1);
    expect(isSceneDirty(BASE)).toBe(true);
    expect(hasUnsavedChanges()).toBe(true);
    expect(undoLabel()).toBe('Move base Camera');
  });

  it('an ABORTED reload (superseded by a newer one) replaced nothing, so it adopts nothing', async () => {
    loadScene.mockRejectedValueOnce(new DOMException('superseded', 'AbortError'));
    edit('Move');
    await hotReload();
    expect(loadScene, 'fixture: the reload was attempted').toHaveBeenCalledTimes(1);
    expect(undoLabel()).toBe('Move');
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('a SUPPRESSED reload touches nothing — the world was not replaced', async () => {
    setSceneReloadSuppressor(() => 'game is playing');
    edit('Move');
    await hotReload();
    expect(loadScene).not.toHaveBeenCalled();
    expect(undoLabel()).toBe('Move');
    expect(hasUnsavedChanges()).toBe(true);
  });
});
