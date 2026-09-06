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
 *  4. A FAILED REBUILD IS RETRIED (#156). It used to be reported and dropped, and that was
 *     TERMINAL BY CONSTRUCTION: the only thing that can ask for another attempt is a further
 *     `onRendererLost`, and after a failed rebuild there is no live renderer left to lose, so
 *     that event can never arrive. The old message — "stays black until another loss is reported"
 *     — named a condition nothing could reach. Measured on a Huawei Y6 2019: a context loss
 *     during BOOT, the rebuild rejects, and the surface is blank for the process lifetime.
 *
 *     Retried with BACKOFF because the likeliest reason `init()` rejects moments after a loss is
 *     that the driver is still resetting — the same reasoning as rule 1's delay, one step further
 *     out. Bounded, because a device that cannot bring a renderer up after several tries is not
 *     going to on the tenth, and a hot loop would be worse than a black screen.
 *
 *     ⚠️ This retries a rebuild that FAILED. It is not a second give-up budget for context LOSS —
 *     `core/activeRenderer` still owns that (see above), and the two must not be conflated: one
 *     counts how often the GPU dies, this counts how often bring-up refuses to start.
 */

/** Delay before a rebuild starts. A DELIBERATE GUESS, not a tuned figure: long enough to be
 *  clearly out of the loss event and to let a context teardown settle, short enough that the
 *  user reads it as a hitch rather than a hang. The recovery this serves is already visible
 *  (shader prewarm re-runs), so a few hundred ms is not the dominant cost. */
export const DEFAULT_REBUILD_DELAY_MS = 250;

/** How many times bring-up may REJECT before the viewport gives up (rule 4). Three, so a driver
 *  that needs a moment gets ~250 + 500 + 1000 ms of it, and a genuinely dead device stops fast. */
export const DEFAULT_MAX_REBUILD_ATTEMPTS = 3;

/** How long a REBUILD's renderer bring-up may take before it counts as failed and REJECTS.
 *
 *  Lives here, with the rest of the shared rebuild policy, for the same reason the scheduler does:
 *  the 2D pool and the 3D viewports must not disagree about when a rebuild has failed. It was two
 *  constants for a while — `canvas2DPool`'s `APP_INIT_TIMEOUT_MS` and nothing at all on the 3D
 *  side, which is #820 — and a hand-kept copy of a number in two files is exactly the shadow
 *  constant this repo's single-source-of-truth rule exists to prevent.
 *
 *  ⚠️ This bounds REBUILDS, never a FIRST bring-up, and that asymmetry is measured rather than
 *  stylistic. `canvas2DPool`'s own history records a rejecting 8s bound on a first init turning a
 *  merely SLOW cold bring-up — 8.5s on a low-end GPU — into a permanent failure: the init
 *  succeeded at 8.5s with nothing still listening. A first init therefore gets a WATCHDOG that
 *  reports and waits; only a rebuild gets a bound that rejects, because a rebuild has
 *  `rendererRecovery` behind it to retry with backoff, and an unbounded one latches `inFlight`
 *  forever — no retry, no report, a surface black in silence.
 *
 *  Generous — a real bring-up on a slow phone is well under this — but FINITE. */
export const REBUILD_BRINGUP_TIMEOUT_MS = 8000;

/** Describe a rejection that is not an `Error` — the #156 reporting half.
 *
 *  The symptom this exists for: `[Scene3D] renderer rebuild after context loss FAILED … {}`. It is
 *  tempting to blame serialization (`Error`'s `message`/`stack` are non-enumerable, so
 *  `JSON.stringify` renders `{}`), and that is WRONG here — the device console capture already
 *  special-cases `Error` and would have sent the stack (`app/debug/agentBridge.ts`). An empty `{}`
 *  therefore proves the rejection was a NON-Error carrying no enumerable properties, i.e. the
 *  reason genuinely did not exist in readable form. three's backends reject with assorted shapes,
 *  so the fix belongs here rather than at each throw site.
 *
 *  Pure, and total: it must never throw while describing why something else failed. */
export function describeRebuildFailure(e: unknown): string {
  if (e instanceof Error) return e.stack || `${e.name}: ${e.message}`;
  if (e === undefined) return 'rejected with undefined';
  if (e === null) return 'rejected with null';
  const kind = typeof e === 'object' ? (e.constructor?.name ?? 'object') : typeof e;
  let text: string;
  try {
    text = typeof e === 'object' ? JSON.stringify(e) ?? String(e) : String(e);
  } catch { text = '<unserializable>'; }
  // `{}` is the case that started this: an object whose own properties are all non-enumerable.
  // Fall back to whatever the prototype chain exposes, so the report says SOMETHING.
  if (text === '{}' && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    const salvaged = ['name', 'message', 'code', 'reason']
      .map((k) => (o[k] === undefined ? null : `${k}=${String(o[k])}`))
      .filter(Boolean);
    text = salvaged.length ? `{${salvaged.join(', ')}}` : `${String(e)} (no readable properties)`;
  }
  return `non-Error rejection (${kind}): ${text}`;
}

export interface RendererRecoveryDeps {
  /** Tear the old renderer down and bring a new one up. Rejecting is reported, not fatal —
   *  a further loss can still ask for another attempt while the budget holds. */
  rebuild: () => Promise<void>;
  /** True once the owning viewport has torn down for good (React unmount). Checked both when a
   *  request arrives AND after the delay, because an unmount can land in between. */
  isDisposed: () => boolean;
  /** Reported when `rebuild` rejects. Receives a `description` already normalised by
   *  `describeRebuildFailure` (a non-Error rejection is why #156's report read `{}`), plus
   *  whether another attempt is coming — so the viewport can say "retrying" instead of
   *  announcing a permanent black screen that a retry may be about to disprove. */
  onError?: (e: unknown, info: { description: string; attempt: number; willRetry: boolean }) => void;
  delayMs?: number;
  /** Bring-up rejections tolerated before giving up. Default `DEFAULT_MAX_REBUILD_ATTEMPTS`. */
  maxAttempts?: number;
  /** Called when a rebuild request is DROPPED or a scheduled run bails, with the reason.
   *
   *  ⚠️ These paths used to return in total silence, and that is how a recovery failure becomes
   *  indistinguishable from a recovery that never ran: #213 spent a round trip on a device
   *  unable to tell "rebuild rejected" from "rebuild never started", because only the success and
   *  failure paths ever said anything. A recovery mechanism that can decline silently cannot be
   *  debugged from a log. */
  onSkipped?: (reason: 'disposed' | 'in-flight' | 'timer-pending') => void;
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

  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_REBUILD_ATTEMPTS);

  let timer: unknown = null;
  let inFlight = false;
  /** A loss arrived while a rebuild was running — run exactly one more once it settles. */
  let again = false;
  let disposed = false;
  /** Consecutive bring-up REJECTIONS (rule 4). Reset by a success, and by a fresh loss request —
   *  a new fault deserves the full budget rather than inheriting an old one's exhaustion. */
  let failures = 0;

  const run = async () => {
    timer = null;
    // Re-check: the viewport can unmount during the delay, and rebuilding into a torn-down
    // container would leak a renderer nobody will ever dispose.
    if (disposed || deps.isDisposed()) { deps.onSkipped?.('disposed'); return; }
    inFlight = true;
    let failed = false;
    try {
      await deps.rebuild();
      failures = 0;
    } catch (e) {
      failed = true;
      failures++;
      // Decided BEFORE the report so the message can say whether a retry is coming — a viewport
      // announcing a permanent black screen that a retry then fixes is worse than no message.
      const willRetry = failures < maxAttempts && !disposed && !deps.isDisposed();
      deps.onError?.(e, { description: describeRebuildFailure(e), attempt: failures, willRetry });
    } finally {
      // MUST reset before the follow-up, and in `finally`: a rebuild that throws would
      // otherwise latch `inFlight` true forever and silently swallow every later loss —
      // turning a recoverable fault back into the permanent black screen this phase exists
      // to remove.
      inFlight = false;
      if (again) {
        again = false;
        request();
      } else if (failed && failures < maxAttempts) {
        // Rule 4. Backoff doubles per failure: the likeliest reason bring-up rejects moments
        // after a loss is a driver still resetting, and retrying at the same interval that just
        // failed mostly buys another identical failure.
        schedule(delayMs * 2 ** failures);
      }
    }
  };

  /** Arm the one pending timer. Coalescing lives here so both the loss path and the retry path
   *  are physically unable to run two rebuilds. */
  function schedule(ms: number): void {
    if (disposed || deps.isDisposed()) { deps.onSkipped?.('disposed'); return; }
    if (inFlight || timer !== null) { deps.onSkipped?.(inFlight ? 'in-flight' : 'timer-pending'); return; }
    timer = setTimer(run, ms);
  }

  function request(): void {
    // ⚠️ This early return was SILENT, and it is the first one a request hits — so a recovery that
    // never even scheduled looked identical, in the log, to one that scheduled and failed. On
    // device that cost a full build/deploy round trip to distinguish (#213).
    if (disposed || deps.isDisposed()) { deps.onSkipped?.('disposed'); return; }
    if (inFlight) { again = true; return; }   // rule 3
    failures = 0;                              // a fresh fault gets the full retry budget
    schedule(delayMs);                         // rules 1 + 2
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
