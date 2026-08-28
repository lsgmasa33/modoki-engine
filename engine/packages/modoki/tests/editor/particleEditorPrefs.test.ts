// @vitest-environment jsdom
/** Particle Editor's ground-plane toggle persistence (#399 close-out sweep) — the exact same
 *  bug shape as SceneView's Grid toggle: a preview-viewport display option that reset on
 *  every mount. */

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

import { loadParticleEditorShowFloor, saveParticleEditorShowFloor } from '../../src/editor/panels/particleEditorPrefs';

describe('particleEditorPrefs', () => {
  beforeEach(() => { localStorage.clear(); });

  it('defaults to false (matching the pre-#399 hardcoded default) and round-trips', () => {
    expect(loadParticleEditorShowFloor()).toBe(false);
    saveParticleEditorShowFloor(true);
    expect(loadParticleEditorShowFloor()).toBe(true);
    saveParticleEditorShowFloor(false);
    expect(loadParticleEditorShowFloor()).toBe(false);
  });
});
