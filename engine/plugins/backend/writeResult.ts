/**
 * Shared writer that serializes a `BackendResult` to an http response — used by
 * BOTH backend hosts (the Vite dev middleware and the Electron HTTP server) so
 * the json/raw/file/headers handling can't drift between dev and prod. The `file`
 * kind streams from disk via `createReadStream` instead of buffering the whole
 * file in memory (P1-5), so a large GLB/HDR/KTX2 doesn't spike the in-process
 * backend's heap or block on a giant `readFileSync`.
 *
 * Node-only (fs/http).
 */

import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { BackendResult } from './editorBackendRouter';

export function writeBackendResult(
  res: ServerResponse,
  result: BackendResult,
  ifNoneMatch?: string | string[],
): void {
  res.statusCode = result.status ?? 200;
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
  }

  // Conditional GET: a `no-cache` variant (model/texture) carries the content hash
  // as its ETag, so an unchanged bake revalidates with a body-less 304 instead of
  // re-streaming megabytes. Match is exact (the hash is unique); covers the common
  // single-ETag header we emit, not the weak/comma-list general case.
  const etag = result.headers?.ETag;
  if (etag && typeof ifNoneMatch === 'string' && ifNoneMatch === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  if (result.kind === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result.body));
    return;
  }

  if (result.kind === 'raw') {
    res.setHeader('Content-Type', result.contentType);
    res.end(result.body);
    return;
  }

  // kind === 'file' — stream from disk.
  res.setHeader('Content-Type', result.contentType);
  let size: number | undefined;
  try { size = fs.statSync(result.path).size; } catch { /* gone; stream errors below */ }
  if (size != null) res.setHeader('Content-Length', String(size));
  const stream = fs.createReadStream(result.path);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `failed to read ${result.path}` }));
    } else {
      res.destroy();
    }
  });
  res.on('close', () => stream.destroy()); // client aborted — stop reading
  stream.pipe(res);
}
