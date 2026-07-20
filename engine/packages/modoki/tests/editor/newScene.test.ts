// @vitest-environment jsdom
/** Contract test for `newScene()` (editor/scene/serialize.ts).
 *
 *  A freshly-created scene must be LIT out of the box — the regression that
 *  motivated this (commit bb55957) was new scenes rendering everything black
 *  because they had only a Camera. `newScene()` now spawns a ready-to-use
 *  starting world: Camera + Environment (built-in white.hdr) + a Directional key
 *  light + an Ambient fill. This locks that contract (entity set, names, the
 *  white-HDR GUID, and sortOrder) so it can't silently regress. */

import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { setCurrentWorld, getCurrentWorld } from '../../src/runtime/ecs/world';
import { registerTrait } from '../../src/runtime/ecs/traitRegistry';
import { getAllEntities } from '../../src/runtime/ecs/entityUtils';
import { Camera } from '../../src/runtime/traits/Camera';
import { Transform } from '../../src/runtime/traits/Transform';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Environment } from '../../src/three/traits/Environment';
import { Light } from '../../src/three/traits/Light';
import { newScene, getCurrentScenePath, setCurrentScenePath } from '../../src/editor/scene/serialize';
import { WHITE_HDR_GUID } from '../../src/runtime/assets/builtinAssets';

function registerAll() {
  registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: {}, isActive: {}, sortOrder: {}, parentId: {}, layer: {}, guid: {} } });
  registerTrait({ name: 'Transform', trait: Transform, category: 'component', fields: { x: {}, y: {}, z: {}, rx: {}, ry: {}, rz: {}, sx: {}, sy: {}, sz: {} } });
  registerTrait({ name: 'Camera', trait: Camera, category: 'component', fields: { fov: {} } });
  registerTrait({ name: 'Environment', trait: Environment, category: 'component', fields: { hdrPath: {}, intensity: {} } });
  registerTrait({ name: 'Light', trait: Light, category: 'component', fields: { lightType: {}, color: {}, intensity: {} } });
}

// serialize.ts persists the last-scene path to localStorage; the jsdom env here
// doesn't provide one, so back it with a tiny in-memory store.
function installLocalStorage() {
  if (typeof globalThis.localStorage !== 'undefined') return;
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

describe('newScene()', () => {
  beforeEach(() => {
    installLocalStorage();
    setCurrentWorld(createWorld());
    registerAll();
    setCurrentScenePath('/assets/scenes/prev.json'); // simulate a prior scene
  });

  it('spawns exactly four starter entities', () => {
    newScene();
    expect(getAllEntities()).toHaveLength(4);
  });

  it('spawns Camera + HDR Environment + Directional + Ambient by name and order', () => {
    newScene();
    const byOrder = getAllEntities().slice().sort((a, b) => a.sortOrder - b.sortOrder);
    expect(byOrder.map((e) => e.name)).toEqual(['Camera', 'HDR Environment', 'Directional Light', 'Ambient Light']);
    expect(byOrder.map((e) => e.sortOrder)).toEqual([0, 1, 2, 3]);
  });

  it('binds the Environment to the built-in white.hdr GUID', () => {
    newScene();
    const env = getCurrentWorld().query(Environment)[0];
    expect(env).toBeDefined();
    expect(env.get(Environment)!.hdrPath).toBe(WHITE_HDR_GUID);
  });

  it('spawns a lit setup: a directional key light and an ambient fill', () => {
    newScene();
    const lights = getCurrentWorld().query(Light).map((e) => e.get(Light)!);
    const types = lights.map((l) => l.lightType).sort();
    expect(types).toEqual(['ambient', 'directional']);
    // The directional key is meaningfully bright; ambient is a softer fill.
    const directional = lights.find((l) => l.lightType === 'directional')!;
    const ambient = lights.find((l) => l.lightType === 'ambient')!;
    expect(directional.intensity).toBeGreaterThan(0);
    expect(ambient.intensity).toBeGreaterThan(0);
    expect(directional.intensity).toBeGreaterThan(ambient.intensity);
  });

  it('clears the current scene path (untitled)', () => {
    newScene();
    expect(getCurrentScenePath()).toBeNull();
  });

  it('replaces the previous world (no leftover entities across calls)', () => {
    newScene();
    newScene();
    expect(getAllEntities()).toHaveLength(4); // not 8 — the prior starter set is cleared
  });
});
