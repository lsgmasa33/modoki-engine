/** WHEN to rebuild a viewport's renderer after GPU context loss (#121 P1).
 *
 *  Split out of the two viewports (`rendering/Scene3D.tsx`, `editor/panels/SceneView.tsx`)
 *  deliberately: the rebuild ITSELF is imperative wiring that only the viewport can do — it owns
 *  the container, the DOM node and the bring-up closure — but the scheduling around it is pure
 *  decision-making, and that is the part worth testing. Mounting a viewport in jsdom to test
 *  these rules would assert the mock, not the policy.
 *
 *  WHAT THIS MODULE IS NOT. It does not decide WHETHER recovery is still worth attempting —
 *  `core/activeRenderer.ts` owns that budget (`MAX_RECOVERY_ATTEMPTS` inside
 *  `RECOVERY_WINDOW_MS`) and simply stops firing `onRendererLost` once it is spent. Duplicating
 *  a give-up rule here would create two policies that can disagree about whether a device is
 *  hopeless. This module answers only: given that a rebuild has been asked for, when does it
 *  run, and how do overlapping requests behave.
 *
 *  The three rules, and why each is not optional:
 *
 *  1. NEVER REBUILD SYNCHRONOUSLY INSIDE THE LOSS EVENT. `reportRendererLoss` calls its
 *     listeners straight out of the `webglcontextlost` handler. Tearing down and re-creating a
 *     GPU device from inside the event that reports the device's death gives the browser no
 *     chance to finish handling it.
 *  2. ONE REBUILD AT A TIME. A rebuild is async (renderer creation + `init()` + shader prewarm),
 *     and a device that just died can easily die again mid-rebuild. Overlapping rebuilds would
 *     race two renderers into the same container.
 *  3. A LOSS DURING A REBUILD IS NOT DISCARDED. It is coalesced into exactly ONE follow-up
 *     rebuild — the new renderer may itself be dead on arrival, and dropping that signal would
 *     strand the viewport black with the budget unspent. Coalesced, not queued per event: five
 *     losses during one rebuild mean the same thing as one.
 */

/** Delay before a rebuild starts. A DELIBERATE GUESS, not a tuned figure: long enough to be
 *  clearly out of the loss event and to let a context teardown settle, short enough that the
 *  user reads it as a hitch rather than a hang. The recovery this serves is already visible
 *  (shader prewarm re-runs), so a few hundred ms is not the dominant cost. */
export const DEFAULT_REBUILD_DELAY_MS = 250;

export interface RendererRecoveryDeps {
  /** Tear the old renderer down and bring a new one up. Rejecting is reported, not fatal —
   *  a further loss can still ask for another attempt while the budget holds. */
  rebuild: () => Promise<void>;
  /** True once the owning viewport has torn down for good (React unmount). Checked both when a
   *  request arrives AND after the delay, because an unmount can land in between. */
  isDisposed: () => boolean;
  /** Reported when `rebuild` rejects. */
  onError?: (e: unknown) => void;
  delayMs?: number;
  /** Injectable timers — so the tests assert the POLICY rather than sleeping through it. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface RendererRecovery {
  /** "Your renderer is dead" — schedule a rebuild under the rules above. Safe to call any
   *  number of times, from inside the loss event. */
  request(): void;
  /** Cancel anything pending. The owning viewport calls this on unmount. */
  dispose(): void;
  /** Diagnostic: is a rebuild running right now? */
  isRebuilding(): boolean;
}

export function createRendererRecovery(deps: RendererRecoveryDeps): RendererRecovery {
  const delayMs = deps.delayMs ?? DEFAULT_REBUILD_DELAY_MS;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer
    ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  let inFlight = false;
  /** A loss arrived while a rebuild was running — run exactly one more once it settles. */
  let again = false;
  let disposed = false;

  const run = async () => {
    timer = null;
    // Re-check: the viewport can unmount during the delay, and rebuilding into a torn-down
    // container would leak a renderer nobody will ever dispose.
    if (disposed || deps.isDisposed()) return;
    inFlight = true;
    try {
      await deps.rebuild();
    } catch (e) {
      deps.onError?.(e);
    } finally {
      // MUST reset before the follow-up, and in `finally`: a rebuild that throws would
      // otherwise latch `inFlight` true forever and silently swallow every later loss —
      // turning a recoverable fault back into the permanent black screen this phase exists
      // to remove.
      inFlight = false;
      if (again) {
        again = false;
        request();
      }
    }
  };

  function request(): void {
    if (disposed || deps.isDisposed()) return;
    if (inFlight) { again = true; return; }   // rule 3
    if (timer !== null) return;                // already scheduled — coalesce
    timer = setTimer(run, delayMs);            // rules 1 + 2
  }

  return {
    request,
    dispose(): void {
      disposed = true;
      again = false;
      if (timer !== null) { clearTimer(timer); timer = null; }
    },
    isRebuilding: () => inFlight,
  };
}
