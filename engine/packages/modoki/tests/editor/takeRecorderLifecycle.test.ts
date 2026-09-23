// @vitest-environment jsdom
/** The recorder's start/abandon lifecycle (#1479): a Play that did not start must DISARM it —
 *  otherwise the next ordinary Play becomes the take, with the save, clock and scene of an earlier
 *  press — and an unsaved scene is refused, because the replay loads the scene from disk. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  unsaved: false,
  enterPlay: (async () => {}) as () => Promise<void>,
}));

vi.mock('../../src/editor/scene/playMode', () => ({
  enterPlay: () => h.enterPlay(),
  stopPlay: async () => {},
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

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

beforeEach(() => {
  // Node's own (flag-gated, empty) `localStorage` shadows jsdom's here; the snapshot only needs a store.
  vi.stubGlobal('localStorage', { length: 0, key: () => null, getItem: () => null });
  setPlayState('stopped');
  document.body.innerHTML = '<div data-game-view-area><div data-modoki-ui-root="runtime"></div></div>';
  h.unsaved = false;
  h.enterPlay = async () => { setPlayState('playing'); };
});
afterEach(async () => {
  await finishTakeRecording();
  setPlayState('stopped');
  vi.unstubAllGlobals();
});

describe('startTakeRecording', () => {
  it('arms on a Play that actually started — capture mode on, recording', async () => {
    expect(await startTakeRecording(NO_INSETS)).toBeNull();
    expect(isRecordingTake()).toBe(true);
    expect(getCaptureMode()).toBe('recording');
    expect(getPlayState()).toBe('playing');
  });

  it('disarms when Play declines without throwing (a scene swap in flight)', async () => {
    h.enterPlay = async () => {};
    expect(await startTakeRecording(NO_INSETS)).toMatch(/Play did not start/);
    expect(isRecordingTake()).toBe(false);
    expect(getCaptureMode()).toBe('off');
  });

  it('disarms when Play throws, and reports it instead of rejecting', async () => {
    h.enterPlay = async () => { throw new Error('serialize failed'); };
    expect(await startTakeRecording(NO_INSETS)).toMatch(/Play failed to start: serialize failed/);
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

