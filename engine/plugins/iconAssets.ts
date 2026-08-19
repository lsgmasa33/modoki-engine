/** App-icon / splash generation inputs and the freshness stamp that decides whether the
 *  generator needs to run at all.
 *
 *  Two problems this module exists to prevent, both of which shipped:
 *
 *  1. **An unpinned generator.** The build ran a bare `npx --yes @capacitor/assets` under a
 *     comment claiming it was "verified against 3.0.5" — but `npx --yes` installs LATEST, so
 *     the comment documented a version the build did not use. The generated icons are
 *     committed release artifacts, so the tool making them is pinned here.
 *     ⚠️ That fix also blamed the extra density buckets (`drawable-*-night-*`, `*-ldpi`,
 *     `mipmap-ldpi`) on the floating version. Measured 2026-08-19: the PINNED 3.0.5 emits
 *     them too — 21 paths on forest-camp that no project commits. Pinning stopped them
 *     changing, not appearing (#236).
 *
 *  2. **Unconditional regeneration.** The step ran on every native build, rewriting every
 *     tracked mipmap/splash PNG each time. Any game that had been built therefore had a
 *     permanently dirty working tree, and real changes were buried under re-encoded binaries
 *     (measured: 95 such files across two games in a single day).
 *
 *  Note the fix is deliberately NOT "gitignore the icons". Generation is non-fatal by design
 *  and needs `npx` to reach the network, so untracked icons would let an offline or
 *  upstream-broken build ship an app with no icon and no committed fallback. They stay in
 *  git; the build just stops rewriting them when nothing changed.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type IconPlatform = 'ios' | 'android';

/** PINNED — see (1) above. Bumping this invalidates every stamp, so the next build of each
 *  project regenerates its icons exactly once. Defined in `scripts/iconAssets.mjs` because the
 *  generator wrapper (`scripts/generate-icons.mjs`) is plain Node and cannot import this file;
 *  re-exported here so every existing consumer is unchanged. */
export { ICON_TOOL, ICON_COLORS } from '../scripts/iconAssets.mjs';
import { ICON_TOOL, ICON_COLORS } from '../scripts/iconAssets.mjs';

/** Stamp file, under the project's gitignored `.cache/`. Never committed. */
export function iconStampPath(projectRoot: string, plat: IconPlatform): string {
  return path.join(projectRoot, '.cache', `icon-stamp-${plat}`);
}

/** One generated output per platform, used to detect that the icons were deleted while the
 *  stamp survived — without it, a wiped `res/` would never be regenerated. */
export function iconSentinelPath(projectRoot: string, plat: IconPlatform): string {
  return path.join(
    projectRoot,
    plat === 'ios'
      ? 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'
      : 'android/app/src/main/res/mipmap-hdpi/ic_launcher.png',
  );
}

/** Hash of everything that can change the generated output: the tool version, the platform,
 *  the colour flags, and the CONTENT of the source image (not its path or mtime — a project
 *  that repoints `iconSource` at a byte-identical file should not regenerate, and editing an
 *  image in place must). */
export function iconStampValue(iconSrcAbs: string, plat: IconPlatform): string {
  let srcHash = 'missing';
  try { srcHash = crypto.createHash('sha256').update(fs.readFileSync(iconSrcAbs)).digest('hex'); }
  catch { /* unreadable source → 'missing', so the step runs and reports the failure itself */ }
  return crypto.createHash('sha256')
    .update([ICON_TOOL, plat, ICON_COLORS, srcHash].join('\0'))
    .digest('hex');
}

/** True when generation can be skipped entirely. Conservative: ANY doubt (missing stamp,
 *  missing outputs, unreadable source) returns false and regenerates. */
export function iconIsUpToDate(projectRoot: string, iconSrcAbs: string, plat: IconPlatform): boolean {
  try {
    if (!fs.existsSync(iconSentinelPath(projectRoot, plat))) return false;
    return fs.readFileSync(iconStampPath(projectRoot, plat), 'utf8').trim()
      === iconStampValue(iconSrcAbs, plat);
  } catch {
    return false;
  }
}
