/** Types for `iconInputs.mjs` — the one place icon/splash generation inputs are resolved (#827).
 *  Hand-written because the module is plain Node (`generate-icons.mjs` imports it directly), while
 *  the editor's build plan (`vite-asset-scanner.ts`) imports it typechecked. */

/** Every generation input, resolved. */
export interface IconInputs {
  icon: string | undefined;
  splash: string | undefined;
  splashDark: string | undefined;
  title: string | undefined;
  titleWidthPct: number;
  titleOffsetPct: number;
  badge: boolean;
  badgeLight: string | undefined;
  badgeDark: string | undefined;
  orientation: string | undefined;
  iconDark: string | undefined;
  iconTinted: string | undefined;
  iconMonochrome: string | undefined;
  /** Android's notification small icon source (#1203). Undefined = emit none. */
  notificationIcon: string | undefined;
  /** True ONLY when the config positively has no `notificationIconSource`, or the caller says so with
   *  `--notification-icon-cleared`. Gates removing a previously emitted icon (#1203). */
  notificationIconCleared: boolean;
  /** True ONLY when the config positively has no `splashSource`, i.e. the setting was cleared —
   *  never merely because the `--splash` flag was not typed, and never when `cfg` is null. */
  splashCleared: boolean;
  /** Fail the generation (non-zero exit) on any degraded outcome (#1028). Not a generation input. */
  strict: boolean;
}

/** A CLI flag WINS, otherwise the value comes from `project.config.json` (#1011). `cfg` is the
 *  merged ProjectConfig, or `null` when it could not be read — and `null` means UNKNOWN, not "empty",
 *  which is why `splashCleared` and the bundled-icon default both require it non-null. `engineRoot`
 *  is where the bundled icon and the badge art are read from. */
export declare function resolveIconInputs(
  args: Record<string, string | undefined>,
  projectRoot: string,
  cfg: unknown | null,
  engineRoot: string,
): IconInputs;

/** The freshness-stamp inputs, re-shaped from {@link resolveIconInputs}' output so one place decides
 *  what an input IS. `engineRootAbs` anchors the post-processing-source hash. Structurally the
 *  editor's `IconStampExtras`. */
export declare function stampExtrasFrom(
  inputs: IconInputs,
  engineRootAbs: string,
): {
  splashSrcAbs?: string;
  splashDarkSrcAbs?: string;
  titleSrcAbs?: string;
  badgeArtAbs?: string;
  badgeDarkArtAbs?: string;
  iconDarkSrcAbs?: string;
  iconTintedSrcAbs?: string;
  iconMonochromeSrcAbs?: string;
  notificationIconSrcAbs?: string;
  titleWidthPct?: number;
  titleOffsetPct?: number;
  badge?: boolean;
  orientation?: string;
  engineRootAbs?: string;
};

/** {@link resolveIconInputs}' output as `generate-icons.mjs` flags (`[flag, value]`, no leading
 *  `--`) — its exact inverse, so a script that cannot read the config resolves the same inputs. */
export declare function iconInputsToArgs(inputs: IconInputs): Array<[string, string]>;
