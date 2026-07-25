/** OTA Phase 4 (docs/ota-subgame-modules.md) — the runtime game registry.
 *  Under vitest the repo root has no game.ts, so `virtual:modoki-games` resolves to an
 *  empty baked set — these tests exercise the dynamic-registration half against that
 *  known-empty baseline. */

import { describe, it, expect, afterEach } from 'vitest';
import { getGames, findGame, registerDynamicGame, subscribeGameRegistry, __resetGameRegistryForTest } from '../../app/gameRegistry';
import type { GameDefinition } from '@modoki/engine/runtime';

function makeGame(id: string): GameDefinition {
  return { id, name: id, loadConfig: async () => ({ scenePath: '' }) as never };
}

afterEach(() => {
  __resetGameRegistryForTest();
});

describe('gameRegistry', () => {
  it('starts with no dynamic games registered', () => {
    expect(getGames()).toEqual([]);
    expect(findGame('sub-a')).toBeUndefined();
  });

  it('registers a dynamic game and makes it findable', () => {
    const ok = registerDynamicGame(makeGame('sub-a'));
    expect(ok).toBe(true);
    expect(findGame('sub-a')?.id).toBe('sub-a');
    expect(getGames().map((g) => g.id)).toEqual(['sub-a']);
  });

  it('refuses (does not throw) a duplicate dynamic gameId', () => {
    expect(registerDynamicGame(makeGame('sub-a'))).toBe(true);
    expect(registerDynamicGame(makeGame('sub-a'))).toBe(false);
    expect(getGames().map((g) => g.id)).toEqual(['sub-a']); // still just the one
  });

  it('notifies subscribers on registration', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeGameRegistry(() => seen.push('changed'));
    registerDynamicGame(makeGame('sub-b'));
    expect(seen).toEqual(['changed']);
    unsubscribe();
  });
});
