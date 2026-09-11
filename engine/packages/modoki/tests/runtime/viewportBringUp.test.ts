/** A 3D viewport's bring-up decisions (#824, #1052) — `runtime/rendering/viewportBringUp.ts`.
 *
 *  Each case pins one decision that used to live inside `Scene3D.tsx`'s effect closure, where
 *  deleting it broke nothing: with #819's retirement and both halves of #820 removed, the full gate
 *  still passed 18,116 tests. These drive the REAL module with a fake renderer — the seam is
 *  `createRenderer`/`install`/`teardown`, and nothing here mounts a component.
 *
 *  Timers are vitest's fake timers rather than an injected clock, because the bound under test IS
 *  `withTimeout`'s own `setTimeout`; injecting a clock would test a copy of it. */

import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import {
  createViewportBringUp, boundedCaptureReadback, OFFSCREEN_READBACK_TIMEOUT_MS, type ViewportBringUpDeps,
} from '../../src/runtime/rendering/viewportBringUp';
import {
  createRendererRecovery, REBUILD_BRINGUP_TIMEOUT_MS, DEFAULT_REBUILD_DELAY_MS, DEFAULT_MAX_REBUILD_ATTEMPTS,
} from '../../src/runtime/rendering/rendererRecovery';
import { TimeoutError } from '../../src/runtime/core/abandonment';

afterEach(() => {
  vi.useRealTimers();
});

interface FakeRenderer {
  id: string;
  dispose: Mock<() => void>;
  domElement: { remove: Mock<() => void> };
}
const fakeRenderer = (id: string): FakeRenderer => ({ id, dispose: vi.fn(), domElement: { remove: vi.fn() } });

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

/** `createRenderer` hands out a fresh deferred per call, in order, so a test decides when (and
 *  whether) each attempt's renderer arrives. `overrides` swaps in the #1052 seams a case is about;
 *  without them this is exactly Scene3D's wiring (sync install, default discard). */
function harness(overrides: Partial<Pick<ViewportBringUpDeps<FakeRenderer>, 'install' | 'discard' | 'onLateInstallError'>> = {}) {
  const attempts: Deferred<FakeRenderer>[] = [];
  const kinds: string[] = [];
  const installed: string[] = [];
  const events: string[] = [];
  let unmounted = false;
  const bringUp = createViewportBringUp<FakeRenderer>({
    createRenderer: (kind) => {
      const d = deferred<FakeRenderer>();
      attempts.push(d);
      kinds.push(kind);
      events.push(`create#${attempts.length}`);
      return d.promise;
    },
    isDisposed: () => unmounted,
    install: overrides.install ?? ((r) => { installed.push(r.id); events.push(`install:${r.id}`); }),
    teardown: () => { events.push('teardown'); },
    discard: overrides.discard,
    onLateInstallError: overrides.onLateInstallError,
  });
  return { bringUp, attempts, kinds, installed, events, unmount: () => { unmounted = true; } };
}

describe('boot() — the FIRST bring-up is not bounded', () => {
  it('installs the renderer it creates, and tears nothing down', async () => {
    const h = harness();
    const r1 = fakeRenderer('r1');
    const p = h.bringUp.boot();
    h.attempts[0].resolve(r1);
    await p;
    expect(h.events).toEqual(['create#1', 'install:r1']);
    expect(r1.dispose).not.toHaveBeenCalled();
  });

  /** Rule 1. A rejecting bound on a first init turned an 8.5 s cold start into a permanent failure
   *  (canvas2DPool's history). Mutation-checked: passing the rebuild bound to `boot()` reddens it. */
  it('does not reject a first bring-up slower than the rebuild bound — a slow cold start is not a failure', async () => {
    vi.useFakeTimers();
    const h = harness();
    let settled = false;
    const p = h.bringUp.boot().then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(REBUILD_BRINGUP_TIMEOUT_MS * 2);
    expect(settled, 'boot() gave up on a renderer that was merely slow').toBe(false);
    h.attempts[0].resolve(fakeRenderer('r1'));
    await p;
    expect(h.installed).toEqual(['r1']);
  });
});

describe('rebuild() — bounded, and a late renderer is adopted unless superseded', () => {
  it('tears down BEFORE creating, then installs', async () => {
    const h = harness();
    const p = h.bringUp.rebuild();
    h.attempts[0].resolve(fakeRenderer('r1'));
    await p;
    expect(h.events).toEqual(['teardown', 'create#1', 'install:r1']);
  });

  /** Rule 1, the other half: without a bound a hung `createRenderer` latches recovery forever.
   *  Mutation-checked: an unbounded `rebuild()` reddens this and the recovery cases below. */
  it('rejects with a TimeoutError at REBUILD_BRINGUP_TIMEOUT_MS, installing nothing', async () => {
    vi.useFakeTimers();
    const h = harness();
    const p = h.bringUp.rebuild();
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(REBUILD_BRINGUP_TIMEOUT_MS);
    await assertion;
    expect(h.installed).toEqual([]);
  });

  /** ⭐ Rule 2 — THE case that would have caught #820's first version, which disposed every late
   *  renderer and so turned a slow-but-alive device permanently black. Mutation-checked: disposing
   *  the late renderer unconditionally reddens it. */
  it('a late renderer nothing superseded is ADOPTED, not disposed', async () => {
    vi.useFakeTimers();
    const h = harness();
    const r1 = fakeRenderer('r1');
    const p = h.bringUp.rebuild().catch(() => { /* timed out — the subject is what happens next */ });
    await vi.advanceTimersByTimeAsync(REBUILD_BRINGUP_TIMEOUT_MS);
    await p;
    h.attempts[0].resolve(r1);
    await flush();
    expect(h.installed).toEqual(['r1']);
    expect(r1.dispose).not.toHaveBeenCalled();
  });

  /** Mutation-checked: dropping `stillCurrent()` from the adopt check reddens this. */
  it('a late renderer a NEWER bring-up superseded is disposed, and the newer one keeps the surface', async () => {
    vi.useFakeTimers();
    const h = harness();
    const r1 = fakeRenderer('r1');
    const r2 = fakeRenderer('r2');
    const first = h.bringUp.rebuild().catch(() => { /* timed out */ });
    await vi.advanceTimersByTimeAsync(REBUILD_BRINGUP_TIMEOUT_MS);
    await first;
    const second = h.bringUp.rebuild();
    h.attempts[1].resolve(r2);
    await second;
    h.attempts[0].resolve(r1);
    await flush();
    expect(h.installed).toEqual(['r2']);
    expect(r1.dispose).toHaveBeenCalledTimes(1);
    expect(r1.domElement.remove).toHaveBeenCalledTimes(1);
    expect(r2.dispose).not.toHaveBeenCalled();
  });

  it('a late renderer arriving after UNMOUNT is disposed, not installed', async () => {
    vi.useFakeTimers();
    const h = harness();
    const r1 = fakeRenderer('r1');
    const p = h.bringUp.rebuild().catch(() => { /* timed out */ });
    await vi.advanceTimersByTimeAsync(REBUILD_BRINGUP_TIMEOUT_MS);
    await p;
    h.unmount();
    h.attempts[0].resolve(r1);
    await flush();
    expect(h.installed).toEqual([]);
    expect(r1.dispose).toHaveBeenCalledTimes(1);
  });

  it('a late REJECTION installs nothing and does not surface as unhandled', async () => {
    vi.useFakeTimers();
    const h = harness();
    const p = h.bringUp.rebuild().catch(() => { /* timed out */ });
    await vi.advanceTimersByTimeAsync(REBUILD_BRINGUP_TIMEOUT_MS);
    await p;
    h.attempts[0].reject(new Error('device lost while initialising'));
    await flush();
    expect(h.installed).toEqual([]);
  });
});

/** #820's original shape, on the ON-TIME path: the initial `boot()` runs outside recovery's latch,
 *  so a loss during boot starts a rebuild while boot is still awaiting `createRenderer`. */
describe('supersession on the on-time path (#820)', () => {
  /** Mutation-checked: dropping `stillCurrent()` from the adopt check reddens this. */
  it('a boot overtaken by a rebuild that finished first is DISPOSED when its renderer arrives', async () => {
    const h = harness();
    const r1 = fakeRenderer('r1');
    const r2 = fakeRenderer('r2');
    const boot = h.bringUp.boot();
    const rebuild = h.bringUp.rebuild();
    h.attempts[1].resolve(r2);
    await rebuild;
    h.attempts[0].resolve(r1);
    await boot;
    expect(h.installed).toEqual(['r2']);
    expect(r1.dispose).toHaveBeenCalledTimes(1);
  });

  it('an on-time renderer arriving after unmount is disposed, not installed', async () => {
    const h = harness();
    const r1 = fakeRenderer('r1');
    const p = h.bringUp.boot();
    h.unmount();
    h.attempts[0].resolve(r1);
    await p;
    expect(h.installed).toEqual([]);
    expect(r1.dispose).toHaveBeenCalledTimes(1);
  });
});

/** Wired the way `Scene3D.tsx` wires it: `createRendererRecovery({ rebuild: bringUp.rebuild })`,
 *  real scheduling, real bound. The unit cases above prove each decision; these prove they compose
 *  into the behaviour the decisions exist for. */
describe('driven by rendererRecovery, as Scene3D drives it', () => {
  function wired() {
    const h = harness();
    const onError = vi.fn();
    const recovery = createRendererRecovery({ rebuild: h.bringUp.rebuild, isDisposed: () => false, onError });
    return { ...h, onError, recovery };
  }

  it('a HUNG attempt is reported and retried, and its late renderer is disposed once the retry has won', async () => {
    vi.useFakeTimers();
    const w = wired();
    const r1 = fakeRenderer('r1');
    const r2 = fakeRenderer('r2');

    w.recovery.request();
    await vi.advanceTimersByTimeAsync(DEFAULT_REBUILD_DELAY_MS);
    expect(w.attempts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(REBUILD_BRINGUP_TIMEOUT_MS);
    expect(w.onError, 'a hung bring-up must be REPORTED, not latch in silence').toHaveBeenCalledTimes(1);
    expect(w.onError.mock.calls[0][0]).toBeInstanceOf(TimeoutError);
    expect(w.onError.mock.calls[0][1].willRetry).toBe(true);
    expect(w.recovery.isRebuilding()).toBe(false);

    await vi.advanceTimersByTimeAsync(DEFAULT_REBUILD_DELAY_MS * 2);
    expect(w.attempts, 'the retry ran').toHaveLength(2);
    w.attempts[1].resolve(r2);
    await flush();
    expect(w.installed).toEqual(['r2']);

    w.attempts[0].resolve(r1);
    await flush();
    expect(w.installed, 'the superseded late renderer must not replace the winner').toEqual(['r2']);
    expect(r1.dispose).toHaveBeenCalledTimes(1);
  });

  /** Rule 2 in the situation it was written for: recovery has GIVEN UP, so nothing will ever retry
   *  again, and the last attempt's renderer arriving late is the only way this surface ever draws. */
  it('when every attempt hangs and recovery gives up, the LAST late renderer is adopted — earlier ones are disposed', async () => {
    vi.useFakeTimers();
    const w = wired();

    w.recovery.request();
    for (let attempt = 1; attempt <= DEFAULT_MAX_REBUILD_ATTEMPTS; attempt++) {
      await vi.advanceTimersByTimeAsync(attempt === 1 ? DEFAULT_REBUILD_DELAY_MS : DEFAULT_REBUILD_DELAY_MS * 2 ** (attempt - 1));
      expect(w.attempts).toHaveLength(attempt);
      await vi.advanceTimersByTimeAsync(REBUILD_BRINGUP_TIMEOUT_MS);
    }
    expect(w.onError).toHaveBeenCalledTimes(DEFAULT_MAX_REBUILD_ATTEMPTS);
    expect(w.onError.mock.calls.at(-1)?.[1].willRetry, 'recovery has given up').toBe(false);

    const renderers = w.attempts.map((_, i) => fakeRenderer(`r${i + 1}`));
    w.attempts.forEach((d, i) => d.resolve(renderers[i]));
    await flush();

    const last = renderers[renderers.length - 1];
    expect(w.installed).toEqual([last.id]);
    expect(last.dispose).not.toHaveBeenCalled();
    for (const earlier of renderers.slice(0, -1)) expect(earlier.dispose).toHaveBeenCalledTimes(1);
  });
});

/** #1052 — the three seams the editor's SceneView needs and Scene3D does not use. Each runs under fake
 *  timers even where no bound is advanced: a `rebuild()` arms `withTimeout`'s real 8 s timer otherwise,
 *  and a timer that outlives its test is #1058's defect class. */
describe('the SceneView seams (#1052)', () => {
  it('createRenderer is told which bring-up it serves — boot for boot(), rebuild for rebuild()', async () => {
    vi.useFakeTimers();
    const h = harness();
    const boot = h.bringUp.boot();
    h.attempts[0].resolve(fakeRenderer('r1'));
    await boot;
    const rebuild = h.bringUp.rebuild();
    h.attempts[1].resolve(fakeRenderer('r2'));
    await rebuild;
    expect(h.kinds).toEqual(['boot', 'rebuild']);
  });

  it('an ASYNC install is awaited: rebuild() settles only once install has finished', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const h = harness({ install: () => gate.promise });
    let settled = false;
    const p = h.bringUp.rebuild().then(() => { settled = true; });
    h.attempts[0].resolve(fakeRenderer('r1'));
    await flush();
    expect(settled, 'rebuild() reported success while install was still running').toBe(false);
    gate.resolve();
    await p;
    expect(settled).toBe(true);
  });

  it('install gets a check that turns false once a NEWER bring-up begins — an awaiting install can see it was overtaken', async () => {
    vi.useFakeTimers();
    const checks: Array<() => boolean> = [];
    const gate = deferred<void>();
    const h = harness({ install: (_r, stillCurrent) => { checks.push(stillCurrent); return gate.promise; } });
    const boot = h.bringUp.boot();
    h.attempts[0].resolve(fakeRenderer('r1'));
    await flush();
    expect(checks, 'precondition: install is running').toHaveLength(1);
    expect(checks[0](), 'precondition: nothing has overtaken it yet').toBe(true);

    void h.bringUp.rebuild().catch(() => { /* never resolved — the subject is the boot's check */ });

    expect(checks[0](), 'a rebuild began while the boot install awaited').toBe(false);
    gate.resolve();
    await boot;
  });

  it('a late renderer arriving after UNMOUNT goes to discard(r, "disposed") — the caller releases it, nothing disposes it here', async () => {
    vi.useFakeTimers();
    const discard = vi.fn();
    const h = harness({ discard });
    const r1 = fakeRenderer('r1');
    const p = h.bringUp.rebuild().catch(() => { /* timed out */ });
    await vi.advanceTimersByTimeAsync(REBUILD_BRINGUP_TIMEOUT_MS);
    await p;
    h.unmount();
    h.attempts[0].resolve(r1);
    await flush();
    expect(discard).toHaveBeenCalledWith(r1, 'disposed');
    expect(r1.dispose, 'the hook owns disposal once it is supplied').not.toHaveBeenCalled();
    expect(h.installed).toEqual([]);
  });

  /** Mutation-check target: deciding `disposed` before `superseded` in `adopt` reddens this. */
  it('a SUPERSEDED late renderer goes to discard(r, "superseded") even after unmount — its lease is already gone', async () => {
    vi.useFakeTimers();
    const discard = vi.fn();
    const h = harness({ discard });
    const r1 = fakeRenderer('r1');
    const first = h.bringUp.rebuild().catch(() => { /* timed out */ });
    await vi.advanceTimersByTimeAsync(REBUILD_BRINGUP_TIMEOUT_MS);
    await first;
    const second = h.bringUp.rebuild();
    h.attempts[1].resolve(fakeRenderer('r2'));
    await second;
    h.unmount();
    h.attempts[0].resolve(r1);
    await flush();
    expect(discard).toHaveBeenCalledWith(r1, 'superseded');
    expect(discard).not.toHaveBeenCalledWith(r1, 'disposed');
  });

  it('a late ADOPTED renderer whose install throws is reported, not left as an unhandled rejection', async () => {
    vi.useFakeTimers();
    const onLateInstallError = vi.fn();
    const boom = new Error('install failed');
    const h = harness({ install: () => { throw boom; }, onLateInstallError });
    const p = h.bringUp.rebuild().catch(() => { /* timed out */ });
    await vi.advanceTimersByTimeAsync(REBUILD_BRINGUP_TIMEOUT_MS);
    await p;
    h.attempts[0].resolve(fakeRenderer('r1'));
    await flush();
    expect(onLateInstallError).toHaveBeenCalledWith(boom);
  });
});

describe('boundedCaptureReadback — a timed-out read keeps the pool away from its target (#819)', () => {
  function pool<T>(initial: T) {
    let held: T | null = initial;
    return {
      slot: { current: () => held, retire: () => { held = null; } },
      held: () => held,
      moveTo: (next: T) => { held = next; },
    };
  }

  it('a readback in time returns the pixels and KEEPS the pooled target', async () => {
    const rt = { dispose: vi.fn() };
    const p = pool(rt);
    const buf = new Uint8Array([1, 2, 3, 4]);
    await expect(boundedCaptureReadback(Promise.resolve(buf), rt, p.slot)).resolves.toBe(buf);
    expect(p.held()).toBe(rt);
    expect(rt.dispose).not.toHaveBeenCalled();
  });

  /** Mutation-checked: removing the retirement reddens this. */
  it('a TIMED-OUT readback retires the pooled target, but does not dispose what the read still owns', async () => {
    vi.useFakeTimers();
    const rt = { dispose: vi.fn() };
    const p = pool(rt);
    const read = deferred<Uint8Array>();
    const pending = boundedCaptureReadback(read.promise, rt, p.slot, 100);
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(p.held(), 'the next capture must allocate a fresh target').toBeNull();
    expect(rt.dispose, 'the stalled read is still using it').not.toHaveBeenCalled();
  });

  /** Mutation-checked: removing the `onSettled` dispose reddens this. */
  it.each([
    ['resolves', (d: Deferred<Uint8Array>) => d.resolve(new Uint8Array(4))],
    ['rejects', (d: Deferred<Uint8Array>) => d.reject(new Error('device lost'))],
  ])('the retired target is disposed once the stalled read finally %s', async (_label, settle) => {
    vi.useFakeTimers();
    const rt = { dispose: vi.fn() };
    const p = pool(rt);
    const read = deferred<Uint8Array>();
    const pending = boundedCaptureReadback(read.promise, rt, p.slot, 100).catch(() => { /* timed out */ });
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    settle(read);
    await flush();
    expect(rt.dispose).toHaveBeenCalledTimes(1);
  });

  /** Mutation-checked: retiring without the `current() === rt` check reddens this. */
  it('does not retire a NEWER target the pool has already moved on to', async () => {
    vi.useFakeTimers();
    const rt = { dispose: vi.fn() };
    const newer = { dispose: vi.fn() };
    const p = pool(rt);
    const pending = boundedCaptureReadback(deferred<Uint8Array>().promise, rt, p.slot, 100).catch(() => { /* timed out */ });
    p.moveTo(newer);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(p.held()).toBe(newer);
  });

  it('a read that REJECTS in time is rethrown as-is and retires nothing — it owns nothing any more', async () => {
    const rt = { dispose: vi.fn() };
    const p = pool(rt);
    const boom = new Error('readback failed');
    await expect(boundedCaptureReadback(Promise.reject(boom), rt, p.slot)).rejects.toBe(boom);
    expect(p.held()).toBe(rt);
  });

  it('defaults to OFFSCREEN_READBACK_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const rt = { dispose: vi.fn() };
    const p = pool(rt);
    let rejected = false;
    const pending = boundedCaptureReadback(deferred<Uint8Array>().promise, rt, p.slot).catch(() => { rejected = true; });
    await vi.advanceTimersByTimeAsync(OFFSCREEN_READBACK_TIMEOUT_MS - 1);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(rejected).toBe(true);
  });
});
