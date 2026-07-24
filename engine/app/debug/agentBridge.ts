/** Agent bridge — dev-only glue that makes the engine friendly to AI agents
 *  (and any tooling) editing scene JSON on disk via plain `curl`.
 *
 *  Three jobs, all over Vite's existing HMR websocket (no extra server):
 *   1. Push the live trait-registry schema to the dev server once, so its
 *      `/api/validate-scene` + `/api/scene-mutate` endpoints can type-check
 *      scene JSON (the registry only exists here, in the browser).
 *   2. Answer `modoki:request` ops from the server (currently `scene-state`),
 *      replying with `modoki:response`. Backs the curl-able `/api/scene-state`.
 *   3. Hot-reload the active scene when its `.scene.json` (or any `.prefab.json`)
 *      changes on disk — no manual browser refresh — and warn on validation
 *      findings so a malformed edit is visible immediately.
 *
 *  Entirely gated on `import.meta.hot`, so it is stripped from production builds. */

import {
  sceneManager,
  getAllEntities,
  getAllTraits,
  readTraitData,
  readTraitDataFull,
  buildSceneSchema,
  validateSceneData,
  loadManifestJson,
  renderSceneOffscreen,
  journalEvents,
  clearJournal,
  setJournalEnabled,
  resolveRefName,
  setVerboseCapture,
  verboseCaptureState,
  isVerboseType,
  dispatchUIAction,
  getUIActionNames,
  getUIActionParams,
  getReadSourceNames,
  getReadValue,
  isSimRunning,
  setTimeScale,
  getTimeScale,
  getCurrentWorld,
  getContactState,
  registerHandleProvider,
  invalidateModel,
  invalidateTexture,
  switchableClipNames,
  ANIMATOR_CLIP_TRAITS,
  type OffscreenRenderOpts,
  type SceneData,
  invalidateAnimationClip,
  findEntityByGuid,
} from '@modoki/engine/runtime';
import { computeLayoutBounds, type LayoutBoundsParams } from './layoutDump';
import { tailWithCounts, tailHint, CONSOLE_TAIL_DEFAULT, JOURNAL_TAIL_DEFAULT } from './streamSummary';
import { roundFloats, resolvePrecision } from './roundFloats';
import { computeHandles, type HandlesDumpParams } from './handlesDump';
import { resolveDomPointReport, type DomPointSpec } from './domResolve';
import { chromeHandles } from './chromeHandles';
import { computeDiagnostics } from './diagnose';
import { startWatch, readWatch, listWatches, clearWatch, type StartWatchParams } from './watch';
// Percept S3: resolved world transforms + hierarchy-deactivation set, both computed
// each frame by transformPropagationSystem. Same module instance the renderers read.
import { worldTransforms, deactivatedEntities } from '@modoki/engine/three';

/** Minimal transport the bridge needs — implemented over the Electron preload
 *  IPC channel (window.__modokiElectron.bridge) under Electron. */
interface ElectronBridge {
  send(event: string, data: unknown): void;
  on(event: string, cb: (data: unknown) => void): void;
}

interface SceneStateParams {
  /** Only include this trait's data (still lists all entities). */
  trait?: string;
  /** Only include this single entity id. */
  id?: number;
  /** Only include the entity with this stable guid (the addressing CLAUDE.md mandates). */
  guid?: string;
  /** Filter to entities whose name CONTAINS this (case-insensitive). */
  name?: string;
  /** Filter by a simple predicate "Trait.field <op> value", op ∈ = == != > >= < <= ~ (~ = contains). */
  where?: string;
  /** Include EVERY persistent trait field (via readTraitDataFull), not just the
   *  curated Inspector subset — surfaces AoS/object fields (animSets, materials,
   *  onClickSet) the default dump drops. Default false (compact). */
  full?: boolean;
  /** Force-include resource entities (mesh/material/prefab/env holders + config
   *  singletons Time/Physics/NPRPostFX). They're excluded from the DEFAULT untargeted
   *  listing only — any id/trait/name/where filter already includes them. */
  resources?: boolean;
  /** Cap the number of entities returned; sets `truncated` + `totalCount` when hit.
   *  In INDEX mode (the untargeted default) this defaults to `DEFAULT_INDEX_LIMIT`;
   *  a targeted/enriched query stays uncapped unless you pass one. */
  limit?: number;
  /** Add the resolved WORLD transform (after parent-chain propagation) + an
   *  `activeInHierarchy` flag (false if the entity or an ancestor is inactive) to
   *  each entity. Default false — the dump reports only the local Transform. */
  world?: boolean;
  /** Add each entity's screen-space rect (`screen` {x,y,w,h} CSS px, projected via
   *  the same layout-bounds path) + `onScreen`, so Claude gets geometry in one call
   *  instead of a separate get_layout_bounds. Default false. Needs the renderer. */
  bounds?: boolean;
  /** Add each body's CURRENT physics contacts: `contacts` (solid, load-bearing) +
   *  `overlaps` (sensor/trigger), as GUID arrays rolled up to bodies. The STATE
   *  counterpart to the `@contact`/`@sensor` journal events ("what is it touching NOW"
   *  vs "when did they touch"). Present only on bodies currently touching something.
   *  Default false. */
  contacts?: boolean;
}

type WhereMeta = ReturnType<typeof getAllTraits>[number];
type WherePredicate = (info: { id: number; traits: string[] }) => boolean;

/** Parse a `Trait.field op value` predicate into a per-entity test, OR an `{ error }`
 *  describing why it couldn't (so the caller can surface it instead of silently
 *  returning an unfiltered dump — the old null-means-ignore trap). Reads via
 *  readTraitDataFull so a field outside the curated Inspector set is still queryable
 *  (Decision A). Numeric compares coerce; `~` is substring. */
function parseWhere(
  expr: string,
  metaByName: Map<string, WhereMeta>,
): { pred: WherePredicate } | { error: string } {
  const m = /^(\w+)\.(\w+)\s*(==|!=|>=|<=|=|>|<|~)\s*(.+)$/.exec(expr.trim());
  if (!m) return { error: `could not parse where "${expr}" — expected 'Trait.field <op> value' (op ∈ = != > >= < <= ~)` };
  const [, trait, field, op, rawVal] = m;
  const meta = metaByName.get(trait);
  if (!meta) return { error: `unknown trait "${trait}" in where "${expr}"` };
  // Field-existence check when the trait's field set is statically known (SoA
  // schema object or the curated meta.fields). AoS traits (function schema) can't
  // be validated statically, so we skip the check rather than false-warn.
  const schema = (meta.trait as { schema?: unknown }).schema;
  const knownFields = schema && typeof schema === 'object'
    ? new Set([...Object.keys(schema), ...Object.keys(meta.fields)])
    : null;
  if (knownFields && !knownFields.has(field)) {
    return { error: `unknown field "${trait}.${field}" in where "${expr}"` };
  }
  const val = rawVal.trim();
  const num = Number(val);
  const isNum = val !== '' && !Number.isNaN(num);
  const pred: WherePredicate = (info) => {
    if (!info.traits.includes(trait)) return false;
    const data = readTraitDataFull(info.id, meta) as Record<string, unknown> | null;
    if (!data) return false;
    const v = data[field];
    switch (op) {
      case '=': case '==': return isNum ? Number(v) === num : String(v) === val;
      case '!=': return isNum ? Number(v) !== num : String(v) !== val;
      case '>': return Number(v) > num;
      case '>=': return Number(v) >= num;
      case '<': return Number(v) < num;
      case '<=': return Number(v) <= num;
      case '~': return String(v).toLowerCase().includes(val.toLowerCase());
      default: return false;
    }
  };
  return { pred };
}

// ── Console capture (dev) ── a ring buffer of recent console messages so an
// agent/tooling can read editor errors + warnings via the curl-able
// /api/console-logs (backed by the 'console-logs' op below) — no devtools or
// MCP attach needed. Capped; cleared on reload.
interface ConsoleEntry { level: 'log' | 'warn' | 'error'; ts: number; text: string }
interface ConsoleLogsParams { level?: 'log' | 'warn' | 'error'; limit?: number; since?: number }
const CONSOLE_BUFFER_MAX = 500;
const consoleBuffer: ConsoleEntry[] = [];
let consoleHooked = false;

/** Wrap console.* into the ring. Called by `initAgentBridge`; exported so a test can populate
 *  the buffer without standing up the whole bridge (jsdom has neither HMR nor the Electron
 *  bridge, so `initAgentBridge` returns early). Idempotent. */
export function installConsoleCapture(): void {
  if (consoleHooked) return;
  consoleHooked = true;
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        const text = args.map((a) =>
          typeof a === 'string' ? a
            : a instanceof Error ? (a.stack || a.message)
              : (() => { try { return JSON.stringify(a); } catch { return String(a); } })(),
        ).join(' ');
        consoleBuffer.push({ level, ts: Date.now(), text });
        if (consoleBuffer.length > CONSOLE_BUFFER_MAX) consoleBuffer.shift();
      } catch { /* never let capture break logging */ }
      original(...args);
    };
  }
  // Also capture uncaught errors + unhandled promise rejections — a failed dynamic
  // import or a throw deep in scene/resource loading never reaches console.*, so
  // tooling (/api/console-logs) would otherwise see a silent stall. Recorded at
  // 'error' level with the source URL so the failing module is identifiable.
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (e) => {
      try {
        const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
        const msg = e.error instanceof Error ? (e.error.stack || e.error.message) : String(e.message);
        consoleBuffer.push({ level: 'error', ts: Date.now(), text: `[uncaught] ${msg}${where}` });
        if (consoleBuffer.length > CONSOLE_BUFFER_MAX) consoleBuffer.shift();
      } catch { /* ignore */ }
    });
    window.addEventListener('unhandledrejection', (e) => {
      try {
        const r = (e as PromiseRejectionEvent).reason;
        const msg = r instanceof Error ? (r.stack || r.message) : String(r);
        consoleBuffer.push({ level: 'error', ts: Date.now(), text: `[unhandledrejection] ${msg}` });
        if (consoleBuffer.length > CONSOLE_BUFFER_MAX) consoleBuffer.shift();
      } catch { /* ignore */ }
    });
  }
}

function dumpConsoleLogs(p: ConsoleLogsParams = {}): { logs: ConsoleEntry[]; total: number } {
  let logs = consoleBuffer;
  if (p.level) logs = logs.filter((e) => e.level === p.level);
  if (p.since != null) logs = logs.filter((e) => e.ts > p.since!);
  const total = logs.length;
  if (p.limit != null) logs = logs.slice(-p.limit);
  return { logs, total };
}

/** Normalize a scene URL for comparison by the hot-reload equality gate.
 *
 *  The same scene can be referenced through several forms:
 *   - game app import: `/games/<id>/runtime/assets/scenes/x.json?url`
 *   - dev-server watcher broadcast: `/games/<id>/assets/…` or (editor) `/assets/…`
 *     (`findAssetRoots` strips `runtime/`; the editor watcher also strips the project)
 *   - editor "open scene": Vite's absolute `/@fs/<abspath>/…/runtime/assets/scenes/x.json`
 *
 *  Collapse `runtime/assets` → `assets`, drop the query, THEN reduce to the suffix
 *  from the last `/assets/` — so an absolute `/@fs/…` current path and a clean
 *  `/assets/…` broadcast resolve to the same key. Only one project is open at a time,
 *  so the `/assets/…` suffix uniquely identifies a scene (no cross-project collision). */
export function normScenePath(p: string): string {
  const s = p.split('?')[0].replace('/runtime/assets/', '/assets/');
  const i = s.lastIndexOf('/assets/');
  return i >= 0 ? s.slice(i) : s;
}

/** Which transport drives scene hot-reloads in the current environment.
 *
 *  The renderer's `/api/write-file` is routed (via `backendBase()`) to whichever
 *  backend owns the self-write guard (`markEditorWrite`). Scene reloads MUST be
 *  driven by that SAME backend's watcher — otherwise the editor's own writes look
 *  external and bounce the live scene, silently wiping unsaved in-memory state
 *  (e.g. the PrefabInstance tags a freshly-created prefab just applied to the tree).
 *
 *   - Electron (dev OR packaged): writes go to main (via `__modokiBackendBase`), so
 *     main's watcher owns the guard → drive reloads off the IPC `bridge`. In dev the
 *     Vite HMR watcher ALSO fires, but with a separate, unmarked guard — so it must
 *     be ignored here, not used as a second driver.
 *   - Browser dev (no bridge): writes go same-origin to the Vite dev server, whose
 *     guard IS marked → drive reloads off Vite HMR.
 *   - Neither: no live-reload transport. */
export function sceneReloadSource(env: { hasBridge: boolean; hasHot: boolean }): 'bridge' | 'vite' | null {
  if (env.hasBridge) return 'bridge';
  if (env.hasHot) return 'vite';
  return null;
}

/** Build a plain-JSON dump of the live ECS world — the "verify without a
 *  screenshot" payload. Reuses `getAllEntities` (which already returns the trait
 *  names present per entity), resolving each name to its meta via a map built
 *  once — avoids re-walking the world per entity. */
/** Default cap on the untargeted INDEX. Comfortably above a hand-authored scene, low
 *  enough that a generated one can't flood a context window before the agent narrows. */
export const DEFAULT_INDEX_LIMIT = 200;

export function dumpSceneState(params: SceneStateParams = {}) {
  const metaByName = new Map(getAllTraits().map((m) => [m.name, m] as const));
  const readTrait = params.full ? readTraitDataFull : readTraitData;
  const warnings: string[] = [];
  const all = getAllEntities();
  // Resource entities are mesh/material/prefab/env holders AND world-singleton
  // config traits (Time, Physics2D/3D, NPRPostFX). They clutter the DEFAULT
  // full-scene listing, so they're excluded there. But any TARGETING filter
  // (id/trait/name/where) is explicit intent to find something specific, so we keep
  // them — otherwise `trait=Time` or `where=Physics3D.gravityY<-5` would silently
  // drop the very singleton being queried (the S1 silent-empty trap). `resources`
  // forces inclusion regardless.
  // Parse `where` BEFORE deciding whether the query is targeted. A predicate that failed to
  // parse selected nothing, so it must not count as targeting — otherwise a typo
  // (`where=Transform.y >> 3`) silently flips the response from a capped index into an
  // uncapped full-fidelity dump of every entity, which is the opposite of what the typo asked
  // for and the largest payload the tool can produce.
  const whereResult = params.where ? parseWhere(params.where, metaByName) : null;
  const whereFailed = !!whereResult && 'error' in whereResult;
  if (whereResult && 'error' in whereResult) warnings.push(whereResult.error); // surface, don't silently return all
  const targeted = params.id != null || params.guid != null || params.trait != null || params.name != null || (params.where != null && !whereFailed);
  // INDEX MODE (the untargeted default). A bare `get_scene_state` used to serialize every
  // field of every trait of every entity — ~40k tokens on a 135-entity scene, a fifth of a
  // context window for a question the agent didn't ask. It almost never wants the values; it
  // wants to know WHAT EXISTS, then to ask about one thing.
  //
  // So: no filter and no enricher ⇒ return identity + trait NAMES, and a hint naming the way
  // in. Any of `id/trait/name/where` (explicit target) or `full/world/bounds/contacts`
  // (explicit request for per-entity data) opts back into the full-fidelity dump, unchanged.
  const enriched = !!(params.full || params.world || params.bounds || params.contacts);
  const indexMode = !targeted && !enriched;
  let wanted = (params.resources || targeted) ? all : all.filter((e) => !e.isResource);
  if (params.id != null) wanted = wanted.filter((e) => e.id === params.id);
  if (params.guid) {
    const ent = findEntityByGuid(params.guid);
    if (ent) { const gid = ent.id(); wanted = wanted.filter((e) => e.id === gid); }
    else { wanted = []; warnings.push(`guid "${params.guid}" matched no entity in the live world (it may be stale — ids/entities rebuild on scene reload).`); }
  }
  if (params.name) {
    const q = params.name.toLowerCase();
    wanted = wanted.filter((e) => (e.name ?? '').toLowerCase().includes(q));
  }
  if (whereResult && !('error' in whereResult)) wanted = wanted.filter((e) => whereResult.pred(e));
  const totalCount = wanted.length;
  let truncated = false;
  // A targeted query stays uncapped unless the caller asks — narrowing to `trait=Transform`
  // and then silently losing entities off the end would be worse than a large answer.
  const limit = params.limit ?? (indexMode ? DEFAULT_INDEX_LIMIT : undefined);
  if (limit != null && wanted.length > limit) {
    wanted = wanted.slice(0, limit);
    truncated = true;
  }
  // Screen-space geometry (S6) — projected once for the wanted set, keyed by id.
  const boundsById = params.bounds
    ? new Map((computeLayoutBounds({ ids: wanted.map((e) => e.id) }).entities ?? []).map((e) => [e.id, e] as const))
    : undefined;

  // Contact roll-up (Percept): resolve a contacted body's runtime id → its stable GUID
  // (memoized; the index stores ids since it's per-world and read within that world).
  const eaMeta = metaByName.get('EntityAttributes');
  const guidCache = new Map<number, string>();
  const guidOf = (id: number): string => {
    let g = guidCache.get(id);
    if (g === undefined) {
      const d = eaMeta ? readTraitData(id, eaMeta) : null;
      g = ((d?.guid as string) || '') || String(id);
      guidCache.set(id, g);
    }
    return g;
  };
  const contactWorld = params.contacts ? getCurrentWorld() : null;

  const entities = wanted.map((info) => {
    // Index mode: trait NAMES, no values. Plus the GUID — the only hot-reload-stable way to
    // address an entity (runtime ids are reassigned on every reload), and previously buried
    // inside `traits.EntityAttributes` where the untargeted caller could never cheaply see it.
    if (indexMode) {
      return { id: info.id, guid: guidOf(info.id), name: info.name, parentId: info.parentId, layer: info.layer ?? null, traits: info.traits };
    }
    const traits: Record<string, unknown> = {};
    for (const name of info.traits) {
      if (params.trait && name !== params.trait) continue;
      const meta = metaByName.get(name);
      if (!meta) continue;
      const data = meta.category === 'tag' ? true : readTrait(info.id, meta);
      // For the three animator traits, attach the switchable clip NAMES (derived) so an agent
      // can discover the engine.playClip targets without opening the clips bank / clipSet /
      // GLB. Omitted when empty (asset not loaded yet, or no clips).
      if (ANIMATOR_CLIP_TRAITS.has(name) && data && typeof data === 'object') {
        const clipNames = switchableClipNames(info.id, name);
        if (clipNames.length) (data as Record<string, unknown>).clipNames = clipNames;
      }
      traits[name] = data;
    }
    const out: Record<string, unknown> = { id: info.id, name: info.name, parentId: info.parentId, layer: info.layer ?? null, traits };
    if (params.world) {
      // Resolved world TRS + effective active state (S3). worldTransforms is empty
      // until transformPropagationSystem has run a frame; omit `world` if so.
      out.activeInHierarchy = !deactivatedEntities.has(info.id);
      const wt = worldTransforms.get(info.id);
      if (wt) out.world = { position: [wt.x, wt.y, wt.z], rotation: [wt.rx, wt.ry, wt.rz], scale: [wt.sx, wt.sy, wt.sz] };
    }
    if (params.bounds) {
      // Screen rect + on-screen flag (S6). null when no bounds provider reported one
      // (e.g. an entity with no renderable, or the renderer hasn't rendered yet).
      const b = boundsById?.get(info.id);
      out.screen = b?.screen ?? null;
      out.onScreen = b?.onScreen ?? false;
      // V5: true world-space AABB size/center (3D only), when the provider reported it.
      if (b?.worldAABB) out.worldAABB = b.worldAABB;
    }
    if (params.contacts && contactWorld) {
      // Current physics contacts as GUIDs, rolled up to bodies. Present only on a body
      // that's currently touching something (solid `contacts` / sensor `overlaps`).
      const cs = getContactState(contactWorld, info.id);
      if (cs?.contacts.length) out.contacts = cs.contacts.map(guidOf);
      if (cs?.overlaps.length) out.overlaps = cs.overlaps.map(guidOf);
    }
    return out;
  });
  // The hint is the whole point of a summary: a small answer is only useful if it says how to
  // ask the bigger question. Emitted in index mode, and whenever a cap actually bit.
  const hint = indexMode
    ? `Index only — trait NAMES, no values. Drill down: full=1 (all field values), trait=<Trait>, ` +
      `id=<n>, name=<substr>, where="Transform.y > 3". Enrichers: world=1, bounds=1, contacts=1, resources=1.` +
      (truncated ? ` Showing ${entities.length} of ${totalCount}; raise limit=N.` : '')
    : truncated
      ? `Showing ${entities.length} of ${totalCount}; raise limit=N or narrow the filter.`
      : undefined;
  return {
    scenePath: sceneManager.getCurrent()?.path ?? null,
    entityCount: entities.length,
    entities,
    ...(truncated ? { truncated, totalCount } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(hint ? { hint } : {}),
  };
}

/** A registered agent op: takes the raw params, returns a JSON-serializable result. */
export type AgentOpHandler = (params: unknown) => unknown | Promise<unknown>;

/** Op registry. The transport (Vite HMR / Electron IPC) funnels every request
 *  through `handleOp`, which looks the op up here. Runtime-only ops are registered
 *  inline below; the EDITOR injects its own ops (selection, play, undo, prefab, …)
 *  at editor-startup via `registerAgentOp` from the lazy editor path, so editor
 *  code is never pulled into the shipped game bundle. */
const agentOps = new Map<string, AgentOpHandler>();

/** Optional gate that suppresses scene hot-reload while it would be discarded.
 *  Installed by the EDITOR (lazy path) — in editor Play mode a scene edit would
 *  hot-reload the live world but then be clobbered by the Play-press snapshot on
 *  Stop (see editor/scene/playMode.ts), so we skip the reload and tell the caller
 *  to Stop first. Unset in the shipped game runtime (which has no Stop that could
 *  clobber), so hot-reload there always proceeds. Returns a reason string when
 *  reload should be suppressed, else null. */
let _reloadSuppressor: (() => string | null) | null = null;

/** Editor-only: install the hot-reload suppression gate. Called from
 *  `agentEditorOps.ts` at editor startup so game builds never suppress. */
export function setSceneReloadSuppressor(fn: (() => string | null) | null): void {
  _reloadSuppressor = fn;
}

/** Why scene hot-reload is currently suppressed (editor Play mode), or null when
 *  it may proceed. Also consulted by the backend to refuse mutate-while-playing. */
export function sceneReloadSuppressedReason(): string | null {
  return _reloadSuppressor?.() ?? null;
}

/** Register (or replace) an agent op handler. Editor-only ops call this from
 *  `engine/app/editor/agentEditorOps.ts` during editor startup. */
export function registerAgentOp(name: string, handler: AgentOpHandler): void {
  agentOps.set(name, handler);
}

/** The currently-registered op names (testing / diagnostics). */
export function listAgentOps(): string[] {
  return [...agentOps.keys()];
}

// Built-in runtime ops (no editor deps — safe in every build the bridge runs in).
// Round agent-facing floats at the OP, never in `dumpSceneState` — an in-process caller must
// keep exact float64. `precision` defaults to 9 significant digits (~17% of the real tokens on a
// Transform drill-down, max error 3.5e-7); pass precision=0 for exact values. Verify edits with a
// tolerance, not `===`.
registerAgentOp('scene-state', (params) => {
  const p = (params ?? {}) as SceneStateParams & { precision?: number };
  return roundFloats(dumpSceneState(p), resolvePrecision(p.precision));
});
// Deterministic offscreen frame → JPEG data URL. The backend decodes it to a temp
// file so the agent gets a path, not an inline image.
registerAgentOp('render-scene', (params) => renderSceneOffscreen((params ?? {}) as OffscreenRenderOpts));
// Summary-first at the OP, never in `dumpConsoleLogs` — `diagnose` (below) reads that
// producer directly for its error list, and a default tail there would silently drop errors
// from `modoki_diagnose` with no failing test. The ring holds 500 entries (~20–27k tokens);
// a bare read returns the last 50 plus a per-level histogram of the whole window.
registerAgentOp('console-logs', (params) => {
  const p = (params ?? {}) as ConsoleLogsParams;
  // Filter here, tail here: pass no `limit` to the producer so the histogram sees everything.
  const { logs } = dumpConsoleLogs({ level: p.level, since: p.since });
  const r = tailWithCounts(logs, (e) => e.level, { limit: p.limit, defaultLimit: CONSOLE_TAIL_DEFAULT });
  return {
    logs: r.items,
    total: r.total,
    byLevel: r.byType,
    ...(r.truncated ? { truncated: true, hint: tailHint('console entries', r.items.length, r.total, ', or narrow with level=/since=') } : {}),
  };
});

// ── Phase A: semantic verification (event journal + action dispatch) ──
// Read the tick-stamped game-event trace — the screenshot-free way to verify game
// LOGIC (assert on match/score/win). Journaling is on by default, but force-enable
// in case a shipped game turned it off, so the agent always sees events.
registerAgentOp('journal-events', (params) => {
  const p = (params ?? {}) as { type?: string; level?: 'info' | 'warn' | 'error'; clear?: boolean; limit?: number; action?: 'start' | 'stop' };
  setJournalEnabled(true);
  // Tier-2 capture control: `action:start|stop` with `type` names the watch-gated diagnostic
  // (e.g. @contact) to begin/end capturing. Off by default so the journal stays lean; a Tier-2
  // type emits NOTHING until started, and only from the start point forward (no back-history).
  if (p.action === 'start' || p.action === 'stop') {
    const t = p.type;
    if (!t) return { ok: false, reason: 'action needs type= naming the diagnostic to capture (e.g. @contact)', captures: verboseCaptureState() };
    if (!isVerboseType(t)) return { ok: false, reason: `"${t}" is always-on, not watch-gated — nothing to start/stop. Watch-gated types: ${verboseCaptureState().types.join(', ') || '(none)'}.`, captures: verboseCaptureState() };
    setVerboseCapture(t, p.action === 'start');
    return { ok: true, action: p.action, type: t, captures: verboseCaptureState() };
  }
  const events = (p.type || p.level) ? journalEvents({ type: p.type, level: p.level }) : journalEvents();
  if (p.clear) clearJournal();
  // Tail at the op. `journalEvents()` stays whole for JournalTab, which slices its own view.
  // A busy physics Play session fills the 10,000-event ring with ~226-byte `@contact` events
  // — ~582k tokens if returned entire.
  const r = tailWithCounts(events, (e) => String((e as { type?: string }).type ?? '?'), { limit: p.limit, defaultLimit: JOURNAL_TAIL_DEFAULT });
  // Surface Tier-2 capture state so a reader knows a diagnostic (@contact) is OFF unless it
  // opened a watch — otherwise an empty @contact result reads as "no contacts" not "not capturing".
  const captures = verboseCaptureState();
  const idle = captures.types.filter((t) => !captures.active.includes(t));
  return {
    count: r.items.length,
    total: r.total,
    byType: r.byType,
    events: r.items,
    captures,
    ...(idle.length ? { captureHint: `${idle.join(', ')} ${idle.length > 1 ? 'are' : 'is'} watch-gated and NOT capturing — start with action:'start', type:'${idle[0]}' before the moment you want to trace.` } : {}),
    ...(r.truncated ? { truncated: true, hint: tailHint('events', r.items.length, r.total, ', or narrow with type=') } : {}),
  };
});
// Resolve journal/contact refs (GUIDs and/or numeric ids) to entity display names —
// the deliberate second hop that keeps names OUT of the journal stream. Names come from
// the emit-time side-table FIRST (so a since-despawned projectile/gem/enemy still
// resolves — a live-world lookup alone couldn't), then a live-world lookup for a
// still-alive entity whose name was never journaled. Batched: send every ref you care
// about after you've narrowed down, get one small { ref: {name, alive} } map back.
registerAgentOp('resolve-refs', (params) => {
  const p = (params ?? {}) as { refs?: (string | number)[] };
  const refs = Array.isArray(p.refs) ? p.refs : [];
  if (refs.length === 0) return { resolved: {} }; // nothing to resolve — skip the world walk
  // Normalize each requested ref ONCE: a numeric id (a real number from device JSON OR a numeric
  // string from the editor GET query) vs a GUID string.
  const norm = refs.map((ref) => ({
    ref,
    asNum: typeof ref === 'number' ? ref : (/^\d+$/.test(ref) ? Number(ref) : undefined),
  }));
  const wantNum = new Set<number>();
  const wantGuid = new Set<string>();
  for (const { ref, asNum } of norm) { if (asNum != null) wantNum.add(asNum); else wantGuid.add(ref as string); }
  // Single pass over the live world, collecting names ONLY for the wanted entities — avoids
  // materializing two whole-scene maps to answer an O(refs) question.
  const liveNum = new Map<number, string>();
  const liveGuid = new Map<string, string>();
  for (const e of getAllEntities()) {
    if (wantNum.has(e.id)) liveNum.set(e.id, e.name ?? '');
    if (e.guid && wantGuid.has(e.guid)) liveGuid.set(e.guid, e.name ?? '');
  }
  const resolved: Record<string, { name: string; alive: boolean }> = {};
  const unresolved: (string | number)[] = [];
  for (const { ref, asNum } of norm) {
    const live = asNum != null ? liveNum.get(asNum) : liveGuid.get(ref as string);
    // Side-table fallback names a despawned entity. It's keyed by the entity's numeric id OR its
    // GUID string — never a numeric STRING — so look up the numeric form when the ref is numeric,
    // else the GUID as-is. A live name wins (it's current); for a live entity both agree anyway.
    const name = live ?? resolveRefName(asNum ?? ref);
    if (name != null && name !== '') resolved[String(ref)] = { name, alive: live != null };
    else unresolved.push(ref);
  }
  return { resolved, ...(unresolved.length ? { unresolved } : {}) };
});
// Discover what an agent can dispatch/read: action names + their param schemas,
// and the live named read-values (e.g. canGoBack, timeSinceGameStart).
registerAgentOp('game-introspect', () => ({
  actions: getUIActionNames().map((name) => ({ name, params: getUIActionParams(name) ?? null })),
  readValues: getReadSourceNames().map((name) => ({ name, value: getReadValue(name) })),
}));
// Trigger a game intent directly (no pixel-hunting a button). Dispatch is inert
// unless the sim is playing, and throws in dev on an unknown name — so guard both.
registerAgentOp('dispatch-action', (params) => {
  const p = (params ?? {}) as { name?: string; payload?: string | number; params?: Record<string, unknown>; targetGuid?: string };
  // Every "did not dispatch" return carries ok:false so the MCP client's isFailureBody (which inspects
  // ok/error/errors, NOT dispatched) surfaces it as a failed tool call — an unknown name / stale guid /
  // not-playing no-op was reported as a non-error success at HTTP 200 before. (F8)
  if (!p.name) return { ok: false, dispatched: false, reason: 'missing action name' };
  if (!isSimRunning()) return { ok: false, dispatched: false, reason: 'not playing — press Play first', simRunning: false };
  if (!getUIActionNames().includes(p.name)) return { ok: false, dispatched: false, reason: `unknown action '${p.name}'`, known: getUIActionNames() };
  // Resolve targetGuid HERE so a phantom guid is reported, not obeyed. dispatchUIAction
  // scans for it and, finding nothing, calls the handler with target:undefined — the handler
  // console.warns and returns, and this op used to answer {dispatched:true}. The agent then
  // read back, saw no change, and had no way to tell "guid didn't resolve" from "the handler
  // ignored me" from "the clip name was wrong". Stale guids are routine (any hot-reload or
  // play→stop rebuilds the world). (C7)
  if (p.targetGuid && !findEntityByGuid(p.targetGuid)) {
    return { ok: false, dispatched: false, reason: `targetGuid '${p.targetGuid}' matched no entity in the live world — it may be stale (ids/entities are rebuilt on scene reload and play→stop). Re-read it with get_scene_state.`, simRunning: true };
  }
  // engine.playClip: validate the clip NAME against the target's switchable clips. C7 fixed the
  // phantom-GUID case but not the phantom-CLIP case — a typo'd/wrong-case clip name only
  // console.warned while the op reported dispatched:true, so the agent trusted a switch that
  // never happened. Only reject a wrong clip when the clip list is KNOWN (non-empty): an empty list is
  // ambiguous (the animator's clipSet/GLB may not have loaded yet), so rejecting on it would
  // false-negative a valid clip — mirrors list_traits' empty-registry nuance. (C7 re-audit.)
  if (p.name === 'engine.playClip') {
    const clip = (p.params as { clip?: unknown } | undefined)?.clip;
    const entityId = p.targetGuid ? findEntityByGuid(p.targetGuid)?.id() : undefined;
    if (entityId != null) {
      // No animator trait at all → engine.playClip only console.warns and no-ops, but the op used to
      // answer dispatched:true. Reject: nothing to drive. This is DISTINCT from an empty clip list
      // (clips-not-loaded, ambiguous) — a missing trait is unambiguous, so it's safe to fail here. (F5)
      const ent = getAllEntities().find((e) => e.id === entityId);
      if (!ent || !ent.traits.some((t) => ANIMATOR_CLIP_TRAITS.has(t))) {
        return { ok: false, dispatched: false, reason: `target '${p.targetGuid}' has no animator trait (Animator / SpriteAnimator / SkeletalAnimator) — engine.playClip has nothing to drive.`, simRunning: true };
      }
      if (typeof clip === 'string' && clip) {
        const known = [...ANIMATOR_CLIP_TRAITS].flatMap((t) => switchableClipNames(entityId, t));
        if (known.length > 0 && !known.includes(clip)) {
          return { ok: false, dispatched: false, reason: `no clip named "${clip}" on the target's animator (names are case-sensitive). Known clips: ${known.join(', ')}.`, known, simRunning: true };
        }
      }
    }
  }
  dispatchUIAction(p.name, { payload: p.payload, params: p.params, targetGuid: p.targetGuid });
  return { dispatched: true, simRunning: true, ...(p.targetGuid ? { targetResolved: true } : {}) };
});
// Clear the journal (start of a clean playtest scenario).
registerAgentOp('clear-journal', () => { clearJournal(); return { ok: true }; });

// Evict the browser-side GPU caches for freshly re-baked assets so the LIVE viewport
// (and the offscreen render_scene path, same renderer) rebinds the new variant WITHOUT a
// scene reload or editor restart. `/api/reimport` calls this via requestBrowser after a
// successful bake — the server writes new bytes but has no other channel to the renderer,
// so the mesh/texture cache (keyed by path, "bytes never change mid-session without an
// explicit invalidate") would otherwise keep serving the stale geometry until restart.
// Mirrors the Assets-panel button path (assetViews/reimport.ts), so MCP/curl reimports now
// refresh identically. invalidateModel disposes the model's templates + LOD siblings + mesh
// entries and notifies onModelInvalidated listeners, which drop the live meshes for re-sync.
registerAgentOp('invalidate-assets', (params) => {
  const p = (params ?? {}) as { items?: Array<{ path?: string; type?: string }> };
  let models = 0, textures = 0;
  for (const it of p.items ?? []) {
    if (!it?.path) continue;
    if (it.type === 'model') { invalidateModel(it.path); models++; }
    else if (it.type === 'texture') { invalidateTexture(it.path); textures++; }
  }
  return { ok: true, models, textures };
});

// ── Phase B: numeric screen-space layout/bounds (turn "is it laid out right?" into data) ──
registerAgentOp('layout-bounds', (params) => {
  // Same reasoning as scene-state. `diagnose` reads `computeLayoutBounds().offScreen` (ids, ints)
  // from the PRODUCER, so it is unaffected either way — but keep the rounding here regardless.
  const p = (params ?? {}) as LayoutBoundsParams & { precision?: number };
  return roundFloats(computeLayoutBounds(p), resolvePrecision(p.precision));
});

// ── Enact Phase 2: numeric handle geometry — WHERE the draggable handles are in the
// Canvas2D/SVG authoring editors, so `drag-handle`/`tap-handle` can aim without pixels. ──
registerAgentOp('enact-handles', (params) => computeHandles((params ?? {}) as HandlesDumpParams));

// Editor CHROME joins the same registry, so `tap_handle` drives a panel button with no new
// input tool. Registered once here rather than per-panel: it is one DOM walk over
// `[data-ui-id]`, not a per-editor geometry computation like the Canvas2D providers.
//
// Belt-and-braces, not a fixed bug: unlike `registerAgentOp` (a Map keyed by name, so
// re-registering replaces), the handle registry is a Set of function references — a
// re-execution of this module with a fresh `chromeHandles` reference would ADD a second
// provider and double every chrome handle. Today that can't happen (this module has no HMR
// accept boundary, so an edit below it forces a full page reload, which resets the
// registry) — verified by editing `chromeHandles.ts` live and watching the count stay put.
// The dispose costs one line and makes the invariant not depend on that reload.
const unregisterChromeHandles = registerHandleProvider(chromeHandles);
import.meta.hot?.dispose(() => unregisterChromeHandles());

// ── Selector-aware input: resolve a CSS selector to a live viewport point (+ who is
// actually on top of it) so the trusted-input host routes can aim without a round-trip
// race. Renderer-side because only the renderer has the DOM. ──
registerAgentOp('resolve-dom-point', (params) => resolveDomPointReport((params ?? {}) as DomPointSpec));

// ── Phase F: structured render/scene health (causes, not a black screenshot) ──
// Only errors from the last 30s gate `ok` (F14): a stale load-time / prior-scene error otherwise
// pins ok:false forever. Date.now() is fine here — app/debug is outside the runtime determinism
// guard, and the console ring already stamps entries with Date.now().
const DIAGNOSE_ERROR_WINDOW_MS = 30_000;
registerAgentOp('diagnose', () => computeDiagnostics({
  consoleErrors: dumpConsoleLogs({ level: 'error' }).logs,
  now: Date.now(),
  errorWindowMs: DIAGNOSE_ERROR_WINDOW_MS,
}));

// ── Percept Watch: standing numeric time-series (how a NUMBER moved over time) ──
registerAgentOp('watch-start', (params) => startWatch((params ?? {}) as StartWatchParams));
// Stats-first. `readWatch` keeps returning raw `samples` — WatchTab.tsx imports it directly
// and renders them into a Sparkline, so stripping them in the PRODUCER would blank the human's
// chart to fix the agent's token bill. Strip them here, at the op.
// Measured: 39.8 chars/sample; the caps (512 series × 600 samples default, 5000 ceiling) put a
// raw read at ~3.1M–25.8M tokens. Per-field stats (first/last/min/max/delta/settled) are the
// answer to "how did this number move?" — 159 bytes vs 24,006 for a full 600-sample series.
// Default series cap (F7). A broad watch (component:Transform, no guids/names — documented usage) has
// hundreds of series; a bare `watch read` with no limit emitted every one (up to MAX_SERIES_CEIL=4096,
// ~160KB–1MB), unlike sibling reads (journal, get_scene_state) which default-cap. Cap HERE at the op —
// NOT in readWatch, which WatchTab.tsx calls directly and needs every series for its chart. seriesTotal/
// seriesTruncated (already emitted by readWatch when limit < matched) announce the truncation.
const DEFAULT_WATCH_SERIES_LIMIT = 100;
registerAgentOp('watch-read', (params) => {
  const p = (params ?? {}) as { id?: string; clear?: boolean; samples?: boolean; precision?: number; name?: string; guids?: string[]; limit?: number };
  const sig = resolvePrecision(p.precision);
  const out = readWatch(p.id ?? '', { clear: p.clear, name: p.name, guids: p.guids, limit: p.limit ?? DEFAULT_WATCH_SERIES_LIMIT }) as { ok?: boolean; series?: Array<Record<string, unknown>> };
  // `roundFloats` COPIES, which matters here: `readWatch` hands back the LIVE `samples` arrays
  // that WatchTab renders. Rounding in place would degrade the human's sparkline.
  if (!out?.ok || !Array.isArray(out.series)) return out;
  if (p.samples) return roundFloats(out, sig);
  const totalSamples = out.series.reduce((n, s) => n + (typeof s.count === 'number' ? s.count : 0), 0);
  return roundFloats({
    ...out,
    series: out.series.map(({ samples: _samples, ...rest }) => rest),
    totalSamples,
    hint: `Stats only (${totalSamples} samples across ${out.series.length} series). Pass samples=true for the raw time-series.`,
  }, sig);
});
registerAgentOp('watch-list', () => listWatches());
registerAgentOp('watch-clear', (params) => clearWatch((params as { id?: string })?.id));

// ── Phase E: time-scale control (0=pause, 0.3=slow-mo, 2=fast) — inspect fast motion ──
registerAgentOp('set-timescale', (params) => {
  const { scale } = (params ?? {}) as { scale?: number };
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0) {
    return { ok: false, error: 'scale must be a finite number >= 0' };
  }
  setTimeScale(getCurrentWorld(), scale);
  return { ok: true, timeScale: getTimeScale(getCurrentWorld()) };
});

/** Dispatch a server request op to a result via the registry.
 *
 *  Exported (like `listAgentOps`) so tests can exercise an op through the SAME entry point the
 *  bridge transport uses. That matters for the Phase-6 seams: the summary-first shaping lives in
 *  the op handlers, so a test that called the producer directly would prove nothing. */
export async function runAgentOp(op: string, params: unknown = {}): Promise<unknown> {
  const handler = agentOps.get(op);
  if (!handler) throw new Error(`unknown agent op '${op}'`);
  return handler(params);
}
const handleOp = runAgentOp;

/** Hot-reload the active scene when its file (or any prefab) changes on disk.
 *  Shared by the Vite HMR path and the Electron IPC path. */
async function handleSceneChanged(msg: { urlPath: string; kind: 'scene' | 'prefab' | 'animation' }): Promise<void> {
  // An .anim.json changed on disk → drop the cached clip. NOT a scene reload: the clip cache
  // is the only thing stale, and reloading would throw away unsaved live work.
  //
  // Without this the cache held the pre-edit clip forever — `invalidateAnimationClip` was
  // exported, tested, and had ZERO production callers. Any read-modify-write on a clip
  // (anim_add_key) then re-read the STALE copy and wrote it back, silently REVERTING the
  // file. Hits modoki_write_asset AND the headline case for this whole feature: the user's
  // own Claude Code editing a .anim.json with a plain file Write. (C7)
  if (msg.kind === 'animation') {
    invalidateAnimationClip(msg.urlPath);
    return;
  }
  const current = sceneManager.getCurrent()?.path;
  if (!current) return;
  // Suppressed in editor Play mode: reloading now would be discarded by the
  // Play-press snapshot on Stop, so the edit would silently vanish. Skip and log
  // — the caller (agent mutate) is told separately to Stop first.
  const suppressed = sceneReloadSuppressedReason();
  if (suppressed) {
    console.warn(`[agentBridge] scene hot-reload skipped (${msg.kind} change: ${msg.urlPath}) — ${suppressed}`);
    return;
  }
  // In prefab-edit mode the active "scene" is a synthetic in-memory scene
  // (`/__prefab-edit__/<guid>`) with no file on disk — leave it alone.
  if (current.startsWith('/__prefab-edit__/')) return;
  // Prefab edits require re-expanding instances → always reload the current
  // scene. Scene edits only reload if they touch the active scene.
  if (msg.kind === 'scene' && normScenePath(msg.urlPath) !== normScenePath(current)) return;
  try {
    // Fetch the fresh file once: validate it AND hand it to loadScene via
    // `preloaded` so the reload doesn't fetch the same bytes a second time.
    let preloaded: SceneData | undefined;
    try {
      const res = await fetch(current, { cache: 'no-store' });
      if (res.ok) {
        preloaded = await res.json();
        const { warnings } = validateSceneData(preloaded, buildSceneSchema());
        if (warnings.length) {
          console.warn(`[agentBridge] ${warnings.length} validation warning(s) in ${current}:`);
          for (const w of warnings) console.warn(`  • ${w}`);
        }
      }
    } catch { /* fall back to loadScene's own fetch */ }
    await sceneManager.loadScene(current, preloaded ? { preloaded } : undefined);
    console.log(`[agentBridge] hot-reloaded scene (${msg.kind} change: ${msg.urlPath})`);
  } catch (e) {
    // A newer reload superseding this one aborts the in-flight load
    // (SceneManager throws DOMException 'AbortError'). That's expected — the
    // superseding reload logs its own success — not a failure. This fires
    // routinely when several files change at once (e.g. deleting a batch of
    // unused prefabs), so keep it quiet rather than an alarming "failed" warn.
    if (e instanceof DOMException && e.name === 'AbortError') {
      console.log(`[agentBridge] scene hot-reload superseded (${msg.kind} change: ${msg.urlPath})`);
      return;
    }
    console.warn('[agentBridge] scene hot-reload failed:', e);
  }
}

/** Push the trait-registry schema via `send`, retrying until the registry is
 *  populated (app trait registration may not have run yet). Returns a starter. */
function makeSchemaPusher(send: (schema: ReturnType<typeof buildSceneSchema>) => void) {
  let tries = 0;
  const pushOnce = (): boolean => {
    try {
      const schema = buildSceneSchema();
      if (Object.keys(schema.traits).length === 0) return false; // not ready yet
      send(schema);
      return true;
    } catch { return false; }
  };
  const tick = () => { if (pushOnce() || tries++ > 40) return; setTimeout(tick, 200); };
  return { start: () => { tries = 0; tick(); }, pushOnce };
}

export function initAgentBridge(): void {
  const hot = import.meta.hot;
  const bridge = (window as unknown as { __modokiElectron?: { bridge?: ElectronBridge } }).__modokiElectron?.bridge;
  // Exactly ONE backend's watcher drives scene reloads — the one owning the
  // self-write guard for this renderer's writes (see sceneReloadSource).
  const reloadSource = sceneReloadSource({ hasBridge: !!bridge, hasHot: !!hot });
  if (!hot && !bridge) return;

  // Capture console output ASAP so /api/console-logs can surface editor errors
  // (e.g. failed scene/mesh loads) without a devtools attach.
  installConsoleCapture();

  // ── Electron: also serve the main-hosted backend over IPC (ELECTRON_PLAN
  //    Phase 2). Schema push + request answering are required so main's backend
  //    can type-check and run /api/scene-state. Under dev the page is Vite-served,
  //    so scene-reload + manifest stay on the live HMR socket below (avoids a
  //    double reload); in a packaged build (no `hot`) main drives those too. ──
  if (bridge) {
    const pusher = makeSchemaPusher((schema) => bridge.send('schema', schema));
    pusher.start();
    bridge.on('request', async (data) => {
      const msg = data as { id: number; op: string; params?: unknown };
      try { bridge.send('response', { id: msg.id, result: await handleOp(msg.op, msg.params) }); }
      catch (e) { bridge.send('response', { id: msg.id, error: String(e instanceof Error ? e.message : e) }); }
    });
    // Drive scene reloads off main's watcher (which owns the guard) when chosen —
    // for an Electron bridge this is ALWAYS the case, dev or packaged. See
    // sceneReloadSource for why the Vite HMR path must NOT also drive reloads here.
    if (reloadSource === 'bridge') {
      bridge.on('scene-changed', (data) => { void handleSceneChanged(data as { urlPath: string; kind: 'scene' | 'prefab' | 'animation' }); });
    }
    if (!hot) {
      // Packaged build (no Vite HMR): main also drives manifest updates. In dev,
      // init.ts handles Vite's `asset-manifest-updated` instead — don't double up.
      bridge.on('manifest-updated', (data) => {
        try { loadManifestJson(data as Parameters<typeof loadManifestJson>[0]); }
        catch (e) { console.warn('[agentBridge] manifest update failed:', e); }
      });
    }
  }

  if (!hot) return;

  // ── Vite HMR path (browser dev + Electron-dev renderer) ──
  // 1. Push the trait-registry schema, re-pushing after an HMR update (a
  //    game/trait edit may change the registry) and on reconnect (server restart
  //    drops the cache).
  let schemaPushed = false;
  const pusher = makeSchemaPusher((schema) => { hot.send('modoki:schema', schema); schemaPushed = true; });
  pusher.start();
  hot.on('vite:afterUpdate', () => { schemaPushed = false; pusher.start(); });
  hot.on('vite:ws:connect', () => { if (!schemaPushed) pusher.start(); });

  // 2. Answer request ops from the dev server.
  hot.on('modoki:request', async (msg: { id: number; op: string; params?: unknown }) => {
    try { hot.send('modoki:response', { id: msg.id, result: await handleOp(msg.op, msg.params) }); }
    catch (e) { hot.send('modoki:response', { id: msg.id, error: String(e instanceof Error ? e.message : e) }); }
  });

  // 3. Hot-reload the active scene on a .scene.json / .prefab.json edit — ONLY when
  //    Vite owns the self-write guard (browser dev, same-origin writes). With an
  //    Electron bridge, main's watcher drives reloads (registered above); listening
  //    here too would double-reload AND bounce the scene on the editor's own writes
  //    (Vite's guard is never marked from this renderer). See sceneReloadSource.
  if (reloadSource === 'vite') {
    hot.on('modoki:scene-changed', (msg: { urlPath: string; kind: 'scene' | 'prefab' | 'animation' }) => { void handleSceneChanged(msg); });
  }
}
