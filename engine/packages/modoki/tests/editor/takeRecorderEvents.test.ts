// @vitest-environment jsdom
/** What a saved take carries for the render (#1488): the game events played between the Play press
 *  and Stop (`expectedEvents`, the replay check's expectation), and the take-saved event the render
 *  dialog opens from — on BOTH Stop paths, the Record button and the Play toolbar's Stop. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  written: [] as { url: string; body: string }[],
  /** What `POST /api/record/fingerprint` answers (#1509): a body, or null for a failed request. */
  fingerprint: null as unknown,
  fingerprintAsked: 0,
}));

vi.mock('../../src/editor/scene/playMode', async () => {
  const ps = await import('../../src/runtime/core/playState');
  return { enterPlay: async () => { ps.setPlayState('playing'); }, stopPlay: async () => { ps.setPlayState('stopped'); } };
});
vi.mock('../../src/editor/scene/serialize', () => ({ hasUnsavedChanges: () => false }));
vi.mock('../../src/runtime/managers/managerRegistry', () => ({ getActiveGameId: () => 'court' }));
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: { getCurrent: () => ({ path: '/assets/scenes/main.scene.json' }) },
}));
vi.mock('../../src/editor/backend/editorBackend', () => ({
  backendFetch: async (url: string) => {
    if (url !== '/api/record/fingerprint') return { ok: true, json: async () => ({ projectRoot: '/proj' }) };
    h.fingerprintAsked++;
    return h.fingerprint === null ? { ok: false, status: 500, json: async () => ({ error: 'boom' }) } : { ok: true, json: async () => h.fingerprint };
  },
  jsonFileBody: (x: unknown) => JSON.stringify(x),
  writeAssetFile: async (url: string, body: string) => { h.written.push({ url, body }); return true; },
}));

import { startTakeRecording, finishTakeRecording, onTakeSaved, type SavedTake } from '../../src/editor/recorder/takeRecorder';
import { createWorld, type World } from 'koota';
import { Time } from '../../src/runtime/core/traits/Time';
import { timeSystem, resetTimeBaseline } from '../../src/runtime/core/timeSystem';
import { advanceManual, setManualNow, restoreRealClock } from '../../src/runtime/core/clock';
import { registerFrameCallback, unregisterFrameCallback, stepOneFrame } from '../../src/runtime/rendering/frameDriver';
import { getCurrentWorld, setCurrentWorld } from '../../src/runtime/core/ecs/worldRegistry';
import { setPlayState } from '../../src/runtime/core/playState';
import { emit } from '../../src/runtime/core/journal';
import { stopPlay } from '../../src/editor/scene/playMode';

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };
let prev: World;
let w: World;

beforeEach(() => {
  vi.stubGlobal('localStorage', { length: 0, key: () => null, getItem: () => null });
  setPlayState('stopped');
  document.body.innerHTML = '<div data-game-view-area><div data-modoki-ui-root="runtime"></div></div>';
  h.written = [];
  h.fingerprint = null;
  h.fingerprintAsked = 0;
  prev = getCurrentWorld();
  w = createWorld();
  w.spawn(Time());
  setCurrentWorld(w);
  setManualNow(0);
  resetTimeBaseline();
  registerFrameCallback('eventsSim', () => timeSystem(getCurrentWorld()), 0);
});
afterEach(async () => {
  await finishTakeRecording();
  unregisterFrameCallback('eventsSim');
  restoreRealClock();
  setCurrentWorld(prev);
  w.destroy();
  setPlayState('stopped');
  vi.unstubAllGlobals();
});

const frame = () => { advanceManual(20); stepOneFrame(); };

describe('expectedEvents', () => {
  it('holds the game events emitted from the Play press to Stop, on the take clock — and nothing from before', async () => {
    emit('while-editing', null, w);
    expect(await startTakeRecording(NO_INSETS)).toBeNull();
    frame();
    emit('court.place', { cell: 'a2' }, w);
    frame();
    emit('@spawn', null, w);
    emit('court.heart.lost', { left: 2 }, w);
    // Emitted after the last frame, before Stop: still part of the take.
    emit('court.win', null, w);
    const file = await finishTakeRecording();
    expect(file).toBe('/proj/recordings/' + file!.split('/').pop());
    const take = JSON.parse(h.written[0].body);
    expect(take.expectedEvents.map((e: { type: string }) => e.type)).toEqual(['court.place', 'court.heart.lost', 'court.win']);
    // Stamped at the drain AFTER it — the frame that follows, as the replay driver stamps it too.
    expect(take.expectedEvents[0]).toEqual({ t: expect.closeTo(0.04, 9), type: 'court.place', payload: { cell: 'a2' } });
    expect(take.expectedEvents[2].t).toBeCloseTo(0.04, 9);
  });

  it('keeps an emission\'s app-lifetime mark, and adds none to the others (#1527)', async () => {
    expect(await startTakeRecording(NO_INSETS)).toBeNull();
    frame();
    emit('court.store.products', { summary: '6/6' }, w, 'info', { appLifetime: true });
    emit('court.store.products', { summary: '6/6' }, w);
    frame();
    await finishTakeRecording();
    const take = JSON.parse(h.written[0].body);
    expect(take.expectedEvents.map((e: { appLifetime?: boolean }) => e.appLifetime)).toEqual([true, undefined]);
    // The take says its events carry marks, so its render does not fall back to #1524's whole-type skip.
    expect(take.appLifetimeMarks).toBe(true);
    expect(Object.hasOwn(take.expectedEvents[1], 'appLifetime')).toBe(false);
  });
});

describe('onTakeSaved', () => {
  it('fires when the Record button stops the take', async () => {
    const saved: SavedTake[] = [];
    const off = onTakeSaved((s) => saved.push(s));
    try {
      await startTakeRecording(NO_INSETS);
      frame();
      const file = await finishTakeRecording();
      expect(saved).toEqual([{ file, take: expect.objectContaining({ game: 'court', scene: 'main.scene.json' }) }]);
    } finally { off(); }
  });

  it('fires when the Play toolbar\'s Stop ends the take — the other path to the dialog', async () => {
    const saved: SavedTake[] = [];
    const off = onTakeSaved((s) => saved.push(s));
    try {
      await startTakeRecording(NO_INSETS);
      frame();
      await stopPlay();
      await vi.waitFor(() => expect(saved).toHaveLength(1));
    } finally { off(); }
  });

  it('does not fire when nothing was recorded', async () => {
    const saved: SavedTake[] = [];
    const off = onTakeSaved((s) => saved.push(s));
    try {
      await startTakeRecording(NO_INSETS);
      await finishTakeRecording();
      expect(saved).toEqual([]);
    } finally { off(); }
  });
});

describe('the asset fingerprint (#1509)', () => {
  it("is asked for at the Play press and saved in the take, for the render to compare against", async () => {
    const fp = { dir: 'runtime/assets', files: { 'scenes/main.scene.json': '0123456789abcdef' } };
    h.fingerprint = fp;
    expect(await startTakeRecording(NO_INSETS)).toBeNull();
    // Requested when recording starts, not when the take is written: hashing runs while the owner plays.
    expect(h.fingerprintAsked).toBe(1);
    frame();
    await finishTakeRecording();
    expect(JSON.parse(h.written[0].body).assets).toEqual(fp);
  });

  it('still saves the take when the fingerprint fails — the render then reports the check unchecked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await startTakeRecording(NO_INSETS)).toBeNull();
      frame();
      expect(await finishTakeRecording()).not.toBeNull();
      const take = JSON.parse(h.written[0].body);
      expect(take).not.toHaveProperty('assets');
      expect(take.events).toBeDefined();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no asset fingerprint/), 500);
    } finally { warn.mockRestore(); }
  });
});
