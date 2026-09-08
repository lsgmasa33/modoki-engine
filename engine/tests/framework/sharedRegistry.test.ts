/** Pins `sharedRegistry.ts` (the shell's globalThis.__MODOKI_SHARED__ registry) and
 *  `sharedRegistryKeys.ts` (SUBGAME_SHARED_KEYS, what a sub-game build externalizes)
 *  together — an ES import can't be generated from an array entry, so the two lists
 *  are maintained by hand and drift silently without this test. Missing a key on
 *  either side is exactly the "shell registers `three` but not `three/webgpu`"
 *  double-instance trap the registry exists to prevent (docs/ota-subgame-modules.md §1/§5). */

import { describe, it, expect } from 'vitest';
import { __registeredKeysForTest } from '../../app/sharedRegistry';
import { SUBGAME_SHARED_KEYS } from '../../app/sharedRegistryKeys';

describe('sharedRegistry ensure() retry-after-rejection', () => {
  // `ensure` itself is not exported (only `__registeredKeysForTest` is, for the
  // key-agreement check above) — reach it the same way a sub-game bundle does, via the
  // global registry `sharedRegistry.ts` installs as its side effect. `LAZY_LOADERS` IS
  // exported by reference through `__registeredKeysForTest`, so a test-only key can be
  // injected into the real map without touching the eager/lazy module lists it pins.
  it('retries loader() after a rejected ensure(), and does not re-call it after a resolved one', async () => {
    const { modules, LAZY_LOADERS } = __registeredKeysForTest;
    const key = '__test_retry_key__';
    let calls = 0;
    LAZY_LOADERS[key] = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('transient failure'));
      return Promise.resolve({ ok: true });
    };

    try {
      const ensure = globalThis.__MODOKI_SHARED__!.ensure;

      await expect(ensure([key])).rejects.toThrow('transient failure');
      expect(calls).toBe(1);

      await expect(ensure([key])).resolves.toBeUndefined();
      expect(calls).toBe(2);

      // A repeat ensure() after success must short-circuit on `modules[key]` and not
      // call the loader a third time.
      await expect(ensure([key])).resolves.toBeUndefined();
      expect(calls).toBe(2);
    } finally {
      delete LAZY_LOADERS[key];
      delete modules[key];
    }
  });
});

describe('sharedRegistry / SUBGAME_SHARED_KEYS agreement', () => {
  it('every SUBGAME_SHARED_KEYS entry is registered (eagerly or lazily) by the shell', () => {
    const { modules, LAZY_LOADERS } = __registeredKeysForTest;
    const registered = new Set([...Object.keys(modules), ...Object.keys(LAZY_LOADERS)]);
    const missing = SUBGAME_SHARED_KEYS.filter((k) => !registered.has(k));
    expect(missing).toEqual([]);
  });

  it('the shell registers no key outside SUBGAME_SHARED_KEYS (a sub-game build would refuse to externalize it)', () => {
    const { modules, LAZY_LOADERS } = __registeredKeysForTest;
    const registered = [...Object.keys(modules), ...Object.keys(LAZY_LOADERS)];
    const extra = registered.filter((k) => !SUBGAME_SHARED_KEYS.includes(k));
    expect(extra).toEqual([]);
  });
});
