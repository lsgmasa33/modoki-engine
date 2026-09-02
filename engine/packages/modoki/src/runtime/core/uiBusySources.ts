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

import { rawNow } from './clock';

/** One registered predicate, keyed by its own disposer identity (not by `name` — two sources can
 *  legitimately share a name, e.g. two managers both calling this "account"; each disposer must
 *  remove only ITS OWN registration, matching `pointerBlockers.ts`'s refcount reasoning for the
 *  same shape of problem). */
interface BusySource {
  name: string;
  isBusy: () => boolean;
  // Dedups the throwing-predicate log below: set on a throw, cleared on the next successful
  // call. Since #551 this predicate is polled every FRAME rather than once per discrete
  // activation, so an un-deduped `console.error` on a persistently-throwing predicate would
  // flood the console/device log at ~60Hz instead of firing once per tap.
  erroredSinceRecovery: boolean;
}

const sources = new Set<BusySource>();

/** Register a predicate. Since #551 it is called every FRAME (via `pollUIBusyContinuity`, wired
 *  into the pipeline at `SYSTEM_PRIORITY.GAME`), not just at a discrete UI activation — so keep
 *  the implementation cheap (a flag/field read), never expensive per-call work. Returns a
 *  disposer; call it on manager teardown. Registering the same `name` twice is two INDEPENDENT
 *  registrations — each disposer removes only the one it was returned from, so disposing one
 *  leaves the other (and its predicate) in effect, same as `registerPointerBlocker`. */
export function registerUIBusySource(name: string, isBusy: () => boolean): () => void {
  const entry: BusySource = { name, isBusy, erroredSinceRecovery: false };
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
 *  every button in the game from ever unlocking. Logged once PER THROW STREAK, not once per
 *  call: since #551 this runs every frame (via `pollUIBusyContinuity`), so an un-deduped log on a
 *  persistently-throwing predicate would flood at ~60Hz — `erroredSinceRecovery` dedups it, and
 *  resets (silently) the moment the predicate stops throwing, so a later throw logs again. */
export function getActiveUIBusySources(): string[] {
  const active: string[] = [];
  for (const source of sources) {
    let busy: boolean;
    try {
      busy = source.isBusy();
      source.erroredSinceRecovery = false;
    } catch (err) {
      if (!source.erroredSinceRecovery) {
        source.erroredSinceRecovery = true;
        console.error(`[UI busy source] '${source.name}' predicate threw — treating as not busy:`, err);
      }
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

let busyAccumulatedMs = 0;
let busyLastPollAt: number | null = null;
let busyWarned = false;

// A gap this large between two polls means the pipeline didn't actually tick across it (editor
// Pause, a backgrounded tab, a long synchronous stall) — not that busy was genuinely observed
// for that whole span. Treating it as observed would credit an unwatched stretch in full and
// force-release a still-in-flight operation on the very next poll after resume, reintroducing
// #530. Mirrors timeSystem.ts's MAX_DELTA clamp for the same class of problem (GC pauses / tab
// throttle), but for the busy valve rather than sim dt: a genuine multi-second stall this
// crosses restarts as a fresh (still-protected) episode instead of being credited toward
// force-release.
//
// 2000ms, not a tighter value: an ordinary heavy SYNCHRONOUS stall that's part of normal
// gameplay on a low-end device (shader compile, a scene/GLB load, a big JSON parse — the exact
// class of thing the paragraph above names) can run for hundreds of ms without the pipeline
// getting a chance to poll in between; a threshold much below a second risks treating that
// legitimate stall as an unwatched gap and wiping the accumulator on every poll, so a genuine
// stuck-busy episode during the stall could NEVER cross `lockWindow.maxMs` and force-release —
// input stays bricked for the whole stall, the exact severe failure this valve exists to
// prevent. 2000ms stays comfortably above that while remaining far tighter than a real
// pause/backgrounded-tab gap (seconds to indefinite) — the case this clamp is actually meant to
// catch.
export const MAX_POLL_GAP_MS = 2000;

/** Runs every frame via a registered system (SYSTEM_PRIORITY.GAME, see app/ecs/pipeline.ts).
 *  Continuity is OBSERVED here — this call and the previous call are USUALLY adjacent frames, so
 *  the delta between them is normally credited in full. But the pipeline does not always tick:
 *  editor Pause, a backgrounded tab (rAF halts), or a long synchronous stall (scene load, shader
 *  compile) can all leave a real gap between two polls with nothing observed across it. A gap
 *  over `MAX_POLL_GAP_MS` is clamped to a fresh episode (credit zero for the gap) instead of
 *  being credited in full — see `MAX_POLL_GAP_MS` above for why. */
export function pollUIBusyContinuity(): void {
  const now = rawNow();
  const active = getActiveUIBusySources().length > 0;
  if (active) {
    const gap = busyLastPollAt === null ? 0 : now - busyLastPollAt;
    if (gap > MAX_POLL_GAP_MS) {
      busyAccumulatedMs = 0; // the gap wasn't watched — start a fresh episode, credit nothing
      busyWarned = false; // and the episode is fresh, so a later force-release should warn again
    } else {
      busyAccumulatedMs += gap;
    }
  } else {
    busyAccumulatedMs = 0;
    busyWarned = false;
  }
  busyLastPollAt = now;
}

export function getBusyAccumulatedMs(): number { return busyAccumulatedMs; }
export function isBusyWarned(): boolean { return busyWarned; }
export function markBusyWarned(): void { busyWarned = true; }

/** Reset on world swap — mirrors the reset onWorldSwap already does in bindings.ts. */
export function resetBusyContinuity(): void {
  busyAccumulatedMs = 0;
  busyLastPollAt = null;
  busyWarned = false;
}
