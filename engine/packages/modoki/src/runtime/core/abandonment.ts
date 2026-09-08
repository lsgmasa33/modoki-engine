/** Shared machinery for "give this promise `ms` to settle, and say what happens to it if it
 *  doesn't" — the ONE `withTimeout` for the engine.
 *
 *  ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
 *  `withTimeout` had been hand-rolled SIX times in this tree: four named helpers
 *  (`canvas2DPool.ts`, `gpuClock.ts`, `rampProbeRunner.ts`, `msdfGenerate.ts`) and two inline
 *  copies (`Scene3D.tsx`, `app/debug/bridgeHelpers.ts`), all built to the
 *  same reject-only shape: race the promise against a timer, reject the CALLER when the timer
 *  wins. Five of the six were live call sites; `rampProbeRunner`'s had NO caller at all (it was
 *  exported solely so a test could assert the mechanism) and was deleted rather than migrated, so
 *  the family is five live sites and six implementations. Each live one is a lie by omission —
 *  rejecting the caller does not touch the underlying operation, which is still running. `Promise.race` cannot cancel its losing side;
 *  nothing here can either, because **none of the operations this wraps accepts an
 *  `AbortSignal`** (a Pixi `Application.init()`, a GPU fence poll, a worker's `generateAtlas`, a
 *  WebGPU `onSubmittedWorkDone()`). The promise keeps running to completion regardless of what the
 *  caller decided to do about the timeout.
 *
 *  That leaves a real question at every call site: when the abandoned operation eventually
 *  settles — maybe 50ms later, maybe never — what happens to its result? Half the sites never
 *  asked it: three of the six were already correct (`gpuClock`, `rampProbeRunner`,
 *  `bridgeHelpers` — a late value there owns nothing), and the other three carry FIVE defects
 *  between them (#801, #817, #818, #819, #820). So `withTimeout` makes the disposition a REQUIRED
 *  fourth argument, typed as a closed union:
 *
 *  - **`{ adopt }`** — a late settlement is handled on its OWN path (some other code already
 *    reads the eventual result, e.g. a cache or a retry loop keyed off the same promise). This
 *    call's timeout is purely a "stop waiting", not a "stop caring".
 *  - **`{ discard }`** — the late value owns nothing and asserts nothing; it is dropped on the
 *    floor on purpose. The stale GPU duration `gpuClock.ts` used to await is exactly this: once
 *    the measurement has timed out, a late number is meaningless and holds no resource.
 *  - **`{ onSettled }`** — the late value (or error) DOES own something that must be released or
 *    disposed even though the caller has already moved on (a slot to free, a listener to detach,
 *    a handle to close).
 *
 *  `adopt` and `discard` are both runtime no-ops — nothing here distinguishes them once the code
 *  is running. The distinction is deliberately type-level and load-bearing at the SOURCE line: an
 *  author cannot call `withTimeout` without writing down, in the string, which of the three is
 *  true and why. A future reader — or the next author copying the call site — gets that reasoning
 *  for free instead of having to reconstruct it from the surrounding code (or, as happened here,
 *  not reconstructing it and getting it wrong).
 *
 *  ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────────────────────
 *  ⚠️ **This does not cancel anything.** The abandoned promise keeps running; `withTimeout` only
 *  changes who is told about the eventual result, and how late they hear about it. If a real
 *  cancellation primitive becomes available for one of these operations, the right fix is to wire
 *  an `AbortSignal` at that call site, not to lean harder on this file.
 *
 *  ⚠️ **Nothing here warns when a late settlement actually arrives.** `onSettled` gets called, but
 *  the primitive itself never logs "the operation you gave up on to `ms` finished anyway N ms
 *  later" — so it cannot tell a caller that its timeout is set too tight, only let it dispose of
 *  what the late result was holding. A caller that wants that signal has to build it into its own
 *  `onSettled`.
 *
 *  ── THE TIMER MUST BE CLEARED ──────────────────────────────────────────────────────────────
 *  An uncleared timer on the happy path is a real, previously-shipped bug: see
 *  `rampProbeRunner.ts`'s history — the ramp probe once believed in a phantom 8-second WebGPU
 *  timeout for a whole session because a `withTimeout` copy left its `setTimeout` running after
 *  the raced promise had already settled, and the stale timer's rejection surfaced later against
 *  unrelated work. `withTimeout` below clears its timer the instant the race is decided, on every
 *  path — settle-in-time, reject-in-time, and timeout.
 *
 *  This is L0 (`runtime/core/`) — no imports, ships in every build, and depends on nothing else in
 *  the engine. */

/** Thrown when `p` does not settle within `ms`.
 *
 *  ⚠️ The message wording — `"<what> timed out after <ms>ms (<hint>)"` — is not arbitrary. Two of
 *  the six migrated sites had that exact phrasing already, and one of them (`handleEval`) returns
 *  it verbatim to an agent through `modoki_eval` / `device_eval`, with eight tests pinning the
 *  string. Choosing this format kept that surface byte-identical; the alternative changed an
 *  agent-facing message to no benefit. Only `canvas2DPool`'s console warning moved, and nothing
 *  asserts on it. */
export class TimeoutError extends Error {
  /** The `what` passed to `withTimeout` — a human-readable name for the operation that timed
   *  out, for logs and error messages. */
  readonly what: string;
  /** The timeout, in ms, that was exceeded. */
  readonly ms: number;

  constructor(what: string, ms: number, hint?: string) {
    super(`${what} timed out after ${ms}ms${hint ? ` (${hint})` : ''}`);
    this.name = 'TimeoutError';
    this.what = what;
    this.ms = ms;
  }
}

/** The eventual outcome of a promise, without throwing — how a late settlement is reported to
 *  `onSettled` below, since by the time it arrives nothing is `await`ing it anymore. */
export type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/** What to do with `p`'s eventual result if it settles AFTER `withTimeout` has already rejected
 *  the caller with a {@link TimeoutError}. Exactly one of the three — see the file header for what
 *  each means and why the choice is required rather than defaulted. */
export type Abandonment<T> =
  | { readonly adopt: string }
  | { readonly discard: string }
  | { readonly onSettled: (result: Settled<T>) => void };

/** Race `p` against `ms`. On time, the returned promise settles exactly as `p` did. Past `ms`, it
 *  rejects with a {@link TimeoutError} and `p` is abandoned per `abandonment` — see the file
 *  header. `p`'s eventual settlement is always observed internally, so a late rejection can never
 *  surface as an unhandled promise rejection regardless of which `abandonment` was chosen.
 *
 *  @param p Something that does not itself support cancellation.
 *  @param ms The deadline, in ms.
 *  @param what A human-readable name for `p`, used in the `TimeoutError` message.
 *  @param abandonment What to do with `p` if it settles after the deadline.
 *  @param hint Optional extra context appended to the `TimeoutError` message. */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  what: string,
  abandonment: Abandonment<T>,
  hint?: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  // Set by the timer callback ONLY — this is how a late settlement is told apart from an on-time
  // one, rather than inferring it from handler-attachment order (which the race below would get
  // wrong, since `p.then` below is attached before `Promise.race`'s own internal one).
  let timedOut = false;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new TimeoutError(what, ms, hint));
    }, ms);
  });

  // Always observe `p`'s eventual settlement, independent of the race outcome. This is what
  // guarantees `p`'s rejection is never unhandled, and it is how a settlement that arrives AFTER
  // the timeout reaches `onSettled`.
  p.then(
    (value) => {
      if (!timedOut) return; // delivered on time, through the race below — nothing more to do.
      if ('onSettled' in abandonment) {
        try {
          abandonment.onSettled({ ok: true, value });
        } catch (err) {
          console.error(`[withTimeout] onSettled threw for a late settlement of "${what}"`, err);
        }
      }
    },
    (error) => {
      if (!timedOut) return; // delivered on time, through the race below — nothing more to do.
      if ('onSettled' in abandonment) {
        try {
          abandonment.onSettled({ ok: false, error });
        } catch (err) {
          console.error(`[withTimeout] onSettled threw for a late settlement of "${what}"`, err);
        }
      }
    },
  );

  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
