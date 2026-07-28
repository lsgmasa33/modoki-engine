/** core/providerSlot.ts — the P7 L2→L3 injection primitive underlying every provider slot
 *  (particleDefProvider, textureProvider, assetPlumbing, animationAssetProvider,
 *  audioAssetProvider, rig2dProvider, materialProvider, meshColliderProvider,
 *  timelineAssetProvider). Exercises the generic contract directly — register/unregister
 *  (provide/reset), re-registration, double registration, the D5 warn-once-neutral-value
 *  behaviour for an unprovided slot, and independence between two distinct slots. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProviderSlot } from '../../src/runtime/core/providerSlot';

interface Impl { get(): number }

describe('createProviderSlot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is unprovided at creation — isProvided false, get() returns null', () => {
    const slot = createProviderSlot<Impl>('test.fresh');
    expect(slot.isProvided()).toBe(false);
    expect(slot.get()).toBeNull();
  });

  it('provide() then get() returns the exact installed implementation', () => {
    const slot = createProviderSlot<Impl>('test.basic');
    const impl: Impl = { get: () => 42 };
    slot.provide(impl);
    expect(slot.isProvided()).toBe(true);
    expect(slot.get()).toBe(impl); // same reference, not a copy
    expect(slot.get()!.get()).toBe(42);
  });

  it('re-registration (provide called twice) replaces the implementation, no error', () => {
    const slot = createProviderSlot<Impl>('test.reregister');
    const first: Impl = { get: () => 1 };
    const second: Impl = { get: () => 2 };
    slot.provide(first);
    expect(slot.get()).toBe(first);
    slot.provide(second);
    expect(slot.get()).toBe(second);
    expect(slot.get()!.get()).toBe(2);
  });

  it('double registration with the SAME implementation is a harmless no-op', () => {
    const slot = createProviderSlot<Impl>('test.double');
    const impl: Impl = { get: () => 7 };
    slot.provide(impl);
    slot.provide(impl);
    expect(slot.get()).toBe(impl);
    expect(slot.isProvided()).toBe(true);
  });

  it('reset() clears the implementation — isProvided flips back to false', () => {
    const slot = createProviderSlot<Impl>('test.reset');
    slot.provide({ get: () => 1 });
    expect(slot.isProvided()).toBe(true);
    slot.reset();
    expect(slot.isProvided()).toBe(false);
    expect(slot.get()).toBeNull();
  });

  it('reset() then provide() again (teardown/re-init) works cleanly', () => {
    const slot = createProviderSlot<Impl>('test.teardown-reinit');
    slot.provide({ get: () => 1 });
    slot.reset();
    const impl: Impl = { get: () => 99 };
    slot.provide(impl);
    expect(slot.isProvided()).toBe(true);
    expect(slot.get()).toBe(impl);
  });

  it('per D5: an unprovided slot warns ONCE (not on every call) and always returns null', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const slot = createProviderSlot<Impl>('test.warn-once');
    expect(slot.get()).toBeNull();
    expect(slot.get()).toBeNull();
    expect(slot.get()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/test\.warn-once/);
  });

  it('does not throw when read before provide() — the whole point of D5', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const slot = createProviderSlot<Impl>('test.no-throw');
    expect(() => slot.get()).not.toThrow();
  });

  it('reset() clears the warn-once flag too — a fresh unprovided period warns again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const slot = createProviderSlot<Impl>('test.warn-after-reset');
    slot.get(); // warns once
    slot.provide({ get: () => 1 });
    slot.reset();
    slot.get(); // unprovided again — should warn again
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('provide() after an unprovided read silences future warnings (fresh get() calls succeed)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const slot = createProviderSlot<Impl>('test.recover');
    slot.get(); // warns once, returns null
    slot.provide({ get: () => 5 });
    expect(slot.get()!.get()).toBe(5);
    expect(warn).toHaveBeenCalledTimes(1); // no additional warning once provided
  });

  it('two independently created slots never see each other\'s state', () => {
    const a = createProviderSlot<Impl>('test.a');
    const b = createProviderSlot<Impl>('test.b');
    a.provide({ get: () => 1 });
    expect(a.isProvided()).toBe(true);
    expect(b.isProvided()).toBe(false);
    expect(b.get()).toBeNull();
  });
});
