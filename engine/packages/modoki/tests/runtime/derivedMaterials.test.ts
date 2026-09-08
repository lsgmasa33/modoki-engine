/** derivedMaterials — #828: this module had NO test file at all. The one behaviour worth pinning
 *  is `retireDerivedMaterial`'s idempotency contract (derivedMaterials.ts:160-165): *"a second
 *  retire of the same clone keeps the FIRST dispose step, so an owner cannot lose its cleanup to
 *  a later, less specific one."*
 *
 *  ⚠️ Every PRODUCTION caller passes a functionally identical bare `() => m.dispose()`
 *  (`lightMaskVariants.ts:309`, `scene3DSync.ts:167`/`:1692`/`:3024`) — so no test built against a
 *  real call site could ever observe WHICH of two retires' dispose steps actually runs; both do
 *  the same thing. This file passes two DISTINGUISHABLE closures instead, which is the only way
 *  to tell "first wins" apart from "last wins" or "both run". */
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { createWorld } from 'koota';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import {
  retireDerivedMaterial, retiredDerivedMaterials, retiredDerivedCount,
  disposeRetiredDerivedMaterial, resetDerivedMaterials,
} from '../../src/runtime/rendering/derivedMaterials';

// The retirement queue is module-level (shared across every test file that imports this module),
// so drain it between tests the same way `resetDerivedMaterials` exists to be used at teardown.
afterEach(() => resetDerivedMaterials());

describe('retireDerivedMaterial idempotency', () => {
  it('a SECOND retire of the same clone keeps the FIRST dispose step', () => {
    const clone = new THREE.MeshStandardMaterial();
    const order: string[] = [];

    retireDerivedMaterial(clone, () => order.push('first'));
    retireDerivedMaterial(clone, () => order.push('second')); // must be ignored

    disposeRetiredDerivedMaterial(clone);

    expect(order, 'the FIRST dispose step must be the one that ran').toEqual(['first']);
  });

  it('retiring a clone only once still runs its own dispose step', () => {
    const clone = new THREE.MeshStandardMaterial();
    const order: string[] = [];
    retireDerivedMaterial(clone, () => order.push('only'));

    disposeRetiredDerivedMaterial(clone);

    expect(order).toEqual(['only']);
  });
});

describe('the retirement queue', () => {
  it('tracks size and membership until disposed', () => {
    const clone = new THREE.MeshStandardMaterial();
    expect(retiredDerivedCount()).toBe(0);

    retireDerivedMaterial(clone, () => {});
    expect(retiredDerivedCount()).toBe(1);
    expect(retiredDerivedMaterials().has(clone)).toBe(true);

    disposeRetiredDerivedMaterial(clone);
    expect(retiredDerivedCount(), 'disposed clone must leave the queue').toBe(0);
    expect(retiredDerivedMaterials().has(clone)).toBe(false);
  });

  it('disposing a clone that was never retired is a no-op', () => {
    const clone = new THREE.MeshStandardMaterial();
    expect(() => disposeRetiredDerivedMaterial(clone)).not.toThrow();
    expect(retiredDerivedCount()).toBe(0);
  });
});

describe('the PRODUCTION world-swap wiring (#838) — not the test-only reset hook', () => {
  // Every test above drains the queue through `resetDerivedMaterials()` — the test/teardown
  // export — never the `onWorldSwap(disposeAllRetiredDerived)` registration at module load that is
  // what actually runs on a real scene swap. Deleting that registration line left this whole suite
  // green, which is the gap this test closes: it drives a REAL `setCurrentWorld` swap, the same
  // mechanism `materialInstanceClones.test.ts`'s own wiring test uses, and this file does not mock
  // `core/ecs/world` at all, so the real listener Set is intact.
  it('a real world swap disposes a retired clone that was never explicitly drained', () => {
    const clone = new THREE.MeshStandardMaterial();
    let disposed = false;
    retireDerivedMaterial(clone, () => { disposed = true; });

    setCurrentWorld(createWorld()); // the REAL swap path — must fire the production onWorldSwap listener

    expect(disposed, 'the retired clone\'s dispose step must have run').toBe(true);
    expect(retiredDerivedCount()).toBe(0);
  });
});
