/** The `pagehide` backstop's decision core (#611) — extracted so it can carry a unit test, the same
 *  precedent as `createResumeReloadHandler` in
 *  `engine/packages/modoki/src/runtime/core/resumeReload.ts` ("the decision, with every dependency
 *  injected"). It must stay a plain `.ts` module, not `.tsx` — same house rule as that file and as
 *  `docs/editor.md`'s "editor `.ts` logic carries tests; editor `.tsx` does not".
 *
 *  WHY this exists: `App.tsx` installs a `pagehide` listener as a backstop for `#587`'s realm
 *  shutdown tasks (native ad SDK teardown before a reload). `event.persisted === false` is supposed
 *  to mean "the page is actually going away, not just backgrounding into the bfcache" — but that
 *  gate was validated by an ANDROID measurement only, and `pagehide` firing on a mere backgrounding
 *  is documented real-world behaviour on iOS. If it fires there, calling shutdown is a FALSE ALARM:
 *  `app.cleanup`'s `ads.cleanup()` runs with nothing left to call `ads.init()` again, so ads stay
 *  dead for the rest of the run.
 *
 *  The ruling (#611): do NOT try to guess iOS's semantics with a narrower trigger gate — a narrower
 *  gate risks the opposite failure, suppressing a GENUINE teardown, which is worse (a leaked native
 *  SDK is invisible; a missed reload is not). Instead, keep the trigger and make a false positive
 *  SELF-HEALING: if the page becomes visible again after we ran shutdown, that is positive proof the
 *  realm survived, so we call `notifyRealmSurvived()` to re-arm the latch and let each shutdown
 *  task's own `onRealmSurvived` recovery undo whatever needs undoing (see `realmShutdown.ts`).
 *  A recoverable false positive beats a silent false negative.
 */

export interface RealmDeathBackstopDeps {
  /** Usually `() => { void runRealmShutdownTasks(); }`. */
  runShutdown: () => void;
  /** Usually `notifyRealmSurvived` from `@modoki/engine/runtime`. */
  notifySurvived: () => void;
}

export interface RealmDeathBackstop {
  /** Call on every `pagehide`. `persisted === false` is the ambiguous "realm may be dying" signal
   *  — see the header for why it is ambiguous on iOS. `persisted === true` means the page went into
   *  the bfcache and may resume, which is never a death signal on any platform. */
  onPageHide(persisted: boolean): void;
  /** Call when the document becomes visible/showing again (`visibilitychange` → visible, or
   *  `pageshow`) — positive proof the realm did NOT die. Only recovers when THIS backstop
   *  previously triggered a shutdown; an ordinary foreground transition must never re-arm the
   *  seam, since that would spuriously recover a shutdown some OTHER caller ran deliberately
   *  (e.g. a real reload elsewhere in the same tick). */
  onRealmVisible(): void;
}

/** The decision, with every dependency injected — no `document`, no Capacitor, no real
 *  `runRealmShutdownTasks()` — so it is testable with plain spies. */
export function createRealmDeathBackstop(deps: RealmDeathBackstopDeps): RealmDeathBackstop {
  // Per-EPISODE, not once-ever: a survived false alarm must not disarm the backstop for the rest
  // of the realm's life. The next `onPageHide(false)` starts a fresh episode and, if IT also turns
  // out to be a false alarm, recovers again.
  let weTriggeredShutdown = false;

  return {
    onPageHide(persisted: boolean): void {
      // Strict `!== false` is deliberate, matching the pre-#611 gate exactly: only an EXPLICIT
      // `false` proceeds. A `pagehide` dispatched as a plain `Event` (not a `PageTransitionEvent`)
      // carries `persisted: undefined`, and a truthiness check (`if (persisted) return;`) would
      // treat that as "not persisted" and run shutdown where the gate previously did not — widening
      // what triggers a shutdown, which #611's ruling was explicit the trigger gate must not do.
      if (persisted !== false) return; // bfcache/background/ambiguous — not a confirmed death signal
      weTriggeredShutdown = true;
      deps.runShutdown();
    },

    onRealmVisible(): void {
      if (!weTriggeredShutdown) return; // an ordinary foreground must never re-arm the seam
      weTriggeredShutdown = false;
      deps.notifySurvived();
    },
  };
}
