/**
 * Which Settings page to open.
 *
 * - `app` — the app's own page in the system Settings app.
 * - `notifications` — the app's notification page, where the OS has one: iOS 16+
 *   (`UIApplication.openNotificationSettingsURLString`) and Android 8+
 *   (`Settings.ACTION_APP_NOTIFICATION_SETTINGS`). Anywhere older falls back to `app`.
 */
export type SettingsTarget = 'app' | 'notifications';

export interface ModokiSystemPlugin {
  /**
   * Leave the app for its page in the system Settings app — the only route back once the player
   * has denied an OS permission, because neither iOS nor Android will prompt again.
   *
   * Resolves `{opened: false}` rather than rejecting when nothing could be opened (the web, or a
   * device with no activity for the intent), so a caller can fall back to explanatory text.
   */
  openAppSettings(options?: { target?: SettingsTarget }): Promise<{ opened: boolean }>;

  /**
   * Leave the app for a web page in the system browser (Safari / the default Android browser) —
   * a Privacy Policy or Terms of Use link (#1196).
   *
   * Only `https:` URLs are opened. Anything else (`http:`, `javascript:`, `file:`, `intent:`, a
   * malformed string) resolves `{opened: false}` without leaving the app, so an authored typo cannot
   * become a scheme the OS would act on.
   *
   * Resolves `{opened: false}` rather than rejecting when nothing could be opened. On the web,
   * `opened` means the URL was handed to `window.open` — a popup blocker and the Electron editor's
   * deny-and-forward window handler both make `window.open` return `null`, so the web cannot tell a
   * blocked tab from one opened elsewhere.
   */
  openUrl(options: { url: string }): Promise<{ opened: boolean }>;

  /**
   * Put plain text on the system clipboard (#1398) — `UIPasteboard.general` on iOS,
   * `ClipboardManager` on Android. Native rather than `navigator.clipboard` because a write from
   * the web view needs the tap's user activation, which an action dispatched through the engine
   * cannot promise to still hold.
   *
   * Resolves `{copied: false}` rather than rejecting when nothing was copied (empty text, no
   * clipboard service). On the web, `copied` means `navigator.clipboard.writeText` resolved.
   */
  copyText(options: { text: string }): Promise<{ copied: boolean }>;

  /**
   * iOS only (#1271): every entry of the backup-excluded key-value store whose key starts with
   * `prefix`. The store lives in a folder marked `isExcludedFromBackup`, so an iCloud or Finder
   * backup never copies it. Android rejects these as unavailable and the web as unimplemented: Android's
   * backup is off for the whole app, and the engine only calls them on iOS.
   */
  kvGetAll(options: { prefix: string }): Promise<{ entries: Record<string, string> }>;

  /** iOS only: write one entry atomically (temp file + rename). */
  kvSet(options: { key: string; value: string }): Promise<void>;

  /** iOS only: remove one entry. Removing a missing key resolves. */
  kvRemove(options: { key: string }): Promise<void>;

  /** iOS only: where the store is, whether the backup exclusion is set, and how many entries it holds. */
  kvInfo(): Promise<{ path: string; excludedFromBackup: boolean; entries: number }>;

  /**
   * Ask the OS to show its own "rate this app" prompt — `SKStoreReviewController` on iOS, the Play
   * In-App Review flow on Android (#939).
   *
   * ⚠️ **`requested: true` does NOT mean the player saw anything, and nothing can tell you whether
   * they did.** Both platforms treat this as a hint: they apply their own quota (iOS shows at most
   * ~3 per user per year and may show nothing at all), they never report the outcome, and they
   * never say whether a review was written. So a caller must treat one call as one *spent
   * opportunity*, not as a displayed dialog, and must never re-ask because "nothing happened" —
   * there is no such signal, and asking again only burns the quota faster.
   *
   * `requested` is therefore only "the OS accepted the request without erroring". It resolves
   * `false` rather than rejecting when the platform has no such flow (the web, or an Android build
   * without Play services), so a caller needs no platform branch of its own.
   */
  requestReview(): Promise<{ requested: boolean }>;
}
