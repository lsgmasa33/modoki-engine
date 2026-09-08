/** The PlayerPrefs-backed probe verdict cache — the WRITE→READ round trip (#188).
 *
 *  ⚠️ **THIS FILE EXISTS BECAUSE ITS ABSENCE COST A SHIPPING BUG.** Both halves of the cache were
 *  unit-tested through their own module and neither was ever driven the way production drives it:
 *  write a verdict on one launch, read it back on the next. So when the classifier swapped from
 *  `fill`/`draw` to `cpu`/`shade` (#188, 2026-08-11), the provider's read-side validator kept
 *  checking the OLD field names — and because it validates unvalidated JSON through deliberate
 *  `as` casts, no type error was possible. Every read returned `null`, the cache was dead, and the
 *  probe re-ran on every launch forever while never accumulating the samples it needs to settle.
 *
 *  The device campaigns could not catch it either: they wipe app data before every launch on
 *  purpose, to get independent readings, which is exactly the state in which a dead cache is
 *  invisible. A round-trip test is the only thing that sees it. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlayerPrefs, InMemoryBackend } from '../../src/runtime/storage';
import type { PrefsBackend } from '../../src/runtime/storage/backends';
import { probeVerdictStore, type CachedProbeVerdict } from '../../src/runtime/core/probeVerdictStore';
import { readingOf, refineProbeVerdict, type ProbeReading } from '../../src/runtime/rendering/rampProbe';
import '../../src/runtime/storage/probeVerdictProvider';

const VERDICT: CachedProbeVerdict = {
  fingerprint: 'v4|android|SM-A236B|Adreno (TM) 610|6',
  deviceClass: 'middle',
  // Real A23 readings (native, 2026-08-11).
  samples: [
    { cpuUnitsPerMs: 9_200, shadeMfragPerMs: 0.11, fillMpxPerMs: 0 },
    { cpuUnitsPerMs: 9_900, shadeMfragPerMs: 0.14, fillMpxPerMs: 0 },
  ],
  final: false,
};

describe('probe verdict cache — write then read, the way two launches drive it', () => {
  beforeEach(async () => {
    await PlayerPrefs.init({ backend: new InMemoryBackend() });
  });
  afterEach(() => { probeVerdictStore.get()?.write(null); });

  it('reads back exactly what it wrote — the seam that had no test', () => {
    const store = probeVerdictStore.get()!;
    store.write(VERDICT);
    expect(store.read()).toEqual(VERDICT);
  });

  it('accumulates samples ACROSS launches, so a device can actually settle', () => {
    // The property the cache exists for. With a dead read the sample list restarts at 1 every
    // launch, `PROBE_SAMPLE_TARGET` is never reached, `final` is never true, and the probe blocks
    // every launch for the life of the install — measurably worse than having no cache at all,
    // because the launch cost is paid forever and no verdict is ever earned.
    const launches: ProbeReading[] = [
      { cpuUnitsPerMs: 9_200, shadeMfragPerMs: 0.11, fillMpxPerMs: 0 },
      { cpuUnitsPerMs: 9_900, shadeMfragPerMs: 0.14, fillMpxPerMs: 0 },
      { cpuUnitsPerMs: 10_600, shadeMfragPerMs: 0.16, fillMpxPerMs: 0 },
    ];
    const store = probeVerdictStore.get()!;
    let refined = refineProbeVerdict([], launches[0], '3d');
    for (const reading of launches.slice(1)) {
      store.write({
        fingerprint: VERDICT.fingerprint,
        deviceClass: refined.deviceClass as CachedProbeVerdict['deviceClass'],
        samples: [...refined.samples],
        final: refined.final,
      });
      // The next launch reads the record back and folds its own pass in — if `read()` returns
      // null here the chain silently restarts, which is the whole bug.
      const carried = store.read();
      expect(carried, 'the previous launch\'s samples must survive').not.toBeNull();
      refined = refineProbeVerdict(carried!.samples, reading, '3d');
    }
    expect(refined.samples).toHaveLength(3);
    expect(refined).toMatchObject({ deviceClass: 'middle', final: true });
  });

  it('accepts a reading built by readingOf, not just a hand-written sample', () => {
    // Pins the two shapes together. `readingOf` is what production persists, so a field it emits
    // that the validator does not know about is the exact drift this file guards.
    const reading = readingOf({
      intervalMs: 16.7, clockKind: 'webgpu', axes: '3d',
      fill: { kind: 'fill', status: 'ceiling', unitsPerMs: 0, bound: 'lower', peakLoad: 0, steps: [] },
      cpu: { kind: 'cpu', status: 'escaped', unitsPerMs: 9_900, bound: 'measured', peakLoad: 131_072, steps: [] },
      shade: { kind: 'shade', status: 'escaped', unitsPerMs: 14, bound: 'measured', peakLoad: 512, steps: [] },
      totalMs: 1_700, rendererMs: 19, compileMs: 96, shadeCompileMs: 53,
      bufferPixels: 290_000, shadeRegionPixels: 10_000,
    });
    const store = probeVerdictStore.get()!;
    store.write({ ...VERDICT, samples: [reading] });
    expect(store.read()?.samples).toEqual([reading]);
  });

  it('still refuses a record that is malformed rather than merely old', () => {
    // The validation must stay strict — this value decides whether a phone boots into the tier
    // that once cost a Huawei Y6 its GPU context, so a partial record reads as "no cache".
    const store = probeVerdictStore.get()!;
    for (const bad of [
      { ...VERDICT, samples: [] },
      { ...VERDICT, samples: [{ cpuUnitsPerMs: Number.NaN, shadeMfragPerMs: 0.11, fillMpxPerMs: 0 }] },
      { ...VERDICT, samples: [{ cpuUnitsPerMs: 9_200 }] },            // half a sample
      { ...VERDICT, deviceClass: 'unknown' as CachedProbeVerdict['deviceClass'] },
      { ...VERDICT, fingerprint: '' },
    ]) {
      store.write(bad as CachedProbeVerdict);
      expect(store.read(), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
  });
});

/** #487 item 2: a write whose `session()` no longer matches the LIVE store — captured before a
 *  sub-game swap re-namespaced it during the probe's own awaits — must be DROPPED rather than
 *  landed in the incoming game's namespace. */
describe('probe verdict cache — write() is guarded by the swap session (#487 item 2)', () => {
  beforeEach(async () => {
    await PlayerPrefs.init({ backend: new InMemoryBackend(), namespace: 'game-a' });
  });
  afterEach(() => { probeVerdictStore.get()?.write(null); });

  it('writes normally when NO session is supplied — existing callers are unaffected', () => {
    const store = probeVerdictStore.get()!;
    store.write(VERDICT); // no session argument at all
    expect(store.read()).toEqual(VERDICT);
  });

  it('writes normally when the session still matches — no swap happened', () => {
    const store = probeVerdictStore.get()!;
    const session = store.session!(); // this provider always implements it
    store.write(VERDICT, session);
    expect(store.read()).toEqual(VERDICT);
  });

  it('DROPS the write when the namespace changed underneath it (a sub-game swap mid-probe)', async () => {
    const store = probeVerdictStore.get()!;
    const session = store.session!(); // captured for "game-a", as if before the probe's awaits — this provider always implements it
    await PlayerPrefs.init({ namespace: 'game-b' }); // the swap that happens WHILE the probe runs

    // Ordinary path, not an error — see `globalErrors.ts`'s rule that `console.warn` becomes a
    // Crashlytics alerting issue and must not fire on a product path like a sub-game swap.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    store.write(VERDICT, session);
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();

    // Nothing landed in the incoming namespace...
    expect(store.read()).toBeNull();
    // ...and the outgoing namespace's own record was not touched either — dropped, not redirected.
    await PlayerPrefs.init({ namespace: 'game-a' });
    expect(store.read()).toBeNull();
  });

  it('DROPS the write when the generation bumped even if the namespace happens to match', async () => {
    // A swap OUT and back IN to the same namespace still bumps `swapGeneration()` — see its own
    // doc comment: it never resets, and this is precisely the "opened and closed inside the
    // caller's own await" case `isSwapInFlight()` structurally cannot see on its own.
    const store = probeVerdictStore.get()!;
    const session = store.session!(); // this provider always implements it
    await PlayerPrefs.init({ namespace: 'game-b' });
    await PlayerPrefs.init({ namespace: 'game-a' }); // back to the SAME namespace

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    store.write(VERDICT, session);
    log.mockRestore();

    expect(store.read()).toBeNull();
  });
});

/** #487 item 2 review finding: `isSwapInFlight()` is checked AFTER the `gen`/`ns` comparisons,
 *  so it only fires when neither of those already caught the write — i.e. the session was
 *  captured DURING an already-open swap (`swapEpoch` bumps at the very START of `doInit`, before
 *  its first `await`, so any swap that BEGINS after capture is already caught by the `gen`
 *  branch above). Constructing that window needs a backend whose `getAll()` we can hold open, so
 *  the swap is provably still in flight — and still targeting the SAME namespace, so `ns` also
 *  still matches — at the moment `write()` runs. */
describe('probe verdict cache — the isSwapInFlight() branch fires only when captured mid-swap', () => {
  afterEach(() => { probeVerdictStore.get()?.write(null); });

  it('DROPS the write when a session is captured WHILE a swap to the SAME namespace is still open', async () => {
    await PlayerPrefs.init({ backend: new InMemoryBackend(), namespace: 'game-a' });

    // A backend whose getAll() we hold open by hand, so the re-init below parks in
    // `await nextBackend.getAll(prefix)` (playerPrefs.ts) until we release it — that is
    // precisely the window `doInit` calls `swapInFlight = true` for and does not clear until
    // this `getAll` resolves. Re-initing to the SAME namespace means the module-global
    // `namespace` (only reassigned after this await) never actually changes, so `ns` matches
    // both before and during the window too — isolating the branch under test from the `gen`
    // and `ns` branches above it.
    let releaseGetAll!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGetAll = resolve; });
    const stallingBackend: PrefsBackend = {
      async getAll(prefix) {
        await gate;
        return new InMemoryBackend().getAll(prefix);
      },
      async set() {},
      async remove() {},
    };

    const swapPromise = PlayerPrefs.init({ backend: stallingBackend, namespace: 'game-a' });
    // `init()` queues onto `initChain` (a microtask hop) before `doInit`'s synchronous prefix
    // (`swapInFlight = true; swapEpoch++`) runs, and `doInit` may then await an empty
    // pre-swap flush loop before it reaches the `getAll()` we are holding open — so poll
    // rather than assume a fixed number of ticks.
    for (let i = 0; i < 50 && !PlayerPrefs.isSwapInFlight(); i++) await Promise.resolve();

    // ⚠️ Everything from here to the release runs in a `try`, and the gate is released in the
    // `finally`. Without that, an assertion below throwing leaves `getAll()` parked forever —
    // so PlayerPrefs stays swapInFlight for the REST OF THE FILE and every later test times out
    // at 30s. A real failure here would then bury itself under unrelated timeouts, which is the
    // opposite of what a failing test is for. (Found by mutation-checking this very branch.)
    try {
      const store = probeVerdictStore.get()!;
      expect(PlayerPrefs.isSwapInFlight()).toBe(true);
      // Captured WHILE the swap above is open — both gen and ns already reflect the new swap's
      // values, so this session matches on both counts at write time and only isSwapInFlight()
      // is left to catch it.
      const session = store.session!(); // this provider always implements it

      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      store.write(VERDICT, session);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toContain('swap is currently in flight');
      log.mockRestore();

      expect(store.read()).toBeNull();
    } finally {
      releaseGetAll();
      await swapPromise;
    }
  });
});

/** #487 item 2 review finding: the `wellFormed` guard on `write()`'s session argument is
 *  unreachable from any IN-REPO caller — `tierResolve.ts` only ever hands back exactly what
 *  `session()` gave it. It exists for an OUT-OF-REPO `ProbeVerdictStore` consumer (or a hand-built
 *  test double) that passes something else entirely, so this direct unit test is the only cover
 *  it will ever get. Do not delete it as dead code — see `docs/player-prefs.md`'s equivalent note
 *  on agentBridge's counter for the same shape of "unreachable from here, real from outside". */
describe('probe verdict cache — write() rejects a malformed session token without throwing', () => {
  beforeEach(async () => {
    await PlayerPrefs.init({ backend: new InMemoryBackend(), namespace: 'game-a' });
  });
  afterEach(() => { probeVerdictStore.get()?.write(null); });

  it('drops a non-object session token', () => {
    const store = probeVerdictStore.get()!;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => store.write(VERDICT, 42)).not.toThrow();
    log.mockRestore();

    expect(store.read()).toBeNull();
  });

  it('drops an object session token missing `ns`', () => {
    const store = probeVerdictStore.get()!;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => store.write(VERDICT, { gen: 0 })).not.toThrow();
    log.mockRestore();

    expect(store.read()).toBeNull();
  });
});
