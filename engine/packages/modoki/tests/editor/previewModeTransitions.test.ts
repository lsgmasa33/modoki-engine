/** preview-mode-refactor Phase 1 (+ review H1 ownership) — the editor scrub/preview run-mode
 *  transition funnel (`playMode.ts`). These pin:
 *    1. scrub/preview carry the RIGHT RunMode signal (so `get_editor_state` can report it), yet
 *    2. remain BYTE-IDENTICAL to today: both still derive to the legacy PlayState `'stopped'`, and
 *       a live/paused Play is NEVER downgraded to a preview/scrub by a stray transition; and
 *    3. OWNERSHIP: a panel's exit must not clobber a mode a DIFFERENT panel currently owns
 *       (the cross-panel save-guard defeat, review H1). */

import { describe, it, expect, afterEach } from 'vitest';
import {
  getRunMode, setRunMode, isAdvancing, getPlayState,
} from '../../src/runtime/systems/playState';
import { enterScrubMode, enterPreviewMode, exitPreviewMode, getModeOwner } from '../../src/editor/scene/playMode';

afterEach(() => { setRunMode('playing', { advancing: true }); }); // restore the runtime default

describe('editor preview/scrub run-mode transitions', () => {
  it('enterScrubMode sets scrub, which still derives to the legacy "stopped"', () => {
    setRunMode('stopped');
    enterScrubMode('timeline');
    expect(getRunMode()).toBe('scrub');
    expect(getPlayState()).toBe('stopped'); // byte-identical: no gate sees a change yet
  });

  it('enterPreviewMode carries advancing; a frozen preview reads advancing:false but still "stopped"', () => {
    setRunMode('stopped');
    enterPreviewMode(true, 'timeline');
    expect(getRunMode()).toBe('preview');
    expect(isAdvancing()).toBe(true);
    expect(getPlayState()).toBe('stopped');

    enterPreviewMode(false, 'timeline'); // pause → frozen preview frame
    expect(getRunMode()).toBe('preview');
    expect(isAdvancing()).toBe(false);
    expect(getPlayState()).toBe('stopped');
  });

  it('exitPreviewMode (same owner) returns scrub/preview to stopped, and is a no-op from stopped', () => {
    setRunMode('stopped');
    enterScrubMode('timeline');
    exitPreviewMode('timeline');
    expect(getRunMode()).toBe('stopped');
    expect(getModeOwner()).toBe(null);

    enterPreviewMode(false, 'timeline');
    exitPreviewMode('timeline');
    expect(getRunMode()).toBe('stopped');

    exitPreviewMode('timeline'); // already stopped → still stopped
    expect(getRunMode()).toBe('stopped');
  });

  it('OWNERSHIP (H1): a different panel must NOT tear down a live preview/scrub it does not own', () => {
    setRunMode('stopped');
    enterPreviewMode(true, 'timeline'); // Timeline ▶ preview live
    exitPreviewMode('animation');       // Animation panel mount/asset-switch/unmount fires this
    expect(getRunMode()).toBe('preview'); // preserved — not clobbered to stopped
    expect(getModeOwner()).toBe('timeline');

    exitPreviewMode('timeline');        // the OWNER exits → now it clears
    expect(getRunMode()).toBe('stopped');

    // Same for a scrub owned by the Animation panel vs a Timeline exit.
    enterScrubMode('animation');
    exitPreviewMode('timeline');
    expect(getRunMode()).toBe('scrub');
    exitPreviewMode('animation');
    expect(getRunMode()).toBe('stopped');
  });

  it('NEVER downgrades a live Play — enterScrub/enterPreview no-op while playing (guards the sim)', () => {
    setRunMode('playing', { advancing: true });
    enterScrubMode('timeline');
    expect(getRunMode()).toBe('playing'); // a ruler drag mid-Play must not stop the sim
    enterPreviewMode(true, 'timeline');
    expect(getRunMode()).toBe('playing');
  });

  it('NEVER downgrades a PAUSED Play either (RunMode is still "playing", advancing:false)', () => {
    setRunMode('playing', { advancing: false });
    enterScrubMode('timeline');
    expect(getRunMode()).toBe('playing');
    expect(isAdvancing()).toBe(false);
    enterPreviewMode(true, 'timeline');
    expect(getRunMode()).toBe('playing');
  });

  it('exitPreviewMode leaves a Play untouched (Stop owns play→stopped)', () => {
    setRunMode('playing', { advancing: true });
    exitPreviewMode('timeline');
    expect(getRunMode()).toBe('playing');
  });
});
