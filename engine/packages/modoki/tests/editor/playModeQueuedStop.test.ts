/** Stop pressed WHILE Play is still starting up must not be a silent no-op.
 *
 *  `enterPlay()`'s re-entry guard (`getPlayState() === 'playing'`) only reads true after
 *  `setPlayState('playing')`, which is the LAST thing enterPlay does — but the snapshot capture
 *  before it awaits several times (ending a Timeline preview session, `serializeScene()`, a
 *  per-base `serializeScene()`, `fetchAiSettings()`). For that whole window `getPlayState()` still
 *  reads `'stopped'`, so `stopPlay()`'s own `'stopped'` early return made a Stop pressed during
 *  that window silently do nothing: the editor believed it had stopped, Play then started anyway,
 *  and every subsequent edit was later discarded as a during-Play mutation (issue #470).
 *
 *  The fix queues that Stop (`_stopRequested`) behind an in-flight latch (`_entering`) and honors
 *  it once `enterPlay()` reaches `'playing'`, by running the real `stopPlay()` revert. This pins:
 *  the queued Stop actually reverts and ends in `'stopped'`; the queue does not leak into the next
 *  Play; and a Stop with nothing in flight stays a plain no-op. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let currentPath: string | null = null;
// Normally resolves immediately; a test can flip `stallLoad` to make it stall on a controlled
// deferred promise instead — used to hold a Stop's OWN revert open so a second Stop can land
// while `_entering` is still true (the step-1-6 sequence from the coordinator's review).
let resolveLoad: (() => void) | null = null;
let stallLoad = false;
const loadScene = vi.fn(async (path: string, _opts?: unknown) => {
  currentPath = path;
  if (stallLoad) await new Promise<void>((resolve) => { resolveLoad = resolve; });
});
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    getCurrent: () => (currentPath === null ? null : { path: currentPath }),
    getLoadedScenes: () => new Map(),
    loadScene: (p: string, o: unknown) => loadScene(p, o as never),
  },
}));

// A deferred `serializeScene()` — one of the awaits enterPlay sits on before it flips to
// 'playing' — so a test can hold enterPlay mid-flight and fire a Stop into that window.
let resolveSerialize: (() => void) | null = null;
const SCENE = { version: 1, entities: [], resources: [] };
const serializeScene = vi.fn(async () => {
  await new Promise<void>((resolve) => { resolveSerialize = resolve; });
  return SCENE;
});
let filePath: string | null = '/assets/scenes/main.scene.json';
vi.mock('../../src/editor/scene/serialize', () => ({
  serializeScene: (...args: unknown[]) => serializeScene(...(args as [])),
  getCurrentScenePath: () => filePath,
}));

vi.mock('../../src/editor/scene/timelinePreview', () => ({
  hasTimelinePreviewSession: () => false,
  endTimelinePreviewSession: async () => {},
}));
vi.mock('../../src/editor/panels/aiSettingsModel', () => ({
  fetchAiSettings: async () => ({}),
  getCachedAiSettings: () => ({}),
}));
vi.mock('../../src/editor/undo/undoManager', () => ({ undoDepth: () => 0, truncateUndoTo: vi.fn() }));
vi.mock('../../src/editor/editorJournal', () => ({ editorEmit: vi.fn() }));

const { enterPlay, stopPlay, pausePlay } = await import('../../src/editor/scene/playMode');
const { setPlayState, getPlayState } = await import('../../src/runtime/core/playState');

beforeEach(() => {
  loadScene.mockClear();
  serializeScene.mockClear();
  resolveSerialize = null;
  resolveLoad = null;
  stallLoad = false;
  currentPath = '/assets/scenes/main.scene.json';
  filePath = '/assets/scenes/main.scene.json';
  setPlayState('stopped');
});

describe('Stop queued during an in-flight enterPlay (#470)', () => {
  it('a Stop pressed mid-startup ends the editor stopped, with the snapshot reverted', async () => {
    const playPromise = enterPlay(); // stalls inside serializeScene(), before setPlayState('playing')
    await vi.waitFor(() => expect(resolveSerialize).not.toBeNull());

    // getPlayState() still reads 'stopped' here — this is the exact window issue #470 lost a Stop in.
    expect(getPlayState()).toBe('stopped');
    const stopPromise = stopPlay(); // must queue, not no-op

    resolveSerialize!(); // let enterPlay proceed to 'playing' and then honor the queued Stop
    await playPromise;
    await stopPromise;

    expect(getPlayState(), 'the queued Stop must actually take effect').toBe('stopped');
    expect(loadScene, 'the revert path ran — the snapshot was reloaded').toHaveBeenCalledTimes(1);
  });

  it('a plain Stop with nothing running is still a no-op', async () => {
    expect(getPlayState()).toBe('stopped');
    await stopPlay();
    expect(getPlayState()).toBe('stopped');
    expect(loadScene, 'nothing to revert').not.toHaveBeenCalled();
  });

  it('a SECOND Stop landing during the queued stop\'s own revert does not poison the next Play', async () => {
    // The exact sequence from review: (1) Stop queued mid-startup, (2) the tail consumes it and
    // starts reverting, (3) revert is still in flight (state already flipped to 'stopped',
    // _entering still true because that revert runs INSIDE enterPlay's try), (4) a second Stop
    // arrives in that window and re-queues, (5) nothing left in enterPlay to consume it, so
    // without the `finally` clear it would sit and ambush the NEXT enterPlay().
    stallLoad = true;

    const playPromise = enterPlay(); // stalls in serializeScene()
    await vi.waitFor(() => expect(resolveSerialize).not.toBeNull());

    stopPlay(); // (1) first Stop — queues, returns synchronously without awaiting
    expect(getPlayState()).toBe('stopped');

    resolveSerialize!(); // enterPlay proceeds: reaches 'playing', then (2) its tail awaits stopPlay()
    // The tail's own stopPlay() flips state to 'stopped' immediately, then stalls inside loadScene().
    await vi.waitFor(() => expect(resolveLoad).not.toBeNull());
    expect(getPlayState(), 'the queued revert already flipped state back to stopped').toBe('stopped');

    const secondStop = stopPlay(); // (4) a second Stop, while the first revert is still in flight
    resolveLoad!(); // let the in-flight revert (and the second Stop, once it gets its turn) finish
    await secondStop;
    await playPromise;

    expect(getPlayState()).toBe('stopped');

    // (6) The next Play must reach 'playing' and STAY there — no stale _stopRequested ambush.
    stallLoad = false;
    const nextPlay = enterPlay();
    await vi.waitFor(() => expect(resolveSerialize).not.toBeNull());
    resolveSerialize!();
    await nextPlay;
    expect(getPlayState(), 'a stale queued stop must not fire against the NEXT legitimate Play')
      .toBe('playing');
  });
});

describe('enterPlay() re-entry refusal (adversarial review of #470)', () => {
  it('a SECOND enterPlay() arriving mid-startup is refused, not started', async () => {
    const first = enterPlay(); // stalls inside serializeScene()
    await vi.waitFor(() => expect(resolveSerialize).not.toBeNull());

    const second = enterPlay(); // _entering is already true — must return immediately, doing nothing
    await second;

    // The refusal must be synchronous and do no work of its own: only ONE serializeScene() call
    // exists (the first's), state is still mid-startup, and nothing was loaded.
    expect(serializeScene, 'the refused call never attempted its own snapshot').toHaveBeenCalledTimes(1);
    expect(getPlayState()).toBe('stopped');
    expect(loadScene).not.toHaveBeenCalled();

    resolveSerialize!();
    await first;
    expect(getPlayState()).toBe('playing');

    // The editor is coherent: the ONE snapshot the surviving call captured is still there to revert.
    await stopPlay();
    expect(getPlayState()).toBe('stopped');
    expect(loadScene, 'the survivor\'s snapshot reverted cleanly').toHaveBeenCalledTimes(1);
  });

  it('double Play + a Stop mid-startup ends stopped — not the _snapshot-null+playing corruption', async () => {
    // The coordinator's failure sequence: Play pressed twice, then Stop lands mid-startup. Before
    // the re-entry refusal, the second enterPlay() could reach 'playing' AFTER the first's queued
    // Stop had already reverted and cleared `_snapshot` — leaving the editor 'playing' with no
    // snapshot to revert on the NEXT Stop (silent data loss). With the refusal, the second call
    // never gets a chance to do any of that.
    const a = enterPlay(); // the only call that actually runs
    await vi.waitFor(() => expect(resolveSerialize).not.toBeNull());

    const b = enterPlay(); // refused synchronously — no-op
    await b;

    stopPlay(); // queues against A, mid-startup
    resolveSerialize!();
    await a; // A's tail reaches 'playing', then honors the queued Stop and reverts

    expect(getPlayState(), 'ends stopped, never the playing+no-snapshot corruption').toBe('stopped');

    // Prove the editor is genuinely coherent, not just reporting the right enum value: a fresh
    // Play → Stop cycle must still have a real snapshot to revert.
    const playAgain = enterPlay();
    await vi.waitFor(() => expect(resolveSerialize).not.toBeNull());
    resolveSerialize!();
    await playAgain;
    expect(getPlayState()).toBe('playing');
    await stopPlay();
    expect(getPlayState()).toBe('stopped');
    expect(loadScene, 'one revert from the queued Stop, one from this Stop').toHaveBeenCalledTimes(2);
  });

  it('a Play pressed during the tail\'s own revert is refused, not started against a mid-revert world', async () => {
    // Narrower variant needing no double-click: a Stop queued mid-startup is honored by the tail's
    // OWN `await stopPlay()`. While that revert is itself in flight, getPlayState() already reads
    // 'stopped' (stopPlay sets it before the async reload) but `_entering` is still true — a Play
    // pressed in that exact window must be refused, or its serializeScene() would capture the
    // mid-revert (partially play-mutated) world as the new "authored" snapshot.
    stallLoad = true;

    const playPromise = enterPlay(); // stalls in serializeScene()
    await vi.waitFor(() => expect(resolveSerialize).not.toBeNull());

    stopPlay(); // queues against the in-flight enterPlay
    resolveSerialize!(); // enterPlay reaches 'playing', then its tail awaits its own stopPlay()
    await vi.waitFor(() => expect(resolveLoad).not.toBeNull()); // that revert is now stalled in loadScene()

    expect(getPlayState(), 'mid-revert: state already reads stopped').toBe('stopped');

    const midRevertPlay = enterPlay(); // must be refused — _entering is still true
    await midRevertPlay;
    expect(serializeScene, 'no second snapshot was captured off the mid-revert world')
      .toHaveBeenCalledTimes(1);

    resolveLoad!();
    await playPromise;
    expect(getPlayState()).toBe('stopped');
  });
});

describe('pausePlay() refusal during Play startup (#513)', () => {
  it('a Pause pressed mid-startup is refused — the editor ends up playing, not paused', async () => {
    const playPromise = enterPlay(); // stalls inside serializeScene()
    await vi.waitFor(() => expect(resolveSerialize).not.toBeNull());

    expect(getPlayState()).toBe('stopped'); // the exact window pausePlay must refuse in
    pausePlay(); // must be refused, not silently no-op-because-not-playing-yet

    resolveSerialize!();
    await playPromise;

    expect(getPlayState(), 'Play won — a mid-startup Pause never took effect').toBe('playing');
  });

  it('a Pause AND a Stop both arriving during startup: the Stop (queued) wins, the Pause (refused) does not', async () => {
    const playPromise = enterPlay(); // stalls inside serializeScene()
    await vi.waitFor(() => expect(resolveSerialize).not.toBeNull());

    pausePlay(); // refused
    const stopPromise = stopPlay(); // queued

    resolveSerialize!();
    await playPromise;
    await stopPromise;

    expect(getPlayState(), 'the queued Stop still wins over the refused Pause').toBe('stopped');
    expect(loadScene, 'the Stop\'s revert actually ran').toHaveBeenCalledTimes(1);
  });

  it('a Pause after Play has genuinely started still works', async () => {
    const playPromise = enterPlay();
    await vi.waitFor(() => expect(resolveSerialize).not.toBeNull());
    resolveSerialize!();
    await playPromise;

    expect(getPlayState()).toBe('playing');
    pausePlay();
    expect(getPlayState()).toBe('paused');
  });
});
