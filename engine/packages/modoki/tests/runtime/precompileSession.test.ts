/** The renderer borrowed by a post-FX stage precompile (#323).
 *
 *  Every case here is a defect that was found by review AFTER the feature landed, so each one is
 *  named for the failure rather than the function: a permanently no-op renderer, a blank frame
 *  submitted past the gate's ceiling, and a capture reading back an untouched buffer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginPrecompile, isPrecompileActive, endAllPrecompiles, runExclusivePrecompile,
  resetPrecompileSession, PRECOMPILE_MAX_HOLD_MS,
} from '../../src/runtime/rendering/postfx/precompileSession';

/** As much of three's `Renderer` as the session touches. */
function fakeRenderer() {
  const drawn: Array<{ object: unknown; target: unknown }> = [];
  let target: unknown = null;
  let mrt: unknown = null;
  const r = {
    realRender: null as unknown,
    drawn,
    render(object: unknown, camera?: unknown) { drawn.push({ object, target: camera }); },
    toneMapping: 4,
    outputColorSpace: 'srgb',
    depth: true,
    stencil: false,
    xr: { enabled: true },
    getMRT() { return mrt; },
    setMRT(m: unknown) { mrt = m; return this; },
    getRenderTarget() { return target; },
    setRenderTarget(rt: unknown) { target = rt; return this; },
  };
  r.realRender = r.render;
  return r;
}

const material = (name: string) => ({ isMaterial: true, name });

describe('beginPrecompile — saves and restores every field the compile mutates', () => {
  let r: ReturnType<typeof fakeRenderer>;
  beforeEach(() => { r = fakeRenderer(); resetPrecompileSession(r); });

  it('restores render, tone mapping, colour space, xr, depth/stencil, MRT and target together', () => {
    const rtA = { isRenderTarget: true };
    r.setRenderTarget(rtA);
    r.setMRT({ mrt: 1 });
    const session = beginPrecompile(r, 0)!;
    expect(session).not.toBeNull();
    expect(r.render).not.toBe(r.realRender);

    r.toneMapping = 0;
    r.outputColorSpace = 'srgb-linear';
    r.xr.enabled = false;
    r.depth = false;
    r.stencil = true;
    r.setRenderTarget({ isRenderTarget: true, other: true });
    r.setMRT(null);

    session.end();
    expect(r.render).toBe(r.realRender);
    expect(r.toneMapping).toBe(4);
    expect(r.outputColorSpace).toBe('srgb');
    expect(r.xr.enabled).toBe(true);
    expect(r.depth).toBe(true);
    expect(r.stencil).toBe(false);
    expect(r.getRenderTarget()).toBe(rtA);
    expect(r.getMRT()).toEqual({ mrt: 1 });
  });

  it('returns null for something that is not renderer-shaped, rather than proceeding unprotected', () => {
    expect(beginPrecompile(null, 0)).toBeNull();
    expect(beginPrecompile(42, 0)).toBeNull();
    expect(beginPrecompile({}, 0)).toBeNull();
  });

  it('end() is idempotent', () => {
    const session = beginPrecompile(r, 0)!;
    session.end(); session.end(); session.end();
    expect(r.render).toBe(r.realRender);
  });
});

/** ⚠️ THE CRITICAL ONE. `liveCompileGate.tick()` guards on `armed`, never on `pending`, so a stack
 *  rebuild mid-compile kicks a SECOND `compileStagesAsync` — and the two belong to different
 *  `PostFXStack` instances, so no instance-level guard can see it. With plain save/restore, call B
 *  captured call A's STUB as its "original", A restored the real render, and B then restored A's
 *  stub: `renderer.render` was a permanent no-op for the rest of the session. */
describe('overlapping sessions cannot corrupt the renderer', () => {
  let r: ReturnType<typeof fakeRenderer>;
  beforeEach(() => { r = fakeRenderer(); resetPrecompileSession(r); });

  it('a nested session shares the first one\'s saved state and only the LAST end() restores', () => {
    const a = beginPrecompile(r, 0)!;
    const stub = r.render;
    const b = beginPrecompile(r, 0)!;
    expect(r.render).toBe(stub);        // B did not install a second stub over A's

    a.end();
    expect(r.render).toBe(stub);        // still held by B — NOT restored early
    b.end();
    expect(r.render).toBe(r.realRender); // and the REAL one comes back, never a stub
  });

  it('restores the real renderer whatever order the two sessions end in', () => {
    const a = beginPrecompile(r, 0)!;
    const b = beginPrecompile(r, 0)!;
    b.end();
    a.end();
    expect(r.render).toBe(r.realRender);
    expect(r.toneMapping).toBe(4);
  });

  it('a later session after a clean one still saves the REAL render, not a stale stub', () => {
    beginPrecompile(r, 0)!.end();
    const second = beginPrecompile(r, 0)!;
    second.end();
    expect(r.render).toBe(r.realRender);
  });

  it('runExclusivePrecompile serialises per renderer, so overlap never happens at all', async () => {
    const order: string[] = [];
    const slow = () => new Promise<void>((res) => {
      order.push('A-start');
      setTimeout(() => { order.push('A-end'); res(); }, 20);
    });
    const fast = async () => { order.push('B-start'); order.push('B-end'); };
    const pa = runExclusivePrecompile(r, slow);
    const pb = runExclusivePrecompile(r, fast);
    await Promise.all([pa, pb]);
    expect(order).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
  });

  it('a rejecting compile does not wedge the ones queued behind it', async () => {
    const boom = () => Promise.reject(new Error('bad shader'));
    let ran = false;
    await expect(runExclusivePrecompile(r, boom)).rejects.toThrow('bad shader');
    await runExclusivePrecompile(r, async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('serialisation is per renderer — a second renderer is not blocked', async () => {
    const r2 = fakeRenderer();
    resetPrecompileSession(r2);
    let released!: () => void;
    const blocked = runExclusivePrecompile(r, () => new Promise<void>((res) => { released = res; }));
    let otherRan = false;
    await runExclusivePrecompile(r2, async () => { otherRan = true; });
    expect(otherRan).toBe(true);
    released();
    await blocked;
  });
});

/** ⚠️ THE OTHER CRITICAL ONE. `liveCompileGate`'s ceiling releases the FRAME without waiting for
 *  the compile — deliberate, documented. So the frame that gets past it must not draw through a
 *  stubbed `render`: that submits nothing and then `markScenePainted()` lifts the loading overlay
 *  over a blank canvas, which is #334's bug from the other side. */
describe('the hold has its own ceiling, and asking is what ends it', () => {
  let r: ReturnType<typeof fakeRenderer>;
  beforeEach(() => { r = fakeRenderer(); resetPrecompileSession(r); });

  it('reports active while a compile holds the renderer', () => {
    const session = beginPrecompile(r, 1_000)!;
    expect(isPrecompileActive(r, 1_000)).toBe(true);
    session.end();
    expect(isPrecompileActive(r, 1_000)).toBe(false);
  });

  it('past the deadline it RESTORES the renderer and answers false', () => {
    const session = beginPrecompile(r, 0)!;
    expect(r.render).not.toBe(r.realRender);
    expect(isPrecompileActive(r, PRECOMPILE_MAX_HOLD_MS - 1)).toBe(true);
    expect(isPrecompileActive(r, PRECOMPILE_MAX_HOLD_MS)).toBe(false);
    expect(r.render).toBe(r.realRender);  // the asker got the renderer back, not just a `false`
    expect(session.alive).toBe(false);    // and the compile can see it must stop
  });

  it('its ceiling is BELOW the gate\'s 5 s hold, so the stub is gone before a frame is released', () => {
    expect(PRECOMPILE_MAX_HOLD_MS).toBeLessThan(5_000);
  });

  it('a torn-down session\'s end() cannot restore a second time over a newer one', () => {
    const stale = beginPrecompile(r, 0)!;
    isPrecompileActive(r, PRECOMPILE_MAX_HOLD_MS);      // force-ends `stale`
    const fresh = beginPrecompile(r, 0)!;
    const freshStub = r.render;
    stale.end();                                        // must be inert
    expect(r.render).toBe(freshStub);
    fresh.end();
    expect(r.render).toBe(r.realRender);
  });

  it('endAllPrecompiles hands the renderer straight back — the capture path', () => {
    const session = beginPrecompile(r, 0)!;
    endAllPrecompiles(r);
    expect(r.render).toBe(r.realRender);
    expect(session.alive).toBe(false);
    expect(isPrecompileActive(r, 0)).toBe(false);
  });

  it('a joined session is ended too, so a capture is never half-freed', () => {
    const a = beginPrecompile(r, 0)!;
    const b = beginPrecompile(r, 0)!;
    endAllPrecompiles(r);
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(false);
    expect(r.render).toBe(r.realRender);
  });
});

describe('the stub RECORDS instead of discarding — this is where the job pairs come from', () => {
  let r: ReturnType<typeof fakeRenderer>;
  beforeEach(() => { r = fakeRenderer(); resetPrecompileSession(r); });

  it('captures (material, bound target) for each swallowed draw, in order', () => {
    const session = beginPrecompile(r, 0)!;
    const m0 = material('Bloom_highPass'); const m1 = material('Bloom_comp');
    const t0 = { isRenderTarget: true, n: 0 }; const t1 = { isRenderTarget: true, n: 1 };
    r.setRenderTarget(t0);
    r.render({ material: m0 }, null);
    r.setRenderTarget(t1);
    r.render({ material: m1 }, null);
    expect(session.draws).toEqual([
      { material: m0, target: t0 },
      { material: m1, target: t1 },
    ]);
    session.end();
  });

  it('swallows the draw — nothing reaches the real renderer', () => {
    const session = beginPrecompile(r, 0)!;
    r.render({ material: material('x') }, null);
    expect(r.drawn).toHaveLength(0);
    session.end();
  });

  it('ignores an object with no material — a scene pass draw', () => {
    const session = beginPrecompile(r, 0)!;
    r.render({ isScene: true }, null);
    r.render(null, null);
    expect(session.draws).toHaveLength(0);
    session.end();
  });

  it('records a canvas-target draw with target null, for the caller to skip', () => {
    const session = beginPrecompile(r, 0)!;
    r.setRenderTarget(null);
    r.render({ material: material('terminal') }, null);
    expect(session.draws[0].target).toBeNull();
    session.end();
  });
});
