/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * The binary a beforePack stager bundles for a PINNED conversion CLI (toktx, msdf-atlas-gen — #1327).
 *
 * The packaged editor converts with what it bundles, so bundling "whatever this build machine has
 * on PATH" would make the shipped app's output depend on the machine that packed it — the defect
 * #1327 closes. So the answer is: an explicit env override (a deliberate act, e.g. CI), else the
 * pinned copy that `npm run toolchain:install` provisions — installing it now if it is missing. It
 * delegates to that script rather than re-implementing the pin in CommonJS, so there is one pin.
 *
 * Returns null when neither is available (offline, or no pinned build for this host) — the stager's
 * documented graceful skip. Never falls back to PATH.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ENV_VAR = { toktx: 'MODOKI_TOKTX', 'msdf-atlas-gen': 'MODOKI_MSDF_ATLAS_GEN' };
const INSTALL_SCRIPT = path.join(__dirname, 'toolchain-install.mjs');

function pinnedToolForStaging(id) {
  const override = process.env[ENV_VAR[id]];
  if (override && fs.existsSync(override)) return override;
  // toolchain-install prints `<id>: <path>` on stdout for each tool it installed or found.
  const r = spawnSync(process.execPath, [INSTALL_SCRIPT, id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.error || r.status !== 0) return null;
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith(`${id}: `));
  const bin = line && line.slice(id.length + 2).trim();
  return bin && fs.existsSync(bin) ? bin : null;
}

module.exports = { pinnedToolForStaging };
