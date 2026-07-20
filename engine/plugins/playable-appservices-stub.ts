/** Playable build stub for a game's `@<game>/app-services` package (Phase 5). Aliased in for a
 *  `VITE_PLAYABLE` build only (see vite.config.ts). A game's app-services package statically pulls
 *  the native-SDK wrappers (AppLovin MAX, Adjust, Firebase analytics/crashlytics) — none of which
 *  do anything in an ad webview. App.tsx already SKIPS `registerAppServices()` in a playable, but
 *  because the game's `game.ts` still holds a `() => import('@<game>/app-services')` closure and the
 *  playable build inlines every dynamic import into the one chunk, that SDK JS gets bundled as dead
 *  weight against the byte cap. Stubbing the package at resolve time keeps the import resolvable
 *  while dropping the SDK code entirely; `register()` is a no-op should it ever be called. */

export function register(): void {}
