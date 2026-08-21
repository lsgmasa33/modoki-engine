/** #238 — the post-FX scene-pass precompile must warm the render context the pass is actually
 *  drawn through.
 *
 *  three keys its RenderContexts by `(attachmentState, mrt, callDepth)` and folds `context.id`
 *  into `RenderObject.getMaterialCacheKey()`, so the node-builder cache is per-context-INSTANCE.
 *  `Renderer.compile()` always asks for the depth-0 context while the pass renders at depth 1 —
 *  measured on `demos/postfx-demo`: the compile warmed context #4, the first frame drew through
 *  #5, and rebuilt every shader graph synchronously (513 ms of an 807 ms block on an A23).
 *
 *  These cases pin the two halves that make the fix safe rather than merely fast: the remap is
 *  scoped to the pass's own target (a top-level render landing during the compile's awaits must
 *  NOT be handed a nested context), and the lookup is always restored. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  pinPassCallDepth, observePassCallDepth, getPassCallDepth, resetPassCallDepth,
  DEFAULT_PASS_CALL_DEPTH,
} from '../../src/runtime/rendering/postfx/passCompileContext';

/** A stand-in for three's `Renderer`, exposing only the private field the pin reaches for. */
function makeRenderer(callDepth = -1) {
  const calls: Array<{ rt: unknown; mrt: unknown; depth: number | undefined }> = [];
  const original = function get(this: unknown, rt: unknown, mrt: unknown, depth?: number) {
    calls.push({ rt, mrt, depth });
    return { id: `ctx@${depth ?? 0}` };
  };
  return {
    _callDepth: callDepth,
    _renderContexts: { get: original },
    calls,
    original,
  };
}

beforeEach(() => resetPassCallDepth());

describe('pinPassCallDepth', () => {
  it('remaps the default call depth for the pass target', async () => {
    const r = makeRenderer();
    const target = { name: 'pass-rt' };
    await pinPassCallDepth(r, target, 1, async () => {
      // Exactly what `Renderer.compile()` does: two arguments, so `callDepth` is undefined.
      r._renderContexts.get(target, 'mrt');
    });
    expect(r.calls).toEqual([{ rt: target, mrt: 'mrt', depth: 1 }]);
  });

  it('leaves a lookup for any OTHER render target alone', async () => {
    const r = makeRenderer();
    const target = { name: 'pass-rt' };
    await pinPassCallDepth(r, target, 1, async () => {
      // A top-level render to the canvas landing during the compile's awaits. Handing it the
      // nested context would trade a boot win for a live rendering bug.
      r._renderContexts.get(null, null);
      r._renderContexts.get({ name: 'other-rt' }, null);
    });
    expect(r.calls.map((c) => c.depth)).toEqual([undefined, undefined]);
  });

  it('leaves an EXPLICIT call depth alone (three clears at -1)', async () => {
    const r = makeRenderer();
    const target = { name: 'pass-rt' };
    await pinPassCallDepth(r, target, 1, async () => {
      r._renderContexts.get(target, null, -1);
      r._renderContexts.get(target, null, 2);
    });
    expect(r.calls.map((c) => c.depth)).toEqual([-1, 2]);
  });

  it('restores the original lookup afterwards — and when the compile throws', async () => {
    const r = makeRenderer();
    const target = {};
    await pinPassCallDepth(r, target, 1, async () => {});
    expect(r._renderContexts.get).toBe(r.original);

    await expect(pinPassCallDepth(r, target, 1, async () => { throw new Error('compile failed'); }))
      .rejects.toThrow('compile failed');
    expect(r._renderContexts.get).toBe(r.original);
  });

  // ⚠️ The failure this pins is silent in BOTH directions, and reachable on an ordinary double
  // swap: `liveCompileGate` kicks a second compile while the first is still in flight, and a swap
  // can rebuild the stack, so the second pins a different render target.
  it('survives two overlapping compiles, whichever settles first', async () => {
    const r = makeRenderer();
    const a = { name: 'rt-A' };
    const b = { name: 'rt-B' };
    let releaseA!: () => void;
    let releaseB!: () => void;
    const compileA = pinPassCallDepth(r, a, 1, () => new Promise<void>((res) => { releaseA = res; }));
    const compileB = pinPassCallDepth(r, b, 2, () => new Promise<void>((res) => { releaseB = res; }));

    // The OUTER compile settles first — under a save/restore pair this is where B's pin silently
    // switched off, and B then reinstalled A's wrapper permanently.
    releaseA();
    await compileA;
    r._renderContexts.get(b, null);
    expect(r.calls.at(-1)).toEqual({ rt: b, mrt: null, depth: 2 });
    // A's pin is gone with A.
    r._renderContexts.get(a, null);
    expect(r.calls.at(-1)).toEqual({ rt: a, mrt: null, depth: undefined });

    releaseB();
    await compileB;
    // Uninstalled exactly once, back to the real lookup.
    expect(r._renderContexts.get).toBe(r.original);
  });

  it('still runs the compile when the renderer has no _renderContexts', async () => {
    // A three upgrade that moves the field must cost the optimisation, never the boot.
    const run = vi.fn(async () => 'done');
    await expect(pinPassCallDepth({}, {}, 1, run)).resolves.toBe('done');
    await expect(pinPassCallDepth(null, {}, 1, run)).resolves.toBe('done');
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('observePassCallDepth', () => {
  it('starts from the documented default', () => {
    expect(getPassCallDepth()).toBe(DEFAULT_PASS_CALL_DEPTH);
  });

  it('records callDepth + 1, forwards the frame, and unwraps itself', () => {
    const original = vi.fn();
    const scenePass = { updateBefore: original };
    const renderer = { _callDepth: 0 };
    observePassCallDepth(scenePass, renderer);
    const wrapper = scenePass.updateBefore;
    expect(wrapper).not.toBe(original);

    scenePass.updateBefore('frame-1');
    expect(original).toHaveBeenCalledWith('frame-1');
    // The pass renders one level deeper than the draw it is called from.
    expect(getPassCallDepth()).toBe(1);

    // Unwrapped: the hook is gone from the per-frame path, and asserted by BEHAVIOUR rather than
    // by identity — it restores a bound copy, so a reference check would pass on a hook that
    // still ran. Moving the renderer to another depth must now change nothing.
    expect(scenePass.updateBefore).not.toBe(wrapper);
    renderer._callDepth = 5;
    scenePass.updateBefore('frame-2');
    expect(original).toHaveBeenCalledWith('frame-2');
    expect(getPassCallDepth()).toBe(1);
  });

  it('warns ONCE and pins the observed depth when the stack nests deeper', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scenePass = { updateBefore: vi.fn() };
    observePassCallDepth(scenePass, { _callDepth: 1 });
    scenePass.updateBefore('frame');
    expect(getPassCallDepth()).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('call depth 2');

    // A rebuild constructs a new stack; it must not go back to guessing.
    const second = { updateBefore: vi.fn() };
    observePassCallDepth(second, { _callDepth: 1 });
    second.updateBefore('frame');
    expect(getPassCallDepth()).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('tolerates a pass with no updateBefore, and a renderer with no _callDepth', () => {
    expect(() => observePassCallDepth({} as never, {})).not.toThrow();
    const scenePass = { updateBefore: vi.fn() };
    observePassCallDepth(scenePass, {});
    scenePass.updateBefore('frame');
    expect(getPassCallDepth()).toBe(DEFAULT_PASS_CALL_DEPTH);
  });
});
