/** Realm shutdown tasks (#587) — the seam that lets a reload destroy native SDK state before it
 *  destroys the JS realm, instead of racing it.
 *
 *  `docs/managers-and-systems.md`'s "every end-of-lifetime is a REALM DEATH" ruling (#534, carried
 *  forward by `resumeReload.ts` beside this file) means `App.tsx`'s unmount-cleanup effect
 *  EFFECTIVELY NEVER RUNS — there is no unmount commit on the reload path, only a page tear-down.
 *  So a native ad SDK (AppLovin MAX banner/MREC/interstitial) that is only torn down on unmount
 *  survives every reload with no JS listener left attached to it: it keeps refreshing and
 *  monetising in the native view hierarchy, invisibly under-counting `ad_revenue`.
 *
 *  The reload itself is dispatched from two places that cannot reach `appServices()`:
 *  `engine.reload` (`runtime/actions/engineActions.ts`) is an L0/L-layer UIAction, and
 *  `useResumeReload.ts`'s `reload` dep is injected from the same layer. `runtime/**` may not
 *  import from `engine/app/**` (the layering the L0→L3 contract enforces), so neither call site can
 *  call `appServices().ads?.cleanup()` directly. This file is the registry that closes the gap: the
 *  APP registers a shutdown task where it already knows about `appServices()`
 *  (`engine/app/App.tsx`), and the RUNTIME only ever needs to invoke the registry by name — same
 *  shape as `registerReloadBlocker`, for the same layering reason.
 *
 *  ⚠️ Nothing here reads a clock or randomness — this file is subject to the determinism guard
 *  (`determinismGuard.test.ts`) like everything else in `runtime/**`. The 250ms bound below uses
 *  `setTimeout`, which is not a clock read.
 */

import { createSupersessionToken } from './liveness';

/** One registered task, keyed by its own disposer identity rather than by `name` — two subsystems
 *  may legitimately register the same name, and each disposer must remove only its own
 *  registration. Same reasoning as `registerReloadBlocker` beside this file.
 *
 *  `onRealmSurvived` (#611) is the inverse of `run`: optional, because most tasks tear down state
 *  that is fine to leave torn down (a promise/latch that nothing re-arms), and only some need to
 *  re-establish something after a FALSE ALARM — see `notifyRealmSurvived` below for when this
 *  fires. */
interface ShutdownTask {
  name: string;
  run: () => void | Promise<void>;
  onRealmSurvived?: () => void | Promise<void>;
}

const tasks = new Set<ShutdownTask>();

/** Register a task to run once, when the realm is about to die (a reload, in practice). Returns a
 *  disposer; call it if the registering subsystem tears itself down before shutdown ever fires.
 *
 *  `options.onRealmSurvived` (#611) registers the recovery for a FALSE ALARM — the realm was
 *  believed to be dying (this task's `run` fired) but did not actually die. See
 *  `notifyRealmSurvived` for exactly when and how it runs. Omit it when `run`'s teardown needs no
 *  recovery (nothing else re-establishes it, or the next natural use rebuilds it lazily). */
export function registerRealmShutdownTask(
  name: string,
  run: () => void | Promise<void>,
  options?: { onRealmSurvived?: () => void | Promise<void> },
): () => void {
  const entry: ShutdownTask = { name, run, onRealmSurvived: options?.onRealmSurvived };
  tasks.add(entry);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    tasks.delete(entry);
  };
}

/** Once-per-realm latch. A reload site calls `runRealmShutdownTasks()` and then tears the realm
 *  down (`window.location.reload()`); a second caller in the same realm (e.g. a `pagehide` firing
 *  after `engine.reload` already ran) must not re-run every task a second time. */
let ranPromise: Promise<void> | null = null;

/** The tasks that actually ran on the CURRENT `ranPromise`, snapshotted at the moment the run
 *  started (#611). `notifyRealmSurvived()` recovers exactly this set, never the live `tasks`
 *  registry — a task registered AFTER the run started never had its `run` fire, so recovering it
 *  would call `onRealmSurvived` without a matching teardown to undo. */
let ranTasks: ShutdownTask[] = [];

/** Supersession token for the run (#611) — `begin()`d by every `runRealmShutdownTasks()` call that
 *  actually starts a new run (the once-per-realm latch guard above returns early otherwise).
 *  `notifyRealmSurvived()` captures the predicate its recovery belongs to, so if a NEWER run starts
 *  before the recovery's captured `ran` promise settles, the recovery can tell it has been
 *  superseded and bail instead of re-establishing what the newer run just tore down.
 *
 *  ⚠️ **`createSupersessionToken` rather than a hand-rolled counter, and that is enforced** —
 *  `livenessTokenIsShared.test.ts` (#573) fails the build on any `let generation = 0` that gets
 *  captured into a local and compared against itself, because this repo had several such counters
 *  and they disagreed. Close-out review of #611 wrote exactly that hand-rolled counter here and the
 *  guard caught it; "bumps on START" is the right half of the pair, since a newer RUN is what must
 *  win. See `docs/async-lifetime.md`.
 *
 *  Unreachable while every registered `run` is synchronous, which is every task shipped today — the
 *  registry has exactly one entry (`app.cleanup`). It becomes reachable the moment any `run` is
 *  genuinely async, which `games/court/packages/app-services/src/cloudSave.ts` explicitly invites a
 *  future author to add. */
const runToken = createSupersessionToken();

/** Whether the run that `notifyRealmSurvived()` would recover from is still the current one. Null
 *  until the first run begins. */
let runIsCurrent: (() => boolean) | null = null;

/** The bound on the whole run, not per task — a single hung native call must not add up across
 *  several tasks and stall the reload further than one timeout's worth. The reload matters more
 *  than the cleanup: losing the last few frames of ad-SDK teardown is a rounding error, a reload
 *  that never happens is not. */
const SHUTDOWN_TIMEOUT_MS = 250;

/** Run every registered task, once per realm. Never throws or rejects — a task that throws
 *  synchronously or returns a rejecting promise is caught and logged via `console.warn`, and the
 *  remaining tasks still run. Bounded by `Promise.race` against a timeout so a hung native bridge
 *  call cannot block the reload that is waiting on this. */
export function runRealmShutdownTasks(): Promise<void> {
  if (ranPromise) return ranPromise;

  // This run supersedes whatever `notifyRealmSurvived()` may still be waiting to recover from an
  // earlier one — see `runToken`'s own comment.
  runIsCurrent = runToken.begin();

  // Snapshot BEFORE the async body starts, not inside it — `notifyRealmSurvived()` (#611) needs
  // the exact set that is about to run, and a task registered while this run is already in flight
  // (unusual, but not impossible for an async `run`) must not silently join `ranTasks` after the
  // fact.
  ranTasks = Array.from(tasks);

  ranPromise = (async () => {
    const runs = ranTasks.map(async (task) => {
      try {
        await task.run();
      } catch (err) {
        console.warn(`[realm-shutdown] task '${task.name}' failed — continuing:`, err);
      }
    });

    const all = Promise.all(runs).then(() => undefined);
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
    });
    await Promise.race([all, timeout]);
  })();

  return ranPromise;
}

/**
 * Run every shutdown task, then tear the realm down with `reload` — **the seam a reload site
 * should use**, rather than composing `runRealmShutdownTasks()` and `reload()` by hand.
 *
 * ⚠️ It exists because composing it by hand is easy to get subtly wrong, and two of the three
 * shipped call sites HAD it wrong: `void runRealmShutdownTasks().finally(() => reload())` spends
 * the once-per-realm latch, and if `reload()` throws, the tasks have run, the latch is spent, and
 * the realm is still alive — so a LATER reload in that realm skips teardown entirely and silently.
 * Only `resumeReload.ts` re-armed. Found in close-out review of #587.
 *
 * Putting the recovery here rather than at each call site means a new reload site cannot
 * reintroduce the bug by forgetting a `.catch` — there is nothing left for it to forget.
 *
 * ⚠️ **It recovers the THROWING route only, and that is a real limit — do not read it as total.**
 * `window.location.reload()` returns synchronously and the microtask queue drains long before the
 * navigation tears the realm down, so this promise RESOLVES on the normal path rather than hanging
 * (measured; an earlier version of this comment claimed the opposite). A reload that silently does
 * nothing — a `beforeunload` cancel, a WebView that swallows the navigation — therefore resolves
 * cleanly, `notifyRealmSurvived()` never runs, and the latch stays spent with the realm alive.
 * `resumeReload.ts`'s `reloading` flag has the same shape and the same gap. Nothing covers that
 * case today; closing it would need a positive signal that the navigation actually started, which
 * is a bigger change than this seam. On the throwing route it re-arms and rejects, so the caller
 * still sees the error (an unhandled rejection here is a genuine signal: a reload that did not
 * happen).
 */
export function shutdownRealmThenReload(reload: () => void): Promise<void> {
  return runRealmShutdownTasks()
    .finally(reload)
    .catch((err: unknown) => {
      // `runRealmShutdownTasks()` never rejects (it catches every task), so a rejection here can
      // only have come from `reload()` itself — i.e. the realm is still alive with a spent latch.
      notifyRealmSurvived();
      throw err;
    });
}

/** Re-arm the seam after a reload that DID NOT actually destroy the realm.
 *
 *  Production callers: `resumeReload.ts`'s recovery path when `deps.reload()` throws or rejects,
 *  and `shutdownRealmThenReload()`'s `.catch` above for the same reason. #611 adds a THIRD: the
 *  `pagehide` backstop in `engine/app/useBackgroundFlush.ts` fires on `event.persisted === false`, which is an ANDROID
 *  measurement (#587) shipped on iOS where `pagehide` firing on a mere backgrounding is a
 *  documented real behaviour — so this call is now sometimes a genuine false alarm rather than
 *  only a failed `reload()`. `realmDeathBackstop.ts` is what decides WHEN to call it for that case;
 *  this function only defines what happens once it is called.
 *
 *  What this DOES, synchronously and unconditionally:
 *  - clears the `ranPromise` latch, so a LATER `runRealmShutdownTasks()` call in this same realm
 *    runs every still-registered task again instead of returning the earlier, already-resolved
 *    promise;
 *  - clears `ranTasks` alongside it, for the same reason.
 *
 *  What this DOES, asynchronously, if there WAS a prior run (#611): each captured task MAY register
 *  its own `onRealmSurvived` recovery (`registerRealmShutdownTask`'s third argument), and this is
 *  what runs them. This replaces the old, more absolute claim that used to live here — "it cannot
 *  un-destroy whatever the tasks already tore down" was only ever half true, because a task can
 *  always choose to make its OWN teardown recoverable; this function just provides the trigger.
 *  Recovery is opt-in per task, but ⚠️ **opting out is a CLAIM, not a default** — and the one
 *  example that used to sit here was wrong. This comment cited audio as needing nothing, "the graph
 *  rebuilds lazily on next use"; that is true of the GRAPH and false of PLAYBACK, because
 *  `audioDispose()` leaves every handle `ended` and `audioSystem`'s `autoplayed` guard then blocks
 *  autoplay from ever re-declaring intent — an authored `loop + autoplay` music source was silent
 *  for the rest of the session. It now registers a real recovery (`rearmAudioAutoplay`, see
 *  `App.tsx`). Before omitting `onRealmSurvived`, trace what `run` actually leaves behind rather
 *  than what it looks like it leaves behind.
 *
 *  The recovery chain is deliberately hung off the CAPTURED shutdown promise (`ran`), not fired
 *  immediately, so a still-in-flight native destroy cannot race a re-init that assumes it already
 *  finished. ⚠️ This removes the COMMON race, not every race: `ran` resolves at the latest by the
 *  250ms `SHUTDOWN_TIMEOUT_MS` bound above, so a native teardown call that is still running past
 *  that bound can still overlap whatever a recovery does. Nothing here claims otherwise.
 *
 *  Each task's recovery runs in its own try/catch, logged via `console.warn` in the same style as
 *  the task-failure log above — one throwing recovery must not skip the rest. Only the tasks that
 *  ACTUALLY RAN (`ranTasks`, snapshotted by `runRealmShutdownTasks()`) are recovered; a task
 *  registered after the run never had its `run` fire and so gets no recovery call either.
 *
 *  Calling this with no prior run (`ran == null`) is a no-op beyond the (already-cleared) latch —
 *  there is nothing to recover. `notifyRealmSurvived()` itself stays synchronous and
 *  `void`-returning; no caller awaits it, so the recovery work is intentionally fire-and-forget from
 *  the caller's point of view.
 *
 *  ⚠️ Guarded against a NEWER run superseding this one (#611) — nothing stops a fresh
 *  `runRealmShutdownTasks()` call from starting while this recovery is still hung off the OLD `ran`
 *  promise (only reachable once a task's `run` is async, which none shipped when this file was
 *  written; `cloudSave.ts` invites a future one). Without the supersession check below, a
 *  superseded recovery would land AFTER the newer run's own teardown and re-establish exactly what
 *  it just tore down — #587's native-ads-left-alive defect, reintroduced via this file's own
 *  recovery path. */
export function notifyRealmSurvived(): void {
  const ran = ranPromise;
  const survived = ranTasks;
  const stillCurrent = runIsCurrent;
  ranPromise = null;
  ranTasks = [];

  if (!ran) return; // nothing ran yet in this realm; nothing to recover

  void ran.then(() => {
    // A newer run started before this one's recovery got to fire — it has already redone
    // whatever this would recover, so recovering now would undo the newer run's teardown.
    if (stillCurrent && !stillCurrent()) return;
    const recoveries = survived.map(async (task) => {
      if (!task.onRealmSurvived) return;
      try {
        await task.onRealmSurvived();
      } catch (err) {
        console.warn(`[realm-shutdown] recovery for '${task.name}' failed:`, err);
      }
    });
    return Promise.all(recoveries).then(() => undefined);
  });
}

/** Test seam. Not exported from the package index — production has no teardown for this. */
export function __resetRealmShutdownForTest(): void {
  tasks.clear();
  ranPromise = null;
  ranTasks = [];
  runIsCurrent = null;
}
