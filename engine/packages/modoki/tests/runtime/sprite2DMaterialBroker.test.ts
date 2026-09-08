/** sprite2DMaterialBroker unit tests (2D materials).
 *  A pure module over a Set of per-renderer `Map<number, Entity2DShaderEntry>` maps + a per-frame
 *  dirty Map. It holds GLOBAL state across tests, so every map registered in a test is
 *  unregistered and the dirty map cleared in afterEach to keep tests isolated.
 *  Shaders are plain object fakes `{ _destroyed: boolean } as unknown as Shader` — `_destroyed`
 *  because that's the field pixi.js's real `Shader` actually carries (an earlier version of
 *  this fake modelled a public `destroyed` field that doesn't exist on the real class, which
 *  let the source's now-fixed filter pass while doing nothing).
 *
 *  ⚠️ The `#848` block at the bottom uses a REAL koota world on purpose. The defect is that a
 *  masked entity index is reclaimed LIFO, and no fake can establish that precondition — a hand
 *  written "pretend these two ids collide" test would pass against the unfixed source too. */

import { describe, it, expect, afterEach } from 'vitest';
import type { Shader } from 'pixi.js';
import { createWorld } from 'koota';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { Transform } from '../../src/runtime/traits';
import {
  register2DMaterialShaderMap,
  getEntity2DMaterialShaders,
  hasEntity2DMaterial,
  markEntity2DMaterialDirty,
  isEntity2DMaterialDirty,
  clearEntity2DMaterialDirty,
} from '../../src/runtime/rendering/sprite2DMaterialBroker';
import type { Entity2DShaderEntry } from '../../src/runtime/rendering/sprite2DMaterialBroker';

const fakeShader = (destroyed = false) => ({ _destroyed: destroyed } as unknown as Shader);

/** The generation the non-#848 tests register and read at. Any value works — those tests are
 *  about the per-renderer fan-out and the destroyed filter, not about recycling — but it must be
 *  the SAME on both sides, which is exactly what the #848 block varies. */
const GEN = 0;
const entry = (shader: Shader, gen = GEN): Entity2DShaderEntry => ({ shader, gen });

// Track everything we register so we can tear down the module's global Set between tests.
// The returned unregister fns are idempotent (Set.delete of an absent map is a no-op), so
// calling one in-test AND again in afterEach is harmless.
const unregisters: Array<() => void> = [];
const register = (map: Map<number, Entity2DShaderEntry>) => {
  const off = register2DMaterialShaderMap(map);
  unregisters.push(off);
  return off;
};

let world: ReturnType<typeof createWorld> | undefined;

afterEach(() => {
  for (const off of unregisters) off();
  unregisters.length = 0;
  clearEntity2DMaterialDirty();
  world?.destroy(); world = undefined;
});

describe('register2DMaterialShaderMap', () => {
  it('returns an unregister fn that removes only that map', () => {
    const X = 7;
    const sa = fakeShader();
    const sb = fakeShader();
    const mapA = new Map<number, Entity2DShaderEntry>([[X, entry(sa)]]);
    const mapB = new Map<number, Entity2DShaderEntry>([[X, entry(sb)]]);
    const offA = register(mapA);
    const offB = register(mapB);

    expect(getEntity2DMaterialShaders(X, GEN)).toHaveLength(2);

    offB(); // drop map B
    expect(getEntity2DMaterialShaders(X, GEN)).toEqual([sa]); // only A's shader remains
    expect(hasEntity2DMaterial(X, GEN)).toBe(true);

    offA(); // drop A too → nothing left for X
    expect(getEntity2DMaterialShaders(X, GEN)).toEqual([]);
    expect(hasEntity2DMaterial(X, GEN)).toBe(false);
  });
});

describe('getEntity2DMaterialShaders', () => {
  it('skips a destroyed shader per-map but keeps live ones across maps', () => {
    const X = 3;
    const live = fakeShader(false);
    const mapA = new Map<number, Entity2DShaderEntry>([[X, entry(fakeShader(true))]]); // destroyed in A
    const mapB = new Map<number, Entity2DShaderEntry>([[X, entry(live)]]);             // live in B
    register(mapA);
    register(mapB);

    expect(getEntity2DMaterialShaders(X, GEN)).toEqual([live]); // exactly B's live shader
  });

  it('returns [] when the entity is absent from every map', () => {
    register(new Map<number, Entity2DShaderEntry>([[1, entry(fakeShader())]]));
    expect(getEntity2DMaterialShaders(999, GEN)).toEqual([]);
  });
});

describe('hasEntity2DMaterial', () => {
  it('is false when every map is destroyed/absent, true once any map has a live shader', () => {
    const X = 5;
    const mapA = new Map<number, Entity2DShaderEntry>([[X, entry(fakeShader(true))]]); // destroyed
    const mapB = new Map<number, Entity2DShaderEntry>();                                // absent
    register(mapA);
    register(mapB);
    expect(hasEntity2DMaterial(X, GEN)).toBe(false);

    mapB.set(X, entry(fakeShader(false))); // now a live one appears
    expect(hasEntity2DMaterial(X, GEN)).toBe(true);
  });
});

describe('dirty set', () => {
  it('marks, reads without consuming, and clears', () => {
    const X = 42;
    expect(isEntity2DMaterialDirty(X, GEN)).toBe(false);

    markEntity2DMaterialDirty(X, GEN);
    expect(isEntity2DMaterialDirty(X, GEN)).toBe(true);
    expect(isEntity2DMaterialDirty(X, GEN)).toBe(true); // reads do not consume the flag

    clearEntity2DMaterialDirty();
    expect(isEntity2DMaterialDirty(X, GEN)).toBe(false);
  });

  it('clearEntity2DMaterialDirty clears all marked entities', () => {
    markEntity2DMaterialDirty(1, GEN);
    markEntity2DMaterialDirty(2, GEN);
    expect(isEntity2DMaterialDirty(1, GEN)).toBe(true);
    expect(isEntity2DMaterialDirty(2, GEN)).toBe(true);
    clearEntity2DMaterialDirty();
    expect(isEntity2DMaterialDirty(1, GEN)).toBe(false);
    expect(isEntity2DMaterialDirty(2, GEN)).toBe(false);
  });
});

describe('#848 world-swap wiring', () => {
  // ⚠️ Drives the REAL `setCurrentWorld`, not a mocked one. This file deliberately does not mock
  // `core/ecs/world`: the broker's `onWorldSwap(...)` registration happens at module load, so a
  // suite that mocked the emitting module would exercise it with NOTHING and stay green with the
  // teardown deleted — the #838 shape.
  it('clears the dirty map on a world swap, where the generation cannot discriminate', () => {
    world = createWorld();
    const a = world.spawn(Transform());
    markEntity2DMaterialDirty(a.id(), a.generation());
    expect(isEntity2DMaterialDirty(a.id(), a.generation())).toBe(true); // accept side

    // A fresh world restarts BOTH id and generation, so the outgoing world's mark would match a
    // live entity in the incoming one — `(id, gen)` is not unique across the boundary.
    const next = createWorld();
    setCurrentWorld(next);
    try {
      expect(isEntity2DMaterialDirty(a.id(), a.generation())).toBe(false);
    } finally {
      // koota's world-id pool is bounded (16) and this file states per-test isolation as its own
      // rule, so the world handed to setCurrentWorld is destroyed here rather than left as the
      // process-global current world for the rest of the file.
      next.destroy();
    }
  });
});

describe('#848 — a recycled entity index does not inherit the dead entity 2D material', () => {
  /** Spawn, register a Shader the way `Scene2DRenderer` does, destroy, respawn. Returns both
   *  entities plus the shader that was registered for the FIRST one. The collision precondition
   *  is asserted by every caller rather than assumed — koota's free list is LIFO today, and a
   *  test that silently stopped colliding would pass while proving nothing. */
  function recycle() {
    world = createWorld();
    const a = world.spawn(Transform());
    const shaderA = fakeShader(false);
    const map = new Map<number, Entity2DShaderEntry>([[a.id(), { shader: shaderA, gen: a.generation() }]]);
    register(map);
    return { a, shaderA, map };
  }

  it('hasEntity2DMaterial is false for the respawned entity, and TRUE for the live one', () => {
    const { a, map } = recycle();

    // Accept side first: the entity that actually registered must still be found. A guard tested
    // only on its reject side can be a bare `return false` and still pass.
    expect(hasEntity2DMaterial(a.id(), a.generation())).toBe(true);

    a.destroy();
    const b = world!.spawn(Transform());
    expect(b.id()).toBe(a.id());                 // the index really was reclaimed…
    expect(b.valueOf()).not.toBe(a.valueOf());   // …and it is genuinely a different entity
    expect(b.generation()).not.toBe(a.generation());

    // B registered nothing. Before the fix this answered TRUE, from A's entry.
    expect(hasEntity2DMaterial(b.id(), b.generation())).toBe(false);
    expect(map.has(b.id())).toBe(true); // the stale entry IS still there — the generation is what rejects it
  });

  it('getEntity2DMaterialShaders returns [] for the respawned entity, and A shader for A', () => {
    const { a, shaderA } = recycle();
    expect(getEntity2DMaterialShaders(a.id(), a.generation())).toEqual([shaderA]); // accept side

    a.destroy();
    const b = world!.spawn(Transform());
    expect(b.id()).toBe(a.id());
    expect(b.valueOf()).not.toBe(a.valueOf());

    // A separate code path from hasEntity2DMaterial — testing one proves nothing about the other.
    expect(getEntity2DMaterialShaders(b.id(), b.generation())).toEqual([]);
  });

  it('the per-frame dirty mark does not carry across a recycled index', () => {
    world = createWorld();
    const a = world.spawn(Transform());
    markEntity2DMaterialDirty(a.id(), a.generation());
    expect(isEntity2DMaterialDirty(a.id(), a.generation())).toBe(true); // accept side

    a.destroy();
    const b = world.spawn(Transform());
    expect(b.id()).toBe(a.id());
    expect(b.valueOf()).not.toBe(a.valueOf());

    // Same frame: the driver marked A at ECS priority, A died, B reclaimed the index, and the
    // render pass reads before the clear. B was never marked.
    expect(isEntity2DMaterialDirty(b.id(), b.generation())).toBe(false);
  });
});
