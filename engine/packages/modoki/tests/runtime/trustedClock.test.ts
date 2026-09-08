/** `trustedClock.ts` — the pure anchor arithmetic. No PlayerPrefs, no Firebase, no ECS: see the
 *  module's own banner for why an ANCHOR (not a stored floor) is what actually stops a forward-
 *  wound device clock from minting time. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  setTrustedAnchor, trustedNow, hasTrustedAnchor, trustedAnchorSource, clearTrustedAnchor,
} from '../../src/runtime/core/trustedClock';

afterEach(() => clearTrustedAnchor());

describe('trustedNow / hasTrustedAnchor', () => {
  it('is null with no anchor set', () => {
    expect(hasTrustedAnchor()).toBe(false);
    expect(trustedNow(1_000)).toBeNull();
    expect(trustedAnchorSource()).toBeNull();
  });

  it('returns exactly the server time at the moment the anchor was taken', () => {
    setTrustedAnchor(1_700_000_000_000, 5_000, 'id-token');
    expect(hasTrustedAnchor()).toBe(true);
    expect(trustedNow(5_000)).toBe(1_700_000_000_000);
    expect(trustedAnchorSource()).toBe('id-token');
  });

  it('advancing the monotonic reading advances trustedNow() by the SAME amount', () => {
    setTrustedAnchor(1_700_000_000_000, 5_000, 'date-header');
    expect(trustedNow(5_000)).toBe(1_700_000_000_000);
    expect(trustedNow(5_000 + 30_000)).toBe(1_700_000_000_000 + 30_000); // +30s monotonic → +30s trusted
    expect(trustedNow(5_000 + 3_600_000)).toBe(1_700_000_000_000 + 3_600_000); // +1h → +1h
    expect(trustedAnchorSource()).toBe('date-header');
  });

  it('a monotonic reading BEFORE the anchor moment reads backwards by the same amount — the anchor never clamps', () => {
    // Not a real scenario (a caller always passes a later reading), but the arithmetic itself is
    // unconditional — proving that is what shows there is no hidden `Math.max` anywhere in here.
    setTrustedAnchor(1_700_000_000_000, 10_000, 'id-token');
    expect(trustedNow(9_000)).toBe(1_700_000_000_000 - 1_000);
  });

  it('rejects a non-finite or non-positive serverMs, leaving any existing anchor untouched', () => {
    setTrustedAnchor(1_700_000_000_000, 1_000, 'id-token');
    setTrustedAnchor(Number.NaN, 2_000, 'date-header');
    setTrustedAnchor(0, 2_000, 'date-header');
    setTrustedAnchor(-5, 2_000, 'date-header');
    setTrustedAnchor(Number.POSITIVE_INFINITY, 2_000, 'date-header');
    expect(trustedNow(1_000)).toBe(1_700_000_000_000);
    expect(trustedAnchorSource()).toBe('id-token'); // the bad calls above never overwrote it
  });

  it('rejects a non-finite monotonicMs', () => {
    setTrustedAnchor(1_700_000_000_000, Number.NaN, 'id-token');
    expect(hasTrustedAnchor()).toBe(false);
  });

  // ⚠️ The SECURITY-relevant half of `setTrustedAnchor`, and it was covered by nothing until
  // #660 promoted this module to the engine (found by close-out review, mutation-proven: deleting
  // the guard left all 8 existing tests and Court's 37 storeGrant tests green).
  //
  // The near-miss below it — "rejects a non-finite or non-positive serverMs" — LOOKS like it
  // covers this, but all four of its `'date-header'` calls carry an invalid `serverMs`, so they
  // are refused one line EARLIER by the finite/positive check. Its closing
  // `expect(trustedAnchorSource()).toBe('id-token')` therefore passes under both hypotheses and
  // proves nothing about the downgrade. The distinguishing input is a perfectly VALID
  // `date-header` anchor arriving after an `id-token` one.
  it('refuses to DOWNGRADE an id-token anchor to a date-header one, even with a valid serverMs', () => {
    setTrustedAnchor(1_700_000_000_000, 1_000, 'id-token');
    // Valid in every respect — finite, positive, later than the anchor it would replace.
    setTrustedAnchor(1_800_000_000_000, 2_000, 'date-header');
    expect(trustedAnchorSource()).toBe('id-token');
    // The arithmetic must still run off the ORIGINAL anchor, not the refused one.
    expect(trustedNow(1_000)).toBe(1_700_000_000_000);
  });

  it('still allows an id-token anchor to replace an existing id-token anchor', () => {
    // Only a DOWNGRADE is refused — a second strong anchor landing later must win, or a
    // re-anchor after a long session could never correct drift.
    setTrustedAnchor(1_700_000_000_000, 1_000, 'id-token');
    setTrustedAnchor(1_800_000_000_000, 2_000, 'id-token');
    expect(trustedAnchorSource()).toBe('id-token');
    expect(trustedNow(2_000)).toBe(1_800_000_000_000);
  });

  it('a later setTrustedAnchor call replaces the previous anchor, source included', () => {
    setTrustedAnchor(1_700_000_000_000, 1_000, 'date-header');
    setTrustedAnchor(1_800_000_000_000, 2_000, 'id-token');
    expect(trustedNow(2_000)).toBe(1_800_000_000_000);
    expect(trustedAnchorSource()).toBe('id-token');
  });

  it('clearTrustedAnchor drops the anchor', () => {
    setTrustedAnchor(1_700_000_000_000, 1_000, 'id-token');
    clearTrustedAnchor();
    expect(hasTrustedAnchor()).toBe(false);
    expect(trustedNow(1_000)).toBeNull();
    expect(trustedAnchorSource()).toBeNull();
  });
});
