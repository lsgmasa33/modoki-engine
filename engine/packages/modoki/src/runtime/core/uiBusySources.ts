/** UI-busy-source registry — lets a GAME tell the global UI input lock (`runtime/ui/bindings.ts`,
 *  #466) that a discrete activation must stay blocked while some ASYNCHRONOUS state it owns is in
 *  flight, without the game's handlers having to return a promise.
 *
 *  #466's real completion gate works by duck-typing a `call` binding's return value
 *  (`trackLockPromise`): only a thenable holds the lock open. Every Court UI action is
 *  `registerUIAction(name, () => fireTap(target))`, and `fireTap` returns `void` — so that gate is
 *  silently dead for Court, and only the time floor does anything. Rewriting every handler to
 *  return a promise was rejected (#530) as the option that goes stale the moment a new handler is
 *  added and forgets to.
 *
 *  So instead: the engine ASKS, the game does not TELL. A game registers a PREDICATE once, at
 *  manager init, and the lock evaluates it at activation time — there is no per-operation pairing,
 *  so there is nothing to leak. This is a deliberate rejection of a push/pop `beginUIBusy()`/
 *  `endUIBusy()` pair: Court's `beginSignIn` is a bare fire-and-forget async IIFE with no
 *  try/catch/finally, so a throw between `begin` and `end` would leak an open scope and brick
 *  every button in the game until a much longer watchdog (Court's is 60s) finally fires.
 *
 *  Lives in `core/` (L0) rather than `input/` or `ui/` (both L2), same reasoning as
 *  `pointerBlockers.ts` beside it: `runtime/ui/bindings.ts` must consult this, a game's own
 *  manager must register into it, and there is no `ui → input`-shaped zone edge
 *  (`eslint.config.js`'s `L2_ALLOWED`) that would let one reach the other directly. */

/** One registered predicate, keyed by its own disposer identity (not by `name` — two sources can
 *  legitimately share a name, e.g. two managers both calling this "account"; each disposer must
 *  remove only ITS OWN registration, matching `pointerBlockers.ts`'s refcount reasoning for the
 *  same shape of problem). */
interface BusySource {
  name: string;
  isBusy: () => boolean;
}

const sources = new Set<BusySource>();

/** Register a predicate the input lock consults on every discrete activation. Returns a disposer;
 *  call it on manager teardown. Registering the same `name` twice is two INDEPENDENT
 *  registrations — each disposer removes only the one it was returned from, so disposing one
 *  leaves the other (and its predicate) in effect, same as `registerPointerBlocker`. */
export function registerUIBusySource(name: string, isBusy: () => boolean): () => void {
  const entry: BusySource = { name, isBusy };
  sources.add(entry);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    sources.delete(entry);
  };
}

/** The names of every registered source whose predicate currently reads busy. Named, not just a
 *  boolean, because the lock's existing max-ms warning NAMES what is pending — this feeds that
 *  same diagnostic rather than a bare "something is busy".
 *
 *  ⚠️ A throwing predicate must not take the whole input system down with it — a game's busy
 *  check can reach arbitrary game state, and one bad read should degrade to "not busy", not stop
 *  every button in the game from ever unlocking. Logged once per throwing call (not deduped) so a
 *  broken predicate is visible immediately rather than silently starving input forever. */
export function getActiveUIBusySources(): string[] {
  const active: string[] = [];
  for (const source of sources) {
    let busy: boolean;
    try {
      busy = source.isBusy();
    } catch (err) {
      console.error(`[UI busy source] '${source.name}' predicate threw — treating as not busy:`, err);
      continue;
    }
    if (busy) active.push(source.name);
  }
  return active;
}

// Deliberately NOT cleared on `onWorldSwap` — a game-scoped manager (Court's account/store state)
// legitimately survives an in-game scene swap, and clearing here would silently drop its
// registration out from under it with nothing to re-register it. Registrations are owned by
// their disposer alone (a manager's own `dispose()`), same lifetime contract as
// `registerPointerBlocker`. The tradeoff — a manager that forgets to dispose leaks a
// registration — is accepted: `isInputLockActive`'s own safety valve (mirroring `inputLockMaxMs`)
// is the backstop for a predicate stuck busy, whatever the reason.

/** Test/teardown escape hatch — drop every registration without calling disposers. */
export function clearUIBusySources(): void {
  sources.clear();
}
