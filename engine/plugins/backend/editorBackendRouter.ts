/**
 * Transport-agnostic editor backend router (ELECTRON_PLAN Phase 1).
 *
 * The ~18 JSON `/api/*` command endpoints — previously inlined as `if (req.url
 * === ...)` blocks inside the Vite middleware — extracted into pure
 * `(ctx, params) => BackendResult` handlers over a small filesystem/exec
 * interface (`BackendContext`). No capability lives only in the Vite plugin:
 * Phase 2 mounts this exact router in the Electron main process.
 *
 * Each handler is tagged with its process owner from the ownership table:
 *   M    — served entirely in main (fs/exec, no engine state)
 *   M→R  — main entry point that forwards to a renderer over the RPC channel
 *          (today: Vite HMR `requestBrowser`; Electron: IPC into the editor renderer)
 *   R→M  — depends on a renderer push (the trait schema) cached main-side
 *
 * Streaming/host-specific routes (`/api/build` SSE, `/api/exit`, static asset
 * serving) intentionally stay in the host (vite-asset-scanner.ts) — they are not
 * part of the editorBackend client call surface.
 */

import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { openInOS, revealInOS } from './osOpen';
import { readMetaSidecar, writeMetaSidecar } from '../meta-sidecar';
import { createFolderAt, moveAssetFile, duplicateAssetFile, moveToTrash } from '../asset-fs-ops';
import { getReimportHandler, getReimportTypes, type ReimportContext, type ReimportAsset } from '../reimport-registry';
import { findGamesEntry } from '../findGamesEntry';

/** Build Vite's `/@fs/<abs>` URL for an absolute path — how the dev server serves files
 *  outside its root (the open project's game.ts, the script-tree entries). Uses
 *  path.posix.join so a POSIX `/Users/x` collapses cleanly AND a Windows `C:\Users\x`
 *  becomes `/@fs/C:/Users/x` (forward slashes). A bare `'/@fs' + abs` concat produces the
 *  broken `/@fsC:\Users\x` on Windows (no separator, backslashes) — which Vite can't
 *  serve, so the editor "could not load the open project's games". */
export function toFsUrl(abs: string): string {
  return path.posix.join('/@fs/', abs.replace(/\\/g, '/'));
}
/** Inverse of toFsUrl: the absolute fs path from a `/@fs/…` URL. Slices `/@fs` (keeping
 *  the leading `/`, matching Vite), then drops the leading slash before a Windows drive
 *  letter (`/C:/x` → `C:/x`) so path.resolve doesn't mangle it. */
export function fromFsUrl(url: string): string {
  let p = url.slice('/@fs'.length);
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  return path.resolve(p);
}
import { discoverSigningTeams } from '../signingTeams';
import { toolchainStatus, writeToolchainSettings, uninstall, uninstallAll, type ToolId } from '../../toolchain';
import { loadProjectConfig, writeProjectConfig, validateBuildConfig, loadProjectUserConfig, writeProjectUserConfig } from '../load-project-config';
import { mergeProjectConfig, mergeProjectUserConfig } from '../../project-config';
import { validateSceneData, type SceneSchema } from '../../packages/modoki/src/runtime/scene/sceneValidation';
import { applyOps, type MutableScene, type MutateOp, type EntityRef } from '../../packages/modoki/src/runtime/scene/sceneMutate';
import { getAssetSchema, validateAssetData, normalizeAssetData, defaultAssetData, type AssetSchemaType } from '../../packages/modoki/src/runtime/assets/assetSchemas';
import { pruneOldTempFiles } from './tempFiles';
import { deviceConnection, type ConnectRequest } from './deviceConnection';
// Type-only — erased at runtime, so it does NOT pull the tree-shaker (and its
// vite-asset-scanner import) into this host-agnostic router.
import type { TreeShakeResult } from '../asset-tree-shaker';

/** Minimal shape of a manifest entry the router needs (structurally compatible
 *  with the scanner's AssetEntry — avoids an import cycle with the host). */
export interface ManifestEntry { path: string; type: string }
export interface Manifest { version: 2; assets: ManifestEntry[]; folders?: string[] }

/** The host (Vite middleware today, Electron main in Phase 2) supplies these —
 *  everything that depends on asset-root resolution or live server/renderer state.
 *  Everything stateless (fs helpers, exec) the handlers import directly. */
export interface BackendContext {
  projectRoot: string;
  /** The EDITOR's own root (where its node_modules live). Lets the backend serve
   *  editor-shipped runtime deps (the Basis/KTX2 transcoder) for a FLAT project
   *  that has no node_modules of its own. Optional: omitted ⇒ project-only lookup. */
  editorRoot?: string;
  /** Resolve an asset-root URL path (e.g. /games/x/assets/y.json) to an absolute
   *  path, or null if it escapes every allowed root. */
  resolveAssetPath(urlPath: string): string | null;
  /** Reverse of resolveAssetPath: absolute path → asset-root URL, or null. */
  absToAssetUrl(absPath: string): string | null;
  /** Absolute dir of the first asset root (save-dialog default location), or null. */
  firstRootDir(): string | null;
  /** Current cached asset manifest (kept fresh by the host's watcher). */
  getManifest(): Manifest;
  /** Force a fresh filesystem scan + GUID heal, returning the rebuilt manifest. */
  rebuildManifest(): Manifest;
  /** M→R forwarder: relay an op to the editor renderer and await its reply.
   *  Today: Vite HMR websocket; Electron: IPC into the editor renderer. */
  requestBrowser(op: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  /** Last trait schema the renderer pushed (R→M). undefined ⇒ ref-only validation. */
  getSchema(): SceneSchema | undefined;
  /** Mark a file as an editor's own write so the watcher skips the hot-reload
   *  broadcast (Cmd+S must not bounce the live scene). Pass `hash` (sha1 of the
   *  exact bytes written) so a watcher event that lands after the TTL is still
   *  recognized as a self-write while the on-disk bytes match (editor-core F9). */
  markEditorWrite(absPath: string, hash?: string | null): void;
  /** SSR module loader, used by reimport handlers for postprocessor bakes. */
  ssrLoadModule(url: string): Promise<Record<string, unknown>>;
  /** Invalidate the virtual project-config module so the next reload picks up
   *  edits (Vite module graph). No-op outside Vite. */
  invalidateProjectConfig(): void;
  /** Run the static asset tree-shaker over the open project and return the result
   *  (the `orphanDetails` list backs the editor's "Clean Up Unused Assets" dialog).
   *  Host-provided so the router stays free of the tree-shaker → scanner import
   *  cycle. */
  computeUnused(): TreeShakeResult;
}

/** What a handler returns. The host serializes it onto its response object. */
export type BackendResult =
  | { kind: 'json'; status?: number; body: unknown; headers?: Record<string, string> }
  | { kind: 'raw'; status?: number; contentType: string; body: string | Buffer; headers?: Record<string, string> }
  // A file on disk, streamed to the client (not buffered into memory) — for
  // tens-of-MB assets (GLB/HDR/KTX2) on the single-threaded, in-process backend.
  | { kind: 'file'; status?: number; contentType: string; path: string; headers?: Record<string, string> };

/** Parsed request the host hands to the router. `body` is the JSON-parsed POST
 *  payload (undefined for GET or empty body). */
export interface BackendRequest {
  method: string;
  /** Path only (no query string), e.g. "/api/write-file". */
  urlPath: string;
  query: URLSearchParams;
  body: unknown;
}

const json = (body: unknown, status?: number): BackendResult => ({ kind: 'json', status, body });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Decode a `data:image/…;base64,…` URL (the renderer's render_scene result) to a
 *  temp file, returning its path — so an agent receives a path, never an inline
 *  image (which would bloat its context). Mirrors capture_viewport's path return. */
let renderSeq = 0;
function writeDataUrlToTemp(dataUrl: unknown): string {
  if (typeof dataUrl !== 'string') throw new Error('renderer returned no frame');
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('renderer returned a non-data-URL frame');
  const ext = m[1] === 'image/png' ? 'png' : m[1] === 'image/webp' ? 'webp' : 'jpg';
  const file = path.join(os.tmpdir(), `modoki-render-${process.pid}-${renderSeq++}.${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

/** Atomic JSON write: tmp file + rename. (Mirrors the scanner's helper; kept
 *  local to avoid an import cycle.) */
function writeJsonAtomic(absPath: string, data: unknown): void {
  const tmp = absPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, absPath);
}

// ── Source-file (script) browsing for the in-browser code editor ──────────────
// Scripts (.ts/.tsx/.js/…) live OUTSIDE the asset roots (game.ts, setup.ts,
// runtime/**) and are deliberately NOT asset-manifest entries (the scanner drops
// them, so they get no GUID/.meta.json and never bake into assets.manifest.json).
// The code-editor panel browses them via /api/scripts/tree and reads/writes them
// by the /@fs/<abs> form (the same unambiguous path /api/write-file accepts).
// Two roots: the project working copy (writable) and the engine source
// (read-only — gives Monaco go-to-definition into engine internals).
const SCRIPT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
// Dirs never worth walking for source: deps, build output, vcs, native shells,
// machine-local editor state. Mirrors the scanner's ignore intent.
const SCRIPT_IGNORE_DIRS = new Set(['node_modules', 'dist', '.git', '.modoki', 'ios', 'android', 'build', 'DerivedData', '.vite', 'coverage']);
const SCRIPT_WALK_CAP = 4000; // safety cap against a pathological tree

interface ScriptFile { rel: string; path: string; name: string }

/** What the renderer's `enact-handles` op returns. Only the fields the router summarizes
 *  on are named; everything else (viewport, the occlusion counters) rides through. */
interface HandlesResponse { handles?: Array<{ editor?: string; kind?: string }>; [k: string]: unknown }

/** Recursively collect source files under `rootAbs`: `rel` is the root-relative
 *  POSIX path (for folder-tree building + display), `path` is the /@fs/<abs>
 *  form for read-file/write-file. Prunes ignored + dotfile dirs; capped. */
function walkScripts(rootAbs: string): ScriptFile[] {
  const out: ScriptFile[] = [];
  const walk = (dirAbs: string): void => {
    if (out.length >= SCRIPT_WALK_CAP) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (out.length >= SCRIPT_WALK_CAP) return;
      if (e.name.startsWith('.')) continue; // dotfiles + dotdirs
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) {
        if (!SCRIPT_IGNORE_DIRS.has(e.name)) walk(abs);
      } else if (e.isFile() && SCRIPT_EXTS.has(path.extname(e.name))) {
        out.push({ rel: path.relative(rootAbs, abs).split(path.sep).join('/'), path: toFsUrl(abs), name: e.name });
      }
    }
  };
  if (fs.existsSync(rootAbs)) walk(rootAbs);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/** The engine's own source root (read-only reference), or null if editorRoot
 *  isn't known. Same path on every host — editorRoot is the repo root. */
function engineSrcRoot(ctx: BackendContext): string | null {
  if (!ctx.editorRoot) return null;
  const dir = path.join(ctx.editorRoot, 'engine', 'packages', 'modoki', 'src');
  return fs.existsSync(dir) ? dir : null;
}

/** Resolve a client-supplied source path (the /@fs/<abs> form, or relative to
 *  the project root) to an absolute path, gated to within one of the allowed
 *  roots. The project working copy is writable; engine source is read-only.
 *  Returns null on escape (path traversal out of every root). */
function resolveSourcePath(ctx: BackendContext, p: string): { abs: string; writable: boolean } | null {
  if (!p) return null;
  const abs = p.startsWith('/@fs/') ? fromFsUrl(p) : path.resolve(ctx.projectRoot, p);
  const within = (root: string): boolean => {
    const rel = path.relative(root, abs);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  if (within(ctx.projectRoot)) return { abs, writable: true };
  const eng = engineSrcRoot(ctx);
  if (eng && within(eng)) return { abs, writable: false };
  return null;
}

/**
 * Dispatch a backend request. Returns a BackendResult, or `null` if the path is
 * not a router-owned `/api/*` route (the host then handles it or calls next()).
 */
export async function handleBackendRequest(ctx: BackendContext, req: BackendRequest): Promise<BackendResult | null> {
  const { method, urlPath, query, body } = req;

  // ── GET /api/scan-assets, GET /assets.manifest.json (M) ──
  // Both serve the cached manifest — single source of truth for the asset panel
  // and the runtime guid resolver. `no-store`: this dev/editor manifest changes
  // per open project, and the URL carries no cache-bust in dev — without it a
  // SOFT renderer reload (project switch, `webContents.reload`) can serve the
  // PREVIOUS project's manifest from the HTTP cache, so new GUIDs never register
  // and textures fail to load until a manual hard reload. Production serves the
  // baked dist manifest via static hosting, not this route, so this is dev-only.
  if ((urlPath === '/api/scan-assets' || urlPath === '/assets.manifest.json') && method === 'GET') {
    return { kind: 'json', body: ctx.getManifest(), headers: { 'Cache-Control': 'no-store' } };
  }

  // ── GET/POST /api/rescan-assets (M) ── force a fresh scan + GUID heal.
  if (urlPath === '/api/rescan-assets') {
    return json(ctx.rebuildManifest());
  }

  // ── GET /api/reimport-types ── the asset types the server has a re-import
  // handler registered for. The editor derives its re-import gating from this
  // instead of a hardcoded client constant, so server + client can't drift on
  // which types are re-importable. (editor-panels F9.)
  if (urlPath === '/api/reimport-types' && method === 'GET') {
    return json({ types: getReimportTypes() });
  }

  // ── GET /api/project-games (editor) ── the open project's game registry as a
  // RUNTIME-importable URL, so the editor loads games at runtime (the transport
  // that C4c repoints at external projects) instead of the build-time
  // virtual:modoki-games. Dev serves the registry file via Vite's /@fs/; a
  // packaged editor will repoint this at a project Vite server (C4c-2). Consumed
  // only by the dev editor today (the renderer falls back to the baked module
  // when import.meta.hot is absent).
  if (urlPath === '/api/project-games' && method === 'GET') {
    const entry = findGamesEntry(ctx.projectRoot);
    if (!entry) return json({ url: null, error: `no game.ts in ${ctx.projectRoot}` }, 404);
    return json({ url: toFsUrl(entry.path), kind: entry.kind });
  }

  // ── GET /api/scene-state[?trait=&id=] (M→R) ── dump the LIVE ECS world by
  // relaying to the renderer. Proves an edit took effect without a screenshot.
  if (urlPath === '/api/scene-state' && method === 'GET') {
    const params: { trait?: string; id?: number; guid?: string; name?: string; where?: string; full?: boolean; resources?: boolean; limit?: number; world?: boolean; bounds?: boolean; contacts?: boolean; precision?: number } = {};
    const trait = query.get('trait');
    const id = query.get('id');
    const guid = query.get('guid');
    const name = query.get('name');
    const where = query.get('where');
    if (trait) params.trait = trait;
    if (guid) params.guid = guid;
    if (name) params.name = name;
    if (where) params.where = where;
    if (query.get('full') === '1' || query.get('full') === 'true') params.full = true;
    if (query.get('resources') === '1' || query.get('resources') === 'true') params.resources = true;
    if (query.get('world') === '1' || query.get('world') === 'true') params.world = true;
    if (query.get('bounds') === '1' || query.get('bounds') === 'true') params.bounds = true;
    if (query.get('contacts') === '1' || query.get('contacts') === 'true') params.contacts = true;
    const limit = query.get('limit');
    if (limit != null && limit !== '') {
      const n = Number(limit);
      if (Number.isNaN(n) || n < 0) return json({ error: `invalid limit (not a non-negative number): ${limit}` }, 400);
      params.limit = Math.floor(n); // whole entities only — echoed value matches what's returned
    }
    // Significant digits for agent-facing floats (default 9). 0 = exact float64.
    const precision = query.get('precision');
    if (precision != null && precision !== '') {
      const n = Number(precision);
      if (Number.isNaN(n) || n < 0) return json({ error: `invalid precision (not a non-negative number): ${precision}` }, 400);
      params.precision = Math.floor(n);
    }
    if (id != null && id !== '') {
      const n = Number(id);
      if (Number.isNaN(n)) return json({ error: `invalid id (not a number): ${id}` }, 400);
      params.id = n;
    }
    try {
      const result = await ctx.requestBrowser('scene-state', params);
      return json(result);
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 504);
    }
  }

  // ── GET /api/console-logs[?level=&limit=&since=] (M→R) ── dump the renderer's
  // recent console output (error/warn/log ring buffer) by relaying to the
  // browser. Lets tooling read editor errors (failed scene/mesh loads, etc.)
  // without a devtools/MCP attach — the curl-able sibling of /api/scene-state.
  if (urlPath === '/api/console-logs' && method === 'GET') {
    const params: { level?: string; limit?: number; since?: number } = {};
    const level = query.get('level');
    const limit = query.get('limit');
    const since = query.get('since');
    if (level) params.level = level;
    // NaN-guard, like the /api/journal and /api/editor-journal siblings. `?limit=abc` would
    // otherwise pass NaN through to the op's tail: `NaN ?? 50` is NaN (nullish coalescing does
    // not catch NaN), `length > NaN` is false, so the tail silently returns the WHOLE 500-entry
    // ring — the exact flood the default exists to prevent. `?since=abc` is worse: every
    // `ts > NaN` is false, so it returns zero logs and hides real errors.
    if (limit != null && limit !== '' && !Number.isNaN(Number(limit))) params.limit = Number(limit);
    if (since != null && since !== '' && !Number.isNaN(Number(since))) params.since = Number(since);
    try {
      const result = await ctx.requestBrowser('console-logs', params);
      return json(result);
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 504);
    }
  }

  // ── GET /api/journal[?type=&clear=1] (M→R) ── the tick-stamped game-event trace
  // (emit/journalEvents) — verify game LOGIC (match/score/win) without screenshots.
  if (urlPath === '/api/journal' && method === 'GET') {
    const params: { type?: string; clear?: boolean; limit?: number; action?: 'start' | 'stop' } = {};
    const type = query.get('type');
    if (type) params.type = type;
    const action = query.get('action');
    if (action === 'start' || action === 'stop') params.action = action;
    if (query.get('clear') === '1' || query.get('clear') === 'true') params.clear = true;
    const jLimit = query.get('limit');
    if (jLimit != null && jLimit !== '' && !Number.isNaN(Number(jLimit))) params.limit = Number(jLimit);
    try { return json(await ctx.requestBrowser('journal-events', params)); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 504); }
  }

  // ── GET /api/resolve-refs?refs=a,b,244 (M→R) ── resolve journal/contact refs (GUIDs
  // and/or numeric ids) to entity display names — the deliberate second hop that keeps
  // names OUT of the journal stream. Resolves despawned entities too (emit-time side-table).
  if (urlPath === '/api/resolve-refs' && method === 'GET') {
    const refs = (query.get('refs') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    try { return json(await ctx.requestBrowser('resolve-refs', { refs })); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 504); }
  }

  // ── GET /api/game-introspect (M→R) ── discoverable dispatchable actions (+ param
  // schemas) and live named read-values, so an agent knows what it can trigger/read.
  if (urlPath === '/api/game-introspect' && method === 'GET') {
    try { return json(await ctx.requestBrowser('game-introspect', {})); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 504); }
  }

  // ── GET /api/layout-bounds[?layer=&ids=&entities=&overlaps=] (M→R) ── numeric screen-space
  // rects per entity (UI DOM rects + projected 2D/3D) + overlap/off-screen flags, so an agent
  // verifies layout WITHOUT a screenshot. Untargeted ⇒ counts only (the rects and the O(n²)
  // pair list are opt-in); see docs/mcp-response-budget.md Phase 4.
  if (urlPath === '/api/layout-bounds' && method === 'GET') {
    const params: { layer?: string; ids?: number[]; entities?: boolean; overlaps?: boolean; limit?: number; precision?: number } = {};
    const layer = query.get('layer');
    const ids = query.get('ids');
    if (layer) params.layer = layer;
    if (ids) params.ids = ids.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    if (query.get('entities')) params.entities = true;
    if (query.get('overlaps')) params.overlaps = true;
    const lbLimit = query.get('limit');
    if (lbLimit != null && lbLimit !== '' && !Number.isNaN(Number(lbLimit))) params.limit = Number(lbLimit);
    const lbPrec = query.get('precision');
    if (lbPrec != null && lbPrec !== '' && !Number.isNaN(Number(lbPrec))) params.precision = Number(lbPrec);
    try { return json(await ctx.requestBrowser('layout-bounds', params)); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 504); }
  }

  // ── GET /api/enact-handles[?editor=&kind=&ids=] (M→R) ── numeric handle geometry
  // (Enact Phase 2): the draggable handles the Canvas2D/SVG authoring editors offer
  // right now, in viewport CSS px, so drag-handle/tap-handle can aim without pixels. ──
  if (urlPath === '/api/enact-handles' && method === 'GET') {
    const params: { editor?: string; kind?: string; ids?: string[] } = {};
    const editor = query.get('editor');
    const kind = query.get('kind');
    const ids = query.get('ids');
    if (editor) params.editor = editor;
    if (kind) params.kind = kind;
    if (ids) params.ids = ids.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const res = await ctx.requestBrowser('enact-handles', params) as HandlesResponse;
      // Summarize HERE, not at the `enact-handles` op: `inputRoutes.ts` calls that op
      // directly (`requestRenderer('enact-handles', {ids:[id]})`) to resolve tap_handle /
      // drag_handle coordinates, so an op-level summary would break trusted input. The
      // router is the agent's boundary; the op is an internal service.
      //
      // A bare call with a Dopesheet open enumerates every key of every track (no windowing
      // in DopesheetView) — ~374 bytes/handle, so 2,000 keys ≈ 187k tokens. Untargeted now
      // reports per-editor/per-kind counts; the geometry needs an editor/kind/ids filter.
      const bare = !editor && !kind && !(params.ids?.length);
      if (bare && res && Array.isArray(res.handles)) {
        const byEditor: Record<string, number> = {};
        const byKind: Record<string, number> = {};
        for (const h of res.handles) {
          byEditor[h.editor ?? '?'] = (byEditor[h.editor ?? '?'] ?? 0) + 1;
          byKind[h.kind ?? '?'] = (byKind[h.kind ?? '?'] ?? 0) + 1;
        }
        // Keep every diagnostic counter. `occludedCount:0` only means "all clickable" when
        // `occlusionUnchecked` is 0 too — dropping either would make the pair a lie.
        const { handles: _handles, ...meta } = res;
        return json({
          ...meta,
          byEditor,
          byKind,
          hint: res.handles.length
            ? 'Counts only. Pass editor=<name>, kind=<name>, or ids=[…] for handle geometry (x/y/rect).'
            : 'No handles: open the relevant editor + enter its sub-mode first (e.g. scene_view_mode ui + collider_edit on).',
        });
      }
      return json(res);
    } catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 504); }
  }

  // ── GET /api/diagnose (M→R) ── structured render/scene health report (Phase F). ──
  if (urlPath === '/api/diagnose' && method === 'GET') {
    try { return json(await ctx.requestBrowser('diagnose', {})); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 504); }
  }

  // ── Device connection (M) — the Modoki-owned lease to a physical device. ──
  // A DELIBERATE, human-initiated connection (AI panel Connect button), NOT auto-discovery:
  // one connection per backend process → one per clone. The manager holds the lease GUID +
  // pings + auto-reconnects; Claude's device_* tools proxy through the backend once connected.
  // See docs/debug-tools-mcp.md.
  if (urlPath === '/api/device/status' && method === 'GET') {
    return json(deviceConnection.status());
  }
  if (urlPath === '/api/device/connect' && method === 'POST') {
    const b = (body ?? {}) as ConnectRequest;
    try { return json(await deviceConnection.connect({ ip: b.ip, useAdb: b.useAdb, port: b.port })); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 500); }
  }
  if (urlPath === '/api/device/disconnect' && method === 'POST') {
    try { return json(await deviceConnection.disconnect()); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 500); }
  }
  // Data plane: proxy a device request (eval/screenshot/tap/…) through Modoki's held lease socket.
  if (urlPath === '/api/device/request' && method === 'POST') {
    const b = (body ?? {}) as { method?: string; params?: Record<string, unknown> };
    if (!b.method) return json({ error: 'method required' }, 400);
    try { return json({ result: await deviceConnection.proxy(b.method, b.params ?? {}) }); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 502); }
  }

  // ── Percept Watch (M→R) ── standing numeric time-series over the live world. ──
  if (urlPath === '/api/watch/start' && method === 'POST') {
    try { return json(await ctx.requestBrowser('watch-start', body ?? {})); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 504); }
  }
  if (urlPath === '/api/watch/read' && method === 'GET') {
    const readLimit = query.get('limit');
    const params = {
      id: query.get('id') ?? '',
      clear: query.get('clear') === '1' || query.get('clear') === 'true',
      // Raw time-series are ~40 chars/sample and the caps allow 512 series × 5000 samples.
      // Stats-only by default; opt in when you actually need the curve.
      samples: query.get('samples') === '1' || query.get('samples') === 'true',
      // Read-side filters (Batch 3 D) — isolate a series in a broad watch.
      ...(query.get('name') ? { name: query.get('name')! } : {}),
      ...(query.get('guids') ? { guids: query.get('guids')!.split(',').map((g) => g.trim()).filter(Boolean) } : {}),
      ...(readLimit != null && readLimit !== '' && !Number.isNaN(Number(readLimit)) ? { limit: Number(readLimit) } : {}),
      // Significant digits for the stats/series floats (default 9); 0 = exact.
      ...(query.get('precision') != null && query.get('precision') !== '' && !Number.isNaN(Number(query.get('precision')))
        ? { precision: Number(query.get('precision')) } : {}),
    };
    try {
      const result = await ctx.requestBrowser('watch-read', params);
      // A read of an unknown / auto-expired watch answers {ok:false,error} — return it at 404 so
      // the MCP GET path (getJson, which only fails on status>=400 and does NOT run isFailureBody)
      // surfaces it as a tool failure instead of a "successful" empty result an agent misreads as
      // "the value never moved". (C7 re-audit.)
      if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) return json(result, 404);
      return json(result);
    }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 504); }
  }
  if (urlPath === '/api/watch/list' && method === 'GET') {
    try { return json(await ctx.requestBrowser('watch-list', {})); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 504); }
  }
  if (urlPath === '/api/watch/clear' && method === 'POST') {
    try { return json(await ctx.requestBrowser('watch-clear', body ?? {})); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 504); }
  }

  // ── POST /api/render-scene (M→R) ── deterministic offscreen render of the live
  // scene (caller-chosen size + camera), relayed to the renderer, decoded to a
  // temp file. Window-independent + reproducible (vs capture_viewport's window
  // screenshot). Body: {width?, height?, quality?, camera?:{position?,target?,fov?}}.
  if (urlPath === '/api/render-scene' && method === 'POST') {
    pruneOldTempFiles('modoki-render-'); // drop stale frames from prior sessions
    try {
      const result = await ctx.requestBrowser('render-scene', body ?? {}, 15000) as { width: number; height: number; dataUrl: string };
      return json({ path: writeDataUrlToTemp(result.dataUrl), width: result.width, height: result.height });
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 504);
    }
  }

  // ── POST /api/render-sequence (M→R) ── N offscreen frames sampled over wall
  // clock at `fps`, for motion checks (the live animation advances between
  // frames). Body adds {frames?, fps?} to render-scene's. Returns frame paths.
  if (urlPath === '/api/render-sequence' && method === 'POST') {
    const b = (body ?? {}) as { frames?: number; fps?: number; width?: number; height?: number; quality?: number; camera?: unknown };
    const frames = Math.max(1, Math.min(Math.round(b.frames ?? 8), 120));
    const fps = Math.max(1, Math.min(b.fps ?? 10, 60));
    const frameOpts = { width: b.width, height: b.height, quality: b.quality, camera: b.camera };
    const paths: string[] = [];
    pruneOldTempFiles('modoki-render-'); // sweep once before the sequence (new frames are kept)
    try {
      for (let i = 0; i < frames; i++) {
        const result = await ctx.requestBrowser('render-scene', frameOpts, 15000) as { dataUrl: string };
        paths.push(writeDataUrlToTemp(result.dataUrl));
        if (i < frames - 1) await sleep(1000 / fps);
      }
      return json({ paths, frames: paths.length, fps });
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e), framesWritten: paths.length, paths }, 504);
    }
  }

  // ── GET /api/trait-schema (M, data from the R→M schema push) ── the live trait
  // registry (valid trait names + field types) the renderer pushed. Backs the MCP
  // list_traits tool so an agent knows which trait fields are settable.
  if (urlPath === '/api/trait-schema' && method === 'GET') {
    const schema = ctx.getSchema();
    return json({ schemaAvailable: !!schema, traits: schema?.traits ?? {} });
  }

  // ── GET /api/validate-scene?path= (M, schema-dependent via R→M push) ──
  if (urlPath === '/api/validate-scene' && method === 'GET') {
    const scenePath = query.get('path');
    try {
      const absPath = scenePath ? ctx.resolveAssetPath(scenePath) : null;
      if (!absPath || !fs.existsSync(absPath)) return json({ error: `scene not found: ${scenePath}` }, 404);
      const data = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
      const schema = ctx.getSchema();
      const result = validateSceneData(data, schema);
      return json({ path: scenePath, schemaApplied: result.schemaApplied, schemaAvailable: !!schema, warnings: result.warnings });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

/**
 * C7 — say WHY a ref didn't resolve, instead of implying it doesn't exist.
 *
 * `applyOps` only sees the scene FILE. The live world is where create_entity/duplicate/
 * prefab put things, and nothing auto-saves — so the single most common cause of "no entity
 * matching" is an entity that exists RIGHT NOW but hasn't been serialized. Ask the renderer
 * and tell the agent the actionable truth: save first.
 *
 * Probes each ref with a TARGETED query, one at a time. A BARE `scene-state` would be wrong
 * in two ways that both manufacture a NEW lie ("really is absent") in the function written to
 * stop lying: the untargeted index DROPS resource entities (`all.filter(e => !e.isResource)`)
 * and is CAPPED at DEFAULT_INDEX_LIMIT. Targeting opts back into the uncapped,
 * resource-inclusive path — which is exactly why those params exist.
 *
 * Best-effort by construction: no editor connected (headless curl / pure runtime) → no hint,
 * and the plain error stands. It must never turn a mutate into a 500.
 */
async function describeUnresolvedAgainstLiveWorld(
  ctx: BackendContext,
  unresolved: EntityRef[],
): Promise<string | null> {
  /** Is THIS ref live? Targeted probe ⇒ uncapped + includes resource entities. */
  const isLive = async (ref: EntityRef): Promise<boolean | null> => {
    const params = ref.guid
      ? { where: `EntityAttributes.guid=${ref.guid}` }
      : ref.id != null
        ? { id: ref.id }
        : { name: ref.name };
    const r = (await ctx.requestBrowser('scene-state', params, 2000)) as
      | { entities?: Array<{ name?: string }>; entityCount?: number }
      | null;
    if (!r || !Array.isArray(r.entities)) return null; // no editor to ask
    // `name` is a CONTAINS match in dumpSceneState, so re-check it exactly — a partial hit
    // would claim a DIFFERENT entity is "the one you meant, just unsaved".
    if (ref.name != null) return r.entities.some((e) => e.name === ref.name);
    return r.entities.length > 0;
  };

  try {
    const verdicts = await Promise.all(unresolved.map(async (ref) => ({ ref, live: await isLive(ref) })));
    if (verdicts.every((v) => v.live === null)) return null; // couldn't ask about any of them
    const liveOnly = verdicts.filter((v) => v.live === true).map((v) => v.ref);
    if (liveOnly.length === 0) {
      // Only say this for refs we actually CHECKED — never infer absence from a failed probe.
      if (verdicts.some((v) => v.live === null)) return null;
      return `None of these refs exist in the live world either — the entity really is absent (check the guid, or the scene path: this edits the FILE, not whatever is open).`;
    }
    const which = liveOnly.map((r) => JSON.stringify(r)).join(', ');
    return (
      `${liveOnly.length} of these refs DO exist in the live editor world right now (${which}) ` +
      `but are not in the scene file yet — the editor has unsaved changes (e.g. from ` +
      `create_entity / duplicate_entity / prefab, which edit the live world and do NOT save). ` +
      `This route edits the FILE. Run modoki_save_all, then retry.`
    );
  } catch {
    return null; // no renderer to ask — the plain error is the best we can honestly say
  }
}

  // ── POST /api/scene-mutate {path, ops} (M) ── validated setTrait/addEntity/
  // removeEntity, then atomic write. The watcher broadcasts the change.
  if (urlPath === '/api/scene-mutate' && method === 'POST') {
    try {
      const { path: scenePath, ops, returnScene } = (body ?? {}) as { path: string; ops: MutateOp[]; returnScene?: boolean };
      // Validate `path` like we validate `ops`. Omitted, this reached resolveAssetPath(undefined)
      // and threw a raw "Cannot read properties of undefined (reading 'startsWith')" — and
      // CLAUDE.md advertises this endpoint for browser-free curl editing, so that TypeError is
      // what a user hitting it by hand actually got. (C7)
      if (typeof scenePath !== 'string' || !scenePath) {
        return json({ error: "path is required (the scene FILE to edit, e.g. '/assets/scenes/main.json'). Use /api/editor-state to find the active scene." }, 400);
      }
      const absPath = ctx.resolveAssetPath(scenePath);
      if (!absPath) return json({ error: 'path outside allowed directories' }, 403);
      if (!fs.existsSync(absPath)) return json({ error: `scene not found: ${scenePath}` }, 404);
      if (!Array.isArray(ops)) return json({ error: 'ops must be an array' }, 400);
      // Refuse while the editor is Playing/Paused: the edit would hot-reload the
      // live world but Stop reverts to the Play-press snapshot, silently discarding
      // it (see agentBridge scene-reload suppression). Ask the renderer for its play
      // state; if there's no editor to ask (relay throws / unknown op / pure game
      // runtime), proceed — there's no snapshot that could clobber the edit.
      try {
        const st = (await ctx.requestBrowser('editor-state', {}, 2000)) as { playState?: string; unsavedChanges?: boolean } | null;
        const playState = st?.playState;
        if (playState === 'playing' || playState === 'paused') {
          return json({
            error: `game is ${playState} — stop the game (press Stop) before editing the scene; edits during Play are discarded on Stop`,
            playState,
          }, 409);
        }
        // Refuse when the editor has UNSAVED live work — entities created via create_entity /
        // duplicate_entity / prefab that are not in the scene file yet. This route edits the FILE, and
        // the resulting disk hot-reload rebuilds the live world FROM that file, silently DESTROYING
        // those unsaved entities while the tool reported ok:true, changed:N. Save first, then the reload
        // is lossless. Mirrors the load_scene / new_scene guardUnsaved sibling. (F3)
        if (st?.unsavedChanges === true) {
          return json({
            ok: false,
            error: `the editor has unsaved live changes (entities created via create_entity / duplicate_entity / prefab are not in the scene file yet). This route edits the FILE, and the write hot-reloads the scene — which would DISCARD that unsaved work. Run modoki_save_all first, then retry.`,
            unsavedChanges: true,
          }, 409);
        }
      } catch { /* no editor connected — headless file edit, safe to proceed */ }
      const scene = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as MutableScene;
      const { changed, errors, warnings: opWarnings, unresolved } = applyOps(scene, ops);
      // ── C7: "no entity matching {guid}" was a LIE. ──
      // This route edits the scene FILE; create_entity/duplicate/prefab edit the LIVE world
      // and don't save. So a brand-new entity is real, selected, and visible — yet invisible
      // here until save_all, and the agent was told its guid didn't exist. It then re-queried
      // scene-state, got the SAME guid back, and concluded the tooling was broken.
      // applyOps is pure (file-only) and CANNOT know; this route can ASK the renderer, so
      // the explanation belongs here. One probe, only when something failed to resolve.
      const liveHint = unresolved.length ? await describeUnresolvedAgainstLiveWorld(ctx, unresolved) : null;
      // Surface BOTH the op-level warnings (dangling refs / orphaned parents from F5)
      // and the post-apply schema validation warnings.
      const schema = ctx.getSchema();
      const { warnings: schemaWarnings } = validateSceneData(scene, schema);
      const warnings = [...opWarnings, ...schemaWarnings];
      // ── C7 re-audit: a setTrait naming an UNKNOWN FIELD on a KNOWN trait is a certain typo. ──
      // applyOps merges any field name verbatim (it is schema-less), the file gets a junk field,
      // and the LOADER silently DROPS it — so the intended edit (e.g. `fontSizee`→`fontSize`) is a
      // no-op, yet ok:true + changed:1 read as success. When the schema is available we KNOW the
      // field is bogus, so make it a hard failure the agent can see. Kept narrow to avoid breaking
      // the engine's deliberate warn-but-load: an unknown TRAIT (forward-compat / a game trait the
      // editor schema lacks) and a cold start (schema undefined until the renderer connects) both
      // stay warnings, untouched — only a known trait's unknown field fails.
      const fieldTypos = new Set<string>();
      if (schema) {
        for (const op of ops as Array<{ op?: string; trait?: string; fields?: Record<string, unknown> }>) {
          if (op.op !== 'setTrait' || !op.trait || !op.fields) continue;
          const ts = schema.traits[op.trait];
          if (!ts) continue; // unknown trait → warn-but-load, not a hard error
          for (const f of Object.keys(op.fields)) if (!(f in ts.fields)) fieldTypos.add(`${op.trait}.${f}`);
        }
      }
      const typoError = fieldTypos.size
        ? `setTrait wrote unknown field(s) the loader IGNORES (likely a typo — the edit did NOT take effect): ${[...fieldTypos].join(', ')}. List the trait's real fields with modoki_list_traits {name:"<Trait>"}.`
        : null;
      const allErrors = typoError ? [...errors, typoError] : errors;
      // Only persist when at least one op succeeded — a structural-op error
      // (entity-not-found) leaves the file untouched so a typo is a no-op.
      if (changed > 0) writeJsonAtomic(absPath, scene);
      // Do NOT echo the scene by default. A `setTrait` always changes something, so this
      // fired on EVERY edit — ~10k tokens of agent context per call, on the hottest write
      // path, and nobody read it. It is also the wrong data: this is the pre-expansion
      // scene FILE, not the live world, so a caller verifying its edit must still ask
      // `/api/scene-state`. Opt in with `returnScene` if you genuinely want the file back.
      return json({
        ok: allErrors.length === 0, changed, errors: allErrors, warnings,
        ...(liveHint ? { hint: liveHint } : {}),
        ...(returnScene && changed > 0 ? { scene } : {}),
      });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // ── POST /api/delete-asset {path} | {paths} (M) ── move file(s) to OS trash
  // (recoverable). Accepts a single `path` (back-compat: Hierarchy prefab delete,
  // model-import orphan prune) OR a `paths` list. The whole list is trashed in
  // ONE moveToTrash call so a multi-file delete plays a single OS trash sound
  // instead of one per file. Missing paths are skipped (not a 404) so a batch
  // carrying maybe-absent sidecars (`.meta.json`) doesn't fail wholesale.
  if (urlPath === '/api/delete-asset' && method === 'POST') {
    try {
      const { path: assetPath, paths } = (body ?? {}) as { path?: string; paths?: string[] };
      const inputs = Array.isArray(paths) ? paths : (assetPath != null ? [assetPath] : []);
      if (inputs.length === 0) return json({ error: 'No path(s) provided' }, 400);
      const resolved: string[] = [];
      const missing: string[] = [];
      for (const p of inputs) {
        const absPath = ctx.resolveAssetPath(p);
        if (!absPath) return json({ error: 'Path outside allowed directories' }, 403);
        if (!fs.existsSync(absPath)) { missing.push(p); continue; }
        resolved.push(absPath);
      }
      // Single-path back-compat: a lone non-existent target is still a 404.
      if (resolved.length === 0 && !Array.isArray(paths)) return json({ error: 'File not found' }, 404);
      if (resolved.length > 0) moveToTrash(resolved);
      return json({ ok: true, trashed: resolved.length, missing });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── GET /api/unused-assets (M) ── run the static asset tree-shaker over the
  // open project and report the orphans (files on disk no scene/prefab reaches).
  // Backs the editor's "Clean Up Unused Assets" dialog: the client lists these,
  // the user checks which to remove, and delete happens via /api/delete-asset
  // (OS trash, recoverable). Same reachability walk the prod build uses to drop
  // unshipped assets, so "unused" here == "would be tree-shaken out of the build".
  if (urlPath === '/api/unused-assets' && method === 'GET') {
    try {
      const result = ctx.computeUnused();
      // Only offer the PROJECT's own assets for deletion. The shaker also walks
      // the engine's shared `/modoki/assets` root (built-in fonts/HDRs served to
      // every project) — those resolve OUTSIDE projectRoot and are engine-owned,
      // so a game-cleanup action must never trash them (it'd dirty the engine repo
      // and starve other projects). Filter by resolved-abs-under-projectRoot rather
      // than a hardcoded prefix, so flat (`/assets`) and multi-game
      // (`/games/<id>/assets`) roots both pass and only the engine root is dropped.
      const rootWithSep = ctx.projectRoot.endsWith(path.sep) ? ctx.projectRoot : ctx.projectRoot + path.sep;
      const inProject = (o: { path: string }): boolean => {
        const abs = ctx.resolveAssetPath(o.path);
        return !!abs && (abs === ctx.projectRoot || abs.startsWith(rootWithSep));
      };
      // Largest first — the reclaimable-space wins are what the user scans for.
      const orphans = result.orphanDetails.filter(inProject).sort((a, b) => b.bytes - a.bytes);
      const totalBytes = orphans.reduce((sum, o) => sum + o.bytes, 0);
      return json({
        orphans,
        totalBytes,
        sceneCount: result.stats.scenes,
        // Drop warnings about the engine root we filtered out — they'd be noise here.
        warnings: result.warnings,
      });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // ── GET /api/exists?path= (M) ── file existence probe (Vite's SPA fallback
  // makes `fetch(path).ok` useless client-side).
  if (urlPath === '/api/exists' && method === 'GET') {
    const assetPath = query.get('path') || '';
    const resolved = ctx.resolveAssetPath(assetPath);
    return json({ exists: !!resolved && fs.existsSync(resolved) });
  }

  // ── POST /api/save-dialog (M, native) ── macOS "Save As" panel. Returns the
  // chosen location as an asset-root URL path.
  if (urlPath === '/api/save-dialog' && method === 'POST') {
    try {
      const { defaultName = 'Untitled', defaultFolder, prompt = 'Save As' } = (body ?? {}) as { defaultName?: string; defaultFolder?: string; prompt?: string };
      const startDir = (defaultFolder && ctx.resolveAssetPath(defaultFolder)) || ctx.firstRootDir();
      if (!startDir) return json({ error: 'no asset roots' }, 500);
      if (process.platform !== 'darwin') return json({ unsupported: true });
      let chosenAbs: string;
      try {
        const out = execFileSync('osascript', [
          '-e', 'on run argv',
          '-e', 'set f to choose file name with prompt (item 1 of argv) default name (item 2 of argv) default location (POSIX file (item 3 of argv))',
          '-e', 'return POSIX path of f',
          '-e', 'end run',
          prompt, defaultName, startDir,
        ], { encoding: 'utf-8' });
        chosenAbs = out.trim();
      } catch {
        // osascript exits non-zero on user cancel (-128).
        return json({ cancelled: true });
      }
      const urlPathOut = ctx.absToAssetUrl(chosenAbs);
      if (!urlPathOut) return json({ error: 'outside-asset-roots', abs: chosenAbs });
      return json({ path: urlPathOut });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── GET /api/read-meta?path= (M) ── the asset's `.meta.json`, MERGED with this
  // machine's `.meta.local.json` byte-size stats via readMetaSidecar. The inspector
  // asset views (Model/Texture/Font/Environment/Audio) read triCounts/lodBytes/
  // variantBytes/bytes from here — those keys are peeled into the gitignored local
  // sidecar (meta-sidecar.ts), so a raw read of `.meta.json` would blank those rows.
  if (urlPath === '/api/read-meta' && method === 'GET') {
    const assetPath = query.get('path') || '';
    // Outside-root and missing-asset both used to collapse to `{}` — indistinguishable from a genuine
    // "asset exists but has no sidecar", and inconsistent with /api/read-file (which 403s outside-root).
    // Fail those explicitly so a typo'd/escaped path isn't read as an empty-but-valid meta. (F10)
    if (!assetPath) return json({ error: 'path is required (an asset-root path, e.g. /assets/models/x.glb)' }, 400);
    const resolved = ctx.resolveAssetPath(assetPath);
    if (!resolved) return json({ error: `path outside allowed directories: ${assetPath}` }, 403);
    if (!fs.existsSync(resolved)) return json({ error: `asset not found: ${assetPath}` }, 404);
    // The asset exists — an empty `{}` here now unambiguously means "no sidecar", not "bad path".
    return { kind: 'raw', contentType: 'application/json', body: JSON.stringify(readMetaSidecar(resolved)) };
  }

  // ── GET /api/scripts/tree (M) ── source files for the in-browser code editor:
  // the project working copy (writable) + the engine source (read-only). NOT
  // asset-manifest entries — scripts live outside asset roots by design.
  if (urlPath === '/api/scripts/tree' && method === 'GET') {
    const roots: { label: string; rootPath: string; writable: boolean; files: ScriptFile[] }[] = [
      { label: 'Scripts', rootPath: toFsUrl(ctx.projectRoot), writable: true, files: walkScripts(ctx.projectRoot) },
    ];
    const eng = engineSrcRoot(ctx);
    if (eng) roots.push({ label: 'Engine', rootPath: toFsUrl(eng), writable: false, files: walkScripts(eng) });
    return json({ roots });
  }

  // ── GET /api/read-file?path= (M) ── raw UTF-8 contents of a source file,
  // gated to the project working copy or engine source (403 on escape).
  // Companion to /api/scripts/tree for the code editor. `X-Writable` tells the
  // client whether to open the buffer editable (engine source is read-only).
  if (urlPath === '/api/read-file' && method === 'GET') {
    const r = resolveSourcePath(ctx, query.get('path') || '');
    if (!r) return json({ error: 'path outside allowed roots' }, 403);
    if (!fs.existsSync(r.abs) || !fs.statSync(r.abs).isFile()) return json({ error: 'not found' }, 404);
    return {
      kind: 'raw', contentType: 'text/plain; charset=utf-8', body: fs.readFileSync(r.abs, 'utf-8'),
      headers: { 'Cache-Control': 'no-store', 'X-Writable': String(r.writable) },
    };
  }

  // ── POST /api/write-meta {path, meta} (M) ──
  if (urlPath === '/api/write-meta' && method === 'POST') {
    try {
      const { path: assetPath, meta } = (body ?? {}) as { path: string; meta: unknown };
      const resolved = ctx.resolveAssetPath(assetPath);
      if (!resolved) return { kind: 'raw', status: 403, contentType: 'application/json', body: '{}' };
      writeMetaSidecar(resolved, meta as Parameters<typeof writeMetaSidecar>[1]);
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── POST /api/reimport {path, recursive?} (M, exec) ── convert a source asset
  // (or every asset under a folder) into derived runtime files via the registry.
  if (urlPath === '/api/reimport' && method === 'POST') {
    try {
      const { path: target, recursive } = (body ?? {}) as { path: string; recursive?: boolean };
      const manifest = ctx.getManifest();
      const reCtx: ReimportContext = {
        projectRoot: ctx.projectRoot,
        resolveAssetPath: (p) => ctx.resolveAssetPath(p),
        ssrLoadModule: (url) => ctx.ssrLoadModule(url),
        // Load the postprocessor registry by ABSOLUTE engine-src path, not the root-relative
        // `/packages/modoki/...` URL — the latter needs the `@modoki/engine` workspace symlink,
        // which electron-builder DEREFERENCES into a real dir in the packaged app, so a model
        // reimport there silently skipped the Stage A postprocessor bake (lost procedural UVs →
        // untextured meshes). Pairs with the @modoki/engine alias in ssrLoader.ts.
        enginePkgSrc: engineSrcRoot(ctx) ?? undefined,
        // The atlas handler resolves member sprites → their parent textures. The cached
        // manifest already carries every sprite block + guid; textures' abs paths come
        // from resolveAssetPath. (ManifestEntry is narrowed to {path,type} in this
        // module's types but the runtime objects carry the full asset fields.)
        listAssets: (): ReimportAsset[] => (manifest.assets as Array<ReimportAsset & { path: string; type: string }>).map((a) => ({
          guid: a.guid, type: a.type, path: a.path,
          absPath: a.type === 'texture' ? (ctx.resolveAssetPath(a.path) ?? undefined) : undefined,
          sprite: a.sprite,
        })),
      };
      let targets: ManifestEntry[];
      if (recursive) {
        const prefix = target === '/' ? '' : target.replace(/\/+$/, '');
        targets = manifest.assets.filter((a) => a.path.startsWith(prefix + '/'));
      } else {
        targets = manifest.assets.filter((a) => a.path === target);
      }
      // No manifest asset matched the path (typo / casing / a derived or non-manifest file). With an
      // empty target list the loop is skipped and `ok` below would be `converted>0 || errors.length===0`
      // = true — a {ok:true, converted:0} indistinguishable from a real re-bake, so Claude ships a stale
      // asset. Fail loudly instead. (F4)
      if (targets.length === 0) {
        return json({ ok: false, converted: 0, skipped: 0, errors: [], error: `no manifest asset matches ${JSON.stringify(target)}${recursive ? ' (recursive)' : ''} — check the path/casing (it must be an asset-root path like /games/<id>/assets/…), or list assets first.` }, 404);
      }
      const summary = { converted: 0, skipped: 0, errors: [] as string[] };
      // Paths whose bake succeeded — pushed to the renderer below so the LIVE viewport
      // evicts its stale GPU cache without a reload. The UI "Re-import" button does this
      // client-side (assetViews/reimport.ts); routing it through the endpoint means the
      // MCP tool and the /api/reimport curl path refresh identically (no editor restart).
      const invalidate: Array<{ path: string; type: string }> = [];
      for (const a of targets) {
        const handler = getReimportHandler(a.type);
        const abs = handler ? ctx.resolveAssetPath(a.path) : null;
        if (!handler || !abs) { summary.skipped++; continue; }
        try {
          await handler(a.path, abs, reCtx); summary.converted++;
          if (a.type === 'model' || a.type === 'texture') invalidate.push({ path: a.path, type: a.type });
        }
        catch (e) { summary.errors.push(`${a.path}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      ctx.rebuildManifest(); // pick up baked import settings
      // Tell the renderer to drop the cached geometry/texture for the re-baked assets.
      // Best-effort: a headless/disconnected renderer just times out — the bake already
      // landed on disk, so a later scene load still picks it up.
      if (invalidate.length) {
        try { await ctx.requestBrowser('invalidate-assets', { items: invalidate }); }
        catch { /* no live renderer — files are on disk regardless */ }
      }
      // `ok` states this route's own verdict: a PARTIAL bake is a SUCCESS whose errors[]
      // names the assets that failed. Without it, a generic "non-empty errors[] ⇒ failure"
      // client rule (modoki-mcp's isFailureBody) reports a successful 20-of-21 reimport as a
      // failed tool call. (C7)
      const ok = summary.converted > 0 || summary.errors.length === 0;
      return json({ ...summary, ok }, ok ? 200 : 500);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── GET /api/asset-schema?type=material|particle|animation (M, host-static) ──
  // Field metadata + a valid example so an agent authors assets without guessing JSON.
  if (urlPath === '/api/asset-schema' && method === 'GET') {
    const t = query.get('type') as AssetSchemaType | null;
    if (!t) return json({ error: 'type required: material | particle | animation', types: ['material', 'particle', 'animation'] }, 400);
    const schema = getAssetSchema(t);
    return schema ? json(schema) : json({ error: `unknown asset type '${t}'` }, 400);
  }

  // ── POST /api/asset-write {path, type, data} (M) ── validated (warn-but-write)
  // write of an asset JSON file. Hard errors block; warnings are returned. Preserves
  // an existing file's `id` when the new data omits one.
  if (urlPath === '/api/asset-write' && method === 'POST') {
    try {
      const { path: assetPath, type, data } = (body ?? {}) as { path?: string; type?: AssetSchemaType; data?: unknown };
      if (!assetPath || !type) return json({ error: 'asset-write requires { path, type, data }' }, 400);
      if (!getAssetSchema(type)) return json({ error: `unknown asset type '${type}'` }, 400);
      const abs = ctx.resolveAssetPath(assetPath);
      if (!abs) return json({ error: 'path outside allowed directories' }, 403);
      const { errors, warnings } = validateAssetData(type, data);
      if (errors.length) return json({ ok: false, errors, warnings }, 400);
      const out = normalizeAssetData(type, data) as Record<string, unknown>;
      // Preserve identity: keep the existing file's id if the new doc omits one.
      // `!out.id`, NOT `out.id == null`: normalizeAssetData NORMALISES a missing id to an
      // EMPTY STRING (normalizeAnimationClip: `id: json.id ?? ''`), and '' == null is false —
      // so the preserve branch never fired for animations. The file was written with id:'',
      // readAssetGuid rejected it, and the watcher's heal minted a BRAND-NEW guid ~150ms
      // later: every scene/Animator reference to the old guid dangled and the clip silently
      // stopped loading. `write_asset` promises to preserve the id, and reported ok:true
      // while doing the opposite. (C7)
      if (out && typeof out === 'object' && !out.id && fs.existsSync(abs)) {
        try { const prev = JSON.parse(fs.readFileSync(abs, 'utf-8')); if (prev?.id) out.id = prev.id; } catch { /* ignore */ }
      }
      writeJsonAtomic(abs, out);
      return json({ ok: true, warnings, path: assetPath });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── POST /api/create-asset {type, path} (M) ── scaffold a default asset of `type`
  // (material/particle/animation) with a fresh GUID id, written to `path`.
  if (urlPath === '/api/create-asset' && method === 'POST') {
    try {
      const { type, path: assetPath } = (body ?? {}) as { type?: AssetSchemaType; path?: string };
      if (!assetPath || !type) return json({ error: 'create-asset requires { type, path }' }, 400);
      if (!getAssetSchema(type)) return json({ error: `unknown asset type '${type}'` }, 400);
      const abs = ctx.resolveAssetPath(assetPath);
      if (!abs) return json({ error: 'path outside allowed directories' }, 403);
      if (fs.existsSync(abs)) return json({ error: `destination exists: ${assetPath}` }, 409);
      const id = crypto.randomUUID();
      const data = defaultAssetData(type) as Record<string, unknown>;
      data.id = id;
      writeJsonAtomic(abs, data);
      ctx.rebuildManifest(); // register the new asset's GUID
      return json({ ok: true, path: assetPath, id });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── POST /api/write-file {path, content, encoding?} (M) ── write any file
  // under an asset root. Suppresses the watcher hot-reload for the editor's own save.
  if (urlPath === '/api/write-file' && method === 'POST') {
    try {
      const { path: filePath, content, encoding } = (body ?? {}) as { path: string; content: unknown; encoding?: string };
      // Resolve the write target. Normally an asset URL (/assets/…, /games/…)
      // via resolveAssetPath. But a flat project's scenes load through Vite's
      // /@fs/<abs> form, so the editor may hold a /@fs path (e.g. saving the
      // current scene, or a code-editor script save) — accept it, restricted to
      // within the project root so a write can't escape the project. This is
      // also the code editor's read-only guard: the engine source root lives
      // OUTSIDE projectRoot, so an engine-source /@fs path lands here as null →
      // 403. Never trust a client `writable` flag.
      let absPath: string | null;
      if (filePath.startsWith('/@fs/')) {
        const abs = fromFsUrl(filePath);
        const rel = path.relative(ctx.projectRoot, abs);
        absPath = (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) ? abs : null;
      } else {
        absPath = ctx.resolveAssetPath(filePath);
      }
      if (!absPath) return { kind: 'raw', status: 403, contentType: 'application/json', body: '{}' };
      // Materialize the exact bytes once so the self-write guard can fingerprint
      // them (the F9 late-rename fallback) and we write the identical buffer.
      const bytes = encoding === 'base64'
        ? Buffer.from(content as string, 'base64')
        : Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      ctx.markEditorWrite(absPath, crypto.createHash('sha1').update(bytes).digest('hex'));
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absPath, bytes);
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── POST /api/duplicate-asset {from, to} (M) ── copy + regenerate GUID.
  if (urlPath === '/api/duplicate-asset' && method === 'POST') {
    try {
      const { from, to } = (body ?? {}) as { from: string; to: string };
      const absFrom = ctx.resolveAssetPath(from);
      const absTo = ctx.resolveAssetPath(to);
      if (!absFrom || !absTo) return json({ error: 'Path outside allowed directories' }, 403);
      if (!fs.existsSync(absFrom)) return json({ error: 'Source not found' }, 404);
      if (fs.existsSync(absTo)) return json({ error: 'Destination exists' }, 409);
      const newGuid = duplicateAssetFile(absFrom, absTo);
      return json({ ok: true, guid: newGuid });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── POST /api/move-file {from, to} (M) ── move/rename, never clobber.
  if (urlPath === '/api/move-file' && method === 'POST') {
    try {
      const { from, to } = (body ?? {}) as { from: string; to: string };
      const absFrom = ctx.resolveAssetPath(from);
      const absTo = ctx.resolveAssetPath(to);
      if (!absFrom || !absTo) return json({ error: 'Path outside allowed directories' }, 403);
      if (!fs.existsSync(absFrom)) return json({ error: 'Source not found' }, 404);
      // Never clobber an existing asset on move/rename (renameSync would silently
      // destroy it). EXCEPT a case-only rename (e.g. Sprites→sprites): on a
      // case-insensitive FS (default macOS APFS / Windows) `fs.existsSync(absTo)` is
      // true because it resolves to the SAME entry as the source — that's not a real
      // collision, so allow it through (renameSync changes just the case). Detect "same
      // entry" by inode+device rather than string compare.
      if (fs.existsSync(absTo) && absTo !== absFrom) {
        let sameEntry = false;
        try { const a = fs.statSync(absFrom), b = fs.statSync(absTo); sameEntry = a.ino === b.ino && a.dev === b.dev; }
        catch { /* stat failed → treat as a real collision */ }
        if (!sameEntry) return json({ error: 'Destination exists' }, 409);
      }
      moveAssetFile(absFrom, absTo);
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── POST /api/create-folder {path} (M) ──
  if (urlPath === '/api/create-folder' && method === 'POST') {
    try {
      const { path: folderPath } = (body ?? {}) as { path: string };
      const absPath = ctx.resolveAssetPath(folderPath);
      if (!absPath) return json({ error: 'Path outside allowed directories' }, 403);
      if (fs.existsSync(absPath)) return json({ error: 'Folder exists' }, 409);
      createFolderAt(absPath);
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── POST /api/reveal-in-finder {path} (M, exec) ── open in OS file manager.
  if (urlPath === '/api/reveal-in-finder' && method === 'POST') {
    try {
      const { path: assetPath } = (body ?? {}) as { path: string };
      // Asset URLs (/assets, /games) resolve via the asset root; a script row
      // hands a /@fs/<abs> source path (outside the asset roots) — accept it via
      // the same project/engine-root guard the code-editor endpoints use.
      const absPath = ctx.resolveAssetPath(assetPath) ?? resolveSourcePath(ctx, assetPath)?.abs ?? null;
      if (!absPath) return json({ error: 'path outside project/engine roots' }, 403);
      await revealInOS(absPath);
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── POST /api/open-file {path} (M, exec) ── open in the OS default app/editor
  // (e.g. a script → the user's default .ts editor). Same path guard as reveal.
  if (urlPath === '/api/open-file' && method === 'POST') {
    try {
      const { path: assetPath } = (body ?? {}) as { path: string };
      const absPath = ctx.resolveAssetPath(assetPath) ?? resolveSourcePath(ctx, assetPath)?.abs ?? null;
      if (!absPath) return json({ error: 'path outside project/engine roots' }, 403);
      await openInOS(absPath);
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── POST /api/pick-path {mode, prompt?} (M, native) ── macOS folder/file
  // chooser for Project Settings path fields (icon source, SDK paths). Returns
  // the chosen path RELATIVE to the project when it lives inside it (e.g. an icon
  // under resources/), else the absolute path (e.g. a JAVA_HOME outside the repo).
  if (urlPath === '/api/pick-path' && method === 'POST') {
    try {
      const { mode = 'folder', prompt = 'Choose' } = (body ?? {}) as { mode?: 'file' | 'folder'; prompt?: string };
      if (process.platform !== 'darwin') return json({ unsupported: true });
      const chooser = mode === 'file' ? 'choose file' : 'choose folder';
      let chosenAbs: string;
      try {
        const out = execFileSync('osascript', [
          '-e', 'on run argv',
          '-e', `set f to ${chooser} with prompt (item 1 of argv)`,
          '-e', 'return POSIX path of f',
          '-e', 'end run',
          prompt,
        ], { encoding: 'utf-8' });
        chosenAbs = out.trim().replace(/\/$/, '');
      } catch {
        // osascript exits non-zero on user cancel (-128).
        return json({ cancelled: true });
      }
      const rel = path.relative(ctx.projectRoot, chosenAbs);
      const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
      return json({ path: inside ? rel : chosenAbs, abs: chosenAbs });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── GET /api/project-settings (M) ── the resolved committed config (file over
  // defaults) PLUS the per-machine user config nested under `user`, so the editor
  // sees one merged settings object. The `user` subtree round-trips back to
  // project.user.json on save (see POST below).
  if (urlPath === '/api/project-settings' && method === 'GET') {
    return json({ ...loadProjectConfig(ctx.projectRoot), user: loadProjectUserConfig(ctx.projectRoot) });
  }

  // ── POST /api/project-settings (M) ── split the merged settings object back
  // into its two files: the `user` subtree → project.user.json (gitignored,
  // per-machine), everything else → project.config.json (committed). Then
  // invalidate the virtual config module so the next reload reflects new values.
  if (urlPath === '/api/project-settings' && method === 'POST') {
    try {
      const { user: userPart, ...configPart } = (body ?? {}) as Record<string, unknown>;
      const merged = mergeProjectConfig(configPart as Parameters<typeof mergeProjectConfig>[0]);
      const mergedUser = mergeProjectUserConfig(userPart as Parameters<typeof mergeProjectUserConfig>[0]);
      // Reject shell-unsafe build fields (across both files) before they can reach a build command.
      const errors = validateBuildConfig(merged, mergedUser);
      if (errors.length) return json({ error: errors.join('; ') }, 400);
      writeProjectConfig(merged, ctx.projectRoot);
      writeProjectUserConfig(mergedUser, ctx.projectRoot);
      ctx.invalidateProjectConfig();
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── POST /api/invalidate-project-config (M) ── invalidate the cached virtual project-config
  // module so the next renderer reload re-reads fresh values. Module-only — NO page reload. It
  // exists as its own route for the Electron split (re-audit finding 4): a project_settings write
  // reaches the ELECTRON backend, but the CHILD VITE serves the renderer and holds the cached
  // module, so Electron main POSTs here to reach that Vite's module graph. On the Vite host this
  // does the invalidation directly; on the Electron host ctx.invalidateProjectConfig forwards here.
  if (urlPath === '/api/invalidate-project-config' && method === 'POST') {
    ctx.invalidateProjectConfig();
    return json({ ok: true });
  }

  // ── Editor panel layouts (M) ── machine-local working state under
  //    <project>/.modoki/layouts/<name>.layout.json. Deliberately OUTSIDE the
  //    asset tree: layouts are the user's editor preference, not engine source or
  //    project data, and the dir is gitignored (mirrors recent-projects.json).
  //    Per-project so each project remembers its own panel arrangement. `name` is
  //    slugged to prevent path traversal.
  const layoutsDir = () => path.join(ctx.projectRoot, '.modoki', 'layouts');
  const safeLayoutName = (n: unknown): string | null => {
    if (typeof n !== 'string') return null;
    const s = n.trim().replace(/\.layout\.json$/, '');
    return /^[\w-]+$/.test(s) ? s : null;
  };

  // ── GET /api/layouts ── list saved layout names for the open project.
  if (urlPath === '/api/layouts' && method === 'GET') {
    try {
      const dir = layoutsDir();
      const layouts = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith('.layout.json')).map((f) => f.replace(/\.layout\.json$/, '')).sort()
        : [];
      return json({ layouts });
    } catch (e) { return json({ error: String(e) }, 500); }
  }

  // ── GET /api/layout?name=<name> ── read one layout's JSON.
  if (urlPath === '/api/layout' && method === 'GET') {
    const name = safeLayoutName(query.get('name'));
    if (!name) return json({ error: 'invalid or missing name' }, 400);
    const file = path.join(layoutsDir(), `${name}.layout.json`);
    // 200 + null body (NOT 404) when the layout is absent. The editor probes the
    // reserved "autosave" layout on EVERY boot, and on a first load (or any project
    // that's never saved a layout) it legitimately doesn't exist — a 404 there is
    // auto-logged by the browser as a red console error on a totally normal path.
    // readLayout already treats a null body as "no layout" and falls back to default.
    if (!fs.existsSync(file)) return json(null, 200);
    try {
      return { kind: 'raw', contentType: 'application/json', body: fs.readFileSync(file, 'utf8') };
    } catch (e) { return json({ error: String(e) }, 500); }
  }

  // ── POST /api/layout {name, content} ── write a layout (content: model JSON).
  if (urlPath === '/api/layout' && method === 'POST') {
    const b = (body ?? {}) as { name?: unknown; content?: unknown };
    const name = safeLayoutName(b.name);
    if (!name) return json({ error: 'invalid or missing name' }, 400);
    try {
      const dir = layoutsDir();
      fs.mkdirSync(dir, { recursive: true });
      const data = typeof b.content === 'string' ? JSON.parse(b.content) : b.content;
      writeJsonAtomic(path.join(dir, `${name}.layout.json`), data);
      return json({ ok: true, name });
    } catch (e) { return json({ error: String(e) }, 500); }
  }

  // ── POST /api/layout-delete {name} ── remove a saved layout.
  if (urlPath === '/api/layout-delete' && method === 'POST') {
    const name = safeLayoutName((body as { name?: unknown })?.name);
    if (!name) return json({ error: 'invalid or missing name' }, 400);
    try {
      const file = path.join(layoutsDir(), `${name}.layout.json`);
      if (fs.existsSync(file)) fs.rmSync(file);
      return json({ ok: true });
    } catch (e) { return json({ error: String(e) }, 500); }
  }

  // ── AI-panel per-project settings (M) ── machine-local editor preferences for the
  //    AI/Percept surface, under <project>/.modoki/ai-settings.json (gitignored, like
  //    layouts). Currently just `captureContactOnLaunch` (auto-open the Tier-2 @contact
  //    journal watch when the GameView enters Play — see setVerboseCapture / journal tiers).
  const aiSettingsFile = () => path.join(ctx.projectRoot, '.modoki', 'ai-settings.json');
  const readAiSettings = (): Record<string, unknown> => {
    try { return JSON.parse(fs.readFileSync(aiSettingsFile(), 'utf8')) as Record<string, unknown>; }
    catch { return {}; }
  };

  // ── GET /api/ai-settings ── read the open project's AI-panel settings ({} if unset).
  if (urlPath === '/api/ai-settings' && method === 'GET') {
    return json(readAiSettings());
  }

  // ── POST /api/ai-settings {…} ── shallow-merge a patch into the settings and persist.
  if (urlPath === '/api/ai-settings' && method === 'POST') {
    try {
      const patch = (body ?? {}) as Record<string, unknown>;
      const next = { ...readAiSettings(), ...patch };
      const dir = path.join(ctx.projectRoot, '.modoki');
      fs.mkdirSync(dir, { recursive: true });
      writeJsonAtomic(aiSettingsFile(), next);
      return json(next);
    } catch (e) { return json({ error: String(e) }, 500); }
  }

  // ── GET /api/editor-state (M→R) ── the WHOLE editor UI state in one read:
  // selection, play state, gizmo mode/space, fps, entity count, editor camera
  // pose, undo/redo labels. Relayed to the renderer (the editor store + play
  // state live there). The "see everything a human sees" read.
  if (urlPath === '/api/editor-state' && method === 'GET') {
    try {
      return json(await ctx.requestBrowser('editor-state', {}));
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 504);
    }
  }

  // ── GET /api/editor-journal[?type=&since=&sinceCap=&merged=1&clear=1] (M→R) ── Editor
  // Percept: the human-activity stream (!-prefixed). merged also returns the game journal
  // + a single-axis `timeline` windowed by `sinceCap` (a shared `cap` cursor).
  if (urlPath === '/api/editor-journal' && method === 'GET') {
    const params: { type?: string; source?: string; since?: number; sinceCap?: number; merged?: boolean; clear?: boolean; limit?: number } = {};
    const type = query.get('type');
    const source = query.get('source');
    const since = query.get('since');
    const sinceCap = query.get('sinceCap');
    const ejLimit = query.get('limit');
    if (type) params.type = type;
    if (source === 'human' || source === 'agent') params.source = source;
    if (since != null && since !== '' && !Number.isNaN(Number(since))) params.since = Number(since);
    if (ejLimit != null && ejLimit !== '' && !Number.isNaN(Number(ejLimit))) params.limit = Number(ejLimit);
    if (sinceCap != null && sinceCap !== '' && !Number.isNaN(Number(sinceCap))) params.sinceCap = Number(sinceCap);
    if (query.get('merged') === '1' || query.get('merged') === 'true') params.merged = true;
    if (query.get('clear') === '1' || query.get('clear') === 'true') params.clear = true;
    try { return json(await ctx.requestBrowser('editor-journal', params)); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 504); }
  }

  // ── POST /api/editor-action {action, ...} (M→R) ── perform one editor action
  // a human can do: selection, gizmo, focus, play/stop/pause/resume/step,
  // undo/redo, scene load/new/save-all, entity create/duplicate/delete/reparent,
  // prefab instantiate/create/detach. `action` is the op name; the rest of the
  // body is the op's params. Allowlisted so the relay can't be used to invoke
  // arbitrary renderer ops. Each works in dev (HMR relay) AND the DMG (IPC relay).
  if (urlPath === '/api/editor-action' && method === 'POST') {
    const b = (body ?? {}) as { action?: string } & Record<string, unknown>;
    const action = b.action;
    if (!action || !EDITOR_ACTIONS.has(action)) {
      return json({ error: `unknown or missing editor action '${action}' (allowed: ${[...EDITOR_ACTIONS].join(', ')})` }, 400);
    }
    const { action: _omit, ...params } = b;
    try {
      // Scene/resource-touching actions (load-scene, play) can take a while — give
      // them generous headroom over the default relay timeout.
      return json(await ctx.requestBrowser(action, params, 60_000));
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 504);
    }
  }

  // ── GET /api/scenes (M) ── list the project's scene assets (guid/path/name)
  // from the cached manifest, so an agent can discover what to load-scene.
  if (urlPath === '/api/scenes' && method === 'GET') {
    const scenes = ctx.getManifest().assets
      .filter((a) => a.type === 'scene')
      .map((a) => ({ path: a.path, ...((a as { guid?: string }).guid ? { guid: (a as { guid?: string }).guid } : {}) }));
    return json({ count: scenes.length, scenes });
  }

  // ── GET /api/signing-teams (M, exec) ── list Apple developer teams usable for
  // iOS signing on THIS machine (provisioning profiles + keychain certs), so the
  // Project Settings "Apple Team ID" field can offer a "Name (ID)" dropdown
  // instead of a raw code. Best-effort + macOS-only (returns [] elsewhere).
  if (urlPath === '/api/signing-teams' && method === 'GET') {
    return json({ teams: discoverSigningTeams() });
  }

  // ── GET /api/toolchain (M) ── the Build-Support dialog's status read: every
  // build tool's detection (present/version/source) + whether it can be
  // auto-installed vs guided + its setup steps, plus per-target preflight. Pure
  // over env + fs (no renderer), so it works in dev AND a packaged editor. The
  // matching install STREAM (`/api/toolchain/install`) is host-owned SSE, kept in
  // vite-asset-scanner.ts alongside /api/build (not part of this JSON router).
  if (urlPath === '/api/toolchain' && method === 'GET') {
    return json(toolchainStatus());
  }

  // ── POST /api/toolchain/settings {allowSystemToolchain} (M) ── the "Use system-
  // installed SDKs" toggle. Persists to settings.json in the toolchain dir, which
  // detect() reads live in BOTH main and the Vite plugin, so the change applies to
  // status immediately and to the next build without an editor restart.
  if (urlPath === '/api/toolchain/settings' && method === 'POST') {
    const { allowSystemToolchain } = (body ?? {}) as { allowSystemToolchain?: boolean };
    const next = writeToolchainSettings({ allowSystemToolchain: !!allowSystemToolchain });
    return json({ ok: true, settings: next });
  }

  // ── POST /api/toolchain/uninstall {id?} (M) ── remove ONE provisioned tool (id), or ALL of them
  // (id === 'all'), from the userData toolchain. Node re-provisions on next launch; the rest via
  // Build Support. Runs in main (owns MODOKI_TOOLCHAIN_DIR + the provisioned Node for npm uninstall).
  if (urlPath === '/api/toolchain/uninstall' && method === 'POST') {
    const tc = process.env.MODOKI_TOOLCHAIN_DIR;
    if (!tc) return json({ error: 'no toolchain directory (dev editor) — nothing to uninstall' }, 400);
    const { id } = (body ?? {}) as { id?: string };
    if (id === 'all') { uninstallAll(tc); return json({ ok: true }); }
    if (!id) return json({ error: 'id required' }, 400);
    await uninstall(id as ToolId, { toolchainDir: tc });
    return json({ ok: true });
  }

  // ── POST /api/import-file {srcPath, destFolder, reimport?} (M, exec) ── import
  // a NEW file from anywhere on disk into the project (the human "drag from
  // Finder" path): copy it under destFolder, let the manifest rescan heal a fresh
  // GUID, then run the asset-type's import handler (texture→KTX2/WebP, model→GLB)
  // unless reimport:false. Returns the new asset's url path + guid.
  if (urlPath === '/api/import-file' && method === 'POST') {
    try {
      const { srcPath, destFolder, reimport = true } = (body ?? {}) as { srcPath?: string; destFolder?: string; reimport?: boolean };
      if (!srcPath || !destFolder) return json({ error: 'import-file requires { srcPath, destFolder }' }, 400);
      if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) return json({ error: `source not found or not a file: ${srcPath}` }, 404);
      const destDirAbs = ctx.resolveAssetPath(destFolder);
      if (!destDirAbs) return json({ error: 'destFolder outside allowed directories' }, 403);
      if (!fs.existsSync(destDirAbs)) fs.mkdirSync(destDirAbs, { recursive: true });
      const base = path.basename(srcPath);
      const destAbs = path.join(destDirAbs, base);
      if (fs.existsSync(destAbs)) return json({ error: `destination exists: ${base}` }, 409);
      fs.copyFileSync(srcPath, destAbs);
      // Rescan heals a fresh GUID for the new file (scanner writeAssetGuid path).
      ctx.rebuildManifest();
      const destUrl = ctx.absToAssetUrl(destAbs);
      const entry = destUrl ? ctx.getManifest().assets.find((a) => a.path === destUrl) : undefined;
      // The file copied, but the scanner registered NO manifest asset for it — an unrecognized
      // extension (detectType → null) that isn't an importable asset type. Returning ok:true with
      // guid/type undefined read as a successful import of an unusable file. Fail it, keeping the
      // copied path so the caller knows where it landed. (F11)
      if (!entry) {
        return json({
          ok: false,
          path: destUrl ?? null,
          imported: false,
          error: `copied to ${destUrl ?? base}, but it registered no asset — its type is not a recognized/importable one (models, textures, audio, fonts, HDR, scenes, prefabs, particles, animations). The file is on disk but is not a usable asset.`,
        }, 422);
      }
      let imported = false;
      if (reimport && destUrl && entry) {
        const handler = getReimportHandler(entry.type);
        if (handler) {
          const reCtx: ReimportContext = {
            projectRoot: ctx.projectRoot,
            resolveAssetPath: (p) => ctx.resolveAssetPath(p),
            ssrLoadModule: (url) => ctx.ssrLoadModule(url),
          };
          try { await handler(destUrl, destAbs, reCtx); imported = true; ctx.rebuildManifest(); }
          catch (e) { return json({ ok: true, path: destUrl, guid: (entry as { guid?: string }).guid, imported: false, importError: String(e instanceof Error ? e.message : e) }); }
        }
      }
      return json({ ok: true, path: destUrl, guid: (entry as { guid?: string } | undefined)?.guid, type: entry?.type, imported });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  return null; // not a router-owned route
}

/** Editor actions the /api/editor-action relay accepts (op names dispatched in
 *  the renderer by engine/app/editor/agentEditorOps.ts). Allowlisted so the relay
 *  can't invoke arbitrary renderer ops. Keep in sync with registerEditorAgentOps. */
const EDITOR_ACTIONS = new Set<string>([
  'set-selection', 'set-gizmo', 'set-scene-view-mode', 'set-collider-edit',
  'open-particle-editor', 'open-sprite-editor', 'open-nine-slice-editor', 'focus-entity',
  'play', 'resume', 'stop', 'pause', 'step',
  'undo', 'redo',
  'load-scene', 'new-scene', 'save-all',
  'create-entity', 'duplicate-entity', 'delete-entities', 'reparent-entity',
  'prefab',
  // Phase A (semantic verification) + E (time) — runtime ops, also relayed through here.
  'dispatch-action', 'clear-journal', 'set-timescale',
  // Phase D (particle/animation first-pass editing).
  'anim-add-key', 'set-playhead', 'particle-set', 'anim-set-clip',
  // Enact Phase 1 (HTML5 drag-and-drop synthesis) — a renderer-DOM op (needs a live
  // DataTransfer), so it rides the browser relay and works in dev AND the DMG.
  'dom-dnd',
]);
