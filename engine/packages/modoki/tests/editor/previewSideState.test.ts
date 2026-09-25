/** #1551 — the state OUTSIDE the world that ▶ preview actions change is put back when the session ends.
 *
 *  Against the REAL stores: the audio service's bus volumes and the mixer store that mirrors them,
 *  PlayerPrefs (in-memory backend), and the applied quality tier. Each case changes a store the way an
 *  engine action does (`audio.setBusVolume`, a game's prefs write, `quality.set`), then checks the
 *  restore puts it back — and that a store nobody changed is not written at all. */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { capturePreviewSideState, restorePreviewSideState } from '../../src/editor/scene/previewSideState';
import { getBusVolumes, setBusVolume } from '../../src/runtime/audio/audioService';
import { useAudioMixStore } from '../../src/runtime/actions/audioControls';
import { PlayerPrefs, InMemoryBackend, resetPlayerPrefsForTest } from '../../src/runtime/storage';
import { getActiveQualityTier, setActiveQualityTier } from '../../src/runtime/rendering/renderSettings';
import { applyQualityTier } from '../../src/runtime/rendering/tierCalibration';
import { onQualityTierChange, resetQualityTierChangeListeners } from '../../src/runtime/rendering/tierChangeNotify';

beforeEach(async () => {
  await PlayerPrefs.init({ namespace: 'preview-side-state', backend: new InMemoryBackend() });
  vi.spyOn(console, 'log').mockImplementation(() => {}); // applyQualityTier logs every switch
});
afterEach(() => {
  vi.restoreAllMocks();
  resetPlayerPrefsForTest();
  for (const bus of ['master', 'music', 'sfx', 'ui'] as const) setBusVolume(bus, 1);
  useAudioMixStore.getState().setBusPct('music', 100);
  setActiveQualityTier(null);
  resetQualityTierChangeListeners();
});

describe('capturePreviewSideState / restorePreviewSideState (#1551)', () => {
  it('puts back the bus volume, its mixer mirror, PlayerPrefs and the applied tier', () => {
    PlayerPrefs.set('kept', { a: 1 });
    PlayerPrefs.set('removed', 3);
    setActiveQualityTier({ tier: 'high', source: 'measured', reason: 'boot' });
    const snap = capturePreviewSideState();

    // What ▶ actions do: a cutscene ducks the music, a game writes prefs, `quality.set` picks a tier.
    setBusVolume('music', 0.2);
    useAudioMixStore.getState().setBusPct('music', 20);
    PlayerPrefs.set('kept', { a: 2 });
    PlayerPrefs.delete('removed');
    PlayerPrefs.set('added', true);
    applyQualityTier('low', 'player', 'player selected this tier');

    restorePreviewSideState(snap);

    // MUTATION TARGET: drop any one store from STORES and its line here fails.
    expect(getBusVolumes().music).toBe(1);
    expect(useAudioMixStore.getState().audioMusic).toBe(100);
    expect(useAudioMixStore.getState().audioMusicPct).toBe('100%');
    expect(PlayerPrefs.get('kept')).toEqual({ a: 1 });
    expect(PlayerPrefs.get('removed')).toBe(3);
    expect(PlayerPrefs.keys()).not.toContain('added');
    // Its own resolution, source and reason included — not "player selected this tier".
    expect(getActiveQualityTier()).toEqual({ tier: 'high', source: 'measured', reason: 'boot' });
  });

  it('a snapshot is a COPY — mutating a value read from PlayerPrefs cannot edit it', () => {
    PlayerPrefs.set('obj', { n: 1 });
    const snap = capturePreviewSideState();
    const live = PlayerPrefs.get<{ n: number }>('obj')!;
    live.n = 99;                                   // a caller mutating the object it read
    PlayerPrefs.set('obj', live);
    restorePreviewSideState(snap);
    expect(PlayerPrefs.get('obj')).toEqual({ n: 1 });
  });

  it('writes NOTHING when the preview changed nothing — no prefs write, no tier re-apply', () => {
    PlayerPrefs.set('k', 1);
    setActiveQualityTier({ tier: 'mid', source: 'measured', reason: 'boot' });
    const snap = capturePreviewSideState();
    const set = vi.spyOn(PlayerPrefs, 'set');
    const del = vi.spyOn(PlayerPrefs, 'delete');
    const tierChanged = vi.fn();
    onQualityTierChange(tierChanged);
    const mixSet = vi.spyOn(useAudioMixStore, 'setState');
    const tierBefore = getActiveQualityTier();
    // MUTATION TARGET: make any store restore unconditionally and one of these is called.
    restorePreviewSideState(snap);
    // A same-tier re-apply fires no change event, but it re-runs the renderer knobs (shadows, texture
    // cap, a resize of every surface) and replaces the live resolution with the snapshot's copy.
    expect(getActiveQualityTier()).toBe(tierBefore);
    expect(set).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(tierChanged).not.toHaveBeenCalled();
    expect(mixSet).not.toHaveBeenCalled();
  });

  it('a store that throws is logged and skipped — the others are still captured and restored', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(PlayerPrefs, 'keys').mockImplementationOnce(() => { throw new Error('prefs down'); });
    const snap = capturePreviewSideState();
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/could not capture PlayerPrefs/), expect.any(Error));
    setBusVolume('sfx', 0.5);
    PlayerPrefs.set('late', 1);                    // not captured → left alone, not deleted
    restorePreviewSideState(snap);
    expect(getBusVolumes().sfx).toBe(1);
    expect(PlayerPrefs.get('late')).toBe(1);
  });
});
