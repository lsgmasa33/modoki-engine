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

/** A project registers its concrete service implementations (merged over any prior). */
export function registerAppServices(services: AppServices): void {
  registered = { ...registered, ...services };
}

/** The currently-registered services. Every field is optional → callers use `?.`. */
export function appServices(): AppServices {
  return registered;
}

/** Drop all registered services (on game swap, so a previous game's services don't leak). */
export function clearAppServices(): void {
  registered = {};
}
