/** Fire a subscriber set so that one bad subscriber cannot take out the publisher.
 *
 *  The engine has ~75 hand-rolled callback fan-outs. Eight of them already wrapped each callback in
 *  its own `try`, each with its own comment arguing the same point in different words:
 *
 *  > *"A listener must never break registration — the game's services are the point, the
 *  > notification is a courtesy."* (`appServices.ts`)
 *  > *"an observer must not be able to break the simulation, and it must not be able to starve the
 *  > observers after it either."* (`materialDirty.ts`)
 *  > *"one bad subscriber must not stop the others"* (`hitRegions.ts`)
 *
 *  This file is that convention extracted once, so those eight copies stop being eight copies.
 *
 *  ⚠️ **The migration is NOT complete, and this docblock said it was.** #888 migrated **36 call sites**; **46** remain
 *  hand-rolled (41 inside the guard's SCAN_DIRS, 5 outside), pinned row-by-row in
 *  `engine/tests/architecture/notifyIsShared.test.ts` and tracked as **#953**. A further 4 are
 *  permanently EXEMPT there — queries that read a value back out of each callback, which a
 *  "call them all, return nothing" helper cannot express. The original census said "23 sites" because its
 *  detector keyed on the variable names `listeners`/`subs`/`cbs` — a claim about how every author
 *  in this repo spells things, and a false one. If you are adding a caller: you are joining a
 *  convention that is most of the way in, not one that is finished.
 *
 *  **The reason it matters is the ORDER, not the tidiness.** Every one of those loops mutates its
 *  own state *before* it notifies — `_currentWorld = next`, `_version += 1`, `waiters.delete(key)`.
 *  So an escaping listener error does three things at once, and only the first is obvious:
 *
 *  1. the publisher's mutation is already **committed** and cannot be rolled back;
 *  2. every listener after the thrower in `Set` iteration order is **permanently starved** — the
 *     loop is not resumable and nothing retries it;
 *  3. the throw propagates into the publisher's **caller**, whose tail then does not run. In
 *     `setCurrentWorld`'s case that tail is what transfers world ownership, so `SceneManager` was
 *     left releasing the live scene's resources and destroying the world it had just promoted.
 *
 *  ## Teardown fan-outs count too
 *
 *  The name says "listeners", but the mechanism is *call every function in this set, isolating
 *  each*, and a **teardown** fan-out is the same shape with the same failure: `TimeManager.dispose`
 *  looped its unsubscribes bare, so one throwing entry skipped `this.unsubs = []`, every
 *  `unregisterReadSource` after it and `anchors.clear()` — a single bad unsub left the manager
 *  half-disposed. Use this for a disposer set as readily as for a subscriber set; the `label` is
 *  where you say which (`'TimeManager:dispose'`).
 *
 *  This is L0 (`runtime/core/`) — no imports, ships in every build, and depends on nothing else in
 *  the engine.
 *
 *  ## The reporting policy, and why it is here rather than at each site
 *
 *  A swallowed error that says nothing is how a dead listener stays dead for months, so the
 *  default reports through `console.error`. That is deliberately NOT free: `globalErrors.ts` wraps
 *  `console.error` and files a non-fatal Crashlytics issue. It is the right cost — a listener that
 *  throws is a real defect, not noise — and the flood case is already owned there (a per-message
 *  dedupe plus a burst ceiling), which is why this file does not grow a second rate limiter of its
 *  own to drift against it.
 *
 *  Two callers must NOT take that default, and they are the reason `report` is a parameter rather
 *  than this file carrying an exemption list: `consoleRing` and `consoleCapture` fire their
 *  subscribers from inside the console patch itself, so a `console.error` here would re-enter the
 *  thing that is mid-flush *and* spend a Crashlytics issue on internal bookkeeping. Both pass
 *  `unpatchedLog`. Their own docblocks carry the full argument. */

/** Fire every listener in `listeners`, isolating each one.
 *
 *  @param listeners the subscriber set. Iterated once; a listener added or removed *during* the
 *    loop follows `Set` semantics exactly as it did before this helper existed.
 *  @param label appears in the report, so it must name the publisher (`'worldRegistry'`), not the
 *    event.
 *  @param args the tuple handed to each listener. Pass `[]` for a bare `() => void` set.
 *  @param report overrides the default `console.error`. Only for a publisher that cannot reach
 *    `console` safely — see the module docblock. */
export function notifyListeners<A extends readonly unknown[]>(
  listeners: Iterable<(...args: [...A]) => void>,
  label: string,
  args: [...A],
  report: (label: string, err: unknown) => void = defaultReport,
): void {
  for (const fn of listeners) {
    try {
      fn(...args);
    } catch (err) {
      // The report itself is inside the loop's isolation, not outside it: a `report` that throws
      // would otherwise reintroduce the exact defect this helper exists to remove, and it is a
      // caller-supplied function.
      try { report(label, err); } catch { /* nothing left to report it to */ }
    }
  }
}

function defaultReport(label: string, err: unknown): void {
  console.error(`[${label}] a listener threw — the remaining listeners still ran`, err);
}
