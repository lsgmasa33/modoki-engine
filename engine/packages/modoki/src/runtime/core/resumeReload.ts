/** Reload-on-resume (#574) — the mechanism for restarting the app after a long background.
 *
 *  The owner's ruling (2026-09-02) is that this app has no teardown path: mobile and web never
 *  quit, so the sanctioned way to reach a clean state is a FULL RELOAD, and reload is what serves
 *  AB tests, LiveOps and resuming after a long time away. `docs/managers-and-systems.md` carries
 *  the "every end-of-lifetime is a REALM DEATH" reasoning; this file is the trigger that ruling
 *  implies, which the tree did not have.
 *
 *  Three separable pieces live here because they are one mechanism, and splitting them across
 *  files would let a caller adopt the trigger without the guards:
 *
 *   1. `registerReloadBlocker` — "do not destroy the realm right now".
 *   2. `markResumeReload` / `consumeResumeReload` — a breadcrumb across the realm boundary.
 *   3. `createResumeReloadHandler` — the decision, with every dependency injected.
 *
 *  ⚠️ Nothing here reads a clock. `runtime/**` may not touch `Date.now()`/`performance.now()`
 *  outside `determinismGuard.test.ts`'s allowlist (capped at 3 entries), and this is the wrong
 *  reason to spend one — so `now` is injected. It must be a WALL clock, not a monotonic one: the
 *  question is "how much real time passed", and `performance.now()` is not guaranteed to advance
 *  while an iOS app is suspended. A user clock change just means a spurious reload, which is
 *  harmless; a monotonic clock that stops counting would mean the trigger never fires at all.
 */

import { createSupersessionToken } from './liveness';
import { notifyRealmSurvived } from './realmShutdown';

/** One registered blocker, keyed by its own disposer identity rather than by `name` — two
 *  subsystems may legitimately register the same name, and each disposer must remove only its
 *  own registration. Same reasoning as `uiBusySources.ts` and `pointerBlockers.ts` beside it. */
interface ReloadBlocker {
  name: string;
  isBlocked: () => boolean;
  /** Dedups the throwing-predicate log below: set on a throw, cleared on the next clean call. */
  erroredSinceRecovery: boolean;
}

const blockers = new Set<ReloadBlocker>();

/** Register a predicate that answers "is it unsafe to destroy the JS realm right now?".
 *
 *  ⚠️ This is deliberately NOT `registerUIBusySource` (`core/uiBusySources.ts`), even though the
 *  shape is identical, because the two answer different questions and FAIL IN OPPOSITE
 *  DIRECTIONS. A UI-busy source asks "should this button stay locked" — a wrong `true` bricks
 *  every button in the game, so a throwing predicate there degrades to "not busy". A reload
 *  blocker asks "would restarting now lose something" — a wrong `false` can strand a purchase or
 *  discard an unanswered dialog, while a wrong `true` costs nothing at all, because the next
 *  background/resume cycle re-evaluates from scratch. So a throwing predicate here counts as
 *  BLOCKED. Merging the two registries would force one of those two failure directions onto the
 *  other question.
 *
 *  The registries also disagree on membership in practice: Court's win screen blocks a reload
 *  (the stored session is deleted on solve, so a reload rebuilds an empty board) without being
 *  UI-busy in any sense.
 *
 *  Called only at a background/resume edge, not per frame, so a predicate here may be slightly
 *  more expensive than a UI-busy one — but keep it to a field read; it is still on a user-visible
 *  path. Returns a disposer; call it on teardown. */
export function registerReloadBlocker(name: string, isBlocked: () => boolean): () => void {
  const entry: ReloadBlocker = { name, isBlocked, erroredSinceRecovery: false };
  blockers.add(entry);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    blockers.delete(entry);
  };
}

/** The names of every registered blocker currently reading blocked. Named rather than a bare
 *  boolean so a refusal can say WHAT held it — a silent "we decided not to reload" is
 *  undiagnosable, and this trigger fires rarely enough that nobody would catch it in the act. */
export function getActiveReloadBlockers(): string[] {
  const active: string[] = [];
  for (const b of blockers) {
    let blocked: boolean;
    try {
      blocked = b.isBlocked();
      b.erroredSinceRecovery = false;
    } catch (err) {
      // Fail CLOSED — see the direction argument on `registerReloadBlocker`. A predicate that
      // cannot answer is not evidence that reloading is safe.
      blocked = true;
      if (!b.erroredSinceRecovery) {
        b.erroredSinceRecovery = true;
        console.error(`[reload blocker] '${b.name}' predicate threw — treating as BLOCKED:`, err);
      }
    }
    if (blocked) active.push(b.name);
  }
  return active;
}

/** Test seam. Not exported from the package index — production has no teardown for this. */
export function __clearReloadBlockersForTest(): void {
  blockers.clear();
}

// ---------------------------------------------------------------------------
// The breadcrumb across the realm boundary
// ---------------------------------------------------------------------------

const BREADCRUMB_KEY = 'modoki.resumeReload';

/** Why this exists: **the reload swallows the very resume that triggered it.**
 *
 *  Capacitor emits `appStateChange` with `retainUntilConsumed` false (`AppPlugin.java:40`), and
 *  `bridge.reset()` clears every JS listener at navigation START (`Bridge.java:570-575`,
 *  `CapacitorBridge.swift:295-298`). So the sequence is: OS foregrounds → event fires → our
 *  handler reloads → listeners wiped → the new realm registers fresh ones → and the event is
 *  gone, with nothing to re-emit it. Court's cloud-sync `'resume'` request
 *  (`cloudSyncWiring.ts`) is the casualty that matters: without this breadcrumb, sync sits idle
 *  after exactly the event that was supposed to refresh it, which would make the feature worse
 *  than not having it.
 *
 *  `App.getState()` cannot substitute — it reports "active now", which is equally true on a cold
 *  launch, so it cannot distinguish the two cases.
 *
 *  `sessionStorage` is the right lifetime here: it survives a same-origin reload and dies with
 *  the browsing context. ⚠️ It would be the WRONG tool for a native-SDK init guard, because iOS
 *  can recycle the WKWebView content process while the app process lives — clearing the storage
 *  while the native SDK stays initialised, i.e. failing towards a double init. Here the same
 *  clearing is harmless: we simply behave as a cold launch, which is correct. Same primitive,
 *  opposite failure tolerance; do not generalise one to the other. */
export function markResumeReload(awayMs: number): void {
  try {
    sessionStorage.setItem(BREADCRUMB_KEY, JSON.stringify({ awayMs }));
  } catch {
    // Private mode, disabled site data, or a context that throws on access. The reload still
    // happens; consumers just see a cold launch. Never let this stop the reload itself.
  }
}

/**
 * Read the breadcrumb WITHOUT removing it.
 *
 * The one-shot `consumeResumeReload()` below is the right default and stays the only way to
 * *handle* a resume. This exists for a reader that needs to know how long the app was away but
 * must NOT claim the resume — `globalErrors.ts` decides whether its persisted budgets belong to
 * the same native Crashlytics session, and consuming the breadcrumb there would steal it from the
 * real consumer. Peeking steps on nothing; a stale breadcrumb is impossible because the true
 * consumer still removes it.
 */
export function peekResumeReload(): { awayMs: number } | null {
  try {
    const raw = sessionStorage.getItem(BREADCRUMB_KEY);
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    const awayMs = (parsed as { awayMs?: unknown })?.awayMs;
    return typeof awayMs === 'number' && Number.isFinite(awayMs) ? { awayMs } : null;
  } catch {
    return null;
  }
}

/** Read and REMOVE the breadcrumb. One-shot by construction: two consumers must not both think
 *  they are the one handling the resume, and a breadcrumb left behind would make every
 *  subsequent navigation in this context look like a resume-reload. */
export function consumeResumeReload(): { awayMs: number } | null {
  try {
    const raw = sessionStorage.getItem(BREADCRUMB_KEY);
    if (raw == null) return null;
    sessionStorage.removeItem(BREADCRUMB_KEY);
    const parsed: unknown = JSON.parse(raw);
    const awayMs = (parsed as { awayMs?: unknown })?.awayMs;
    return { awayMs: typeof awayMs === 'number' && Number.isFinite(awayMs) ? awayMs : 0 };
  } catch {
    // Unreadable or unparseable: treat as absent. Try to clear it so a corrupt value does not
    // survive to be re-parsed on every future navigation.
    try { sessionStorage.removeItem(BREADCRUMB_KEY); } catch { /* nothing left to try */ }
    return null;
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface ResumeReloadDeps {
  /** WALL clock in ms — see the header. Injected so `runtime/**` stays clock-free. */
  now: () => number;
  /** Threshold in ms; `<= 0` disables the trigger. Read at DECISION time, not at registration,
   *  so a config edit takes effect without re-registering anything. */
  thresholdMs: () => number;
  /** Usually `getActiveReloadBlockers`. Injected so the decision can be tested in isolation. */
  blockedBy: () => string[];
  /** `PlayerPrefs.flush`. */
  flush: () => Promise<void>;
  /** `PlayerPrefs.pendingKeys`. ⚠️ This — not `flush()` resolving — is the durability gate.
   *  `drain()` catches every write error and re-queues it (`storage/playerPrefs.ts`), so the
   *  flush promise resolves whether or not anything landed. */
  pendingKeys: () => string[];
  /** `window.location.reload`, or an async wrapper that runs teardown before it (e.g.
   *  `runRealmShutdownTasks().finally(() => window.location.reload())`). Awaited by the caller so
   *  a throw from either the teardown chain or `reload()` itself still reaches the `catch` below —
   *  on a successful reload the returned promise never settles because the realm dies, which is
   *  fine and deliberate. */
  reload: () => void | Promise<void>;
  /** Usually `markResumeReload`. */
  markResumed: (awayMs: number) => void;
  log?: (msg: string) => void;
}

export interface ResumeReloadHandler {
  /** Call on every background edge (`appStateChange` inactive / `visibilitychange` hidden). */
  onBackground(): void;
  /** Call on every resume edge. Resolves once the decision is made; resolves WITHOUT reloading
   *  when the trigger declines. */
  onResume(): Promise<void>;
}

/** The decision, with every dependency injected so it is testable with no Capacitor mock, no
 *  jsdom visibility shims and no real clock — the `createPortLifecycleHandler` precedent in
 *  `engine/app/debug/bridge.ts`, which is why that one has a plain unit test and App.tsx's
 *  inline flush effect has none. */
export function createResumeReloadHandler(deps: ResumeReloadDeps): ResumeReloadHandler {
  const log = deps.log ?? ((m: string) => console.info(`[resume-reload] ${m}`));

  let backgroundedAt: number | null = null;
  /** Blockers sampled at BACKGROUND time, not just at resume.
   *
   *  ⚠️ Sampling only on resume is not enough, and this is the subtle one. The heuristic "away
   *  for N minutes" cannot by itself distinguish *the player put the game down* from *the app
   *  deliberately sent the player elsewhere and is waiting for them* — a rewarded video that
   *  opens the App Store, an OAuth sign-in bouncing through Safari, a bank step in a purchase
   *  flow. All of those background the app by design and can easily exceed the threshold. By the
   *  time we come back, the SDK may already have cleared its own in-flight flag, so a
   *  resume-time check sees nothing pending — and then its completion callback fires into a realm
   *  we just destroyed. Sampling at background time closes that, and needs no new state. */
  let blockedAtBackground: string[] = [];
  /** A reload is in flight (we called `reload()` and are waiting for the realm to die). Guards
   *  against a second resume edge arriving in that window and reloading twice. */
  let reloading = false;
  /** One-shot, so the armed-threshold line below appears once per realm rather than per edge. */
  let announced = false;
  /** Supersession over lifecycle edges. `createSupersessionToken` rather than a hand-rolled
   *  counter because `runtime/core/liveness.ts` is the ONE epoch implementation in the tree
   *  (#573) and `livenessTokenIsShared.test.ts` fails a sixth at authorship — which it duly did
   *  when this started life as a private `backgroundEpoch`.
   *
   *  Supersession rather than a teardown generation, and a token rather than comparing
   *  `backgroundedAt`: BOTH edges bump it, so an `onResume` that is still awaiting its flush goes
   *  stale the moment a newer background OR resume edge arrives. Timestamps cannot do this job —
   *  two edges can legitimately share one (ms resolution, or a manual clock in a test), and a
   *  token that can collide is not a token. */
  const liveness = createSupersessionToken();

  function forget(): void {
    backgroundedAt = null;
    blockedAtBackground = [];
  }

  return {
    onBackground(): void {
      if (reloading) return;
      // Announce the armed threshold on the FIRST background edge, not at mount.
      //
      // ⚠️ Measured on an S22 (2026-09-02): a mount-time log was INVISIBLE on device, because the
      // debug bridge installed its console capture from an async dynamic import
      // (`main.tsx`'s `import('./debug/bridge').then(...)`) that React's mount could beat.
      // #591 FIXED that mechanism — `main.tsx` now installs the capture eagerly
      // (`./installDeviceConsoleCapture`), re-verified on the same S22 — so a mount-time line
      // WOULD be captured today and this no longer has to be a background-edge log to be read.
      // It stays on the background edge anyway, deliberately: a background edge is long after
      // boot on every platform, which keeps this diagnostic readable without depending on the
      // engine's boot-order guarantees holding. Do not "restore" it to mount without re-measuring.
      if (!announced) {
        announced = true;
        log(`armed — will reload on a resume after ${Math.round(deps.thresholdMs() / 1000)}s away`);
      }
      liveness.begin(); // a newer edge supersedes any onResume still awaiting its flush
      backgroundedAt = deps.now();
      blockedAtBackground = deps.blockedBy();
    },

    async onResume(): Promise<void> {
      if (reloading) return;
      const at = backgroundedAt;
      const wasBlocked = blockedAtBackground;
      const stillLive = liveness.begin();

      // No recorded background: a cold launch's first foreground, or a resume we never saw the
      // matching background for. Nothing to measure against.
      if (at == null) return;

      const threshold = deps.thresholdMs();
      if (threshold <= 0) { forget(); return; } // trigger disabled for this project

      const awayMs = deps.now() - at;

      // A backwards clock (user changed the time, NTP stepped) yields a negative delta. Treat it
      // as "not stale" rather than reloading on a number we cannot interpret.
      if (awayMs < threshold) { forget(); return; }

      if (wasBlocked.length > 0) {
        log(`declined: ${wasBlocked.join(', ')} was in flight when we backgrounded`);
        forget();
        return;
      }

      const blockedNow = deps.blockedBy();
      if (blockedNow.length > 0) {
        log(`declined: ${blockedNow.join(', ')} in flight`);
        forget();
        return;
      }

      // Make pending writes durable BEFORE destroying the realm. `App.tsx` already flushes on
      // background, but a write can be made between that flush and this resume, and the reload
      // is what would destroy it.
      await deps.flush();

      // Re-check after the await — the repo's capture-before-await / re-check-after convention
      // (`docs/async-lifetime.md`). A purchase or sign-in can start while the flush is in
      // flight, and this is the last point at which declining is still free.
      if (reloading) return;

      // ⚠️ The app went BACKGROUND again while we were flushing, so this resume is stale: the
      // player is no longer looking at the app and `onBackground` has already recorded a fresh
      // timestamp that we captured neither of. Reloading now would fire into a hidden webview
      // and throw that new sample away. Bail; the next resume re-evaluates against it.
      if (!stillLive()) {
        log('declined: a newer background/resume edge superseded this one during the flush');
        return;
      }
      const blockedAfterFlush = deps.blockedBy();
      if (blockedAfterFlush.length > 0) {
        log(`declined: ${blockedAfterFlush.join(', ')} started during the flush`);
        forget();
        return;
      }

      const stillPending = deps.pendingKeys();
      if (stillPending.length > 0) {
        // The backend refused these and PlayerPrefs re-queued them for a later flush; reloading
        // now would discard them. Decline and let the next background/resume try again.
        log(`declined: ${stillPending.length} pref write(s) did not land (${stillPending.join(', ')})`);
        forget();
        return;
      }

      reloading = true;
      forget();
      log(`reloading after ${Math.round(awayMs / 1000)}s away`);
      deps.markResumed(awayMs);
      try {
        // Awaited, not fired and forgotten: `deps.reload()` can be an async wrapper that runs
        // teardown before the actual `window.location.reload()`, so a throw may arrive
        // asynchronously — from the shutdown-task chain or from `reload()` itself — well after
        // this call returns. Awaiting is what lets it still reach this `catch`. On a SUCCESSFUL
        // reload the awaited promise never settles because the realm dies mid-await, which is
        // fine and deliberate.
        await deps.reload();
      } catch (e) {
        // `reload()` threw, so the realm is NOT dying after all. Leaving `reloading` latched
        // would disable the trigger for the rest of this realm's life — a permanent-off state
        // reached by a single transient failure, and invisible because the only symptom is
        // something never happening again.
        reloading = false;
        // ⚠️ And take the breadcrumb back. `markResumed` ran a line ago on the assumption the
        // realm was about to die; surviving leaves a one-shot marker that makes the NEXT
        // ordinary navigation in this context look like a resume-reload (see
        // `consumeResumeReload`'s own warning) — a spurious cloud sync on the next scene swap.
        // Un-latching is what made the realm live long enough to see it, so the two belong
        // together. And re-arm the realm-shutdown seam (`realmShutdown.ts`) for the same reason —
        // now BELT-AND-BRACES for the shipped callers, since `shutdownRealmThenReload()` re-arms
        // on the throwing route itself, but still load-bearing for any `deps.reload` that does its
        // own teardown without going through that seam:
        // `deps.reload()` on the `engine.reload`/`useResumeReload` path already ran
        // `runRealmShutdownTasks()` before attempting the actual navigation, so its once-per-realm
        // latch is spent — surviving with it stuck would mean a LATER reload in this realm skips
        // teardown entirely. All three lines say "the realm survived after all".
        try { sessionStorage.removeItem(BREADCRUMB_KEY); } catch { /* see markResumeReload */ }
        notifyRealmSurvived();
        throw e;
      }
    },
  };
}
