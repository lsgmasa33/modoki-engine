/**
 * Where a device backend keeps its small per-clone state. A leaf module on purpose: `deviceConnection.ts`
 * and `wdaLauncher.ts` both need it, and `deviceConnection` imports `wdaLauncher` (#1077), so the function
 * cannot live in either without a cycle.
 */

import os from 'os';
import path from 'path';

/** Where this backend keeps its small persistent state (device GUID, last connect target, the pid records
 *  of the processes a lease spawns).
 *
 *  A dev clone gets `<cwd>/.modoki`, so each checkout keeps its own stable token — that is the
 *  "per clone" property the GUID doc in `deviceConnection.ts` describes.
 *
 *  ⚠️ A PACKAGED editor must not use cwd: it is `REPO_ROOT`, which is
 *  `<Resources>/app.asar.unpacked` — INSIDE the signed .app. Writing there breaks the bundle's
 *  code signature, and `codesign --verify` / `spctl --assess` both start failing with "a sealed
 *  resource is missing or invalid" (measured 2026-08-22: `.modoki/device-guid` was one of the two
 *  files `codesign` named after a single build). There is also no "clone" to be per, so the
 *  machine-wide `~/.modoki` is both safe and correct — it is already where `device-claims.json`
 *  and `editor-launches.log` live. */
export function modokiStateDir(): string {
  return process.env.MODOKI_PACKAGED === '1'
    ? path.join(os.homedir(), '.modoki')
    : path.join(process.cwd(), '.modoki');
}
