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
import { resolveGcloudDir, deriveGcsBucketFromBaseUrl, isGcsObjectMissing, OTA_SAFE_TOKEN, OTA_SAFE_BUCKET } from './gcloud';
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
/** An asset-root URL for a scene path in whatever form the renderer reported it, or null.
 *
 *  Accepts Vite's `/@fs/<abs>` form (what `editor-state` actually returns) and an
 *  already-asset-root path (pass-through, validated). Null means the path is real but outside
 *  every asset root — an unsaved/untitled scene, or one opened from elsewhere — in which case the
 *  field is omitted rather than sent as a value that would 403 downstream. */
function toAssetRef(ctx: BackendContext, scenePath: string | undefined): string | null {
  if (!scenePath) return null;
  if (scenePath.startsWith('/@fs/')) return ctx.absToAssetUrl(fromFsUrl(scenePath));
  // Not an /@fs URL: only claim it if the edit routes would actually accept it.
  return ctx.resolveAssetPath(scenePath) ? scenePath : null;
}

/** A `setTrait` naming an unknown field on a KNOWN trait — a certain typo — or null.
 *
 *  Both scene-mutate paths merge field names verbatim (they are schema-less), and the trait/loader
 *  then IGNORES the unknown one. So `setTrait Transform {poistion: 5}` reported `{ok:true,
 *  changed:1}` while the Transform was byte-identical: the count is of the merge, not of an effect.
 *  A false success on the surface's hottest write is the worst outcome on an agent surface — the
 *  agent builds on it.
 *
 *  Narrow ON PURPOSE, so the engine's warn-but-load survives: an unknown TRAIT (forward-compat, or
 *  a game trait the editor schema lacks) stays a warning, and no schema at all (cold start, before
 *  the renderer connects) means we know nothing and must not guess. Only a known trait's unknown
 *  field is refused — that is the case where the schema PROVES the edit cannot take effect.
 *
 *  Returns the refusal message plus the near-miss suggestions, which is what turns the dead end
 *  into the caller's next move (`docs/mcp-tool-conventions.md` §5). */
function detectFieldTypos(
  schema: SceneSchema | undefined,
  ops: unknown[],
): { error: string; extra: Record<string, unknown> } | null {
  if (!schema) return null;
  const bad: string[] = [];
  const didYouMean: Record<string, string[]> = {};
  // BOTH ops that carry trait FIELDS, not just setTrait. `addEntity` seeds the same vocabulary via
  // `traits: {Transform: {...}, EntityAttributes: {...}}`, so a typo there produced an entity with a
  // junk field the loader ignores — the identical silent no-op this guard exists to stop, reachable
  // through the identical tool. Checking one and not the other is the inconsistency class the
  // audit keeps finding (§9).
  const fieldSets: Array<{ trait: string; fields: Record<string, unknown> }> = [];
  for (const op of ops as Array<{ op?: string; trait?: string; fields?: Record<string, unknown>; traits?: Record<string, unknown> }>) {
    if (op.op === 'setTrait' && op.trait && op.fields) fieldSets.push({ trait: op.trait, fields: op.fields });
    else if (op.op === 'addEntity' && op.traits && typeof op.traits === 'object') {
      for (const [trait, data] of Object.entries(op.traits)) {
        // `true` is a tag (presence, no fields) and carries nothing to misspell.
        if (data && typeof data === 'object' && !Array.isArray(data)) fieldSets.push({ trait, fields: data as Record<string, unknown> });
      }
    }
  }
  for (const op of fieldSets) {
    const ts = schema.traits[op.trait];
    if (!ts) continue; // unknown trait → warn-but-load, not a hard error
    const real = Object.keys(ts.fields);
    for (const f of Object.keys(op.fields)) {
      if (f in ts.fields) continue;
      const key = `${op.trait}.${f}`;
      if (bad.includes(key)) continue;
      bad.push(key);
      // Cheap near-miss: a shared prefix or a containment both catch the realistic typo shapes
      // (`poistion`/`position`, `fontSizee`/`fontSize`) without pulling in an edit-distance dep.
      const lower = f.toLowerCase();
      const near = real.filter((r) => {
        const rl = r.toLowerCase();
        return rl.startsWith(lower.slice(0, 3)) || lower.startsWith(rl.slice(0, 3)) || rl.includes(lower) || lower.includes(rl);
      }).slice(0, 6);
      didYouMean[key] = near.length ? near : real.slice(0, 12);
    }
  }
  // TYPE mismatches too, not just unknown NAMES (independent review, 2026-07-30). The file branch
  // runs `validateSceneData` after applying and returns its warnings; the LIVE branch — which
  // `canGoLive` made the path almost every agent edit takes — runs no schema validation at all, so
  // a field written with the wrong type came back `{ok:true, changed:1, warnings:[]}` on one branch
  // and warned on the other, for the identical op. Checking here covers BOTH branches from one
  // place, which is the only way the two can be guaranteed to agree.
  //
  // A WARNING, not a refusal: an unknown field name cannot take effect at all (hence the hard
  // error above), but a wrong-typed value often still writes something, and turning a
  // previously-working call into a hard failure is a bigger change than this defect warrants.
  const typeWarnings: string[] = [];
  for (const op of fieldSets) {
    const ts = schema.traits[op.trait];
    if (!ts) continue;
    for (const [f, value] of Object.entries(op.fields)) {
      const hint = ts.fields[f];
      if (!hint?.type) continue;
      const mismatch = typeMismatch(hint.type, value);
      if (mismatch) typeWarnings.push(`${op.trait}.${f}: ${mismatch}`);
      else if (hint.type === 'enum' && hint.options && typeof value === 'string' && !hint.options.includes(value)) {
        typeWarnings.push(`${op.trait}.${f}: '${value}' not in [${hint.options.join(', ')}]`);
      }
    }
  }
  if (!bad.length) return typeWarnings.length ? { error: '', extra: { typeWarnings } } : null;
  return {
    error:
      `setTrait names field(s) that do not exist on the trait, so the edit CANNOT take effect ` +
      `(the loader ignores unknown fields — this would have reported success while changing ` +
      `nothing): ${bad.join(', ')}. Nothing was applied and nothing was written. ` +
      `See \`didYouMean\` for the real field names, or list them all with ` +
      `modoki_list_traits {name:"<Trait>"}.`,
    extra: { didYouMean, ...(typeWarnings.length ? { typeWarnings } : {}) },
  };
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
import {
  loadProjectConfig, writeProjectConfig, validateBuildConfig, loadProjectUserConfig, writeProjectUserConfig,
  readRawProjectConfig, readRawProjectUserConfig, MalformedProjectConfigError,
  readProjectConfigParseErrors,
} from '../load-project-config';
import {
  mergeProjectConfig, mergeProjectUserConfig, deepMergeConfigPatch, pruneProjectConfig, projectConfigIssues,
  PROJECT_CONFIG_FILENAME,
  findNullPatchPaths, DEFAULT_PROJECT_CONFIG, DEFAULT_PROJECT_USER_CONFIG, type RawProjectConfig,
} from '../../project-config';
import { validateSceneData, validatePrefabData, typeMismatch, type SceneSchema, type PrefabResolver } from '../../packages/modoki/src/runtime/loaders/sceneValidation';
import { isGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { applyOps, assignSyntheticEntityIds, stripBackfilledEntityIds, type MutableScene, type MutateOp, type EntityRef } from '../../packages/modoki/src/runtime/scene/sceneMutate';
import { getAssetSchema, validateAssetData, normalizeAssetData, defaultAssetData, type AssetSchemaType } from '../../packages/modoki/src/runtime/assets/assetSchemas';
import { pruneOldTempFiles } from './tempFiles';
import { deviceConnection, type ConnectRequest } from './deviceConnection';
import { resolveModules } from '../detect-modules';
// Type-only — erased at runtime, so it does NOT pull the tree-shaker (and its
// vite-asset-scanner import) into this host-agnostic router.
import type { TreeShakeResult } from '../asset-tree-shaker';

/** Minimal shape of a manifest entry the router needs (structurally compatible
 *  with the scanner's AssetEntry — avoids an import cycle with the host). */
export interface ManifestEntry { path: string; type: string; guid?: string }
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

/** Every asset type `getAssetSchema` serves. The routes used to advertise a NARROWER set in their
 *  own 400s (material|particle|animation) than they actually accept, which is how the timeline
 *  authoring loop ended up with no reachable schema. */
const ASSET_SCHEMA_TYPES = ['material', 'particle', 'animation', 'spriteanim', 'timeline'] as const;

const json = (body: unknown, status?: number): BackendResult => ({ kind: 'json', status, body });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── MCP persistence: MANUAL ONLY (owner decision, 2026-07-30) ──────────
// There used to be an 'auto' mode (the default) in which every live mutation ALSO saved the
// scene/asset to disk, and a 'manual' mode that left it live-only. `auto` is GONE: a mutating
// tool now behaves exactly one way, so its effect never depends on invisible session state.
//
// Why removed: two modes meant the same call did different things depending on a flag set in
// some earlier turn, and the agent-facing symptom ("did that save or not?") could only be
// answered by asking. One behaviour is worth more than the convenience of the other.
//
// What did NOT change, and cannot: the FILE-DIRECT path (no renderer, or a scene that is not the
// one open) writes the file, because there is no live world to hold the edit. That is not `auto`
// coming back — it is the absence of a live world.
//
// Consequences accepted with the decision (see docs/mcp-persistence.md):
//   • `unsavedChanges: true` is now the normal state after any agent edit;
//   • `modoki_build` refuses while unsaved, and the file-direct path 409s while unsaved — both
//     now routine rather than rare, so their messages must keep naming `modoki_save_all`;
//   • a game-code edit force-reloads the editor and DISCARDS unsaved scene edits (CLAUDE.md),
//     so accumulated unsaved work is more exposed than it was under `auto`.
export type PersistenceMode = 'manual';
export const PERSISTENCE_MODE: PersistenceMode = 'manual';
export function getPersistenceMode(): PersistenceMode { return PERSISTENCE_MODE; }

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

/** Build a `PrefabResolver` (#35) closed over `ctx`, for injecting into
 *  `validateSceneData` so the prefab-instance inert-size check can read the
 *  prefab-supplied UIElement/UIAnchor. `validateSceneData` itself does no I/O
 *  (module docs) — this is the Node-only glue that supplies it. Memoized in a
 *  Map scoped to the returned closure, so ONE call site (one validate-scene
 *  request, one scene-mutate) reads a given prefab file at most once even when
 *  the scene has many instances of it. Every failure — unknown guid,
 *  unresolvable path, read error, bad JSON — resolves to `undefined`; it must
 *  never throw (a bad prefab must not break scene validation). */
function makePrefabResolver(ctx: BackendContext): PrefabResolver {
  const cache = new Map<string, unknown>();
  return (sourceRef: string): unknown => {
    if (cache.has(sourceRef)) return cache.get(sourceRef);
    let result: unknown;
    try {
      let assetPath: string | null = null;
      if (isGuid(sourceRef)) {
        // Match a PREFAB entry only. A `source` pointing at some other asset is a data
        // error, and without this we would slurp that file into a string (a 200 MB .glb,
        // say) purely to have JSON.parse throw. Verified against real built manifests:
        // a `.prefab.json` is typed `'prefab'`.
        const entry = ctx.getManifest().assets.find(
          (a) => a.type === 'prefab' && typeof a.guid === 'string' && a.guid.toLowerCase() === sourceRef.toLowerCase(),
        );
        assetPath = entry ? entry.path : null;
      } else if (sourceRef.endsWith('.json')) {
        // Legacy/explicit path form. Same reasoning: only ever read JSON.
        assetPath = sourceRef;
      }
      const absPath = assetPath ? ctx.resolveAssetPath(assetPath) : null;
      result = absPath && fs.existsSync(absPath) ? JSON.parse(fs.readFileSync(absPath, 'utf-8')) : undefined;
    } catch {
      result = undefined;
    }
    cache.set(sourceRef, result);
    return result;
  };
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
    const params: { type?: string; level?: 'info' | 'warn' | 'error'; clear?: boolean; limit?: number; action?: 'start' | 'stop' } = {};
    const type = query.get('type');
    if (type) params.type = type;
    const level = query.get('level');
    if (level === 'info' || level === 'warn' || level === 'error') params.level = level;
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

  // ── GET /api/layout-bounds[?layer=&ids=&guids=&name=&entities=&overlaps=] (M→R) ── numeric screen-space
  // rects per entity (UI DOM rects + projected 2D/3D) + overlap/off-screen flags, so an agent
  // verifies layout WITHOUT a screenshot. Untargeted ⇒ counts only (the rects and the O(n²)
  // pair list are opt-in); see docs/mcp-response-budget.md Phase 4.
  if (urlPath === '/api/layout-bounds' && method === 'GET') {
    // NOTE this route ALLOWLISTS query params: one the tool sends but this does not parse is
    // silently dropped, and the caller believes it narrowed. Adding a param to the tool means
    // adding it HERE too.
    const params: { layer?: string; ids?: number[]; guids?: string[]; name?: string; entities?: boolean; overlaps?: boolean; limit?: number; precision?: number } = {};
    const layer = query.get('layer');
    const ids = query.get('ids');
    if (layer) params.layer = layer;
    if (ids) params.ids = ids.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    const guids = query.get('guids');
    if (guids) params.guids = guids.split(',').map((g) => g.trim()).filter(Boolean);
    const lbName = query.get('name');
    if (lbName) params.name = lbName;
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
      // A FILTERED call that matched NOTHING used to return `{count:0, editors:[], handles:[]}`
      // — byte-indistinguishable from "no editor is open", so a typo'd editor=/kind= read as a
      // correct negative answer (S3.10). `editors` is derived from the already-filtered list, so
      // it was empty too. One extra unfiltered probe (only on the zero case, so the hot path is
      // unchanged) turns it into "your filter matched nothing, and HERE is what is live".
      if (!bare && res && Array.isArray(res.handles) && res.handles.length === 0) {
        const asked = [editor ? `editor=${editor}` : null, kind ? `kind=${kind}` : null,
          params.ids?.length ? `ids=[${params.ids.join(',')}]` : null].filter(Boolean).join(', ');
        let all: HandlesResponse | null = null;
        try { all = await ctx.requestBrowser('enact-handles', {}) as HandlesResponse; } catch { /* keep the primary answer */ }
        const byEditor: Record<string, number> = {};
        const byKind: Record<string, number> = {};
        for (const h of all?.handles ?? []) {
          byEditor[h.editor ?? '?'] = (byEditor[h.editor ?? '?'] ?? 0) + 1;
          byKind[h.kind ?? '?'] = (byKind[h.kind ?? '?'] ?? 0) + 1;
        }
        const live = Object.keys(byEditor);
        return json({
          ...res,
          byEditor,
          byKind,
          hint: live.length
            ? `no handle matches ${asked}. Live now: editor ∈ {${live.join(', ')}}, kind ∈ {${Object.keys(byKind).join(', ')}} — check the spelling, or drop the filter for counts.`
            : `no handle matches ${asked}, and NO editor is currently exposing handles: open the relevant editor + enter its sub-mode first (e.g. scene_view_mode ui + collider_edit on).`,
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

  // ── POST /api/eval (M→R) ── evaluate JS in the editor RENDERER and return the value
  // (compact, bounded by the MCP formatter). The editor twin of device_eval: unblocks
  // reading/poking live renderer state (a global, window.innerWidth, devicePixelRatio, a
  // fiber value, dispatching a bridge event) without standing up a raw CDP client. The
  // renderer safe-stringifies the result, so a JS error comes back as an `Error: …` STRING
  // in `result` (the MCP tool flags that as isError). Editor-only: this router is stripped
  // from shipped game builds.
  if (urlPath === '/api/eval' && method === 'POST') {
    const b = (body ?? {}) as { code?: string };
    if (typeof b.code !== 'string' || !b.code) return json({ error: 'code (string) required' }, 400);
    try { return json({ result: await ctx.requestBrowser('eval', { code: b.code }) }); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 504); }
  }

  // ── GET /api/eval-api (M→R) ── discovery: the generated `modoki` scripting surface eval code
  // gets (op list + camelCase method names + api()/composite()/call() usage), so an agent never
  // has to read source to find what modoki_eval can call.
  if (urlPath === '/api/eval-api' && method === 'GET') {
    try { return json(await ctx.requestBrowser('eval-api', {})); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 504); }
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
      const result = await ctx.requestBrowser('render-scene', body ?? {}, 15000) as { width: number; height: number; quality?: number; dataUrl: string };
      // Echo the EFFECTIVE quality (1–100) the renderer actually used, so an out-of-unit value is
      // visibly converted rather than silently ignored (S3.13).
      return json({ path: writeDataUrlToTemp(result.dataUrl), width: result.width, height: result.height,
        ...(result.quality !== undefined ? { quality: result.quality } : {}) });
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
      // S2.33 — REFUSE when nothing can move. The whole point of a sequence is motion, and
      // `getSimDelta`/`getVisualDelta` return 0 unless the sim is running — so in the editor's
      // DEFAULT stopped state this produced N byte-identical frames and reported success. An agent
      // then studies a "still" animation that was never given a chance to advance.
      // Read `runMode`, NOT `playState`. `playState` is a 3-value compat shim in which the `preview`
      // and `scrub` run modes both collapse to 'stopped' — so a legitimate motion capture during a
      // Timeline preview would have been refused with "the editor is STOPPED", which is both wrong
      // and unactionable (there is nothing to press Play on; it is already advancing). Only the
      // genuine `stopped` mode freezes time. `editor-state` has reported the 4-value runMode since
      // the preview-mode refactor; falling back to playState keeps an older renderer working.
      let runMode: string | undefined;
      try {
        const st = await ctx.requestBrowser('editor-state', {}, 2000) as { runMode?: string; playState?: string };
        runMode = st?.runMode ?? st?.playState;
      } catch { /* headless / no renderer — the render call below reports it */ }
      if (runMode === 'stopped' && !(b as { force?: boolean }).force) {
        return json({
          ok: false,
          error:
            'REFUSED: the editor is STOPPED, so time does not advance and every frame would be ' +
            'IDENTICAL — a sequence cannot show motion from here. Nothing was rendered.',
          runMode,
          hint: 'Press Play first (modoki_play_control {action:"play"}), or use modoki_render_scene for a single static frame. Pass force:true to render identical frames deliberately. NOTE a Timeline/Animation PREVIEW or SCRUB is not "stopped" — those advance and are captured normally.',
        }, 409);
      }
      // Per-frame timestamps. The returned `fps` was the REQUESTED rate, and the sleep happened
      // AFTER a synchronous render + IPC round-trip that is never subtracted — so real spacing is
      // 1/fps PLUS render time, and any timing conclusion drawn from frameIndex × 1/fps was wrong
      // by however long the renderer took. Report what actually happened. (S2.34)
      const tMs: number[] = [];
      const t0 = Date.now();
      for (let i = 0; i < frames; i++) {
        const result = await ctx.requestBrowser('render-scene', frameOpts, 15000) as { dataUrl: string };
        tMs.push(Date.now() - t0);
        paths.push(writeDataUrlToTemp(result.dataUrl));
        // A FIXED interval between frames, deliberately — do NOT deadline-schedule this.
        //
        // Deadline scheduling ("the frame took 473ms, so we're behind — fire the rest
        // immediately") is right for playback and WRONG for sampling: you cannot retroactively
        // sample a moment that has passed. Measured when it was written that way: a 3-frame
        // request produced tMs [473, 478, 483] — the catch-up collapsed the spacing to 5ms and
        // all three frames showed nearly the same sim time, defeating the one thing this tool
        // exists for. The honest design is to keep real separation and REPORT the true rate.
        if (i < frames - 1) await sleep(1000 / fps);
      }
      const spanMs = tMs.length > 1 ? tMs[tMs.length - 1] - tMs[0] : 0;
      return json({
        paths,
        frames: paths.length,
        /** What was ASKED for. `actualFps` is what the frames were really spaced at. */
        requestedFps: fps,
        actualFps: spanMs > 0 ? Math.round(((paths.length - 1) / (spanMs / 1000)) * 100) / 100 : null,
        spanMs,
        /** Milliseconds from the FIRST frame, per frame. Use these for timing, never index × 1/fps. */
        tMs,
        ...(runMode ? { runMode } : {}),
      });
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
  // ── GET /api/validate-prefab?path=… (M) ── the prefab twin of /api/validate-scene (#42).
  //    Exists because an agent (or a human) editing `.prefab.json` directly has no other way to
  //    check its own edit: the scene validator only ever runs on scene data, and the editor's
  //    write-time warning only fires for prefabs written THROUGH the editor. Narrow on purpose —
  //    it reports the inert-size rule, not a whole schema pass (see validatePrefabData).
  if (urlPath === '/api/validate-prefab' && method === 'GET') {
    const prefabPath = query.get('path');
    try {
      const absPath = prefabPath ? ctx.resolveAssetPath(prefabPath) : null;
      if (!absPath || !fs.existsSync(absPath)) return json({ error: `prefab not found: ${prefabPath}` }, 404);
      const data = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
      const result = validatePrefabData(data);
      // No `schemaApplied`/`schemaAvailable` here: this pass consults no trait schema, and
      // reporting those fields would imply type checks ran when none did.
      return json({ path: prefabPath, warnings: result.warnings });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  if (urlPath === '/api/validate-scene' && method === 'GET') {
    const scenePath = query.get('path');
    try {
      const absPath = scenePath ? ctx.resolveAssetPath(scenePath) : null;
      if (!absPath || !fs.existsSync(absPath)) return json({ error: `scene not found: ${scenePath}` }, 404);
      const data = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
      const schema = ctx.getSchema();
      const result = validateSceneData(data, schema, makePrefabResolver(ctx));
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
        return json({ error: "path is required (the scene FILE to edit, e.g. '/assets/scenes/main.scene.json'). Use /api/editor-state to find the active scene." }, 400);
      }
      const absPath = ctx.resolveAssetPath(scenePath);
      if (!absPath) return json({ error: 'path outside allowed directories' }, 403);
      if (!fs.existsSync(absPath)) return json({ error: `scene not found: ${scenePath}` }, 404);
      if (!Array.isArray(ops)) return json({ error: 'ops must be an array' }, 400);
      // ── A setTrait naming an UNKNOWN FIELD on a KNOWN trait is refused BEFORE either path. ──
      // This check used to live ~55 lines below, INSIDE the file-direct branch — i.e. after the
      // `canGoLive` early return — so the LIVE path (which is now the path almost every agent edit
      // takes) never ran it. Measured 2026-07-30 against a real editor:
      //
      //   setTrait Transform {poistion: 5}  →  {"ok":true,"changed":1}   ← and the Transform was
      //                                                                    byte-identical after
      //
      // A false success on the surface's hottest write, produced by the very guard written to
      // prevent it. The live applier merges field names verbatim and the loader/trait then ignores
      // the unknown one, so `changed:1` counts the merge, not an effect.
      //
      // Refusing PRE-FLIGHT (rather than fixing each branch) also fixes a second defect on the
      // file path, where the typo was reported as ok:false but the junk field had ALREADY been
      // written to disk. Nothing runs now, so nothing is written on either path.
      //
      // Deliberately narrow, to preserve the engine's warn-but-load: an unknown TRAIT
      // (forward-compat, or a game trait the editor schema lacks) and a cold start (no schema
      // until the renderer connects) both stay warnings. Only a KNOWN trait's unknown field fails.
      const typoRefusal = detectFieldTypos(ctx.getSchema(), ops);
      // An empty `error` means "no unknown field NAMES, but there are type warnings" — not a
      // refusal. Only a named-field miss is fatal (the loader drops the field, so the edit cannot
      // take effect at all); a wrong TYPE is reported and applied.
      if (typoRefusal?.error) return json({ ok: false, changed: 0, errors: [typoRefusal.error], warnings: [], saved: false, ...typoRefusal.extra }, 400);
      // Carried into BOTH branches' responses below, so the live and file paths answer the same
      // way about the same op. Previously only the file branch validated.
      const preflightWarnings = (typoRefusal?.extra.typeWarnings as string[] | undefined) ?? [];
      // Probe the renderer ONCE: play state (both paths refuse during Play/Pause — an edit
      // now would touch the Play snapshot either way), the active scene path (the LIVE path
      // below only ever exists for the scene actually loaded live — this route can target ANY
      // scene FILE on disk, loaded or not), and unsavedChanges (only load-bearing on the
      // FILE-DIRECT fallback below; see its own comment for why).
      type EditorStateProbe = { playState?: string; unsavedChanges?: boolean; scenePath?: string };
      let st: EditorStateProbe | null = null;
      let probeFailed = false;
      // 8s, not 2s (independent review, 2026-07-30). `requestBrowser` REJECTS on timeout, and this
      // catch treated that as "no editor connected — safe". But a renderer that is merely BUSY —
      // a GLB/KTX2 decode, a scene load, a long frame — misses 2s easily, and then `st` is null, so
      // `st?.playState` and `st?.unsavedChanges` are both undefined and NEITHER the Play 409 below
      // nor the unsaved-work 409 further down can fire. A busy editor silently downgraded to a
      // file-direct write with both protections off.
      //
      // The two cases are genuinely indistinguishable here (`requestBrowser` rejects with the same
      // timeout for a missing renderer and a slow one), and refusing outright would break the real
      // headless/file-only use. So: give a busy renderer room to answer, and when it still does not,
      // SAY the guards could not run rather than proceeding as though they had passed.
      try { st = (await ctx.requestBrowser('editor-state', {}, 8000)) as EditorStateProbe; }
      catch { probeFailed = true; /* no editor connected, OR one too busy to answer — see below */ }
      if (st?.playState === 'playing' || st?.playState === 'paused') {
        return json({
          error: `game is ${st.playState} — stop the game (press Stop) before editing the scene; edits during Play are discarded on Stop`,
          playState: st.playState,
        }, 409);
      }
      // ── Live-world path (mcp-persistence.md Phase 2) ──
      // Route through the live world whenever it's SAFE to: a renderer is connected, its
      // active scene is the one THIS call targets (the live world only ever represents one
      // scene — applying to a scene that isn't loaded would silently do nothing), and none of
      // the ops is `setBaseScene` (no live-world equivalent — it changes what the scene LOADS,
      // not any live entity's state). Going live makes the edit undoable (ONE composite entry
      // per call) and — because it no longer needs to overwrite the file out from under the
      // live world — makes the old "unsaved live work" 409 below unreachable for this call:
      // the edit joins whatever unsaved work already existed instead of destroying it.
      const hasSetBaseScene = ops.some((op) => (op as { op?: string })?.op === 'setBaseScene');
      // COMPARE NORMALIZED PATHS. This was `st.scenePath === scenePath`, and that string equality
      // made the live path UNREACHABLE — a catch-22 measured 2026-07-30:
      //
      //   • the renderer reports `scenePath` as Vite's `/@fs/<abs>` URL;
      //   • this route requires an ASSET-ROOT path — `resolveAssetPath` 403s anything else, so a
      //     caller passing the `/@fs` form never reaches this line at all;
      //   • an asset-root path therefore never equalled the `/@fs` one, and EVERY call fell
      //     through to file-direct.
      //
      // No path string satisfied both. The consequences were invisible because file-direct
      // "works": every agent scene edit wrote the FILE (so persistence mode was a no-op for
      // scene mutations), the composite-undo primitive built for this path was dead — a human
      // could not Cmd-Z an agent edit as one step — and the file write hot-reloaded the scene,
      // which raced any read that followed and reported freshly-edited entities as ABSENT.
      const liveRef = toAssetRef(ctx, st?.scenePath);
      const wantRef = toAssetRef(ctx, scenePath);
      const canGoLive = !!st && !!liveRef && liveRef === wantRef && !hasSetBaseScene;
      if (canGoLive) {
        try {
          const live = (await ctx.requestBrowser('apply-scene-ops', { ops }, 30_000)) as {
            ok: boolean; changed: number; errors: string[]; warnings: string[]; unresolved: EntityRef[];
            created?: Array<{ op: number; id: number; guid: string; name: string }>;
          };
          // Manual-only: a live edit NEVER writes the file. `saved:false` is the truth for
          // every live call now, and the hint says how to persist — the field is kept (rather
          // than dropped) because callers already branch on it and `false` is meaningful.
          return json({
            ok: live.errors.length === 0, changed: live.changed, errors: live.errors,
            warnings: [...live.warnings, ...preflightWarnings],
            saved: false, mode: PERSISTENCE_MODE,
            // S3.12 applies to BOTH branches, and shipped on only one. `applySceneOpsLive` builds
            // `created` and the `apply-scene-ops` op returns it; this literal simply dropped it, so
            // the file-direct fallback answered `created:[…]` while the LIVE path — the one the
            // comment above calls the path almost every agent edit takes — answered `changed:1` and
            // nothing else. That is the exact dead-end S3.12 closed (re-find your own new entity by
            // name, which this surface refuses when ambiguous), left open on the hot branch and
            // verified on the cold one. Same shape as the `set_transform {space:'world'}` S1: a
            // capability with two backends chosen by ambient state, checked on one of them.
            ...(live.created?.length ? { created: live.created } : {}),
            ...(live.changed > 0 ? { hint: 'applied to the LIVE world only — run modoki_save_all to write it to disk.' } : {}),
            ...(live.unresolved.length ? { unresolved: live.unresolved } : {}),
          });
        } catch (e) {
          // The live path itself failed (relay error mid-call, not "no editor") — this is NOT
          // "fall back to file-direct" territory (that would silently re-run the edit against a
          // stale file while the live world is in an unknown state); surface it.
          return json({ error: `apply-scene-ops failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
        }
      }
      // ── File-direct fallback (headless curl, no renderer, wrong scene loaded, or setBaseScene) ──
      // Refuse when the editor has UNSAVED live work — entities created via create_entity /
      // duplicate_entity / prefab that are not in the scene file yet. This route edits the FILE, and
      // the resulting disk hot-reload rebuilds the live world FROM that file, silently DESTROYING
      // those unsaved entities while the tool reported ok:true, changed:N. Save first, then the reload
      // is lossless. Mirrors the load_scene / new_scene guardUnsaved sibling. (F3) Moot when we just
      // went live above (that branch returned already) — this only guards the true file-direct case.
      if (st?.unsavedChanges === true) {
        return json({
          ok: false,
          error: `the editor has unsaved live changes (entities created via create_entity / duplicate_entity / prefab are not in the scene file yet). This route edits the FILE, and the write hot-reloads the scene — which would DISCARD that unsaved work. Run modoki_save_all first, then retry.`,
          unsavedChanges: true,
        }, 409);
      }
      const scene = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as MutableScene;
      // Phase 3, scene-loading.md — a v12+ file has no entity ids; this
      // module still addresses entities by numeric id internally, so backfill one per
      // entry for the duration of this call. Stripped back off (stripBackfilledEntityIds,
      // below) before writing — otherwise every setTrait through this route would
      // reintroduce an `id` field on EVERY entity, the exact diff noise Phase 3 removed.
      const backfilledIds = assignSyntheticEntityIds(scene);
      const { changed, errors, warnings: opWarnings, unresolved, created } = applyOps(scene, ops);
      // Surface BOTH the op-level warnings (dangling refs / orphaned parents from F5)
      // and the post-apply schema validation warnings.
      const schema = ctx.getSchema();
      const { warnings: schemaWarnings } = validateSceneData(scene, schema, makePrefabResolver(ctx));
      const warnings = [...opWarnings, ...schemaWarnings, ...preflightWarnings];
      // The probe never answered, so NEITHER guard above could run. Say so: the write proceeds
      // (a genuinely headless edit is the normal case and must keep working), but the caller must
      // not read a plain success as "the editor was checked and had nothing pending". A busy
      // renderer looks exactly like an absent one from here.
      if (probeFailed) {
        warnings.push(
          'the editor did not answer the state probe within 8s, so this write could NOT be checked ' +
          'against the Play state or unsaved live work. If an editor IS open, it was busy — verify ' +
          'with modoki_get_editor_state that nothing was pending, or re-run once it is idle.',
        );
      }
      // (The unknown-field guard that used to live here now runs PRE-FLIGHT, above the live/file
      // branch — see `detectFieldTypos`. Down here it was unreachable from the live path.)
      const allErrors = errors;
      // Only persist when at least one op succeeded — a structural-op error
      // (entity-not-found) leaves the file untouched so a typo is a no-op.
      // Written HERE, immediately after applyOps and with no `await` in between since the
      // read above — the liveHint lookup below is async (a round-trip to the browser) and
      // used to sit BEFORE this write, leaving a window where a concurrent writer to the
      // same file (another /api/scene-mutate call, a Save All, /api/write-file) could land
      // and then get silently clobbered by this handler writing back its now-stale in-memory
      // `scene`. Only the response's liveHint needs the await; it doesn't touch the file.
      if (changed > 0) {
        stripBackfilledEntityIds(scene, backfilledIds);
        writeJsonAtomic(absPath, scene);
      }
      // ── C7: "no entity matching {guid}" was a LIE. ──
      // This route edits the scene FILE; create_entity/duplicate/prefab edit the LIVE world
      // and don't save. So a brand-new entity is real, selected, and visible — yet invisible
      // here until save_all, and the agent was told its guid didn't exist. It then re-queried
      // scene-state, got the SAME guid back, and concluded the tooling was broken.
      // applyOps is pure (file-only) and CANNOT know; this route can ASK the renderer, so
      // the explanation belongs here. One probe, only when something failed to resolve.
      const liveHint = unresolved.length ? await describeUnresolvedAgainstLiveWorld(ctx, unresolved) : null;
      // Do NOT echo the scene by default. A `setTrait` always changes something, so this
      // fired on EVERY edit — ~10k tokens of agent context per call, on the hottest write
      // path, and nobody read it. It is also the wrong data: this is the pre-expansion
      // scene FILE, not the live world, so a caller verifying its edit must still ask
      // `/api/scene-state`. Opt in with `returnScene` if you genuinely want the file back.
      return json({
        ok: allErrors.length === 0, changed, errors: allErrors, warnings,
        // This route always writes the FILE when anything changed (Path A — see
        // mcp-persistence.md); `saved` names that plainly so an agent never
        // has to infer it from `changed`/`ok`. Phase 2 gives mutate_scene a live-world
        // path where `saved` can be false in 'manual' mode — until then it mirrors `changed > 0`.
        saved: changed > 0,
        // What each addEntity CREATED — {op, id, guid, name} (S3.12). The agent must not have to
        // re-find its own new entity by name (which this surface refuses when ambiguous).
        ...(created?.length ? { created } : {}),
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
      // WHY a target was skipped matters, and `skipped` alone erased the difference. Re-importing
      // an asset whose TYPE has no handler at all (scene, prefab, material, mesh, particle,
      // animation…) answered {ok:true, converted:0, skipped:1} — a success verdict for a call where
      // the pipeline never ran and never COULD run. The agent then waits for an effect that will
      // never arrive. A path that is merely unresolvable is a different problem with a different
      // fix, so they are counted apart.
      const noHandler: string[] = [];
      const unresolved: string[] = [];
      for (const a of targets) {
        const handler = getReimportHandler(a.type);
        const abs = handler ? ctx.resolveAssetPath(a.path) : null;
        if (!handler) { summary.skipped++; noHandler.push(`${a.path} (${a.type})`); continue; }
        if (!abs) { summary.skipped++; unresolved.push(a.path); continue; }
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
      // Nothing convertible at all is a FAILURE, not a quiet success: every target was a type the
      // import pipeline does not handle, so this call could never have done anything.
      if (summary.converted === 0 && summary.errors.length === 0 && noHandler.length && !unresolved.length) {
        return json({
          ok: false,
          converted: 0,
          skipped: summary.skipped,
          errors: [],
          noHandler,
          error:
            `nothing to re-import: ${noHandler.length === 1 ? 'this asset type has' : 'these asset types have'} no import ` +
            `pipeline — ${noHandler.join(', ')}. Re-import only applies to SOURCE assets that get baked ` +
            '(textures → KTX2/WebP, models → GLB). Scenes, prefabs, materials, meshes, particles and ' +
            'animations are authored JSON and are read as-is; there is nothing to re-bake.',
          hint: 'If you meant to reload one of those after editing it on disk, no action is needed — the watcher hot-reloads them.',
        }, 422);
      }
      const ok = summary.converted > 0 || summary.errors.length === 0;
      // Say WHY anything was skipped. A bare `skipped:N` is a number the caller cannot act on.
      return json({
        ...summary, ok,
        ...(noHandler.length ? { noHandler } : {}),
        ...(unresolved.length ? { unresolved } : {}),
      }, ok ? 200 : 500);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── GET /api/asset-schema?type=material|particle|animation (M, host-static) ──
  // Field metadata + a valid example so an agent authors assets without guessing JSON.
  if (urlPath === '/api/asset-schema' && method === 'GET') {
    const t = query.get('type') as AssetSchemaType | null;
    if (!t) return json({ error: `type required: ${ASSET_SCHEMA_TYPES.join(' | ')}`, types: ASSET_SCHEMA_TYPES }, 400);
    const schema = getAssetSchema(t);
    return schema ? json(schema) : json({ error: `unknown asset type '${t}' — valid: ${ASSET_SCHEMA_TYPES.join(', ')}`, types: ASSET_SCHEMA_TYPES }, 400);
  }

  // ── POST /api/asset-write {path, type, data} (M) ── validated (warn-but-write)
  // write of an asset JSON file. Hard errors block; warnings are returned. Preserves
  // an existing file's `id` when the new data omits one.
  if (urlPath === '/api/asset-write' && method === 'POST') {
    try {
      const { path: assetPath, type, data } = (body ?? {}) as { path?: string; type?: AssetSchemaType; data?: unknown; replace?: boolean };
      if (!assetPath || !type) return json({ error: 'asset-write requires { path, type, data }' }, 400);
      if (!getAssetSchema(type)) return json({ error: `unknown asset type '${type}' — valid: ${ASSET_SCHEMA_TYPES.join(', ')}`, types: ASSET_SCHEMA_TYPES }, 400);
      const abs = ctx.resolveAssetPath(assetPath);
      if (!abs) return json({ error: 'path outside allowed directories' }, 403);
      const { errors, warnings } = validateAssetData(type, data);
      if (errors.length) return json({ ok: false, errors, warnings }, 400);
      // ── asset-write is a FULL REPLACE, so a thin `data` is a DESTRUCTIVE write. ──
      // Validation only warns on missing fundamentals, so `data:{}` — the tool's own declared
      // minimalArgs — wiped every field of an existing particle/material and answered
      // {ok:true, saved:true}. Nothing in the request says "replace", and nothing in the reply
      // says "and I deleted 14 fields".
      //
      // Two guards, both cheap, both about the caller's INTENT rather than the data's validity:
      //  1. An empty object can only ever be a mistake for a full replace.
      //  2. Dropping top-level keys that the existing file has is refused unless the caller
      //     acknowledges it with `replace:true` — the read-modify-write round trip (the intended
      //     flow, via modoki_read_asset_def) never trips it, because it carries every key back.
      const isObj = !!data && typeof data === 'object' && !Array.isArray(data);
      if (isObj && Object.keys(data as object).length === 0) {
        return json({
          ok: false,
          error: `REFUSED: data:{} would REPLACE ${assetPath} with an empty document, erasing every field. asset-write is a full replace, not a merge. Nothing was written.`,
          hint: 'Read the current def first (modoki_read_asset_def), change what you need, and write the WHOLE object back. For a one-field edit prefer the granular tools (modoki_particle_set / anim_set_clip / timeline_set).',
        }, 400);
      }
      let prevDoc: Record<string, unknown> | null = null;
      if (fs.existsSync(abs)) {
        try { prevDoc = JSON.parse(fs.readFileSync(abs, 'utf-8')) as Record<string, unknown>; } catch { prevDoc = null; }
      }
      if (isObj && prevDoc && !(body as { replace?: boolean })?.replace) {
        const incoming = new Set(Object.keys(data as object));
        const dropped = Object.keys(prevDoc).filter((k) => k !== 'id' && !incoming.has(k));
        if (dropped.length) {
          return json({
            ok: false,
            error:
              `REFUSED: this write would DROP ${dropped.length} top-level field(s) that ${assetPath} currently has: ${dropped.join(', ')}. ` +
              'asset-write is a FULL REPLACE — anything absent from `data` is deleted. Nothing was written.',
            dropped,
            hint: 'Either include those fields (read the current def with modoki_read_asset_def and write the whole object back), or pass replace:true to delete them deliberately.',
          }, 409);
        }
      }
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
      return json({ ok: true, saved: true, warnings, path: assetPath });
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
      if (!getAssetSchema(type)) return json({ error: `unknown asset type '${type}' — valid: ${ASSET_SCHEMA_TYPES.join(', ')}`, types: ASSET_SCHEMA_TYPES }, 400);
      const abs = ctx.resolveAssetPath(assetPath);
      if (!abs) return json({ error: 'path outside allowed directories' }, 403);
      if (fs.existsSync(abs)) return json({ error: `destination exists: ${assetPath}` }, 409);
      const id = crypto.randomUUID();
      const data = defaultAssetData(type) as Record<string, unknown>;
      data.id = id;
      writeJsonAtomic(abs, data);
      ctx.rebuildManifest(); // register the new asset's GUID
      return json({ ok: true, saved: true, path: assetPath, id });
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
      // Atomic write (tmp + rename), not a direct writeFileSync: this endpoint is
      // what saveAll uses to write EVERY scene in a base-scene chain, and a bare
      // writeFileSync leaves a window where the Vite asset-scanner's chokidar
      // watcher can react to the file mid-write and rescan a torn/partial JSON.
      // `readAssetGuid` (vite-asset-scanner.ts) swallows that parse failure
      // silently and just omits the asset's guid from the manifest, which can
      // transiently break base-scene chain resolution (SceneManager.loadScene's
      // resolveGuidToPath lookup) right after a Save All. The write-guard above
      // already anticipates a rename landing after the initial write (see its
      // "write+rename" burst handling), so this doesn't change hot-reload
      // suppression behavior — same pattern as writeJsonAtomic in this file.
      const tmpPath = `${absPath}.tmp`;
      fs.writeFileSync(tmpPath, bytes);
      fs.renameSync(tmpPath, absPath);
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
  //
  // `configErrors` (present ONLY when non-empty) says a file EXISTS but does not
  // parse, so every value beside it is an engine DEFAULT rather than the project's
  // own — see readProjectConfigParseErrors. Without it the response is a set of
  // plausible-looking lies with nothing marking them as such: the read path falls
  // back forgivingly (right — the editor must still open) while the write path
  // refuses, so the truth was only reachable by pressing Apply. It is a diagnostic,
  // NOT a config section; the POST below drops it if it round-trips back.
  if (urlPath === '/api/project-settings' && method === 'GET') {
    const configErrors = readProjectConfigParseErrors(ctx.projectRoot);
    // `configWarnings` is the same diagnostic one notch down: the file PARSED, but a
    // field holds a value no consumer handles, so the resolved config below silently
    // substitutes a default. Without this the dropdown reads "Free" and looks correct
    // while the file says "portrait" — and the save path deliberately keeps the file's
    // word, so they disagree indefinitely. Non-blocking (unlike configErrors): the
    // rest of the config is real and editing it is safe.
    // Gated on project.config.json ITSELF parsing — two reasons, both load-bearing:
    // an unparseable config resolved to pure defaults, so attributing a fallback to a
    // specific bad value would be a lie; and `readRawProjectConfig` THROWS on that file,
    // which this branch must not reach. A malformed project.user.json is unrelated and
    // must not suppress a real warning about the committed config.
    const configFileBroken = configErrors.some((e) => e.file === PROJECT_CONFIG_FILENAME);
    const configWarnings = configFileBroken
      ? []
      : projectConfigIssues(readRawProjectConfig(ctx.projectRoot) as Parameters<typeof projectConfigIssues>[0]);
    return json({
      ...loadProjectConfig(ctx.projectRoot),
      user: loadProjectUserConfig(ctx.projectRoot),
      ...(configErrors.length ? { configErrors } : {}),
      ...(configWarnings.length ? { configWarnings } : {}),
    });
  }

  // ── POST /api/project-settings (M) ── split the merged settings object back
  // into its two files: the `user` subtree → project.user.json (gitignored,
  // per-machine), everything else → project.config.json (committed). Then
  // invalidate the virtual config module so the next reload reflects new values.
  //
  // THE BODY IS A PATCH, deep-merged onto the file ON DISK — a section you omit is
  // left exactly as the file had it. ("Section" means one DECLARED in ProjectConfig:
  // the write still funnels through mergeProjectConfig, whose explicit key list drops
  // any UNDECLARED top-level key. Pre-existing — the old route did the same — and
  // inert, since every reader resolves through that same list. Unknown keys nested
  // INSIDE a declared section do survive, via prune's already-on-disk rule.)
  // This is load-bearing: the Project Settings
  // dialog posts the WHOLE object (so every key is present and blanking a field
  // still works), but `modoki_project_settings action=set` and the OTA-keys
  // "sync public key" button post a single section. This route used to merge onto
  // the DEFAULTS instead (mergeProjectConfig is the LOAD-time resolver), so those
  // partial callers silently reset app identity to com.modokiengine.prototype and
  // blanked appleTeamId. Absence must mean "don't touch", never "reset to default".
  //
  // What lands on disk is PRUNED, not the resolved config — see the file-stays-
  // minimal invariant in project-config.ts. Writing the resolved config is what
  // once handed an internal game the demo deploy bucket.
  if (urlPath === '/api/project-settings' && method === 'POST') {
    try {
      // `configErrors` is the GET's read-only diagnostic, not a section. The dialog
      // posts back the WHOLE object it loaded, so it would otherwise come straight
      // back here and trip the unknown-section 400 below — a confusing refusal for
      // something the caller never authored. Drop it before anything else looks.
      const { configErrors: _configErrors, ...bodyIn } = (body ?? {}) as Record<string, unknown>;
      const { user: userPart, ...configPart } = bodyIn;
      // No config field is nullable, so a null is the caller reaching for "clear
      // this" with the wrong value. Writing it through poisons a typed field and
      // dropping it would be a silent no-op reported as success — reject instead.
      // An UNKNOWN top-level section is a silent no-op: `deepMergeConfigPatch` merges it in,
      // `mergeProjectConfig` drops anything it does not know, and prune then writes nothing — so
      // `{"apps":{…}}` (or `{"device":{…}}`) answered ok:true having changed absolutely nothing.
      // A misspelled section is the likeliest way to reach this route, and reporting success is
      // the worst possible answer to it. Derived from DEFAULT_PROJECT_CONFIG so the list cannot
      // drift from the schema it is checking against.
      const KNOWN_SECTIONS = new Set([...Object.keys(DEFAULT_PROJECT_CONFIG), 'user']);
      const unknownSections = Object.keys(bodyIn).filter((k) => !KNOWN_SECTIONS.has(k));
      if (unknownSections.length) {
        return json({
          error:
            `unknown config section(s) ${unknownSections.map((k) => `"${k}"`).join(', ')} — nothing was written. ` +
            `project.config.json has: ${[...KNOWN_SECTIONS].sort().join(', ')}.`,
          unknownSections,
          knownSections: [...KNOWN_SECTIONS].sort(),
        }, 400);
      }
      const nulls = findNullPatchPaths(bodyIn);
      if (nulls.length) {
        return json({
          error: `null is not a valid value for ${nulls.join(', ')} — no project-config field is ` +
            'nullable. Use "" (string), false (boolean) or 0 (number) to clear a field.',
        }, 400);
      }
      // Keep the PRE-EDIT file around: it is what prune measures "was already
      // recorded" against. Pruning against nextRaw instead would make every key in
      // a full-object save trivially present and prune nothing.
      // These throw if a file exists but is malformed — a patch onto a file we
      // couldn't read would silently replace the author's config with whatever
      // section they were editing. Surfaced as a 400 below, not a write.
      const prevRaw = readRawProjectConfig(ctx.projectRoot);
      const prevRawUser = readRawProjectUserConfig(ctx.projectRoot);
      const nextRaw = deepMergeConfigPatch(prevRaw, configPart);
      const nextRawUser = deepMergeConfigPatch(prevRawUser, (userPart ?? {}) as Record<string, unknown>);
      // `coerceUnions:false` — this resolved config is what gets WRITTEN (pruned)
      // below, so validating here would silently rewrite an out-of-union value the
      // author never touched when they Apply an unrelated section. See the note on
      // mergeProjectConfig: reading coerces, writing round-trips.
      const merged = mergeProjectConfig(nextRaw as Parameters<typeof mergeProjectConfig>[0], { coerceUnions: false });
      const mergedUser = mergeProjectUserConfig(nextRawUser as Parameters<typeof mergeProjectUserConfig>[0]);
      // Reject shell-unsafe build fields (across both files) before they can reach a build command.
      // Validated against the RESOLVED config so a partial patch can't smuggle a bad
      // value past by omitting the field it lands next to. Nothing is written on error.
      const errors = validateBuildConfig(merged, mergedUser);
      if (errors.length) return json({ error: errors.join('; ') }, 400);
      writeProjectConfig(
        pruneProjectConfig(
          merged as unknown as RawProjectConfig,
          prevRaw,
          DEFAULT_PROJECT_CONFIG as unknown as RawProjectConfig,
        ),
        ctx.projectRoot,
      );
      writeProjectUserConfig(
        pruneProjectConfig(
          mergedUser as unknown as RawProjectConfig,
          prevRawUser,
          DEFAULT_PROJECT_USER_CONFIG as unknown as RawProjectConfig,
        ),
        ctx.projectRoot,
      );
      ctx.invalidateProjectConfig();
      return json({ ok: true });
    } catch (e) {
      // A malformed file on disk is the CALLER's to fix, not a server fault.
      if (e instanceof MalformedProjectConfigError) return json({ error: e.message }, 400);
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
      const state = await ctx.requestBrowser('editor-state', {});
      const obj = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
      // `scenePathRef` — the ACTIVE SCENE IN THE FORM THE EDIT ROUTES ACCEPT.
      //
      // The renderer reports `scenePath` as Vite's `/@fs/<abs>` URL, which is right for the
      // renderer (it is how the file is served) and useless to `/api/scene-mutate`, whose
      // `resolveAssetPath` only understands asset-root URLs and 403s "path outside allowed
      // directories" on anything else. Every consumer that wanted "edit the open scene" had to
      // re-derive the asset-root form, and `modoki_set_transform` — the tool CLAUDE.md points
      // agents at for placing entities — got it wrong: its documented `path` default 403'd on
      // every call. Answer it here, once, rather than leave each caller to guess.
      const ref = toAssetRef(ctx, typeof obj.scenePath === 'string' ? obj.scenePath : undefined);
      return json({ ...obj, ...(ref ? { scenePathRef: ref } : {}), persistenceMode: getPersistenceMode() });
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 504);
    }
  }

  // ── POST /api/persistence (M) ── report the persistence contract + pending live work.
  // Persistence is MANUAL-ONLY (see PERSISTENCE_MODE): there is no mode to set, so this route is
  // now a READ. It stays because `unsavedChanges` is the genuinely useful half — "do I have live
  // work that is not on disk?" — which callers need before a build, a scene swap, or a file-direct
  // edit, all of which refuse while unsaved.
  //
  // A `mode` argument is REJECTED rather than ignored. Silently accepting `mode:'auto'` would let a
  // caller believe it had re-enabled auto-save and then lose work when nothing saved; a 400 that
  // names `modoki_save_all` is the whole point.
  if (urlPath === '/api/persistence' && method === 'POST') {
    const { mode } = (body ?? {}) as { mode?: string };
    if (mode !== undefined && mode !== 'manual') {
      return json({
        error: `persistence is manual-only — '${mode}' is not a valid mode. Live edits stay in the ` +
          'live world (undoable) and reach disk only via modoki_save_all. The former auto mode, ' +
          'which saved on every mutation, was removed so a tool\'s effect never depends on session state.',
        mode: PERSISTENCE_MODE,
      }, 400);
    }
    let unsavedChanges: boolean | null = null;
    try {
      const state = (await ctx.requestBrowser('editor-state', {}, 2000)) as { unsavedChanges?: boolean } | null;
      if (state && typeof state.unsavedChanges === 'boolean') unsavedChanges = state.unsavedChanges;
    } catch { /* no editor connected — mode is still readable/settable headlessly */ }
    return json({ mode: getPersistenceMode(), unsavedChanges });
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

  // ── GET /api/wait-for-edit[?type=&source=&since=&timeoutMs=] (M→R) ── #28: the long-poll
  // twin of /api/editor-journal. Parks in the RENDERER (`waitForEditorJournal`) until a
  // matching event is appended or the deadline expires; a timeout is a NORMAL 200 answer
  // ({events:[], timedOut:true, nextSeq}), never an error — so an agent can be WOKEN by a
  // human edit instead of polling editor-journal in a loop. `source` defaults to 'human' in
  // the op (the whole point is "tell me what the HUMAN did").
  //
  // The relay timeout below MUST exceed the op's own internal deadline (the op clamps
  // `timeoutMs` to [50, 120_000] — WAIT_FOR_EDIT_MIN_MS/MAX_MS in agentEditorOps.ts; kept as
  // a literal here rather than imported because plugins/ sits BELOW app/ in the build, so
  // this file can't import from it), or this HTTP round trip would die first and report a
  // legitimate 120s park as a dead backend instead of the op's own `timedOut:true`.
  if (urlPath === '/api/wait-for-edit' && method === 'GET') {
    const params: { type?: string; source?: string; since?: number; timeoutMs?: number } = {};
    const type = query.get('type');
    const source = query.get('source');
    const since = query.get('since');
    const timeoutMsQ = query.get('timeoutMs');
    if (type) params.type = type;
    if (source === 'human' || source === 'agent') params.source = source;
    if (since != null && since !== '' && !Number.isNaN(Number(since))) params.since = Number(since);
    if (timeoutMsQ != null && timeoutMsQ !== '' && !Number.isNaN(Number(timeoutMsQ))) params.timeoutMs = Number(timeoutMsQ);
    const clampedOpTimeout = Math.max(50, Math.min(120_000, params.timeoutMs ?? 30_000));
    const relayTimeoutMs = clampedOpTimeout + 10_000; // headroom over the op's own deadline
    try { return json(await ctx.requestBrowser('wait-for-edit', params, relayTimeoutMs)); }
    catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 504); }
  }

  // ── GET /api/asset-def?path=[&type=] (M→R) ── read an asset DEFINITION back from the LIVE
  // cache. The read half of `particle-set` / `anim-set-clip` / `timeline-set`, which all require a
  // FULL def and, until this existed, gave no way to obtain one or to verify the result — see the
  // `read-asset-def` op's header. GET, not POST, per the C7 convention: this tells you something,
  // it does not do something.
  if (urlPath === '/api/asset-def' && method === 'GET') {
    const path = query.get('path');
    if (!path) return json({ error: 'asset-def requires ?path=<asset-root URL>' }, 400);
    const type = query.get('type');
    try { return json(await ctx.requestBrowser('read-asset-def', { path, ...(type ? { type } : {}) })); }
    catch (e) {
      // Same split as the editor-action relay: a miss ("not in the live cache") is the op
      // answering (400), not a dead gateway.
      const msg = String(e instanceof Error ? e.message : e);
      return json({ error: msg }, relayFailureStatus(e));
    }
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
    // The asset-shaped ops (mcp-persistence.md Phase 3) apply live either way but
    // only persist to disk in 'auto' mode — in 'manual' mode they park the pending write in the
    // renderer's dirty-asset registry instead. The mode lives in THIS process (Node), not the
    // renderer, so it rides along as an extra param rather than requiring a separate round trip.
    const relayParams = ASSET_PERSISTENCE_ACTIONS.has(action)
      ? { ...params, _persistenceMode: getPersistenceMode() }
      : params;
    try {
      // Scene/resource-touching actions (load-scene, play) can take a while — give
      // them generous headroom over the default relay timeout.
      return json(await ctx.requestBrowser(action, relayParams, 60_000));
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, relayFailureStatus(e));
    }
  }

  // ── GET /api/scenes (M) ── list the project's scene assets (guid/path/name)
  // from the cached manifest, so an agent can discover what to load-scene.
  // `type === 'scene'` is trustworthy on its own: scenes are positively identified
  // by the `.scene.json` suffix (or the legacy `/scenes/` directory convention) —
  // issue #54's migration removed the catch-all that used to type ANY
  // uncategorized JSON under an asset root as 'scene' (e.g. court's
  // assets/levels/index.json used to leak in here as a false candidate boot scene).
  if (urlPath === '/api/scenes' && method === 'GET') {
    const scenes = ctx.getManifest().assets
      .filter((a) => a.type === 'scene')
      .map((a) => ({ path: a.path, ...((a as { guid?: string }).guid ? { guid: (a as { guid?: string }).guid } : {}) }));
    return json({ count: scenes.length, scenes });
  }

  // ── GET /api/build-modules (M) ── resolve `build.modules` (the Project Settings →
  // Engine Modules toggle, 'auto' | boolean per module) for the OPEN project, so the
  // running editor can answer "does this project actually render 3D?" — something it
  // cannot determine on its own: `resolveModules`'s 'auto' branch scans the project's
  // scene files on the FILESYSTEM (`detect-modules.ts`, Node-only), and the browser-side
  // `__MODOKI_MODULE_*__` Vite define is always all-true for an editor/dev build
  // (`vite.config.ts` passes `projectRoot: null` there). Reuses the SAME resolution the
  // real build uses — do not reimplement the scan. Deliberately passes the REAL
  // `ctx.projectRoot` (the difference from vite.config.ts's `null`): callers want the
  // project's actual answer, not "load every SDK". One scene-tree scan per call; called
  // once per editor boot today, so no caching — add it if a future caller polls this.
  if (urlPath === '/api/build-modules' && method === 'GET') {
    const modules = resolveModules(loadProjectConfig(ctx.projectRoot).build.modules, ctx.projectRoot);
    return json({ modules });
  }

  // ── GET /api/signing-teams (M, exec) ── list Apple developer teams usable for
  // iOS signing on THIS machine (provisioning profiles + keychain certs), so the
  // Project Settings "Apple Team ID" field can offer a "Name (ID)" dropdown
  // instead of a raw code. Best-effort + macOS-only (returns [] elsewhere).
  if (urlPath === '/api/signing-teams' && method === 'GET') {
    return json({ teams: discoverSigningTeams() });
  }

  // ── GET /api/ota/keys?name=<name> (M) ── read-only: does build/ota-keys/<name>.json
  // exist, and if so what's its public key? Pure fs read, no generation — lets the OTA
  // Keys dialog show current state (and whether it matches project.config.json's
  // ota.publicKey) WITHOUT a side-effecting keygen call just to check.
  if (urlPath === '/api/ota/keys' && method === 'GET') {
    const name = query.get('name') || 'default';
    if (!OTA_SAFE_TOKEN.test(name)) return json({ ok: false, error: `name must match ${OTA_SAFE_TOKEN}` }, 400);
    const keyPath = path.join(ctx.editorRoot || ctx.projectRoot, 'build', 'ota-keys', `${name}.json`);
    if (!fs.existsSync(keyPath)) return json({ ok: true, name, exists: false, publicKey: null });
    try {
      const { publicKey } = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as { publicKey?: string };
      return json({ ok: true, name, exists: true, publicKey: publicKey ?? null });
    } catch (e) {
      return json({ ok: false, error: `could not read ${path.relative(ctx.projectRoot, keyPath)}: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
  }

  // ── POST /api/ota/keygen?name=<name> (M, exec) ── generate the OTA signing keypair
  // (engine/scripts/ota-keygen.mjs). Deliberately NO overwrite/force option: regenerating
  // orphans every already-shipped binary (they have the old public key baked in), and the
  // editor's typed-confirmation guard for that (plan doc, Phase 5a) doesn't exist yet —
  // shipping a backend bypass ahead of its own guard would defeat the reason the guard
  // exists. `ota-keygen.mjs` already refuses to overwrite; this just surfaces that refusal
  // as JSON instead of a CLI exit code.
  if (urlPath === '/api/ota/keygen' && method === 'POST') {
    const name = query.get('name') || 'default';
    if (!OTA_SAFE_TOKEN.test(name)) return json({ ok: false, error: `name must match ${OTA_SAFE_TOKEN}` }, 400);
    try {
      const out = execFileSync('node', ['engine/scripts/ota-keygen.mjs', name], { cwd: ctx.editorRoot || ctx.projectRoot, encoding: 'utf8' });
      const publicKey = out.match(/^\s*(\S+)\s*$/m)?.[1] ?? null;
      return json({ ok: true, name, publicKey, log: out });
    } catch (e) {
      // ota-keygen.mjs exits 1 (refuses to overwrite) — surface its stderr, not a stack trace.
      const stderr = (e as { stderr?: Buffer | string })?.stderr?.toString() || (e instanceof Error ? e.message : String(e));
      return json({ ok: false, error: stderr.trim() }, 409);
    }
  }

  // ── GET /api/ota/status?bucket=gs://... (M, exec) ── read-only: the CURRENT
  // release.json for this project's OTA bucket (or an explicit override). No
  // project.config.json mutation, no gcloud write — safe to call anytime, incl. before
  // ota.enabled is on (only needs a bucket to read from).
  if (urlPath === '/api/ota/status' && method === 'GET') {
    const cfg = loadProjectConfig(ctx.projectRoot);
    const bucket = query.get('bucket') ?? deriveGcsBucketFromBaseUrl(cfg.ota.baseUrl);
    if (!bucket || !OTA_SAFE_BUCKET.test(bucket)) {
      return json({ ok: false, error: `Could not derive a gs:// bucket from ota.baseUrl ("${cfg.ota.baseUrl}"). Pass ?bucket=gs://... explicitly.` }, 400);
    }
    const user = loadProjectUserConfig(ctx.projectRoot);
    const gcloudDir = resolveGcloudDir(user.sdk.gcloudPath);
    if (!gcloudDir) {
      return json({ ok: false, error: 'gcloud not found — install the Google Cloud SDK and run `gcloud auth login`, or set its path in Project Settings.' }, 500);
    }
    const env = { ...process.env, PATH: `${gcloudDir}:${process.env.PATH ?? ''}` };
    // "COULD NOT LOOK" IS NEVER REPORTED AS "NOTHING IS THERE" (conventions §5). This was a bare
    // `catch` that answered `{ok:true, release:null, note:'No release.json published yet'}` for
    // EVERY failure — expired auth, no network, a typo'd bucket, a missing IAM permission, even a
    // corrupt release.json. An agent then believes a fact about PRODUCTION ("nothing is live") and
    // acts on it: re-publishing, or telling the human the rollout never landed.
    let raw: string;
    try {
      raw = execFileSync('gcloud', ['storage', 'cat', `${bucket}/release.json`], { env, encoding: 'utf8' });
    } catch (e) {
      const stderr = String((e as { stderr?: unknown })?.stderr ?? (e as Error)?.message ?? e);
      if (isGcsObjectMissing(stderr)) {
        // The one case that IS an answer: the bucket is readable and the object isn't there.
        return json({ ok: true, bucket, release: null, note: 'No release.json published yet for this bucket.' });
      }
      return json({
        ok: false,
        bucket,
        error:
          `Could not READ ${bucket}/release.json — this does NOT mean nothing is published, it means ` +
          `the bucket could not be reached or read. gcloud said: ${stderr.trim() || '(no output)'}`,
        hint: 'Common causes: expired credentials (`gcloud auth login`), no network, a wrong bucket in ota.baseUrl, or missing storage.objects.get permission.',
      }, 502);
    }
    try {
      return json({ ok: true, bucket, release: JSON.parse(raw) });
    } catch (e) {
      // A corrupt release.json is ALSO not "nothing published" — it is a live file we cannot read,
      // which is worse and needs saying.
      return json({
        ok: false,
        bucket,
        error: `${bucket}/release.json exists but is not valid JSON (${e instanceof Error ? e.message : String(e)}). Clients fetching it will fail — this is a BROKEN release, not an absent one.`,
        raw: raw.slice(0, 2000),
      }, 502);
    }
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
          catch (e) {
            // PARTIAL IS A FAILURE unless the tool documents partial success (conventions §5), and
            // this one does not. It used to answer `{ok:true, imported:false, importError}` — a
            // SUCCESS with the bad news in a field nobody branches on. The caller asked to import;
            // a texture that failed KTX2/WebP conversion has no runtime variant, so it will fail
            // to load later with nothing connecting that back to this call. Say so now, and keep
            // path/guid in the body so the caller can retry or clean up rather than guess.
            return json({
              ok: false,
              path: destUrl,
              guid: (entry as { guid?: string }).guid,
              type: entry?.type,
              imported: false,
              error:
                `copied to ${destUrl} and registered (guid ${(entry as { guid?: string }).guid}), but the ` +
                `IMPORT PIPELINE FAILED: ${String(e instanceof Error ? e.message : e)}. The file is on disk ` +
                `but its derived form (e.g. KTX2/WebP for a texture, GLB parse for a model) was not produced, ` +
                `so it will not load correctly at runtime.`,
              hint: 'Fix the cause and re-run the pipeline with modoki_reimport_asset on the path above — no need to import again. Pass reimport:false to import_file if you deliberately want the raw copy only.',
            }, 422);
          }
        }
      }
      return json({ ok: true, path: destUrl, guid: (entry as { guid?: string } | undefined)?.guid, type: entry?.type, imported });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  return null; // not a router-owned route
}

/** Which status a thrown relay error deserves.
 *
 *  Everything used to be a **504**, which reads as "the editor hung" — so a DELIBERATE, correct
 *  refusal was indistinguishable from a dead renderer. Measured while running batch use case 8:
 *  `load-scene` refused because the editor had unsaved live-world changes (exactly right, and its
 *  message says what to do), and it arrived as `backend 504`. An agent reading that chases a
 *  wedged editor instead of calling `save_all`.
 *
 *  Only the RELAY's own failures are gateway failures; an error the op raised is the op answering,
 *  so it is a 400. The two transport signatures come from `requestRenderer` in `electron/main.ts`
 *  (and the Vite HMR relay's equivalents). Matching on the message is deliberately conservative:
 *  an unrecognized error is treated as the OP speaking, which is the common case. */
function relayFailureStatus(e: unknown): number {
  const msg = String(e instanceof Error ? e.message : e);
  // Match BOTH hosts' relay wordings. This listed only the Electron strings, so on the Vite dev
  // server every renderer transport failure — "timed out waiting for the BROWSER", "dev server
  // websocket not ready" — fell through to 400 and surfaced as REFUSED_BY_OP: an unreachable
  // renderer reported as a deliberate op refusal, which is the "could not look" vs "it said no"
  // confusion §5 exists to prevent, mirrored across the two backends (§9).
  //
  // The list must cover every string `failPendingRenderer` (electron/main.ts) actually sends, and
  // it did not (independent review, 2026-07-30): `'project changed — renderer reloading'` fell
  // through to 400, so a request killed by a deliberate renderer TEARDOWN was reported to the
  // agent as an op refusal — the same could-not-look/it-said-no inversion this function exists to
  // fix, in the opposite direction. (`'editor window closed'` was already covered by `window
  // closed`.) A teardown is retryable once the renderer is back; a refusal is not, so telling the
  // two apart changes what the agent does next.
  const transport = /no (editor )?renderer|timed out waiting for the (renderer|browser)|renderer went away|renderer reloading|project changed|window (is )?closed|destroyed|websocket not ready/i.test(msg);
  return transport ? 504 : 400;
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
  // The counterpart to save-all for parked ASSET writes: drop them instead of persisting them.
  // Manual persistence had no discard at all until now.
  'discard-asset-edits',
  'create-entity', 'duplicate-entity', 'delete-entities', 'reparent-entity',
  'prefab',
  // Phase A (semantic verification) + E (time) — runtime ops, also relayed through here.
  'dispatch-action', 'clear-journal', 'set-timescale',
  // Phase D (particle/animation first-pass editing).
  'anim-add-key', 'set-playhead', 'particle-set', 'anim-set-clip',
  'timeline-set', 'timeline-add-clip',
  // Enact Phase 1 (HTML5 drag-and-drop synthesis) — a renderer-DOM op (needs a live
  // DataTransfer), so it rides the browser relay and works in dev AND the DMG.
  'dom-dnd',
  // Focus-scope refactor P7: set which panel owns the keyboard, so an agent can steer a
  // panel-scoped chord instead of tapping-and-hoping.
  'set-focus-scope',
]);

/** The asset-shaped ops that apply live and (in 'auto' mode) also persist to disk —
 *  mcp-persistence.md Phase 3. Gets `_persistenceMode` injected into its relay
 *  params so the renderer (which doesn't otherwise know this Node-process-side flag) can
 *  decide between persisting immediately and parking the write in the dirty-asset registry. */
const ASSET_PERSISTENCE_ACTIONS = new Set<string>([
  'particle-set', 'anim-set-clip', 'anim-add-key', 'timeline-set', 'timeline-add-clip',
]);
