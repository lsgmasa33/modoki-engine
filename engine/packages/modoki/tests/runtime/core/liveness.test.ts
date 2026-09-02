import { describe, expect, it } from 'vitest';
import { createSupersessionToken, createTeardownToken } from '../../../src/runtime/core/liveness';

describe('createSupersessionToken', () => {
  it('a lone begin() is true — the guard can detect the positive case at all', () => {
    // Without this, every other assertion here is satisfied by a check that always returns false.
    const token = createSupersessionToken();
    const only = token.begin();
    expect(only()).toBe(true);
  });

  it('the newest begin() stays true while an earlier begin() goes false', () => {
    const token = createSupersessionToken();
    const first = token.begin();
    const second = token.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});

describe('createTeardownToken', () => {
  it('a capture is true until invalidateAll(), including captures taken before it', () => {
    const token = createTeardownToken();
    const before = token.capture();
    expect(before()).toBe(true);
    token.invalidateAll();
    expect(before()).toBe(false);
  });

  it('a capture taken AFTER invalidateAll() is unaffected by that past invalidation', () => {
    const token = createTeardownToken();
    token.invalidateAll();
    const after = token.capture();
    expect(after()).toBe(true);
  });

  it('invalidateKey stales only captures taken for that key; other keys stay true', () => {
    const token = createTeardownToken<string>();
    const a = token.capture('a');
    const b = token.capture('b');
    token.invalidateKey('a');
    expect(a()).toBe(false);
    expect(b()).toBe(true);
  });

  it('invalidateAll also stales keyed captures', () => {
    const token = createTeardownToken<string>();
    const a = token.capture('a');
    token.invalidateAll();
    expect(a()).toBe(false);
  });

  it('invalidateKey on a never-captured key is a no-op and does not throw', () => {
    const token = createTeardownToken<string>();
    expect(() => token.invalidateKey('never-captured')).not.toThrow();
  });

  it('a capture with no key is unaffected by any invalidateKey', () => {
    const token = createTeardownToken<string>();
    const unkeyed = token.capture();
    token.invalidateKey('a');
    token.invalidateKey('b');
    expect(unkeyed()).toBe(true);
  });

  it('.generation and .current expose the raw counter for composition without capture()', () => {
    const token = createTeardownToken();
    const capturedGeneration = token.generation;
    expect(capturedGeneration).toBe(token.generation);
    token.invalidateAll();
    expect(token.generation).not.toBe(capturedGeneration);

    const supersession = createSupersessionToken();
    const capturedCurrent = supersession.current;
    supersession.begin();
    expect(supersession.current).not.toBe(capturedCurrent);
  });

  it('two tokens from two factory calls are fully independent', () => {
    const tokenA = createTeardownToken<string>();
    const tokenB = createTeardownToken<string>();
    const captureA = tokenA.capture('shared-key');
    const captureB = tokenB.capture('shared-key');
    tokenA.invalidateAll();
    expect(captureA()).toBe(false);
    expect(captureB()).toBe(true);
  });

  it('an old capture stays false even when invalidateAll resets its key back to the captured value (ABA)', () => {
    // invalidateAll() CLEARS the per-key map, so a key that had climbed to 1 reads 0 again —
    // exactly what the stale capture recorded. Only the global generation, which is monotonic and
    // never reset, still separates them. This pins that: an optimisation that reset `generation`
    // in invalidateAll(), or that dropped the global check when a key matched, would resurrect a
    // superseded continuation and pass every other test in this file.
    const token = createTeardownToken<string>();
    const stale = token.capture('a'); // captured at generation 0, key 'a' generation 0
    token.invalidateKey('a'); // key 'a' -> 1
    token.invalidateAll(); // generation -> 1, per-key map cleared so 'a' reads 0 again
    expect(stale()).toBe(false);
  });

  it('invalidateAll clears the per-key map so a fresh capture is true and later invalidateKey still stales it', () => {
    const token = createTeardownToken<string>();
    token.capture('a');
    token.invalidateKey('a');
    token.invalidateAll();
    const freshA = token.capture('a');
    expect(freshA()).toBe(true);
    token.invalidateKey('a');
    expect(freshA()).toBe(false);
  });
});
