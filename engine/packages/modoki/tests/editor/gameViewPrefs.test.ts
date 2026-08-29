// @vitest-environment jsdom
/** GameView's Mute Audio / Show Colliders toolbar toggle persistence (#399) — both used to
 *  live only in a runtime module-level variable, reset to `false` on every fresh page load. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  resolveInitialGameViewMute, _resetMutePageLoadGuardForTests,
} from '../../src/editor/rendering/gameViewPrefs';

describe('gameViewPrefs', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetMutePageLoadGuardForTests();
  });

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

  // Close-out review finding #3: the naive fix (apply the persisted value on EVERY GameView
  // mount) stomps a mute set by a game's own runtime (e.g. Court's in-game sound setting)
  // whenever GameView remounts within the same session (Load Layout, Reset Layout, dragging
  // the Game tab, Fast Refresh). These pin the fixed "apply once per page load, then just
  // read live" behaviour.
  describe('resolveInitialGameViewMute', () => {
    it('on the FIRST call of a page load, applies the persisted value to the runtime', () => {
      saveGameViewMuted(true);
      const setAudioMuted = vi.fn();
      const result = resolveInitialGameViewMute(() => false /* live, ignored */, setAudioMuted);
      expect(result).toBe(true);
      expect(setAudioMuted).toHaveBeenCalledTimes(1);
      expect(setAudioMuted).toHaveBeenCalledWith(true);
    });

    it('on a LATER call (same-session remount), reads the live value and does NOT write', () => {
      saveGameViewMuted(false); // persisted: unmuted
      const setAudioMutedFirst = vi.fn();
      resolveInitialGameViewMute(() => false, setAudioMutedFirst); // consumes the "first call"

      // The game has since muted itself (e.g. the player turned sound off in-game) — the
      // persisted editor snapshot is stale relative to that live state.
      const setAudioMutedSecond = vi.fn();
      const result = resolveInitialGameViewMute(() => true /* live: game muted itself */, setAudioMutedSecond);

      expect(result).toBe(true); // reflects the LIVE state, not the stale persisted 'false'
      expect(setAudioMutedSecond).not.toHaveBeenCalled(); // and does not stomp it back
    });
  });
});
