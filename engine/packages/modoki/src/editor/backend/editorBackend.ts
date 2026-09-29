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
 *  network call. Most callers want `writeAssetFile`'s outcome instead; this exists for the rare
 *  caller that needs the HTTP status (`collisionMeshWrite.ts`'s write-then-register sequencing,
 *  which reports `write GLB failed (${res.status})`). `content` is passed through completely
 *  unchanged — compose a JSON document's bytes with `jsonFileBody` FIRST; this function does not
 *  know or care whether it is writing JSON or binary. */
export function postWriteFile(
  filePath: string, content: string, encoding?: string,
  /** `createOnly` sends `ifNoneMatch:'*'`: the route answers 409 instead of overwriting a file that
   *  is already there (#1215). Absent, the write replaces — which every save depends on.
   *  `ifMatch` is the sha256 (`sha256Hex`) of the bytes the caller expects the file to hold NOW: the
   *  route answers 409 `reason:'if-match'` instead of writing when they differ or the file is gone
   *  (`ifMatchRefusal`, editorBackendRouter.ts). Apply-to-Prefab's undo/redo pass it (#1664). */
  opts?: { createOnly?: boolean; ifMatch?: string },
): Promise<Response> {
  return backendFetch('/api/write-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: filePath, content, encoding,
      ...(opts?.createOnly ? { ifNoneMatch: '*' } : {}),
      ...(opts?.ifMatch !== undefined ? { ifMatch: opts.ifMatch } : {}),
    }),
  });
}

/** Write the OPEN scene to another file as a COPY with its own identity (#1414): the backend stamps
 *  a fresh scene id and re-mints the entity guids, then overwrites whatever scene is at `filePath`.
 *  `content` is the scene as serialized (`jsonFileBody`). Resolves to the copy's new guid and the
 *  path the disk spells it with; `'same-file'` when `filePath` resolves to `openPath`'s own file, or
 *  `'target-loaded'` to another of `loadedPaths` (nothing written either way — the backend compares
 *  the files the DISK resolves, which a client string compare cannot); or null when the write was
 *  refused or failed. */
export async function writeSceneCopy(filePath: string, content: string, openPath: string, loadedPaths: readonly string[]): Promise<{ guid: string; path: string } | 'same-file' | 'target-loaded' | null> {
  try {
    const res = await backendFetch('/api/scene-save-as', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content, openPath, loadedPaths }),
    });
    if (res.status === 409) {
      const j = await res.json().catch(() => ({})) as { sameFile?: boolean; targetLoaded?: boolean };
      return j.sameFile ? 'same-file' : j.targetLoaded ? 'target-loaded' : null;
    }
    if (!res.ok) return null;
    const j = await res.json() as { guid?: string; path?: string };
    return typeof j.guid === 'string' ? { guid: j.guid, path: typeof j.path === 'string' ? j.path : filePath } : null;
  } catch { return null; }
}

/** The bytes (base64) a file dropped into the Assets panel is written as at `dest` (#1713): a JSON asset with an
 *  identity of its own, decided by the backend exactly as `modoki_import_file` decides it (`/api/import-identity`
 *  → `importedAssetBytes`); anything else unchanged, without a round trip. Null when the backend could not answer — the
 *  caller must NOT fall back to the dropped bytes, which carry the source's id: written as they are, a copy of an asset
 *  already in the project claims its guid, and the scanner's heal keeps it for whichever path sorts first.
 *
 *  `claimed` is ONE batch's decided ids, shared across its calls and grown by each (#1713 close-out re-review): the
 *  batch writes through `/api/write-file`, which rebuilds no manifest, so the backend cannot see the batch's earlier
 *  files — two carrying one unused id would otherwise both keep it. */
export async function importedFileContent(dest: string, content: string, claimed: Set<string> = new Set()): Promise<string | null> {
  if (!dest.toLowerCase().endsWith('.json')) return content;
  try {
    const res = await backendPostJson('/api/import-identity', { path: dest, content, claimed: [...claimed] });
    const j = await res.json().catch(() => ({})) as { content?: unknown; id?: unknown; error?: unknown };
    if (!res.ok || typeof j.content !== 'string') {
      console.error(`[Assets] ${dest} was not imported: no identity from the backend (${String(j.error ?? res.status)})`);
      return null;
    }
    if (typeof j.id === 'string') claimed.add(j.id);
    return j.content;
  } catch (e) {
    console.error(`[Assets] ${dest} was not imported: no identity from the backend`, e);
    return null;
  }
}

/** One file `/api/prefab-member-paths` rewrote (#1751): the bytes it wrote, and the bytes it held before. */
export interface MemberPathRewrite { path: string; type: 'scene' | 'prefab'; guid?: string; text: string; prior: string }

/** What `/api/prefab-member-paths` did: rewrote (`rewritten`, with the bytes in `written`), left because an asset view
 *  holds it unsaved (`held`), and left because it changed on disk while the route waited (`changed`, #1784). */
export interface MemberPathRepair { rewritten: string[]; held: string[]; changed: string[]; written: MemberPathRewrite[] }

/** After a prefab changed from `before` in a way that moved member PATHS (#1437: an applied move),
 *  re-point the member refs stored in every OTHER scene and prefab file that uses it
 *  (`/api/prefab-member-paths`). `null` when the backend could not do it (the reason is in the console).
 *
 *  ⚠️ The transport only. The route marks its writes as the editor's own, so no watcher event brings the client's
 *  caches along (#1751): call it through `repairMemberPathsEverywhere` (serverPrefabRewrites.ts), which adopts
 *  `written`. */
export async function repairPrefabMemberPaths(prefab: string, before: unknown): Promise<MemberPathRepair | null> {
  try {
    const res = await backendPostJson('/api/prefab-member-paths', { prefab, before });
    const j = await res.json().catch(() => ({})) as { rewritten?: unknown; held?: unknown; changed?: unknown; written?: unknown; error?: unknown };
    if (!res.ok) { console.error(`[Prefab] member refs in other files were NOT repaired: ${String(j.error ?? res.status)}`); return null; }
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    // Decoded, never cast: a row missing a field is dropped rather than seated as `undefined`.
    const written = (Array.isArray(j.written) ? j.written : []).filter((w): w is MemberPathRewrite => {
      const r = w as Partial<MemberPathRewrite> | null;
      return !!r && typeof r.path === 'string' && (r.type === 'scene' || r.type === 'prefab')
        && typeof r.text === 'string' && typeof r.prior === 'string' && (r.guid === undefined || typeof r.guid === 'string');
    });
    const out = { rewritten: list(j.rewritten), held: list(j.held), changed: list(j.changed), written };
    // Said HERE, once, for every caller (apply, undo, redo): a held document's own save would write its old
    // refs back, and nothing else tells the user which files those are.
    if (out.held.length) console.warn(`[Prefab] member refs NOT repaired in ${out.held.join(', ')}: open with unsaved edits. Their refs to the moved members will dangle once saved.`);
    if (out.changed.length) console.warn(`[Prefab] member refs NOT repaired in ${out.changed.join(', ')}: the file changed on disk while the repair ran, so it was left as it is. Its refs to the moved members may dangle.`);
    return out;
  } catch (e) {
    console.error('[Prefab] member refs in other files were NOT repaired:', e);
    return null;
  }
}

/** Why `/api/write-file` refused a write, read the ONE way every client caller reads it (#1811).
 *
 *  The route states a reason for every refusal — `{error, options}` for a path outside the asset roots, the prefab
 *  gates' 409 with `error`, a 500's `{error}`, the transport's 400/413/token 403 — and the precondition 409s carry only
 *  `reason`. The two shared wrappers used to read `res.ok` (and a 409's `reason`) and nothing else, so ten callers
 *  reported a bare "failed" to a person or an agent who could only guess why. `error` is the body's `error`, else its
 *  `reason`, else the HTTP status; it is never empty.
 *
 *  `conflict`: the file is not the one the caller expected, so the step must refuse rather than report a failure —
 *  an if-match or if-none-match precondition, or `prefab-mark-lowered` (#1774: the file's localId mark rose past what
 *  this write was raised to, so it is not the file the caller read). The prefab FORMAT gate's 409 is a failed write,
 *  not a conflict: nothing about the file changed, this build just may not write it. */
export interface WriteRefusal { conflict: boolean; error: string; options?: string[] }

const CONFLICT_REASONS: ReadonlySet<unknown> = new Set(['if-match', 'if-none-match', 'prefab-mark-lowered']);

/** Read a refused `/api/write-file` answer (`res.ok` false). */
export async function readWriteRefusal(res: Response): Promise<WriteRefusal> {
  // Inside a `then`, so a body that cannot be read at all (no JSON, a stub without `json`) is a null body, not a throw.
  const body = await Promise.resolve().then(() => res.json()).catch(() => null) as { error?: unknown; reason?: unknown; options?: unknown } | null;
  const why = typeof body?.error === 'string' && body.error ? body.error : typeof body?.reason === 'string' ? body.reason : '';
  const options = Array.isArray(body?.options) ? body.options.filter((o): o is string => typeof o === 'string') : [];
  return {
    conflict: res.status === 409 && CONFLICT_REASONS.has(body?.reason),
    error: why || `the write was refused (HTTP ${res.status})`,
    ...(options.length ? { options } : {}),
  };
}

/** The refusal for a write that never got an answer (the fetch threw). */
export function thrownWriteRefusal(e: unknown): WriteRefusal {
  return { conflict: false, error: e instanceof Error ? e.message : String(e) };
}

/** What `writeAssetFile` answers: landed, or refused with the route's reason. */
export type WriteOutcome = { ok: true } | { ok: false; error: string; options?: string[] };

/** Write a text or base64-encoded file via /api/write-file — the ONE client write wrapper every
 *  JSON write in the editor now routes through (#835; collapses five near-identical copies —
 *  `serialize.ts`'s `writeFileToServer`, this module's own prior duplicate, a third copy in
 *  `modelImport.ts`, `writeAssetFileOrAbort`, and an inline `post` lambda in
 *  `ModelAssetView.tsx`). `content` is passed through completely unchanged, same as
 *  `postWriteFile` above — a JSON caller must produce its bytes with `jsonFileBody` first. Three
 *  BINARY (base64) sites deliberately keep their own raw `backendFetch` call instead of routing
 *  through here — see `tests/architecture/clientJsonWriteSeam.test.ts`'s EXEMPT ledger for which
 *  and why. A refusal carries the route's reason (#1811): the caller states it, never a bare "failed". */
export async function writeAssetFile(filePath: string, content: string, encoding?: 'base64'): Promise<WriteOutcome> {
  let r: WriteRefusal;
  try {
    const res = await postWriteFile(filePath, content, encoding);
    if (res.ok) return { ok: true };
    r = await readWriteRefusal(res);
  } catch (e) { r = thrownWriteRefusal(e); }
  return { ok: false, error: r.error, ...(r.options ? { options: r.options } : {}) };
}

/** What `writeAssetFileGuarded` answers. */
export type GuardedWriteOutcome =
  | { result: 'ok' }
  | { result: 'conflict'; error: string }
  | { result: 'failed'; error: string; options?: string[] };

/** `writeAssetFile` with a precondition on what the file holds NOW (#1679), for an undo/redo that rewrites a file
 *  the editor wrote earlier: `ifMatch` (the sha256 of the bytes it must hold) or `createOnly` (nothing may be there).
 *  A three-way answer rather than a boolean, because the caller does opposite things with the two misses: a
 *  `'conflict'` means the file is someone else's now and the step must refuse, while `'failed'` is a transport or
 *  server error, with the route's reason (#1811). What counts as a conflict is `readWriteRefusal`'s one answer, the
 *  same one `prefabCommit`'s writes read. */
export async function writeAssetFileGuarded(
  filePath: string, content: string,
  opts: { encoding?: 'base64' } & ({ ifMatch: string } | { createOnly: true }),
): Promise<GuardedWriteOutcome> {
  let r: WriteRefusal;
  try {
    const res = await postWriteFile(filePath, content, opts.encoding,
      'ifMatch' in opts ? { ifMatch: opts.ifMatch } : { createOnly: true });
    if (res.ok) return { result: 'ok' };
    r = await readWriteRefusal(res);
  } catch (e) { r = thrownWriteRefusal(e); }
  if (r.conflict) return { result: 'conflict', error: r.error };
  return { result: 'failed', error: r.error, ...(r.options ? { options: r.options } : {}) };
}
