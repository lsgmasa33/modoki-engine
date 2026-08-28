// @vitest-environment jsdom
/** GameView's Mute Audio / Show Colliders toolbar toggle persistence (#399) — both used to
 *  live only in a runtime module-level variable, reset to `false` on every fresh page load. */

import { describe, it, expect, beforeEach } from 'vitest';

function installLocalStorage() {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}
installLocalStorage();

import {
  loadGameViewMuted, saveGameViewMuted,
  loadGameViewShowColliders, saveGameViewShowColliders,
} from '../../src/editor/rendering/gameViewPrefs';

describe('gameViewPrefs', () => {
  beforeEach(() => { localStorage.clear(); });

  it('mute defaults to false and round-trips', () => {
    expect(loadGameViewMuted()).toBe(false);
    saveGameViewMuted(true);
    expect(loadGameViewMuted()).toBe(true);
    saveGameViewMuted(false);
    expect(loadGameViewMuted()).toBe(false);
  });

  it('show-colliders defaults to false and round-trips independently of mute', () => {
    expect(loadGameViewShowColliders()).toBe(false);
    saveGameViewMuted(true);
    saveGameViewShowColliders(true);
    expect(loadGameViewShowColliders()).toBe(true);
    expect(loadGameViewMuted()).toBe(true);
  });
});
