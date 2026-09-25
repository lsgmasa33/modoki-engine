// @vitest-environment jsdom
/** The recorder's start/abandon lifecycle (#1479): a Play that did not start must DISARM it —
 *  otherwise the next ordinary Play becomes the take, with the save, clock and scene of an earlier
 *  press — and an unsaved scene is refused, because the replay loads the scene from disk. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  unsaved: false,
  // The recorder reads a real PlayOutcome through pressPlay (#1577), so a stub returns one.
  enterPlay: (async () => ({ kind: 'started' })) as () => Promise<unknown>,
  stopPlay: (async () => ({ kind: 'stopped', reverted: true })) as () => Promise<unknown>,
}));

vi.mock('../../src/editor/scene/playMode', () => ({
  enterPlay: () => h.enterPlay(),
  stopPlay: () => h.stopPlay(),
}));
vi.mock('../../src/editor/scene/serialize', () => ({ hasUnsavedChanges: () => h.unsaved }));
vi.mock('../../src/runtime/managers/managerRegistry', () => ({ getActiveGameId: () => 'court' }));
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: { getCurrent: () => ({ path: '/assets/scenes/main.scene.json' }) },
}));

import { startTakeRecording, isRecordingTake, finishTakeRecording, getRecordingTakeTime } from '../../src/editor/recorder/takeRecorder';
import { createWorld } from 'koota';
import { Time } from '../../src/runtime/core/traits/Time';
import { timeSystem, resetTimeBaseline } from '../../src/runtime/core/timeSystem';
import { advanceManual, setManualNow, restoreRealClock } from '../../src/runtime/core/clock';
import { registerFrameCallback, unregisterFrameCallback, stepOneFrame } from '../../src/runtime/rendering/frameDriver';
import { getCurrentWorld, setCurrentWorld } from '../../src/runtime/core/ecs/worldRegistry';
import { setTimeScale } from '../../src/runtime/core/getTime';
import { getCaptureMode } from '../../src/runtime/core/captureMode';
import { getPlayState, setPlayState } from '../../src/runtime/core/playState';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { PlayerPrefs } from '../../src/runtime/storage/playerPrefs';

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

beforeEach(() => {
  // Node's own (flag-gated, empty) `localStorage` shadows jsdom's here; the snapshot only needs a store.
  vi.stubGlobal('localStorage', { length: 0, key: () => null, getItem: () => null });
  setPlayState('stopped');
  document.body.innerHTML = '<div data-game-view-area><div data-modoki-ui-root="runtime"></div></div>';
  h.unsaved = false;
  h.enterPlay = async () => { setPlayState('playing'); return { kind: 'started' }; };
  h.stopPlay = async () => { setPlayState('stopped'); return { kind: 'stopped', reverted: true }; };
  useEditorStore.setState({ toast: null });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await finishTakeRecording();
  setPlayState('stopped');
  vi.unstubAllGlobals();
});

describe('finishTakeRecording — the second ⏺ press stops Play (#1577)', () => {
  it('a Stop whose restore THROWS resolves (GameView voids it) and tells the human', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await startTakeRecording(NO_INSETS)).toBeNull();
    h.stopPlay = async () => { throw new Error('reload failed'); };
    await finishTakeRecording(); // a rejection here IS the failure — GameView's `void` would drop it
    expect(useEditorStore.getState().toast?.message).toContain('Stop could not restore the authored world (reload failed)');
  });

  // The take's Play reads 'stopped' until it reaches 'playing' — a second ⏺ in that window must still
  // STOP it (stopPlay queues behind the startup), or Play starts anyway, unrecorded.
  it('a second ⏺ while the take\'s Play is still starting stops that Play', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let stops = 0;
    h.enterPlay = async () => { await gate; return { kind: 'stopped-during-startup', reverted: true, message: 'stopped' }; };
    h.stopPlay = async () => { stops++; return { kind: 'queued' }; };
    const started = startTakeRecording(NO_INSETS);
    await new Promise((r) => setTimeout(r, 0));
    expect(isRecordingTake()).toBe(true);
    await finishTakeRecording();
    expect(stops).toBe(1);
    release();
    expect(await started).toMatch(/Stopped before the take began/);
    expect(useEditorStore.getState().toast).toBeNull(); // the take ended as asked — nothing to warn about
  });

  it('a Stop that skipped its revert says so', async () => {
    expect(await startTakeRecording(NO_INSETS)).toBeNull();
    h.stopPlay = async () => { setPlayState('stopped'); return { kind: 'stopped', reverted: false, reason: 'the scene changed during Play' }; };
    await finishTakeRecording();
    expect(useEditorStore.getState().toast).toMatchObject({ message: 'Stopped without reverting — the scene changed during Play.', kind: 'warn' });
  });
});

describe('startTakeRecording', () => {
  it('arms on a Play that actually started — capture mode on, recording', async () => {
    expect(await startTakeRecording(NO_INSETS)).toBeNull();
    expect(isRecordingTake()).toBe(true);
    expect(getCaptureMode()).toBe('recording');
    expect(getPlayState()).toBe('playing');
  });

  it('disarms when Play declines without throwing (a scene swap in flight)', async () => {
    h.enterPlay = async () => ({ kind: 'refused', reason: 'scene-swap', message: 'Play refused — a scene load is still in flight.' });
    expect(await startTakeRecording(NO_INSETS)).toMatch(/Play did not start/);
    expect(isRecordingTake()).toBe(false);
    expect(getCaptureMode()).toBe('off');
  });

  // ⏺ is a Play press to the human (#1577): the refusal reaches the editor toast, not only the
  // return value GameView logs to the console.
  it('a refused ⏺ tells the human why, through the toast', async () => {
    h.enterPlay = async () => ({ kind: 'refused', reason: 'scene-swap', message: 'Play refused — a scene load is still in flight.' });
    await startTakeRecording(NO_INSETS);
    expect(useEditorStore.getState().toast).toMatchObject({ message: 'Play refused — a scene load is still in flight.', kind: 'warn' });
  });

  // ▶ stays silent on its own double-press — but ⏺ ABANDONS the take on it, so it says why.
  it('a ⏺ refused because another Play is starting tells the human, and is not "Play did not start"', async () => {
    h.enterPlay = async () => ({ kind: 'refused', reason: 'already-starting', message: 'Play refused — another Play is still starting up.' });
    expect(await startTakeRecording(NO_INSETS)).toMatch(/another Play was already starting or running/);
    expect(useEditorStore.getState().toast).toMatchObject({ kind: 'warn' });
    expect(useEditorStore.getState().toast?.message).toMatch(/another Play was already starting or running/);
    expect(isRecordingTake()).toBe(false);
  });

  // ▶'s Play reached 'playing' while this ⏺ awaited the save flush: Play IS running on screen, so
  // "Play did not start" would be false.
  it.each(['already-playing', 'resumed'] as const)('a ⏺ that finds a Play already %s says so, not "did not start"', async (kind) => {
    h.enterPlay = async () => ({ kind });
    expect(await startTakeRecording(NO_INSETS)).toMatch(/another Play was already starting or running/);
    expect(useEditorStore.getState().toast?.message).toMatch(/another Play was already starting or running/);
  });

  it('a double-click on ⏺ before the take arms starts ONE take, not two', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    vi.spyOn(PlayerPrefs, 'flush').mockImplementation(() => gate);
    let plays = 0;
    h.enterPlay = async () => { plays++; setPlayState('playing'); return { kind: 'started' }; };
    const first = startTakeRecording(NO_INSETS);
    expect(await startTakeRecording(NO_INSETS)).toBe('already recording');
    release();
    expect(await first).toBeNull();
    expect(plays).toBe(1);
    expect(isRecordingTake()).toBe(true);
  });

  it('disarms when Play throws, and reports it instead of rejecting', async () => {
    h.enterPlay = async () => { throw new Error('serialize failed'); };
    expect(await startTakeRecording(NO_INSETS)).toMatch(/Play failed to start/);
    expect(isRecordingTake()).toBe(false);
    expect(getCaptureMode()).toBe('off');
  });

  it('refuses an unsaved scene — the replay loads it from disk', async () => {
    h.unsaved = true;
    expect(await startTakeRecording(NO_INSETS)).toMatch(/save the scene first/);
    expect(isRecordingTake()).toBe(false);
    expect(getCaptureMode()).toBe('off');
  });

  it('the take clock is the frames\' real time, summed — the axis the replay counts on', async () => {
    const prev = getCurrentWorld();
    const w = createWorld();
    w.spawn(Time());
    setCurrentWorld(w);
    setManualNow(0);
    resetTimeBaseline();
    registerFrameCallback('lifecycleSim', () => timeSystem(getCurrentWorld()), 0);
    try {
      expect(await startTakeRecording(NO_INSETS)).toBeNull();
      expect(getRecordingTakeTime()).toBe(0);
      for (let i = 0; i < 3; i++) { advanceManual(20); stepOneFrame(); }
      expect(getRecordingTakeTime()).toBeCloseTo(0.06, 9);
      // Slow-mo does not shorten the take: a video frame is 1/fps of REAL time.
      setTimeScale(w, 0.5);
      advanceManual(20); stepOneFrame();
      expect(getRecordingTakeTime()).toBeCloseTo(0.08, 9);
      // A scene load swaps in a fresh Time — the take clock carries on.
      const next = createWorld();
      next.spawn(Time());
      setCurrentWorld(next);
      advanceManual(20); stepOneFrame();
      expect(getRecordingTakeTime()).toBeCloseTo(0.1, 9);
      next.destroy();
    } finally {
      unregisterFrameCallback('lifecycleSim');
      restoreRealClock();
      setCurrentWorld(prev);
      w.destroy();
    }
  });
});

