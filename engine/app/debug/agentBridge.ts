/** Agent bridge — the glue that makes the engine friendly to AI agents (and any tooling).
 *
 *  Home of the AGENT-OP REGISTRY: `registerAgentOp` here registers an op on every surface at once
 *  — the editor, the device, and BOTH eval APIs (`evalApi.ts` / `deviceEvalApi.ts` are generated
 *  from this registry, so they add composition and no capability of their own). The editor injects
 *  its extra ops from `../editor/agentEditorOps.ts`, which runs LATER (a function call from
 *  `setup.ts`, against this module's top-level registrations) and therefore REPLACES a name where
 *  it has a richer, undoable version. Which half an op belongs in is a rule, not a habit — see
 *  docs/mcp-tool-conventions.md §9.
 *
 *  Three transports reach it: Vite's HMR websocket (dev), Electron IPC (packaged editor), and the
 *  TCP device lease (a game on a phone). The ops themselves are transport-agnostic.
 *
 *  Its jobs, beyond the registry: push the live trait-registry schema to the dev server so
 *  `/api/validate-scene` + `/api/scene-mutate` can type-check scene JSON (the registry only exists
 *  here, in the browser), and hot-reload the active scene when its `.scene.json`/`.prefab.json`
 *  changes on disk.
 *
 *  ⚠️ NOT gated on `import.meta.hot` — this docblock said so for a long time and it was WRONG in a
 *  way that matters. The registrations below are top-level, and a **device** build is a production
 *  build that runs them. What actually keeps all of this out of a shipped app is
 *  `project.config.json` `build.debugBuild` (`engine/app/main.tsx:14`), which decides whether the
 *  bridge is mounted at all. Do not re-derive the safety answer from this file's scope.
 *
 *  HMR note (load-bearing, and INCIDENTAL — which is why it is written down): this module has no
 *  `import.meta.hot.accept` boundary, and it is imported both through `App.tsx` (which self-accepts)
 *  AND directly from `main.tsx`, which does not. Vite propagates an update only when EVERY importer
 *  path reaches a boundary, so the `main.tsx` dead end forces a full page RELOAD for any edit here —
 *  which re-runs the whole boot sequence, editor registrations included. That is what stops a hot
 *  patch from re-running the top-level registrations and silently reverting the editor's undoable
 *  ops to the runtime ones. Nobody designed it as a safety mechanism: removing or `@vite-ignore`-ing
 *  the `main.tsx` import, or adding an accept boundary here, would quietly break it. */

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
  getTime,
  registerFrameCallback,
  unregisterFrameCallback,
  getCurrentWorld,
  getContactState,
  registerHandleProvider,
  invalidateModel,
  invalidateTexture,
  invalidateAudio,
  invalidateEnvironment,
  switchableClipNames,
  ANIMATOR_CLIP_TRAITS,
  type OffscreenRenderOpts,
  type SceneData,
  invalidateAnimationClip,
  invalidateTimeline,
  invalidateParticleEffect,
  invalidateSpriteAnim,
  invalidateRig2D,
  invalidateAnimSet,
  findEntityByGuid,
  getCachedPrefab,
  getAllAssets,
  PlayerPrefs,
  type JsonValue,
  raycast2D, shapeCast2D, pointQuery2D, hasPhysics2D,
  raycast3D, shapeCast3D, pointQuery3D, hasPhysics3D,
  findEntityById,
  EntityAttributes,
  makeAssetRefResolver,
  getParticleEffect,
  getAnimationClip,
  getTimeline,
  getSpriteAnim,
  getRig2D,
  startInputWatch,
  stopInputWatch,
  clearInputPresses,
  readInputPresses,
  type InputPressRecord,
} from '@modoki/engine/runtime';
import { applyLiveMutate } from './liveMutate';
import { createEntityLive, duplicateEntityLive, deleteEntitiesLive } from './liveLifecycle';
import { computeLayoutBounds, type LayoutBoundsParams, type LayoutEntry } from './layoutDump';
import { tailWithCounts, tailHint, CONSOLE_TAIL_DEFAULT, JOURNAL_TAIL_DEFAULT } from './streamSummary';
import { roundFloats, resolvePrecision } from './roundFloats';
import { computeHandles, type HandlesDumpParams } from './handlesDump';
import { resolveDomPointReport, type DomPointSpec } from './domResolve';
import { layoutSettleReport } from './layoutSettle';
import { resolveEntityPointReport, type EntityPointSpec } from './entityResolve';
import { readConsoleSource } from './consoleSource';
import { getConsoleRingEntries, getConsoleRingDropped, installConsoleRing } from '@modoki/engine/runtime/core/consoleRing';
import { chromeHandles } from './chromeHandles';
import { computeDiagnostics } from './diagnose';
import { makeSchemaPusher } from './schemaPusher';
import {
  startCapture, stopCapture, clearCapture, getCapture, readPerfProfile,
  resetProfilerMarkers, resetMarkerAggregate, resetFrameProfile, type MarkerSample,
  getBootTimeline, getBootOrigin, bootSpansOverlapping, resetBootTimeline, getWorstStallWindow,
  getFrameProfile,
  setGpuTimingEnabled, resetGpuTimings,
  collectHitRegions, hitRegionProviders, isHitRegionOverlayVisible, setHitRegionOverlayVisible,
  regionsAt, nearestRegionTo,
} from '@modoki/engine/runtime';
import {
  listAgentTools, getAgentTool, agentToolsVersion, validateAgentToolArgs, type AgentToolDef,
} from '@modoki/engine/runtime';
import { startWatch, readWatch, listWatches, clearWatch, type StartWatchParams } from './watch';
// Percept S3: resolved world transforms + hierarchy-deactivation set, both computed
// each frame by transformPropagationSystem. Same module instance the renderers read.
import {
  worldTransforms, deactivatedEntities,
  // The LIVE downloaded-video cache, read through a one-slot registry rather than by importing
  // `app/ecs/pipeline` (which builds it): that import drags the whole pipeline — registerSystem
  // calls and all — into every module that imports this one, and it broke five headless tests
  // on the first attempt. See videoCacheSlot.ts.
  getActiveVideoCache,
} from '@modoki/engine/runtime';

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

// ── Console capture ── the ONE shared engine console ring (#596/#597 Stage 3a), read here for
// an agent/tooling to reach via the curl-able /api/console-logs (backed by the 'console-logs' op
// below) — no devtools or MCP attach needed.
interface ConsoleEntry { level: 'log' | 'warn' | 'error'; ts: number; text: string }
interface ConsoleLogsParams { level?: 'log' | 'warn' | 'error'; limit?: number; since?: number }

/** UNTIL STAGE 3a this wrapped `console.log/warn/error` into a private `consoleBuffer` and
 *  registered its OWN `window` `error`/`unhandledrejection` listeners — a SECOND capture,
 *  duplicating the shared ring `installConsoleRing.ts` installs eagerly, and (once Stage 2 made
 *  both feed that one ring) a SECOND ring entry for every uncaught error, alongside the one
 *  `deviceConsoleCapture.ts` recorded. Both private captures are gone; the shared ring is the only
 *  wrapper and `./uncaughtCapture.ts` (registered from `installConsoleRing.ts`'s gate) is the only
 *  uncaught-error listener, anywhere in the app.
 *
 *  This function no longer decides when capture starts — that used to be the boot hole: capture
 *  began only once `initAgentBridge()` ran (after `if (!hot && !bridge) return`), measured at
 *  ~1.16s into boot, missing App.tsx's module eval at nav+276ms and React's mount at nav+305ms. The
 *  eager, superset-gated `installConsoleRing.ts` import closes that hole regardless of whether this
 *  function is ever called. Kept only as a shim so its existing callers (`initAgentBridge`, below,
 *  and `ringBufferSeams.test.ts`) still work: it just makes sure the shared ring is installed, for a
 *  test that imports this module directly without going through `main.tsx`'s eager import. */
export function installConsoleCapture(): void {
  installConsoleRing();
}

/** Project the shared ring into this module's `ConsoleEntry` shape.
 *
 *  `readConsoleSource()` is preferred when set: #157's seam (`consoleSource.ts`) is STILL how the
 *  DEVICE ring reaches `diagnose` — do not delete it thinking it's dead, and do not read this
 *  function as its replacement. It degrades to `null` when nobody registered a source, which is the
 *  ordinary case for a PACKAGED (non-dev) editor: `installDeviceConsoleCapture()`'s narrower gate
 *  never fires there even though the shared ring itself does (`installConsoleRing.ts`'s gate
 *  includes `__MODOKI_EDITOR__`) — so this function is the fallback that keeps `/api/console-logs`
 *  non-empty in exactly that build. */
function ringEntriesAsConsoleEntries(): ConsoleEntry[] {
  return getConsoleRingEntries().map((e) => ({
    // The ring carries 'info' as a distinct level; this reader's vocabulary has three ('log' /
    // 'warn' / 'error') and 'info' must never leak into /api/console-logs, diagnose, or the MCP
    // contract — fold it into 'log' rather than dropping the entry.
    level: e.level === 'info' ? 'log' : e.level,
    // EPOCH, not the ring's own monotonic `mono` — `since=`/`ts` comparisons below and in `diagnose`
    // are wall-clock windows. `performance.timeOrigin` is the epoch instant `performance.now()`'s
    // zero point measures from; this arithmetic belongs here, in the unscanned app layer, not in
    // the engine's determinism-guarded `runtime/**` (see `consoleRing.ts`'s own doc comment).
    ts: Math.round(performance.timeOrigin + e.mono),
    text: e.args.join(' '),
  }));
}

function dumpConsoleLogs(p: ConsoleLogsParams = {}): { logs: ConsoleEntry[]; total: number } {
  // #596/#597 Stage 3a: `consoleBuffer`/`consoleHooked` are gone — the shared ring is the only
  // capture, everywhere, so there is no longer a "which buffer is live" question to answer. See
  // `ringEntriesAsConsoleEntries`'s own doc comment for why `readConsoleSource()` is still tried
  // first.
  let logs: ConsoleEntry[] = readConsoleSource() ?? ringEntriesAsConsoleEntries();
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
  // A `new Map()` here would keep the LAST rect per id and silently drop the rest — and one
  // entity routinely has several: with the editor's Scene and Game panels both open, every 3D
  // entity is measured by two providers through two cameras (MEASURED: 47x45 at (755,312) in the
  // GameView vs 496x372 at (76,-63) in the SceneView, same id, both onScreen). This payload has
  // one row per entity, so it still reports ONE rect — but it names the surface it came from and
  // lists the others, instead of presenting one of several answers as the answer.
  const boundsById = params.bounds
    ? (() => {
        const m = new Map<number, LayoutEntry & { otherSurfaces?: string[] }>();
        for (const e of computeLayoutBounds({ ids: wanted.map((w) => w.id) }).entities ?? []) {
          const prev = m.get(e.id);
          if (!prev) { m.set(e.id, e); continue; }
          const others = prev.otherSurfaces ?? [];
          // Record the dropped rect UNCONDITIONALLY. Gating on `prev.surface` meant an unlabelled
          // rect vanished leaving `otherSurfaces` empty — and since the field is omitted when
          // empty, the response looked like there had only ever been one. That is exactly the
          // "keep the LAST, silently drop the rest" behaviour the comment above says was fixed; it
          // was true for 3D (always labelled) and false for UI (never labelled) until UI rects
          // gained a surface. An unlabelled host still has to be visible, so it gets a placeholder
          // rather than silence. (independent review, 2026-07-30)
          others.push(prev.surface ?? `unlabelled-${prev.layer}`);
          m.set(e.id, { ...e, otherSurfaces: others });
        }
        return m;
      })()
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
  // An unknown or WRONG-CASE `trait=` was applied silently: every entity came back with
  // `traits:{}` and no warning, which reads as "nothing in this scene has that trait" rather than
  // "there is no such trait". The two call for opposite next moves — add the component, versus fix
  // the spelling — so the answer must distinguish them. `where=` already warns on an unknown
  // trait/field (line above); this is the same rule for the simpler filter. (§6: never silently
  // ignore a parameter.)
  if (params.trait && !metaByName.has(params.trait)) {
    const near = [...metaByName.keys()].filter((t) => t.toLowerCase() === params.trait!.toLowerCase()
      || t.toLowerCase().includes(params.trait!.toLowerCase())).slice(0, 6);
    warnings.push(
      `trait "${params.trait}" is not a REGISTERED trait, so every entity below shows traits:{} — ` +
      `that means the FILTER matched nothing, NOT that the scene lacks the component.` +
      (near.length ? ` Did you mean: ${near.join(', ')}? (names are case-sensitive)` : ' List them with modoki_list_traits.'),
    );
  }

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
    // `guid` on EVERY row, not just the index (S3.9). In targeted/trait-filtered mode the guid
    // used to live only inside `traits.EntityAttributes` — which a `trait=` filter EXCLUDES, so the
    // tool that tells agents "address entities by guid, ids are reassigned on every hot-reload"
    // handed back id-only rows in its most common drill-down (the live smoke suite's own shape).
    // One memoized lookup, already implemented.
    const out: Record<string, unknown> = { id: info.id, guid: guidOf(info.id), name: info.name, parentId: info.parentId, layer: info.layer ?? null, traits };
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
      // WHICH surface this rect belongs to, and which others also measured this entity. Both
      // omitted in the common single-surface case, so the payload only grows when it must.
      if (b?.surface) out.surface = b.surface;
      if (b?.otherSurfaces?.length) out.otherSurfaces = b.otherSurfaces;
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
// from `modoki_diagnose` with no failing test. The shared ring holds 1000 entries in the editor
// (`installConsoleRing.ts`'s `capacity`, #596/#597 Stage 3a — was a private 500-entry buffer);
// a bare read returns the last 50 plus a per-level histogram of the whole window.
registerAgentOp('console-logs', (params) => {
  const p = (params ?? {}) as ConsoleLogsParams;
  // Filter here, tail here: pass no `limit` to the producer so the histogram sees everything.
  const { logs } = dumpConsoleLogs({ level: p.level, since: p.since });
  const r = tailWithCounts(logs, (e) => e.level, { limit: p.limit, defaultLimit: CONSOLE_TAIL_DEFAULT });
  // S3.8 — `byLevel`/`ringTotal` describe the WHOLE ring, `total` describes what MATCHED the
  // filter. The histogram used to be built over the already-filtered array, so `level:'warn'`
  // answered `byLevel:{warn:N}` — an agent using it to decide "are there errors?" concluded no
  // from a filtered read. Same three-number contract as modoki_journal (count/total/ringTotal),
  // because two tools answering the same question must answer it the same way (§8).
  const ring = p.level || p.since ? dumpConsoleLogs({}).logs : logs;
  const byLevel: Record<string, number> = {};
  for (const e of ring) byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
  return {
    logs: r.items,
    count: r.items.length,
    total: r.total,
    ringTotal: ring.length,
    byLevel,
    // The ring is `[pinned boot prefix] ++ [rolling tail]` — once it wraps, that is DISCONTIGUOUS,
    // and `logs`/`ring` above concatenate the two halves with nothing marking the seam. `dropped`
    // is how many tail entries were evicted between them; non-zero means an agent reading `logs`
    // is looking at boot plus a recent window with a real gap in between, not a continuous log. See
    // `getConsoleRingDropped`'s own doc comment (consoleRing.ts).
    dropped: getConsoleRingDropped(),
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
  const filtered = !!(p.type || p.level);
  const all = journalEvents();
  const events = filtered ? journalEvents({ type: p.type, level: p.level }) : all;
  // `clear` used to wipe the ENTIRE 10,000-event ring even when the read was FILTERED — so
  // `journal {type:'match', clear:true}` returned 100 match events and silently destroyed every
  // @contact / score / win event alongside them, including the human's. There is no selective
  // clear (the journal is a flat ring), so the honest move is to refuse rather than to
  // over-delete: destroying data the caller did not ask about, and did not see, is not something
  // to do on a best guess. An UNFILTERED clear is unchanged — that one really does mean "all".
  if (p.clear && filtered) {
    return {
      ok: false,
      error:
        `REFUSED: clear:true with a filter (${[p.type && `type=${p.type}`, p.level && `level=${p.level}`].filter(Boolean).join(', ')}) ` +
        'would clear the WHOLE journal, not just the events returned — the ring has no selective ' +
        'clear. Nothing was cleared and the events were NOT returned.',
      hint: 'Read with the filter and no clear, then clear deliberately with a bare clear:true (which means ALL events); or clear first and re-read from a known-empty ring.',
    };
  }
  if (p.clear) clearJournal();
  // Tail at the op. `journalEvents()` stays whole for JournalTab, which slices its own view.
  // A busy physics Play session fills the 10,000-event ring with ~226-byte `@contact` events
  // — ~582k tokens if returned entire.
  const r = tailWithCounts(events, (e) => String((e as { type?: string }).type ?? '?'), { limit: p.limit, defaultLimit: JOURNAL_TAIL_DEFAULT });
  // `byType`/`ringTotal` describe the WHOLE RING, which is what the tool description and
  // docs/debug-tools-mcp.md both promise. They used to be computed over the FILTERED slice, so
  // `journal {type:'match'}` answered `byType:{match:N}` — indistinguishable from "this ring
  // contains nothing but match events", which is the opposite of a histogram's purpose (§2: one
  // name, one meaning).
  const ring = filtered
    ? tailWithCounts(all, (e) => String((e as { type?: string }).type ?? '?'), { limit: 0, defaultLimit: 0 })
    : r;
  // Surface Tier-2 capture state so a reader knows a diagnostic (@contact) is OFF unless it
  // opened a watch — otherwise an empty @contact result reads as "no contacts" not "not capturing".
  const captures = verboseCaptureState();
  const idle = captures.types.filter((t) => !captures.active.includes(t));
  return {
    count: r.items.length,
    /** Events MATCHING the filter (the whole ring when unfiltered). */
    total: r.total,
    /** Every event in the ring, and the histogram over ALL of them — unchanged by a filter, so
     *  a filtered read still shows what else is in there. */
    ringTotal: ring.total,
    byType: ring.byType,
    ...(filtered ? { filter: { ...(p.type ? { type: p.type } : {}), ...(p.level ? { level: p.level } : {}) } } : {}),
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

// ── Game-registered agent tools (#270) ── the game side of the MCP extension seam.
//
// `game-tools` is the DECLARATION feed: the MCP server polls it and materializes one real MCP
// tool per entry, so a game's tools sit beside the engine's `modoki_*` ones with real schemas
// instead of being squeezed through `dispatch_action`'s single scalar payload. See
// `runtime/debug/agentToolRegistry.ts` for why the declarations are plain JSON (they cross a
// process boundary) and docs/agent-tools.md for the whole chain.
//
// `version` is what makes the surface LIVE: it changes whenever a game registers or unregisters,
// and the server sends `tools/list_changed` when it moves. Without it the server would have to
// re-derive the surface by comparing full declarations on every poll, and a tool whose schema
// changed in place would never be noticed.
//
// Both ops answer normally when the registry is EMPTY (no game tools, or a release build where
// `isDebugMenuEnabled()` is false and `listAgentTools()` returns nothing). Empty is a valid
// answer, not an error — most projects register none.
registerAgentOp('game-tools', () => ({
  version: agentToolsVersion(),
  tools: listAgentTools().map((t: AgentToolDef) => ({
    name: t.name,
    description: t.description,
    params: t.params ?? {},
    mutates: t.mutates,
    requiresPlaying: t.requiresPlaying === true,
  })),
}));
// Invoke one. The handler's return value is passed through UNTOUCHED: a game tool answers its
// own question, and wrapping it in an envelope here would bury that answer one level deeper for
// every caller. A refusal follows the same convention as the rest of the surface (§5) —
// `ok:false` + a `reason` + the options — so the MCP client's isFailureBody surfaces it as a
// failed call rather than a cheerful 200.
registerAgentOp('game-tool-call', async (params) => {
  const p = (params ?? {}) as { name?: string; args?: Record<string, unknown> };
  if (!p.name) return { ok: false, reason: 'missing tool name' };
  const tool = getAgentTool(p.name);
  if (!tool) {
    // Name the alternatives. An unknown name is nearly always a stale tool list (the project was
    // switched, or the game unregistered on a hot-reload), and the recovery is to look at what IS
    // registered — so answer that question in the same call instead of making the agent ask it.
    const known = listAgentTools().map((t: AgentToolDef) => t.name);
    return {
      ok: false,
      reason: known.length
        ? `unknown game tool '${p.name}'`
        : `unknown game tool '${p.name}' — this project registers no agent tools (or the debug menu is disabled, which suppresses them)`,
      known,
    };
  }
  const args = p.args ?? {};
  // Enforce the DECLARATION here, so every caller inherits it — the curl API, device_eval's
  // modoki.call, and the device relays all land on this op, and only the editor MCP rebuilds a
  // zod schema of its own. A declaration honoured by one caller in four is not a contract.
  const invalid = validateAgentToolArgs(tool, args);
  if (invalid) return { ok: false, reason: invalid, params: Object.keys(tool.params ?? {}) };
  try {
    return await tool.handler(args);
  } catch (e) {
    // A throwing handler is the game's bug, but it must not present as a transport failure: a 504
    // reads as "the editor is gone" and sends the agent diagnosing the wrong layer entirely.
    return { ok: false, reason: `game tool '${p.name}' threw: ${e instanceof Error ? e.message : String(e)}` };
  }
});
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
  let models = 0, textures = 0, audio = 0, environments = 0;
  for (const it of p.items ?? []) {
    if (!it?.path) continue;
    // THE list of cache-holding kinds for the server-driven path — the /api/reimport
    // route now forwards every baked type and lets this decide (#304 close-out). A type
    // with no branch here is ignored on purpose: `font` refreshes through the
    // manifest-hash channel, and atlas/video hold no engine-side cache. Keep in step
    // with assetViews/reimport.ts, which is the same decision for the client-side path.
    if (it.type === 'model') { invalidateModel(it.path); models++; }
    else if (it.type === 'texture') { invalidateTexture(it.path); textures++; }
    else if (it.type === 'audio') { invalidateAudio(it.path); audio++; }
    else if (it.type === 'environment') { invalidateEnvironment(it.path); environments++; }
  }
  return { ok: true, models, textures, audio, environments };
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
// #261 — consulted ONLY when an aim is about to be refused, to tell a transient (the dock is
// mid-move) from a real one. Registered here rather than in agentEditorOps.ts because it needs
// nothing from `editor/`: §9's rule is that an op reaching only the DOM belongs where BOTH
// surfaces can get it.
registerAgentOp('layout-settling', () => layoutSettleReport());

// ── Entity-aware input: the same idea one layer in — resolve {guid}/{name}/{id} to the
// entity's LIVE screen rect so a viewport tap never has to be aimed from coordinates read in
// an earlier round-trip. Renderer-side because only the renderer holds the camera, the
// PixiJS bounds, and the DOM. ──
registerAgentOp('resolve-entity-point', (params) => resolveEntityPointReport((params ?? {}) as EntityPointSpec));

// ── Can trusted input actually be DELIVERED to this window right now? ──
// Chromium DROPS every `sendInputEvent` while the window is OCCLUDED (another app fully covers
// it, or it is minimised) — `document.visibilityState === 'hidden'`. Nothing on the main-process
// side can see that, so the host input routes ask here before dispatching: measured 2026-08-18,
// three consecutive `modoki_tap`s at a correctly-resolved point delivered ZERO events (a
// capture-phase `document` listener saw nothing) while every call answered `ok:true,
// occluded:false`. Only the renderer knows — occlusion is a page-visibility fact, not a
// BrowserWindow one.
//
// `hasFocus` is the WEAKER sibling and is reported rather than refused: with the window visible
// but not OS-focused, input DOES arrive, but Chromium fires no focus/blur/focusin/focusout, so
// anything the editor does on a focus event silently does not happen.
registerAgentOp('input-deliverability', () => ({
  visibilityState: document.visibilityState,
  hasFocus: document.hasFocus(),
}));

// ── Phase F: structured render/scene health (causes, not a black screenshot) ──
// Only errors inside this window gate `ok` (F14): a stale load-time / prior-scene error otherwise
// pins ok:false forever. Date.now() is fine here — app/debug is outside the runtime determinism
// guard, and the console ring already stamps entries with Date.now().
//
// FIVE MINUTES, not the original 30s (#152). The window has to be longer than the time it takes a
// human to notice something, connect a device, attach an agent and ask a question — at 30s it was
// shorter than that on every real investigation, so boot errors aged out before anyone could look.
// It is a VERDICT window, not a reporting window: `computeDiagnostics` counts and timestamps
// everything older as `olderErrors` and names the window as `errorWindowMs`, so widening it trades
// "how long a fixed error keeps failing ok" against nothing — the older ones are visible either way.
const DIAGNOSE_ERROR_WINDOW_MS = 300_000;
registerAgentOp('diagnose', (params) => {
  const p = (params ?? {}) as { video?: boolean };
  const base = computeDiagnostics({
    consoleErrors: dumpConsoleLogs({ level: 'error' }).logs,
    now: Date.now(),
    errorWindowMs: DIAGNOSE_ERROR_WINDOW_MS,
  });
  if (!p.video) return base;
  // ── The downloaded-video cache, behind an OPT-IN filter (#288 Phase 6) ──
  //
  // Behind a filter rather than added unconditionally because `diagnose` is a SWEPT read tool and
  // §6 is summary-first: a per-clip index would grow every caller's payload to answer a question
  // almost none of them asked.
  //
  // It needs a surface at all because the accessor alone is not reachable. `modoki_eval` runs in
  // the renderer and could import `pipeline.ts` through `/@fs` — but that yields a SECOND module
  // instance whose slot is null, so it would report "no cache" for a perfectly live one. Before
  // this, QA-VIDEO-0002 patched `window.fetch` to infer a refetch, which measures the network
  // rather than the cache and cannot tell a MISS from a cache that was never wired.
  //
  // `available:false` carries WHY, because the two causes want opposite next moves: the video
  // module compiled out (a playable-ad build) versus no Cache API (video streams, uncached).
  const cache = getActiveVideoCache();
  if (!cache) {
    return {
      ...base,
      video: {
        available: false,
        reason: 'no downloaded-video cache is wired on this surface — either the __MODOKI_MODULE_VIDEO__ module flag is off (video compiled out, e.g. a playable-ad build) or the Cache API is unavailable, in which case `download` clips STREAM instead. This is NOT "the cache is empty".',
      },
    };
  }
  const entries = cache.entries();
  return {
    ...base,
    video: {
      available: true,
      usedBytes: cache.usedBytes(),
      budgetBytes: cache.budgetBytes(),
      count: entries.length,
      entries,
    },
  };
});

// ── profiler (profiler plan P4/P6) ────────────────────────────────────────────────────────
// The capture was HUMAN-ONLY until this: the Profiler panel has a Record button and an agent
// had no way to start one at all. On a device that is exactly backwards — the agent is the
// consumer that can be on a phone without anyone holding it, which is the whole reason the
// marker tree was built as data first. Verified missing by listing the device's op registry.
//
// Summary-first, like every other read here: `capture-read` returns the WORST frames by total
// frame time, not every frame. A 300-frame capture with a full marker tree each is far past any
// response budget, and "which frames were slow, and what did they spend it on" is the question —
// the whole capture is still exportable as JSON for the cases that genuinely need it.
registerAgentOp('profiler', (raw: unknown) => {
  const params = (raw ?? {}) as Record<string, unknown>;
  const action = String(params.action ?? 'read');
  switch (action) {
    case 'capture-start':
      startCapture();
      return { capturing: true };
    case 'capture-stop':
      stopCapture();
      return { capturing: false, frames: getCapture().frames.length };
    case 'capture-clear':
      clearCapture();
      return { cleared: true };
    case 'capture-read': {
      const cap = getCapture();
      const limit = Math.max(1, Math.min(20, Number(params.limit ?? 5)));
      // Sorted by cost, so the interesting frames come first regardless of when they happened.
      const worst = [...cap.frames].sort((a, b) => b.frameMs - a.frameMs).slice(0, limit);
      return {
        capturing: cap.capturing,
        frameCount: cap.frames.length,
        stoppedByCap: cap.stoppedByCap,
        worst: worst.map((f) => ({
          index: f.index, atMs: +f.atMs.toFixed(1), frameMs: +f.frameMs.toFixed(1),
          cpuMs: +f.cpuMs.toFixed(1),
          // Only the costly branches — a full tree per frame is what blows the budget.
          top: flattenTree(f.tree).sort((a, b) => b.selfMs - a.selfMs).slice(0, 6),
        })),
      };
    }
    // P7 — GPU timestamp queries. Separate actions rather than a flag on `read` because enabling
    // has a real cost and must be a deliberate act: three allocates a query set and writes two
    // timestamps per render pass, and the plan's overhead rule says the profiler must not change
    // the thing it measures. The returned status is the honest answer for THIS device — on a
    // WebGL2 backend without EXT_disjoint_timer_query_webgl2 (most low-end Android) it comes back
    // 'unsupported' with a reason, and no number is ever fabricated to fill the gap.
    case 'gpu-on': {
      const status = setGpuTimingEnabled(true);
      return { gpuTiming: status, ...(status === 'pending' ? { note: 'Samples resolve asynchronously — read again in a few frames.' } : {}) };
    }
    case 'gpu-off':
      return { gpuTiming: setGpuTimingEnabled(false) };
    // #238 — the boot-phase read. The frame profiler can say a cold boot froze for 1,814 ms; it
    // cannot say what was open across it, and three attributions guessed from frame markers were
    // all wrong. This intersects the recorded stall window with the boot timeline, so the answer
    // is a measurement rather than a hypothesis. Summary-first like every read here: the stall
    // overlap and the costliest spans, with the full timeline behind `all:true`.
    case 'boot': {
      const tl = getBootTimeline();
      const stall = getWorstStallWindow();
      const origin = getBootOrigin();
      const round = (v: number) => +v.toFixed(1);
      const row = (sp: { name: string; startMs: number; endMs: number; detail?: string }) => ({
        name: sp.name, ...(sp.detail !== undefined ? { detail: sp.detail } : {}),
        startMs: round(sp.startMs),
        // An open span reports `durMs: -1` rather than a plausible number. A span that never
        // closed is the most interesting row on the page (it may BE the stall) and must not be
        // disguised as a finished one.
        durMs: sp.endMs < 0 ? -1 : round(sp.endMs - sp.startMs),
      });
      // Relative to the boot origin, so every number in this response is on one axis.
      const stallRel = stall ? { startMs: round(stall.startMs - origin), endMs: round(stall.endMs - origin) } : null;
      const closed = tl.spans.filter((sp) => sp.endMs >= 0);
      const limit = Math.max(1, Math.min(200, Number(params.limit ?? 15)));
      const out: Record<string, unknown> = {
        spanCount: tl.spans.length,
        dropped: tl.dropped,
        // Announced rather than implied: a full timeline is TRUNCATED AT THE TAIL, so a missing
        // phase may simply be past the cap.
        recordingStopped: tl.full,
        worstStallMs: round(getFrameProfile().worstStallMs),
        stall: stallRel,
        duringStall: stallRel
          ? bootSpansOverlapping(stallRel.startMs, stallRel.endMs).slice(0, limit)
              .map((sp) => ({ ...row(sp), overlapMs: round(sp.overlapMs) }))
          : [],
        top: [...closed].sort((a2, b2) => (b2.endMs - b2.startMs) - (a2.endMs - a2.startMs)).slice(0, limit).map(row),
        open: tl.spans.filter((sp) => sp.endMs < 0).slice(0, limit).map(row),
      };
      if (!stallRel) out.note = 'No frame has been dropped yet — nothing to attribute. Cold-boot the app and read again.';
      if (params.all) out.timeline = tl.spans.map(row);
      return out;
    }
    case 'boot-reset':
      resetBootTimeline();
      return { reset: true };
    case 'reset':
      resetProfilerMarkers();
      resetMarkerAggregate();
      resetFrameProfile();
      resetGpuTimings();
      clearCapture();
      // NOT the boot timeline: `reset` is for starting a clean measurement of the LIVE window,
      // and boot is over by then. Wiping it here would mean the one read that answers #238 is
      // destroyed by the routine call an agent makes before measuring anything. `boot-reset`
      // exists for the deliberate case (re-arming across a scene swap).
      return { reset: true };
    case 'read':
    default:
      return readPerfProfile({ markers: Number(params.markers ?? 12) });
  }
});

/** Flatten a captured tree to `{path, selfMs, calls}` rows so one frame can be ranked the same
 *  way the live aggregate is — the question ("what owned this frame?") is identical. */
function flattenTree(node: MarkerSample, parent = ''): Array<{ path: string; selfMs: number; calls: number }> {
  const path = parent ? `${parent}/${node.name}` : node.name;
  const rows = [{ path, selfMs: +node.selfMs.toFixed(2), calls: node.calls }];
  for (const c of node.children) rows.push(...flattenTree(c, path));
  return rows;
}

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

// ── Input WATCH (#134): what the POINTER actually did, and what it resolved to — the
// evidence a failed gesture otherwise leaves NOTHING behind (no journal event, no commit, no
// coordinates). Response shaping (limit/unresolvedOnly/precision) lives HERE, in the op, same
// split as watch-read: `readInputPresses()` (the producer, `runtime/input/pointerRecorder.ts`)
// stays a pure ring-buffer read with no agent-surface concerns. ──
registerAgentOp('input-watch-start', (params) => startInputWatch((params ?? {}) as { max?: number }));

const DEFAULT_INPUT_WATCH_LIMIT = 20;
function isUnresolvedPress(p: InputPressRecord): boolean {
  return p.resolved.by === 'none' || p.resolved.by === 'unknown';
}
/** Shared by `read` and `stop` (stop reports what was captured, same shape as a read). */
function shapeInputWatchRead(params: unknown): unknown {
  const p = (params ?? {}) as { limit?: number; unresolvedOnly?: boolean; precision?: number };
  const out = readInputPresses();
  const sig = resolvePrecision(p.precision);
  const matched = p.unresolvedOnly ? out.presses.filter(isUnresolvedPress) : out.presses;
  const limit = typeof p.limit === 'number' && Number.isFinite(p.limit) && p.limit > 0
    ? Math.floor(p.limit) : DEFAULT_INPUT_WATCH_LIMIT;
  // The ring is oldest-first; the MOST RECENT N is the tail.
  const presses = matched.slice(Math.max(0, matched.length - limit));
  const result: Record<string, unknown> = {
    open: out.open,
    max: out.max,
    // Recomputed against what THIS call actually returns (post-filter, post-limit) — `totalCount`
    // stays the producer's true all-time count, per §2 ("both present whenever a filter applied").
    returnedCount: presses.length,
    totalCount: out.totalCount,
    dropped: out.dropped,
    presses,
  };
  // "Could not look" must never read as "nothing is there" (§5): an empty list from a window that
  // has never been opened is not evidence the gesture produced no presses — nobody was watching.
  if (!out.open && out.totalCount === 0) {
    result.hint = "No presses recorded — this input watch has never been opened (or was cleared). "
      + "Call action:'start' BEFORE the gesture you want to capture, then read again.";
  } else if (presses.length < matched.length) {
    result.hint = `${matched.length} press(es) matched; showing the most recent ${presses.length}. Raise limit= to see more.`;
  }
  return roundFloats(result, sig);
}
registerAgentOp('input-watch-read', (params) => shapeInputWatchRead(params));
/** `stop` is a CONTROL action, so it answers with control state and not with a truncated read.
 *  It used to return `shapeInputWatchRead({})` — which took the DEFAULT limit of 20 and, past
 *  that, emitted "Raise limit= to see more" on the one action whose param allowlist REFUSES
 *  `limit`. That is the dead-end hint §6 forbids by name: it reads as the agent's mistake and
 *  there is no call that satisfies it. The documented flow (stop, then read, without racing your
 *  own probe) is unaffected — and now it is the only flow, rather than one of two shapes. */
registerAgentOp('input-watch-stop', () => {
  const before = readInputPresses();
  stopInputWatch();
  return {
    ok: true,
    open: false,
    retained: before.returnedCount,
    totalCount: before.totalCount,
    hint: `Window closed; ${before.returnedCount} press(es) kept. Read them with action:'read'.`,
  };
});
registerAgentOp('input-watch-clear', () => ({ ok: true, cleared: clearInputPresses() }));

// ── Hit REGIONS (#139): the shapes a game's hitTest uses, which are authored NOWHERE — computed
// inside the hit-test from config, so no inspector, scene view or screenshot can show them. The
// companion to the input watch above: that one measures a miss, this one says what it missed and
// by how much. `show`/`hide` drive the on-screen overlay (which also plots the last few recorded
// presses); `read` returns the geometry as data, which is what an agent actually reasons over. ──
const DEFAULT_HIT_REGION_LIMIT = 60;
registerAgentOp('hit-regions', (raw: unknown) => {
  const p = (raw ?? {}) as {
    action?: string; provider?: string; kind?: string; ids?: string[];
    limit?: number; precision?: number; at?: { x: number; y: number };
  };
  const action = String(p.action ?? 'read');
  if (action === 'show' || action === 'hide') {
    setHitRegionOverlayVisible(action === 'show');
    return { ok: true, visible: action === 'show', providers: hitRegionProviders() };
  }
  const providers = hitRegionProviders();
  const all = collectHitRegions({ provider: p.provider, kind: p.kind, ids: p.ids });
  const limit = typeof p.limit === 'number' && Number.isFinite(p.limit) && p.limit > 0
    ? Math.floor(p.limit) : DEFAULT_HIT_REGION_LIMIT;
  const regions = all.slice(0, limit);
  const result: Record<string, unknown> = {
    visible: isHitRegionOverlayVisible(),
    providers,
    returnedCount: regions.length,
    totalCount: all.length,
    regions,
  };
  // The question a miss investigation actually asks, answered here rather than by making the
  // caller re-implement point-in-shape against the returned geometry — which is where a second,
  // subtly different containment test would creep in and disagree with the overlay.
  if (p.at && Number.isFinite(p.at.x) && Number.isFinite(p.at.y)) {
    const hits = regionsAt(all, p.at!.x, p.at!.y);
    result.at = p.at;
    result.hitsAt = hits.map((r) => ({ id: r.id, kind: r.kind, label: r.label }));
    if (hits.length === 0) {
      // A MISS is the interesting answer, so it comes with the nearest edge — the number the
      // Court investigation had to derive by hand (27.6 px against a 22.76 px radius).
      const near = nearestRegionTo(all, p.at.x, p.at.y);
      result.nearest = near
        ? { id: near.region.id, kind: near.region.kind, label: near.region.label, distancePx: +near.distance.toFixed(2) }
        : null;
    }
  }
  // "Could not look" must never read as "nothing is there" (§5): no provider is a different fact
  // from no regions, and they produce identical empty lists.
  if (providers.length === 0) {
    result.hint = 'No hit-region provider is registered, so this is NOT evidence that the surface '
      + 'has no hit regions — nobody was able to answer. A game publishes them by calling '
      + 'registerHitRegionProvider() from the code that owns its hitTest geometry.';
  } else if (all.length === 0) {
    result.hint = `Provider(s) [${providers.join(', ')}] registered but reported no regions — the `
      + 'surface is not hit-testable right now (no level loaded, or a modal is swallowing input).';
  } else if (regions.length < all.length) {
    result.hint = `${all.length} region(s) matched; showing the first ${regions.length}. Raise limit=, or filter by kind=/provider=.`;
  }
  return roundFloats(result, resolvePrecision(p.precision));
});


// ── Scene queries (#288 gap 1) — raycast / shapecast / point-pick against the PHYSICS world.
//
// All six exported query functions were unreachable from any tool, and `modoki_eval` could not
// substitute: `makeEvalApi()` builds its object from `listAgentOps()`, so eval adds composition
// and zero capability (§9), and there was no /api route for its `api()` escape hatch to reach
// either. QA-PHYS-0004 substituted the `contacts:true` enricher on get_scene_state.
//
// SIX, not the four #288 lists: `shapeCast2D` and `pointQuery2D` are exported and barrel-exposed
// too, and shipping 3D-has-three / 2D-has-one would be an arbitrary asymmetry.
//
// ONE tool is §7-legal here: no argument changes the method, the route, or whether anything is
// written — every kind is a pure read. This is the `play_control` shape, where the op varies and
// the job does not.
//
// ⚠️ THE REFUSAL TAXONOMY IS THE SUBSTANCE OF THIS OP. Every underlying function collapses three
// distinguishable outcomes onto the same `null` — no physics world, a zero-length direction, and
// a genuine miss. In game code that is harmless (the next line is `if (hit)`); through a tool it
// is §0's rank-2 failure, "could not look" reported authoritatively as "nothing is there". So the
// causes it CAN rule out are ruled out BEFORE the call, and only what is left is reported as a
// miss.
type QueryKind = 'raycast' | 'shapecast' | 'point';

/** Resolve a raw runtime entity id to the address an agent is allowed to hold onto.
 *
 *  The query functions return a bare `entityId`, and §3 forbids handing that back as an
 *  address — runtime ids are reassigned on every scene reload, and a mutate triggers one. The
 *  guid is the only address that always works, so it rides along with every hit. `-1` is the
 *  functions' own "hit a collider with no ECS owner" sentinel and is passed through as such
 *  rather than being dressed up as an entity. */
function queryHitRef(entityId: number): { entityId: number; guid: string | null; name: string | null } {
  if (entityId < 0) return { entityId, guid: null, name: null };
  const e = findEntityById(entityId);
  const ea = e && e.has(EntityAttributes) ? e.get(EntityAttributes) : undefined;
  return { entityId, guid: (ea?.guid as string) || null, name: (ea?.name as string) ?? null };
}

/** Resolve the `exclude` argument — a name or guid, never a raw id — to a runtime id.
 *  An ambiguous NAME is REFUSED rather than first-matched (§3, on every path). */
function resolveExclude(spec: string): { id: number } | { error: string; options?: string[] } {
  const byGuid = findEntityByGuid(spec);
  if (byGuid) return { id: byGuid.id() };
  const matches = getAllEntities().filter((e) => e.name === spec);
  if (matches.length === 0) return { error: `exclude: no entity named or guid'd '${spec}' in the live world` };
  if (matches.length > 1) {
    return {
      error: `exclude: '${spec}' matches ${matches.length} entities — an ambiguous name is refused everywhere, never first-matched`,
      options: matches.map((m) => m.guid || `id:${m.id}`),
    };
  }
  return { id: matches[0].id };
}

registerAgentOp('scene-query', (params) => {
  const p = (params ?? {}) as {
    kind?: QueryKind; dim?: '2d' | '3d';
    origin?: number[]; direction?: number[]; point?: number[];
    radius?: number; maxDistance?: number; solid?: boolean; exclude?: string;
    precision?: number;
  };
  const KINDS: QueryKind[] = ['raycast', 'shapecast', 'point'];
  if (!p.kind || !KINDS.includes(p.kind)) {
    return { ok: false, code: 'REFUSED_BY_OP', error: `scene-query requires kind (one of ${KINDS.join(', ')}); got ${JSON.stringify(p.kind)}`, options: KINDS };
  }
  if (p.dim !== '2d' && p.dim !== '3d') {
    return { ok: false, code: 'REFUSED_BY_OP', error: `scene-query requires dim '2d' or '3d'; got ${JSON.stringify(p.dim)}`, options: ['2d', '3d'] };
  }
  const world = getCurrentWorld();
  const is2d = p.dim === '2d';
  const n = is2d ? 2 : 3;

  // 1. "There is no physics world" — NOT a miss. A world exists only once the physics system has
  //    run, i.e. while the sim is PLAYING, so a stopped editor legitimately has none. Answering
  //    `hit:null` here would tell the agent the ray passed through empty space.
  if (!(is2d ? hasPhysics2D(world) : hasPhysics3D(world))) {
    return {
      ok: false, code: 'NOT_AVAILABLE_HERE', kind: p.kind, dim: p.dim,
      error: `no ${p.dim.toUpperCase()} physics world exists on this surface, so nothing could be queried — this is NOT "the query missed".`,
      hint: 'A Rapier world is built by the physics system on its first tick and freed on Stop, so '
        + 'a STOPPED editor has none. Start the sim (modoki_play_control action:"play"), or check '
        + `the scene actually has ${p.dim.toUpperCase()} colliders.`,
    };
  }

  const vec = (v: unknown, what: string): number[] | string => {
    if (!Array.isArray(v) || v.length !== n || v.some((c) => typeof c !== 'number' || !Number.isFinite(c))) {
      return `${what} must be an array of ${n} finite numbers for dim:'${p.dim}' (got ${JSON.stringify(v)})`;
    }
    return v as number[];
  };

  // ── point: the pick/hit-test query. Its result shape is deliberately DIFFERENT ──
  if (p.kind === 'point') {
    const pt = vec(p.point, 'point');
    if (typeof pt === 'string') return { ok: false, code: 'REFUSED_BY_OP', error: pt };
    const id = is2d ? pointQuery2D(world, pt[0], pt[1]) : pointQuery3D(world, pt[0], pt[1], pt[2]);
    // §2 — same field name, same meaning, or ABSENT. pointQuery returns containment, which has no
    // impact point, no surface normal and no distance; padding those with zeros would make a
    // `distance:0` here mean something different from a `distance:0` on a raycast, which is
    // exactly the drift that rule exists to stop.
    return { ok: true, kind: 'point', dim: p.dim, point: pt, hit: id == null ? null : queryHitRef(id) };
  }

  const origin = vec(p.origin, 'origin');
  if (typeof origin === 'string') return { ok: false, code: 'REFUSED_BY_OP', error: origin };
  const dir = vec(p.direction, 'direction');
  if (typeof dir === 'string') return { ok: false, code: 'REFUSED_BY_OP', error: dir };

  // 2. "The direction was degenerate" — also NOT a miss. A zero-length direction describes no ray
  //    at all, and the query functions return the same `null` a clean miss returns. An agent that
  //    normalized a delta between two coincident points lands here, and "nothing was hit" would
  //    send it looking for a missing collider instead of at its own arithmetic.
  if (dir.every((c) => c === 0)) {
    return {
      ok: false, code: 'REFUSED_BY_OP', kind: p.kind, dim: p.dim,
      error: 'direction has zero length, which describes no ray — nothing was cast. This is NOT a miss.',
      hint: 'A direction need not be normalized, but it must be non-zero. A zero vector usually '
        + 'means the two points it was derived from are the same.',
    };
  }

  let excludeId: number | undefined;
  if (p.exclude !== undefined) {
    if (p.kind === 'shapecast') {
      // Say so rather than accepting and ignoring it: a silently dropped filter is a query that
      // answers a different question than the one asked, and the caster's own body is the single
      // most likely hit.
      return { ok: false, code: 'REFUSED_BY_OP', error: "exclude is not supported for kind:'shapecast' — the underlying castShape takes no exclusion filter. Use kind:'raycast', or offset the origin past your own collider." };
    }
    const r = resolveExclude(p.exclude);
    if ('error' in r) return { ok: false, code: 'AMBIGUOUS', error: r.error, options: r.options };
    excludeId = r.id;
  }

  const opts = {
    ...(p.maxDistance !== undefined ? { maxDistance: p.maxDistance } : {}),
    ...(p.solid !== undefined ? { solid: p.solid } : {}),
    ...(excludeId !== undefined ? { exclude: excludeId } : {}),
  };

  let raw: { entityId: number; x: number; y: number; z?: number; nx: number; ny: number; nz?: number; distance: number } | null;
  if (p.kind === 'raycast') {
    raw = is2d
      ? raycast2D(world, origin[0], origin[1], dir[0], dir[1], opts)
      : raycast3D(world, origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], opts);
  } else {
    if (typeof p.radius !== 'number' || !Number.isFinite(p.radius) || p.radius <= 0) {
      return { ok: false, code: 'REFUSED_BY_OP', error: `kind:'shapecast' requires a positive finite radius; got ${JSON.stringify(p.radius)}` };
    }
    const { exclude: _drop, solid: _drop2, ...castOpts } = opts as Record<string, unknown>;
    raw = is2d
      ? shapeCast2D(world, origin[0], origin[1], dir[0], dir[1], p.radius, castOpts)
      : shapeCast3D(world, origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], p.radius, castOpts);
  }

  // 3. Everything that could have produced a false `null` is ruled out, so THIS null is a real
  //    miss and can be reported as one.
  const base = { ok: true as const, kind: p.kind, dim: p.dim, origin, direction: dir };
  if (!raw) return { ...base, hit: null };
  const point = is2d ? [raw.x, raw.y] : [raw.x, raw.y, raw.z as number];
  const normal = is2d ? [raw.nx, raw.ny] : [raw.nx, raw.ny, raw.nz as number];
  return roundFloats({
    ...base,
    hit: {
      ...queryHitRef(raw.entityId),
      // shapecast's `point` is the swept sphere's CENTRE at impact, not the surface contact —
      // named in the tool description, because reading it as a contact point puts it one radius
      // inside the geometry.
      point, normal, distance: raw.distance,
    },
  }, resolvePrecision(p.precision));
});

// ── PlayerPrefs (#288 gap 4) — the engine's durable per-key store, previously reachable only
// through `modoki_eval` + a dynamic import. Registered HERE (runtime) and not in agentEditorOps,
// per docs/mcp-tool-conventions.md §9: nothing about it touches editor chrome, the undo stack, or
// the project on disk, so the DEVICE surface gets the same ops for free — which is the surface
// where prefs matter most, since that is where a real player's save data lives.
//
// SPLIT IN TWO, per §7 ("if one argument value changes whether it writes to disk, it is more than
// one tool"). The split's premise is not a guess: `get`/`keys`/`has`/`hasPendingWrite` are pure
// cache reads with no lazy hydration and no scheduleFlush (playerPrefs.ts), while
// `set`/`delete`/`clear` all dirty a key and schedule a durable write.

/** Refuse rather than answer when the cache was never hydrated.
 *
 *  `cache` is populated ONLY by `PlayerPrefs.init()`, so before a game boots `keys()` returns `[]`
 *  for a store that may have plenty on disk. Answering `[]` there is §5's worst shape — "could not
 *  look" reported as "nothing is there" — and it is not recoverable, because an empty list is
 *  exactly what a genuinely empty store returns.
 *
 *  It gates WRITES too, and that half is the sharper one: `set()` on an un-hydrated store writes
 *  into a throwaway in-memory cache under the `'default'` namespace, and the next `init()` CLEARS
 *  it. Every signal the caller has says the write succeeded; nothing of it survives. */
function prefsUnhydrated(): { ok: false; code: string; error: string; hint: string } | null {
  if (PlayerPrefs.isHydrated()) return null;
  return {
    ok: false,
    code: 'NOT_AVAILABLE_HERE',
    error: 'PlayerPrefs has not been hydrated on this surface — PlayerPrefs.init() has not run yet.',
    hint: 'This is NOT "the store is empty": nothing has read the backend, so nothing can be said '
      + 'about what it holds. The editor hydrates during boot once a game is chosen, and a game '
      + 'build hydrates in its shell — so open a project / launch the game and retry.',
  };
}

registerAgentOp('player-prefs-read', (params) => {
  const p = (params ?? {}) as { key?: string };
  const refusal = prefsUnhydrated();
  if (refusal) return refusal;
  // ALWAYS reported, on both shapes: the same game has separate stores depending on where it runs
  // (the editor hydrates `<gameId>@editor` on purpose so playtest saves cannot reach a shipped
  // build's), so a key list that does not say which store it came from is unanswerable.
  const namespace = PlayerPrefs.namespace();
  const keys = [...PlayerPrefs.keys()].sort();
  if (p.key === undefined) {
    // Summary-first (§6): the INDEX by default, a value only when a key is named.
    return {
      ok: true, namespace, totalCount: keys.length, keys,
      // The authoritative pending set AT A STABLE POINT, NOT `keys.filter(hasPendingWrite)` — a
      // key can be pending and simultaneously ABSENT from `keys` (a DELETE the backend rejected:
      // `PlayerPrefs.delete` removes it from the cache immediately, so `keys` never has it). So
      // this list can legitimately contain a key this same response's `keys` array does not —
      // that's the point, not a bug. ⚠️ It no longer under-reports mid-drain (#559): this op does
      // not flush, but `pendingKeys()` now reports writes a drain has taken and not yet settled, so
      // an in-flight write appears here rather than reading as landed. This op is the ONE caller
      // whose behaviour that changed — every other reader samples after an awaited flush — and the
      // change is strictly toward truth. The old comment told an agent debugging a money path to
      // distrust exactly the list it can now rely on.
      pendingWrites: PlayerPrefs.pendingKeys().sort(),
    };
  }
  // A key that is genuinely absent is an ANSWER, not a refusal — we looked, and it is not there.
  // `present` carries that explicitly rather than leaving it to be inferred from a missing
  // `value`, which is indistinguishable from a key holding JSON `null`.
  if (!PlayerPrefs.has(p.key)) {
    return {
      ok: true, namespace, key: p.key, present: false, totalCount: keys.length, keys,
      // A key absent from the cache can still be DIRTY. That does NOT prove a rejection — an
      // ordinary debounced delete (still inside its 150ms window, never yet sent to the backend)
      // has the identical signature. What it proves is that the durable remove has not been
      // ACCEPTED yet, so the key may still be on disk. `present: false` alone would report it as
      // durably gone (#422's own failure shape, on the branch an agent uses to verify a single key).
      pendingWrite: PlayerPrefs.hasPendingWrite(p.key),
    };
  }
  return {
    ok: true, namespace, key: p.key, present: true,
    value: PlayerPrefs.get(p.key),
    // The one signal that separates "the backend rejected this write" from "the backend took it"
    // — see hasPendingWrite's header. `get()` alone cannot fail, because it re-reads the
    // optimistic cache.
    pendingWrite: PlayerPrefs.hasPendingWrite(p.key),
  };
});

registerAgentOp('player-prefs-write', async (params) => {
  const p = (params ?? {}) as { action?: string; key?: string; value?: unknown; confirm?: boolean };
  const ACTIONS = ['set', 'delete', 'clear', 'flush'];
  if (!p.action || !ACTIONS.includes(p.action)) {
    return { ok: false, code: 'REFUSED_BY_OP', error: `player-prefs-write requires action (one of ${ACTIONS.join(', ')}); got ${JSON.stringify(p.action)}`, options: ACTIONS };
  }
  const refusal = prefsUnhydrated();
  if (refusal) return refusal;
  // Distinct from `prefsUnhydrated()` above: `isHydrated()` stays `true` for the whole swap
  // window (it's truthfully describing the OUTGOING store — see `doInit`'s doc comment in
  // playerPrefs.ts). ALL FOUR actions are refused here, `flush` included (#438 round 5 — a round
  // 4 `flush` exemption reasoned that draining the outgoing store is "harmless", but a `flush`
  // that is still draining when the install runs settles AFTER the swap: `PlayerPrefs.pendingKeys()`
  // read below would then answer against the INCOMING (already-empty) namespace, so a write that
  // never landed anywhere reports `{ok:true, flushed:true, pendingWrites:[]}` — a false success by
  // construction, not a harmless drain. A `set`/`delete`/`clear` has the same problem one layer up:
  // even where the write itself durably lands in the OUTGOING backend, this op cannot truthfully
  // report so once the swap has moved the namespace out from under it. Reads are left alone (see
  // `player-prefs-read` above) because a read during the window answers truthfully about the
  // outgoing store — there is nothing for it to settle across.
  if (PlayerPrefs.isSwapInFlight()) {
    return {
      ok: false,
      code: 'NOT_AVAILABLE_HERE',
      error: 'A game/namespace swap is in progress (PlayerPrefs.init() is mid-flight) — a ' +
        `${p.action} right now could settle AFTER the swap installs the incoming namespace, so ` +
        'this op cannot truthfully report where (or whether) it landed.',
      hint: 'Retry once the swap finishes (isSwapInFlight() returns false).',
    };
  }
  // Captured HERE, before this op's own internal `await`s (flush/clear below) — not re-read at
  // reply time. If a swap starts DURING one of those awaits (a separate, later `init()` call),
  // the write already in flight resolves against whatever `drain()` captured as its OWN
  // `batchNamespace`/`batchBackend` locals at the moment it started — i.e. THIS namespace, not
  // whatever `PlayerPrefs.namespace()` would report afterward. Re-reading it after the await
  // would name the wrong (incoming) namespace for a write that actually landed in this one.
  const namespace = PlayerPrefs.namespace();
  // Captured alongside `namespace`, same reasoning — see `swapGeneration()`'s doc comment in
  // playerPrefs.ts. `isSwapInFlight()` above is a SAMPLE taken at entry; a swap that starts (and
  // possibly finishes) during one of this op's own `await PlayerPrefs.flush()` calls below is
  // invisible to a re-sampled `isSwapInFlight()` if it also closes before this op resumes, so the
  // generation counter is what actually catches it (#454 C).
  const swapGen = PlayerPrefs.swapGeneration();
  // Called after every internal `await PlayerPrefs.flush()` below, right before the
  // `pendingKeys()`/`hasPendingWrite()` readback that follows it — a swap that lands mid-await
  // means that readback would answer against the INCOMING namespace, not the one this op is
  // reporting about. `isSwapInFlight()` is checked too (not just the generation) so a swap that
  // is STILL open when this op resumes is caught by the cheaper, more direct signal; the
  // generation check is what catches the swap that already opened AND closed inside the await.
  // The issue (#454) names only the `flush` action, but `clear`/`delete`/`set` have the exact
  // same shape of bug at their own flush sites — a single shared helper called at every one of
  // them is less error-prone than reimplementing this check per call site.
  //
  // This check is deliberately CONSERVATIVE — it fires whenever a swap started during the
  // await, including cases where the readback would in fact still have been truthful (the swap
  // may be parked behind this op's own `writeChain` and not yet installed). Over-reporting
  // "unknown" is the safe direction; claiming a durability we could not observe is not.
  //
  // Unlike the entry-time `isSwapInFlight()` refusal above, this fires AFTER the mutation has
  // already happened — the cache write landed, and the durable write was at least attempted
  // against `namespace`. So it does NOT return `NOT_AVAILABLE_HERE` (which at entry truthfully
  // means "nothing was done"; here it would mean "everything was done, I just won't tell you" —
  // worse than the false success it replaced, since a caller retrying a `delete` whose durable
  // remove already landed would then get `NOT_FOUND: nothing was deleted` and conclude its
  // delete never happened). Instead it reports `PARTIAL` with `durability:'unknown'` — the
  // shape `contracts.ts` already defines for "the cache change happened, the durable outcome
  // could not be confirmed" — merging in whichever facts THIS action already knows are true.
  const swapUnverifiableAfterFlush = (known: Record<string, unknown>) =>
    (PlayerPrefs.swapGeneration() !== swapGen || PlayerPrefs.isSwapInFlight())
      ? {
          ok: false as const,
          code: 'PARTIAL' as const,
          namespace,
          ...known,
          durability: 'unknown' as const,
          error: `a game/namespace swap STARTED while this op was awaiting its own flush (it may or may not have completed) — the write was applied to the live cache and its durable write was attempted against "${namespace}", but the pending-write readback that decides this reply can no longer be trusted to answer for "${namespace}", so whether the backend ACCEPTED it is unknown`,
          hint: `Treat this as durability-unknown, NOT as a failure — do not simply retry, since the same op against the incoming namespace would report on a different store. Once the swap has settled, "${namespace}" is only inspectable by re-opening the game that owns it.`,
        }
      : null;

  if (p.action === 'flush') {
    await PlayerPrefs.flush();
    const swapUnverifiable = swapUnverifiableAfterFlush({ flushed: true });
    if (swapUnverifiable) return swapUnverifiable;
    // A flush that RESOLVES is not a flush that landed: `drain()` catches a rejected backend write,
    // re-queues the key into `dirty`, and settles fulfilled so later writes are not poisoned —
    // while `cache` keeps the value, so `get()` still returns it. Re-reading the pending set is the
    // only way to see it, so reporting a clean `ok:true` here would be a false success by
    // construction. Must be `PlayerPrefs.pendingKeys()`, not `keys().filter(hasPendingWrite)` — a
    // rejected DELETE leaves the key dirty but removes it from `cache` (and so from `keys()`) in the
    // same call, so the cache-derived filter structurally cannot see it.
    const stillPending = PlayerPrefs.pendingKeys().sort();
    if (stillPending.length > 0) {
      return {
        ok: false, code: 'PARTIAL', namespace, pendingWrites: stillPending,
        error: `the flush resolved but ${stillPending.length} key(s) were REJECTED by the backend and re-queued: ${stillPending.join(', ')}`,
        hint: 'A rejected write (quota exceeded, a native I/O error) keeps its value in the cache, '
          + 'so a read-back through player_prefs still shows it. The value is NOT durable.',
      };
    }
    return { ok: true, namespace, flushed: true, pendingWrites: [] };
  }

  if (p.action === 'clear') {
    // §8's force pattern. The device surface makes this non-negotiable: there the target is a real
    // installed app holding a real player's save data, namespaced by appId, and this is neither
    // undoable nor journaled as a scene edit. A REQUIRED `action` stops the `{}`-typo hazard; only
    // an explicit acknowledgement stops a deliberate clear aimed at the wrong lease.
    const keys = PlayerPrefs.keys();
    if (p.confirm !== true) {
      return {
        // REFUSED_BY_OP, not REQUIRES_SAVE. §5 documents REQUIRES_SAVE for a world-swapping or
        // file-reading op refusing because unsaved LIVE WORK would be lost (load_scene, new_scene,
        // build). A prefs clear is neither, and nothing about the scene is at stake — sending a
        // reader to go save their scene is a wrong answer stated authoritatively. This is an
        // ordinary deliberate refusal awaiting an acknowledgement.
        ok: false, code: 'REFUSED_BY_OP', namespace, totalCount: keys.length, keys,
        error: `clear would remove all ${keys.length} key(s) in namespace '${namespace}' and is NOT undoable — pass confirm:true to proceed.`,
        options: ['confirm:true to clear the whole namespace', "action:'delete' with a key to remove exactly one"],
      };
    }
    PlayerPrefs.clear();
    await PlayerPrefs.flush();
    const clearSwapUnverifiable = swapUnverifiableAfterFlush({ cleared: keys.length, keys });
    if (clearSwapUnverifiable) return clearSwapUnverifiable;
    // Same rejection possibility as `flush`/`set`/`delete` — a clear queues every key as a delete,
    // and any of those backend.remove() calls can be rejected (quota, native I/O) and re-queued.
    const stillPending = PlayerPrefs.pendingKeys().sort();
    // `stillPending` is the whole dirty set, which can include a key that was ALREADY pending before
    // this clear ran (an earlier rejected delete) — that key is not one this clear enumerated, and
    // attributing it here produced "REJECTED for 2 of them" against `cleared: 1`.
    const failed = stillPending.filter((k) => keys.includes(k));
    const alsoPending = stillPending.filter((k) => !keys.includes(k));
    if (stillPending.length > 0) {
      // `alsoPending`'s state pre-dates this clear, but this clear's own `await flush()` above
      // retried every dirty key (including these) — so if one is still pending here, THIS call's
      // retry was rejected again, not merely "not caused by it".
      const alsoPendingClause = alsoPending.length > 0
        ? ` (${alsoPending.join(', ')} — already pending before this clear ran, and this call's ` +
          `flush retried ${alsoPending.length === 1 ? 'it' : 'them'} and ` +
          `${alsoPending.length === 1 ? 'was' : 'were'} rejected again)`
        : '';
      // "the backend accepted the durable remove for all of them" is false whenever `alsoPending`
      // fired alongside an empty `failed` — this clause only speaks for the keys THIS clear
      // enumerated, which `failed` (not `stillPending`) tracks.
      const failedClause = failed.length > 0
        ? `the backend REJECTED the durable remove for ${failed.length} of them: ${failed.join(', ')} — the on-disk state for ${failed.length === 1 ? 'it is' : 'them is'} unchanged from before this call`
        : 'every key this clear enumerated was durably removed';
      return {
        ok: false, code: 'PARTIAL', namespace, cleared: keys.length, keys, pendingWrites: stillPending,
        error: `clear removed ${keys.length} key(s) from the live cache but ${failedClause}${alsoPendingClause}`,
        hint: 'A rejected write keeps the key out of the cache but not off disk. Retry with player-prefs-write action:\'flush\' once the underlying issue (quota, I/O) clears.',
      };
    }
    return { ok: true, namespace, cleared: keys.length, keys };
  }

  if (typeof p.key !== 'string' || p.key === '') {
    return { ok: false, code: 'REFUSED_BY_OP', error: `action:'${p.action}' requires a non-empty string key` };
  }

  if (p.action === 'delete') {
    // A no-op is a failure when the caller asked for a change (§5) — and the refusal is more
    // useful than the no-op would have been, because a delete that hits nothing is almost always
    // a mistyped key and the real ones are right here.
    // #630 review finding 4 — a PROTECTED key also reads as absent from `has()` (deliberately —
    // see its doc comment), but it is not missing: it holds a save this build could not read, and
    // `set()`'s own refusal message tells the caller to `PlayerPrefs.delete(key)` first to clear
    // it. Without this check that escape hatch is unreachable from the agent surface — `has()`
    // says the key isn't there, so the delete falls straight into NOT_FOUND below, and the only
    // way left to clear a protected key is `action:'clear'`, which wipes the whole namespace.
    // `PlayerPrefs.delete()` itself already treats a protected key like any other (it drops the
    // protection unconditionally), so falling through to the ordinary delete path below is correct.
    if (!PlayerPrefs.has(p.key) && !PlayerPrefs.isProtected(p.key)) {
      // A key absent from the cache but still DIRTY is not a missing key — but it is NOT proof of
      // a rejection either. `PlayerPrefs.delete()` does `cache.delete; dirty.add; scheduleFlush()`
      // on a 150ms debounce, so an ordinary in-flight delete (the game's own `PlayerPrefs.delete()`,
      // or a prior call to this op before its own flush lands) has the IDENTICAL signature — dirty,
      // absent from cache, nothing yet sent to the backend. Flushing settles which one this is, and
      // if it was merely debounced, it also completes the removal this delete call asked for.
      if (PlayerPrefs.hasPendingWrite(p.key)) {
        await PlayerPrefs.flush();
        const deleteNoopSwapUnverifiable = swapUnverifiableAfterFlush({ key: p.key, deleted: true, alreadyRemoved: true });
        if (deleteNoopSwapUnverifiable) return deleteNoopSwapUnverifiable;
        if (PlayerPrefs.hasPendingWrite(p.key)) {
          return {
            ok: false, code: 'PARTIAL', namespace, key: p.key, deleted: true, saved: false,
            // Same symmetry as the PARTIAL below: "still on disk" would be false for a key whose
            // only prior write was itself a rejected SET.
            error: `'${p.key}' was already out of the live cache from an earlier delete, and the backend REJECTED its durable remove — the on-disk state is unchanged from before this call`,
            hint: "The cache removal already happened, so a second delete cannot help. Retry the durable remove with action:'flush' once the underlying issue (quota, I/O) clears.",
          };
        }
        return {
          ok: true, namespace, key: p.key, deleted: true, saved: true, alreadyRemoved: true,
          note: `'${p.key}' had already been removed from the live cache by an earlier delete whose durable write was still pending (the game's own delete, or a prior call); this call flushed it, so it is now durably removed`,
        };
      }
      const keys = [...PlayerPrefs.keys()].sort();
      return {
        ok: false, code: 'NOT_FOUND', namespace, key: p.key, keys,
        error: `no key '${p.key}' in namespace '${namespace}' — nothing was deleted`,
        options: keys,
      };
    }
    PlayerPrefs.delete(p.key);
    await PlayerPrefs.flush();
    const deleteSwapUnverifiable = swapUnverifiableAfterFlush({ key: p.key, deleted: true });
    if (deleteSwapUnverifiable) return deleteSwapUnverifiable;
    // Mirrors the `set` path's check below. `deleted: true` stays true even in the PARTIAL shape —
    // the cache removal DID happen, `get()`/`has()` on this key now behave as if it's gone. It's
    // `saved` that's false: the durable remove was rejected, so the key is still on disk and will
    // come back on the next launch. That asymmetry is the honest report.
    if (PlayerPrefs.hasPendingWrite(p.key)) {
      return {
        ok: false, code: 'PARTIAL', namespace, key: p.key, deleted: true, saved: false,
        // "Still on disk" would be false for a key whose only prior write was itself a rejected
        // SET — it was never durably written in the first place. State it symmetrically instead:
        // the durable remove failed, so whatever was on disk before this call (if anything) is
        // unchanged.
        error: `'${p.key}' was removed from the live cache but the backend REJECTED the durable remove (quota, or a native I/O error) — the on-disk state is unchanged from before this call`,
        hint: "Retry the durable remove with action:'flush'. A second delete cannot help — the cache removal already happened, so it reports this same PARTIAL rather than removing anything.",
      };
    }
    return { ok: true, namespace, key: p.key, deleted: true, saved: true };
  }

  // action:'set'
  if (p.value === undefined) {
    return {
      ok: false, code: 'REFUSED_BY_OP', error: "action:'set' requires a `value`. PlayerPrefs treats an undefined value as a DELETE, which is a different operation here.",
      options: ["action:'delete' to remove the key"],
    };
  }
  PlayerPrefs.set(p.key, p.value as JsonValue);
  // `set()` SKIPS a value in TWO distinct cases, both leaving `has()` false: a value it cannot
  // serialize (it warns and returns), and — #630 review finding 5 — a key PROTECTED by a save
  // this build could not read (it refuses to clobber it and returns). The wire is JSON, so the
  // non-serializable case should be unreachable — asserted here rather than assumed — but the
  // protected case is very much reachable, and reporting it as "rejected as non-JSON-serializable"
  // states a false cause authoritatively. Distinguish them with `isProtected` instead.
  if (!PlayerPrefs.has(p.key)) {
    if (PlayerPrefs.isProtected(p.key)) {
      return {
        ok: false, code: 'REFUSED_BY_OP', namespace, key: p.key,
        error: `'${p.key}' holds a save written by a newer build that this build cannot read, so the write was refused rather than overwriting it`,
        hint: `call player-prefs-write action:'delete' key:'${p.key}' first if overwriting it is intentional`,
      };
    }
    return { ok: false, code: 'REFUSED_BY_OP', namespace, key: p.key, error: `the value for '${p.key}' was rejected as non-JSON-serializable and NOT stored` };
  }
  // Flush rather than leaving the 150ms debounce running: an agent's next act is usually to verify
  // or to move on, and a debounced write that a reload or a scene swap eats would look like the
  // set never happened. The flush also surfaces a backend rejection, which the debounce would hide.
  await PlayerPrefs.flush();
  const setSwapUnverifiable = swapUnverifiableAfterFlush({ key: p.key });
  if (setSwapUnverifiable) return setSwapUnverifiable;
  const pending = PlayerPrefs.hasPendingWrite(p.key);
  if (pending) {
    return {
      ok: false, code: 'PARTIAL', namespace, key: p.key, saved: false,
      error: `'${p.key}' is set in the live cache but the backend REJECTED the durable write (quota, or a native I/O error) — it will not survive a restart`,
    };
  }
  return { ok: true, namespace, key: p.key, saved: true, value: PlayerPrefs.get(p.key) };
});

// ── Phase E: time-scale control (0=pause, 0.3=slow-mo, 2=fast) — inspect fast motion ──
registerAgentOp('set-timescale', (params) => {
  const { scale } = (params ?? {}) as { scale?: number };
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0) {
    return { ok: false, error: 'scale must be a finite number >= 0' };
  }
  setTimeScale(getCurrentWorld(), scale);
  return { ok: true, timeScale: getTimeScale(getCurrentWorld()) };
});

// ── Live trait mutation (#166) — the write half of the surface, registered HERE (runtime) rather
// than in agentEditorOps so the DEVICE gets it too, along with both eval APIs (which are generated
// from this registry). The editor keeps its own richer, UNDOABLE `apply-scene-ops` alongside it;
// this op is the flat, single-selector twin that works on every surface.
// See docs/mcp-tool-conventions.md §9.
/** Guess an asset-def kind from its filename. The suffixes are the project's own convention
 *  (docs/doc-conventions.md), not a heuristic. Exported so the EDITOR op reuses it instead of
 *  keeping a second copy (#166 P7 — the duplication class §9 warns about). */
export function inferAssetDefType(path: string): 'particle' | 'animation' | 'timeline' | 'spriteanim' | 'rig2d' | null {
  if (path.endsWith('.particle.json')) return 'particle';
  if (path.endsWith('.anim.json')) return 'animation';
  if (path.endsWith('.timeline.json')) return 'timeline';
  if (path.endsWith('.spriteanim.json')) return 'spriteanim';
  if (path.endsWith('.rig2d.json')) return 'rig2d';
  return null;
}

// ── read-asset-def (#166 P7) — what the RUNNING build actually resolved.
//
// Runtime twin: reads the live cache and nothing else. The editor replaces this with its own
// version, which additionally reports `unsaved` from the dirty-asset registry — a concept that
// does not exist on a device (no project on disk). On a phone this answers a question nothing else
// can: not "what does the file say" (a file read answers that) but "what did THIS build actually
// load", which is the whole observe-don't-infer rule applied to assets.
registerAgentOp('read-asset-def', (params) => {
  const { path, type } = (params ?? {}) as { path?: string; type?: string };
  if (!path) return { ok: false, error: 'read-asset-def requires { path }.' };
  const kind = type ?? inferAssetDefType(path);
  if (!kind) {
    return {
      ok: false,
      error: `cannot tell what kind of asset '${path}' is — pass type explicitly.`,
      options: ['particle', 'animation', 'timeline', 'spriteanim', 'rig2d'],
    };
  }
  // PEEK, don't load. The plain getters treat a miss as "not loaded YET" and kick off a background
  // fetch, so asking about an absent asset would queue a load that can only fail and log into the
  // console — for a question this op then refuses anyway.
  const peek = { load: false } as const;
  const def =
    kind === 'particle' ? getParticleEffect(path, peek)
    : kind === 'animation' ? getAnimationClip(path, peek)
    : kind === 'timeline' ? getTimeline(path, peek)
    : kind === 'spriteanim' ? getSpriteAnim(path, peek)
    : kind === 'rig2d' ? getRig2D(path, peek)
    : undefined;
  if (def === undefined) {
    return { ok: false, error: `unsupported type '${kind}'.`, options: ['particle', 'animation', 'timeline', 'spriteanim', 'rig2d'] };
  }
  if (def === null) {
    // NOT an empty answer: nothing has loaded this asset into the live cache, so there is no live
    // def to report. Saying so beats returning null, which reads as "the asset is empty".
    return { ok: false, error: `'${path}' is not in the live ${kind} cache — nothing in the running scene has loaded it.` };
  }
  return { ok: true, path, type: kind, source: 'live', def };
});

// ── Scene swap (#166 P5) — load another scene on the device with NO rebuild.
//
// The editor's `load-scene` guards unsaved editor work and returns editor state; neither exists
// here. What DOES carry over is the failure discipline: a load that did not happen must never be
// reported as one, which is why the current path is read back after the swap rather than echoed.
registerAgentOp('load-scene', async (params) => {
  const p = (params ?? {}) as { path?: string };
  if (!p.path) {
    return {
      ok: false,
      error: 'load-scene requires { path } — nothing was loaded.',
      current: sceneManager.getCurrent()?.path ?? null,
    };
  }
  const before = sceneManager.getCurrent()?.path ?? null;
  const loading = sceneManager.loadScene(p.path);
  // SceneManager allocates THIS attempt's id into `nextLoad` synchronously, before loadScene's
  // first await (SceneManager.ts:286-288) — so reading it here, between the call and the await,
  // names OUR load specifically, not whichever load happens to win a later swap (#486 finding A).
  const myId = sceneManager.getNext()?.id ?? null;
  try {
    await loading;
  } catch (e) {
    const cur = sceneManager.getCurrent();
    if (cur?.path === before) {
      return { ok: false, error: `load-scene FAILED for "${p.path}": ${(e as Error).message}. The previous scene is still loaded.`, current: cur?.path ?? null };
    }
    // A DIFFERENT load's world got swapped in while this one was failing — "the previous scene is
    // still loaded" would be false right next to `current` naming a third scene.
    return {
      ok: false,
      error: `load-scene FAILED for "${p.path}": ${(e as Error).message}. The active scene is now "${cur?.path ?? 'null'}" — the previous scene is NOT what is loaded, because another load swapped it in while this one was failing.`,
      current: cur?.path ?? null,
    };
  }
  const cur = sceneManager.getCurrent();
  const after = cur?.path ?? null;
  if (myId !== null && cur !== null) {
    if (cur.id === myId) {
      // Our load won the swap — unchanged success reply.
      return { ok: true, current: after, previous: before, entityCount: getAllEntities().length };
    }
    // ⚠️ `> myId`, NOT `!== myId`. Scene ids come from a monotonic `this.nextSceneId++`
    // (sceneManager.ts:286), so only an id GREATER than ours is evidence that a LATER load won
    // the swap. A different-but-SMALLER id means nothing newer ever installed and our own load
    // simply never became primary — and reporting THAT as "a later scene load won" would assert
    // from evidence that only says "the current id is not mine", which is the same shape of
    // over-claim this fix exists to remove. That case falls through to the original path check
    // below and keeps its original message. (A genuinely bad path throws at sceneManager.ts:325
    // and is answered by the catch above; this is belt-and-braces for any resolve-without-
    // installing path, which is what the original `after !== p.path` check was written for.)
    if (cur.id > myId) {
      // Superseded. `loadScene` still resolved successfully for us (sceneManager.ts:896, "a
      // superseded load skips straight to resolving"), so this is not our load failing and it
      // says nothing about whether `p.path` exists.
      if (cur.path === p.path) {
        // The same requested path won, so the caller's requested end state IS true — just not
        // because of THIS op's load. `entityCount` is deliberately omitted: it would be a live
        // read of a world this op did not load.
        return {
          ok: true, current: after, previous: before,
          note: `a concurrent load of "${p.path}" won the swap — this op's own load was superseded, but the requested scene is active.`,
        };
      }
      return {
        ok: false,
        superseded: true,
        current: after,
        previous: before,
        error: `load-scene for "${p.path}" was superseded — a LATER scene load won the swap, and "${after ?? 'null'}" is now the active scene. This op's own load did not fail; this says nothing about whether "${p.path}" exists in this build.`,
      };
    }
  }
  // Reached when `myId` could not be read (`getNext()` already cleared by the time we looked), or
  // when our load resolved without ever becoming primary and nothing newer installed either. The
  // original path comparison is the only check that does not depend on `myId` — message unchanged.
  if (after !== p.path) {
    return { ok: false, error: `load-scene did not switch to "${p.path}" — the active scene is ${after ?? 'null'}. Check the path exists in this build.`, current: after, previous: before };
  }
  return { ok: true, current: after, previous: before, entityCount: getAllEntities().length };
});

export const SIM_STEP_MAX_TIMEOUT_MS = 20000;

/** The default budget for `sim-step`, DERIVED from the frame count rather than flat.
 *
 *  A flat default could not cover the op's own documented maximum: 600 frames is ~10s at 60fps and
 *  ~20s at 30fps, so `sim-step {frames:600}` — the max the same handler advertises — timed out
 *  against its own budget every time. Two limits sized independently with no cross-check is how a
 *  feature fails on its headline call.
 *
 *  Exported so the arithmetic is unit-testable: pinning it through the op itself would mean waiting
 *  out a real timeout (4.5s+ per assertion), which is why the flat-default regression survived a
 *  mutation check until this was extracted. */
export function simStepDefaultTimeout(frames: number): number {
  return Math.min(SIM_STEP_MAX_TIMEOUT_MS, Math.max(3000, frames * 40 + 500));
}

// ── Sim control (#166 P3) — step an exact number of FRAMES on the device.
//
// NOT stepSimulation(): that is a HEADLESS-only entry point and its own docblock warns that calling
// it during a live real-clock 'playing' session "will reset the global clock to manual/0,
// disturbing the live render loop" — which is precisely a game running on a phone. So a device step
// advances REAL frames instead: unfreeze, let the natural rAF loop run N frames, re-freeze.
//
// The consequence is stated rather than hidden: a step here is one REAL frame (~16-33ms, whatever
// the phone took), not a fixed dt, so this is a measurement aid and NOT a deterministic repro. The
// deterministic-but-invasive alternative (install the manual clock, suspend the rAF driver) was
// considered and declined — see docs/mcp-tool-conventions.md §9 P3.
registerAgentOp('sim-step', (params) => {
  const p = (params ?? {}) as { frames?: number; scale?: number; timeoutMs?: number };
  const world = getCurrentWorld();
  // Mirrors the editor's `step requires paused state`: stepping a running world is meaningless, and
  // silently pausing one would be a side effect the caller did not ask for.
  if (getTimeScale(world) !== 0) {
    return Promise.resolve({
      ok: false,
      error: `sim-step requires a PAUSED world — timeScale is ${getTimeScale(world)}. Pause first with set-timescale {scale:0}.`,
      timeScale: getTimeScale(world),
    });
  }
  const frames = Math.max(1, Math.min(600, Math.floor(Number(p.frames ?? 1))));
  const scale = typeof p.scale === 'number' && Number.isFinite(p.scale) && p.scale > 0 ? p.scale : 1;
  const timeoutMs = Math.max(100, Math.min(SIM_STEP_MAX_TIMEOUT_MS, Number(p.timeoutMs ?? simStepDefaultTimeout(frames))));

  return new Promise((resolve) => {
    const key = `__agent-sim-step-${Date.now()}`;
    let seen = 0;
    let done = false;
    const elapsedOf = () => (getTime(world) as { elapsed?: number } | undefined)?.elapsed ?? 0;
    const startElapsed = elapsedOf();
    const finish = (timedOut: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unregisterFrameCallback(key);
      if (getCurrentWorld() !== world) {
        // A scene load swapped in a DIFFERENT world mid-step and destroyed this one (the two-world
        // atomic swap). Querying it further — getTime/setTimeScale below both do a koota
        // query/queryFirst — can throw on a destroyed world, and a throw here would skip `resolve`
        // entirely: the op would never reply at all (#486 finding B). So: touch `world` no further.
        resolve({
          ok: false,
          worldReplaced: true,
          stepped: seen, requested: frames,
          error: `the world was REPLACED during this step — a scene load swapped it out and destroyed `
            + `it, so this step's numbers cannot be attributed to the world it started on. "stepped" `
            + `(${seen}) counts frames the frame driver ran GLOBALLY, including the incoming world's `
            + `frames, not frames run on the destroyed one. Nothing was left unfrozen: the only world `
            + `this op unfroze is the one that was destroyed, so the live world's timeScale is untouched.`,
        });
        return;
      }
      setTimeScale(world, 0);   // ALWAYS re-freeze, including on the timeout path
      const advancedMs = Math.round((elapsedOf() - startElapsed) * 1000);
      if (timedOut) {
        // A frozen frame loop is the honest answer here. Reporting `stepped: 0` as a success would
        // tell an agent the world advanced when nothing rendered at all (conventions §8).
        resolve({
          ok: false,
          error: `only ${seen} of ${frames} frame(s) ran within ${timeoutMs}ms — the frame loop may be stopped or the app backgrounded. The world was re-frozen (timeScale 0).`,
          stepped: seen, requested: frames, advancedMs,
        });
        return;
      }
      resolve({ ok: true, stepped: seen, advancedMs, timeScale: getTimeScale(world), note: 'real frames, not a fixed dt — a step is however long the device took to render it.' });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    // Priority 100: after ECS and both renderers, so a frame is counted only once its work is done.
    registerFrameCallback(key, () => {
      // Bail out immediately on a world swap rather than burning the rest of the timeout budget —
      // this is what turns a 20s wait into an honest answer on the very frame the swap happens.
      if (getCurrentWorld() !== world) { finish(false); return; }
      if (++seen >= frames) finish(false);
    }, 100);
    setTimeScale(world, scale);
  });
});

// ── Entity lifecycle (#166 P2) — runtime twins, so the DEVICE can spawn/duplicate/delete. The
// editor REPLACES all three at startup with its undoable versions (registerAgentOp is a Map keyed
// by name, and agentEditorOps registers later), so an editor session is unchanged.
registerAgentOp('create-entity', createEntityLive);
registerAgentOp('duplicate-entity', duplicateEntityLive);
registerAgentOp('delete-entities', deleteEntitiesLive);

registerAgentOp('set-traits', (params) =>
  applyLiveMutate(params, {
    parseWhere,
    guidOf: (id) => {
      const eaMeta = getAllTraits().find((m) => m.name === 'EntityAttributes');
      const d = eaMeta ? readTraitData(id, eaMeta) : null;
      return ((d?.guid as string) || '') || String(id);
    },
  }));

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

/** What a watched-file change asks this renderer to do. Structurally mirrors `LiveReloadKind`
 *  in `engine/plugins/vite-asset-scanner.ts` (the producer) — kept as a local union rather than
 *  a type import because the plugin is a Node module and the app tsconfig has no node types.
 *  Keep the two in sync; a new kind that lands here without a branch below is simply ignored. */
type SceneChangedKind = 'scene' | 'prefab' | 'animation' | 'timeline' | 'particle' | 'spriteanim' | 'rig2d' | 'animset';

/**
 * Kinds whose ONLY stale thing is a cached asset definition → drop that entry and stop. Never a
 * scene reload: the cache is all that went stale, and reloading would throw away unsaved live work.
 *
 * A TABLE, not a chain of `if`s, and that is the actual fix for #74. This had five instances of one
 * defect — `invalidateAnimationClip`, `invalidateTimeline`, `invalidateParticleEffect`,
 * `invalidateSpriteAnim`, `invalidateRig2D` each shipped exported, tested, and with ZERO production
 * callers — because a new kind needed a hand-written branch here AND a hand-written member in
 * `LiveReloadKind` over in the plugin, with nothing checking either. Three of them were fixed one
 * at a time, each with a comment explaining the class, and the fourth and fifth still happened.
 *
 * With a table, adding a kind is one entry, and
 * `engine/tests/architecture/liveReloadKinds.test.ts` fails when the two unions disagree or when a
 * kind has neither a table entry nor an explicit scene-reload branch. The symptom this prevents is
 * nasty precisely because it is not a crash: the asset keeps working with its old contents, so it
 * reads as "my edit was ignored" rather than as a stale cache.
 */
const ASSET_CACHE_INVALIDATORS: Partial<Record<SceneChangedKind, (urlPath: string) => void>> = {
  animation: invalidateAnimationClip,
  timeline: invalidateTimeline,
  particle: invalidateParticleEffect,
  spriteanim: invalidateSpriteAnim,
  rig2d: invalidateRig2D,
  // Sixth, and a different shape from the five: `invalidateAnimSet` was never callerless — the
  // Inspector's AnimSetAssetView drives it — so only EXTERNAL writes were unserved. That is why
  // `liveReloadKinds.test.ts` stayed green through it: `animset` was missing from BOTH unions, so
  // the cross-check agreed with itself. `invalidatorsAreReachable.test.ts` asks from the other end.
  animset: invalidateAnimSet,
};

/** The file on disk for `urlPath` just changed, so its cached def is being dropped — any
 *  PARKED write for that same path is now stale and must go with it.
 *
 *  WHY (independent review, 2026-07-30). `/api/asset-write` writes from the Node process and
 *  never told the renderer, so an explicit `modoki_write_asset` to a path that still had a
 *  parked particle/anim/timeline doc was silently reverted by the next `save_all` — it flushed
 *  the stale parked doc straight over the freshly written file. Dropping the parked write with
 *  the cache is the only coherent outcome: once the cache is invalidated the pending doc has no
 *  live counterpart, and disk becomes the truth for that asset.
 *
 *  Dynamic import on purpose: `agentBridge` ships in device debug builds, and the dirty-asset
 *  registry is editor-only. The branch only ever runs where a file watcher exists.
 *
 *  Loud, never silent — this discards pending work, so it says exactly what it dropped. */
async function dropParkedWriteFor(urlPath: string): Promise<void> {
  try {
    const { peekDirtyAsset, discardDirtyAssets } = await import('@modoki/engine/editor');
    if (!peekDirtyAsset(urlPath)) return;
    discardDirtyAssets([urlPath]);
    console.warn(
      `[agentBridge] ${urlPath} changed on disk — DISCARDED the pending unsaved edit parked for it. ` +
      'The file on disk is now authoritative; the parked write would have overwritten it at the next save_all.',
    );
  } catch { /* not an editor context — no registry to clear */ }
}

/** Hot-reload the active scene when its file (or any prefab) changes on disk.
 *  Shared by the Vite HMR path and the Electron IPC path. */
async function handleSceneChanged(msg: { urlPath: string; kind: SceneChangedKind }): Promise<void> {
  // An asset-def change (.anim/.timeline/.particle/.spriteanim/.rig2d) invalidates just that
  // cache entry and returns — see ASSET_CACHE_INVALIDATORS above for why this is a table and what
  // it prevents. The parked write goes with the cache entry: once the cached def is dropped the
  // pending doc has no live counterpart, and disk becomes the truth for that asset (otherwise the
  // next save_all flushes the stale parked doc over the file that was just written).
  const invalidateCachedAsset = ASSET_CACHE_INVALIDATORS[msg.kind];
  if (invalidateCachedAsset) {
    invalidateCachedAsset(msg.urlPath);
    await dropParkedWriteFor(msg.urlPath);
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
  // A7 (scene-loading.md): the changed file may be a BASE in the
  // loaded chain, not the primary — match against EVERY loaded scene, not just the
  // primary's path. Without this, editing Base.json on disk (an agent's
  // scene-mutate write, or a hand edit) landed silently: the live world kept
  // rendering the stale copy with no warning, because the old check only ever
  // compared against the primary.
  let changedBaseGuid: string | undefined;
  if (msg.kind === 'scene') {
    const normChanged = normScenePath(msg.urlPath);
    let matchedAny = false;
    for (const entry of sceneManager.getLoadedScenes().values()) {
      if (normScenePath(entry.path) !== normChanged) continue;
      matchedAny = true;
      if (entry.role === 'base') changedBaseGuid = entry.guid;
      break;
    }
    if (!matchedAny) return; // touches no scene in the currently-loaded chain
  }
  try {
    // Fetch the fresh file once: validate it AND hand it to loadScene via
    // `preloaded` so the reload doesn't fetch the same bytes a second time.
    // Only usable when the CHANGED file is the primary itself — a changed base's
    // bytes go through `forceReloadBases` below instead (loadScene re-fetches it
    // as part of resolving the chain).
    let preloaded: SceneData | undefined;
    if (!changedBaseGuid) {
      try {
        const res = await fetch(current, { cache: 'no-store' });
        if (res.ok) {
          preloaded = await res.json();
          // Best-effort resolver over the runtime's already-loaded prefab cache (#35) — no
          // fetch: an unloaded prefab (not yet acquired by any scene) resolves to undefined,
          // which is the documented conservative "stay silent" behaviour, not a bug.
          // #292 — the manifest is loaded by the time a scene hot-reloads, so this consumer
          // can answer "does that GUID name a real asset?" too, and a dead ref is worth a
          // warning HERE, right before the load that will silently drop it. The RULE (and
          // the "no guids ⇒ no resolver ⇒ could-not-check" guard) lives in
          // `makeAssetRefResolver` — building it here by hand is what once let this consumer
          // disagree with the dev-server one about letter case. Passing guids rather than a
          // lookup is exact, not an approximation: `registerAsset` stores `{ guid, ... }`
          // UNDER that same guid, so this set is `guidToEntry`'s key set, which is what
          // `resolveRef` consults.
          const assetExists = makeAssetRefResolver(getAllAssets().map((a) => a.guid));
          const { warnings } = validateSceneData(preloaded, buildSceneSchema(), getCachedPrefab, assetExists);
          if (warnings.length) {
            console.warn(`[agentBridge] ${warnings.length} validation warning(s) in ${current}:`);
            for (const w of warnings) console.warn(`  • ${w}`);
          }
        }
      } catch { /* fall back to loadScene's own fetch */ }
    }
    await sceneManager.loadScene(current, {
      ...(preloaded ? { preloaded } : undefined),
      ...(changedBaseGuid ? { forceReloadBases: [changedBaseGuid] } : undefined),
    });
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

export function initAgentBridge(): void {
  const hot = import.meta.hot;
  const bridge = (window as unknown as { __modokiElectron?: { bridge?: ElectronBridge } }).__modokiElectron?.bridge;
  // Exactly ONE backend's watcher drives scene reloads — the one owning the
  // self-write guard for this renderer's writes (see sceneReloadSource).
  const reloadSource = sceneReloadSource({ hasBridge: !!bridge, hasHot: !!hot });
  if (!hot && !bridge) return;

  // Belt-and-suspenders: the shared ring is already installed by `installConsoleRing.ts`'s eager
  // import by the time this runs (#596/#597 Stage 3a) — this call is now a thin shim, kept so
  // `/api/console-logs` still has something to fall back on if that ever changes.
  installConsoleCapture();

  // ── Electron: also serve the main-hosted backend over IPC (ELECTRON_PLAN
  //    Phase 2). Schema push + request answering are required so main's backend
  //    can type-check and run /api/scene-state. Scene reload is driven off this
  //    bridge whenever it exists (dev or packaged — see sceneReloadSource, which
  //    avoids a double reload against Vite's own HMR socket below); manifest
  //    updates are ALSO driven off this bridge whenever it exists (#503 — see the
  //    `manifest-updated` handler below for why dev is included). ──
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
      bridge.on('scene-changed', (data) => {
        void handleSceneChanged(data as { urlPath: string; kind: SceneChangedKind });
      });
    }
    // Registered whenever the Electron bridge exists — dev included (#503). Unlike
    // scene reloads above, this one is NOT `if (!hot)`-gated: `/api/create-asset`
    // (and friends) is served by MAIN's backend, so main's `rebuildManifest()`
    // broadcast reaches this renderer ONLY over this IPC channel. In dev, Vite's
    // own chokidar watcher eventually notices the same file and fires
    // `asset-manifest-updated` (handled in init.ts), but that copy is ~1s late
    // (debounce + FS latency) — long enough for an agent's very next
    // `particle-set`/`anim-set-clip`/`timeline-set` call to bounce off a stale
    // `pathToGuid` map with "no asset exists at <path>". Staying on this channel
    // in dev closes that window instead of waiting on Vite's slower copy.
    //
    // Must stay ADDITIVE (no `{ prune: true }`): `createEditor.tsx` loads WITH
    // prune as the sole authority that a missing guid means a DELETED asset: a
    // second, possibly-stale IPC payload treated as a full rescan could delete a
    // guid that was only briefly absent from IT, not from the project. Loaded
    // additively (as here, and in init.ts), a late/stale payload can at worst
    // transiently re-add a just-deleted guid, which the next pruning load from
    // Vite corrects — never the other way around.
    bridge.on('manifest-updated', (data) => {
      try { loadManifestJson(data as Parameters<typeof loadManifestJson>[0]); }
      catch (e) { console.warn('[agentBridge] manifest update failed:', e); }
    });
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
  // Reconnect (server restart drops the dev server's cache): force a resend even if the
  // trait set is unchanged — a plain start() would find the same signature already sent
  // and send nothing, leaving the freshly-restarted server with no schema at all.
  hot.on('vite:ws:connect', () => { if (!schemaPushed) pusher.start({ force: true }); });

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
    hot.on('modoki:scene-changed', (msg: { urlPath: string; kind: SceneChangedKind }) => { void handleSceneChanged(msg); });
  }
}
