/** #810 follow-up: only the panel whose ▶ started the preview drives it.
 *
 *  The regression this pins: both panels key their preview effect on ONE shared
 *  `isPreviewPlaying` flag, so a single press ran both, each took `RunMode` from the other, and
 *  the Timeline (entering behind an await) always won — killing the Animation panel's loop, which
 *  with no timeline doc open meant ▶ played nothing at all. */
import { describe, it, expect } from 'vitest';
import { panelDrivesPreview, panelMayStopPreview } from '../../src/editor/scene/previewOwnership';

describe('panelDrivesPreview', () => {
  it('does not drive when nothing is playing, whoever owns it', () => {
    expect(panelDrivesPreview(false, 'animation', 'animation')).toBe(false);
    expect(panelDrivesPreview(false, null, 'timeline')).toBe(false);
  });

  it('the owning panel drives', () => {
    expect(panelDrivesPreview(true, 'animation', 'animation')).toBe(true);
    expect(panelDrivesPreview(true, 'timeline', 'timeline')).toBe(true);
  });

  it('the NON-owning panel stands down — the whole point', () => {
    // Timeline must not enter preview off the Animation panel's ▶: it lands second, wins
    // `_modeOwner`, and its displacement callback then stops Animation's loop.
    expect(panelDrivesPreview(true, 'animation', 'timeline')).toBe(false);
    expect(panelDrivesPreview(true, 'timeline', 'animation')).toBe(false);
  });

  it('an UNCLAIMED preview drives NOTHING — the permissive fallback was #810 re-armed', () => {
    // An earlier cut returned true here so a programmatic `setPreviewPlaying(true)` kept working.
    // That is the original bug on that path: both panels run, the Timeline lands second, wins the
    // mode and stops the other's loop. Nothing playing is the safe failure; two panels fighting
    // over a single-valued RunMode is not.
    expect(panelDrivesPreview(true, null, 'animation')).toBe(false);
    expect(panelDrivesPreview(true, null, 'timeline')).toBe(false);
  });
});

describe('panelMayStopPreview — the permissive twin', () => {
  it('a panel may stop its OWN preview', () => {
    expect(panelMayStopPreview('animation', 'animation')).toBe(true);
    expect(panelMayStopPreview('timeline', 'timeline')).toBe(true);
  });

  it('a panel may NOT stop the other panel\'s — the mirror-face of #810', () => {
    // Closing or re-docking an idle Timeline tab used to run `setPreviewPlaying(false)` in its
    // unmount cleanup and kill a running Animation preview, because the flag is shared.
    expect(panelMayStopPreview('animation', 'timeline')).toBe(false);
    expect(panelMayStopPreview('timeline', 'animation')).toBe(false);
  });

  it('either panel may clean up an UNCLAIMED preview', () => {
    // Deliberately permissive where `panelDrivesPreview` is strict: otherwise an untagged
    // `setPreviewPlaying(true)` strands the flag true with nothing able to clear it.
    expect(panelMayStopPreview(null, 'animation')).toBe(true);
    expect(panelMayStopPreview(null, 'timeline')).toBe(true);
  });
});
