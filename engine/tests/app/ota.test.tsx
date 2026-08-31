/** #437 — the OTA blocking gate (`engine/app/ota.ts`). App.tsx's `[gameId]` boot effect can
 *  re-run `checkAppOtaUpdate()` before an in-flight call returns (a game swap), and that
 *  in-flight call was never cancelled — it kept writing `setGate` from an epoch nobody wanted
 *  anymore. Covers four behaviours of the fix:
 *   1. the per-call generation guard — a stale call cannot write the gate once a newer call
 *      has started;
 *   2. the sticky `ready-to-restart` backstop in `setGate` — a `null` write must never clear it;
 *   3. the terminal short-circuit — once `ready-to-restart`, a later check resolves `false`
 *      without re-running the update check, so App.tsx never boots a scene behind the gate;
 *   4. the `otaProgress` listener is removed via `finally` even when `checkForUpdate` rejects.
 *
 *  No `.tsx`/JSX is used here — the file is still `.test.tsx` because `engine/vite.config.ts`'s
 *  app-suite `include` only picks up `tests/app/**\/*.test.tsx`, not `.test.ts`.
 *
 *  `ota.ts` holds its gate/generation state in module-level `let`s with no reset export, so
 *  every test gets a FRESH module instance via `vi.resetModules()` + a dynamic `import()` —
 *  otherwise one test's gate would leak into the next. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => true),
  checkForUpdate: vi.fn(),
  fetchRelease: vi.fn(),
  addListener: vi.fn(),
  ota: { enabled: true, baseUrl: 'https://example.test', publicKey: 'pk', bundleName: 'shell', engineApi: 1 },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: h.isNativePlatform },
  // Unused by the four behaviours here (isPluginUnimplemented isn't exercised), but ota.ts
  // imports it at module scope, so the mock must supply something.
  ExceptionCode: { Unimplemented: 'UNIMPLEMENTED' },
}));
vi.mock('virtual:modoki-project-config', () => ({ default: { ota: h.ota } }));
vi.mock('@modoki/engine/runtime', () => ({
  checkForUpdate: h.checkForUpdate,
  fetchRelease: h.fetchRelease,
}));
vi.mock('capacitor-modoki-ota', () => ({
  ModokiOta: { addListener: h.addListener },
}));

beforeEach(() => {
  vi.resetModules();
  // resetAllMocks (not clearAllMocks): several tests queue `mockResolvedValueOnce` /
  // `mockRejectedValueOnce` / `mockImplementationOnce` calls on the SAME hoisted `h.checkForUpdate`
  // — clearAllMocks only wipes call history, leaving a queued-but-unconsumed implementation (e.g.
  // the short-circuit test's second, deliberately-unreached queued value) to bleed into the NEXT
  // test's first call. resetAllMocks drops queued implementations too.
  vi.resetAllMocks();
  h.isNativePlatform.mockReturnValue(true);
  h.ota.enabled = true;
});

/** Re-imports `ota.ts` fresh (see the header comment on why). */
async function freshOta() {
  return import('../../app/ota');
}

describe('#437 checkAppOtaUpdate / the blocking gate', () => {
  it('an older in-flight check cannot write the gate once a newer check has started (generation guard)', async () => {
    const ota = await freshOta();
    h.addListener.mockResolvedValue({ remove: vi.fn(async () => {}) });

    // Call 1 ("old") hangs on a manually-resolved promise; call 2 ("new") resolves promptly
    // with a DIFFERENT staged+mandatory version, so the two writes are trivially distinguishable.
    let resolveOld: (r: unknown) => void = () => {};
    const oldResult = new Promise((res) => { resolveOld = res; });
    h.checkForUpdate
      .mockImplementationOnce(() => oldResult)
      .mockImplementationOnce(async () => ({ outcome: 'staged', mandatory: true, version: 'v2' }));

    const snapshots: unknown[] = [];
    ota.subscribeOtaGate((s) => snapshots.push(s));

    const p1 = ota.checkAppOtaUpdate(); // generation 1, hangs inside checkForUpdate
    // Let call 1 actually reach its `checkForUpdate` invocation (consuming the FIRST
    // mockImplementationOnce) before starting call 2, so the two calls' mock results land on
    // the calls they're meant to — otherwise call 2 could race ahead and consume `oldResult`.
    await vi.waitFor(() => expect(h.checkForUpdate).toHaveBeenCalledTimes(1));

    const p2 = ota.checkAppOtaUpdate(); // generation 2 — the newer, "current" call
    await p2;
    expect(snapshots[snapshots.length - 1]).toEqual({ phase: 'ready-to-restart', version: 'v2' });

    // Now the stale call resolves and tries to write ITS OWN "ready-to-restart" over the
    // newer generation's gate. Without the guard this clobbers v2 with the superseded v1.
    resolveOld({ outcome: 'staged', mandatory: true, version: 'v1' });
    await p1;

    expect(snapshots[snapshots.length - 1]).toEqual({ phase: 'ready-to-restart', version: 'v2' });
  });

  // ⚠️ Best-effort coverage, not a clean isolation of the backstop from the short-circuit
  // (test 3 below): with BOTH fixes in place, `setGate` has exactly one call site
  // (`setGateIfCurrent`, itself generation-guarded), and the short-circuit at the top of
  // `checkAppOtaUpdate` means a call issued AFTER the gate is already `ready-to-restart` never
  // even reaches `checkForUpdate`, let alone a `setGateIfCurrent(null)` write — so there is no
  // path through the CURRENT public surface that reaches `setGate(null)` while the gate is
  // `ready-to-restart` without ALSO going through the short-circuit. This test therefore
  // exercises the observable guarantee ("a check whose result is nothing-to-do leaves a
  // previously-set ready-to-restart gate standing"), which both defenses jointly provide; see
  // the mutation-check report for what this test does and does not isolate.
  it('a subsequent check leaves a previously-set ready-to-restart gate standing (sticky backstop)', async () => {
    const ota = await freshOta();
    h.addListener.mockResolvedValue({ remove: vi.fn(async () => {}) });
    h.checkForUpdate.mockResolvedValueOnce({ outcome: 'staged', mandatory: true, version: 'v1' });

    await ota.checkAppOtaUpdate();

    const snapshots: unknown[] = [];
    ota.subscribeOtaGate((s) => snapshots.push(s)); // fires immediately with the current state
    expect(snapshots[0]).toEqual({ phase: 'ready-to-restart', version: 'v1' });

    // A further check whose own result would normally be "nothing to do" (un-arming the gate)
    // must not clear the standing restart gate.
    h.checkForUpdate.mockResolvedValueOnce({ outcome: 'up-to-date' });
    const result = await ota.checkAppOtaUpdate();
    expect(result).toBe(false);

    expect(snapshots[snapshots.length - 1]).toEqual({ phase: 'ready-to-restart', version: 'v1' });
  });

  it('once ready-to-restart, a later check resolves false without re-running the update check (terminal short-circuit)', async () => {
    const ota = await freshOta();
    h.addListener.mockResolvedValue({ remove: vi.fn(async () => {}) });
    h.checkForUpdate.mockResolvedValueOnce({ outcome: 'staged', mandatory: true, version: 'v1' });

    const first = await ota.checkAppOtaUpdate();
    expect(first).toBe(false);
    expect(h.checkForUpdate).toHaveBeenCalledTimes(1);

    // App.tsx's boot effect can call this again on a game swap. If it were to resolve `true`
    // here, App.tsx would load a scene behind a gate the user cannot dismiss (#437 review
    // finding 3) — the whole point of the fix.
    const second = await ota.checkAppOtaUpdate();
    expect(second).toBe(false);
    expect(h.checkForUpdate).toHaveBeenCalledTimes(1); // never re-entered the update check
  });

  it('the otaProgress listener is removed even when checkForUpdate rejects', async () => {
    const ota = await freshOta();
    const remove = vi.fn(async () => {});
    h.addListener.mockResolvedValue({ remove });
    h.checkForUpdate.mockRejectedValueOnce(new Error('network down'));

    const result = await ota.checkAppOtaUpdate();

    expect(result).toBe(true); // a failing check is non-fatal — boot proceeds normally
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
