/** Pins `sharedRegistry.ts` (the shell's globalThis.__MODOKI_SHARED__ registry) and
 *  `sharedRegistryKeys.ts` (SUBGAME_SHARED_KEYS, what a sub-game build externalizes)
 *  together — an ES import can't be generated from an array entry, so the two lists
 *  are maintained by hand and drift silently without this test. Missing a key on
 *  either side is exactly the "shell registers `three` but not `three/webgpu`"
 *  double-instance trap the registry exists to prevent (docs/ota-subgame-modules.md §1/§5). */

import { describe, it, expect } from 'vitest';
import { __registeredKeysForTest } from '../../app/sharedRegistry';
import { SUBGAME_SHARED_KEYS } from '../../app/sharedRegistryKeys';

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
