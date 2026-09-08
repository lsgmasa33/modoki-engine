/** RunMode (preview-mode-refactor Phase 0) — the unified run-state signal, plus the legacy
 *  PlayState API derived from it as an EXACT compat shim. These tests pin the derivation so the
 *  additive introduction is byte-identical (scrub/preview read back as 'stopped'; Play-paused reads
 *  back as 'paused') and the gate helpers match the intended per-mode behavior. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getRunMode, setRunMode, isAdvancing, getPlayState, setPlayState, isSimRunning,
  onPlayStateChange, onRunModeChange,
  shouldFireActions, shouldRunSimTier, isPoseOnly, isLiveRender, canEdit,
} from '../../src/runtime/core/playState';

afterEach(() => { setRunMode('playing', { advancing: true }); }); // restore the runtime default

describe('RunMode ↔ PlayState compat derivation', () => {
  it('playing/paused/stopped round-trip through the legacy setter/getter', () => {
    setPlayState('stopped');
    expect(getRunMode()).toBe('stopped');
    expect(getPlayState()).toBe('stopped');
    expect(isSimRunning()).toBe(false);

    setPlayState('playing');
    expect(getRunMode()).toBe('playing');
    expect(isAdvancing()).toBe(true);
    expect(getPlayState()).toBe('playing');
    expect(isSimRunning()).toBe(true);

    setPlayState('paused'); // == playing + frozen
    expect(getRunMode()).toBe('playing');
    expect(isAdvancing()).toBe(false);
    expect(getPlayState()).toBe('paused');
    expect(isSimRunning()).toBe(false); // paused → sim frozen (unchanged behavior)
  });

  it('scrub and preview read back as the legacy "stopped" (how they behave today)', () => {
    setRunMode('scrub');
    expect(getPlayState()).toBe('stopped');
    expect(isSimRunning()).toBe(false);

    setRunMode('preview');
    expect(getPlayState()).toBe('stopped');
    expect(isSimRunning()).toBe(false);
  });

  it('onPlayStateChange fires only when the DERIVED PlayState changes; onRunModeChange on any change', () => {
    setRunMode('stopped');
    let play = 0; let mode = 0;
    const offP = onPlayStateChange(() => { play++; });
    const offM = onRunModeChange(() => { mode++; });

    setRunMode('scrub');   // derived stays 'stopped' → NO play fire; mode fires
    expect(play).toBe(0);
    expect(mode).toBe(1);

    setRunMode('preview'); // derived stays 'stopped' → NO play fire; mode fires
    expect(play).toBe(0);
    expect(mode).toBe(2);

    setRunMode('playing'); // derived 'stopped' → 'playing' → both fire
    expect(play).toBe(1);
    expect(mode).toBe(3);

    setRunMode('playing', { advancing: false }); // 'playing' → 'paused' → both fire
    expect(play).toBe(2);
    expect(mode).toBe(4);

    setRunMode('playing', { advancing: false }); // no change → neither fires
    expect(play).toBe(2);
    expect(mode).toBe(4);

    offP(); offM();
  });

  it('gate helpers map each mode to the right decision', () => {
    setRunMode('stopped');
    expect([shouldFireActions(), shouldRunSimTier(), isPoseOnly(), isLiveRender(), canEdit()]).toEqual([false, false, false, false, true]);

    setRunMode('scrub');
    expect([shouldFireActions(), shouldRunSimTier(), isPoseOnly(), isLiveRender(), canEdit()]).toEqual([false, false, true, false, false]);

    setRunMode('preview');
    expect([shouldFireActions(), shouldRunSimTier(), isPoseOnly(), isLiveRender(), canEdit()]).toEqual([true, false, false, true, false]);

    setRunMode('preview', { advancing: false }); // paused preview → actions must NOT keep firing
    expect(shouldFireActions()).toBe(false);
    expect(isLiveRender()).toBe(true); // still renders the frozen frame

    setRunMode('playing');
    expect([shouldFireActions(), shouldRunSimTier(), isPoseOnly(), isLiveRender(), canEdit()]).toEqual([true, true, false, true, false]);

    setRunMode('playing', { advancing: false }); // paused Play
    expect([shouldFireActions(), shouldRunSimTier(), isLiveRender()]).toEqual([false, false, true]);
  });
});

describe('a throwing listener does not take out the other set (#888)', () => {
  // `setRunMode` assigns `_mode`/`_advancing` and THEN notifies two DIFFERENT sets in sequence —
  // play-state listeners, then run-mode listeners. Before the isolation, a throwing play-state
  // listener unwound out of `setRunMode` before the second loop ran at all: the mode had changed
  // and every run-mode subscriber in the engine missed the transition, permanently, because the
  // loop is not resumable and nothing retries it.
  it('a throwing PLAY listener still lets the RUN-MODE listeners fire', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setPlayState('stopped');            // a known starting state, so the transition below is real

    const modeSeen = vi.fn();
    const unsubThrow = onPlayStateChange(() => { throw new Error('listener boom'); });
    const unsubMode = onRunModeChange(modeSeen);

    expect(() => setRunMode('playing')).not.toThrow();
    expect(modeSeen).toHaveBeenCalled();

    unsubThrow();
    unsubMode();
    vi.restoreAllMocks();
  });

  it('a throwing listener does not starve the ones after it in its OWN set', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setPlayState('stopped');

    const after = vi.fn();
    const unsubThrow = onPlayStateChange(() => { throw new Error('listener boom'); });
    const unsubAfter = onPlayStateChange(after);

    setRunMode('playing');
    expect(after).toHaveBeenCalled();

    unsubThrow();
    unsubAfter();
    vi.restoreAllMocks();
  });
});
