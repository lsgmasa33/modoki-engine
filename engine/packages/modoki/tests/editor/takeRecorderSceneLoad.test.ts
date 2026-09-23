// @vitest-environment jsdom
/** The editor recorder's take clock across a REAL mid-take scene load (#1486). The editor keeps
 *  ticking the old world through the async load, but the replay's settle gate waits the load out
 *  without stepping — so the recorder must count none of it either, or every event after the load
 *  replays early by however long this machine took to load. Its own file because it needs the real
 *  SceneManager, which `takeRecorderLifecycle.test.ts` mocks. */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/editor/scene/playMode', () => ({
  enterPlay: async () => { (await import('../../src/runtime/core/playState')).setPlayState('playing'); },
  stopPlay: async () => {},
}));
vi.mock('../../src/editor/scene/serialize', () => ({ hasUnsavedChanges: () => false }));
vi.mock('../../src/runtime/managers/managerRegistry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getActiveGameId: () => 'court',
}));

import { startTakeRecording, finishTakeRecording, getRecordingTakeTime } from '../../src/editor/recorder/takeRecorder';
import { sceneManager } from '../../src/runtime/scene/SceneManager';
import { timeSystem, resetTimeBaseline } from '../../src/runtime/core/timeSystem';
import { advanceManual, setManualNow, restoreRealClock } from '../../src/runtime/core/clock';
import { registerFrameCallback, unregisterFrameCallback, stepOneFrame } from '../../src/runtime/rendering/frameDriver';
import { getCurrentWorld } from '../../src/runtime/core/ecs/worldRegistry';
import { setPlayState } from '../../src/runtime/core/playState';

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };
const empty = () => ({ preloaded: { version: 8, resources: [], entities: [] } as never });

afterEach(async () => {
  await finishTakeRecording();
  setPlayState('stopped');
  unregisterFrameCallback('sceneLoadSim');
  unregisterFrameCallback('sceneLoadStarter');
  restoreRealClock();
  vi.unstubAllGlobals();
});

describe('take clock across a mid-take scene load (editor half)', () => {
  it('counts the frame that starts the load, none while it is in flight, and resumes after the swap', async () => {
    vi.stubGlobal('localStorage', { length: 0, key: () => null, getItem: () => null });
    document.body.innerHTML = '<div data-game-view-area><div data-modoki-ui-root="runtime"></div></div>';
    await sceneManager.loadScene('/assets/scenes/a.scene.json', empty());
    setManualNow(0);
    resetTimeBaseline();
    registerFrameCallback('sceneLoadSim', () => timeSystem(getCurrentWorld()), 0);

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const hook = () => held;
    sceneManager.registerBeforeSwap(hook);
    let load: Promise<unknown> | null = null;
    let startLoad = false;
    // A game system starting a level change mid-frame — before the recorder's callback (priority 5).
    registerFrameCallback('sceneLoadStarter', () => {
      if (startLoad && !load) load = sceneManager.loadScene('/assets/scenes/b.scene.json', empty());
    }, 1);
    try {
      setPlayState('stopped');   // the runtime boots playing; a take records from the Play press
      expect(await startTakeRecording(NO_INSETS)).toBeNull();
      advanceManual(20); stepOneFrame();
      expect(getRecordingTakeTime()).toBeCloseTo(0.02, 9);
      startLoad = true;
      // The frame that starts the load counts — it began with no load in flight, and the replay's
      // step for it is a timed frame too.
      advanceManual(20); stepOneFrame();
      expect(sceneManager.getNext()).not.toBeNull();
      expect(getRecordingTakeTime()).toBeCloseTo(0.04, 9);
      // Two more while it is in flight: the old world is still ticking at display rate, which is
      // exactly the time the replay never sees.
      for (let i = 0; i < 2; i++) { advanceManual(20); stepOneFrame(); }
      expect(getRecordingTakeTime()).toBeCloseTo(0.04, 9);
      release();
      await load;
      advanceManual(20); stepOneFrame();
      expect(getRecordingTakeTime()).toBeCloseTo(0.06, 9);
    } finally {
      // Even when an assertion failed first — a load left in flight leaks into the next test.
      release();
      await load;
      sceneManager.unregisterBeforeSwap(hook);
    }
  });
});
