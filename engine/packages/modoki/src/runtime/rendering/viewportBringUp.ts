/** A 3D viewport's renderer bring-up DECISIONS, in a module a test can reach (#824, #1052).
 *
 *  These used to be `const`s inside `Scene3D.tsx`'s ~900-line effect closure, reachable only by
 *  mounting the component — which CLAUDE.md rules out ("never mount a panel in jsdom: that asserts
 *  the mock"). Measured when #824 was filed: with #819's target retirement and both halves of #820
 *  deleted from `Scene3D.tsx`, the full gate still passed 18,116 tests. Three landed fixes, pinned by
 *  nothing. `tests/runtime/viewportBringUp.test.ts` is where they are pinned now.
 *
 *  TWO callers: the game's `Scene3D.tsx`, and since #1052 the editor's `SceneView.tsx`, whose
 *  context-loss rebuild used to re-run its whole setup UNBOUNDED — a hung WebGPU init latched its
 *  recovery exactly as #820 latched Scene3D's. The editor needs three seams Scene3D does not use:
 *   - `createRenderer(kind)` — SceneView retries a BOOT's creation itself but leaves a rebuild's
 *     retries to `rendererRecovery`, so one bound measures one attempt.
 *   - an ASYNC `install(r, stillCurrent)` — SceneView awaits `setActiveRenderer` mid-install, and a
 *     loss during that await can start a newer bring-up, which the check reveals.
 *   - `discard(r, reason)` — a leased renderer arriving after UNMOUNT must go back through its
 *     container lease (a StrictMode remount may be re-acquiring it), while a SUPERSEDED one's lease
 *     was already dropped by the attempt that overtook it.
 *
 *  ⚠️ **Keep this module free of the DOM and of three.** A renderer here is anything with `dispose()`
 *  and a `domElement`; the viewport supplies `createRenderer`, `install` and `teardown`. That is the
 *  seam that lets a test drive the real decisions with a fake renderer — move a DOM call in here and
 *  the tests go back to asserting a mock.
 *
 *  ── 1. The bound applies to REBUILDS only ──────────────────────────────────────────────────────
 *  Measured, not stylistic. `canvas2DPool.ts`'s history records a rejecting 8 s bound on a FIRST init
 *  turning a merely slow cold bring-up (8.5 s on a low-end GPU) into a permanent failure — the init
 *  succeeded with nothing left listening. So `boot()` waits as long as `createRenderer` takes. A
 *  REBUILD has `rendererRecovery` behind it, and there an unbounded bring-up that HANGS latches
 *  `inFlight` forever — no retry, no report, a surface black in silence (#820) — so `rebuild()` is
 *  bounded by `REBUILD_BRINGUP_TIMEOUT_MS`.
 *
 *  ── 2. A late renderer is ADOPTED unless something superseded it ──────────────────────────────
 *  A bound without this is strictly worse than no bound: a slow-but-alive `createRenderer` would
 *  reject every attempt, recovery would stop scheduling, each late renderer would be thrown away, and
 *  the surface would stay black for the life of the realm — where without the bound it simply
 *  succeeded, late. #820's first version disposed the late renderer unconditionally and did exactly
 *  that. `canvas2DPool` answers the same problem by curing whichever attempt produces a renderer
 *  (`revalidateOwed`); this is the 3D answer. **A working surface beats a blank one.**
 *
 *  What makes adopting a late renderer safe is the supersession token: every attempt calls
 *  `begin()`, which turns every EARLIER attempt's check false. So a superseded arrival — late, or
 *  on time behind a boot a rebuild overtook — is disposed rather than fighting the winner. The
 *  initial `boot()` runs OUTSIDE recovery's single-flight latch, which is how two attempts can be in
 *  flight at once (`docs/async-lifetime.md` § "The other half").
 *
 *  ── 3. A timed-out readback retires the pooled capture target ─────────────────────────────────
 *  See `boundedCaptureReadback`. */

import { withTimeout, TimeoutError } from '../core/abandonment';
import { createSupersessionToken, type LivenessCheck } from '../core/liveness';
import { REBUILD_BRINGUP_TIMEOUT_MS } from './rendererRecovery';

/** The only surface of a renderer these decisions touch. */
export interface BringUpRenderer {
  dispose(): void;
  readonly domElement: { remove(): void };
}

/** Which bring-up a `createRenderer` call serves. */
export type BringUpKind = 'boot' | 'rebuild';

/** Why a renderer is being thrown away instead of installed. */
export type DiscardReason = 'disposed' | 'superseded';

export interface ViewportBringUpDeps<R extends BringUpRenderer> {
  /** Create and initialise a renderer. Not cancellable — which is why a late one needs a disposition.
   *  `kind` lets a caller treat a first bring-up and a context-loss rebuild differently. */
  createRenderer: (kind: BringUpKind) => Promise<R>;
  /** True once the owning effect has unmounted for good. */
  isDisposed: () => boolean;
  /** Wire a renderer that has been cleared for service. May be async: `boot()`/`rebuild()` settle
   *  only once it has. `stillCurrent` turns false as soon as a NEWER bring-up begins, so an install
   *  that awaits can tell it has been overtaken. */
  install: (r: R, stillCurrent: LivenessCheck) => void | Promise<void>;
  /** Tear down whatever the last `install` wired. `rebuild()` calls it before its bring-up. */
  teardown: () => void;
  /** Where a renderer that will NOT be installed goes. Default: `dispose()` + `domElement.remove()`.
   *  ⚠️ `superseded` is decided BEFORE `disposed`, deliberately: a caller that leases renderers had a
   *  superseded one's lease dropped by the attempt that overtook it — even when the viewport has also
   *  unmounted since — so handing it back to the lease would release the SUCCESSOR's hold. */
  discard?: (r: R, reason: DiscardReason) => void;
  /** A renderer adopted LATE (after the rebuild bound) has no caller left to await its install, so an
   *  install failure there is reported through this. Default: `console.error`. */
  onLateInstallError?: (e: unknown) => void;
  /** Override for tests only; production uses `REBUILD_BRINGUP_TIMEOUT_MS`. */
  rebuildTimeoutMs?: number;
}

export interface ViewportBringUp {
  /** The FIRST bring-up. Unbounded (rule 1): rejects only if `createRenderer` or `install` does. */
  boot(): Promise<void>;
  /** The context-loss rebuild `rendererRecovery` drives: teardown, then a bounded bring-up that
   *  rejects with a `TimeoutError` past the bound — and still adopts the renderer if it arrives
   *  later with nothing having superseded it (rule 2). */
  rebuild(): Promise<void>;
}

export function createViewportBringUp<R extends BringUpRenderer>(deps: ViewportBringUpDeps<R>): ViewportBringUp {
  const token = createSupersessionToken();

  const discard = (r: R, reason: DiscardReason): void => {
    try {
      if (deps.discard) deps.discard(r, reason);
      else { r.dispose(); r.domElement.remove(); }
    } catch { /* already dead */ }
  };

  /** Take a renderer into service, or discard it if it lost its race. Superseded first — see `discard`. */
  const adopt = (r: R, stillCurrent: LivenessCheck): boolean => {
    if (!stillCurrent()) { discard(r, 'superseded'); return false; }
    if (deps.isDisposed()) { discard(r, 'disposed'); return false; }
    return true;
  };

  const bringUp = async (kind: BringUpKind, timeoutMs?: number): Promise<void> => {
    const stillCurrent = token.begin();
    const create = deps.createRenderer(kind);
    const r = timeoutMs === undefined
      ? await create
      : await withTimeout(create, timeoutMs, 'viewport renderer bring-up', {
        // Rule 2: adopted if nothing superseded it, discarded if something did. Throwing it away
        // unconditionally is what turns a slow device into a permanently black one.
        onSettled: (res) => {
          if (!res.ok || !adopt(res.value, stillCurrent)) return;
          void Promise.resolve()
            .then(() => deps.install(res.value, stillCurrent))
            .catch((e) => {
              if (deps.onLateInstallError) deps.onLateInstallError(e);
              else console.error('[viewportBringUp] a late renderer was adopted, but installing it FAILED:', e);
            });
        },
      });
    if (!adopt(r, stillCurrent)) return;
    await deps.install(r, stillCurrent);
  };

  return {
    boot: () => bringUp('boot'),
    rebuild: async () => {
      deps.teardown();
      await bringUp('rebuild', deps.rebuildTimeoutMs ?? REBUILD_BRINGUP_TIMEOUT_MS);
    },
  };
}

/** How long an offscreen capture's GPU readback may take before it is abandoned. A stalled or lost
 *  device must not leave `capturing` stuck true and park the live render loop forever (P2-4).
 *  Mechanism, not config. */
export const OFFSCREEN_READBACK_TIMEOUT_MS = 10_000;

/** The pooled capture render target, as the readback sees it. */
export interface CaptureTargetSlot<T> {
  /** What the pool currently holds. */
  current(): T | null;
  /** Drop the pool's reference, so the next capture allocates a fresh target. */
  retire(): void;
}

/** Await a capture readback of `rt`, bounded — and when the bound is hit, keep the pool away from
 *  a target the abandoned read still owns (#819).
 *
 *  The caller releases `capturing` even on a timeout, deliberately (P2-4). But the stalled read is
 *  still using `rt`, and the target is POOLED: the next capture would `setRenderTarget(rt)` and
 *  render into a target the first read is still reading. So a timeout RETIRES it from the pool, and
 *  the retired target is disposed only when the read actually settles. If the read never settles,
 *  that `rt` leaks until realm death — the deliberate trade.
 *
 *  ⚠️ SCOPE: this closes the pooled-REUSE route only. `Scene3D`'s teardown disposes the pooled
 *  target unconditionally and runs on the recovery path too, so a device loss during a stalled read
 *  still disposes the target underneath it, and `onSettled` then disposes it a second time. Both are
 *  survivable today (three's `RenderTarget.dispose()` only dispatches an event, and both backends'
 *  handlers are idempotent) — do not read this as a general guarantee that a live read owns its
 *  target. */
export async function boundedCaptureReadback<T extends { dispose(): void }>(
  read: Promise<Uint8Array>,
  rt: T,
  slot: CaptureTargetSlot<T>,
  timeoutMs: number = OFFSCREEN_READBACK_TIMEOUT_MS,
): Promise<Uint8Array> {
  try {
    return await withTimeout(read, timeoutMs, 'offscreen readback', {
      onSettled: () => { try { rt.dispose(); } catch { /* already gone */ } },
    });
  } catch (e) {
    // Only a TIMEOUT means the read still owns `rt`; a read that REJECTED in time owns nothing. And
    // only retire the target the pool still holds — never a newer one it has moved on to.
    if (e instanceof TimeoutError && slot.current() === rt) slot.retire();
    throw e;
  }
}
