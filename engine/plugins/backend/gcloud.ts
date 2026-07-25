/** Host-agnostic `gcloud` CLI helpers — shared by the Vite middleware (web GCS deploy,
 *  `/api/ota/publish`) and the transport-agnostic `editorBackendRouter.ts` (`/api/ota/status`,
 *  `/api/ota/keygen`). Pure fs/exec, no Vite import, so both hosts can use it without an
 *  import-direction violation (the router must stay host-agnostic; see its file header). */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/** Resolve the directory containing the `gcloud` CLI, or null if not installed. A
 *  Finder-launched packaged editor gets a minimal PATH without the Google Cloud SDK, so
 *  probe well-known install dirs (Homebrew, the SDK's own installers) and fall back to the
 *  login shell's `command -v gcloud` (covers a custom location). gcloud is a system tool the
 *  editor can't provision (it carries the user's cloud auth) — distinct from the build tools
 *  the toolchain provisions. Exported for unit testing. */
export function resolveGcloudDir(override?: string): string | null {
  // An explicit Project Settings override wins (sdk.gcloudPath — the binary OR its dir).
  if (override) {
    if (fs.existsSync(path.join(override, 'gcloud'))) return override;                 // a bin dir
    if (fs.existsSync(override) && path.basename(override) === 'gcloud') return path.dirname(override); // the binary
  }
  if (process.platform === 'win32') return null; // web deploy steps are posix-only
  const home = process.env.HOME ?? '';
  const dirs = [
    '/opt/homebrew/bin', '/usr/local/bin',
    path.join(home, 'google-cloud-sdk', 'bin'),
    '/usr/local/google-cloud-sdk/bin',
    path.join(home, '.local', 'bin'),
  ];
  for (const d of dirs) {
    if (d && fs.existsSync(path.join(d, 'gcloud'))) return d;
  }
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execSync(`${shell} -ilc 'command -v gcloud'`, { timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out && fs.existsSync(out)) return path.dirname(out);
  } catch { /* not found via the login shell */ }
  return null;
}

/** OTA Phase 5a — `ota.baseUrl` (e.g. "https://storage.googleapis.com/bucket/prefix") is
 *  what the CLIENT fetches from; `ota-publish.mjs`/`gcloud storage` need the `gs://` form
 *  to WRITE to the same location. Derivable only for the plain storage.googleapis.com host
 *  (the common case, incl. games/ota-test) — a custom CDN domain in front of the bucket
 *  can't be reverse-derived, so publish/status callers accept an explicit `bucket` override
 *  for that case. Pure — exported for unit testing. */
export function deriveGcsBucketFromBaseUrl(baseUrl: string): string | null {
  const m = baseUrl.match(/^https:\/\/storage\.googleapis\.com\/([^?#]+)/);
  return m ? `gs://${m[1].replace(/\/+$/, '')}` : null;
}

/** A version/bundle-name/key-name string interpolated into a `bash -c` command
 *  (buildStepShell.ts) — must never carry shell metacharacters. Same discipline as
 *  `validateBuildConfig`. */
export const OTA_SAFE_TOKEN = /^[A-Za-z0-9._-]{1,64}$/;
/** A `gs://bucket[/prefix]` URL, similarly constrained before shell interpolation. */
export const OTA_SAFE_BUCKET = /^gs:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._/-]*)?$/;
