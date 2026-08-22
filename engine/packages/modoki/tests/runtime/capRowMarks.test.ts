/** What the debug menu's "Backing resolution" row says — the cases that were WRONG before the
 *  override landed, and the ones the override itself got wrong first time round.
 *
 *  Every case here is a (authored, override, effective, tierCeiling) tuple that a real device can
 *  be in; the ones marked with a scenario are ones a reader was actually misled by. */
import { describe, it, expect } from 'vitest';
import {
  asCeiling, pickedCap, willBeClamped, capButtonMarks, capRowCaption, type CapRowState,
} from '../../src/runtime/debug/tabs/capRowMarks';

/** The row on a `mid`-tier phone: 2D ceiling 1, project authoring 3, no override. */
const clampedByTier: CapRowState = { authored: 3, override: null, effective: 1, tierCeiling: 1 };

describe('asCeiling', () => {
  it('reads 0 ("Off") and negatives as NO ceiling, not as the tightest possible one', () => {
    expect(asCeiling(0)).toBe(Infinity);
    expect(asCeiling(-1)).toBe(Infinity);
    expect(asCeiling(1.5)).toBe(1.5);
  });
});

describe('pickedCap — the override is the pick once one is in force', () => {
  it('is the authored value when the tier governs', () => {
    expect(pickedCap(clampedByTier)).toBe(3);
  });

  it('is the OVERRIDE when one is set, even when it disagrees with the stored value', () => {
    expect(pickedCap({ authored: 1, override: 3, effective: 3, tierCeiling: 1 })).toBe(3);
  });

  it('treats an override of 0 as a real pick ("Off" = uncapped), not as "no override"', () => {
    // The whole reason the channel is `number | null`: 0 is a value, absence is null.
    expect(pickedCap({ authored: 2, override: 0, effective: 0, tierCeiling: 1 })).toBe(0);
  });
});

describe('capButtonMarks', () => {
  it('marks the authored pick solid and the tier-clamped value dashed', () => {
    expect(capButtonMarks(3, clampedByTier)).toEqual({ active: true, isEffective: false, clamped: true });
    expect(capButtonMarks(1, clampedByTier)).toEqual({ active: false, isEffective: true, clamped: false });
  });

  it('stops dimming every button once an override is in force — the tier clamps nothing then', () => {
    const overridden: CapRowState = { authored: 3, override: 3, effective: 3, tierCeiling: 1 };
    for (const v of [1, 1.5, 2, 3, 0]) expect(capButtonMarks(v, overridden).clamped).toBe(false);
  });

  it('REGRESSION: an override set outside the panel highlights the value that is RUNNING', () => {
    // device_eval sets override 3 while the stored value is still 1 (ceiling 1). Judged by
    // `authored`, button "1" was solid and "3" unmarked — the row pointed at a value nobody
    // picked while the renderer ran at 3.
    const external: CapRowState = { authored: 1, override: 3, effective: 3, tierCeiling: 1 };
    expect(capButtonMarks(3, external)).toEqual({ active: true, isEffective: false, clamped: false });
    expect(capButtonMarks(1, external).active).toBe(false);
  });
});

describe('capRowCaption', () => {
  it('says what the tier did when it clamped the pick', () => {
    expect(capRowCaption(clampedByTier)).toBe('authored 3, tier clamps to 1');
  });

  it('says nothing when the tier changed nothing', () => {
    expect(capRowCaption({ authored: 1, override: null, effective: 1, tierCeiling: 1 })).toBeNull();
  });

  it('names the ceiling being overridden, so the tier stays visible while it is overruled', () => {
    expect(capRowCaption({ authored: 3, override: 3, effective: 3, tierCeiling: 1 }))
      .toBe('overriding tier ceiling of 1');
  });

  it('REGRESSION: an external override ABOVE the ceiling is never silent', () => {
    // authored 1, override 3, ceiling 1. Judged by `authored` (1 > 1 is false) the caption
    // vanished entirely — no indication the surface was running uncapped at 3.
    expect(capRowCaption({ authored: 1, override: 3, effective: 3, tierCeiling: 1 }))
      .toBe('overriding tier ceiling of 1, authored 1');
  });

  it('REGRESSION: an override AT or BELOW the ceiling does not claim to overrule it', () => {
    // authored 2, override 1, ceiling 1 — nothing above the ceiling is running. Judged by
    // `authored` (2 > 1) the row claimed "overriding tier ceiling of 1", which was false.
    expect(capRowCaption({ authored: 2, override: 1, effective: 1, tierCeiling: 1 }))
      .toBe('authored 2');
  });

  it('reports an "Off" (uncapped) override as overriding a finite ceiling', () => {
    expect(capRowCaption({ authored: 0, override: 0, effective: 0, tierCeiling: 1.5 }))
      .toBe('overriding tier ceiling of 1.5');
  });

  it('says nothing when an override matches an already-uncapped tier', () => {
    expect(capRowCaption({ authored: 3, override: 3, effective: 3, tierCeiling: Infinity })).toBeNull();
  });
});

describe('willBeClamped', () => {
  it('is true only for a value above the ceiling, and only while the tier governs', () => {
    expect(willBeClamped(2, clampedByTier)).toBe(true);
    expect(willBeClamped(1, clampedByTier)).toBe(false);
    expect(willBeClamped(2, { ...clampedByTier, override: 1 })).toBe(false);
  });
});
