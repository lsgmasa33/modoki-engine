/** Playable build stub for a game's `@<game>/app-services` package (Phase 5). Aliased in for a
 *  `VITE_PLAYABLE` build only (see vite.config.ts). A game's app-services package statically pulls
 *  the native-SDK wrappers (AppLovin MAX, Adjust, Firebase analytics/crashlytics) — none of which
 *  do anything in an ad webview. App.tsx already SKIPS `registerAppServices()` in a playable, but
 *  because the game's `game.ts` still holds a `() => import('@<game>/app-services')` closure and the
 *  playable build inlines every dynamic import into the one chunk, that SDK JS gets bundled as dead
 *  weight against the byte cap. Stubbing the package at resolve time keeps the import resolvable
 *  while dropping the SDK code entirely; `register()` is a no-op should it ever be called. */

export function register(): void {}

/** Analytics — a no-op here for the same reason `register()` is: an ad creative must not fire
 *  the game's own analytics, and the Firebase SDK behind the real one is exactly the byte weight
 *  this stub exists to drop.
 *
 *  ⚠️ THIS FILE MUST EXPORT EVERY NAME A GAME'S RUNTIME IMPORTS FROM ITS `app-services` PACKAGE.
 *  A missing one is not a silent degradation — Rollup fails the playable build outright with
 *  `[MISSING_EXPORT] "x" is not exported by ...`, and it fails ONLY on `--target playable`, which
 *  no test suite runs. That is how `track`/`setTrackProperty` broke it: they were added to
 *  `games/court/runtime/systems.ts` and nothing here knew. `engine/tests/architecture/
 *  playableAppServicesStub.test.ts` now derives the required set from the games themselves. */
export function track(_name: string, _params?: Record<string, string | number>): void {}
export function setTrackProperty(_track: string): void {}
export function startInstallMilestones(): void {}

/** Crash reporting — a no-op for the same reason. An ad creative has no Firebase app, and the
 *  Crashlytics SDK behind the real wrapper is byte weight the cap cannot afford. Exported as a
 *  namespace object because that is the shape `export * as crashlytics from './crashlytics'`
 *  gives the real package: a runtime that ever writes `crashlytics.setCustomKey(...)` must find
 *  it here, or `--target playable` fails with [MISSING_EXPORT] and nothing else does. */
export const crashlytics = {
  recordError(_message: string): void {},
  log(_message: string): void {},
  setCustomKey(_key: string, _value: string | number | boolean): void {},
  crash(): void {},
  setEnabled(_enabled: boolean): void {},
};

/**
 * Ads — a no-op namespace, mirroring `export * as ads from './ads'` in Court's package (#342).
 *
 * ⚠️ The no-op here is not merely a size saving, it is REQUIRED. A playable ad already runs inside
 * somebody else's ad slot: an interstitial launched from within a creative would be an ad inside
 * an ad, and MRAID has no notion of it. So the honest stub answers "nothing was shown" rather than
 * doing nothing silently — `showInterstitial` resolving `false` is what makes the caller's
 * "did it show" branch take the right path instead of stamping a cooldown for an ad that
 * never existed.
 */
export const ads = {
  async initAds(): Promise<void> {},
  cleanupAds(): void {},
  onRewardEarned(_handler: unknown): void {},
  async showBanner(): Promise<void> {},
  async hideBanner(): Promise<void> {},
  async showInterstitial(_placement: string): Promise<boolean> { return false; },
  async showRewardedAd(_placement: string): Promise<boolean> { return false; },
  async isRewardedReady(): Promise<boolean> { return false; },
  async showAdDebugger(): Promise<void> {},
};

/**
 * Auth — a no-op namespace, mirroring `export * as auth from './auth'` in Court's package
 * (#359/#360).
 *
 * ⚠️ Like `ads` above, the no-op is REQUIRED rather than merely a size saving, and for a sharper
 * reason. A playable ad is a few seconds inside somebody else's ad slot: it has no Firebase app, no
 * native plugin bridge, and no business asking for an Apple or Google account. So every sign-in
 * here reports `not-configured` — the SAME answer the real seam gives off-device — which is what
 * makes the caller hide the sign-in UI rather than render a button that can only fail.
 *
 * `currentUser` resolving `null` matters just as much: a creative must read as a signed-out player
 * with no cloud save, not as an account whose progress failed to load.
 */
export const auth = {
  async signInWithApple() { return PLAYABLE_NO_AUTH; },
  async signInWithGoogle() { return PLAYABLE_NO_AUTH; },
  async continueAsGuest() { return PLAYABLE_NO_AUTH; },
  async linkGuestTo(_provider: string) { return PLAYABLE_NO_AUTH; },
  async deleteAuthUser() { return PLAYABLE_NO_AUTH; },
  async currentUser() { return null; },
  async signOut(): Promise<void> {},
  async onAuthChanged(_cb: unknown): Promise<() => void> { return () => {}; },
  classifyAuthError(_e: unknown) { return 'not-configured' as const; },
  toCourtUser(_raw: unknown) { return null; },
  __resetAuthForTest(): void {},
};

const PLAYABLE_NO_AUTH = {
  ok: false as const,
  reason: 'not-configured' as const,
  message: 'A playable creative has no Firebase app — sign-in is unavailable by design.',
};

/**
 * Cloud save — a no-op namespace, mirroring `export * as cloudSave from './cloudSave'` (#361).
 *
 * ⚠️ `loadSave` THROWS rather than resolving `null`, and the asymmetry is deliberate. `null` means
 * "this account has no save yet", which would invite the sync protocol to treat a creative as a
 * fresh device and try to CREATE one. Throwing means "could not read", which every caller already
 * handles as a failed sync that leaves local storage alone — the correct behaviour for a session
 * that lasts seconds and must never touch a real player's document.
 */
export const cloudSave = {
  async loadSave(_uid: string): Promise<never> {
    throw new Error('A playable creative has no cloud save.');
  },
  async pushSave(_uid: string, _doc: unknown): Promise<'ok' | 'conflict' | 'failed'> { return 'failed'; },
  async deleteSave(_uid: string): Promise<boolean> { return false; },
  isConflict(_e: unknown): boolean { return false; },
  __resetCloudSaveForTest(): void {},
};
