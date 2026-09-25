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
 *  `project.config.json` `build.debugBuild` (`engine/app/main.tsx`'s `initDebugBridge` gate), which decides whether the
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

import { opReplyFor, OpRefusal } from './opRefusal';
import { CONSOLE_LEVELS, atConsoleLevel, isConsoleLevel, type ConsoleLevel } from '../../tools/shared/consoleLevels';
import { conditionError, surfaceError, waitForCondition, clampWaitTimeout, type WaitCondition, type WaitReaders } from './waitFor';
import {
  hasDocKey,
  sceneManager,
  getAllEntities,
  rawNow,
  getAllTraits,
  readTraitData,
  readTraitDataFull,
  buildSceneSchema,
  validateSceneData,
  loadManifestJson,
  renderSceneOffscreen,
  hasSceneRenderer,
  journalEvents,
  clearJournal,
  captureEpoch,
  currentCaptureSeq,
  resolveCapCursor,
  journalDroppedThroughCap,
  journalGapNote,
  setJournalEnabled,
  JOURNAL_LEVELS,
  isJournalLevel,
  type JournalLevel,
  resolveRefName,
  setVerboseCapture,
  verboseCaptureState,
  isVerboseType,
  dispatchUIAction,
  isActionRefusal,
  getUIActionNames,
  isControlLessAction,
  actionControlOnScreen,
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
  pendingPhysics,
  ensurePhysicsReady,
  ensurePhysicsModuleReady,
  getContactState,
  registerHandleProvider,
  REIMPORT_INVALIDATORS,
  type ReimportableAssetKind,
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
  invalidateMaterial,
  invalidateShader,
  invalidateMeshAsset,
  invalidatePrefab,
  fireDirtyListeners,
  findEntityByGuid,
  getCachedPrefab,
  getAllAssets,
  PlayerPrefs,
  type JsonValue,
  raycast2D, shapeCast2D, pointQuery2D, hasPhysics2D,
  raycast3D, shapeCast3D, pointQuery3D, hasPhysics3D,
  RigidBody2D, RigidBody3D, getPlayState,
  findEntityById,
  EntityAttributes,
  makeAssetRefResolver,
  getParticleEffect,
  getAnimationClip,
  getTimeline,
  getSpriteAnim,
  getRig2D,
  getAnimSet,
  getSpriteMaterialProgram,
  isGuid,
  isRuntimeGuid,
  getGuidForPath,
  startInputWatch,
  stopInputWatch,
  clearInputPresses,
  readInputPresses,
  isUnresolvedPress,
} from '@modoki/engine/runtime';
import { classifyWorldAbsence } from './sceneQueryAbsence';
import { applyLiveMutate } from './liveMutate';
import { createEntityLive, duplicateEntityLive, deleteEntitiesLive, liveGuidOf } from './liveLifecycle';
import { resolveEntityAddress, type EntityAddress } from './entityRef';
import { ERROR_CODES, codeFromBody, isFailureBody, type ErrorCode } from '../../tools/shared/errorCodes';
import { INVALIDATABLE_ASSET_TYPES, type InvalidatableAssetType } from '../../tools/shared/invalidateAssets';
import { describeFilter, emptyFilterHint, histogram } from '../../tools/shared/filterDisclosure';
import { computeLayoutBounds, type LayoutBoundsParams, type LayoutEntry } from './layoutDump';
import { tailWithCounts, headWithCounts, takeHead, tailHint, CONSOLE_TAIL_DEFAULT, JOURNAL_TAIL_DEFAULT } from './streamSummary';
import { roundFloats, resolvePrecision } from './roundFloats';
import { computeHandles, type HandlesDumpParams } from './handlesDump';
import { resolveDomPointReport, type DomPointSpec } from './domResolve';
import { layoutSettleReport } from './layoutSettle';
import { resolveEntityPointReport, type EntityPointSpec } from './entityResolve';
import { coveredCarriers } from './carrierCover';
import { readConsoleSource } from './consoleSource';
import { getConsoleRingEntries, getConsoleRingDropped, getConsoleRingEpoch, installConsoleRing } from '@modoki/engine/runtime/core/consoleRing';
import { chromeHandles } from './chromeHandles';
import { computeDiagnostics } from './diagnose';
import { makeSchemaPusher } from './schemaPusher';
// Single-sourced with the HOST side (`mcp-tools.ts`'s `device_step` tool, which must derive this
// SAME default when a caller omits `timeoutMs`) — see `engine/tools/shared/simStepTiming.ts`
// (#822). A VALUE import from `tools/shared`, not `import type`: see that file's docblock for why
// this is a deliberate exception to the app→tools/shared "types only" convention.
import { SIM_STEP_MAX_TIMEOUT_MS, SIM_STEP_MAX_FRAMES, simStepDefaultTimeout } from '../../tools/shared/simStepTiming';
import { PROFILER_ACTIONS, isProfilerAction } from '../../tools/shared/profilerActions';
import {
  startCapture, stopCapture, clearCapture, getCapture, readPerfProfile,
  resetProfilerMarkers, resetMarkerAggregate, resetFrameProfile, type MarkerSample,
  getBootTimeline, getBootOrigin, bootSpansOverlapping, resetBootTimeline, getWorstStallWindow,
  getFrameProfile,
  setGpuTimingEnabled, resetGpuTimings,
  collectHitRegions, collectHitRegionsReport, hitRegionProviders, isHitRegionOverlayVisible, setHitRegionOverlayVisible,
  regionsAt, nearestRegionTo,
  getFrameLoopHealth,
} from '@modoki/engine/runtime';
import {
  listAgentTools, getAgentTool, agentToolsVersion, validateAgentToolArgs, coerceAgentToolArgs, type AgentToolDef,
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
  /** Only the entities that CARRY this trait, and only this trait's data on each (#1557). */
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
  /** Cap the number of entities returned; sets `truncated` when hit (`returnedCount`/`totalCount` are always present).
   *  In INDEX mode (the untargeted default) this defaults to `DEFAULT_INDEX_LIMIT`, and a
   *  TARGETED query (id/guid/trait/name/where) to `DEFAULT_TARGETED_LIMIT`; an untargeted
   *  enriched query (full/world/bounds/contacts alone) stays uncapped unless you pass one. */
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
interface ConsoleEntry { seq: number; level: 'log' | 'warn' | 'error'; ts: number; text: string }
/** `level` is a threshold and `since` a ring SEQ cursor, with `sinceMs` the clock form (#1559). */
interface ConsoleLogsParams { level?: ConsoleLevel; limit?: number; since?: number; sinceMs?: number; epoch?: unknown }

/** A `since` at or above this is an epoch-ms timestamp, not a ring seq: a seq counts log lines from
 *  one page load and cannot reach 1e11, and every epoch-ms instant since 1973 is above it. Before
 *  #1559 `since` WAS epoch ms on this tool, so an old caller's number lands here and is refused with
 *  a pointer to `sinceMs` instead of silently matching nothing. */
const CONSOLE_SEQ_CEILING = 1e11;

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
    seq: e.seq,
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
  if (p.level) logs = logs.filter((e) => atConsoleLevel(e.level, p.level!));
  if (p.since != null) logs = logs.filter((e) => e.seq > p.since!);
  if (p.sinceMs != null) logs = logs.filter((e) => e.ts > p.sinceMs!);
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

/** A staleness note for a FRAME-FED read — worldTransforms, screen bounds, hit regions, a physics
 *  query, the profiler, a watch sample. Every one of these is only as fresh as the frame the loop
 *  last actually ran, and a dead rAF chain returns last-live-frame data with nothing saying so
 *  (#682). Appended to the op's EXISTING `warnings` array rather than a new payload shape.
 *
 *  Same "healthy means silent" inclusion rule as the editor's `frameLoopFields()`
 *  (`agentEditorOps.ts`): silent while `status==='running' && recovered===0`.
 *  `getFrameLoopHealth()` already carries a ready-to-read `.detail` for the two cases that matter
 *  most — `'idle'` (this was NEVER computed, not merely stale — the loop has never pumped a frame)
 *  and `'stalled'` (this is the last frame that ran, N ms ago) — so this reuses it rather than
 *  re-deriving the same facts twice. */
function frameStalenessWarning(what: string): string | null {
  const h = getFrameLoopHealth();
  if (h.status === 'running' && h.recovered === 0) return null;
  if (h.detail) return `${what}: ${h.detail}`;
  // 'hidden' (benign — an occluded window — and carries no `.detail`) or 'running' just after a
  // stall recovered: still worth saying, since either can mean this read spans a gap the caller
  // has no other way to see.
  return `${what}: the frame loop is ${h.status}` +
    (h.recovered > 0 ? ` (recovered from a stall ${h.recovered} time(s) this session)` : '') +
    ' — this may not be from the CURRENT frame.';
}

/** Build a plain-JSON dump of the live ECS world — the "verify without a
 *  screenshot" payload. Reuses `getAllEntities` (which already returns the trait
 *  names present per entity), resolving each name to its meta via a map built
 *  once — avoids re-walking the world per entity. */
/** Default cap on the untargeted INDEX. Comfortably above a hand-authored scene, low
 *  enough that a generated one can't flood a context window before the agent narrows. */
export const DEFAULT_INDEX_LIMIT = 200;

/** Default cap on a TARGETED read (#1557). Targeted rows carry trait VALUES — ~1.6-2.2k chars per UI
 *  row — so a substring like `name=Account` matching 17+ entities answered 36k chars, and `name` was
 *  the heaviest argument group in two months of transcripts (101 calls, 546k chars). This used to be
 *  uncapped on purpose, because losing rows SILENTLY would be worse than a large answer. The cap is
 *  therefore never silent: a capped reply leads with `truncated`, `totalCount` and a hint that names
 *  how many more there are and the exact `limit` that returns them all (owner, 2026-09-25). */
export const DEFAULT_TARGETED_LIMIT = 20;

/** Why `where` cannot be evaluated (the same parse `dumpSceneState` applies), or null. Lets a caller
 *  refuse a typo'd predicate up front instead of reading it as "nothing matches" (#1154). */
export function whereError(where: string): string | null {
  const r = parseWhere(where, new Map(getAllTraits().map((m) => [m.name, m] as const)));
  return 'error' in r ? r.error : null;
}

export function dumpSceneState(params: SceneStateParams = {}) {
  // An empty `trait` filters nothing — as before #1557, when it could only project. Selecting on it
  // would answer "trait '' is not registered" to an eval body that passed a blank field through.
  if (params.trait === '') params = { ...params, trait: undefined };
  const metaByName = new Map(getAllTraits().map((m) => [m.name, m] as const));
  const readTrait = params.full ? readTraitDataFull : readTraitData;
  const warnings: string[] = [];
  // #682: `world`/`bounds` are FRAME-FED — `worldTransforms` is written by
  // transformPropagationSystem, a frame callback, so both enrichers are only as fresh as the last
  // frame the loop actually ran. The `world` guard below (`worldTransforms.get(info.id)`) used to
  // be a SILENT omission either way: a loop that ran and then died returns last-live-frame values
  // as current with nothing saying so, and a loop that never ran drops the key with no explanation
  // at all (indistinguishable from "this entity has no computed world transform").
  if (params.world || params.bounds) {
    const w = frameStalenessWarning('world/bounds');
    if (w) warnings.push(w);
  }
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
  // How many the DEFAULT resource exclusion left out — the constant F8 measured between this read and
  // the editor state's world count (136 vs 137), which nothing in the reply used to explain.
  const resourcesExcluded = all.length - wanted.length;
  let guidMissed = false; // already explained by its own warning — the empty-filter hint would repeat it
  if (params.id != null) wanted = wanted.filter((e) => e.id === params.id);
  if (params.guid) {
    const ent = findEntityByGuid(params.guid);
    if (ent) { const gid = ent.id(); wanted = wanted.filter((e) => e.id === gid); }
    else { wanted = []; guidMissed = true; warnings.push(`guid "${params.guid}" matched no entity in the live world (it may be stale — ids/entities rebuild on scene reload).`); }
  }
  if (params.name) {
    const q = params.name.toLowerCase();
    wanted = wanted.filter((e) => (e.name ?? '').toLowerCase().includes(q));
  }
  if (whereResult && !('error' in whereResult)) wanted = wanted.filter((e) => whereResult.pred(e));
  // `trait=` SELECTS the entities that carry it (#1557). It used to only project the fields, so every
  // other entity came back as a `traits:{}` row — `trait=CourtConfig` answered 274 rows for one config
  // entity. An unregistered trait selects nothing; its own warning below says why.
  const traitKnown = params.trait != null && metaByName.has(params.trait);
  if (params.trait != null) wanted = traitKnown ? wanted.filter((e) => e.traits.includes(params.trait!)) : [];
  const totalCount = wanted.length;
  let truncated = false;
  // Both defaults are DISCLOSED caps, never silent ones: a capped reply carries `truncated`, the
  // `totalCount` before the cap, and a hint naming the `limit` that returns every match.
  const limit = params.limit ?? (indexMode ? DEFAULT_INDEX_LIMIT : targeted ? DEFAULT_TARGETED_LIMIT : undefined);
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
  // `null` for an entity with no guid, NEVER `String(id)` (#1199): the id-as-guid looked addressable
  // and every guid-addressed op refused it. See `liveGuidOf` in liveLifecycle.ts.
  const guidCache = new Map<number, string | null>();
  const guidOf = (id: number): string | null => {
    let g = guidCache.get(id);
    if (g === undefined) { g = liveGuidOf(id); guidCache.set(id, g); }
    return g;
  };
  // A contact partner with no guid is `id:<n>`, not null (#1199 review). A row's `guid: null` has
  // its `id` beside it; a bare array element has nothing else, so null would lose WHICH body it is
  // (and two such partners would read `[null, null]`). `id:<n>` cannot be mistaken for a guid.
  // Since #1248 every spawn has a guid (#1210's runtime mint, on EntityAttributes spawnEntity adds), so
  // only an entity whose EntityAttributes was REMOVED after spawn reaches it.
  const contactRefOf = (id: number): string => guidOf(id) ?? `id:${id}`;
  // The parent named by guid beside `parentId` (#1223 P2); `null` for a root (parentId 0) or a guid-less parent.
  const parentGuidOf = (parentId: number | undefined): string | null => (parentId ? guidOf(parentId) : null);
  const contactWorld = params.contacts ? getCurrentWorld() : null;
  // An unknown or WRONG-CASE `trait=` was applied silently: every entity came back with
  // `traits:{}` and no warning, which reads as "nothing in this scene has that trait" rather than
  // "there is no such trait". The two call for opposite next moves — add the component, versus fix
  // the spelling — so the answer must distinguish them. `where=` already warns on an unknown
  // trait/field (line above); this is the same rule for the simpler filter. (§6: never silently
  // ignore a parameter.)
  if (params.trait != null && !traitKnown) {
    const near = [...metaByName.keys()].filter((t) => t.toLowerCase() === params.trait!.toLowerCase()
      || t.toLowerCase().includes(params.trait!.toLowerCase())).slice(0, 6);
    warnings.push(
      `trait "${params.trait}" is not a REGISTERED trait, so it selected no entities — ` +
      `that means the FILTER name is wrong, NOT that the scene lacks the component.` +
      (near.length ? ` Did you mean: ${near.join(', ')}? (names are case-sensitive)` : ' List them with modoki_list_traits.'),
    );
  }

  const entities = wanted.map((info) => {
    // Index mode: trait NAMES, no values. Plus the GUID — the only hot-reload-stable way to
    // address an entity (runtime ids are reassigned on every reload), and previously buried
    // inside `traits.EntityAttributes` where the untargeted caller could never cheaply see it.
    if (indexMode) {
      return { id: info.id, guid: guidOf(info.id), name: info.name, parentId: info.parentId, parentGuid: parentGuidOf(info.parentId), layer: info.layer ?? null, traits: info.traits };
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
    const out: Record<string, unknown> = { id: info.id, guid: guidOf(info.id), name: info.name, parentId: info.parentId, parentGuid: parentGuidOf(info.parentId), layer: info.layer ?? null, traits };
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
      if (cs?.contacts.length) out.contacts = cs.contacts.map(contactRefOf);
      if (cs?.overlaps.length) out.overlaps = cs.overlaps.map(contactRefOf);
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
      ? `Showing ${entities.length} of ${totalCount} matches — ${totalCount - entities.length} MORE are not shown` +
        `${params.limit == null ? ` (a targeted read is capped at ${DEFAULT_TARGETED_LIMIT} by default)` : ''}. ` +
        `Pass limit=${totalCount} for all of them, or narrow with trait=/name=/where=.`
      // #1214: a targeted query that matched nothing answered `totalCount:0` with nothing beside it, so
      // a typo'd `name=Plyer` read exactly like "that entity is gone". Say which one it was.
      : targeted && totalCount === 0 && !guidMissed && (params.trait == null || traitKnown)
        ? emptyFilterHint({
          what: 'entity',
          filter: describeFilter({ id: params.id, guid: params.guid, trait: params.trait, name: params.name, where: params.where }),
          unfilteredCount: all.length,
          // A targeted query searches every entity, resources included — which a BARE read hides.
          unfilteredLabel: 'exist in the world, resources included',
          live: params.name ? { name: all.map((e) => e.name ?? '') } : undefined,
          near: { name: params.name },
        })
        : undefined;
  return {
    scenePath: sceneManager.getCurrent()?.path ?? null,
    // §2 (#1217, #1223 D3): `returnedCount` is the rows below, `totalCount` every entity the query
    // matched before the limit — both always, so a total never exists only when truncation happened.
    // Never `entityCount`: it meant these rows here and the whole world in the editor state.
    returnedCount: entities.length,
    totalCount,
    // A capped reply says so BEFORE the rows (#1557): a reader skimming 20 rows meets `truncated` and
    // the hint naming the missing count first, not after the payload it would otherwise stop at.
    ...(truncated ? { truncated } : {}),
    ...(truncated && hint ? { hint } : {}),
    ...(resourcesExcluded ? { resourcesExcluded } : {}),
    entities,
    ...(warnings.length ? { warnings } : {}),
    ...(hint && !truncated ? { hint } : {}),
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
 *  Stop (see editor/scene/playMode.ts), so we hold the reload back and tell the caller
 *  to Stop first. A held reload is DEFERRED, not dropped (#1164): it replays once
 *  authoring settles — `replaySuppressedSceneReloads`, docs/editor-hmr.md. Unset in the
 *  shipped game runtime (which has no Stop that could clobber), so hot-reload there
 *  always proceeds. Returns a reason string when reload should be suppressed, else null. */
let _reloadSuppressor: (() => string | null) | null = null;

/** Editor-only: install the hot-reload suppression gate. Called from
 *  `agentEditorOps.ts` at editor startup so game builds never suppress. */
export function setSceneReloadSuppressor(fn: (() => string | null) | null): void {
  _reloadSuppressor = fn;
}

/** Editor-only: re-reads the EDITOR's copy of a prefab whose file changed on disk (#1169). The
 *  runtime cache is evicted here directly; the editor's diff-base copy lives in the editor package,
 *  which this module must not import, so the editor installs the refresh the way it installs the
 *  suppressor. */
let _prefabSourceRefresher: ((urlPath: string) => Promise<void>) | null = null;

/** Editor-only: install the editor-side prefab refresh. Called from `agentEditorOps.ts`. */
export function setPrefabSourceRefresher(fn: ((urlPath: string) => Promise<void>) | null): void {
  _prefabSourceRefresher = fn;
}

/** Editor-only: told when a hot reload has REPLACED the current world from disk (#1409), and which
 *  bases it kept (#1417), so the editor can drop discarded work's undo entries and rebaseline —
 *  `adoptWorldReloadedFromDisk`.
 *  Installed the way the suppressor is; unset in the game runtime, which has no undo. */
type WorldReloadedFromDisk = (scenePath: string, keptBaseGuids: ReadonlySet<string>) => void | Promise<void>;
let _worldReloadedFromDisk: WorldReloadedFromDisk | null = null;

/** Editor-only: install the after-reload hook. Called from `agentEditorOps.ts`. */
export function setWorldReloadedFromDiskHook(fn: WorldReloadedFromDisk | null): void {
  _worldReloadedFromDisk = fn;
}

/** Why scene hot-reload is currently suppressed (editor Play mode), or null when
 *  it may proceed. Also consulted by the backend to refuse mutate-while-playing. */
export function sceneReloadSuppressedReason(): string | null {
  return _reloadSuppressor?.() ?? null;
}

/** Register (or replace) an agent op handler. Editor-only ops call this from
 *  `engine/app/editor/agentEditorOps.ts` during editor startup. */
export function registerAgentOp(name: string, handler: AgentOpHandler, opts: { accepts?: (params: unknown) => boolean } = {}): void {
  agentOps.set(name, handler);
  // A re-registration without `accepts` (the editor replacing a runtime op) takes EVERY call again.
  if (opts.accepts) agentOpAccepts.set(name, opts.accepts); else agentOpAccepts.delete(name);
}

/** Per-op "is this call MINE?" predicates (#1559 review). The HMR relay broadcasts a request to every
 *  client and settles on the first answer that is not a decline (#1030), so a client that holds an op
 *  but cannot serve THIS call must decline it, not refuse it: the runtime `wait-for` on a
 *  `#/game/<id>` tab has no editor, and its instant refusal of a `chrome` wait beat the editor's park. */
const agentOpAccepts = new Map<string, (params: unknown) => boolean>();

/** Would this client serve `op` with `params`? What the relay asks before running anything. */
export function servesAgentOp(op: string, params: unknown): boolean {
  if (!agentOps.has(op)) return false;
  const accepts = agentOpAccepts.get(op);
  return !accepts || accepts(params);
}

/** The handler registered under `name` right now, or undefined. For a client that REPLACES a shared op
 *  and must still run the original — the editor's `player-prefs-write` adds its envelope refusal in
 *  front of this module's handler (#1551 review) rather than copying it. */
export function agentOpHandler(name: string): AgentOpHandler | undefined {
  return agentOps.get(name);
}

/** The currently-registered op names (testing / diagnostics). */
export function listAgentOps(): string[] {
  return [...agentOps.keys()];
}

/** Is `name` registered in THIS client right now? The membership half of `servesAgentOp`, which is
 *  what the relay asks since #1559 (it adds the op's `accepts` predicate).
 *
 *  Why the relay's decline test (#1030) is membership at all: deliberately a membership
 *  question rather than "did `runAgentOp` throw something that reads like `unknown agent op`":
 *  the string test would miscount an op that legitimately throws those words, and would have RUN
 *  the op before deciding. Exported (like `listAgentOps`) so the transport asks the registry
 *  through the same seam a test can. */
export function hasAgentOp(name: string): boolean {
  return agentOps.has(name);
}

/** The `modoki:response` payload this client owes for one relayed request (#1030).
 *
 *  Extracted from the `modoki:request` handler because that handler lives inside
 *  `initAgentBridge`, behind a live Vite `hot` — so the DECISION it makes had no test, which is
 *  the shape this repo's convention exists to stop ("a panel's decisions belong in a plain `.ts`
 *  module beside it"). It is also the half that makes #1030 work in production: the server's
 *  decline counting is inert if no client ever sends `declined`.
 *
 *  Three outcomes, and the distinction between the last two is the entire fix:
 *  - **declined** — this client has no handler for the op. NOT an answer; the server counts it and
 *    settles only once every client has said the same.
 *  - **error** — the op ran and threw. An ANSWER, from the one client that owns the op, and it
 *    must settle immediately rather than wait for anyone else.
 *  - **result** — the op ran and returned.
 *
 *  ⚠️ Membership is asked BEFORE dispatch, deliberately. Deciding by catching `/unknown agent op/`
 *  out of `run` would both miscount an op that legitimately throws those words and have already
 *  RUN the op before deciding whether it existed. */
export async function relayResponseFor(
  msg: { id: number; op: string; params?: unknown },
  has: (op: string, params: unknown) => boolean = servesAgentOp,
  run: (op: string, params: unknown) => Promise<unknown> = (op, params) => runAgentOp(op, params),
): Promise<{ id: number; result?: unknown; error?: string; declined?: boolean }> {
  if (!has(msg.op, msg.params)) return { id: msg.id, declined: true };
  // An `OpRefusal` comes back as a coded RESULT, not an `error` — through `opReplyFor`, which the
  // Electron IPC handler shares so the two transports cannot disagree about it (#1012).
  return { id: msg.id, ...(await opReplyFor(() => run(msg.op, msg.params))) };
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
/** The §5 refusal `render-scene` answers when no scene renderer is registered (#994).
 *
 *  Shape, not prose: `code` is what the MCP client reads back (`codeFromBody` in
 *  `tools/modoki-mcp/src/context.ts` lets a body-supplied code beat the one derived from the HTTP
 *  status) and what `test-live-tools.ts` classifies on — `NO_RENDERER` is already in its `ENV_CODES`,
 *  so this needs no harness change. `error` carries the WHY in the caller's terms; `options` is the
 *  field that turns a dead end into the next move.
 *
 *  ⚠️ WHAT THIS DELIBERATELY DOES NOT SAY. A first draft blamed an unselected Game TAB and told the
 *  reader to check `gameView.panelMounted`. Both were wrong, and measuring beat repeating: on this
 *  clone's editor (games/3d-test, 2026-09-09) `gameView.panelMounted` was **false** while
 *  `surfaces` listed `game-3d` and `/api/render-scene` returned a frame. `panelMounted` is
 *  `GameView.tsx`'s own mount flag — a different fact — so a refusal citing it would have sent the
 *  reader to a field that does not answer this question. That is the exact defect this issue is
 *  about, one layer up. (`modoki_render_scene`'s own tool description still carries the same claim;
 *  recorded on #994, not fixed here — the true mount story was not established.)
 *
 *  What IS established, by exhaustive grep: `Scene3D.tsx` is the repo's ONLY caller of
 *  `registerSceneRenderer`, and it registers the renderer and the `game-3d` bounds provider in one
 *  effect, dropping both through the same teardown scope. So `surfaces` containing `game-3d` is the
 *  observable for "a renderer is registered", and it is what the options point at. */
export const NO_RENDERER_REFUSAL = Object.freeze({
  ok: false as const,
  code: 'NO_RENDERER' as const,
  error:
    'no scene renderer is registered, so there is nothing to render offscreen and nothing was '
    + 'rendered. The runtime Scene3D layer is the only thing that registers one, and it is absent '
    + 'when the project is built without the 3D renderer module (build.modules.render3d:false) or '
    + 'sets disable3D, and before the app shell has mounted it. This is the editor\'s STATE — NOT a '
    + 'missing route, NOT a wedged editor, and NOT a reason to relaunch.',
  options: Object.freeze([
    'modoki_get_editor_state — `surfaces` lists `game-3d` exactly when a scene renderer is registered; if it is missing, this refusal is why',
    'if the 3D surface should be up but is not, modoki_diagnose and modoki_get_console_logs report a renderer that failed to come up',
    'read the scene as DATA instead — modoki_get_scene_state / modoki_diagnose need no renderer at all',
  ]),
  // FROZEN, and `options` frozen WITH it: one object is returned BY REFERENCE to every caller of
  // this op, so an accidental mutation anywhere would rewrite the refusal for every future call.
  // Nothing mutates it today (the router spreads rather than assigns) — freezing is what keeps that
  // true. ⚠️ `Object.freeze` is SHALLOW, so freezing the outer object alone left `options.push(…)`
  // and `options[0] = …` working and the claim above only half-kept.
});

// Deterministic offscreen frame → JPEG data URL. The backend decodes it to a temp
// file so the agent gets a path, not an inline image.
//
// The no-renderer case is a §5 REFUSAL, not a throw (#994). `renderSceneOffscreen` rejects with a
// plain Error, and every route that relays this op turns a throw into a hard-coded 504 → the MCP
// client's `NOT_AVAILABLE_HERE`, i.e. "could not look: the route is absent". That is the exact
// inversion §5 exists to prevent: the route is present, the renderer answered, and it said no —
// an ordinary editor state — a project built without the 3D renderer module, or a Game tab that has
// never been opened this session — was reported to the agent as a dead tool, and to
// `test:mcp:live` as a DEFECT.
// This generalises the lesson already applied to the game-tool op below (`game-tool-call`'s throwing-handler catch): a
// state refusal names its own code, because the op is the only layer that knows it.
registerAgentOp('render-scene', (params) => {
  if (!hasSceneRenderer()) return NO_RENDERER_REFUSAL;
  return renderSceneOffscreen((params ?? {}) as OffscreenRenderOpts);
});
// Summary-first at the OP, never in `dumpConsoleLogs` — `diagnose` (below) reads that
// producer directly for its error list, and a default tail there would silently drop errors
// from `modoki_diagnose` with no failing test. The shared ring holds 1000 entries in the editor
// (`installConsoleRing.ts`'s `capacity`, #596/#597 Stage 3a — was a private 500-entry buffer);
// a bare read returns the last 50 plus a per-level histogram of the whole window.
registerAgentOp('console-logs', (params) => {
  const p = (params ?? {}) as ConsoleLogsParams;
  // One reading per argument (#1559). The MCP schemas already bound these; the curl route and a
  // device op call do not, and a value this op cannot honour must refuse rather than filter wrongly.
  // RETURNED, not thrown: the device relay carries a returned `{ok:false, code}` through with its
  // code, and would flatten a thrown OpRefusal to REFUSED_BY_OP (opRefusal.ts's docblock).
  if (p.level !== undefined && !isConsoleLevel(p.level)) {
    return { ok: false as const, code: 'REFUSED_BY_OP' as const, error: `console-logs: level must be one of ${CONSOLE_LEVELS.join(', ')} (a threshold: that level or worse), got ${JSON.stringify(p.level)}.`, options: [...CONSOLE_LEVELS] };
  }
  if (p.since != null && p.sinceMs != null) {
    return { ok: false as const, code: 'AMBIGUOUS' as const, error: 'console-logs: pass since (a ring seq cursor, from nextSeq) OR sinceMs (an epoch-ms timestamp), not both — they select by different clocks.', options: ['since', 'sinceMs'] };
  }
  if (p.since != null && (!Number.isInteger(p.since) || p.since < 0)) {
    return { ok: false as const, code: 'REFUSED_BY_OP' as const, error: `console-logs: since is a ring seq cursor (a non-negative integer — pass back a reply's nextSeq), got ${p.since}.` };
  }
  if (p.since != null && p.since >= CONSOLE_SEQ_CEILING) {
    return { ok: false as const, code: 'REFUSED_BY_OP' as const, error: `console-logs: since=${p.since} is a timestamp, but since is a ring SEQ cursor — pass back a reply's nextSeq. For "logged after this instant", use sinceMs=${p.since}.`, options: ['sinceMs'] };
  }
  // The mirror image: a seq passed as `sinceMs` reads as an instant in 1970, so it would match the whole ring.
  if (p.sinceMs != null && p.sinceMs < CONSOLE_SEQ_CEILING) {
    return { ok: false as const, code: 'REFUSED_BY_OP' as const, error: `console-logs: sinceMs=${p.sinceMs} is a ring seq, not an epoch-ms timestamp — for a cursor use since=${p.sinceMs}.`, options: ['since'] };
  }
  // An empty epoch is ABSENT: the editor's route and tool drop `''`, and the device tool must not turn
  // it into a reset on every call.
  const callerEpoch = p.epoch === '' ? undefined : p.epoch;
  if (callerEpoch !== undefined && typeof callerEpoch !== 'string') {
    return { ok: false as const, code: 'REFUSED_BY_OP' as const, error: `console-logs: epoch is the string a previous reply returned, got ${JSON.stringify(callerEpoch)}.` };
  }
  // The ring's IDENTITY for this page load (#1559 review). `seq` restarts at 1 on a reload, so a
  // cursor's VALUE cannot tell "the ring restarted" from "nothing new" once the new ring has logged
  // past it — which is exactly the case that matters: a game-code edit reloads the page, its boot
  // logs past the old cursor, and a value check drops the boot error it caused. `timeOrigin` differs
  // per page load; the ring's generation covers a reset within one (tests). Same contract as
  // editor_journal's `epoch`: send it back with `since`, and a mismatch replays from the start.
  const epoch = `${Math.round(performance.timeOrigin).toString(36)}-${getConsoleRingEpoch()}`;
  const whole = dumpConsoleLogs({}).logs;
  const newestSeq = whole.reduce((m, e) => Math.max(m, e.seq), 0);
  const cursorReset = p.since == null ? undefined
    : callerEpoch !== undefined && callerEpoch !== epoch
      ? `since=${p.since} was issued under epoch ${callerEpoch}; the console ring has restarted since (epoch ${epoch} — a reload, e.g. a game-code edit), so this read starts from the beginning. Use the returned cursor from now on.`
      // Without `epoch`, a cursor past the newest seq is the only restart that can still be seen.
      : p.since > newestSeq
        ? `since=${p.since} is past the newest seq this ring has issued (${newestSeq}), so it is from before a restart (a reload); this read starts from the beginning.` +
          (callerEpoch === undefined ? ' Send `epoch` back with `since` so a restart is always detected.' : '')
        : undefined;
  const since = cursorReset ? 0 : p.since;
  const { logs } = dumpConsoleLogs({ level: p.level, since, sinceMs: p.sinceMs });
  // A CURSORED read pages OLDEST-first (#1559 review), as editor_journal's `since` does: a tail would
  // hand back the newest 50 of an error storm and a `nextSeq` past the rest, so the first error — the
  // cause — could never be reached again. An uncursored read stays a tail: "what happened lately".
  const cursored = since != null;
  const page = cursored
    ? { ...takeHead(logs, p.limit, CONSOLE_TAIL_DEFAULT), total: logs.length }
    : tailWithCounts(logs, (e) => e.level, { limit: p.limit, defaultLimit: CONSOLE_TAIL_DEFAULT });
  // S3.8 — `byLevel`/`ringTotal` describe the WHOLE ring, `total` describes what MATCHED the
  // filter. The histogram used to be built over the already-filtered array, so `level:'warn'`
  // answered `byLevel:{warn:N}` — an agent using it to decide "are there errors?" concluded no
  // from a filtered read. Same three-number contract as modoki_journal (count/total/ringTotal),
  // because two tools answering the same question must answer it the same way (§8).
  const byLevel = histogram(whole, (e) => e.level);
  // The cursor for the NEXT read. A truncated cursored page continues right after its last row. Any
  // other read has seen everything that matched, so it moves to the newest seq in the WHOLE ring — a
  // `level:'error'` poll then does not re-read the warnings it filtered out.
  const nextSeq = cursored && page.truncated ? (page.items.at(-1)?.seq ?? since) : newestSeq;
  return {
    logs: page.items,
    nextSeq,
    epoch,
    ...(cursorReset ? { cursorReset } : {}),
    // §2 (#1217, #1223 D3, #1266): `returnedCount` is the rows here, `totalCount` everything the
    // filter matched before the tail. `ringTotal` is a THIRD population — the whole ring, filter
    // ignored — so it keeps its own name rather than being folded into either.
    returnedCount: page.items.length,
    totalCount: page.total,
    ringTotal: whole.length,
    byLevel,
    // The ring is `[pinned boot prefix] ++ [rolling tail]` — once it wraps, that is DISCONTIGUOUS,
    // and `logs`/`ring` above concatenate the two halves with nothing marking the seam. `dropped`
    // is how many tail entries were evicted between them; non-zero means an agent reading `logs`
    // is looking at boot plus a recent window with a real gap in between, not a continuous log. See
    // `getConsoleRingDropped`'s own doc comment (consoleRing.ts).
    dropped: getConsoleRingDropped(),
    ...(page.truncated ? {
      truncated: true,
      hint: cursored
        ? `Showing the OLDEST ${page.items.length} of ${page.total} entries after since=${since} (oldest first). Continue with since=${nextSeq} and this epoch, or raise limit=N.`
        : tailHint('console entries', page.items.length, page.total, ', or narrow with level=/since='),
    } : {}),
  };
});

// ── Phase A: semantic verification (event journal + action dispatch) ──
// Read the tick-stamped game-event trace — the screenshot-free way to verify game
// LOGIC (assert on match/score/win). Journaling is on by default, but force-enable
// in case a shipped game turned it off, so the agent always sees events.
/** The capture-control verbs `journal-events` accepts — a table so an unknown one is refused with the
 *  real options (#1072) rather than falling through to a plain read. */
const JOURNAL_CAPTURE_ACTIONS = ['start', 'stop'] as const;
const isJournalCaptureAction = (a: unknown): a is typeof JOURNAL_CAPTURE_ACTIONS[number] =>
  (JOURNAL_CAPTURE_ACTIONS as readonly unknown[]).includes(a);

registerAgentOp('journal-events', (params) => {
  const p = (params ?? {}) as { type?: string; level?: unknown; clear?: unknown; limit?: number; action?: unknown; sinceCap?: unknown; epoch?: unknown };
  setJournalEnabled(true);
  // ⚠️ `clear` is RETIRED, and refused rather than ignored (#1561). It made a READ destroy the ring
  // it read — the evidence the next verification read depends on (mcp-tool-conventions.md §7) — and
  // its one real use was a clean baseline, which `sinceCap` now gives without deleting anything.
  // Ignoring it would be worse than the old behaviour: a caller that meant "start clean" would read
  // a full ring believing it empty. The MCP tools' strict schemas refuse it first; this catches the
  // dev-server curl API and in-process callers.
  if (p.clear !== undefined) {
    return {
      ok: false, code: 'UNKNOWN_PARAM',
      error: 'clear was removed — a journal read no longer deletes anything. For a clean baseline, '
        + 'read once (limit:0 is enough) and pass the returned nextCap as sinceCap (with its epoch): '
        + 'that read returns only the events after it. Nothing was read and nothing was cleared.',
      options: ['sinceCap', 'epoch'],
    };
  }
  if (p.sinceCap !== undefined && (typeof p.sinceCap !== 'number' || !Number.isFinite(p.sinceCap) || p.sinceCap < 0)) {
    return {
      ok: false, code: 'REFUSED_BY_OP',
      error: `sinceCap must be a non-negative number (a nextCap from an earlier read), got ${JSON.stringify(p.sinceCap)} — nothing was read.`,
    };
  }
  // ⚠️ These two vocabulary refusals carry a §5 CODE and `options`, and that is load-bearing, not
  // decoration (#1072). This op answers a GET relay: `relayJson` sends a coded envelope as a 400, and
  // the MCP client fails any status ≥400 — but a plain read's 200 body is NOT checked for `ok:false`
  // (`getJson`'s `checkFailure` is off for reads, because diagnose/validate return `ok:false` as their
  // ANSWER). So an uncoded `{ok:false, reason}` here reached the agent as a SUCCESSFUL read. The route
  // forwards the raw value precisely so these can fire; it used to drop an unknown one first.
  if (p.action !== undefined && !isJournalCaptureAction(p.action)) {
    return {
      ok: false, code: 'REFUSED_BY_OP',
      error: `unknown action ${JSON.stringify(p.action)} — nothing was started, stopped or read. Omit action to just read.`,
      options: [...JOURNAL_CAPTURE_ACTIONS], captures: verboseCaptureState(),
    };
  }
  // Tier-2 capture control: `action:start|stop` with `type` names the watch-gated diagnostic
  // (e.g. @contact) to begin/end capturing. Off by default so the journal stays lean; a Tier-2
  // type emits NOTHING until started, and only from the start point forward (no back-history).
  if (p.action !== undefined) {
    const t = p.type;
    if (!t) return { ok: false, reason: 'action needs type= naming the diagnostic to capture (e.g. @contact)', captures: verboseCaptureState() };
    if (!isVerboseType(t)) return { ok: false, reason: `"${t}" is always-on, not watch-gated — nothing to start/stop. Watch-gated types: ${verboseCaptureState().types.join(', ') || '(none)'}.`, captures: verboseCaptureState() };
    setVerboseCapture(t, p.action === 'start');
    return { ok: true, action: p.action, type: t, captures: verboseCaptureState() };
  }
  // ⚠️ REFUSE an unknown level rather than silently returning the whole ring (#993 close-out
  // § 2d). `filtered` below would still report the reply as filtered — so `level:"wran"` answered
  // with every event of every level, which an agent reads as "there really were N warn+ events".
  // Both MCP tools enum-validate `level`, so what reaches this is the dev-server curl API and an
  // in-process call; it was unreachable from curl too until #1072 stopped the route dropping it.
  if (p.level !== undefined && (typeof p.level !== 'string' || !isJournalLevel(p.level))) {
    return {
      ok: false, code: 'REFUSED_BY_OP',
      error: `unknown level ${JSON.stringify(p.level)} — nothing was read. `
        + 'A level filter means that severity AND ABOVE.',
      options: [...JOURNAL_LEVELS],
    };
  }
  const level = p.level as JournalLevel | undefined;
  const filtered = !!(p.type || level);
  // The cursor WINDOWS the ring: with `sinceCap`, "the ring" is every event after it, exactly as if
  // the caller had cleared at that point — which is the job `clear` used to do, destructively (#1561).
  // The filters then narrow the returned rows inside that window. A cursor from an earlier life of the
  // capture counter (a reload) is reset and said so, rather than filtering every new event out.
  const cursor = resolveCapCursor(p.sinceCap as number | undefined, typeof p.epoch === 'string' ? p.epoch : undefined);
  const sinceCap = cursor.sinceCap;
  const cursored = sinceCap != null;
  const inWindow = (e: { cap: number }) => !cursored || e.cap > sinceCap;
  const all = journalEvents().filter(inWindow);
  const events = filtered ? journalEvents({ type: p.type, level }).filter(inWindow) : all;
  // Tail at the op. `journalEvents()` stays whole for JournalTab, which slices its own view.
  // A busy physics Play session fills the 10,000-event ring with ~226-byte `@contact` events
  // — ~582k tokens if returned entire.
  // A CURSORED read takes the OLDEST events after the cursor (C7: a tail would drop the block
  // between the cursor and the tail for good); a bare read keeps the newest tail.
  const r = (cursored ? headWithCounts : tailWithCounts)(events, (e) => String((e as { type?: string }).type ?? '?'), { limit: p.limit, defaultLimit: JOURNAL_TAIL_DEFAULT });
  // `byType`/`ringTotal` describe the WHOLE RING (after `sinceCap`, when cursored), which is what the tool description and
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
  // Where the NEXT read should start. A cursored read cut short continues from its last returned
  // event (contiguous, no gap); anything else has seen everything up to the counter's tip, so the
  // next read starts there — which is what makes a bare `limit:0` read a baseline.
  const lastCap = (r.items[r.items.length - 1] as { cap?: number } | undefined)?.cap;
  // (A cut-short read that returned nothing — limit:0 — read nothing, so it stays where it was.)
  const nextCap = cursored && r.truncated ? (lastCap ?? sinceCap) : currentCaptureSeq();
  // Events after the cursor that the ring has LOST (evicted past its cap, or cleared) — said out loud,
  // because nothing in the returned caps can show it (#1561 review).
  const dropped = journalDroppedThroughCap();
  const gap = cursored && sinceCap! < dropped
    ? { droppedThroughCap: dropped, gapNote: journalGapNote(sinceCap!, dropped) }
    : undefined;
  return {
    // §2 (#1217, #1223 D3, #1266): `returnedCount`/`totalCount` everywhere; `ringTotal` below is a
    // THIRD population (the whole ring, filter ignored) and keeps its own name.
    returnedCount: r.items.length,
    /** Events MATCHING the filter (the whole ring when unfiltered). */
    totalCount: r.total,
    /** Every event in the ring, and the histogram over ALL of them — unchanged by a filter, so
     *  a filtered read still shows what else is in there. */
    ringTotal: ring.total,
    byType: ring.byType,
    nextCap,
    epoch: captureEpoch(),
    ...(gap ?? {}),
    ...(cursor.cursorReset ? { cursorReset: cursor.cursorReset } : {}),
    ...(filtered ? { filter: { ...(p.type ? { type: p.type } : {}), ...(p.level ? { level: p.level } : {}) } } : {}),
    events: r.items,
    captures,
    ...(idle.length ? { captureHint: `${idle.join(', ')} ${idle.length > 1 ? 'are' : 'is'} watch-gated and NOT capturing — start with action:'start', type:'${idle[0]}' before the moment you want to trace.` } : {}),
    ...(r.truncated ? {
      truncated: true,
      hint: cursored
        ? `Showing the OLDEST ${r.items.length} of ${r.total} events after sinceCap=${sinceCap} (oldest first). Read again with sinceCap=${nextCap} to continue ${gap ? 'from here (see gapNote: earlier events were already lost)' : 'with no gap'}; raise limit=N for more per read.`
        : tailHint('events', r.items.length, r.total, ', or narrow with type='),
    } : {}),
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
  // A runtime guid (#1210) whose entity a save has since re-minted is not in the list under that
  // string, but findEntityByGuid still names it — the @spawn journal refs carry exactly those.
  for (const g of wantGuid) {
    // Runtime guids only: a DURABLE guid the pass above did not match is not live under any string,
    // and asking findEntityByGuid would rebuild the whole guid index once per despawned ref.
    if (liveGuid.has(g) || !isRuntimeGuid(g)) continue;
    const e = findEntityByGuid(g);
    if (e && e.has(EntityAttributes)) liveGuid.set(g, ((e.get(EntityAttributes) as { name?: string }).name) ?? '');
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
// ── wait-for (#1154, #1559 C-12) ── park until a CONDITION holds instead of sleeping a guessed number
// of ms. The decisions live in `waitFor.ts`; these are its RUNTIME readers — `entity` (the scene-state
// resolver) and `console` (the shared ring) — registered here so the device has the op too (§9: an op
// that needs only `runtime/` registers where both surfaces get it). The editor re-registers `wait-for`
// with these plus `chrome`/`editor`; on a device those two kinds are refused by name.
export const runtimeWaitReaders: WaitReaders = {
  whereError,
  entities: ({ guid, name, where }) => {
    // `trait` narrows the one returned row to the trait the predicate reads, keeping the
    // observation small; `limit:1` because the wait needs a count and one example, not a dump.
    const trait = where ? /^\s*(\w+)\./.exec(where)?.[1] : undefined;
    const r = dumpSceneState({ guid, name, where, ...(trait ? { trait } : {}), limit: 1 }) as { entities: unknown[]; totalCount: number };
    return { count: r.totalCount, first: r.entities[0] };
  },
  consoleSince: (seq) => getConsoleRingEntries(seq),
  consoleWatermark: (lookbackMs) => {
    const all = getConsoleRingEntries();
    if (!lookbackMs) return all.at(-1)?.seq ?? 0;
    // `mono` is the ring's own `rawNow()` stamp, so the cutoff is on the same clock.
    const cutoff = rawNow() - lookbackMs;
    let mark = 0;
    for (const e of all) { if (e.mono < cutoff) mark = e.seq; else break; }
    return mark;
  },
  entityNames: () => getAllEntities().map((e) => e.name ?? '').filter(Boolean),
};

/** Run one `wait-for` call against `readers`. An unevaluable condition is RETURNED as a coded refusal,
 *  not thrown: the device relay keeps a returned `{ok:false, code}`'s code (opRefusal.ts's docblock). */
export function runWaitFor(params: unknown, readers: WaitReaders) {
  const { timeoutMs, ...cond } = (params ?? {}) as WaitCondition & { timeoutMs?: unknown };
  const why = surfaceError(cond, readers) ?? conditionError(cond, readers);
  if (why) return { ok: false as const, code: 'REFUSED_BY_OP' as const, error: `wait-for: ${why} — nothing was waited for.` };
  return waitForCondition(cond, { readers, timeoutMs: clampWaitTimeout(timeoutMs) });
}
// It ACCEPTS only what it can answer: on the HMR relay a `chrome`/`editor` wait from a page with no editor
// is DECLINED, so the editor's own registration (which accepts everything) takes it. The device relay
// runs the op directly, so there the refusal above is what the agent sees.
registerAgentOp('wait-for', (params) => runWaitFor(params, runtimeWaitReaders), {
  accepts: (params) => surfaceError(params, runtimeWaitReaders) === null,
});

// Discover what an agent can dispatch/read: action names + their param schemas,
// and the live named read-values (e.g. canGoBack, timeSinceGameStart).
//
// Summary-first (§6, #1557): a BARE call answers the action NAMES only. Every row used to carry its
// param schema, `null` for nearly all of them, so the list cost a median 5.7k chars per call to answer
// "what can I dispatch?". `name=<substr>` (case-insensitive CONTAINS, as scene-state's `name`) buys
// the detail rows, `{name, params}`, for the matches.
registerAgentOp('game-introspect', (params) => {
  const { name } = (params ?? {}) as { name?: unknown };
  const all = getUIActionNames();
  const readValues = getReadSourceNames().map((n) => ({ name: n, value: getReadValue(n) }));
  if (typeof name !== 'string' || name === '') {
    return {
      actionCount: all.length,
      actions: all,
      readValues,
      hint: 'Action NAMES only. name=<substr> returns the matching actions with their param schemas.',
    };
  }
  const q = name.toLowerCase();
  const hits = all.filter((n) => n.toLowerCase().includes(q));
  return {
    returnedCount: hits.length,
    totalCount: hits.length,
    actions: hits.map((n) => ({ name: n, params: getUIActionParams(n) ?? null })),
    readValues,
    ...(hits.length === 0 ? {
      hint: emptyFilterHint({ what: 'action', filter: describeFilter({ name }), unfilteredCount: all.length, live: { name: all }, near: { name } }),
    } : {}),
  };
});

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
// `ok:false` + a `code` + a `reason` + the `options` — so both MCP servers surface it as a failed
// call carrying THAT code (`codeFromBody`), not a blanket REFUSED_BY_OP (#1561).
registerAgentOp('game-tool-call', async (params) => {
  const p = (params ?? {}) as { name?: string; args?: Record<string, unknown> };
  const known = () => listAgentTools().map((t: AgentToolDef) => t.name);
  if (!p.name) return { ok: false, code: 'REFUSED_BY_OP', reason: 'missing tool name', options: known() };
  const tool = getAgentTool(p.name);
  if (!tool) {
    // Name the alternatives. An unknown name is nearly always a stale tool list (the project was
    // switched, or the game unregistered on a hot-reload), and the recovery is to look at what IS
    // registered — so answer that question in the same call instead of making the agent ask it.
    const options = known();
    return {
      ok: false, code: 'NOT_FOUND',
      reason: options.length
        ? `unknown game tool '${p.name}'`
        : `unknown game tool '${p.name}' — this project registers no agent tools (or the debug menu is disabled, which suppresses them)`,
      options,
    };
  }
  // String-encoded numbers/booleans are decoded against the declaration first (#1560).
  const args = coerceAgentToolArgs(tool, p.args ?? {});
  // Enforce the DECLARATION here, so every caller inherits it — the curl API, device_eval's
  // modoki.call, and the device relays all land on this op, and only the editor MCP rebuilds a
  // zod schema of its own. A declaration honoured by one caller in four is not a contract.
  const invalid = validateAgentToolArgs(tool, args);
  if (invalid) {
    const declared = Object.keys(tool.params ?? {});
    // An undeclared key is §1's UNKNOWN_PARAM, as it is for every engine tool; a declared key with a
    // bad value is the op declining the call. Own-key check, never `in` (the #986 prototype trap).
    const undeclared = Object.keys(args).some((k) => !Object.prototype.hasOwnProperty.call(tool.params ?? {}, k));
    return { ok: false, code: undeclared ? 'UNKNOWN_PARAM' : 'REFUSED_BY_OP', reason: invalid, params: declared, options: declared };
  }
  let result: unknown;
  try {
    result = await tool.handler(args);
  } catch (e) {
    // A throwing handler is the game's bug, but it must not present as a transport failure: a 504
    // reads as "the editor is gone" and sends the agent diagnosing the wrong layer entirely.
    return { ok: false, code: 'REFUSED_BY_OP', reason: `game tool '${p.name}' threw: ${e instanceof Error ? e.message : String(e)}` };
  }
  return checkGameToolCode(p.name, result);
});

/** A game handler's refusal `code` must be one of §5's closed set. One outside it used to be
 *  dropped SILENTLY — `codeFromBody` falls back to REFUSED_BY_OP on both servers — so a game that
 *  wrote `code:'INVALID'` believed its callers could branch on it while every caller saw the
 *  generic code. Say so in the reply instead, where the game's own author reads it (#1561). */
function checkGameToolCode(name: string, result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const r = result as { ok?: unknown; code?: unknown; reason?: unknown };
  // Only a REFUSAL's code is §5's: a successful reply may carry a `code` of its own (a key code, a
  // locale, a promo code) and is passed through untouched like every other answer. "A refusal" is
  // whatever the SERVERS will fail the call for — `isFailureBody`, the one predicate, so a body
  // failing on `error`/`errors` without `ok:false` is covered too (#1561 re-review). Then
  // `codeFromBody` hands back the body's code only when it is in the set — the one membership test.
  if (r.code === undefined || isFailureBody(r) === null || codeFromBody(r, 'REFUSED_BY_OP') === r.code) return result;
  const note = `game tool '${name}' returned code ${JSON.stringify(r.code)}, which is not a §5 error code (${ERROR_CODES.join(', ')}) — sent as REFUSED_BY_OP.`;
  return { ...r, code: 'REFUSED_BY_OP', reason: typeof r.reason === 'string' ? `${r.reason} (${note})` : note };
}
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
  // #1406 — a player can only reach a control-bound action through its control, so an agent may not
  // reach it with that control off screen either (owner ruling on #1406: the ENGINE refuses, not each
  // game). Checked here and not in `dispatchUIAction`: a real press (`applyBindings`) has a mounted
  // control by construction, and the debug menu and headless tests have no screen to ask about. An
  // action no control carries opts out with `noControl` at registration (every engine built-in does).
  if (!isControlLessAction(p.name)) {
    const world = getCurrentWorld();
    const seen = actionControlOnScreen(world, p.name);
    if (!seen.onScreen) {
      return {
        ok: false, dispatched: false, gate: 'no-control-on-screen', carriers: seen.carriers, simRunning: true,
        reason: seen.carriers.length > 0
          ? `no control that triggers '${p.name}' is on screen (${seen.carriers.slice(0, 5).join(', ')}${seen.carriers.length > 5 ? ` and ${seen.carriers.length - 5} more` : ''} ${seen.carriers.length === 1 ? 'is' : 'are'} hidden), so a player could not press it — open the screen that shows it first`
          : `no UI control in the current world triggers '${p.name}', so a player could not press it — open the screen that shows it first. If a timeline, a zone, a collision or code fires it instead, register it with \`noControl: true\``,
      };
    }
    // #1418 — shown is not reachable: a HUD button under a full-screen modal is drawn, and a
    // player's tap lands on the modal. Hit-test each shown carrier the way a tap would; refuse only
    // when EVERY one is positively covered (anything the DOM cannot judge fails open — see
    // carrierCover.ts).
    const covers = coveredCarriers(world, seen.shown);
    if (covers) {
      const list = covers.slice(0, 5).map((c) => `${c.carrier} under ${c.coveredBy}`).join(', ');
      return {
        ok: false, dispatched: false, gate: 'control-covered', carriers: covers.map((c) => c.carrier),
        coveredBy: [...new Set(covers.map((c) => c.coveredBy))], simRunning: true,
        reason: `every control that triggers '${p.name}' is covered (${list}${covers.length > 5 ? ` and ${covers.length - 5} more` : ''}), so a player's tap would land on the cover instead — close it first`,
      };
    }
  }
  // Resolve targetGuid HERE so a phantom guid is reported, not obeyed. dispatchUIAction
  // scans for it and, finding nothing, calls the handler with target:undefined — the handler
  // console.warns and returns, and this op used to answer {dispatched:true}. The agent then
  // read back, saw no change, and had no way to tell "guid didn't resolve" from "the handler
  // ignored me" from "the clip name was wrong". Stale guids are routine (any hot-reload or
  // play→stop rebuilds the world). (C7)
  // Through the shared resolver (#1223), so a stale runtime guid says which kind of stale it is.
  const target = p.targetGuid ? resolveEntityAddress({ guid: p.targetGuid }, { label: 'targetGuid', accept: ['guid'] }) : null;
  if (target && !target.ok) {
    return { ok: false, dispatched: false, code: 'NOT_FOUND', ...(target.stale ? { stale: target.stale } : {}), reason: `targetGuid '${p.targetGuid}' matched no entity in the live world — it may be stale (ids/entities are rebuilt on scene reload and play→stop). Re-read it with get_scene_state.`, simRunning: true };
  }
  // The HANDLER decides whether it acted, and says so by returning a refusal (#1129). This op used to
  // re-derive that answer for two actions with hand-written pre-flights (engine.playClip's animator and
  // clip-name checks, engine.director's trait and slaved-child checks) and answered `dispatched:true`
  // for every other refusal — nine conditions across four actions, plus every silent audio/video/
  // haptics/quality refusal. The copies also drifted: the playClip one refused a typo'd SKELETAL clip
  // that the handler, and so every authored button, wrote anyway. Reading the return value leaves the
  // preconditions in exactly one place. `detail` (e.g. `known` clips, `slavedTo`) is spread FIRST so it
  // can never overwrite the verdict fields.
  const result = dispatchUIAction(p.name, { payload: p.payload, params: p.params, targetGuid: p.targetGuid });
  if (isActionRefusal(result)) {
    return { ...result.detail, ok: false, dispatched: false, reason: result.reason, simRunning: true };
  }
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
// SHARES the Assets-panel button path's table rather than mirroring it (#1366): this used to be a
// second hand-written copy, kept in step by a comment in each, and they drifted — `model` mapped to
// `invalidateModel` alone in both, so the rigged prototype was never evicted and a re-imported
// SKINNED GLB kept its pre-import skeleton and clips. `invalidateModelAndRig` is now the `model`
// row for every entry point; see `runtime/loaders/reimportInvalidation.ts`.
//
// This is where the runtime table is pinned against the MCP surface's own
// `INVALIDATABLE_ASSET_TYPES` tuple (tools/shared/invalidateAssets.ts, which
// `device_invalidate_assets` derives its enum from — #1216 C-13). Both directions are pinned, and
// they need DIFFERENT mechanisms:
//
//   `satisfies`  — every MCP kind has a row here (a MISSING row fails).
//   `_KindPin`   — every row here is an MCP kind (an EXTRA row fails).
//
// ⚠️ **`satisfies` alone does NOT give the second direction, though it did before #1366.** Excess-
// property checking applies only to a FRESH OBJECT LITERAL; this used to be one, and is now a
// reference to the shared table, so the extra-key check silently evaporated. Measured during that
// change's close-out review: adding a `video` kind to `REIMPORT_INVALIDATORS` without touching the
// MCP tuple produced ZERO diagnostics from the root typecheck, where the old literal form errored
// TS2353. The drift that would ship is a kind the shared table accepts and
// `device_invalidate_assets`'s enum rejects at runtime — exactly what #1216 C-13 put a pin here for.
type _KindPin = ReimportableAssetKind extends InvalidatableAssetType ? true : never;
const _kindPin: _KindPin = true; void _kindPin;
const INVALIDATORS = REIMPORT_INVALIDATORS satisfies Record<InvalidatableAssetType, (path: string) => void>;
const isInvalidatableAssetType = (t: unknown): t is InvalidatableAssetType =>
  typeof t === 'string' && (INVALIDATABLE_ASSET_TYPES as readonly string[]).includes(t);

registerAgentOp('invalidate-assets', (params) => {
  const p = (params ?? {}) as { items?: Array<{ path?: string; type?: string }> };
  // THE list of cache-holding kinds for the server-driven path — the /api/reimport route forwards
  // every baked type and lets this decide (#304 close-out). A type with no row is ignored on purpose:
  // `font` refreshes through the manifest-hash channel, and atlas/video hold no engine-side cache. Keep
  // in step with assetViews/reimport.ts, which is the same decision for the client-side path. Typed
  // against the shared tuple `device_invalidate_assets` derives its enum from (#1216 C-13).
  const counts: Record<InvalidatableAssetType, number> = { model: 0, texture: 0, audio: 0, environment: 0 };
  for (const it of p.items ?? []) {
    if (!it?.path || !isInvalidatableAssetType(it.type)) continue;
    INVALIDATORS[it.type](it.path);
    counts[it.type]++;
  }
  return { ok: true, models: counts.model, textures: counts.texture, audio: counts.audio, environments: counts.environment };
});

// ── Phase B: numeric screen-space layout/bounds (turn "is it laid out right?" into data) ──
registerAgentOp('layout-bounds', (params) => {
  // Same reasoning as scene-state. `diagnose` reads `computeLayoutBounds().offScreen` (guids)
  // from the PRODUCER, so it is unaffected either way — but keep the rounding here regardless.
  const p = (params ?? {}) as LayoutBoundsParams & { precision?: number };
  const result = roundFloats(computeLayoutBounds(p), resolvePrecision(p.precision)) as Record<string, unknown>;
  // #682: every rect here is FRAME-FED (a registered bounds provider runs at render time).
  const w = frameStalenessWarning('layout bounds');
  return w ? { ...result, warnings: [w] } : result;
});

// ── Enact Phase 2: numeric handle geometry — WHERE the draggable handles are in the
// Canvas2D/SVG authoring editors, so `drag-handle`/`tap-handle` can aim without pixels. ──
registerAgentOp('enact-handles', (params) => {
  const result = computeHandles((params ?? {}) as HandlesDumpParams) as unknown as Record<string, unknown>;
  // #682 close-out (LOW 6): the same frame-fed projection as `layout-bounds` — a Canvas2D
  // provider's handle geometry is only as fresh as the last frame it actually ran on.
  const w = frameStalenessWarning('enact handles');
  return w ? { ...result, warnings: [w] } : result;
});

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
registerAgentOp('resolve-dom-point', (params) => {
  const result = resolveDomPointReport((params ?? {}) as DomPointSpec) as unknown as Record<string, unknown>;
  // #682 close-out (LOW 6): this is one of the values the TRUSTED CDP/WDA routes aim from
  // (`resolveAimViaDevice` → `resolve-aim` → here for a selector aim) — the same frame-fed
  // projection as `layout-bounds`/`hit-regions`, so it gets the same staleness note.
  const w = frameStalenessWarning('resolve dom point');
  return w ? { ...result, warnings: [w] } : result;
});
// #261 — consulted ONLY when an aim is about to be refused, to tell a transient (the dock is
// mid-move) from a real one. Registered here rather than in agentEditorOps.ts because it needs
// nothing from `editor/`: §9's rule is that an op reaching only the DOM belongs where BOTH
// surfaces can get it.
registerAgentOp('layout-settling', () => layoutSettleReport());

// ── Entity-aware input: the same idea one layer in — resolve {guid}/{name}/{id} to the
// entity's LIVE screen rect so a viewport tap never has to be aimed from coordinates read in
// an earlier round-trip. Renderer-side because only the renderer holds the camera, the
// PixiJS bounds, and the DOM. ──
/** Resolve ONE entity address — `{guid}` | `{name}` | `{id}` — with the shared resolver and nothing
 *  else (#1223). For a HOST route that must name its target before it acts and has no world of its
 *  own to look in: `capture_gesture`'s sample. It replaced a `scene-state` probe filtering
 *  `EntityAttributes.guid=<g>` by string, which missed a runtime guid a save had since re-minted and
 *  let a guid beside an id silently win. */
registerAgentOp('resolve-entity', (params) => {
  const r = resolveEntityAddress((params ?? {}) as EntityAddress, { label: 'entity' });
  return r.ok ? { ok: true, id: r.id, guid: r.guid, name: r.name } : r;
});

registerAgentOp('resolve-entity-point', (params) => {
  const result = resolveEntityPointReport((params ?? {}) as EntityPointSpec) as unknown as Record<string, unknown>;
  // #682 close-out (LOW 6): a 2D/3D entity's rect comes from the same registered bounds
  // providers `layout-bounds` reads (`collectScreenBounds`) — frame-fed, and one of the values
  // the TRUSTED routes aim from — so it gets the same staleness note.
  const w = frameStalenessWarning('resolve entity point');
  return w ? { ...result, warnings: [w] } : result;
});

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
//
// `frameLoop` (#682 close-out, HIGH 1): reused by `editorBackendRouter.ts`'s device-input
// dispatch as the ONE round trip every CDP-routable method (tap/drag/press-key/hover/scroll)
// makes before a transport is chosen — `handleResolveAim` alone cannot cover `press-key`, which
// has no coordinates to resolve and so never round-trips through the page at all. Reported here,
// not refused: this op only answers "can input be delivered right now", it dispatches nothing
// itself, so a stalled loop is a FACT for the caller to act on rather than something for this op
// to refuse.
registerAgentOp('input-deliverability', () => {
  const h = getFrameLoopHealth();
  return {
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    frameLoop: { status: h.status, unrecoverable: h.unrecoverable, detail: h.detail, msSinceLastFrame: h.msSinceLastFrame },
  };
});

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
  // It needed a surface at all because the accessor alone was not reachable. `modoki_eval` runs in
  // the renderer and could import `pipeline.ts` through `/@fs` — but that yields a SECOND module
  // instance whose slot is null, so it would report "no cache" for a perfectly live one.
  // (`modoki.import` has reached the app's instance since #1155; this filter stays the typed read.) Before
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
      // §2 (#1266): the cache is listed whole — no filter, no limit — so the two agree, and both
      // are emitted rather than leaving an absent total that reads as "not reported".
      returnedCount: entries.length,
      totalCount: entries.length,
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
/** The profiler's two `limit` ceilings — capture-read's worst frames and boot's rows per section.
 *  The MCP schemas publish the larger and the op refuses capture-read above the smaller (#1560);
 *  `numericRangeInSchema.test.ts` holds both servers' copies to these. */
export const PROFILER_CAPTURE_READ_MAX = 20;
export const PROFILER_BOOT_MAX = 200;
registerAgentOp('profiler', (raw: unknown) => {
  const params = (raw ?? {}) as Record<string, unknown>;
  const action = params.action ?? 'read';
  // An unknown action is REFUSED, not served as a read (#1213 B-6): `default: read` answered
  // `capture-strat` with a live aggregate, so the caller believed a capture had started. The MCP
  // enum hid it from tool calls; a POST, an eval and a device relay all reached it. Coded, because
  // this op answers a GET relay too (an uncoded `ok:false` there reads as success).
  if (!isProfilerAction(action)) {
    return {
      ok: false, code: 'REFUSED_BY_OP',
      error: `profiler: unknown action ${JSON.stringify(params.action)} — nothing was read, started or reset.`,
      options: [...PROFILER_ACTIONS],
    };
  }
  // A count that is not a number used to reach `Math.max(1, NaN)` — which is NaN, so `slice(0, NaN)`
  // returned nothing and the read looked empty. The GET route strips such values; a POST, an eval and
  // a device relay did not.
  for (const k of ['limit', 'markers'] as const) {
    if (params[k] !== undefined && (typeof params[k] !== 'number' || !Number.isFinite(params[k]))) {
      return { ok: false, code: 'REFUSED_BY_OP', error: `profiler: ${k} must be a finite number — got ${JSON.stringify(params[k])}. Nothing was read.` };
    }
  }
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
      // The schema caps `limit` at boot's 200; a capture-read over ITS 20 is refused here rather than
      // clamped (§5, #1560) — a silent 20-of-50 reads as "only 20 frames were captured".
      if (params.limit != null && Number(params.limit) > PROFILER_CAPTURE_READ_MAX) {
        throw new OpRefusal('REFUSED_BY_OP', `profiler capture-read: limit ${params.limit} is over the max of ${PROFILER_CAPTURE_READ_MAX} worst frames. Nothing was read.`, { options: [`limit:${PROFILER_CAPTURE_READ_MAX}`] });
      }
      const limit = Math.max(1, Math.min(PROFILER_CAPTURE_READ_MAX, Number(params.limit ?? 5)));
      // Sorted by cost, so the interesting frames come first regardless of when they happened.
      const worst = [...cap.frames].sort((a, b) => b.frameMs - a.frameMs).slice(0, limit);
      // #682: `captureFrame` is called from inside `runFrame` (a frame callback) — a dead loop
      // simply stops appending, so a capture that ran and then died reports its last frames as
      // current with nothing saying so. Reported ONLY while still `capturing` — a capture the
      // caller already `capture-stop`ped is expected to be frozen, not stale.
      const w = cap.capturing ? frameStalenessWarning('profiler capture') : null;
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
        ...(w ? { warnings: [w] } : {}),
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
      const limit = Math.max(1, Math.min(PROFILER_BOOT_MAX, Number(params.limit ?? 15)));
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
    case 'read': {
      const result = readPerfProfile({ markers: Number(params.markers ?? 12) }) as Record<string, unknown>;
      // #682: `frame`/`gpu`/`restBreakdown` are all sampled from frames that actually ran — a dead
      // loop stops filling the ring and this would otherwise report the last healthy reading
      // forever with nothing saying so.
      const w = frameStalenessWarning('profiler');
      return w ? { ...result, warnings: [w] } : result;
    }
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
export const DEFAULT_WATCH_SERIES_LIMIT = 100;
registerAgentOp('watch-read', (params) => {
  const p = (params ?? {}) as { id?: string; clear?: boolean; samples?: boolean; precision?: number; name?: string; guids?: string[]; limit?: number };
  const sig = resolvePrecision(p.precision);
  const out = readWatch(p.id ?? '', { clear: p.clear, name: p.name, guids: p.guids, limit: p.limit ?? DEFAULT_WATCH_SERIES_LIMIT }) as { ok?: boolean; series?: Array<Record<string, unknown>> };
  // `roundFloats` COPIES, which matters here: `readWatch` hands back the LIVE `samples` arrays
  // that WatchTab renders. Rounding in place would degrade the human's sparkline.
  if (!out?.ok || !Array.isArray(out.series)) return out;
  // #682: a watch samples the live world once per frame — a dead loop simply stops recording, and
  // every stat here (first/last/min/max/delta/settled) is only as fresh as the last sample taken.
  const staleness = frameStalenessWarning('watch');
  if (p.samples) {
    const rounded = roundFloats(out, sig) as Record<string, unknown>;
    return staleness ? { ...rounded, warnings: [staleness] } : rounded;
  }
  const totalSamples = out.series.reduce((n, s) => n + (typeof s.count === 'number' ? s.count : 0), 0);
  // An empty-filter hint from `readWatch` (#1214) is the answer to "why is this empty?" and wins —
  // the stats sentence below used to overwrite it on every default (samples:false) read.
  const producerHint = (out as { hint?: unknown }).hint;
  const rounded = roundFloats({
    ...out,
    series: out.series.map(({ samples: _samples, ...rest }) => rest),
    totalSamples,
    hint: typeof producerHint === 'string'
      ? producerHint
      : `Stats only (${totalSamples} samples across ${out.series.length} series). Pass samples=true for the raw time-series.`,
  }, sig) as Record<string, unknown>;
  return staleness ? { ...rounded, warnings: [staleness] } : rounded;
});
registerAgentOp('watch-list', () => listWatches());
registerAgentOp('watch-clear', (params) => clearWatch((params as { id?: string })?.id));

// ── Input WATCH (#134): what the POINTER actually did, and what it resolved to — the
// evidence a failed gesture otherwise leaves NOTHING behind (no journal event, no commit, no
// coordinates). Response shaping (limit/unresolvedOnly/precision) lives HERE, in the op, same
// split as watch-read: `readInputPresses()` (the producer, `runtime/input/pointerRecorder.ts`)
// stays a pure ring-buffer read with no agent-surface concerns. ──
registerAgentOp('input-watch-start', (params) => startInputWatch((params ?? {}) as { maxPresses?: number }));

const DEFAULT_INPUT_WATCH_LIMIT = 20;
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
    maxPresses: out.maxPresses,
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
const HIT_REGION_ACTIONS = ['read', 'show', 'hide'] as const;
registerAgentOp('hit-regions', (raw: unknown) => {
  const p = (raw ?? {}) as {
    action?: string; provider?: string; kind?: string; ids?: string[];
    limit?: number; precision?: number; at?: { x: number; y: number };
  };
  const action = String(p.action ?? 'read');
  // An unknown action is REFUSED with the verbs, not run as a read (#1072's mechanism, found by its
  // close-out sweep): `action:'shwo'` answered geometry, so a caller that meant to put the overlay
  // up read "it worked" while nothing appeared. Coded, because this op answers a GET relay too.
  if (!(HIT_REGION_ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false, code: 'REFUSED_BY_OP',
      error: `hit-regions: unknown action ${JSON.stringify(p.action)} — nothing was shown, hidden or read.`,
      options: [...HIT_REGION_ACTIONS],
    };
  }
  if (action === 'show' || action === 'hide') {
    setHitRegionOverlayVisible(action === 'show');
    return { ok: true, visible: action === 'show', providers: hitRegionProviders() };
  }
  // A non-array `ids` is the caller's mistake — refused here, not blamed on each provider in turn
  // (#1214). Reachable only schema-less (`modoki.call`, eval): both MCP tools send an array.
  // `null` is "no ids", as it always was — only a PRESENT non-array is refused.
  if (p.ids === null) p.ids = undefined;
  if (p.ids !== undefined && !(Array.isArray(p.ids) && p.ids.every((id) => typeof id === 'string'))) {
    return {
      ok: false, code: 'REFUSED_BY_OP',
      error: `hit-regions: ids must be an array of region id strings, got ${Array.isArray(p.ids) ? 'an array with a non-string entry' : typeof p.ids} — nothing was read.`,
      options: ['ids: ["<region id>", …]', 'omit ids to read every region'],
    };
  }
  const providers = hitRegionProviders();
  const report = collectHitRegionsReport({ provider: p.provider, kind: p.kind, ids: p.ids });
  const all = report.regions;
  // A provider that THREW has UNKNOWN regions. Named in the reply, so an empty or short list is not
  // read as the surface's answer when part of it could not be asked.
  const failedNames = new Set(report.failed.map((f) => f.provider));
  const limit = typeof p.limit === 'number' && Number.isFinite(p.limit) && p.limit > 0
    ? Math.floor(p.limit) : DEFAULT_HIT_REGION_LIMIT;
  const regions = all.slice(0, limit);
  const result: Record<string, unknown> = {
    visible: isHitRegionOverlayVisible(),
    providers,
    returnedCount: regions.length,
    totalCount: all.length,
    regions,
    ...(report.failed.length ? { failedProviders: report.failed } : {}),
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
    // ⚠️ `all` is the FILTERED list, so an empty one is only evidence about the surface when no
    // filter applied. A typo'd `kind`/`provider`/`ids` used to earn "not hit-testable right now" —
    // a confident wrong cause (§0 rank 2, #1208 B-4). So decide in the order the filter narrows:
    //  1. a `provider` nobody registered is a spelling question, not a surface one;
    //  2. the SCOPE is that provider's regions (or every provider's) — if the scope itself is empty,
    //     the surface diagnosis is the true one, however the rest of the filter is spelled
    //     (#1208 review: checking "any regions anywhere" told a correct `provider=board` on an
    //     unloaded board to check its spelling, because another provider had a region);
    //  3. only then is a `kind`/`ids` miss the filter's, with the kinds named FROM THE SCOPE.
    // `ids` is an array of strings by here — anything else was refused above.
    const idsText = p.ids ? p.ids.join(',') : '';
    const filterText = [p.provider && `provider=${p.provider}`, p.kind && `kind=${p.kind}`, idsText && `ids=${idsText}`]
      .filter(Boolean).join(' ');
    // Decide "a filter applied" by PRESENCE, not by the joined text: `ids: []` filters to nothing
    // in `collectHitRegions` while joining to '' (#1208 close-out review F1).
    const scope = p.provider ? collectHitRegions({ provider: p.provider }) : (p.kind || p.ids != null ? collectHitRegions() : all);
    if (p.provider && !providers.includes(p.provider)) {
      result.hint = `No hit-region provider is named "${p.provider}". Registered: {${providers.join(', ')}} — `
        + 'check the spelling, or drop provider=.';
    } else if (scope.length === 0) {
      const inScope = p.provider ? [p.provider] : providers;
      const threw = inScope.filter((n) => failedNames.has(n));
      const quiet = inScope.filter((n) => !failedNames.has(n));
      result.hint = [
        threw.length ? `Provider(s) [${threw.join(', ')}] FAILED while reporting (see failedProviders and the console) — their regions are UNKNOWN, not absent.` : '',
        quiet.length ? `${p.provider ? `Provider "${p.provider}" is` : `Provider(s) [${quiet.join(', ')}]`} registered but reported no regions — the `
          + 'surface is not hit-testable right now (no level loaded, or a modal is swallowing input).' : '',
      ].filter(Boolean).join(' ');
    } else {
      const kinds = [...new Set(scope.map((r) => r.kind))].sort();
      // With no provider filter, a correctly spelled kind can belong to a provider that is
      // registered but EMPTY right now (an unloaded board beside a live HUD). Name those, so
      // "check the spelling" is not the only reading offered (close-out review F2). `provider`
      // is stamped from the registry key, so it is safe to compare against `providers`.
      const reporting = new Set(scope.map((r) => r.provider));
      const empty = p.provider ? [] : providers.filter((n) => !reporting.has(n) && !failedNames.has(n));
      const threw = p.provider ? [] : providers.filter((n) => failedNames.has(n));
      result.hint = `No region matches the filter (${filterText || 'ids=[]'}), but ${scope.length} region(s) exist`
        + `${p.provider ? ` from "${p.provider}"` : ''}. Live kinds there: {${kinds.join(', ')}} — `
        + 'check the spelling, or drop the filter.'
        + (empty.length ? ` Provider(s) [${empty.join(', ')}] reported NO regions right now (not hit-testable — no level loaded, or a modal is swallowing input), so a kind that only they draw cannot match yet.` : '')
        + (threw.length ? ` Provider(s) [${threw.join(', ')}] FAILED while reporting, so a kind only they draw is unknown, not absent (see failedProviders).` : '');
    }
  } else if (regions.length < all.length) {
    result.hint = `${all.length} region(s) matched; showing the first ${regions.length}. Raise limit=, or filter by kind=/provider=.`;
  }
  // #682: hit-test geometry is FRAME-FED (computed inside the hit-test from the live world).
  const staleness = frameStalenessWarning('hit regions');
  if (staleness) result.warnings = [staleness];
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
 *
 *  One string that may be either, so it cannot go to the shared resolver (`entityRef.ts`) as one
 *  address: a guid-shaped string is tried as a guid and falls back to a name only when it misses, as
 *  before. Both halves use that resolver, so an ambiguous NAME is refused rather than first-matched
 *  (§3, on every path), and a miss is `NOT_FOUND` — it used to reach the caller coded `AMBIGUOUS`. */
function resolveExclude(spec: string): { id: number } | { error: string; code: ErrorCode; options?: string[]; stale?: string } {
  const byGuid = resolveEntityAddress({ guid: spec }, { label: 'exclude', accept: ['guid'] });
  if (byGuid.ok) return { id: byGuid.id };
  const byName = resolveEntityAddress({ name: spec }, { label: 'exclude', accept: ['name'] });
  if (byName.ok) return { id: byName.id };
  if (byName.code === 'AMBIGUOUS') return { error: byName.error, code: 'AMBIGUOUS', options: byName.options ?? [] };
  return {
    error: `exclude: no entity named or guid'd '${spec}' in the live world${byGuid.stale ? ` — a runtime guid that is stale (${byGuid.stale})` : ''}`,
    code: 'NOT_FOUND', ...(byGuid.stale ? { stale: byGuid.stale } : {}),
  };
}

/** How long `scene-query` waits on a Rapier module that has not loaded, to tell "still loading" from
 *  "failed for good" (#1260). Short: the caller is told to retry either way. */
const SCENE_QUERY_PHYSICS_WAIT_MS = 1500;

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

  // 1. "There is no physics world" — NOT a miss. Answering `hit:null` here would tell the agent the
  //    ray passed through empty space. `reason` says WHICH absence, because the remedies differ
  //    (#1260) — the rule lives in `sceneQueryAbsence.ts`.
  if (!(is2d ? hasPhysics2D(world) : hasPhysics3D(world))) {
    const refuse = (a: { reason: string; hint: string }) => ({
      ok: false, code: 'NOT_AVAILABLE_HERE', kind: p.kind, dim: p.dim, reason: a.reason,
      error: `no ${p.dim!.toUpperCase()} physics world exists on this surface, so nothing could be queried — this is NOT "the query missed".`,
      hint: a.hint,
    });
    const base = {
      dim: p.dim,
      hasBodies: world.queryFirst(is2d ? RigidBody2D : RigidBody3D) !== undefined,
      moduleInBuild: is2d ? __MODOKI_MODULE_PHYSICS2D__ : __MODOKI_MODULE_PHYSICS3D__,
      playState: getPlayState(),
    } as const;
    const moduleName = is2d ? 'physics2D' : 'physics3D';
    // Nothing to wait for: loaded (or stripped — `pendingPhysics` filters on the same flag), or a
    // stopped sim, whose answer is "start the sim" whatever Rapier is doing.
    if (base.playState === 'stopped' || !pendingPhysics(world).some((m) => m.name === moduleName)) {
      return refuse(classifyWorldAbsence({ ...base, rapier: { state: 'ready' } }));
    }
    // Rapier is not loaded. Waiting is what tells "still loading" from "gave up" — the loader
    // settles a permanent failure fast — bounded so a slow download reads as loading, not a hang.
    // THIS dimension's module only: the other one's slow load must not mask this one's failure.
    return (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outOfTime = new Promise<'loading'>((res) => { timer = setTimeout(() => res('loading'), SCENE_QUERY_PHYSICS_WAIT_MS); });
      const r = await Promise.race([ensurePhysicsModuleReady(moduleName), outOfTime]);
      clearTimeout(timer);
      const rapier = r === 'loading' ? { state: 'loading' as const }
        : r.ok ? { state: 'ready' as const } : { state: 'failed' as const, error: r.error };
      return refuse(classifyWorldAbsence({ ...base, rapier }));
    })();
  }

  const vec = (v: unknown, what: string): number[] | string => {
    if (!Array.isArray(v) || v.length !== n || v.some((c) => typeof c !== 'number' || !Number.isFinite(c))) {
      return `${what} must be an array of ${n} finite numbers for dim:'${p.dim}' (got ${JSON.stringify(v)})`;
    }
    return v as number[];
  };

  // #682: a physics query reads the CURRENT Rapier world, which the physics system — a frame
  // callback — is what actually advances. A dead loop freezes it mid-scene and this query would
  // silently report a hit/miss against wherever things were when frames stopped.
  const staleness = frameStalenessWarning('scene query');
  const warningsField = staleness ? { warnings: [staleness] } : {};

  // ── point: the pick/hit-test query. Its result shape is deliberately DIFFERENT ──
  if (p.kind === 'point') {
    const pt = vec(p.point, 'point');
    if (typeof pt === 'string') return { ok: false, code: 'REFUSED_BY_OP', error: pt };
    const id = is2d ? pointQuery2D(world, pt[0], pt[1]) : pointQuery3D(world, pt[0], pt[1], pt[2]);
    // §2 — same field name, same meaning, or ABSENT. pointQuery returns containment, which has no
    // impact point, no surface normal and no distance; padding those with zeros would make a
    // `distance:0` here mean something different from a `distance:0` on a raycast, which is
    // exactly the drift that rule exists to stop.
    return { ok: true, kind: 'point', dim: p.dim, point: pt, hit: id == null ? null : queryHitRef(id), ...warningsField };
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
    if ('error' in r) return { ok: false, code: r.code, error: r.error, ...(r.options ? { options: r.options } : {}), ...(r.stale ? { stale: r.stale } : {}) };
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
  const base = { ok: true as const, kind: p.kind, dim: p.dim, origin, direction: dir, ...warningsField };
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
  // A param the action does not use is REFUSED, not ignored (#1213 B-15). The case that made this a
  // bug: `{action:'clear', key:'progress', confirm:true}` reads as "clear that key" and wiped the
  // whole namespace — the destructive action was the one that dropped its argument silently.
  const ACTION_PARAMS: Record<string, readonly string[]> = { set: ['key', 'value'], delete: ['key'], clear: ['confirm'], flush: [] };
  const stray = (['key', 'value', 'confirm'] as const).filter((k) => p[k] !== undefined && !ACTION_PARAMS[p.action!].includes(k));
  if (stray.length) {
    return {
      ok: false, code: 'UNKNOWN_PARAM',
      error: `player-prefs-write: action '${p.action}' does not take ${stray.join(' or ')} — nothing was written.`
        + (p.action === 'clear' && stray.includes('key') ? " clear removes EVERY key in the namespace; to remove one key use action:'delete'." : ''),
    };
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
    // ⚠️ **`keysIncludingProtected()`, never `keys()`** (#1310). This listing describes a DELETE —
    // the preview the operator acknowledges, the `cleared` count, and the `failed`/`alsoPending`
    // split below — and `clear()` also removes a key protected by a save this build cannot decode
    // (#630). `keys()` omits that key, so it went unlisted in the preview and a rejected remove of
    // it was narrated as "already pending before this clear ran" beside "every key this clear
    // enumerated was durably removed" — a wipe reporting success over a save still on disk (#1276).
    const keys = PlayerPrefs.keysIncludingProtected();
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
    // #1317 — the same holds for a CORRUPT entry: absent from `has()`, not protected, still on disk.
    // So the test is the delete listing itself (readable ∪ protected ∪ corrupt), the same one that
    // builds `options` below — otherwise NOT_FOUND offered a corrupt key as a target and then refused
    // it again on every retry, leaving `clear` as the only way to remove it.
    if (!PlayerPrefs.keysIncludingProtected().includes(p.key)) {
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
      // `options` are delete TARGETS, and a protected or corrupt key is one (the check above lets
      // it through, #630 review finding 4, #1317) — so they come from the same listing (#1310).
      // `keys` stays the readable index, the same answer `player-prefs-read` gives.
      return {
        ok: false, code: 'NOT_FOUND', namespace, key: p.key, keys,
        error: `no key '${p.key}' in namespace '${namespace}' — nothing was deleted`,
        options: [...PlayerPrefs.keysIncludingProtected()].sort(),
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
 *  keeping a second copy (#166 P7 — the duplication class §9 warns about).
 *
 *  #842b widened this to all 8 `ASSET_SCHEMA_TYPES` — `/api/asset-write` already accepted
 *  material/shader/animset, but this function (and `read-asset-def`, which infers its `type`
 *  from it when the caller doesn't pass one) only recognized 5, so an agent could WRITE a
 *  material/shader/animset and never read it back to verify. */
export function inferAssetDefType(path: string): 'material' | 'particle' | 'animation' | 'spriteanim' | 'timeline' | 'rig2d' | 'shader' | 'animset' | null {
  if (path.endsWith('.mat.json')) return 'material';
  if (path.endsWith('.particle.json')) return 'particle';
  if (path.endsWith('.anim.json')) return 'animation';
  if (path.endsWith('.timeline.json')) return 'timeline';
  if (path.endsWith('.spriteanim.json')) return 'spriteanim';
  if (path.endsWith('.rig2d.json')) return 'rig2d';
  if (path.endsWith('.shader.json')) return 'shader';
  if (path.endsWith('.animset.json')) return 'animset';
  return null;
}

/** The kinds `read-asset-def` can read from the live cache — every inferable kind but `material`,
 *  whose authored JSON is not retained (both twins refuse it with their own explanation). */
export const READABLE_ASSET_DEF_TYPES = ['particle', 'animation', 'spriteanim', 'timeline', 'rig2d', 'shader', 'animset'] as const;

/** `read-asset-def`'s kind, from an explicit `type` or the path's suffix — shared by the runtime and
 *  editor twins so they refuse the same inputs the same way. An explicit `type` that CONTRADICTS the
 *  suffix is refused (#1213 C-23): it used to win, peek the wrong cache, and report "nothing in the
 *  running scene has loaded it" about an asset that was loaded — under the other kind. A path with no
 *  recognised suffix (a bare shader guid) takes the explicit type as given. */
export function resolveAssetDefKind(path: string, type: unknown):
  { kind: string } | { ok: false; code: ErrorCode; error: string; options: string[] } {
  const inferred = inferAssetDefType(path);
  if (type !== undefined) {
    if (type !== 'material' && !(READABLE_ASSET_DEF_TYPES as readonly unknown[]).includes(type)) {
      return { ok: false, code: 'REFUSED_BY_OP', error: `read-asset-def: unsupported type '${String(type)}' — nothing was read. Valid: ${READABLE_ASSET_DEF_TYPES.join(', ')}.`, options: [...READABLE_ASSET_DEF_TYPES] };
    }
    if (inferred && inferred !== type) {
      return {
        ok: false, code: 'REFUSED_BY_OP',
        error: `read-asset-def: type '${String(type)}' contradicts the path — '${path}' is a ${inferred} by its suffix. Nothing was read; omit type, or pass type:'${inferred}'.`,
        options: [inferred],
      };
    }
    return { kind: type as string };
  }
  if (!inferred) {
    return { ok: false, code: 'REFUSED_BY_OP', error: `read-asset-def: cannot tell what kind of asset '${path}' is — pass type explicitly (${READABLE_ASSET_DEF_TYPES.join(', ')}).`, options: [...READABLE_ASSET_DEF_TYPES] };
  }
  return { kind: inferred };
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
  const resolved = resolveAssetDefKind(path, type);
  if (!('kind' in resolved)) return resolved;
  const { kind } = resolved;
  // PEEK, don't load. The plain getters treat a miss as "not loaded YET" and kick off a background
  // fetch, so asking about an absent asset would queue a load that can only fail and log into the
  // console — for a question this op then refuses anyway.
  if (kind === 'material') {
    // material is NOT genuinely peekable, on this surface either — `materialCache`
    // (meshTemplateCache.ts) holds only the BUILT `THREE.Material` once `fetchMaterial` parses the
    // `.mat.json`; the raw JSON is never retained live. Refuse explicitly rather than falling into
    // the generic "unsupported type" branch below, and say why + what to do instead.
    return {
      ok: false,
      error: "read-asset-def: material defs are not readable from the live cache — only the compiled THREE.Material is retained, the authored .mat.json is discarded once built. Read the file directly (it is the authoritative copy; a parked edit shows in modoki_get_editor_state's dirtyAssetPaths).",
      options: [...READABLE_ASSET_DEF_TYPES],
    };
  }
  const peek = { load: false } as const;
  const def =
    kind === 'particle' ? getParticleEffect(path, peek)
    : kind === 'animation' ? getAnimationClip(path, peek)
    : kind === 'timeline' ? getTimeline(path, peek)
    : kind === 'spriteanim' ? getSpriteAnim(path, peek)
    : kind === 'rig2d' ? getRig2D(path, peek)
    // shader — `getSpriteMaterialProgram` is a bare `Map.get`, no fetch side effect on a miss, so
    // it's exactly as peekable as the `{load:false}` getters above despite the different signature.
    // It's keyed by GUID (whatever `Renderable.material` carried when the program compiled), not by
    // path, so a path-shaped `path` has to be turned into a guid first via the manifest's reverse
    // lookup. `.manifest` is the authored `.shader.json` doc itself — the compiled GL/GPU program
    // alongside it is not part of the answer.
    : kind === 'shader' ? (() => {
        const guid = isGuid(path) ? path : getGuidForPath(path);
        const program = guid ? getSpriteMaterialProgram(guid) : undefined;
        return program ? program.manifest : null;
      })()
    // animset — `getAnimSet` now takes the same `{load:false}` peek option as its siblings above,
    // so a miss reports null without fetching or sticky-poisoning `failed`.
    : kind === 'animset' ? getAnimSet(path, peek)
    : undefined;
  if (def === undefined) {
    return { ok: false, error: `unsupported type '${kind}'.`, options: [...READABLE_ASSET_DEF_TYPES] };
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
// The editor's `load-scene` guards unsaved editor work and returns the editor's scene fields; neither exists
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
  let startupErrors: readonly { manager: string; error: unknown }[]; // assigned in the try; the catch always returns
  // SceneManager allocates THIS attempt's id into `nextLoad` synchronously, before loadScene's
  // first await (SceneManager.loadScene's step-2 `nextSceneId`/`nextLoad` allocation) — so reading it here, between the call and the await,
  // names OUR load specifically, not whichever load happens to win a later swap (#486 finding A).
  const myId = sceneManager.getNext()?.id ?? null;
  try {
    startupErrors = (await loading).startupErrors ?? [];
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
      // #1425: a manager that failed to start is reported, not a failure; the scene IS loaded.
      return {
        ok: true, current: after, previous: before, worldEntityTotal: getAllEntities().length,
        ...(startupErrors.length ? { warnings: startupErrors.map(({ manager, error }) =>
          `manager "${manager}" failed to start (the scene is still loaded): ${(error as Error)?.message ?? String(error)}`) } : {}),
      };
    }
    // ⚠️ `> myId`, NOT `!== myId`. Scene ids come from a monotonic `this.nextSceneId++`
    // (loadScene's `nextSceneId` bump), so only an id GREATER than ours is evidence that a LATER load won
    // the swap. A different-but-SMALLER id means nothing newer ever installed and our own load
    // simply never became primary — and reporting THAT as "a later scene load won" would assert
    // from evidence that only says "the current id is not mine", which is the same shape of
    // over-claim this fix exists to remove. That case falls through to the original path check
    // below and keeps its original message. (A genuinely bad path throws at loadScene's `Failed to fetch scene` check
    // and is answered by the catch above; this is belt-and-braces for any resolve-without-
    // installing path, which is what the original `after !== p.path` check was written for.)
    if (cur.id > myId) {
      // Superseded. `loadScene` still resolved successfully for us (loadScene's step-11 `primaryId === id` guard, "a
      // superseded load skips straight to resolving"), so this is not our load failing and it
      // says nothing about whether `p.path` exists.
      if (cur.path === p.path) {
        // The same requested path won, so the caller's requested end state IS true — just not
        // because of THIS op's load. `worldEntityTotal` is deliberately omitted: it would be a live
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
  return { ok: true, current: after, previous: before, worldEntityTotal: getAllEntities().length };
});

// SIM_STEP_MAX_TIMEOUT_MS / simStepDefaultTimeout are imported at the top of this file (from
// `tools/shared/simStepTiming.ts`, #822) and re-exported here so existing importers of this
// module (e.g. `liveLifecycleOps.test.ts`) are unaffected by the move.
export { SIM_STEP_MAX_TIMEOUT_MS, simStepDefaultTimeout };

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
  // Refused, not clamped (#1213 C-9): `frames:1000` stepped 600 and `scale:-1` stepped at 1, both
  // answering ok about a run the caller did not ask for — and `frames:'abc'` became NaN, which no
  // frame count ever reaches, so the call sat out its whole timeout. `duplicate-entity` refuses a bad
  // count for the same reason.
  const bad = (field: string, value: unknown, want: string) => Promise.resolve({
    ok: false, code: 'REFUSED_BY_OP',
    error: `sim-step: ${field} must be ${want} — got ${JSON.stringify(value)}. Nothing was stepped.`,
  });
  if (p.frames !== undefined && !(Number.isInteger(p.frames) && p.frames >= 1 && p.frames <= SIM_STEP_MAX_FRAMES)) {
    return bad('frames', p.frames, `an integer from 1 to ${SIM_STEP_MAX_FRAMES}`);
  }
  if (p.scale !== undefined && !(typeof p.scale === 'number' && Number.isFinite(p.scale) && p.scale > 0)) {
    return bad('scale', p.scale, 'a finite number above 0');
  }
  if (p.timeoutMs !== undefined && !(typeof p.timeoutMs === 'number' && Number.isFinite(p.timeoutMs))) {
    return bad('timeoutMs', p.timeoutMs, 'a finite number of milliseconds');
  }
  const frames = p.frames ?? 1;
  const scale = p.scale ?? 1;
  const budgetMs = Math.max(100, Math.min(SIM_STEP_MAX_TIMEOUT_MS, p.timeoutMs ?? simStepDefaultTimeout(frames)));

  // Physics readiness (#1175): a body whose Rapier WASM has not instantiated is SKIPPED by the
  // physics system, so these frames would come back physics-free and read as real. Wait for it like
  // the editor's `step` does — but inside this op's OWN budget, so the host's transport deadline
  // (derived from the same timeoutMs) still holds: whatever the wait spends, the frames lose.
  return (async () => {
    let timeoutMs = budgetMs;
    const pending = pendingPhysics(world);
    if (pending.length > 0) {
      // REAL wall time, not rawNow(): this budget races the host's transport deadline, and a manual
      // (test/headless) clock would read the wait as 0ms and hand the frames the whole budget again.
      const started = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outOfTime = new Promise<'loading'>((res) => { timer = setTimeout(() => res('loading'), budgetMs); });
      const r = await Promise.race([ensurePhysicsReady(world), outOfTime]);
      clearTimeout(timer);
      const names = pending.map((m) => m.name);
      if (r === 'loading') {
        return {
          ok: false, physicsLoading: names,
          error: `sim-step refused — ${names.join(' + ')} was still loading its WASM after ${budgetMs}ms, so a step `
            + `would run with NO physics. The load continues; retry the step.`,
        };
      }
      if (!r.ok) {
        // Permanent (the loader gave up and memoised the rejection) — retrying cannot help, so say so.
        return { ok: false, error: `sim-step refused — physics failed to initialize, so the world would advance with NO physics: ${r.error}` };
      }
      timeoutMs = Math.max(100, budgetMs - (Date.now() - started));
      if (getCurrentWorld() !== world) {
        // A scene load replaced the world while physics loaded — nothing was unfrozen, so there is nothing to undo.
        return { ok: false, worldReplaced: true, stepped: 0, requested: frames, error: 'the world was REPLACED while physics was loading — a scene load swapped it out, so no frames were stepped.' };
      }
      // Re-read the precondition: a resume (or a concurrent sim-step, whose continuation ran first and
      // unfroze the world) landed during the wait. Stepping on would re-freeze a world someone else
      // just set running — the side effect the entry check refuses.
      if (getTimeScale(world) !== 0) {
        return { ok: false, timeScale: getTimeScale(world), error: `sim-step requires a PAUSED world — timeScale became ${getTimeScale(world)} while physics was loading.` };
      }
    }
    return stepFrames(timeoutMs);
  })();

  function stepFrames(timeoutMs: number) { return new Promise((resolve) => {
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
  }); }
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
    guidOf: liveGuidOf,
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
type SceneChangedKind = 'scene' | 'prefab' | 'animation' | 'timeline' | 'particle' | 'spriteanim' | 'rig2d' | 'animset' | 'material' | 'shader' | 'mesh';

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
  // Seventh and eighth (#842): `material`/`shader` were agent-writable (`/api/asset-write` covers
  // all 8 ASSET_SCHEMA_TYPES) and Inspector-parkable, but absent from LiveReloadKind entirely, so
  // `classifySceneChange` fell through to `null` for both — no broadcast, ever, so an external
  // write never invalidated the cache and a stale parked edit was never dropped at the next save.
  material: invalidateMaterial,
  shader: invalidateShader,
  // Ninth (#1380): `.mesh.json` is not an ASSET_SCHEMA_TYPE, so #842's schema ⊆ kind check could
  // not see it — only a plain file edit writes one externally. The invalidator also tells the
  // renderer, because its built object is cached by the unchanged ref string.
  mesh: invalidateMeshAsset,
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

type SceneChangedMsg = { urlPath: string; kind: SceneChangedKind; viaSibling?: boolean };

/** Scene/prefab changes that arrived while the reload was suppressed, keyed by `urlPath`, in the
 *  order of their latest write (#1164). Drained by {@link replaySuppressedSceneReloads}. */
const _suppressedReloads = new Map<string, SceneChangedMsg>();

/** Replay every scene/prefab change that arrived while the hot reload was suppressed, through the
 *  same `handleSceneChanged` a live change takes, so a deferred change gets exactly the treatment
 *  it would have had one frame after Stop. That includes **disk winning over unsaved edits** the
 *  restored snapshot carried (owner's choice, 2026-09-13, on #1164): a stopped-mode external write
 *  already behaves that way.
 *
 *  Editor-only in practice: the editor calls it on its "authoring settled" signal
 *  (`agentEditorOps.ts`), which fires only once no restore or scene open is still loading. Calling
 *  it on a bare run-mode edge is the defect that signal exists to avoid (see `authoringSettle.ts`).
 *  A no-op while still suppressed, so an early call keeps the entries rather than losing them.
 *
 *  ⚠️ SEQUENTIAL, not fired together. Reloads started together supersede each other, and the
 *  winner does not carry the loser's options: a changed BASE scene reloads with `forceReloadBases`,
 *  a prefab change without it, so a prefab reload winning over a base reload leaves the base stale
 *  (measured live: fired together, the scene reload logged "superseded" and the prefab one won).
 *  A live watcher batch has the same race, but a run collects every write made during it, so
 *  deferral makes the mix far more likely. Prefab changes need only ONE reload, so they collapse to
 *  their last entry, replayed last and carrying the others to evict at the same moment. That entry
 *  runs even after a scene reload, because a scene entry outside the loaded chain reloads nothing.
 *  Nothing is evicted up front: a replay that finds itself suppressed again part-way (Play pressed
 *  mid-replay) re-defers what is left, and an eviction already made would then run during Play.
 *  Resolves with the number of changes replayed. */
export async function replaySuppressedSceneReloads(): Promise<number> {
  if (_suppressedReloads.size === 0 || sceneReloadSuppressedReason()) return 0;
  const pending = [..._suppressedReloads.values()];
  _suppressedReloads.clear();
  console.log(`[agentBridge] replaying ${pending.length} scene hot-reload(s) deferred during the run`);
  for (const m of pending) if (m.kind !== 'prefab') await handleSceneChanged(m);
  const prefabs = pending.filter((m) => m.kind === 'prefab');
  const last = prefabs.at(-1);
  if (last) await handleSceneChanged(last, prefabs.slice(0, -1).map((m) => m.urlPath));
  return pending.length;
}

/** Test seam: the deferred changes currently held, as `urlPath`s in replay order. */
export function peekSuppressedSceneReloads(): string[] {
  return [..._suppressedReloads.keys()];
}

/** Hot-reload the active scene when its file (or any prefab) changes on disk.
 *  Shared by the Vite HMR path and the Electron IPC path. */
async function handleSceneChanged(msg: SceneChangedMsg, evictAlso: readonly string[] = []): Promise<void> {
  // An asset-def change (.anim/.timeline/.particle/.spriteanim/.rig2d) invalidates just that
  // cache entry and returns — see ASSET_CACHE_INVALIDATORS above for why this is a table and what
  // it prevents. The parked write goes with the cache entry: once the cached def is dropped the
  // pending doc has no live counterpart, and disk becomes the truth for that asset (otherwise the
  // next save_all flushes the stale parked doc over the file that was just written).
  // ⚠️ `hasDocKey`, NOT a raw index (#993). `msg.kind` arrives on the device-debug/HMR
  // protocol and `ASSET_CACHE_INVALIDATORS` is a code-declared literal, so `kind:"constructor"`
  // returns the inherited FUNCTION — truthy, so the `if` below passes — and the next line CALLS
  // it: `Object(urlPath)`. The looked-up value being invoked is what makes this one the sharpest
  // read in the family after scroll-demo's URL param.
  const invalidateCachedAsset = hasDocKey(ASSET_CACHE_INVALIDATORS, msg.kind)
    ? ASSET_CACHE_INVALIDATORS[msg.kind]
    : undefined;
  if (invalidateCachedAsset) {
    invalidateCachedAsset(msg.urlPath);
    // ⚠️ Only when THIS asset's own file changed. `viaSibling` says the broadcast was raised by a
    // SIBLING write — today a `.glsl`/`.wgsl` shader body remapped to its `.shader.json`
    // descriptor (#857) — and then `dropParkedWriteFor`'s premise ("the file on disk is now
    // authoritative") is simply false: the descriptor on disk is untouched, so a parked Inspector
    // edit for it is not stale and must survive. Dropping it here discarded exactly the edit the
    // author was iterating on — declare a uniform in the Shader Inspector, save the `.wgsl` you
    // added it to, lose the declaration — which is the very loop #857 exists to enable. The cache
    // invalidation above still runs either way; only the parked-write discard is conditional.
    if (!msg.viaSibling) await dropParkedWriteFor(msg.urlPath);
    // The invalidation above is otherwise invisible while the sim is stopped: Scene2D's idle
    // dirty-gate skips the whole frame unless something wakes it, so the viewport would keep
    // showing pre-edit pixels forever. Firing the shared dirty signal wakes EVERY subscribed
    // surface (Scene2D.tsx, Scene3D.tsx, SceneView.tsx, editor/store/canvas2DDirty.ts,
    // runtime/ui/uiTreeStore.ts) for all eight kinds in the table above, not just material/shader.
    fireDirtyListeners();
    return;
  }
  // Suppressed during Play/Pause and inside a scrub/preview envelope: a reload now would rebuild the
  // world the run's snapshot belongs to, and Stop/Exit would restore the pre-write snapshot over it.
  // DEFERRED, not dropped (#1164) — dropping left the world behind disk after Stop/Exit, and the next
  // save wrote that stale world over the external change. `replaySuppressedSceneReloads` runs it
  // once authoring settles. Checked BEFORE `current`, so a change arriving with no scene loaded is
  // still recorded rather than lost the same way.
  const defer = (reason: string): void => {
    const held = [msg, ...evictAlso.map((urlPath): SceneChangedMsg => ({ urlPath, kind: 'prefab' }))];
    for (const m of held) {
      _suppressedReloads.delete(m.urlPath); // re-insert, so replay order follows the latest write
      _suppressedReloads.set(m.urlPath, m);
    }
    console.warn(`[agentBridge] scene hot-reload deferred (${msg.kind} change: ${msg.urlPath}) — ${reason}`);
  };
  const suppressed = sceneReloadSuppressedReason();
  if (suppressed) { defer(suppressed); return; }
  // #1169: a prefab change must evict the cached prefab BEFORE the scene reload below, or the reload
  // re-instantiates the OLD prefab: a load acquires before it releases, so the new scene id finds the
  // entry still owned and `fetchPrefab` returns on the cache hit. BOTH copies: the runtime cache
  // (evicted), and the editor's own (`_prefabSourceRefresher`, RE-READ — never left empty, see
  // `refreshPrefabSourceForPath`), which the serializer diffs instances against. Refresh only the
  // runtime one and the instance is rebuilt from the new prefab while the next save diffs it against
  // the old, keeping an added trait or entity as a false override. Not in ASSET_CACHE_INVALIDATORS:
  // that branch runs during Play too, where evicting a prefab breaks the runtime's synchronous
  // `getCachedPrefab` spawns — so the runtime eviction runs only on this path, once suppression is
  // over, and as late as possible (see the re-check below). Keyed by the path form the watcher sends.
  const prefabPaths = msg.kind === 'prefab' ? [msg.urlPath, ...evictAlso] : [...evictAlso];
  const evictRuntimePrefabs = (): void => { for (const urlPath of prefabPaths) invalidatePrefab(urlPath); };
  const refreshEditorPrefabs = async (): Promise<void> => {
    const refresh = _prefabSourceRefresher;
    if (refresh) await Promise.all(prefabPaths.map((urlPath) => refresh(urlPath).catch(() => {})));
  };
  const current = sceneManager.getCurrent()?.path;
  if (!current) { evictRuntimePrefabs(); await refreshEditorPrefabs(); return; }
  // In prefab-edit mode the active "scene" is a synthetic in-memory scene
  // (`/__prefab-edit__/<guid>`) with no file on disk — leave it alone. The editor's prefab copy is
  // still re-read: the prefab-edit save reads it synchronously for the edited and nested prefabs.
  if (current.startsWith('/__prefab-edit__/')) { evictRuntimePrefabs(); await refreshEditorPrefabs(); return; }
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
    if (!matchedAny) return; // touches no scene in the currently-loaded chain (a scene change carries no prefabs)
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
    // Before the re-check, since it awaits too: the editor copy is re-read in place, so refreshing it
    // and then deferring leaves nothing stale-and-missing behind.
    await refreshEditorPrefabs();
    // ⚠️ Re-check after the awaits (#1164 review). The check above ran before the fetch, and a Play
    // press, an envelope, or a scene open/restore taking a world-replacement token can all begin
    // inside it. Loading now would supersede that scene open or land inside the new run, and the
    // change would be gone from the pending list — so defer it again instead.
    const lateReason = sceneReloadSuppressedReason();
    if (lateReason) { defer(lateReason); return; }
    evictRuntimePrefabs();
    // The kept bases carried their unsaved edits across, so the editor keeps their dirty flags (#1417).
    const { keptBaseGuids } = await sceneManager.loadScene(current, {
      ...(preloaded ? { preloaded } : undefined),
      ...(changedBaseGuid ? { forceReloadBases: [changedBaseGuid] } : undefined),
    });
    await _worldReloadedFromDisk?.(current, keptBaseGuids);
    console.log(`[agentBridge] hot-reloaded scene (${msg.kind} change: ${msg.urlPath})`);
  } catch (e) {
    // A newer load superseding this one aborts the in-flight load
    // (SceneManager throws DOMException 'AbortError'). That's expected — the
    // superseding load logs its own success — not a failure, and it inherits this
    // load's `forceReloadBases`, so a changed base is still reloaded (#1422). This fires
    // routinely when several files change at once (e.g. deleting a batch of
    // unused prefabs), so keep it quiet rather than an alarming "failed" warn.
    if (e instanceof DOMException && e.name === 'AbortError') {
      console.log(`[agentBridge] scene hot-reload superseded (${msg.kind} change: ${msg.urlPath})`);
      return;
    }
    console.warn('[agentBridge] scene hot-reload failed:', e);
  }
}

/** The minimal HMR surface `registerRelayResponder` needs, so a test can play the dev server. */
export interface RelayHot {
  send(event: string, data: unknown): void;
  // `any` matches Vite's own `ViteHotContext.on`, whose callback payload is inferred per event —
  // a narrower parameter type here makes the real `import.meta.hot` unassignable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (data: any) => void): void;
}

/** Make this client a relay responder: ANNOUNCE first, then accept `modoki:request`.
 *
 *  ⚠️ **The two halves are one function because they are one invariant** (#1030): *nothing may be
 *  able to answer `modoki:request` before it has announced.* The server sizes its decline
 *  denominator from clients that have announced, so a client that can decline while uncounted
 *  completes a count that was one short — and that is #1030 itself, a live editor's asset-path
 *  repair skipped silently. Split across two statements they can drift; here they cannot.
 *
 *  The announce exists because `modoki:schema` was the only signal and it is NOT prompt:
 *  `makeSchemaPusher` refuses to send an empty registry and polls at 200ms, while
 *  `initAgentBridge` is reached through a top-level dynamic import from `main.tsx` — so every tab
 *  could answer for a while before it was counted, and a tab parked on the Vite error overlay
 *  never announced at all.
 *
 *  ⚠️ **Exported and taking `hot` as a parameter so the PRODUCER is testable.** `initAgentBridge`
 *  reads `import.meta.hot` inline, which no test can fake — and with this logic inline there, the
 *  announce could be deleted with 3,621 tests green (found by review, one round after the same
 *  shape was found on the server side). The consumer had a seam test; the producer had nothing.
 *
 *  ⚠️ **`vite:ws:connect` cannot currently fire for this listener, and it is kept knowingly.**
 *  Vite 8 emits it once per page from inside `/@vite/client`'s own `transport.connect`, long
 *  before `main.tsx`'s dynamic import registers anything, and it has no in-page reconnect (on
 *  disconnect the client polls and calls `location.reload()`). So a dev-server restart re-announces
 *  via the fresh page's `announce()`, NOT via this listener. An earlier comment claimed this was
 *  the reconnect path; it was wrong. Kept because it is free and correct if Vite ever reconnects
 *  in place — but do not cite it as the mechanism for anything. (The neighbouring
 *  `vite:ws:connect` schema listener is dead for exactly the same reason.) */
export function registerRelayResponder(hot: RelayHot): void {
  const announce = (): void => { hot.send('modoki:bridge-hello', {}); };
  announce();
  hot.on('vite:ws:connect', announce);

  // ⚠️ **DECLINE an op we do not have — do not reject it** (#1030). The dev server BROADCASTS
  // `modoki:request` to every HMR client, so this runs in every open tab, not only the editor's.
  // A tab on the runtime route has no editor ops and answers in about a millisecond, which used
  // to BEAT the editor tab and settle the request on its behalf.
  //
  // `declined` is a separate channel from `error` because the two mean opposite things to the
  // server: "I do not have this op" is countable, while "this op threw" is a real answer from the
  // one client that owns the op and must settle immediately. Collapsing them is the whole defect.
  //
  // The decision is `relayResponseFor`, called with NO overrides on purpose: its defaults already
  // are `servesAgentOp` and `runAgentOp`, so passing them again adds a line that can be mis-wired —
  // swapping `hasAgentOp` for `() => true` there left 228 tests green while making every client
  // claim every op. Nothing to pass is nothing to get wrong.
  hot.on('modoki:request', async (msg: { id: number; op: string; params?: unknown }) => {
    hot.send('modoki:response', await relayResponseFor(msg));
  });
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
      // The same reply function as the HMR relay's `relayResponseFor`, so an `OpRefusal` reaches the
      // packaged editor's backend as a coded envelope too — not only the dev server's (#1012).
      bridge.send('response', { id: msg.id, ...(await opReplyFor(() => handleOp(msg.op, msg.params))) });
    });
    // Drive scene reloads off main's watcher (which owns the guard) when chosen —
    // for an Electron bridge this is ALWAYS the case, dev or packaged. See
    // sceneReloadSource for why the Vite HMR path must NOT also drive reloads here.
    if (reloadSource === 'bridge') {
      bridge.on('scene-changed', (data) => {
        void handleSceneChanged(data as { urlPath: string; kind: SceneChangedKind; viaSibling?: boolean });
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
  // Intended as the reconnect path: a server restart drops the dev server's cache, and a plain
  // start() would find the same signature already sent and send nothing, leaving the freshly-
  // restarted server with no schema at all. The `force` is what makes the resend happen.
  //
  // ⚠️ **This listener CANNOT FIRE in Vite 8, so the reconnect it describes is handled elsewhere.**
  // Vite emits `vite:ws:connect` once per page from inside `/@vite/client`'s own
  // `transport.connect`, which runs while `/@vite/client` is evaluating — long before
  // `main.tsx`'s dynamic `import('./debug/agentBridge')` registers anything here. And there is no
  // in-page reconnect to catch: on `vite:ws:disconnect` the client polls and calls
  // `location.reload()`, so a restarted server is served by a FRESH page whose own `pusher.start()`
  // above does the push. Kept because it costs nothing and would be correct if Vite ever
  // reconnected in place — but do not cite it as the mechanism for anything. (Found while fixing
  // #1030's announce, whose sibling listener has the same property and says so.)
  hot.on('vite:ws:connect', () => { if (!schemaPushed) pusher.start({ force: true }); });

  // 2 + 3. Announce, then take the ops. ONE call, deliberately — see `registerRelayResponder`.
  registerRelayResponder(hot);

  // 3. Hot-reload the active scene on a .scene.json / .prefab.json edit — ONLY when
  //    Vite owns the self-write guard (browser dev, same-origin writes). With an
  //    Electron bridge, main's watcher drives reloads (registered above); listening
  //    here too would double-reload AND bounce the scene on the editor's own writes
  //    (Vite's guard is never marked from this renderer). See sceneReloadSource.
  if (reloadSource === 'vite') {
    hot.on('modoki:scene-changed', (msg: { urlPath: string; kind: SceneChangedKind; viaSibling?: boolean }) => { void handleSceneChanged(msg); });
  }
}
