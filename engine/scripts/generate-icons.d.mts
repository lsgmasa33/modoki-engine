/** Types for `generate-icons.mjs`'s testable internals (the module is plain Node so the build
 *  step can run it directly; only the collateral-cleanup logic is imported by tests). */
export declare function collect(dir: string, skipPrefix: string, out?: Map<string, Buffer>): Map<string, Buffer>;
export declare function newFilesOutsideScope(dir: string, skipPrefix: string, snapshot: Map<string, Buffer>): string[];
export declare function restoreSnapshot(snapshot: Map<string, Buffer>, projectRoot: string): { restored: string[]; failed: string[] };

/** Every generation input, resolved: a CLI flag WINS, otherwise the value comes from
 *  `project.config.json` (#1011). `cfg` is the merged ProjectConfig, or `null` when it could not be
 *  read — and `null` means UNKNOWN, not "empty", which is why `splashCleared` requires it non-null. */
export declare function resolveIconInputs(
  args: Record<string, string | undefined>,
  projectRoot: string,
  cfg: unknown | null,
): {
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
  /** True ONLY when the config positively has no `splashSource`, i.e. the setting was cleared —
   *  never merely because the `--splash` flag was not typed, and never when `cfg` is null. */
  splashCleared: boolean;
};

/** The freshness-stamp inputs, re-shaped from {@link resolveIconInputs}' output so one place decides
 *  what an input IS. `engineRootAbs` anchors the post-processing-source hash. */
export declare function stampExtrasFrom(
  inputs: ReturnType<typeof resolveIconInputs>,
  engineRootAbs: string,
): Record<string, unknown>;
