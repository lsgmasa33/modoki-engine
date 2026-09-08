/**
 * The account-generic contract (#675) — `reauthProviderFor`, the one function this module owns.
 * Split out of Court's `games/court/tests/accountUi.test.ts` (which still covers the same
 * behaviour through the game's own call site) when the pure decision moved to the engine; the
 * owner's ruling that narrowed #675 kept every string builder in Court, so there is nothing else
 * to test here.
 */

import { describe, it, expect } from 'vitest';
import { reauthProviderFor, type AvailableProviders } from '../../src/runtime/account';

const BOTH: AvailableProviders = { apple: true, google: true };

describe('reauthProviderFor — which arm re-authenticates before delete (#593)', () => {
  it('picks the single provider the account carries', () => {
    expect(reauthProviderFor(['apple'], BOTH)).toBe('apple');
    expect(reauthProviderFor(['google'], BOTH)).toBe('google');
  });

  it('⚠️ preference order is the account\'s OWN list order, not a fixed provider ranking', () => {
    // The account's list is what is iterated, filtered by what the platform can complete — so a
    // ['google', 'apple'] account picks google even though ['apple', 'google'] would pick apple.
    // This is what makes the choice deterministic per DEVICE without needing a cross-device
    // agreement on which provider "wins".
    expect(reauthProviderFor(['apple', 'google'], BOTH)).toBe('apple');
    expect(reauthProviderFor(['google', 'apple'], BOTH)).toBe('google');
  });

  it('⚠️ an unavailable provider is skipped, falling through to the next the account carries', () => {
    // Signing in through a provider the account does NOT carry mints a DIFFERENT uid — the whole
    // reason this iterates the account's own list rather than the platform's.
    expect(reauthProviderFor(['apple', 'google'], { apple: false, google: true })).toBe('google');
    expect(reauthProviderFor(['google', 'apple'], { apple: true, google: false })).toBe('apple');
  });

  it('⚠️ `unknown` never returns — it names no sheet this function can run', () => {
    expect(reauthProviderFor(['unknown'], BOTH)).toBeNull();
    expect(reauthProviderFor(['unknown', 'apple'], BOTH)).toBe('apple');
  });

  it('an empty provider list returns null', () => {
    expect(reauthProviderFor([], BOTH)).toBeNull();
  });

  it('null is also the answer when the platform can complete none of the account\'s providers', () => {
    expect(reauthProviderFor(['apple'], { apple: false, google: true })).toBeNull();
    expect(reauthProviderFor(['apple', 'google'], { apple: false, google: false })).toBeNull();
  });

  it('defaults to every provider available when none is supplied', () => {
    expect(reauthProviderFor(['apple'])).toBe('apple');
    expect(reauthProviderFor(['google'])).toBe('google');
  });
});
