/** Types for `notificationIcon.mjs` (#1203). Plain Node like `iconVariants.mjs`, so its shape is
 *  declared here for the TS consumers that import it. */

export declare const ANDROID_NOTIFICATION_ICON: string;
export declare const NOTIFICATION_ICON_SIZES: Readonly<Record<string, number>>;

export declare function renderNotificationIcon(srcAbs: string, size: number): Promise<Buffer | null>;

export declare function writeAndroidNotificationIcon(opts: {
  projectRoot: string;
  srcAbs?: string;
  /** Remove a previously emitted icon when `srcAbs` is unset. Only when the config was READ and is empty. */
  cleared?: boolean;
}): Promise<{
  /** Paths written, relative to `res/`. */
  written: string[];
  /** Paths removed because the setting was cleared, relative to `res/`. */
  removed: string[];
  notes: string[];
  /** Requested but unreadable: the caller must not stamp the run current (#1028). */
  missing: string[];
}>;
