/** The game-facing tier-change seam (#241) — `onQualityTierChange` + the `@tier` journal event.
 *
 *  A game could already READ the tier and a player could CHOOSE one; nothing could TELL a game the
 *  tier had changed, so self-degradation (spawn counts, particle budgets, an expensive effect) had
 *  to poll and hope. These tests pin the two things that make the seam trustworthy:
 *
 *  1. **It hangs off `setActiveQualityTier`, not `applyQualityTier`.** The obvious-looking funnel
 *     is not one — the tier a device SHIPS WITH is published by `tierResolve` calling
 *     `setActiveQualityTier` directly, and the calibration loop is the only caller of
 *     `applyQualityTier`. Wiring a consumer into the latter is how the frame cap ended up inert on
 *     the path nearly every device takes (#202). The boot-resolution test below is the one that
 *     would fail if someone "simplified" this back.
 *  2. **It fires on CHANGE, not on every publish.** A re-publish carrying a fresh `reason` for the
 *     tier already active is not something a game degrades itself over. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setActiveQualityTier, resetRenderSettings, getAssessedQualityTier,
} from '../../src/runtime/rendering/renderSettings';
import {
  onQualityTierChange, resetQualityTierChangeListeners,
} from '../../src/runtime/rendering/tierChangeNotify';
import { journalEvents, setJournalEnabled, clearJournal } from '../../src/runtime/core/journal';
import { getCurrentWorld } from '../../src/runtime/core/ecs/worldRegistry';
import type { TierResolution } from '../../src/runtime/rendering/qualityTier';

const res = (tier: 'low' | 'mid' | 'high', reason = 'test'): TierResolution =>
  ({ tier, source: 'measured', reason });

beforeEach(() => {
  resetRenderSettings();
  resetQualityTierChangeListeners();
});
afterEach(() => {
  resetQualityTierChangeListeners();
  setActiveQualityTier(null);
});

describe('onQualityTierChange', () => {
  it('delivers the FIRST resolution of a session, with prev null', () => {
    // The boot tier is a change from "nothing decided yet". Swallowing it would mean a game that
    // subscribes at setup never hears the tier it actually launched on.
    const seen: Array<[string, string | null]> = [];
    onQualityTierChange((r, prev) => seen.push([r.tier, prev]));

    setActiveQualityTier(res('mid', 'gpu-benchmark'));

    expect(seen).toEqual([['mid', null]]);
  });

  it('delivers a live demote with the tier it came FROM', () => {
    setActiveQualityTier(res('high'));
    const seen: Array<[string, string | null]> = [];
    onQualityTierChange((r, prev) => seen.push([r.tier, prev]));

    setActiveQualityTier(res('low', 'sustained frame budget miss'));

    expect(seen).toEqual([['low', 'high']]);
  });

  it('carries the full resolution, so a listener can tell a demote from a player pick', () => {
    const seen: TierResolution[] = [];
    onQualityTierChange((r) => seen.push(r));

    setActiveQualityTier({ tier: 'low', source: 'player', reason: 'player selected this tier' });

    expect(seen).toHaveLength(1);
    expect(seen[0].source).toBe('player');
    expect(seen[0].reason).toBe('player selected this tier');
  });

  it('does NOT fire when the same tier is re-published with a new reason', () => {
    setActiveQualityTier(res('mid', 'gpu-benchmark'));
    const fn = vi.fn();
    onQualityTierChange(fn);

    setActiveQualityTier(res('mid', 'promotion held at the ceiling'));

    expect(fn).not.toHaveBeenCalled();
  });

  it('does NOT fire on teardown, when the active tier is cleared', () => {
    setActiveQualityTier(res('mid'));
    const fn = vi.fn();
    onQualityTierChange(fn);

    setActiveQualityTier(null);

    expect(fn).not.toHaveBeenCalled();
  });

  it('is MULTI-subscriber — unlike the overlay seam, N readers cannot conflict', () => {
    const a = vi.fn(); const b = vi.fn();
    onQualityTierChange(a);
    onQualityTierChange(b);

    setActiveQualityTier(res('low'));

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes', () => {
    const fn = vi.fn();
    const off = onQualityTierChange(fn);
    off();

    setActiveQualityTier(res('low'));

    expect(fn).not.toHaveBeenCalled();
  });

  it('one throwing listener does not starve the next, or the engine path that published', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const after = vi.fn();
    onQualityTierChange(() => { throw new Error('game listener blew up'); });
    onQualityTierChange(after);

    expect(() => setActiveQualityTier(res('low'))).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('fires AFTER the assessment latches, so a listener reads consistent engine state', () => {
    // A listener that consults getAssessedQualityTier() must not see the pre-latch world.
    let assessedDuringCallback: string | null = null;
    onQualityTierChange(() => { assessedDuringCallback = getAssessedQualityTier()?.tier ?? null; });

    setActiveQualityTier(res('mid'));

    expect(assessedDuringCallback).toBe('mid');
  });
});

describe('the REAL publish paths reach it', () => {
  // ⭐ THE TESTS ABOVE DRIVE `setActiveQualityTier` DIRECTLY — which IS faithfully the boot path
  // (`tierResolve.publishActiveTier` calls exactly that), so they already fail if the publish is
  // ever moved into `applyQualityTier`. This one covers the OTHER real path: the calibration
  // demote/promote and the player pick, which reach the tier through `applyQualityTier`.

  it('fires through applyQualityTier — the calibration demote/promote and player-pick path', async () => {
    const { applyQualityTier } = await import('../../src/runtime/rendering/tierCalibration');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: Array<[string, string | null]> = [];
    onQualityTierChange((r, prev) => seen.push([r.tier, prev]));

    applyQualityTier('low', 'measured', 'sustained frame budget miss');

    expect(seen).toEqual([['low', null]]);
    warn.mockRestore();
  });

});

describe('the @tier journal event', () => {
  beforeEach(() => {
    getCurrentWorld();   // a world must exist, or the emit is deliberately skipped (see below)
    clearJournal();
    setJournalEnabled(true);
  });

  it('records the change, so a mid-session demote is visible to modoki_journal', () => {
    setActiveQualityTier(res('high'));
    setActiveQualityTier(res('low', 'sustained frame budget miss'));

    const events = journalEvents({ type: '@tier' });
    expect(events).toHaveLength(2);
    expect(events[1].payload).toMatchObject({
      tier: 'low', prev: 'high', source: 'measured', reason: 'sustained frame budget miss',
    });
  });

  it('is Tier-1 — a bare read sees it without opening a capture', () => {
    // Tier changes are low-rate; gating them behind a watch would mean the demote you are hunting
    // is the one event you did not capture.
    setActiveQualityTier(res('low'));
    expect(journalEvents().some((e) => e.type === '@tier')).toBe(true);
  });
});
