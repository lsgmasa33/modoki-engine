/**
 * App-service registry (analytics / crashlytics / ads / attribution).
 *
 * These are native-SDK wrappers (Firebase, AppLovin MAX, Adjust) that do NOT
 * belong in the engine — they are app/game concerns. A PROJECT provides concrete
 * implementations via `GameDefinition.registerAppServices()`; the engine shell
 * calls only the small hook surface below, and every unregistered hook is a no-op
 * (which is also the web/editor behavior, since the underlying Capacitor plugins
 * stub out off-device). A game's package keeps its full API (showInterstitial,
 * logEvent, …) for the game to call directly — the engine never sees those.
 *
 * This is the dogfood seed for a future Modoki package manager: the example game
 * consumes these services as a local package, exactly as a real game would consume
 * the eventual Modoki-hosted npm package. See docs/modoki-package-manager.md.
 */

/** Crash reporting hooks the engine shell calls (ErrorBoundary, gameStore). */
export interface CrashlyticsService {
  recordError(message: string): void;
  log(message: string): void;
}

/** Ads lifecycle the engine shell drives (init on game load, cleanup on swap). */
export interface AdsService {
  init(): void | Promise<void>;
  cleanup(): void;
}

/** Attribution lifecycle the engine shell drives (init on game load). */
export interface AttributionService {
  init(): void | Promise<void>;
}

export interface AppServices {
  crashlytics?: CrashlyticsService;
  ads?: AdsService;
  attribution?: AttributionService;
}

let registered: AppServices = {};

/** Registration listeners. `globalErrors.ts` queues captured errors until a `crashlytics`
 *  implementation exists (a game registers one well after boot) and flushes on this signal —
 *  without it, every error raised during boot, which is the class we would most want reported,
 *  would be dropped for want of a destination that arrives moments later. */
type RegistrationListener = () => void;
const listeners: RegistrationListener[] = [];

/** Subscribe to "a project just registered services". Called after the merge, so a listener
 *  reading `appServices()` sees the new state. Never removed — the listeners are process-level. */
export function onAppServicesRegistered(fn: RegistrationListener): void {
  listeners.push(fn);
}

/** A project registers its concrete service implementations (merged over any prior). */
export function registerAppServices(services: AppServices): void {
  registered = { ...registered, ...services };
  for (const fn of listeners) {
    // A listener must never break registration — the game's services are the point, the
    // notification is a courtesy.
    try { fn(); } catch { /* ignore */ }
  }
}

/** The currently-registered services. Every field is optional → callers use `?.`. */
export function appServices(): AppServices {
  return registered;
}

/** Drop all registered services (on game swap, so a previous game's services don't leak). */
export function clearAppServices(): void {
  registered = {};
}
