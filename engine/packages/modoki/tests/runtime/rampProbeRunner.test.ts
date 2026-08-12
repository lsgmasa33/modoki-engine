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
 *  `three/webgpu` is aliased in `vitest.config.ts` to a MINIMAL stub (only `WebGPURenderer`) so
 *  the node test env can resolve the subpath at all — this file needs the rest of THREE
 *  (geometry, materials, `Object3D`) that `rampProbeRunner.ts` builds its scene from, so it
 *  reexports the REAL `three` package under that specifier instead. `THREE.NodeMaterial` (used
 *  only by the optional heavy-shade ramp) is deliberately left out of that reexport — the probe's
 *  own `try/catch` around `makeHeavyShadeAssets()` is exactly what is meant to absorb a backend
 *  that cannot build it, so letting it fail here doubles as coverage of that fallback rather than
 *  something to route around. */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('three/webgpu', async () => {
  const real = await vi.importActual<typeof import('three')>('three');
  return { ...real };
});

import {
  withTimeout, awaitOrDispose, escapableIntervalMs, runRamp,
} from '../../src/runtime/rendering/rampProbeRunner';
import { ESCAPE_MULTIPLE, ABORT_FRAME_MS } from '../../src/runtime/rendering/rampProbe';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../../src/runtime/rendering/scene3DSync');
  vi.resetModules();
  document.body.innerHTML = '';
});

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

describe('awaitOrDispose — the race loser must not leak a GPU context (close-out 2026-08-12)', () => {
  it('returns the value untouched when it beats the deadline, and does NOT dispose it', async () => {
    // The happy path is the one a naive fix breaks: the salvage callback is subscribed BEFORE the
    // await resolves, so a fix keyed on "has the caller stored a renderer yet?" disposes the good
    // renderer here and the probe renders into a dead context.
    const r = { dispose: vi.fn() };
    await expect(awaitOrDispose(Promise.resolve(r), 1_000)).resolves.toBe(r);
    await Promise.resolve();
    expect(r.dispose).not.toHaveBeenCalled();
  });

  it('DISPOSES a value that arrives after the deadline — the leak this exists for', async () => {
    vi.useFakeTimers();
    const r = { dispose: vi.fn() };
    let settle: (v: typeof r) => void = () => {};
    const slow = new Promise<typeof r>((res) => { settle = res; });
    const pending = awaitOrDispose(slow, 1_000);
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(r.dispose).not.toHaveBeenCalled();   // nothing to dispose yet — creation is still running
    settle(r);                                   // ...and now the abandoned renderer finally arrives
    await vi.advanceTimersByTimeAsync(0);
    expect(r.dispose).toHaveBeenCalledTimes(1);
  });

  it('swallows a late REJECTION rather than raising it unhandled', async () => {
    // The abandoned creation can also fail. Its rejection has no owner left, and an unhandled one
    // would surface as a process-level error in a shipped game.
    vi.useFakeTimers();
    let fail: (e: Error) => void = () => {};
    const slow = new Promise<{ dispose: () => void }>((_, rej) => { fail = rej; });
    const pending = awaitOrDispose(slow, 1_000);
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    fail(new Error('adapter lost'));
    await expect(vi.advanceTimersByTimeAsync(0)).resolves.not.toThrow();
  });
});

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
  /** A group standing in for a ramp's Object3D: `setLoad` only ever touches `.visible` and, for a
   *  non-instanced group, `.children[i].visible` — nothing else in `runRamp` reads it. */
  function fakeGroup() {
    return { visible: false, children: [] as { visible: boolean }[] };
  }

  it('clears the warm-up load before returning when no frame ever arrives', async () => {
    vi.useFakeTimers();
    // rAF that never calls its callback — `nextFrame()`'s only other resolution path is its own
    // internal 5 s timeout, so this forces the `no-frames` branch deterministically.
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
    const group = fakeGroup();
    const renderer = { render: vi.fn() };
    const marks: string[] = [];

    const runP = runRamp(
      'draw',
      renderer as never,
      {} as never,
      {} as never,
      group as never,
      16.7,
      Infinity, // deadline: not what this test is exercising
      (s) => marks.push(s),
      null,
    );
    // Two sequential `nextFrame()` calls on this path (the warm-up, then the ramp's own first
    // frame) each wait out the same internal timeout — advance well past both.
    await vi.advanceTimersByTimeAsync(20_000);
    const reading = await runP;

    expect(marks).toContain('draw:no-frames');
    expect(reading.bound).toBe('none');
    // THE ASSERTION THAT DISTINGUISHES THE FIX FROM THE DEFECT: before the fix this stayed `true`
    // — the warm-up load `setLoad(group, warmLoad)` made visible earlier in this same call was
    // never cleared on this exit, so it would have contaminated whatever ramp runs next.
    expect(group.visible).toBe(false);
  });
});

describe('runBootRampProbe — the two unbounded awaits now degrade instead of hanging (#205 R5.3)', () => {
  it('degrades to null, bounded, when renderer creation never settles', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
    vi.doMock('../../src/runtime/rendering/scene3DSync', () => ({
      makeWebGPURenderer: vi.fn(() => new Promise(() => { /* the hang this bound now catches */ })),
    }));
    const { runBootRampProbe: probe } = await import('../../src/runtime/rendering/rampProbeRunner');

    const marks: string[] = [];
    const runP = probe((s) => marks.push(s));
    // RENDERER_CREATE_TIMEOUT_MS is 5s; clear it with margin.
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await runP;

    expect(result).toBeNull();
    // Proves the hang was caught AT the renderer-creation site specifically, not some earlier
    // guard (e.g. a missing rAF) returning null for an unrelated reason.
    expect(marks).toContain('renderer-create');
    expect(marks.some((m) => m.startsWith('threw'))).toBe(true);
  });

  it('degrades to null, bounded, when the trivial-material compile never settles', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
    vi.doMock('../../src/runtime/rendering/scene3DSync', () => ({
      makeWebGPURenderer: vi.fn(async () => ({
        setPixelRatio: vi.fn(),
        setSize: vi.fn(),
        compileAsync: vi.fn(() => new Promise(() => { /* the hang this bound now catches */ })),
        backend: {},
        dispose: vi.fn(),
      })),
    }));
    const { runBootRampProbe: probe } = await import('../../src/runtime/rendering/rampProbeRunner');

    const marks: string[] = [];
    const runP = probe((s) => marks.push(s));
    // TRIVIAL_COMPILE_TIMEOUT_MS is 1.5s; clear it with margin.
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await runP;

    expect(result).toBeNull();
    // Proves this run got PAST renderer creation and hung at the compile site specifically.
    expect(marks).toContain('compile');
    expect(marks.some((m) => m.startsWith('threw'))).toBe(true);
  });
});
