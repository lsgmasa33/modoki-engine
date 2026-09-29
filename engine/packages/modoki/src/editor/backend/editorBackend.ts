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

import { failureDetail } from './failureBody';

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
 *  the files the DISK resolves, which a client string compare cannot); or `{refused}` with the route's
 *  reason when the write was refused or failed (#1824 — this was a bare `null`, so a wrongKind 409, a 403
 *  and a 500 all reached an agent's `save_all` as `write-failed` with no text). Renamed with the shape, so
 *  no `if (!written)` survives reading every refusal as a success. */
export async function saveSceneCopy(filePath: string, content: string, openPath: string, loadedPaths: readonly string[]): Promise<{ guid: string; path: string } | 'same-file' | 'target-loaded' | { refused: string; code?: string }> {
  const a = await postBackend('/api/scene-save-as', { path: filePath, content, openPath, loadedPaths });
  if (!a.ok) {
    const b = (a.body ?? {}) as { sameFile?: unknown; targetLoaded?: unknown };
    if (a.status === 409 && b.sameFile) return 'same-file';
    if (a.status === 409 && b.targetLoaded) return 'target-loaded';
    return { refused: a.error, ...(a.code ? { code: a.code } : {}) };
  }
  return typeof a.body.guid === 'string'
    ? { guid: a.body.guid, path: typeof a.body.path === 'string' ? a.body.path : filePath }
    : { refused: 'the route answered without the copy\'s guid' };
}

/** The bytes (base64) a file dropped into the Assets panel is written as at `dest` (#1713): a JSON asset with an
 *  identity of its own, decided by the backend exactly as `modoki_import_file` decides it (`/api/import-identity`
 *  → `importedAssetBytes`); anything else unchanged, without a round trip. `{error}` with the route's reason when the
 *  backend could not answer (#1824 — it was a console line and `null`) — the caller must NOT fall back to the dropped
 *  bytes, which carry the source's id: written as they are, a copy of an asset already in the project claims its guid,
 *  and the scanner's heal keeps it for whichever path sorts first.
 *
 *  `claimed` is ONE batch's decided ids, shared across its calls and grown by each (#1713 close-out re-review): the
 *  batch writes through `/api/write-file`, which rebuilds no manifest, so the backend cannot see the batch's earlier
 *  files — two carrying one unused id would otherwise both keep it. */
export async function importedFileBytes(dest: string, content: string, claimed: Set<string> = new Set()): Promise<{ content: string } | { error: string }> {
  if (!dest.toLowerCase().endsWith('.json')) return { content };
  const a = await postBackend('/api/import-identity', { path: dest, content, claimed: [...claimed] });
  if (!a.ok) return { error: `no identity from the backend: ${a.error}` };
  if (typeof a.body.content !== 'string') return { error: 'no identity from the backend: the answer carried no content' };
  if (typeof a.body.id === 'string') claimed.add(a.body.id);
  return { content: a.body.content };
}

/** One file `/api/prefab-member-paths` rewrote (#1751): the bytes it wrote, and the bytes it held before. */
export interface MemberPathRewrite { path: string; type: 'scene' | 'prefab'; guid?: string; text: string; prior: string }

/** What `/api/prefab-member-paths` did: rewrote (`rewritten`, with the bytes in `written`), left because an asset view
 *  holds it unsaved (`held`), and left because it changed on disk while the route waited (`changed`, #1784). */
export interface MemberPathRepair { rewritten: string[]; held: string[]; changed: string[]; written: MemberPathRewrite[] }

/** After a prefab changed from `before` in a way that moved member PATHS (#1437: an applied move),
 *  re-point the member refs stored in every OTHER scene and prefab file that uses it
 *  (`/api/prefab-member-paths`). `{error}` with the route's reason when the backend could not do it (#1824 — it was
 *  `null`, with the reason only in the console, so an agent's Apply reply said `fileRepair: {failed:true}` and no more).
 *
 *  ⚠️ The transport only. The route marks its writes as the editor's own, so no watcher event brings the client's
 *  caches along (#1751): call it through `repairMemberPathsEverywhere` (serverPrefabRewrites.ts), which adopts
 *  `written`. */
export async function requestMemberPathRepair(prefab: string, before: unknown): Promise<MemberPathRepair | { error: string }> {
  const a = await postBackend('/api/prefab-member-paths', { prefab, before });
  if (!a.ok) { console.error(`[Prefab] member refs in other files were NOT repaired: ${a.error}`); return { error: a.error }; }
  const j = a.body as { rewritten?: unknown; held?: unknown; changed?: unknown; written?: unknown };
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
}

// ── The one reader of a route's answer (#1824, Owner A of docs/refusal-reporting.md) ──────────────
//
// Every write route states why it refused, in its body. Before #1824 each client wrapper read the answer for itself —
// `res.ok`, a status, sometimes one field — so the route's reason reached neither the human nor the agent, and two
// wrappers (`reimportPaths`, `saveAiSettings`) counted a refusal as done. #1811 built this for `/api/write-file`
// alone (`readWriteRefusal`); this is that reader widened to every route, and the ONE place the verdict and the
// reason are decided on the client.

/** A route's refusal, as every client wrapper reads it.
 *
 *  - `error`: the body's `error`, else its `reason`, else its `errors`, else the HTTP status. Never empty — a caller
 *    states it as it is (R3).
 *  - `code`: the body's §5 code, RELAYED, never invented (`codeFromBody`'s rule). Absent when the route named none.
 *  - `reason`: the body's machine token (`if-match`, `unsaved`, …), for a caller that branches on it.
 *  - `conflict`: the file is not the one the caller expected, so a step must refuse rather than report a failure — an
 *    if-match or if-none-match precondition, or `prefab-mark-lowered` (#1774: the file's localId mark rose past what
 *    this write was raised to, so it is not the file the caller read). The prefab FORMAT gate's 409 is a failed
 *    write, not a conflict: nothing about the file changed, this build just may not write it.
 *  - `status`: the HTTP status; 0 when the request never got an answer (the fetch threw).
 *  - `body`: the parsed body, or null — for the few callers that read a route-specific field off a refusal. */
export interface BackendRefusal {
  ok: false; status: number; error: string; code?: string; reason?: string; conflict: boolean; options?: string[]; body: unknown;
}

/** What `readBackendAnswer` reads: a `Response`, or anything shaped like its three members that matter — a test stub or
 *  an injected `post` need not build a real `Response`. */
export type BackendResponse = Pick<Response, 'ok' | 'status'> & { json?: () => Promise<unknown> };

/** What `readBackendAnswer` answers: the route did it (with its body — a partial success's notes, `errors`, `failed`,
 *  `held`, ride in it), or it refused (`BackendRefusal`). */
export type BackendAnswer = { ok: true; status: number; body: Record<string, unknown> } | BackendRefusal;

const CONFLICT_REASONS: ReadonlySet<unknown> = new Set(['if-match', 'if-none-match', 'prefab-mark-lowered']);

/** Read any route's answer (R2 + R3).
 *
 *  `verdict: 'body'` (the default, for a MUTATING route, where `ok` is a success flag): a non-2xx is a refusal, and
 *  so is a 2xx whose body `failureDetail` flags — `ok:false`, or `errors`/`error` without an explicit `ok:true`. An
 *  explicit `ok:true` with notes is a success. This is the agent side's `isFailureBody` rule; both read the one
 *  definition in `failureBody.ts`.
 *
 *  `verdict: 'status'`: only the HTTP status decides. For a READ whose `ok:false` is the answer (`validate-prefab`,
 *  `diagnose`), exactly as the agent side's `getJson` leaves such a read un-opted — passing it through the body rule
 *  would turn an honest negative answer into a refusal.
 *
 *  A 2xx body that cannot be parsed is a success with an empty body: the route did answer 2xx, and the pre-#1824
 *  wrappers assumed exactly that (a delete whose reply is unreadable still happened). */
export async function readBackendAnswer(res: BackendResponse, opts?: { verdict?: 'body' | 'status' }): Promise<BackendAnswer> {
  // Inside a `then`, so a body that cannot be read at all (no JSON, a stub without `json`) is a null body, not a throw.
  const parsed: unknown = await Promise.resolve().then(() => res.json?.()).catch(() => null);
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  const detail = opts?.verdict === 'status' ? null : failureDetail(body);
  if (res.ok && detail === null) return { ok: true, status: res.status, body: body ?? {} };
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const errors = Array.isArray(body?.errors) ? body.errors.filter((e): e is string => typeof e === 'string') : [];
  const reason = str(body?.reason);
  const code = str(body?.code);
  const options = Array.isArray(body?.options) ? body.options.filter((o): o is string => typeof o === 'string') : [];
  const error = (res.ok ? detail : null) || str(body?.error) || reason || errors.join('; ')
    || `the request was refused (HTTP ${res.status})`;
  return {
    ok: false, status: res.status, error, conflict: res.status === 409 && CONFLICT_REASONS.has(reason), body,
    ...(code ? { code } : {}), ...(reason ? { reason } : {}), ...(options.length ? { options } : {}),
  };
}

/** The refusal for a request that never got an answer (the fetch threw). */
export function thrownRefusal(e: unknown): BackendRefusal {
  return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e), conflict: false, body: null };
}

/** `backendFetch` + `readBackendAnswer`, with a thrown fetch read as a refusal (`status` 0) — the shape a wrapper
 *  wants when it has nothing else to do with the `Response`. */
export async function callBackend(path: string, init?: RequestInit, opts?: { verdict?: 'body' | 'status' }): Promise<BackendAnswer> {
  try { return await readBackendAnswer(await backendFetch(path, init), opts); } catch (e) { return thrownRefusal(e); }
}

/** `callBackend` for a JSON POST — the shape of almost every command route. */
export function postBackend(path: string, body: unknown, opts?: { verdict?: 'body' | 'status' }): Promise<BackendAnswer> {
  return callBackend(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, opts);
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
  let r: BackendAnswer;
  try { r = await readBackendAnswer(await postWriteFile(filePath, content, encoding)); } catch (e) { r = thrownRefusal(e); }
  if (r.ok) return { ok: true };
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
 *  server error, with the route's reason (#1811). What counts as a conflict is `readBackendAnswer`'s one answer, the
 *  same one `prefabCommit`'s writes read. */
export async function writeAssetFileGuarded(
  filePath: string, content: string,
  opts: { encoding?: 'base64' } & ({ ifMatch: string } | { createOnly: true }),
): Promise<GuardedWriteOutcome> {
  let r: BackendAnswer;
  try {
    r = await readBackendAnswer(await postWriteFile(filePath, content, opts.encoding,
      'ifMatch' in opts ? { ifMatch: opts.ifMatch } : { createOnly: true }));
  } catch (e) { r = thrownRefusal(e); }
  if (r.ok) return { result: 'ok' };
  if (r.conflict) return { result: 'conflict', error: r.error };
  return { result: 'failed', error: r.error, ...(r.options ? { options: r.options } : {}) };
}
