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
} from '../../src/runtime/core/playState';
import {
  enterScrubMode, enterPreviewMode, exitPreviewMode, getModeOwner, registerModeOwnerDisplaced,
} from '../../src/editor/scene/playMode';

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

  describe('displacement notification (#810)', () => {
    it('tells the DISPLACED owner it lost the mode, exactly once, when a different owner enters', () => {
      setRunMode('stopped');
      let calls = 0;
      const unregister = registerModeOwnerDisplaced('timeline', () => { calls += 1; });
      enterPreviewMode(true, 'timeline');
      expect(calls).toBe(0); // taking your OWN first mode is not a displacement
      enterScrubMode('animation'); // displaces the Timeline
      expect(calls).toBe(1);
      unregister();
    });

    it('does NOT notify when the SAME owner re-enters (no displacement occurred)', () => {
      setRunMode('stopped');
      let calls = 0;
      registerModeOwnerDisplaced('timeline', () => { calls += 1; });
      enterScrubMode('timeline');
      enterPreviewMode(true, 'timeline'); // same owner, scrub → preview
      expect(calls).toBe(0);
    });

    it('a displacement callback that THROWS does not prevent the transition from completing', () => {
      setRunMode('stopped');
      enterPreviewMode(true, 'timeline');
      registerModeOwnerDisplaced('timeline', () => { throw new Error('boom'); });
      expect(() => enterScrubMode('animation')).not.toThrow();
      expect(getRunMode()).toBe('scrub');
      expect(getModeOwner()).toBe('animation');
    });

    it('ORDERING: a callback re-entering the review-L1 guard sees the NEW mode and declines (scrub displacer)', () => {
      // ⚠️ Only for a SCRUB displacer. With a PREVIEW displacer `getRunMode()` reads 'preview',
      // the guard PASSES and the transition is clobbered — the ordering is necessary, not
      // sufficient. See `notifyDisplaced`'s doc in playMode.ts: what makes production safe is
      // that no registered callback re-enters a mode transition at all.
      setRunMode('stopped');
      enterPreviewMode(true, 'timeline');
      registerModeOwnerDisplaced('timeline', () => {
        if (getRunMode() === 'preview') enterPreviewMode(false, 'timeline'); // the guard from TimelineEditor's cleanup
      });
      enterScrubMode('animation');
      expect(getRunMode()).toBe('scrub'); // NOT clobbered back to preview
      expect(getModeOwner()).toBe('animation');
    });

    it('unregister stops future notifications', () => {
      setRunMode('stopped');
      let calls = 0;
      const unregister = registerModeOwnerDisplaced('timeline', () => { calls += 1; });
      unregister();
      enterPreviewMode(true, 'timeline');
      enterScrubMode('animation');
      expect(calls).toBe(0);
    });
  });
});
