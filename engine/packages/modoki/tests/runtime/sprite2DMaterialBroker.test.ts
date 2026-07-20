/** sprite2DMaterialBroker unit tests (2D materials).
 *  A pure module over a Set of `Map<number,Shader>` (per-renderer entity→Shader maps) +
 *  a per-frame dirty Set. It holds GLOBAL state across tests, so every map registered in a
 *  test is unregistered and the dirty set cleared in afterEach to keep tests isolated.
 *  Shaders are plain object fakes `{ destroyed?: boolean } as unknown as Shader`. */

import { describe, it, expect, afterEach } from 'vitest';
import type { Shader } from 'pixi.js';
import {
  register2DMaterialShaderMap,
  getEntity2DMaterialShaders,
  hasEntity2DMaterial,
  markEntity2DMaterialDirty,
  isEntity2DMaterialDirty,
  clearEntity2DMaterialDirty,
} from '../../src/runtime/rendering/sprite2DMaterialBroker';

const fakeShader = (destroyed = false) => ({ destroyed } as unknown as Shader);

// Track everything we register so we can tear down the module's global Set between tests.
// The returned unregister fns are idempotent (Set.delete of an absent map is a no-op), so
// calling one in-test AND again in afterEach is harmless.
const unregisters: Array<() => void> = [];
const register = (map: Map<number, Shader>) => {
  const off = register2DMaterialShaderMap(map);
  unregisters.push(off);
  return off;
};

afterEach(() => {
  for (const off of unregisters) off();
  unregisters.length = 0;
  clearEntity2DMaterialDirty();
});

describe('register2DMaterialShaderMap', () => {
  it('returns an unregister fn that removes only that map', () => {
    const X = 7;
    const sa = fakeShader();
    const sb = fakeShader();
    const mapA = new Map<number, Shader>([[X, sa]]);
    const mapB = new Map<number, Shader>([[X, sb]]);
    const offA = register(mapA);
    const offB = register(mapB);

    expect(getEntity2DMaterialShaders(X)).toHaveLength(2);

    offB(); // drop map B
    expect(getEntity2DMaterialShaders(X)).toEqual([sa]); // only A's shader remains
    expect(hasEntity2DMaterial(X)).toBe(true);

    offA(); // drop A too → nothing left for X
    expect(getEntity2DMaterialShaders(X)).toEqual([]);
    expect(hasEntity2DMaterial(X)).toBe(false);
  });
});

describe('getEntity2DMaterialShaders', () => {
  it('skips a destroyed shader per-map but keeps live ones across maps', () => {
    const X = 3;
    const live = fakeShader(false);
    const mapA = new Map<number, Shader>([[X, fakeShader(true)]]); // destroyed in A
    const mapB = new Map<number, Shader>([[X, live]]);             // live in B
    register(mapA);
    register(mapB);

    expect(getEntity2DMaterialShaders(X)).toEqual([live]); // exactly B's live shader
  });

  it('returns [] when the entity is absent from every map', () => {
    register(new Map<number, Shader>([[1, fakeShader()]]));
    expect(getEntity2DMaterialShaders(999)).toEqual([]);
  });
});

describe('hasEntity2DMaterial', () => {
  it('is false when every map is destroyed/absent, true once any map has a live shader', () => {
    const X = 5;
    const mapA = new Map<number, Shader>([[X, fakeShader(true)]]); // destroyed
    const mapB = new Map<number, Shader>();                        // absent
    register(mapA);
    register(mapB);
    expect(hasEntity2DMaterial(X)).toBe(false);

    mapB.set(X, fakeShader(false)); // now a live one appears
    expect(hasEntity2DMaterial(X)).toBe(true);
  });
});

describe('dirty set', () => {
  it('marks, reads without consuming, and clears', () => {
    const X = 42;
    expect(isEntity2DMaterialDirty(X)).toBe(false);

    markEntity2DMaterialDirty(X);
    expect(isEntity2DMaterialDirty(X)).toBe(true);
    expect(isEntity2DMaterialDirty(X)).toBe(true); // reads do not consume the flag

    clearEntity2DMaterialDirty();
    expect(isEntity2DMaterialDirty(X)).toBe(false);
  });

  it('clearEntity2DMaterialDirty clears all marked entities', () => {
    markEntity2DMaterialDirty(1);
    markEntity2DMaterialDirty(2);
    expect(isEntity2DMaterialDirty(1)).toBe(true);
    expect(isEntity2DMaterialDirty(2)).toBe(true);
    clearEntity2DMaterialDirty();
    expect(isEntity2DMaterialDirty(1)).toBe(false);
    expect(isEntity2DMaterialDirty(2)).toBe(false);
  });
});
