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
}
