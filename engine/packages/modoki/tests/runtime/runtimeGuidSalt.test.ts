/** Runtime guids are unique per PAGE LOAD (#1223 D5).
 *
 *  The generation counter is module state, so every page load restarted it at 1 and re-issued the
 *  previous page's guids (observed live in the editor, 2026-09-15). `app/main.tsx` now calls
 *  `saltRuntimeGuidGeneration()` once; the harness never does. The counter lives in module scope and
 *  the salt is idempotent, so each case loads a FRESH module graph (`vi.resetModules`) — a new realm's
 *  worth of state, which is exactly the page load being modelled. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorld } from 'koota';

async function freshRealm() {
  vi.resetModules();
  const world = await import('../../src/runtime/core/ecs/world');
  const { EntityAttributes } = await import('../../src/runtime/core/traits/EntityAttributes');
  const { parseRuntimeGuid } = await import('../../src/runtime/core/assetRefRules');
  /** Mint in a NEW world and return that world's generation. */
  const mintGeneration = () => {
    const w = createWorld();
    const e = world.spawnEntity(w, EntityAttributes({ name: 'probe' }));
    return parseRuntimeGuid((e.get(EntityAttributes) as { guid: string }).guid)!.generation;
  };
  return { world, mintGeneration };
}

beforeEach(() => { vi.resetModules(); });

describe('saltRuntimeGuidGeneration (#1223 D5)', () => {
  // Mutation: make the salt's body a no-op (the pre-fix page load).
  it('an unsalted realm starts at generation 1; a salted one starts at the random base, above 2^20', async () => {
    const plain = await freshRealm();
    expect(plain.mintGeneration()).toBe(1); // what the harness still gets: deterministic

    const page = await freshRealm();
    page.world.saltRuntimeGuidGeneration(4321);
    expect(page.mintGeneration()).toBe(0x100000 + 4321);
    expect(page.mintGeneration()).toBe(0x100000 + 4322); // …and counts on from there, one per world
  });

  // Mutation: drop the `generationSalted` guard, so a second call moves the base under live guids.
  it('is idempotent: a second call does not move the counter', async () => {
    const page = await freshRealm();
    page.world.saltRuntimeGuidGeneration(10);
    const first = page.mintGeneration();
    page.world.saltRuntimeGuidGeneration(900_000);
    expect(page.mintGeneration()).toBe(first + 1);
  });

  // Mutation: widen `span` to 0xffffffff, so a draw near the top overflows the 32-bit generation and the
  // format throws. (0xfffffffe, not 0xffffffff: the latter is 0 modulo the widened span, and passes.)
  it('a draw near the top still leaves 2^20 generations below the 32-bit ceiling', async () => {
    const page = await freshRealm();
    page.world.saltRuntimeGuidGeneration(0xfffffffe);
    const g = page.mintGeneration();
    expect(g).toBeGreaterThanOrEqual(0x100000);
    expect(0xffffffff - g).toBeGreaterThanOrEqual(0x100000 - 1);
  });

  // Two page loads with different random draws do not re-issue each other's generations.
  it('two salted realms with different draws mint different generations', async () => {
    const a = await freshRealm();
    a.world.saltRuntimeGuidGeneration(1_000);
    const b = await freshRealm();
    b.world.saltRuntimeGuidGeneration(2_000_000);
    expect(a.mintGeneration()).not.toBe(b.mintGeneration());
  });
});
