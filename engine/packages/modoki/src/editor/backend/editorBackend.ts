/**
 * Single client seam for all editor → backend calls (ELECTRON_PLAN Phase 1).
 *
 * Every editor → backend request funnels through `backendFetch` /
 * `backendEventSource` here so the transport is swappable in exactly ONE place:
 *
 *   - Vite dev / browser: same-origin (base = ''). Vite middleware serves /api/*.
 *   - Packaged Electron: the editor host sets `window.__modokiBackendBase` to the
 *     backend the Electron main process hosts (Phase 2 starts as a local HTTP
 *     server on 127.0.0.1:<port>; IPC can later replace this in one spot without
 *     touching any callsite).
 *
 * A CI lint gate (eslint.config.js) forbids raw `fetch('/api/...')` and
 * `new EventSource('/api/...')` outside this module so nothing can bypass the
 * seam — see the Phase 1 exit criteria.
 */

/** Base URL the editor backend is reachable at. Empty string = same-origin
 *  (Vite dev server / browser). The Electron host overrides it via a global the
 *  preload script sets. */
export function backendBase(): string {
  const g = globalThis as unknown as { __modokiBackendBase?: string };
  return g.__modokiBackendBase ?? '';
}

/** Resolve a backend path (e.g. '/api/write-file') to a fully-qualified URL. */
export function backendUrl(path: string): string {
  return backendBase() + path;
}

/** The one transport for editor → backend requests. Behaves exactly like
 *  `fetch`, but targets the configured backend host. Callsites keep their own
 *  response handling (`.ok` / `.json()` / `.status`) — only the URL is rerouted. */
export function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(backendUrl(path), init);
}

/** POST-JSON convenience used by most command endpoints. */
export function backendPostJson(path: string, body: unknown, init?: RequestInit): Promise<Response> {
  return backendFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

/** SSE transport for streaming endpoints (currently /api/build). */
export function backendEventSource(path: string): EventSource {
  return new EventSource(backendUrl(path));
}

// ── The client-side JSON write seam (#835) ──────────────────────────────────────────
//
// The editor serialises scene/prefab/asset-document JSON CLIENT-SIDE and POSTs the finished
// string to /api/write-file — unlike `/api/asset-write`, which parks an OBJECT and lets the
// server produce the bytes (`assetJsonBytes`, editorBackendRouter.ts). Before #835 every
// /api/write-file JSON call site spelled out its own `JSON.stringify(x, null, 2)`, and NONE of
// them appended the trailing newline the committed corpus (and `assetJsonBytes`) carries — the
// exact byte drift #831 fixed on the server seam. `jsonFileBody` below is the client mirror of
// `assetJsonBytes`; `writeAssetFile`/`postWriteFile` are the ONE place that composes the
// /api/write-file network call, so a JSON call site that used its own `JSON.stringify` is now a
// call site that forgot to use `jsonFileBody`, not a second definition of the bytes.

/** The exact bytes a client-side JSON document write puts on disk — the CLIENT mirror of the
 *  server's `assetJsonBytes` (`editorBackendRouter.ts`). One definition, so every scene/prefab/
 *  asset-doc write through `/api/write-file` agrees byte-for-byte with the committed corpus's
 *  trailing newline, instead of each call site spelling out its own
 *  `JSON.stringify(x, null, 2)` — that drift is exactly how 537 committed scene/prefab files
 *  lost their trailing newline (#835).
 *
 *  ⚠️ **JSON only.** A BINARY write (base64) must NEVER pass through this — it would gain a
 *  spurious trailing byte and corrupt the asset. Binary call sites pass their base64 string
 *  straight to `writeAssetFile`/`postWriteFile` with `encoding:'base64'` and never touch this
 *  function.
 *
 *  ⚠️ That split is BEHAVIOURAL, not type-level — an earlier version of this comment claimed the
 *  latter and was wrong, which is worth correcting rather than deleting: `content` is a bare
 *  `string` on both writers, so `writeAssetFile(p, JSON.stringify(doc, null, 2))` typechecks,
 *  lints, and passes `clientJsonWriteSeam` (which scans for the ROUTE, not for a `JSON.stringify`
 *  pattern) while reproducing #835 exactly. The guard against that is this paragraph plus review,
 *  and saying so is the point — a false claim of compiler enforcement is worse than none, because
 *  it tells the next author not to look. Branding the return (`string & {readonly __json: unique
 *  symbol}`) would make it real, but the binary callers pass plain strings to the same parameter,
 *  so it cannot be enforced on the writer's side without splitting the writers too. */
export function jsonFileBody(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** POST to /api/write-file, returning the raw `Response` — the ONE place that composes this
 *  network call. Most callers want `writeAssetFile`'s boolean instead; this exists for the rare
 *  caller that needs the HTTP status (`collisionMeshWrite.ts`'s write-then-register sequencing,
 *  which reports `write GLB failed (${res.status})`). `content` is passed through completely
 *  unchanged — compose a JSON document's bytes with `jsonFileBody` FIRST; this function does not
 *  know or care whether it is writing JSON or binary. */
export function postWriteFile(filePath: string, content: string, encoding?: string): Promise<Response> {
  return backendFetch('/api/write-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content, encoding }),
  });
}

/** Write a text or base64-encoded file via /api/write-file — the ONE client write wrapper every
 *  JSON write in the editor now routes through (#835; collapses five near-identical copies —
 *  `serialize.ts`'s `writeFileToServer`, this module's own prior duplicate, a third copy in
 *  `modelImport.ts`, `writeAssetFileOrAbort`, and an inline `post` lambda in
 *  `ModelAssetView.tsx`). `content` is passed through completely unchanged, same as
 *  `postWriteFile` above — a JSON caller must produce its bytes with `jsonFileBody` first. Three
 *  BINARY (base64) sites deliberately keep their own raw `backendFetch` call instead of routing
 *  through here — see `tests/architecture/clientJsonWriteSeam.test.ts`'s EXEMPT ledger for which
 *  and why. */
export async function writeAssetFile(filePath: string, content: string, encoding?: 'base64'): Promise<boolean> {
  try {
    return (await postWriteFile(filePath, content, encoding)).ok;
  } catch { return false; }
}
