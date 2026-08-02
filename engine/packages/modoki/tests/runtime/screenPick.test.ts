/** `screenPick.ts` — the pick-provider registry (F15, `docs/enact.md`).
 *  Sibling of `screenBounds.test.ts`: register/unregister, per-surface keying, and the three-way
 *  `id | null | undefined` distinction the whole design leans on — a throwing provider must be
 *  treated as "cannot answer" (`undefined`), never as a confident miss (`null`). */
import { describe, it, expect, afterEach } from 'vitest';
import {
  registerPickProvider, pickAt, pickableSurfaces, hasPickProvider,
  __resetPickProvidersForTest, type PickProvider,
} from '../../src/runtime/core/screenPick';

afterEach(() => { __resetPickProvidersForTest(); });

describe('registerPickProvider / pickAt', () => {
  it('returns the entity id a provider reports for its surface', () => {
    registerPickProvider(() => 42, 'scene-view');
    expect(pickAt('scene-view', 10, 10)).toBe(42);
  });

  it('returns null for "nothing there" — distinct from "no provider"', () => {
    registerPickProvider(() => null, 'scene-view');
    expect(pickAt('scene-view', 10, 10)).toBeNull();
  });

  it('returns undefined when no provider is registered for the surface — the question was never asked', () => {
    registerPickProvider(() => 42, 'scene-view');
    expect(pickAt('game-3d', 10, 10)).toBeUndefined();
  });

  it('the three answers stay distinct even when all three surfaces are live', () => {
    registerPickProvider(() => 1, 'scene-view');
    registerPickProvider(() => null, 'game-3d');
    // game-2d: nothing registered at all.
    expect(pickAt('scene-view', 0, 0)).toBe(1);
    expect(pickAt('game-3d', 0, 0)).toBeNull();
    expect(pickAt('game-2d', 0, 0)).toBeUndefined();
  });

  it('a throwing provider is treated as unable to answer (undefined), NOT as a miss', () => {
    registerPickProvider(() => { throw new Error('boom'); }, 'scene-view');
    // A confident `null` here would be a false guarantee — see the rule in screenPick.ts's header.
    expect(pickAt('scene-view', 0, 0)).toBeUndefined();
  });

  it('one bad provider does not block another provider on the SAME surface from answering', () => {
    registerPickProvider(() => { throw new Error('boom'); }, 'scene-view');
    registerPickProvider(() => 7, 'scene-view');
    expect(pickAt('scene-view', 0, 0)).toBe(7);
  });

  it('several providers on one surface: first non-null wins, registration order', () => {
    registerPickProvider(() => null, 'scene-view');
    registerPickProvider(() => 5, 'scene-view');
    registerPickProvider(() => 9, 'scene-view'); // never reached — 5 already won
    expect(pickAt('scene-view', 0, 0)).toBe(5);
  });

  it('#80: a higher-priority provider wins regardless of registration order', () => {
    // Registered FIRST but at the default (lower) priority — must NOT win.
    registerPickProvider(() => 1, 'scene-view');
    // Registered SECOND but at higher priority — must win despite mounting later.
    registerPickProvider(() => 2, 'scene-view', 10);
    expect(pickAt('scene-view', 0, 0)).toBe(2);
  });

  it('#80: equal priority falls back to registration order', () => {
    registerPickProvider(() => 1, 'scene-view', 5);
    registerPickProvider(() => 2, 'scene-view', 5);
    expect(pickAt('scene-view', 0, 0)).toBe(1);
  });

  it('#80: a higher-priority provider that answers null still lets a lower-priority provider answer', () => {
    registerPickProvider(() => null, 'scene-view', 10);
    registerPickProvider(() => 3, 'scene-view', 0);
    expect(pickAt('scene-view', 0, 0)).toBe(3);
  });

  it('passes the (x, y) through to the provider untouched', () => {
    let seen: [number, number] | null = null;
    const fn: PickProvider = (x, y) => { seen = [x, y]; return null; };
    registerPickProvider(fn, 'scene-view');
    pickAt('scene-view', 123, 456);
    expect(seen).toEqual([123, 456]);
  });

  it('unregistering drops the provider — the surface reverts to "no picker" (undefined)', () => {
    const unreg = registerPickProvider(() => 1, 'scene-view');
    expect(pickAt('scene-view', 0, 0)).toBe(1);
    unreg();
    expect(pickAt('scene-view', 0, 0)).toBeUndefined();
  });
});

describe('pickableSurfaces / hasPickProvider', () => {
  it('reports a registered surface and drops it again on unregister', () => {
    expect(hasPickProvider('scene-view')).toBe(false);
    const unreg = registerPickProvider(() => null, 'scene-view');
    expect(hasPickProvider('scene-view')).toBe(true);
    expect(pickableSurfaces()).toContain('scene-view');
    unreg();
    expect(hasPickProvider('scene-view')).toBe(false);
    expect(pickableSurfaces()).not.toContain('scene-view');
  });

  it('de-duplicates: two providers on the same surface list it once', () => {
    registerPickProvider(() => null, 'game-2d');
    registerPickProvider(() => null, 'game-2d');
    expect(pickableSurfaces().filter((s) => s === 'game-2d')).toEqual(['game-2d']);
  });

  it('does not call any provider — a throwing provider cannot break it', () => {
    let calls = 0;
    registerPickProvider(() => { calls++; throw new Error('boom'); }, 'scene-view');
    expect(pickableSurfaces()).toContain('scene-view');
    expect(hasPickProvider('scene-view')).toBe(true);
    expect(calls).toBe(0);
  });
});
