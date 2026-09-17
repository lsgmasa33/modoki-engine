/** worldScoped (#1315): module state keyed by the koota world, so a swap needs no reset list. */

import { afterEach, describe, expect, it } from 'vitest';
import { createWorld, type World } from 'koota';
import { worldScoped } from '../../src/runtime/core/ecs/worldScoped';
import { getCurrentWorld, setCurrentWorld } from '../../src/runtime/core/ecs/worldRegistry';

// koota caps live worlds at 16, so every world a test makes is destroyed after it.
const made: World[] = [];
function world(): World {
  const w = createWorld();
  made.push(w);
  return w;
}
afterEach(() => {
  const original = getCurrentWorld();
  for (const w of made.splice(0)) if (w !== original) w.destroy();
});

describe('worldScoped', () => {
  it('a value set in one world is invisible in another live world', () => {
    const a = world();
    const b = world();
    const slot = worldScoped<string | null>(() => null);
    slot.set('level-a', a);
    expect(slot.get(a)).toBe('level-a');
    expect(slot.get(b), 'a second live world must start from init()').toBeNull();
    slot.set('level-b', b);
    expect(slot.get(a), 'writing world B must not touch world A').toBe('level-a');
  });

  it('defaults to the current world, and a swap reads the new world without any reset call', () => {
    const before = getCurrentWorld();
    const a = world();
    const b = world();
    const slot = worldScoped<string | null>(() => null);
    try {
      setCurrentWorld(a);
      // The capture-once idiom that was #1315's defect: "first read of this world wins".
      if (slot.get() === null) slot.set('captured-in-a');
      setCurrentWorld(b);
      expect(slot.get(), 'the capture from world A must not carry into world B').toBeNull();
      if (slot.get() === null) slot.set('captured-in-b');
      expect(slot.get()).toBe('captured-in-b');
      setCurrentWorld(a);
      expect(slot.get(), 'swapping back sees A\'s own value').toBe('captured-in-a');
    } finally {
      setCurrentWorld(before);
    }
  });

  it('init runs once per world, so a mutable default is never shared', () => {
    const a = world();
    const b = world();
    let calls = 0;
    const slot = worldScoped(() => { calls++; return { w: 0, h: 0 }; });
    slot.get(a).w = 320;
    expect(slot.get(a).w).toBe(320);
    expect(slot.get(b).w).toBe(0);
    expect(calls).toBe(2);
  });

  it('reset forgets only that world, and the next get re-runs init', () => {
    const a = world();
    const b = world();
    const slot = worldScoped(() => 0);
    slot.set(1, a);
    slot.set(2, b);
    slot.reset(a);
    expect(slot.get(a)).toBe(0);
    expect(slot.get(b)).toBe(2);
  });

  it('a bare reset() clears the CURRENT world — the form every adopting game calls', () => {
    const before = getCurrentWorld();
    const a = world();
    const b = world();
    const slot = worldScoped(() => 0);
    try {
      slot.set(1, a);
      slot.set(2, b);
      setCurrentWorld(a);
      slot.reset();
      expect(slot.get(a)).toBe(0);
      expect(slot.get(b), 'a bare reset must not reach a non-current world').toBe(2);
    } finally {
      setCurrentWorld(before);
    }
  });

  it('a stored undefined is a value, not "never written"', () => {
    const a = world();
    let calls = 0;
    const slot = worldScoped<number | undefined>(() => { calls++; return 7; });
    slot.set(undefined, a);
    expect(slot.get(a)).toBeUndefined();
    expect(calls).toBe(0);
  });
});
