/**
 * Temp-file housekeeping for the agent capture/render tools (P2-5). Both
 * `captureViewport` (electron/rendererOps) and `/api/render-scene|sequence`
 * (editorBackendRouter) write JPEG/PNG frames into the OS temp dir and hand the
 * agent a path — the agent reads it, but nothing ever deletes them, so a long MCP
 * session would accumulate hundreds of MB. Before each write we sweep our own
 * prefix, dropping anything older than a TTL. Best-effort + sync (the temp dir
 * listing is tiny); failures are ignored so a sweep can never break a capture.
 *
 * Node-only (fs/os). Used by the Electron main process and the dev backend.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Files we manage are named `modoki-capture-*` / `modoki-render-*`. */
export const TEMP_FILE_PREFIXES = ['modoki-capture-', 'modoki-render-'] as const;

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min

/** Delete temp files matching `prefix` older than `maxAgeMs`. */
export function pruneOldTempFiles(prefix: string, maxAgeMs = DEFAULT_TTL_MS): void {
  const dir = os.tmpdir();
  const cutoff = Date.now() - maxAgeMs;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch { /* raced/gone — ignore */ }
  }
}
