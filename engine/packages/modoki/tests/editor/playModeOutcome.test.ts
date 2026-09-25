/** `enterPlay` / `stopPlay` say what they did (#1574).
 *
 *  Both used to return `Promise<void>`: every refusal was a `console.warn` and nothing else, so the
 *  agent `play`/`stop` ops — which cannot read the console — re-read the play state and answered
 *  `ok:true`, and a refused Play reads 'stopped' exactly like one nobody asked for. Each case below
 *  drives one refusal or skip through the REAL controller and asserts the outcome that names it.
 *  The op-side mapping (outcome → coded reply) is pinned in `engine/tests/framework/agentPlayOpReplies.test.ts`.
 *
 *  Stubs as in `timelinePreviewSession.test.ts`: a full serialize→loadScene round-trip is not
 *  loadable headlessly, so serialize and SceneManager are controllable fakes with the same contract. */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scenePath: 'A.json' as string | null,
  generation: 0,
  loadInFlight: false,
  serializeGate: null as Promise<void> | null,
  failLoad: false,
  openGate: null as (() => void) | null,
  aiCached: true,                                  // false = a cold first Play: enterPlay FETCHES the settings
  aiFetchGate: null as Promise<void> | null,
}));

vi.mock('../../src/editor/scene/serialize', () => ({
  registerBeforeSceneLoad: () => {},
  serializeScene: async () => {
    if (h.serializeGate) await h.serializeGate;
    return { entities: [] };
  },
  getCurrentScenePath: () => h.scenePath,
  sceneLoadGeneration: () => h.generation,
  isSceneLoadInFlight: () => h.loadInFlight,
}));
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    loadScene: async () => {
      if (h.failLoad) throw new Error('reload failed');
      return { keptBaseGuids: new Set<string>() };
    },
    getNext: () => null,
    getLoadedScenes: () => new Map(),
    getCurrent: () => ({ path: h.scenePath }),
  },
}));
vi.mock('../../src/editor/panels/aiSettingsModel', () => ({
  getCachedAiSettings: () => (h.aiCached ? { captureContactOnLaunch: false } : null),
  fetchAiSettings: async () => { if (h.aiFetchGate) await h.aiFetchGate; return { captureContactOnLaunch: false }; },
}));

import { enterPlay, stopPlay } from '../../src/editor/scene/playMode';
import { beginTimelinePreviewSession, hasTimelinePreviewSession, endTimelinePreviewSession } from '../../src/editor/scene/timelinePreview';
import { lastRestoreFailed } from '../../src/editor/scene/authoredSnapshot';
import { getPlayState, setPlayState, setRunMode } from '../../src/runtime/core/playState';
import { pushAction, undoDepth, clearHistory } from '../../src/editor/undo/undoManager';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.scenePath = 'A.json'; h.generation = 0; h.loadInFlight = false; h.serializeGate = null; h.failLoad = false;
  h.aiCached = true; h.aiFetchGate = null;
  setRunMode('stopped');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  // A case that failed before opening its gate must not leave `enterPlay` parked for the next one.
  h.openGate?.(); h.openGate = null;
  await new Promise<void>((r) => setTimeout(r, 0));
  h.serializeGate = null; h.failLoad = false; h.scenePath = 'A.json';
  if (getPlayState() !== 'stopped') await stopPlay();
  if (hasTimelinePreviewSession()) await endTimelinePreviewSession({ restore: false });
  // A restore that threw flags the world "not authored" until a world swap, which the fake
  // SceneManager never makes — make one, as a real reload from disk would.
  if (lastRestoreFailed()) {
    const { createWorld } = await import('koota');
    const { getCurrentWorld, setCurrentWorld } = await import('../../src/runtime/core/ecs/worldRegistry');
    const before = getCurrentWorld();
    const scratch = createWorld();
    setCurrentWorld(scratch); setCurrentWorld(before); scratch.destroy();
  }
  setRunMode('stopped');
  warn.mockRestore();
});

const gate = () => { let open!: () => void; h.serializeGate = new Promise<void>((r) => { open = r; }); h.openGate = open; return open; };
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('enterPlay — each refusal is named, not only warned', () => {
  it('a scene load in flight → refused: scene-swap', async () => {
    h.loadInFlight = true;
    expect(await enterPlay()).toEqual({ kind: 'refused', reason: 'scene-swap', message: expect.stringMatching(/scene load is still in flight/) });
    expect(getPlayState()).toBe('stopped');
    // The toolbar still gets its warn, and it is the same string the op replies with.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[Editor\] Play refused — a scene load is still in flight/));
  });

  it('after a restore that FAILED → refused: restore-failed', async () => {
    expect((await enterPlay()).kind).toBe('started');
    h.failLoad = true;
    await expect(stopPlay()).rejects.toThrow(/reload failed/);
    expect(lastRestoreFailed(), 'premise: the failed restore is flagged').toBe(true);
    const o = await enterPlay();
    expect(o).toMatchObject({ kind: 'refused', reason: 'restore-failed' });
    expect(getPlayState()).toBe('stopped');
  });

  it('a second Play while one is starting up → refused: already-starting, and the first still starts', async () => {
    const open = gate();
    const first = enterPlay();
    await settle();
    expect(await enterPlay()).toMatchObject({ kind: 'refused', reason: 'already-starting' });
    open();
    expect(await first).toEqual({ kind: 'started' });
    expect(getPlayState()).toBe('playing');
  });

  it('a scene load landing mid-snapshot → refused: load-landed', async () => {
    const open = gate();
    const p = enterPlay();
    await settle();
    h.generation++;                    // a load through the editor wrapper landed while serializing
    open();
    expect(await p).toMatchObject({ kind: 'refused', reason: 'load-landed' });
    expect(getPlayState()).toBe('stopped');
  });

  it('a Stop queued during startup → stopped-during-startup, reverted (and that Stop reports queued)', async () => {
    const open = gate();
    const p = enterPlay();
    await settle();
    expect(await stopPlay()).toEqual({ kind: 'queued' });
    open();
    expect(await p).toMatchObject({ kind: 'stopped-during-startup', reverted: true, message: expect.stringMatching(/back to the authored snapshot/) });
    expect(getPlayState()).toBe('stopped');
  });

  it('the queued Stop SKIPPED its revert → stopped-during-startup says reverted:false, with the Stop\'s reason', async () => {
    // Review finding: the tail discarded the inner Stop's outcome and always claimed the world was back.
    // Parked AFTER the snapshot (at a cold settings fetch): the snapshot already holds key A.json.
    h.aiCached = false;
    let open!: () => void;
    h.aiFetchGate = new Promise<void>((r) => { open = r; });
    h.openGate = open;
    const p = enterPlay();
    await settle();
    await stopPlay();                  // queued
    h.scenePath = 'B.json';            // the key moves with no load through the wrapper, so Play still arms
    open();
    expect(await p).toMatchObject({ kind: 'stopped-during-startup', reverted: false, message: expect.stringMatching(/without reverting: the scene changed during Play/) });
  });

  it('the queued Stop\'s restore THROWS → stopped-during-startup, reverted:false — the Play press resolves, it does not reject', async () => {
    // Review finding: the throw escaped the tail, so the agent `play` op threw (→ NOT_AVAILABLE_HERE).
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const open = gate();
      const p = enterPlay();
      await settle();
      await stopPlay();                // queued
      h.failLoad = true;
      open();
      expect(await p).toMatchObject({ kind: 'stopped-during-startup', reverted: false, message: expect.stringMatching(/restoring the authored world FAILED \(reload failed\)/) });
      expect(lastRestoreFailed()).toBe(true);
      expect(err).toHaveBeenCalled();
    } finally { err.mockRestore(); }
  });

  it('an edit made during a startup await is dropped from undo by Stop — the barrier is the snapshot\'s', async () => {
    // Re-review finding: the barrier was taken AFTER the settings fetch, so an edit made during it
    // stayed on the undo stack while Stop reverted it in the world — a phantom undo step.
    clearHistory();
    pushAction({ label: 'authored before Play', undo: () => {}, redo: () => {} });
    h.aiCached = false;
    let openFetch!: () => void;
    h.aiFetchGate = new Promise<void>((r) => { openFetch = r; });
    h.openGate = openFetch;
    const p = enterPlay();
    await settle();
    pushAction({ label: 'drag during startup', undo: () => {}, redo: () => {} });
    openFetch();
    expect(await p).toEqual({ kind: 'started' });
    await stopPlay();
    expect(undoDepth(), 'only the pre-Play entry survives Stop').toBe(1);
    clearHistory();
  });

  it('a load landing during a COLD settings fetch → refused: load-landed (the fetch is an await before the re-check)', async () => {
    // Review finding: the fetch sat AFTER the re-check, so a load landing during it armed Play over the new scene.
    h.aiCached = false;
    let openFetch!: () => void;
    h.aiFetchGate = new Promise<void>((r) => { openFetch = r; });
    h.openGate = openFetch;
    const p = enterPlay();
    await settle();
    h.generation++;
    openFetch();
    expect(await p).toMatchObject({ kind: 'refused', reason: 'load-landed' });
    expect(getPlayState()).toBe('stopped');
  });

  it('ACCEPT SIDE: started, then resumed from pause, then already-playing', async () => {
    expect(await enterPlay()).toEqual({ kind: 'started' });
    setPlayState('paused');
    expect(await enterPlay()).toEqual({ kind: 'resumed' });
    expect(await enterPlay()).toEqual({ kind: 'already-playing' });
  });
});

describe('stopPlay — says whether the revert happened', () => {
  it('ACCEPT SIDE: a Stop after Play reverts', async () => {
    await enterPlay();
    expect(await stopPlay()).toEqual({ kind: 'stopped', reverted: true });
  });

  it('the scene changed during Play → stopped, reverted:false, with the reason', async () => {
    await enterPlay();
    h.scenePath = 'B.json';
    expect(await stopPlay()).toEqual({ kind: 'stopped', reverted: false, reason: expect.stringMatching(/scene changed during Play/) });
  });

  it('playing with no snapshot (not entered through enterPlay) → reverted:false', async () => {
    setPlayState('playing');
    expect(await stopPlay()).toEqual({ kind: 'stopped', reverted: false, reason: expect.stringMatching(/no authored snapshot/) });
  });

  it('already stopped → already-stopped', async () => {
    expect(await stopPlay()).toEqual({ kind: 'already-stopped' });
  });

  it('a preview envelope whose scene changed → preview-exited, reverted:false', async () => {
    expect(await beginTimelinePreviewSession()).toBe(true);
    setRunMode('scrub');
    h.scenePath = 'B.json';
    expect(await stopPlay()).toEqual({ kind: 'preview-exited', reverted: false, reason: expect.stringMatching(/scene changed since the preview began/) });
  });

  it('ACCEPT SIDE: a preview envelope on the same scene → preview-exited, reverted:true', async () => {
    expect(await beginTimelinePreviewSession()).toBe(true);
    setRunMode('scrub');
    expect(await stopPlay()).toEqual({ kind: 'preview-exited', reverted: true });
  });
});
