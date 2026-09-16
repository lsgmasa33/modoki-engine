/** withRendererState — renderer-global bindings (render target / MRT / xr.enabled) must come back
 *  whether the borrowed work RETURNS or THROWS (#1298).
 *
 *  Why the throw side is the point: three restores these only on its own normal-return paths
 *  (`PMREMGenerator.dispose()` calls `_dispose()`, never `_cleanup()`; `CubeRenderTarget`'s
 *  equirect conversion and `CubeCamera.update` likewise). So a lost or degraded GPU context left
 *  the renderer bound to an offscreen target, and every later frame drew into it instead of the
 *  canvas — silently.
 *
 *  A fake renderer is honest here: the mechanism under test is entirely "which setter is called
 *  with which captured value", and it touches no GPU. What a fake CANNOT tell us is whether a real
 *  degraded context throws where we assume — that is stated as unverified in #1298 rather than
 *  implied by a green suite. */

import { describe, it, expect, vi } from 'vitest';
import { withRendererState } from '../../src/runtime/rendering/rendererState';

/** A renderer that actually MODELS the binding rather than just spying on the setter, so a test
 *  can assert the end state rather than a call sequence. `setRenderTarget` spies too, for the
 *  cases that care about how many times it was touched. */
function makeRenderer(initial: unknown = 'CANVAS') {
  const r = {
    _target: initial as unknown,
    _mrt: 'PREV_MRT' as unknown,
    xr: { enabled: true },
    getRenderTarget: vi.fn(() => r._target),
    setRenderTarget: vi.fn((t: unknown) => { r._target = t; }),
    getMRT: vi.fn(() => r._mrt),
    setMRT: vi.fn((m: unknown) => { r._mrt = m; }),
  };
  return r;
}

describe('withRendererState', () => {
  it('returns the callback\'s value and restores the binding on the normal path', () => {
    const r = makeRenderer('CANVAS');
    const out = withRendererState(r, () => {
      r.setRenderTarget('OFFSCREEN');
      return 42;
    });
    expect(out).toBe(42);
    expect(r._target).toBe('CANVAS');
  });

  it('restores the binding when the callback THROWS, and re-throws the original error', () => {
    // The defect. Pre-#1298 the 'pmrem' branch left the renderer on OFFSCREEN here.
    const r = makeRenderer('CANVAS');
    expect(() => withRendererState(r, () => {
      r.setRenderTarget('OFFSCREEN');
      throw new Error('lost device');
    })).toThrow('lost device');
    expect(r._target).toBe('CANVAS');
  });

  it('restores MRT and xr.enabled on a throw too, not just the render target', () => {
    // three's _cleanup() restores xr.enabled alongside the target; since we are replacing that
    // guarantee wholesale, missing either one reproduces the same class of corruption.
    const r = makeRenderer();
    expect(() => withRendererState(r, () => {
      r.setMRT('SCRATCH_MRT');
      r.xr.enabled = false;
      throw new Error('boom');
    })).toThrow('boom');
    expect(r._mrt).toBe('PREV_MRT');
    expect(r.xr.enabled).toBe(true);
  });

  it('captures BEFORE the callback runs — it restores the pre-call value, not the one the callback set', () => {
    // Guards the ordering: a capture performed lazily inside the finally would read the value the
    // callback left behind and "restore" the corruption.
    const r = makeRenderer('CANVAS');
    withRendererState(r, () => { r.setRenderTarget('A'); r.setRenderTarget('B'); });
    expect(r._target).toBe('CANVAS');
  });

  it('a null render target is restored as null — "unbound" is a real value, not "absent"', () => {
    // null is what an on-canvas renderer reports, so conflating it with "no accessor" would make
    // the common case the one that does not restore.
    const r = makeRenderer(null);
    expect(() => withRendererState(r, () => {
      r.setRenderTarget('OFFSCREEN');
      throw new Error('x');
    })).toThrow();
    expect(r._target).toBeNull();
    expect(r.setRenderTarget).toHaveBeenLastCalledWith(null);
  });

  it('restores the active CUBE FACE and MIPMAP LEVEL, not just the target (review finding, #1298)', () => {
    // ⚠️ The render-target binding is a TRIPLE. `setRenderTarget(rt, face = 0, mip = 0)` defaults
    // both trailing arguments, so a one-argument restore silently rebinds face 0 / mip 0. three's
    // `_cleanup()` captures and restores all three — `_oldTarget` plus `_oldActiveCubeFace` and
    // `_oldActiveMipmapLevel`, read from `getActiveCubeFace()`/`getActiveMipmapLevel()` and handed
    // back to `setRenderTarget` (both PMREMGenerator copies, three 0.185.1). Since this helper
    // REPLACES that guarantee
    // on the PMREM branch, a one-argument restore made that branch's SUCCESS path strictly worse
    // than not wrapping it at all — `_cleanup()` restored face 3, then our finally reset it to 0.
    const bound: Array<[unknown, number | undefined, number | undefined]> = [];
    const r = {
      getRenderTarget: () => 'CANVAS',
      getActiveCubeFace: () => 3,
      getActiveMipmapLevel: () => 2,
      setRenderTarget: (t: unknown, face?: number, mip?: number) => { bound.push([t, face, mip]); },
    };
    withRendererState(r, () => 'ok');
    expect(bound).toEqual([['CANVAS', 3, 2]]);
  });

  it('a renderer WITHOUT the face/mip getters still gets a one-argument restore', () => {
    // Passing an explicit `undefined` would be coerced to 0 by three, so "no getter" must mean
    // "do not mention the argument", not "pass undefined".
    const bound: unknown[][] = [];
    const r = {
      getRenderTarget: () => null,
      setRenderTarget: (...args: unknown[]) => { bound.push(args); },
    };
    withRendererState(r, () => 'ok');
    expect(bound).toEqual([[null]]);
  });

  it('a renderer with NO getRenderTarget is left alone — it does not get bound to undefined', () => {
    // The "restore only what was captured" rule. Calling setRenderTarget(undefined) on a renderer
    // whose getter is missing would BIND undefined — turning a no-op into the corruption this
    // helper exists to prevent. Bare `{}` stubs like this are what envPmrem's own suite drives.
    const setRenderTarget = vi.fn();
    const r = { setRenderTarget };
    withRendererState(r, () => 'ok');
    expect(setRenderTarget).not.toHaveBeenCalled();
  });

  it('a renderer with no xr does not throw from the restore path', () => {
    // A throw inside the finally would replace the caller's real error with a TypeError — the one
    // outcome worse than not restoring, because it destroys the diagnosis too.
    const r = { getRenderTarget: () => null, setRenderTarget: vi.fn() };
    expect(() => withRendererState(r, () => { throw new Error('original'); })).toThrow('original');
  });

  it('a totally featureless renderer is a no-op rather than a crash', () => {
    expect(withRendererState({}, () => 7)).toBe(7);
    expect(withRendererState(null, () => 7)).toBe(7);
  });
});
