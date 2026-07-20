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
