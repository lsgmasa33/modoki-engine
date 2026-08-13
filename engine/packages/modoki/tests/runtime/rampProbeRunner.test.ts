// @vitest-environment jsdom
/** Boot ramp probe (#188) — the IMPURE runner half (#205 R5.3 / R5.4).
 *
 *  `rampProbe.test.ts` covers the pure policy/maths module. This file covers the three things
 *  landed here: the two previously-unbounded awaits that could hang launch with no error, the
 *  warm-up-load cleanup on the `no-frames` early return, and the escape/abort relation guard.
 *
 *  A green suite against a promise that resolves instantly proves nothing about a hang — every
 *  timeout test below drives the promise that NEVER settles and proves the wrapper still resolves
 *  (or the ramp still degrades) once the clock moves past the bound.
 *
 *  ⚠️ **THE `three/webgpu` MOCK IS GONE, AND SO IS WHAT IT WAS FOR (#203).** This file used to
 *  reexport the real `three` under the `three/webgpu` specifier, because the runner built a scene
 *  out of geometries and materials. The ramps now run on a raw WebGL2 context (`rampWorkloadGL.ts`)
 *  and the runner imports only `three`'s core math for its CPU ramp, so there is nothing left to
 *  stub. */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  withTimeout, escapableIntervalMs, runRamp, runBootRampProbe, runCpuRamp,
} from '../../src/runtime/rendering/rampProbeRunner';
import { createGlProbeSurface } from '../../src/runtime/rendering/rampWorkloadGL';
import { ESCAPE_MULTIPLE, ABORT_FRAME_MS } from '../../src/runtime/rendering/rampProbe';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../../src/runtime/rendering/scene3DSync');
  vi.resetModules();
  document.body.innerHTML = '';
});

/** A stand-in for a real ramp workload. Since #203 `runRamp` is parameterised over exactly this
 *  two-method interface and knows nothing about renderers, scenes or GL — which is what makes these
 *  tests tests of the TIMING logic rather than of a mock renderer. */
function fakeWorkload() {
  const state = { load: 0, submits: 0 };
  return {
    state,
    workload: {
      setLoad: (n: number) => { state.load = n; },
      submit: () => { state.submits++; },
    },
  };
}

function fakeGl() {
  const calls = { instanced: [] as number[], plain: 0, programs: [] as unknown[] };
  const gl = {
    TRIANGLES: 4, FRAGMENT_SHADER: 1, VERTEX_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 5,
    COLOR_BUFFER_BIT: 6, BLEND: 7, DEPTH_TEST: 8, SRC_ALPHA: 9, ONE: 10, TEXTURE_2D: 11,
    TEXTURE0: 12, RGBA: 13, UNSIGNED_BYTE: 14, REPEAT: 15, LINEAR: 16,
    TEXTURE_WRAP_S: 17, TEXTURE_WRAP_T: 18, TEXTURE_MIN_FILTER: 19, TEXTURE_MAG_FILTER: 20,
    createShader: () => ({}), shaderSource: () => {}, compileShader: () => {},
    getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader: () => {},
    createProgram: () => ({}), attachShader: () => {}, linkProgram: () => {},
    getProgramParameter: () => true, getProgramInfoLog: () => '', deleteProgram: () => {},
    useProgram: (p: unknown) => { calls.programs.push(p); },
    getUniformLocation: () => ({}), uniform1i: () => {}, uniform2f: () => {},
    createTexture: () => ({}), bindTexture: () => {}, texImage2D: () => {}, texParameteri: () => {},
    deleteTexture: () => {}, activeTexture: () => {},
    createVertexArray: () => ({}), bindVertexArray: () => {}, deleteVertexArray: () => {},
    viewport: () => {}, disable: () => {}, enable: () => {}, blendFunc: () => {},
    clearColor: () => {}, clear: () => {},
    drawArraysInstanced: (_m: number, _f: number, _c: number, n: number) => { calls.instanced.push(n); },
    drawArrays: () => { calls.plain++; },
    getExtension: () => null,
    // No `fenceSync`, so `makeGpuClock` declines and the harness takes the presentation path —
    // which keeps this test about the workloads and not about timing.
  };
  return { gl, calls };
}

describe('withTimeout', () => {
  it('resolves with the inner value when it settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000)).resolves.toBe('ok');
  });

  it('REJECTS a promise that never settles, once the deadline elapses', async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => { /* never resolves — the case a fast mock cannot prove */ });
    const pending = withTimeout(never, 1_000);
    // Attach the rejection assertion before advancing — otherwise the rejection could fire
    // "unhandled" between the advance and the `expect`, which vitest treats as a test failure.
    const assertion = expect(pending).rejects.toThrow(/timed out after 1000ms/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});

// ⚠️ **`awaitOrDispose` AND ITS THREE TESTS WERE DELETED HERE (#203), AND THE HAZARD WITH THEM.**
// It existed because `runBootRampProbe` raced `makeWebGPURenderer` against a 5 s timeout, and
// `Promise.race` cancels nothing — so an abandoned creation could hand back a live WebGPU device
// that nothing disposed, on exactly the weak hardware the timeout fires for. The probe no longer
// constructs a renderer AT ALL: it draws on a raw WebGL2 context it creates and disposes itself.
// There is no race, no loser, and nothing to salvage.
//
// Deleting a guard is not usually the right move, so the test for keeping one is worth stating: a
// guard earns its place while the failure it prevents is still REACHABLE. This one's failure needs
// a renderer-creation race that no longer exists in the codebase, and a test asserting a helper
// nothing calls is how a suite drifts into proving its own fixtures. `rampWorkloadGL.ts`'s own
// `dispose()` (and the `finally` that always calls it) is what owns context lifetime now.

describe('escapableIntervalMs (#205 R5.4 — escape/abort inversion guard)', () => {
  it('leaves an ordinary display interval unchanged', () => {
    // 16.7 ms (60 Hz): ESCAPE_MULTIPLE x 16.7 is nowhere near ABORT_FRAME_MS, so nothing clamps.
    expect(escapableIntervalMs(16.7)).toBe(16.7);
  });

  it('clamps an interval large enough to invert escape past abort, and the relation now holds', () => {
    // A project legitimately targeting ~5 fps has a 200 ms interval — real, authored, and exactly
    // the case the plausibility guard (which only ever inspects the MEASURED half) does not touch.
    const raw = 200;
    // Unclamped, this is the exact bug: escape would sit ABOVE abort.
    expect(ESCAPE_MULTIPLE * raw).toBeGreaterThan(ABORT_FRAME_MS);
    const clamped = escapableIntervalMs(raw);
    expect(clamped).toBeLessThan(raw);
    expect(ESCAPE_MULTIPLE * clamped).toBeLessThan(ABORT_FRAME_MS);
  });
});

describe('runRamp — warm-up load cleanup on the no-frames exit (#205 R5.4)', () => {

  it('clears the warm-up load before returning when no frame ever arrives', async () => {
    vi.useFakeTimers();
    // rAF that never calls its callback — `nextFrame()`'s only other resolution path is its own
    // internal 5 s timeout, so this forces the `no-frames` branch deterministically.
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
    const { state, workload } = fakeWorkload();
    const marks: string[] = [];

    const runP = runRamp(
      'shade',
      workload,
      16.7,
      Infinity, // deadline: not what this test is exercising
      (s: string) => marks.push(s),
      null,
    );
    // Two sequential `nextFrame()` calls on this path (the warm-up, then the ramp's own first
    // frame) each wait out the same internal timeout — advance well past both.
    await vi.advanceTimersByTimeAsync(20_000);
    const reading = await runP;

    expect(marks).toContain('shade:no-frames');
    expect(reading.bound).toBe('none');
    // THE ASSERTION THAT DISTINGUISHES THE FIX FROM THE DEFECT: before the fix this stayed at the
    // warm-up load, which `runRamp` had set earlier in this same call and never cleared on this
    // exit — contaminating whatever ramp runs next.
    expect(state.load).toBe(0);
    // Non-vacuity: a workload that was never driven at all would also report load 0.
    expect(state.submits).toBeGreaterThan(0);
  });
});

describe('runBootRampProbe — degrading when there is no GL to measure with (#203)', () => {
  // ⚠️ **THIS REPLACED TWO TESTS FOR TIMEOUTS THAT NO LONGER EXIST.** They asserted that renderer
  // creation and the trivial-material compile each degraded to `null` rather than hanging
  // (#205 R5.3). Both awaited a `WebGPURenderer` the probe no longer builds — a raw WebGL2 context
  // is created synchronously and has nothing to hang on. The PROPERTY they were protecting is what
  // survives here: a probe that cannot measure returns `null` promptly, having said why, and never
  // holds the launch open.
  it('returns null, promptly, when the environment has no WebGL2 — and marks the reason', async () => {
    // jsdom has no WebGL2, which is the real shape of this failure rather than a contrived one:
    // a browser that refuses the context (blocked, exhausted, software-only) lands here too.
    const marks: string[] = [];
    const result = await runBootRampProbe((s) => marks.push(s));

    expect(result).toBeNull();
    // The MARK is the load-bearing part. `resolveProbeClass` logs the last stage on every path that
    // returns nothing, and "no measurement, last stage 'start'" is indistinguishable from a probe
    // that was never reached — the exact ambiguity that left an A23 and a Y6 silent for three
    // launches each (#188).
    expect(marks).toContain('gl-context-failed');
    expect(marks).toContain('no-gl-surface');
  });

  it('a 2D probe and a 3D probe both decline the same way — the shape does not change the degrade', async () => {
    // Non-vacuity for the `only2D` parameter: it must not have introduced a path that throws, or
    // hangs, or resolves something other than `null`, on the failure branch every launch can hit.
    await expect(runBootRampProbe(undefined, true)).resolves.toBeNull();
    await expect(runBootRampProbe(undefined, false)).resolves.toBeNull();
  });
});

describe('⭐ the probe is bounded AS A WHOLE, not merely phase by phase', () => {
  // MEASURED: a Galaxy A23 launch took 4416 ms against 277-480 ms across nine others on the same
  // build and device, with its ramp steps summing to ~250 ms — so the time went into the waits, not
  // the measurement. Cause: HARD_DEADLINE_MS was recomputed fresh at each use, and the GPU warm-up
  // loop had no deadline at all while each fence wait is bounded only by the clock's own 2 s.
  // Every piece bounded; the sum unbounded.
  //
  // ⚠️ THESE TESTS MUST DISTINGUISH BOUNDED FROM UNBOUNDED, WHICH A FIRST VERSION DID NOT. It used
  // a clock that resolved after 2 s and asserted the ramp finished — true either way once fake
  // timers advance past 2 s. Mutation-checking caught it: removing the bound broke nothing. The
  // shape that actually discriminates is a clock that NEVER resolves, so an unbounded wait hangs
  // forever and a bounded one returns.
  const neverClock = () => ({
    kind: 'webgl2' as const,
    awaitCompletion: () => new Promise<number | null>(() => { /* never settles */ }),
  });

  it('a ramp whose clock never completes still returns, at its deadline', async () => {
    vi.useFakeTimers();
    const { workload, state } = fakeWorkload();
    const marks: string[] = [];
    // A FUTURE deadline, deliberately: a past one exits before the wait and would prove nothing
    // about the wait itself, which is where the time actually goes.
    const runP = runRamp('fill', workload, 16.7, performance.now() + 300, (m: string) => marks.push(m), neverClock());
    await vi.advanceTimersByTimeAsync(30_000);
    const reading = await runP;   // unbounded, this await never settles and the test times out

    expect(marks).toContain('fill:warm-clock-failed');
    expect(reading.bound).toBe('none');
    expect(state.load).toBe(0);   // cleared on this exit too
  });

  it('and the whole probe returns even when every fence hangs — the warm-up loop included', async () => {
    vi.useFakeTimers();
    // A GL context whose fence NEVER signals. `makeGpuClock` takes the WebGL2 path on `fenceSync`,
    // so this exercises the orchestrator's warm-up loop — the phase that had no deadline at all,
    // and the one the 4416 ms launch is attributed to.
    const { gl } = fakeGl();
    const hanging = {
      ...gl,
      SYNC_GPU_COMMANDS_COMPLETE: 100, ALREADY_SIGNALED: 101, CONDITION_SATISFIED: 102, WAIT_FAILED: 103,
      fenceSync: () => ({}), clientWaitSync: () => 999 /* never signalled */, deleteSync: () => {}, flush: () => {},
    };
    const canvas = { width: 0, height: 0, getContext: () => hanging };
    const spy = vi.spyOn(document, 'createElement').mockReturnValue(canvas as never);
    try {
      const probeP = runBootRampProbe(() => {}, true);
      await vi.advanceTimersByTimeAsync(60_000);
      // The assertion is simply THAT IT SETTLES.
      //
      // ⚠️ **HONEST LIMIT: this does NOT discriminate the orchestrator's warm-up bound.**
      // Mutation-checked — removing `awaitClockWithin` from that loop leaves this green, because
      // `gpuClock`'s WebGL2 path has its OWN 2 s self-timeout, so an "unbounded" warm-up still
      // terminates after 3 x 2 s rather than hanging. A fake GL cannot express "hangs past the
      // clock's own timeout", so the discriminating test would have to inject a clock the
      // orchestrator builds internally.
      //
      // That is also the reassuring half of the diagnosis: the true worst case was ~6 s of
      // self-terminating waits, not an infinite hang, which is consistent with the 4416 ms
      // observed. The bound turns 6 s into the probe budget. The property IS covered by
      // construction — the same helper, exercised discriminatingly one test above — and the gap
      // is in the test, which is worth stating rather than implying coverage that is not there.
      await expect(probeP).resolves.not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the cpu ramp respects a budget already spent (close-out 2026-08-13)', () => {
  it('does no work when the deadline is already past', () => {
    // `phaseDeadline` can hand back a past time when GL setup and the shader compiles alone
    // exhaust PROBE_TOTAL_BUDGET_MS — the pathological launch that budget exists for. The GPU path
    // had this guard; the cpu path ran three JIT warm-up passes and a first ramp step first.
    const marks: string[] = [];
    const started = performance.now();
    const reading = runCpuRamp((m: string) => marks.push(m), -1);
    expect(marks).toContain('cpu:deadline-before-start');
    expect(reading.bound).toBe('none');
    // The warm-up alone is documented at "a millisecond or two"; bailing must be far under that.
    expect(performance.now() - started).toBeLessThan(5);
  });

  it('⭐ the probe discards CPU_WARMUP_RAMPS cpu passes and classifies the one after (#205)', async () => {
    // A JIT warm-up cannot warm a CPU governor: three passes of 8192 iterations are a millisecond
    // or two, and a governor needs sustained work. So a whole ramp is discarded, exactly as the
    // GPU ramps discard theirs. The COUNT is pinned below because it has already moved twice —
    // 2 was tried on hardware and reverted (see `CPU_WARMUP_RAMPS`).
    //
    // ⚠️ **THE DISCRIMINATING ASSERTION IS `cpuWarmups`, NOT THE MARK.** A mark string can be
    // written by hand and would stay green if someone deleted the extra passes; a `cpuWarmups`
    // entry can only exist because a whole extra ramp ran and returned a reading.
    const { gl } = fakeGl();
    // `fenceSync` present and signalling immediately puts the orchestrator on the GPU-clock path,
    // so the probe completes without waiting on jsdom's rAF and the test stays fast.
    const signalling = {
      ...gl,
      SYNC_GPU_COMMANDS_COMPLETE: 100, ALREADY_SIGNALED: 101, CONDITION_SATISFIED: 102, WAIT_FAILED: 103,
      fenceSync: () => ({}), clientWaitSync: () => 101, deleteSync: () => {}, flush: () => {},
    };
    const canvas = { width: 0, height: 0, getContext: () => signalling };
    const spy = vi.spyOn(document, 'createElement').mockReturnValue(canvas as never);
    try {
      const marks: string[] = [];
      const m = await runBootRampProbe((s) => marks.push(s));

      expect(m).not.toBeNull();
      expect(m!.cpu).toBeDefined();
      // An EXACT length, not "at least one" — the count is the knob this test is protecting, and
      // `length > 0` would stay green through either direction of a change to it.
      expect(m!.cpuWarmups).toHaveLength(1);
      // The discarded passes are SILENT — each is handed a no-op `mark`, so the stage breadcrumbs
      // still describe the pass that counts. Without this, a crash mid-warm-up would report a
      // stage from a ramp nobody classified.
      expect(marks.filter((s) => s.startsWith('cpu:')).length).toBeGreaterThan(0);
      expect(marks.some((s) => s.startsWith('cpu-ok') && s.includes('1x discarded warm-up ramp'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('createGlProbeSurface — the workloads, against a fake GL (#203)', () => {
  /** (see the module-scope `fakeGl`) A GL context recording only what the assertions below read. Deliberately not a full fake:
   *  what matters is WHICH draw entry point each ramp uses — `fill`/`shade` submit ONE instanced
   *  call regardless of load, overdraw rather than submit count.
   *
   *  ⛔ Until 2026-08-13 (#221 W2 item 4) this described a THIRD workload, `draw`, whose whole
   *  point was N submits per object — one per object was the correction that made `fill` and
   *  `draw` measure two different things (a Galaxy S22 once read HALF a Galaxy A23 on "fill",
   *  which is the signature of measuring submit cost instead). `draw` itself is gone; see the
   *  `RampKind` removal record in `rampProbe.ts`. `fakeGl`'s `calls.plain` counter (N-submit
   *  entry point) is now dead in this file too but is left in place — it is recoverable evidence
   *  alongside `draw`, not a defect to clean up on its own. */

  function withFakeGl<T>(fn: (calls: ReturnType<typeof fakeGl>['calls']) => T): T {
    const { gl, calls } = fakeGl();
    const canvas = { width: 0, height: 0, getContext: () => gl };
    const spy = vi.spyOn(document, 'createElement').mockReturnValue(canvas as never);
    try { return fn(calls); } finally { spy.mockRestore(); }
  }

  it('fill and shade issue ONE instanced submit each', () => {
    withFakeGl((calls) => {
      const s = createGlProbeSurface(640, 480, () => {});
      expect(s).not.toBeNull();

      s!.workloads.fill.setLoad(8);
      s!.workloads.fill.submit();
      expect(calls.instanced).toEqual([8]);   // one call, eight instances — overdraw, not submits
      expect(calls.plain).toBe(0);

      s!.workloads.shade.setLoad(4);
      s!.workloads.shade.submit();
      expect(calls.instanced).toEqual([8, 4]);
      expect(calls.plain).toBe(0);
      s!.dispose();
    });
  });

  it('a zero load submits nothing but still clears — the ramps all end by zeroing their load', () => {
    withFakeGl((calls) => {
      const s = createGlProbeSurface(640, 480, () => {});
      s!.workloads.fill.setLoad(0);
      s!.workloads.fill.submit();
      expect(calls.instanced).toEqual([]);
      expect(calls.plain).toBe(0);
      s!.dispose();
    });
  });

  it('reports the shade region it actually achieved, not the one it wanted', () => {
    // A buffer narrower than the 100 px region cannot host it, and the reading is only
    // interpretable if the clamp is REPORTED — `shadeMegaFragmentsPerMs` multiplies by this.
    withFakeGl(() => {
      const big = createGlProbeSurface(640, 480, () => {});
      expect(big!.shadeRegionPixels).toBe(100 * 100);
      big!.dispose();
    });
    withFakeGl(() => {
      const narrow = createGlProbeSurface(40, 480, () => {});
      expect(narrow!.shadeRegionPixels).toBe(40 * 100);
      narrow!.dispose();
    });
  });
});
