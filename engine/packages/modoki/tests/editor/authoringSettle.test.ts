/** "Authoring has settled" must not fire until a world-replacing load has LANDED (#1164).
 *
 *  The consumer is the deferred hot-reload replay (`agentBridge.replaySuppressedSceneReloads`), which
 *  loads the scene. Stop flips the run mode to 'stopped' BEFORE its snapshot restore loads, so a
 *  listener keyed on the bare mode edge starts its load under the restore: SceneManager supersedes
 *  one with the other, and either the replay is lost again or the restore is. So the observable in
 *  every case below is ORDER: had the restore's load resolved by the time the listener ran?
 *
 *  Real `playState` and real `authoringSettle`; SceneManager/serialize are stubbed only so the
 *  restore's load can be held open. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let currentPath: string | null = '/assets/scenes/main.scene.json';
let releaseLoad: (() => void) | null = null;
let loadsResolved = 0;
const loadScene = vi.fn(async (path: string) => {
  currentPath = path;
  await new Promise<void>((resolve) => { releaseLoad = resolve; });
  loadsResolved += 1;
});
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    getCurrent: () => (currentPath === null ? null : { path: currentPath }),
    getLoadedScenes: () => new Map(),
    getNext: () => null,
    loadScene: (p: string) => loadScene(p),
  },
}));
const SCENE = { version: 1, entities: [], resources: [] };
vi.mock('../../src/editor/scene/serialize', () => ({
  registerBeforeSceneLoad: () => {},
  serializeScene: async () => SCENE,
  getCurrentScenePath: () => '/assets/scenes/main.scene.json',
  sceneLoadGeneration: () => 0,
  isSceneLoadInFlight: () => false,
}));
vi.mock('../../src/editor/scene/timelinePreview', () => ({
  hasTimelinePreviewSession: () => false,
  isPreviewRestoreInFlight: () => false,
  cancelPreviewGestures: () => {},
  whenPreviewRestoresLanded: async () => {},
  endTimelinePreviewSession: async () => null,
  holdPreviewSessionsClosed: () => () => {},
  cancelPendingPreviewBegins: () => {},
}));
vi.mock('../../src/editor/panels/aiSettingsModel', () => ({
  fetchAiSettings: async () => ({}),
  getCachedAiSettings: () => ({}),
}));
vi.mock('../../src/editor/undo/undoManager', () => ({ undoDepth: () => 0, truncateUndoTo: vi.fn(), registerUndoRestoreBarrier: () => {} }));
vi.mock('../../src/editor/editorJournal', () => ({ editorEmit: vi.fn() }));

const { enterPlay, stopPlay } = await import('../../src/editor/scene/playMode');
const { setPlayState, setRunMode, getPlayState } = await import('../../src/runtime/core/playState');
const { onAuthoringSettled, beginWorldReplacement, isWorldReplacementInFlight } = await import('../../src/editor/scene/authoringSettle');

let unsubscribe: (() => void) | null = null;
beforeEach(() => {
  setPlayState('stopped');
  loadScene.mockClear();
  releaseLoad = null;
  loadsResolved = 0;
  currentPath = '/assets/scenes/main.scene.json';
});
afterEach(() => { unsubscribe?.(); unsubscribe = null; });

describe('authoringSettle — the signal itself', () => {
  it('fires on the edge back to stopped when nothing holds a token', () => {
    setRunMode('scrub');
    const fired = vi.fn();
    unsubscribe = onAuthoringSettled(fired);
    setRunMode('stopped');
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('a held token swallows the stopped edge, and its release fires instead', () => {
    setRunMode('scrub');
    const fired = vi.fn();
    unsubscribe = onAuthoringSettled(fired);
    const release = beginWorldReplacement();
    setRunMode('stopped');
    expect(fired, 'the edge landed while a replacement was in flight').not.toHaveBeenCalled();
    release();
    expect(fired).toHaveBeenCalledTimes(1);
    release(); // idempotent: a second release neither fires nor drives the count negative
    expect(fired).toHaveBeenCalledTimes(1);
    expect(isWorldReplacementInFlight()).toBe(false);
  });

  it('a release while NOT stopped does not fire — the later stopped edge does', () => {
    setRunMode('scrub');
    const fired = vi.fn();
    unsubscribe = onAuthoringSettled(fired);
    beginWorldReplacement()();
    expect(fired, 'still inside an envelope').not.toHaveBeenCalled();
    setRunMode('stopped');
    expect(fired).toHaveBeenCalledTimes(1);
  });
});

describe('stopPlay holds the token across its snapshot restore (#1164)', () => {
  it('settle fires only AFTER the restore load resolves', async () => {
    const playing = enterPlay();
    await playing;
    expect(getPlayState()).toBe('playing');

    const seenAtSettle: number[] = [];
    unsubscribe = onAuthoringSettled(() => { seenAtSettle.push(loadsResolved); });

    const stopping = stopPlay();
    // The mode is already 'stopped' here and the restore load is parked — the exact window.
    await vi.waitFor(() => expect(releaseLoad).not.toBeNull());
    expect(getPlayState()).toBe('stopped');
    expect(seenAtSettle, 'settled while the snapshot restore was still loading').toEqual([]);

    releaseLoad!();
    await stopping;
    expect(seenAtSettle, 'exactly one settle, after the restore landed').toEqual([1]);
  });
});
