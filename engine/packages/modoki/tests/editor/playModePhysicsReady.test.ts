/** enterPlay waits for physics before it flips to 'playing' (#1175).
 *
 *  The scene load awaits Rapier for the bodies it spawns, but a body added in edit mode AFTER the
 *  load reaches Play cold — and the physics system skips every tick until the WASM lands, so Play's
 *  first frames ran with no physics. enterPlay now awaits it, BEFORE its scene-load generation
 *  re-check, so a load landing during the WASM fetch is refused like one landing mid-snapshot.
 *
 *  The loader is a controllable deferred (same `init`/`ready` surface) so the await window can be
 *  held open deterministically. Harness trimmed from playModeQueuedStop.test.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const rapier = vi.hoisted(() => ({ ready: false, release: null as (() => void) | null, current: null as Promise<void> | null }));
vi.mock('../../src/runtime/physics/rapierLoader', () => ({
  isRapierReady: () => rapier.ready,
  initRapier2D: () => {
    if (!rapier.current) {
      rapier.current = new Promise<void>((resolve) => { rapier.release = () => { rapier.ready = true; resolve(); }; });
    }
    return rapier.current;
  },
}));

const currentPath: string | null = '/assets/scenes/main.scene.json';
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    getCurrent: () => (currentPath === null ? null : { path: currentPath }),
    getLoadedScenes: () => new Map(),
    getNext: () => null,
    loadScene: vi.fn(async () => {}),
  },
}));
let loadGeneration = 0;
vi.mock('../../src/editor/scene/serialize', () => ({
  registerBeforeSceneLoad: () => {},
  serializeScene: async () => ({ version: 1, entities: [], resources: [] }),
  getCurrentScenePath: () => currentPath,
  sceneLoadGeneration: () => loadGeneration,
  isSceneLoadInFlight: () => false,
}));
vi.mock('../../src/editor/scene/timelinePreview', () => ({
  hasTimelinePreviewSession: () => false,
  isPreviewRestoreInFlight: () => false,
  cancelPreviewGestures: () => {},
  whenPreviewRestoresLanded: async () => {},
  endTimelinePreviewSession: async () => {},
  holdPreviewSessionsClosed: () => () => {},
  cancelPendingPreviewBegins: () => {},
}));
vi.mock('../../src/editor/panels/aiSettingsModel', () => ({
  fetchAiSettings: async () => ({}),
  getCachedAiSettings: () => ({}),
}));
vi.mock('../../src/editor/undo/undoManager', () => ({ undoDepth: () => 0, truncateUndoTo: vi.fn() }));
vi.mock('../../src/editor/editorJournal', () => ({ editorEmit: vi.fn() }));

const { enterPlay, stopPlay } = await import('../../src/editor/scene/playMode');
const { setPlayState, getPlayState, onPlayStateChange } = await import('../../src/runtime/core/playState');
const { createTestWorld } = await import('../../src/runtime/harness/createTestWorld');
const { RigidBody2D } = await import('../../src/runtime/traits/RigidBody2D');

let tw: ReturnType<typeof createTestWorld> | undefined;
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  rapier.ready = false; rapier.release = null; rapier.current = null;
  loadGeneration = 0;
  tw = createTestWorld({});
  tw.spawn(RigidBody2D());
  setPlayState('stopped');   // AFTER createTestWorld, which starts its world playing
});
afterEach(() => { setPlayState('stopped'); tw?.dispose(); tw = undefined; });

describe('enterPlay — physics readiness', () => {
  it('holds Play until Rapier2D is instantiated, and flips to playing with it ready', async () => {
    const readyWhenPlaying: boolean[] = [];
    const off = onPlayStateChange(() => { if (getPlayState() === 'playing') readyWhenPlaying.push(rapier.ready); });
    try {
      const p = enterPlay();
      await settle();
      expect(rapier.release, 'premise: enterPlay started the load').not.toBeNull();
      expect(getPlayState(), 'Play must not start while the WASM is loading').toBe('stopped');
      rapier.release!();
      await p;
    } finally { off(); }
    expect(getPlayState()).toBe('playing');
    expect(readyWhenPlaying).toEqual([true]);
  });

  it('a Stop pressed DURING the physics await is queued, not dropped — Play ends stopped', async () => {
    // The await sits inside `_entering`, so stopPlay sees "Play is starting" and queues (#470). An
    // await placed in front of enterPlay (the agent op's first shape) dropped this Stop instead.
    const p = enterPlay();
    await settle();
    expect(rapier.release, 'premise: enterPlay is waiting on the load').not.toBeNull();
    await stopPlay();
    rapier.release!();
    await p;
    expect(getPlayState()).toBe('stopped');
  });

  it('a scene load landing DURING the physics await refuses Play, like one landing mid-snapshot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = enterPlay();
      await settle();
      loadGeneration++;                 // a load lands while the WASM is still loading
      rapier.release!();
      await p;
    } finally { warn.mockRestore(); }
    expect(getPlayState()).toBe('stopped');
  });
});
