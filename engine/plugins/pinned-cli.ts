/** Resolution for every PINNED asset-conversion CLI — ffmpeg/ffprobe (#1297) and toktx/
 *  msdf-atlas-gen (#1327) — in one place, so the four cannot drift into four policies.
 *
 *  A conversion's cache key names the source, the settings and an in-repo encoder tag, never the
 *  binary. So the binary must be the same on every machine: the provisioned, version-pinned copy
 *  under the toolchain dir, the packaged editor's bundled copy, or an explicit `MODOKI_*` override
 *  (a deliberate act) — and otherwise the conversion FAILS rather than using whatever is on PATH.
 *  `detect()` is the one resolver; its `pinnedOnly` registry flag is what drops the PATH candidate,
 *  so Build Support and the conversion can never disagree about whether the tool is there. */

import { detect, resolve, forgetDetection, isToolStale, NPM_BINARY_PINS, conversionToolchainDir } from '../toolchain';

export type PinnedConversionCli = 'ffmpeg' | 'ffprobe' | 'toktx' | 'msdf-atlas-gen';

/** Resolve a pinned conversion CLI to a runnable command, or throw an actionable message.
 *
 *  A miss is re-checked once with the cached detection dropped: the install may have run
 *  in the other process (the Vite server installs; the Electron main also converts), and
 *  a negative result cached here before that install would otherwise stick until restart.
 *  A hit is not re-checked — `detect()` already proved it runs. */
export function pinnedConversionCli(id: PinnedConversionCli): string {
  let d = detect(id);
  if (!d.present) {
    forgetDetection(id);
    d = detect(id);
  }
  if (!d.present || !d.command) {
    resolve(id); // throws the registry's actionable install message
    throw new Error(`${id} resolved without a command`);
  }
  // toktx/msdf-atlas-gen need no check here: their install dir is versioned, so a copy from an
  // older pin is never a candidate at all (conversionCliProvision.ts).
  if ((id === 'ffmpeg' || id === 'ffprobe') && isToolStale(id, d)) {
    const pin = NPM_BINARY_PINS[id];
    throw new Error(
      `The provisioned ${id} under ${conversionToolchainDir()} is not the pinned ${pin.pkg}@${pin.version} (#1297). ` +
      'Reinstall it from Build → Build Support…, or run `npm run toolchain:install -- ffmpeg ffprobe`.',
    );
  }
  return d.command;
}
