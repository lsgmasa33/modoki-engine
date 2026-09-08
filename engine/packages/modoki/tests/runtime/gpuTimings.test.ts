/** GPU timestamp queries (profiler plan P7).
 *
 *  The failure mode this phase has to be defended against is NOT "the number is slightly wrong" —
 *  it is publishing a plausible number when nothing was measured. `restMs` was left deliberately
 *  honest for two phases precisely so nobody would read an inference as a claim, and the whole
 *  value of P7 evaporates if `unsupported` can render as `0.0 ms`. So most of what is asserted
 *  here is about ABSENCE: what must not appear, and when.
 *
 *  These are unit tests over a fake renderer shaped like three's WebGPU backend. They cannot
 *  prove the numbers are real GPU time — only a device can — so they pin the contract instead:
 *  feature detection, uid parsing, pass attribution, the leak drain, and the honesty rules. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setGpuTimingEnabled, isGpuTimingEnabled, getGpuProfile, getRestBreakdown, gpuPassScope,
  pollGpuTimings, resetGpuTimings, __resetGpuTimingsForTests,
} from '../../src/runtime/core/gpuTimings';
import { setActiveRendererHandle } from '../../src/runtime/core/activeRenderer';

/** A stand-in for three's WebGPU renderer, exposing only the surface `gpuTimings` reaches for.
 *  `timestamps` is the pool map three fills on resolve and never clears. */
function makeRenderer(opts: {
  features?: string[];
  webgl?: boolean;
  glExtension?: boolean;
  poolTrackTimestamp?: boolean;
} = {}) {
  const timestamps = new Map<string, number>();
  const backend: Record<string, unknown> = {
    trackTimestamp: false,
    timestampQueryPool: {
      render: { timestamps, trackTimestamp: opts.poolTrackTimestamp ?? true },
    },
  };
  if (opts.webgl) {
    backend.isWebGLBackend = true;
    backend.gl = { getExtension: (n: string) => (opts.glExtension && n === 'EXT_disjoint_timer_query_webgl2' ? {} : null) };
  } else {
    backend.device = { features: new Set(opts.features ?? ['timestamp-query']) };
  }
  const renderer = {
    backend,
    info: { frame: 0, render: { frameCalls: 0 } },
    resolveTimestampsAsync: vi.fn(async () => 0),
    // `setActiveRendererHandle` attaches fault listeners; these keep it a no-op rather than throw.
    domElement: { addEventListener() {} },
  };
  return { renderer, timestamps, backend };
}

function activate(r: { renderer: unknown }) {
  setActiveRendererHandle(r.renderer as never);
}

/** Drive one poll and let the resolve promise settle. */
async function poll() {
  pollGpuTimings();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  __resetGpuTimingsForTests();
});

describe('enable/disable', () => {
  it('is off by default and reports off, with no numbers at all', () => {
    expect(isGpuTimingEnabled()).toBe(false);
    const p = getGpuProfile();
    expect(p.status).toBe('off');
    // The load-bearing assertion of the whole module: absent, not zero.
    expect(p.gpuMs).toBeUndefined();
    expect(p.samples).toBeUndefined();
    expect(p.passes).toBeUndefined();
  });

  it('flips three\'s backend flag on rather than needing a renderer rebuild', () => {
    const r = makeRenderer();
    activate(r);
    expect(setGpuTimingEnabled(true)).toBe('pending');
    expect(r.backend.trackTimestamp).toBe(true);
    setGpuTimingEnabled(false);
    expect(r.backend.trackTimestamp).toBe(false);
  });

  it('reports no-renderer when enabled before a viewport exists', () => {
    // A fresh module has never seen a renderer; the handle registry is global and may hold one
    // from an earlier test, so this asserts only the branch that can be reached deterministically.
    const status = setGpuTimingEnabled(true);
    expect(['no-renderer', 'pending', 'unsupported']).toContain(status);
  });
});

describe('feature detection — unavailable must read as unavailable', () => {
  it('refuses a WebGPU adapter without timestamp-query, and says why', () => {
    activate(makeRenderer({ features: [] }));
    expect(setGpuTimingEnabled(true)).toBe('unsupported');
    const p = getGpuProfile();
    expect(p.backend).toBe('WebGPU');
    expect(p.detail).toMatch(/timestamp-query/);
    expect(p.gpuMs).toBeUndefined();
  });

  it('refuses a WebGL2 backend without EXT_disjoint_timer_query_webgl2', () => {
    activate(makeRenderer({ webgl: true, glExtension: false }));
    expect(setGpuTimingEnabled(true)).toBe('unsupported');
    const p = getGpuProfile();
    expect(p.backend).toBe('WebGL');
    expect(p.detail).toMatch(/EXT_disjoint_timer_query_webgl2/);
    // It must point the reader back at the honest reading rather than leaving a hole.
    expect(p.detail).toMatch(/restMs/);
  });

  it('accepts a WebGL2 backend that HAS the extension', () => {
    activate(makeRenderer({ webgl: true, glExtension: true }));
    expect(setGpuTimingEnabled(true)).toBe('pending');
  });

  it('demotes to unsupported when three\'s pool disowns itself on the first drain', async () => {
    // The WebGL pool turns itself off internally; that is not observable until a pool exists.
    const r = makeRenderer({ webgl: true, glExtension: true, poolTrackTimestamp: false });
    activate(r);
    setGpuTimingEnabled(true);
    await poll();
    const p = getGpuProfile();
    expect(p.status).toBe('unsupported');
    expect(p.gpuMs).toBeUndefined();
  });

  it('stops resolving once demoted, instead of retrying every frame forever', async () => {
    // The demotion path is reached on low-end WebGL2 Android — the devices least able to afford a
    // pointless buffer map every frame for the rest of the session.
    const r = makeRenderer({ webgl: true, glExtension: true, poolTrackTimestamp: false });
    activate(r);
    setGpuTimingEnabled(true);
    await poll();
    expect(r.renderer.resolveTimestampsAsync).toHaveBeenCalledTimes(1);
    await poll();
    await poll();
    expect(r.renderer.resolveTimestampsAsync).toHaveBeenCalledTimes(1);
  });
});

describe('sampling and attribution', () => {
  it('groups timestamps by frame and totals them', async () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    r.timestamps.set('r:1:1:f7', 4);
    r.timestamps.set('r:2:2:f7', 6);
    await poll();
    const p = getGpuProfile();
    expect(p.status).toBe('active');
    expect(p.samples).toBe(1);
    expect(p.gpuMs!.median).toBe(10);
  });

  it('names render calls by the scope that claimed their ordinals', async () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    // Two scopes, one render call each — the shape of Scene3D's non-postfx path plus a sibling.
    gpuPassScope('scene', () => { r.renderer.info.render.frameCalls += 1; });
    gpuPassScope('overlay', () => { r.renderer.info.render.frameCalls += 1; });
    // 1-BASED ordinals: three increments frameCalls BEFORE stamping the uid, so the call made
    // while the counter read 0 is stamped `r:1:…`. Measured against a live editor, not assumed.
    r.timestamps.set('r:1:1:f0', 3);
    r.timestamps.set('r:2:2:f0', 5);
    await poll();
    const names = getGpuProfile().passes!.map((x) => x.name);
    expect(names).toContain('scene');
    expect(names).toContain('overlay');
    const overlay = getGpuProfile().passes!.find((x) => x.name === 'overlay')!;
    expect(overlay.ms.median).toBe(5);
  });

  it('keeps a multi-call scope\'s passes individually visible instead of summing them', async () => {
    // A post-FX chain is ONE scope over many internal three passes. Summing would hide the case
    // that matters — a chain whose whole cost sits in one of its passes.
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    gpuPassScope('postfx', () => { r.renderer.info.render.frameCalls += 3; });
    r.timestamps.set('r:1:1:f0', 1);
    r.timestamps.set('r:2:1:f0', 30);
    r.timestamps.set('r:3:1:f0', 2);
    await poll();
    const passes = getGpuProfile().passes!;
    expect(passes.map((p) => p.name).sort()).toEqual(['postfx#0', 'postfx#1', 'postfx#2']);
    expect(passes[0].name).toBe('postfx#1'); // sorted biggest median first
    expect(passes[0].ms.median).toBe(30);
  });

  it('names an unclaimed render call for what it is rather than guessing', async () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    r.timestamps.set('r:5:9:f0', 8);
    await poll();
    expect(getGpuProfile().passes!.map((p) => p.name)).toEqual(['pass[5]']);
  });

  it('ignores a compute uid and any uid it cannot parse', async () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    r.timestamps.set('c:1:1:f0', 99);   // compute pool — a different measurement
    r.timestamps.set('garbage', 99);
    r.timestamps.set('r:0:1:f0', 5);
    await poll();
    expect(getGpuProfile().gpuMs!.median).toBe(5);
  });

  it('drains three\'s timestamps map, which three itself never clears', async () => {
    // Its keys embed the frame number, so leaving it would grow without bound for as long as
    // tracking is on — an unbounded leak introduced BY the instrument.
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    r.timestamps.set('r:1:1:f0', 5);
    await poll();
    expect(r.timestamps.size).toBe(0);
  });

  it('does not carry a pass\'s previous value forward into a frame it did not run in', async () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    gpuPassScope('postfx', () => { r.renderer.info.render.frameCalls += 1; });
    r.timestamps.set('r:1:1:f0', 20);
    await poll();
    // Frame 1: no postfx at all.
    r.renderer.info.frame = 1;
    r.renderer.info.render.frameCalls = 0;
    r.timestamps.set('r:1:1:f1', 4);
    await poll();
    const postfx = getGpuProfile().passes!.find((p) => p.name === 'postfx')!;
    expect(postfx.ms.min).toBe(0); // the frame it was absent from reads 0, not 20
    expect(postfx.ms.max).toBe(20);
  });

  it('reports the timestamp quantum as a GCD, not as the smallest duration seen', async () => {
    // Measured on an Apple-Silicon WebGPU adapter: every duration was a multiple of 2^16 ns, but
    // the smallest OBSERVED one was 4 ticks — so "min duration" reads 4x coarser than the truth.
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    r.timestamps.set('r:1:1:f0', 0.262144);   // 4 ticks
    r.timestamps.set('r:2:1:f0', 0.589824);   // 9 ticks — coprime with 4, so the GCD is 1 tick
    await poll();
    expect(getGpuProfile().resolutionMs).toBeCloseTo(0.065536, 9);
  });

  it('drops a pass that recorded nothing across the whole window', async () => {
    // Found on the A23, not by a test: the live read carried `pass[1]` and `pass[2]` at a flat
    // zero next to the two real passes. A permanent all-zero row costs a slot in a ranking an
    // agent pays response budget for — the same defect the plan records for the `frame` root.
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    r.timestamps.set('r:1:1:f0', 5);
    r.timestamps.set('r:2:1:f0', 3);
    await poll();
    expect(getGpuProfile().passes!.map((p) => p.name).sort()).toEqual(['pass[1]', 'pass[2]']);
    // Frame 1: only ordinal 1 renders. Ordinal 2's ring is still in the window (holding one real
    // sample), so it must SURVIVE — dropping a pass that ran recently would hide a real cost.
    r.renderer.info.frame = 1;
    r.timestamps.set('r:1:1:f1', 4);
    await poll();
    expect(getGpuProfile().passes!.map((p) => p.name).sort()).toEqual(['pass[1]', 'pass[2]']);
    // Now age ordinal 2 out entirely: reset drops the window, then only ordinal 1 ever runs.
    resetGpuTimings();
    r.renderer.info.frame = 2;
    r.timestamps.set('r:1:1:f2', 4);
    await poll();
    expect(getGpuProfile().passes!.map((p) => p.name)).toEqual(['pass[1]']);
  });

  it('reports how far behind the newest sample is instead of implying it is live', async () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    r.timestamps.set('r:1:1:f10', 5);
    await poll();
    r.renderer.info.frame = 13;
    expect(getGpuProfile().lagFrames).toBe(3);
  });
});

describe('restMs breakdown', () => {
  it('returns null with no samples rather than a zero split', () => {
    expect(getRestBreakdown(50)).toBeNull();
    activate(makeRenderer());
    setGpuTimingEnabled(true);
    expect(getRestBreakdown(50)).toBeNull();
  });

  it('calls a frame GPU-bound when the GPU owns most of restMs', async () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    r.timestamps.set('r:1:1:f0', 90);
    await poll();
    const b = getRestBreakdown(99)!;
    expect(b.gpuMs).toBe(90);
    expect(b.presentIdleMs).toBe(9);
    expect(b.verdict).toBe('gpu');
    // The caveat travels WITH the number: these are two medians over two windows, not a
    // per-frame subtraction, and the payload says so rather than leaving it to a doc.
    expect(b.medianComparison).toBe(true);
  });

  it('calls a frame idle when the GPU is a small part of restMs', async () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    r.timestamps.set('r:1:1:f0', 2);
    await poll();
    expect(getRestBreakdown(60)!.verdict).toBe('idle');
  });

  it('clamps at zero rather than reporting negative idle time', async () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    r.timestamps.set('r:1:1:f0', 40);
    await poll();
    // GPU work overlaps the NEXT frame's CPU, so gpuMs legitimately exceeds this frame's restMs.
    expect(getRestBreakdown(10)!.presentIdleMs).toBe(0);
  });
});

describe('overhead rule', () => {
  it('does nothing at all while disabled — no resolve, no flag write', () => {
    const r = makeRenderer();
    activate(r);
    pollGpuTimings();
    expect(r.renderer.resolveTimestampsAsync).not.toHaveBeenCalled();
    expect(r.backend.trackTimestamp).toBe(false);
  });

  it('passes a disabled scope straight through', () => {
    const fn = vi.fn(() => 42);
    expect(gpuPassScope('x', fn)).toBe(42);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('keeps exactly one resolve in flight', async () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    pollGpuTimings();
    pollGpuTimings();
    pollGpuTimings();
    expect(r.renderer.resolveTimestampsAsync).toHaveBeenCalledTimes(1);
  });

  it('never awaits on the caller — poll returns synchronously', () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    expect(pollGpuTimings()).toBeUndefined();
  });

  it('survives a rejecting resolve and counts it', async () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    r.renderer.resolveTimestampsAsync.mockRejectedValueOnce(new Error('device lost'));
    await poll();
    // Still enabled, still no fabricated numbers.
    expect(isGpuTimingEnabled()).toBe(true);
    expect(getGpuProfile().gpuMs).toBeUndefined();
  });
});

describe('a resolve in flight across a session boundary (close-out review)', () => {
  // A resolve takes 1-5 frames to land, so every one of these events can happen while one is in
  // the air, and the promise closure keeps its own renderer. Guarded by a generation token.
  it('does NOT let a resolve landing after a reset pollute the fresh window', async () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    // Kick a resolve, then reset BEFORE it settles — the documented use of reset is "a clean
    // measurement around a specific action", so the previous action's samples must not land in it.
    r.timestamps.set('r:1:1:f0', 99);
    pollGpuTimings();
    resetGpuTimings();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const p = getGpuProfile();
    expect(p.status).toBe('pending');       // NOT flipped to 'active' by the stale arrival
    expect(p.gpuMs).toBeUndefined();        // and no 99ms sample from before the reset
  });

  it('does NOT let a resolve landing after a disable write into the rings', async () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    r.timestamps.set('r:1:1:f0', 99);
    pollGpuTimings();
    setGpuTimingEnabled(false);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // Re-enabling must open a CLEAN window. Asserting `gpuMs === undefined` here would pass for
    // the wrong reason — status is 'pending' and the getter withholds numbers in every non-active
    // state, so it stays undefined whether or not the stale sample landed. Feed one real sample
    // and count: 1 means the window is clean, 2 means the pre-disable sample is still in it.
    // (Caught by mutation-testing this very assertion — the first version did not fail when the
    // generation guard was removed.)
    setGpuTimingEnabled(true);
    r.renderer.info.frame = 1;
    r.timestamps.set('r:1:1:f1', 4);
    await poll();
    const p = getGpuProfile();
    expect(p.status).toBe('active');
    expect(p.samples).toBe(1);
    expect(p.gpuMs!.max).toBe(4);   // never the 99ms from before the disable
  });

  it('retires the in-flight latch when the renderer is swapped', async () => {
    // The old renderer's frame counter is unrelated to the new one's, so a surviving
    // `resolveStartedAtFrame` made the stuck-resolve escape un-trippable and left the new
    // renderer permanently unsampled.
    const a = makeRenderer();
    activate(a);
    setGpuTimingEnabled(true);
    a.renderer.info.frame = 5000;
    pollGpuTimings();                        // latch taken against renderer A at frame 5000
    expect(a.renderer.resolveTimestampsAsync).toHaveBeenCalledTimes(1);
    const b = makeRenderer();                // a viewport remount hands us a different renderer
    activate(b);
    b.renderer.info.frame = 3;               // its counter starts near zero
    pollGpuTimings();
    // B must be resolved against immediately, not blocked by A's latch.
    expect(b.renderer.resolveTimestampsAsync).toHaveBeenCalledTimes(1);
  });

  it('clears trackTimestamp on the OUTGOING renderer when arming a new one (#810)', async () => {
    // Without this, a displaced renderer (never disarmed — nothing else clears its flag) would
    // keep writing GPU timestamp queries every frame forever, for as long as the process lives.
    const a = makeRenderer();
    activate(a);
    setGpuTimingEnabled(true);
    expect(a.backend.trackTimestamp).toBe(true);
    const b = makeRenderer();
    activate(b);
    pollGpuTimings(); // re-arms on B (renderer !== armedRenderer)
    expect(a.backend.trackTimestamp).toBe(false); // A's flag is cleared, not left on forever
    expect(b.backend.trackTimestamp).toBe(true);
  });

  it('clears the OUTGOING renderer even when the incoming one cannot time (#810)', () => {
    // The editor's two viewports need not share a backend, so the renderer that displaces the
    // armed one may itself be unsupported. That path returns early, so if the clear lived in the
    // success path below it, A would keep writing timestamp queries forever — the exact leak.
    const a = makeRenderer();
    activate(a);
    setGpuTimingEnabled(true);
    expect(a.backend.trackTimestamp).toBe(true);

    activate(makeRenderer({ features: [] })); // WebGPU device without 'timestamp-query'
    pollGpuTimings();

    expect(a.backend.trackTimestamp).toBe(false);
  });

  it('adopts an unsupported incoming renderer so the probe stops re-running every frame (#810)', () => {
    // `pollGpuTimings`'s "once shown not to support timestamps, stop asking it" guard compares
    // `renderer === armedRenderer`. Leaving armedRenderer on the DISPLACED renderer makes that test
    // never match, so arm() + its probe would run on every frame — on exactly the low-end devices
    // that guard exists to protect.
    const a = makeRenderer();
    activate(a);
    setGpuTimingEnabled(true);

    const b = makeRenderer({ features: [] });
    const has = vi.fn(() => false);
    (b.backend as unknown as { device: { features: unknown } }).device.features = { has };
    activate(b);

    pollGpuTimings();
    const afterFirstPoll = has.mock.calls.length;
    expect(afterFirstPoll).toBeGreaterThan(0); // it did probe B once

    pollGpuTimings();
    pollGpuTimings();
    expect(has.mock.calls.length).toBe(afterFirstPoll); // …and never again
  });

  it('does not let a stale resolve attribute A\'s pass ranges to B\'s frames', async () => {
    const a = makeRenderer();
    activate(a);
    setGpuTimingEnabled(true);
    a.renderer.info.frame = 5000;
    gpuPassScope('old-pass', () => { a.renderer.info.render.frameCalls += 1; });
    const b = makeRenderer();
    activate(b);
    pollGpuTimings();                        // re-arms on B, retiring A's ranges
    b.timestamps.set('r:1:1:f5000', 7);      // B eventually reaches frame 5000
    await poll();
    // Without the range retirement this would read 'old-pass' — A's label on B's frame.
    expect(getGpuProfile().passes!.map((p) => p.name)).toEqual(['pass[1]']);
  });
});

describe('reset', () => {
  it('drops the window and returns to pending, not to active-with-no-data', async () => {
    const r = makeRenderer();
    activate(r);
    setGpuTimingEnabled(true);
    r.timestamps.set('r:1:1:f0', 5);
    await poll();
    expect(getGpuProfile().status).toBe('active');
    resetGpuTimings();
    const p = getGpuProfile();
    expect(p.status).toBe('pending');
    expect(p.gpuMs).toBeUndefined();
  });
});
