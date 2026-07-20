/** RunMode (preview-mode-refactor Phase 0) — the unified run-state signal, plus the legacy
 *  PlayState API derived from it as an EXACT compat shim. These tests pin the derivation so the
 *  additive introduction is byte-identical (scrub/preview read back as 'stopped'; Play-paused reads
 *  back as 'paused') and the gate helpers match the intended per-mode behavior. */

import { describe, it, expect, afterEach } from 'vitest';
import {
  getRunMode, setRunMode, isAdvancing, getPlayState, setPlayState, isSimRunning,
  onPlayStateChange, onRunModeChange,
  shouldFireActions, shouldRunSimTier, isPoseOnly, isLiveRender, canEdit,
} from '../../src/runtime/systems/playState';

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
