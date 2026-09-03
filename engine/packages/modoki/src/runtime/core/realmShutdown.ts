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

/** One registered task, keyed by its own disposer identity rather than by `name` — two subsystems
 *  may legitimately register the same name, and each disposer must remove only its own
 *  registration. Same reasoning as `registerReloadBlocker` beside this file. */
interface ShutdownTask {
  name: string;
  run: () => void | Promise<void>;
}

const tasks = new Set<ShutdownTask>();

/** Register a task to run once, when the realm is about to die (a reload, in practice). Returns a
 *  disposer; call it if the registering subsystem tears itself down before shutdown ever fires. */
export function registerRealmShutdownTask(name: string, run: () => void | Promise<void>): () => void {
  const entry: ShutdownTask = { name, run };
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

  ranPromise = (async () => {
    const runs = Array.from(tasks).map(async (task) => {
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

/** Re-arm the seam after a reload that DID NOT actually destroy the realm — `resumeReload.ts`'s
 *  recovery path, when `deps.reload()` throws or rejects, is the only production caller.
 *
 *  What this DOES: clears the `ranPromise` latch, so a LATER `runRealmShutdownTasks()` call in
 *  this same realm runs every still-registered task again instead of returning the earlier,
 *  already-resolved promise.
 *
 *  What this does NOT do: it cannot un-destroy whatever the tasks already tore down. Shutdown
 *  tasks are meant to be safe to run twice for exactly this reason (see `registerRealmShutdownTask`
 *  and #587's ad-SDK teardown), but that is a property of each TASK, not something this function
 *  grants. Calling this is a claim that the realm survived, not that the first run was undone. */
export function notifyRealmSurvived(): void {
  ranPromise = null;
}

/** Test seam. Not exported from the package index — production has no teardown for this. */
export function __resetRealmShutdownForTest(): void {
  tasks.clear();
  ranPromise = null;
}
