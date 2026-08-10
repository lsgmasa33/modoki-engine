/** Editor agent ops — the renderer-side handlers that give an AI agent (or any
 *  tooling) parity with what a human can DO and SEE in the editor.
 *
 *  These are registered into the agent-bridge op registry (engine/app/debug/
 *  agentBridge.ts) at EDITOR startup only — `registerEditorAgentOps()` is called
 *  from `createGameEditor` (the lazy, React.lazy-loaded editor path). That keeps
 *  all `@modoki/engine/editor` imports out of the shipped game web bundle while
 *  making every op work identically in dev (relayed over Vite HMR) and the
 *  packaged DMG (relayed over Electron IPC) — the bridge transport is the same.
 *
 *  Convention: each op returns a JSON-serializable result (the backend forwards
 *  it verbatim). Selection/gizmo writes go through RAW store setState so they do
 *  NOT push selection-undo entries — the agent must not pollute the human's undo
 *  stack just by looking around. Structural edits (create/delete/duplicate/
 *  reparent) DO go through the undoable actions, exactly like the menus, so the
 *  agent's edits are undoable too. */

import * as THREE from 'three';
import { describeEditorCamera, type EditorCameraInfo } from './editorCameraInfo';
import { registerAgentOp as _registerAgentOp, type AgentOpHandler, setSceneReloadSuppressor, inferAssetDefType } from '../debug/agentBridge';
import { performDomDnd, type DomDndParams } from '../debug/domDnd';
import { getHmrStatus } from '../debug/hmrStaleness';
import { getGameBootFaults } from './gameBootFaults';
import { handleEval, clampEvalTimeout, EVAL_ASYNC_TIMEOUT_MS, EDITOR_EVAL_MAX_TIMEOUT_MS } from '../debug/bridgeHelpers';
import { makeEvalApi } from './evalApi';
import {
  useEditorStore, type SelectedAsset,
  enterPlay, stopPlay, pausePlay,
  undo, redo, canUndo, canRedo, undoLabel, redoLabel, getEditVersion,
  loadScene, saveAll, newScene, getCurrentScenePath, hasUnsavedChanges, unsavedChangeCauses,
  isEditingPrefab, openPrefabForEditing, savePrefabEdit, exitPrefabEditing,
  createEntityWithUndo, duplicateEntity, deleteEntitiesWithUndo, reparentEntity, ensureGuid, type TraitSpec,
  buildEntityCreateSpecs, type CreateEntitySpec,
  writeTraitFieldWithUndo, removeTraitFromEntitiesWithUndo, addTraitToEntitiesWithUndo,
  runAsCompositeAction, markAssetDirty, getDirtyAssetPaths, discardDirtyAssets,
  getPrefabSource, instantiatePrefabAsync, setPrefabSource, serializePrefab, writePrefabFile,
  resolveExistingPrefabId, tagEntityTreeAsInstance, untagEntityTreeAsInstance,
  detachPrefabInstance, reattachPrefabInstance,
  pushAction, makePrefabInstantiateAction, entityRef,
  getEditorViewportCamera, focusEntityInSceneView,
  upsertKey, findTrack, encodeValue,
  readEditorJournal, clearEditorJournal, withEditorActor, openActorLease, closeActorLease,
  waitForEditorJournal,
  getResolvedRender3d,
  type PrefabFile,
} from '@modoki/engine/editor';
import { tailWithCounts, takeTail, takeHead, tailHint, JOURNAL_TAIL_DEFAULT, EDITOR_JOURNAL_TAIL_DEFAULT } from '../debug/streamSummary';
import {
  getPlayState, setPlayState, getRunMode, isAdvancing, getCurrentFPS, getFrameLoopHealth, getRendererGateHealth, getGpuFaultState, stepOneFrame, getAllEntities, findEntity, findEntityByGuid, deleteEntity,
  getAnimationClip, normalizeAnimationClip, validateAssetData, journalEvents, getParticleEffect, mountedSurfaces,
  getTimeline, normalizeTimeline, getGuidForPath, getAssetType, getPresentationScale,
  getSpriteAnim, getRig2D,
  getAllTraits, PRIMITIVE_NAMES, PRIMITIVE_SPRITE_NAMES, type MutateOp, type MutateEntityRef,
  Transform, getWorldTransform3D, getParentWorldMatrix3D, getCurrentWorld, mergeTrs, worldToLocalTrs, matrixToTrs, persistedTrsKeys, collapsedParentAxes,
  type AnimationClipDef, type TrackValueType, type TimelineDef, type TrackDef, type TrackKind,
} from '@modoki/engine/runtime';

// ── Reads ─────────────────────────────────────────────────────────────────

/** The live editor orbit camera pose, or null when no viewport is mounted — enough to
 *  reconstruct framing or feed render-scene's camera override. The projection-aware shaping
 *  (fov for perspective, orthoSize for ortho) is the pure {@link describeEditorCamera}. */
function readEditorCamera(): EditorCameraInfo | null {
  return describeEditorCamera(getEditorViewportCamera());
}

/** HMR staleness, kept OFF the payload when there is nothing to report — an editor that
 *  has had zero updates is by definition not stale. Silence here means "this build is what
 *  booted". (Applies to the packaged editor too: it runs a real Vite dev server, so it has
 *  HMR — see engine/app/debug/hmrStaleness.ts.) */
function hmrFields(): { hmrUpdates?: number; staleGameCode?: true; discardedUnsavedEdits?: true } {
  const h = getHmrStatus();
  const out: { hmrUpdates?: number; staleGameCode?: true; discardedUnsavedEdits?: true } = {};
  if (h.updates > 0) out.hmrUpdates = h.updates;
  if (h.staleGameCode) { out.staleGameCode = true; out.hmrUpdates = h.updates; }
  // Sticky for the life of the page: the human may not have seen the banner, and an agent
  // reading state later still needs to know work was dropped under it.
  if (h.discardedUnsavedEdits) out.discardedUnsavedEdits = true;
  return out;
}

/** Frame-loop liveness, included only when it is NOT plainly healthy — a running loop is
 *  the norm and needs no words. `hidden` is reported too: it is benign (the OS window is
 *  occluded/minimised, so the browser throttles rAF) but it explains an `fps: 0` reading
 *  and a failing `capture_viewport`, which otherwise look identical to a real wedge. */
function frameLoopFields(): { frameLoop?: ReturnType<typeof getFrameLoopHealth> } {
  const h = getFrameLoopHealth();
  if (h.status === 'running' && h.recovered === 0) return {};
  return { frameLoop: h };
}

/** Renderer-gate health, included only when the renderer is NOT ready. `pending` is normal
 *  for the first seconds of a cold start; `failed` never self-recovers and means every
 *  scene-dependent reading here is meaningless until the editor is relaunched.
 *
 *  `render3d` is the resolved `build.modules.render3d` fact (`createEditor.tsx`'s
 *  `getResolvedRender3d`) — `undefined` while the boot fetch is still in flight, `true`/`false`
 *  once resolved. It explains WHY the no-viewport watchdog warning is (or isn't) firing: a
 *  `'pending'` gate with `render3d: false` is an expected, silent state for a 2D/UI-only
 *  project, not a stall to chase. */
function rendererGateFields(): {
  rendererGate?: ReturnType<typeof getRendererGateHealth> & { render3d?: boolean };
} {
  const g = getRendererGateHealth();
  if (g.status === 'ready') return {};
  const render3d = getResolvedRender3d();
  return { rendererGate: render3d === undefined ? g : { ...g, render3d } };
}

/** GPU device-loss / uncaptured-error state, included only when something has actually gone
 *  wrong — the healthy case (`getGpuFaultState()` returning null) needs no words, same
 *  convention as `frameLoopFields`/`rendererGateFields`. This is the CAUSE `frameLoop.status:
 *  'stalled'` is often only the SYMPTOM of: a lost GPU device stops the compositor from ever
 *  producing a frame, which the stall watchdog reports as a wedge with no idea why. */
function gpuFields(): { gpu?: ReturnType<typeof getGpuFaultState> } {
  const g = getGpuFaultState();
  return g ? { gpu: g } : {};
}

/** The whole editor UI state in one read — the "get all UI state" payload. */
function readEditorState() {
  const s = useEditorStore.getState();
  return {
    scenePath: getCurrentScenePath(),
    // Live-world work not on disk. Anything reading the scene FILE (set_transform,
    // mutate_scene, build) is looking at a DIFFERENT world while this is true. (C7)
    // Also true while a dirty asset (below) is pending — see hasUnsavedChanges()'s own comment.
    unsavedChanges: hasUnsavedChanges(),
    // Pending 'manual'-mode particle/anim/timeline writes (mcp-persistence.md
    // Phase 3) — omitted when empty (nothing pending has nothing to show). A dirty asset an
    // agent can't SEE is the same silent-loss trap `unsavedChanges` already exists to close.
    ...(getDirtyAssetPaths().length ? { dirtyAssetPaths: getDirtyAssetPaths() } : {}),
    playState: getPlayState(),
    runMode: getRunMode(),   // 'stopped' | 'scrub' | 'preview' | 'playing' (preview-mode-refactor)
    advancing: isAdvancing(), // false = a frozen frame (Play paused, or a paused preview)
    gizmoMode: s.gizmoMode,
    gizmoSpace: s.gizmoSpace,
    sceneViewMode: s.sceneViewMode,
    // Which panel owns the KEYBOARD ('scene' | 'hierarchy' | 'animation-editor' | …), or null.
    // Readable as DATA on purpose: the focus ring is a CSS box-shadow, so without this the
    // question "which panel would this key go to?" would only be answerable from a screenshot —
    // exactly what docs/debug-tools-mcp.md forbids. (focus-scope refactor P2)
    focusedPanel: s.focusedPanel,
    // HMR staleness. `staleGameCode: true` means game code changed on disk but the editor
    // could NOT reload (unsaved scene work), so this world is running the OLD build —
    // every measurement taken here is suspect until it reloads. `hmrUpdates` is how many
    // hot updates have landed since boot; 0 means "nothing has changed under me". Exposed
    // as DATA because the failure mode is otherwise SILENT — neither a human nor an agent
    // can tell a stale editor from a working one by looking. (docs/editor-hmr.md)
    ...hmrFields(),
    colliderEditMode: s.colliderEditMode,
    fps: Math.round(getCurrentFPS()),
    // Liveness, NOT run mode. `playState`/`runMode`/`advancing` above only say what the
    // editor INTENDS to do; they read "playing"/true even when the rAF chain is dead and
    // nothing has ticked for minutes. `frameLoop.status` is the only field here that
    // answers "are frames actually being pumped right now?" — omitted while healthy so
    // the common payload stays small, present (with a `detail` string) the moment it is
    // not, because a wedge that an agent has to INFER from `fps: 0` is what made this
    // failure cost four debugging sessions.
    ...(frameLoopFields()),
    // Renderer-gate liveness — the INDEPENDENT twin of `frameLoop`. Measured: a viewport whose
    // renderer failed to init leaves the frame loop at a healthy 61fps while nothing renders and
    // the scene never loads, so `fps` cannot speak for this. Omitted once the renderer is ready.
    ...(rendererGateFields()),
    // GPU device loss / uncaptured errors — the cause a `frameLoop.status: 'stalled'` reading
    // is often only the symptom of. See `gpuFields`.
    ...(gpuFields()),
    // Game code that threw while the editor booted. The project is loaded DEGRADED — its
    // systems/traits are partly unregistered — so anything measured here may be wrong for
    // reasons that have nothing to do with the scene. Omitted when the project booted clean.
    ...(getGameBootFaults().length ? { gameBootFaults: getGameBootFaults() } : {}),
    entityCount: getAllEntities().length,
    selection: {
      entityId: s.selectedEntityId,
      entityIds: s.selectedEntityIds,
      asset: s.selectedAsset,
    },
    camera: readEditorCamera(),
    undo: { canUndo: canUndo(), canRedo: canRedo(), undoLabel: undoLabel(), redoLabel: redoLabel() },
    // Viewport + UI zoom, exposed as DATA so "what's the current zoom / viewport size" has a
    // Percept surface (previously answerable only via a raw CDP eval of window.*). `zoomFactor`
    // is the VS Code–style whole-app UI zoom (getPresentationScale is editor-calibrated to
    // webContents.getZoomFactor); `devicePixelRatio` is the raw backing-store ratio (display
    // scale × zoom). See docs/debug-tools-mcp.md.
    viewport: readViewport(),
    // Which on-screen surfaces have a bounds provider mounted RIGHT NOW. A 2D/3D entity aim
    // REQUIRES a `surface` (docs/enact.md), so without this a caller had to guess at exactly the
    // thing the requirement exists to stop it guessing about — and a batch, which cannot read a
    // response to recover from a refusal, would lose the whole batch to the guess. Cheap: it reads
    // the provider registry, not the scene.
    surfaces: mountedSurfaces(),
  };
}

/** CSS viewport size + zoom, read live from the renderer window. Guarded for the
 *  headless/SSR case (no `window`) so this stays safe if ever called off the renderer. */
function readViewport() {
  if (typeof window === 'undefined') return null;
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    zoomFactor: getPresentationScale(),
  };
}

// ── Param shapes ───────────────────────────────────────────────────────────

interface SetSelectionParams { entityId?: number | null; entityIds?: number[]; guid?: string; guids?: string[]; asset?: SelectedAsset | null }
interface CreateEntityParams { spec: CreateEntitySpec; parentId?: number; parentGuid?: string }
/** The prefab operations. The three `edit-*` actions drive PREFAB-EDIT MODE — opening a
 *  `.prefab.json` in isolation, saving the edited template back, and returning to the scene
 *  it was opened from. They are the only route that re-serializes a prefab file, which is why
 *  the bulk re-save sweep (#125, engine/scripts/resave-prefabs.sh) is built on them. */
type PrefabAction = 'instantiate' | 'create' | 'detach' | 'edit-open' | 'edit-save' | 'edit-exit';

interface PrefabParams {
  /** Which prefab operation. Callers reaching this op DIRECTLY (`runAgentOp`, `modoki_eval`) may
   *  use `action`; anything arriving via `POST /api/editor-action` MUST use `prefabAction`.
   *
   *  Why the second name exists: that route takes the OP NAME in `action` and strips it before
   *  relaying (`const { action: _omit, ...params }`), so a param called `action` is structurally
   *  unreachable through it — and `modoki_prefab`, which spread its args over the routing key,
   *  sent `action:'instantiate'` as the op name and got a 400 listing the valid ops. Every
   *  prefab call through the MCP failed that way. */
  prefabAction?: PrefabAction;
  action?: PrefabAction;
  /** instantiate / edit-open: prefab asset path. create: destination path to write. */
  path?: string;
  /** edit-open: discard unsaved live work instead of refusing (mirrors load-scene). */
  force?: boolean;
  /** instantiate: parent entity id (default root). */
  parentId?: number;
  /** instantiate: parent entity guid (stable; wins over parentId). */
  parentGuid?: string;
  /** create/detach: the entity to make a prefab from / detach. */
  entityId?: number;
  /** create/detach: the entity guid (stable; wins over entityId). */
  entityGuid?: string;
}

/** Raw selection write — no undo entry (the agent shouldn't pollute the human's
 *  undo stack just by selecting). Mirrors deleteEntitiesWithUndo's setState path. */
function setSelectionRaw(entityId: number | null, entityIds: number[]): void {
  useEditorStore.setState({ selectedEntityId: entityId, selectedEntityIds: entityIds, selectedAsset: null });
}

/** Resolve an entity ref to a LIVE numeric id: `guid` wins (stable across hot-reloads), else
 *  the numeric `id` if it still resolves; null when neither does. CLAUDE.md mandates addressing
 *  by guid because runtime ids are REASSIGNED on every scene reload — a recycled id silently
 *  targets the WRONG entity (data loss on delete/reparent), so guid must be accepted everywhere
 *  an id is. `set_transform`/`mutate_scene` already take {id|name|guid}; this brings the live-world
 *  structural ops to parity. (C7 re-audit.) */
function resolveLiveId(ref: { id?: number; guid?: string } | undefined): number | null {
  if (!ref) return null;
  if (ref.guid) { const e = findEntityByGuid(ref.guid); return e ? e.id() : null; }
  if (ref.id != null) return findEntity(ref.id) ? ref.id : null;
  return null;
}

/** Validate that `path` names a real asset of `expected` type before opening an editor on it.
 *  The open-*-editor ops used to mount a panel at ANY string path and return editor state
 *  (success), so a typo'd/wrong-type path silently produced a panel with no handles and no
 *  error — indistinguishable from "not mounted". Now a bad path is an actionable failure. (C7 re-audit.) */
function requireAssetPath(path: string | undefined, expected: string, op: string): void {
  if (typeof path !== 'string' || !path) throw new Error(`${op} requires { path } — the asset's served URL (see modoki_list_assets).`);
  if (!getGuidForPath(path)) throw new Error(`${op}: no asset found at "${path}" — it resolves to no manifest entry (typo, or wrong path). Find it with modoki_list_assets.`);
  const type = getAssetType(path);
  if (type && type !== expected) throw new Error(`${op}: "${path}" is a ${type}, not a ${expected} — this editor only opens ${expected} assets.`);
}

/** Resolve a required entity ref for a structural op, throwing an actionable error when it
 *  doesn't resolve — so a stale guid/id is a visible failure, never a silent wrong-target. */
function requireLiveId(ref: { id?: number; guid?: string } | undefined, op: string): number {
  const id = resolveLiveId(ref);
  if (id == null) {
    const what = ref?.guid ? `guid "${ref.guid}"` : ref?.id != null ? `id ${ref.id}` : 'entity ref';
    throw new Error(`${op}: ${what} matched no live entity — it may be stale (runtime ids are reassigned on every scene reload; prefer addressing by guid). Re-read it with get_scene_state.`);
  }
  return id;
}

/** The parent an entity should be created under / moved to, VALIDATED.
 *
 *  `parentGuid` was checked and `parentId` was not, so a stale or invented id sailed through as a
 *  literal. Measured 2026-07-30: `create-entity {spec:{kind:'primitive',mesh:'cube'}, parentId:99999}`
 *  returned `{id:141, name:'Cube', guid:…}` — a clean success — and produced an entity whose
 *  `EntityAttributes.parentId` pointed at nothing. An ORPHAN: it is in the world, it has a parent
 *  that does not exist, and nothing said so. Runtime ids are reassigned on every scene reload, so a
 *  stale `parentId` is not an exotic input — it is what an agent holds after any hot-reload.
 *
 *  `0` stays literal: it means ROOT, not "entity 0", and must never be resolved. */
function resolveParentId(p: { parentId?: number; parentGuid?: string }, op: string): number {
  if (p.parentGuid) return requireLiveId({ guid: p.parentGuid }, op);
  if (p.parentId) return requireLiveId({ id: p.parentId }, op);
  return 0; // omitted, or an explicit 0 → root
}

/** Make an agent asset-def edit UNDOABLE, the way the equivalent panel edit already is.
 *
 *  The five asset-authoring ops (`particle-set`, `anim-set-clip`, `anim-add-key`, `timeline-set`,
 *  `timeline-add-clip`) applied their change and pushed NOTHING, while `ParticleEditor` pushes a
 *  before/after entry to the SAME global `undoManager` for the identical edit. Two consequences,
 *  and the second is the damaging one: the agent's edit could not be undone at all, and a human
 *  pressing Cmd-Z after it silently unwound THEIR OWN earlier action — one they had no reason to
 *  think was next on the stack. (Audit S2.27; owner decision 2026-07-30 to close the asymmetry.)
 *
 *  `_isFileDirect` is load-bearing, not decoration. Without it, pushing the entry ALSO bumps
 *  `notifyEdited()`, so `hasUnsavedChanges()` reports the SCENE dirty for an asset-only edit — and
 *  the dirty-asset registry already tracks the asset's own pending write separately. That bump is
 *  what `dirtyAssets.test.ts` guards, and it is a real defect, not a technicality: a falsely-dirty
 *  scene self-blocks the file-direct routes that refuse when live work is unsaved.
 *
 *  `apply` is the same store call the op itself uses, so undo/redo replay the exact path the edit
 *  took rather than a reconstruction of it.
 *
 *  BOTH DIRECTIONS MUST MOVE THE PARKED WRITE, not just the live cache (independent review,
 *  2026-07-30). Persistence is manual-only, so the op parks its result in the dirty-asset registry
 *  and `save_all` is what commits it. When undo only re-applied the old def to the CACHE, the
 *  registry still held the new one — so the next `save_all` wrote to disk exactly the value the
 *  caller had just undone, and the undo silently un-did itself at save time.
 *
 *  Which way undo moves the registry depends on whether a write was ALREADY parked for this path
 *  before this edit (captured here, before the op's own `persistOrMarkDirty` runs):
 *   - already pending → the parked doc WAS `before`, so re-park `before`: state restored exactly.
 *   - not pending → disk already holds `before`, so DISCARD the parked write instead of re-parking.
 *     Re-parking would leave the asset dirty forever after an undo, and `hasUnsavedChanges()` would
 *     then block the file-direct routes over an edit that no longer exists. */
function pushAssetUndo<T>(
  label: string, before: T | null | undefined, after: T, apply: (def: T) => void,
  path: string, type: 'particle' | 'animation' | 'timeline',
): void {
  // No prior def means this is the FIRST write to that asset — there is no state to revert TO, so
  // an entry would be a lie about what undo can do. The write itself still stands.
  //
  // `== null` catches BOTH, deliberately: every asset cache getter returns `null` for a miss
  // (`getParticleEffect`, `getAnimationClip`, `getTimeline`), so a strict `=== undefined` check
  // never fired and we pushed an entry whose `undo()` applied `null` — restoring nothing while
  // consuming the human's Cmd-Z, which is worse than the missing entry it was meant to prevent.
  if (before == null) return;
  const wasPending = getDirtyAssetPaths().includes(path);
  pushAction({
    label,
    undo: () => {
      apply(before);
      if (wasPending) markAssetDirty(path, type, before);
      else discardDirtyAssets([path]);
    },
    redo: () => {
      apply(after);
      markAssetDirty(path, type, after);
    },
    kind: '!asset-edit',
    _isFileDirect: true,
  });
}

/** Refuse an asset-editing op whose `path` names no asset that exists.
 *
 *  `particle-set` / `anim-set-clip` / `timeline-set` REPLACE a def by path and, under manual
 *  persistence, park the write for `save_all` to flush. None of them checked that the path was a
 *  real asset — so a typo (or a file nothing has loaded) was applied to nothing, reported
 *  `{ok:true}`, and `save_all` later MATERIALISED it as a brand-new file. The agent believes it
 *  edited an existing effect; what it actually did was create a second one with a slightly wrong
 *  name, leaving the original untouched. Their granular siblings (`anim-add-key`,
 *  `timeline-add-clip`) already resolve the asset first — this brings the wholesale ops in line.
 *
 *  Returns a refusal object, or null when the path is fine. */
function requireExistingAsset(path: string, op: string, kind: string): { ok: false; error: string; hint: string } | null {
  if (getGuidForPath(path)) return null;
  return {
    ok: false,
    error:
      `${op}: no ${kind} asset exists at ${JSON.stringify(path)} — nothing was applied and nothing was parked. ` +
      'This op REPLACES an existing def; it does not create one, and a save would otherwise have ' +
      'written a brand-new file under this name while the asset you meant stayed untouched.',
    hint: `Check the path with modoki_list_assets (type=${kind}), or create it first with modoki_create_asset.`,
  };
}

/** WORLD-space Transform fields → the LOCAL fields actually stored, against the LIVE world.
 *
 *  The live twin of `sceneMutate.ts`'s `worldFieldsToLocal`, and it converts the WHOLE POSE for
 *  the same reason: with a rotated parent a world X depends on the child's world Y and Z, so
 *  converting one field against zeros would silently move the other axes.
 *
 *  TRS IS THE PARENT CONVENTION — deliberately, and it is why this no longer calls `worldToLocal3D`
 *  (owner decision, 2026-07-31; independent review, 2026-07-30).
 *
 *  A hierarchy in Modoki is TRS at every level, the way Unity's `Transform` is; a sheared parent
 *  (non-uniform scale ABOVE a rotation) is not a legal state. `worldToLocal3D` inverts the RAW
 *  composed matrix, so it is exact even under shear — and that made it the OUTLIER: the file path
 *  (`parentWorldTrs` → `worldToLocalTrs`) and the human 3D gizmo
 *  (`gizmoTransform.worldToLocalTransform`, fed the render cache's decomposed parent) both compose
 *  the chain and decompose ONCE. So the same `{space:'world'}` op landed the entity in a different
 *  place depending on whether an editor happened to be open, and neither answer matched a gizmo
 *  drag. Measured on a 2-level chain: requesting world (10,0,0) put it at (10,0,0) live and
 *  (12.638, 0.270, 0) headless. Authoring now speaks one language across all three.
 *
 *  SCOPE, also deliberate: `worldToLocal3D` itself is UNCHANGED. Physics uses it every frame to
 *  write a stepped body's world pose back into a parented local Transform, as do `games/sling`
 *  (fish steering) and `demos/forest-camp` (arrow attach) — simulation wants the exact inverse and
 *  a per-frame decompose is a cost with no authoring benefit. The split is authoring vs simulation,
 *  which is a real line, not two accidental conventions.
 *
 *  A ROOT entity's parent matrix is the identity, so this is an exact no-op there. */
/** Scratch for the parent-chain composition — this runs per set_transform op, not per frame,
 *  but allocating a Matrix4 per call for no reason is still noise. */
const _parentM = new THREE.Matrix4();

function worldFieldsToLocalLive(id: number, fields: Record<string, unknown>): { fields: Record<string, unknown> } | { error: string } {
  const entity = findEntity(id);
  const cur = entity?.get(Transform) as Record<string, number> | undefined;
  if (!cur) return { fields };
  const local = {
    x: cur.x ?? 0, y: cur.y ?? 0, z: cur.z ?? 0,
    rx: cur.rx ?? 0, ry: cur.ry ?? 0, rz: cur.rz ?? 0,
    sx: cur.sx ?? 1, sy: cur.sy ?? 1, sz: cur.sz ?? 1,
  };
  const w = getWorldTransform3D(id);
  const world = { x: w.x, y: w.y, z: w.z, rx: w.rx, ry: w.ry, rz: w.rz, sx: w.sx, sy: w.sy, sz: w.sz };
  // Root: world == local already, so no conversion is needed (and none is safe to apply — the
  // decompose round-trip would introduce float noise on untouched axes).
  const isRoot = (['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'] as const)
    .every((k) => Math.abs(world[k] - local[k]) < 1e-9);
  if (isRoot) return { fields };

  const wantWorld = mergeTrs(world, fields);
  // Compose the parent chain exactly, then decompose ONCE — byte-for-byte what `parentWorldTrs`
  // does on the file side, and what the render cache hands the gizmo. `getParentWorldMatrix3D` is
  // the composition; the decompose is what makes this the TRS convention rather than the exact one.
  const parentTrs = matrixToTrs(getParentWorldMatrix3D(id, getCurrentWorld(), _parentM));
  // Same refusal as the file path: a zero-scaled ancestor collapses every descendant onto its
  // origin, so the request has no solution and `decompose` would silently substitute an identity
  // parent. See `collapsedParentAxes`.
  const collapsed = collapsedParentAxes(parentTrs);
  if (collapsed) {
    return { error:
      `space:'world' is not solvable here: an ancestor has ZERO scale on ${collapsed.join('/')}, which `
      + 'collapses every descendant onto its origin, so no local transform can place this entity at the '
      + "requested world point. Give the ancestor a non-zero scale, or write space:'local'." };
  }
  const next = worldToLocalTrs(wantWorld, parentTrs);
  const all: Record<string, number> = {
    x: next.x, y: next.y, z: next.z, rx: next.rx, ry: next.ry, rz: next.rz, sx: next.sx, sy: next.sy, sz: next.sz,
  };
  // Write back the whole GROUP each named axis belongs to — see `persistedTrsKeys`, shared with
  // the file path so the two cannot diverge.
  const out: Record<string, unknown> = {};
  for (const k of persistedTrsKeys(fields)) out[k] = all[k];
  return { fields: out };
}

/** Resolve a `mutate_scene`-shaped entity ref ({id}|{name}|{guid}) against the LIVE world —
 *  the live-path twin of sceneMutate.ts's `resolveEntity` (which resolves against the FILE).
 *  `name` is not covered by `resolveLiveId` (structural ops only ever took id/guid), so this
 *  adds it for parity with the file-direct op vocabulary.
 *
 *  An AMBIGUOUS `name` is an error, not a first-match. It used to be `.find()`, and duplicate
 *  names are ordinary (three entities called "Enemy") — MEASURED on `games/3d-test`: with two
 *  entities named `DUP_probe`, `set_transform {name:'DUP_probe'}` moved ONE of them and returned
 *  `{ok:true, changed:1, errors:[], warnings:[]}`. The other was untouched and nothing said so.
 *  Inside a batch there is no intermediate response in which to notice, and the entity-aimed input
 *  path already refuses exactly this (see `entityResolve.ts`) — so the two halves of the agent
 *  surface disagreed about whether an ambiguous name is addressable. It is not. */
function resolveLiveEntityRef(ref: MutateEntityRef | undefined): { id: number } | { error: string } {
  if (!ref) return { error: 'no entity ref given — pass {guid} | {name} | {id}' };
  if (ref.guid) {
    const e = findEntityByGuid(ref.guid);
    return e ? { id: e.id() } : { error: `no LIVE entity with guid ${JSON.stringify(ref.guid)}` };
  }
  if (ref.id != null) {
    return findEntity(ref.id) ? { id: ref.id } : { error: `no LIVE entity with id ${ref.id}` };
  }
  if (ref.name) {
    const hits = getAllEntities().filter((en) => en.name === ref.name);
    if (hits.length === 0) return { error: `no LIVE entity named ${JSON.stringify(ref.name)}` };
    if (hits.length > 1) {
      const which = hits.map((e) => e.guid || `id:${e.id}`).join(', ');
      return { error: `${hits.length} LIVE entities are named ${JSON.stringify(ref.name)} (${which}) — address by guid` };
    }
    return { id: hits[0].id };
  }
  return { error: 'entity ref has none of {guid} | {name} | {id}' };
}

/** Core traits every entity needs — mirrors sceneMutate.ts's CORE_TRAITS. removeTrait refuses
 *  to drop these live too (a human can't remove them in the Inspector either). */
const LIVE_CORE_TRAITS = new Set(['Transform', 'EntityAttributes']);

/** The live-world twin of sceneMutate.ts's `applyOps` — same {@link MutateOp} vocabulary
 *  (setTrait / removeTrait / addEntity / removeEntity), applied to the running ECS world via
 *  the existing undoable `*WithUndo` helpers instead of a scene-file JSON object, wrapped in
 *  ONE composite undo entry (compositeAction.ts) so an N-op tool call is one Cmd-Z.
 *
 *  `setBaseScene` has NO live-world equivalent — it changes what the scene *loads*, not any
 *  live entity's state — so it is refused here entirely; the caller (the `/api/scene-mutate`
 *  route) keeps any call containing it on the file-direct path regardless of persistence mode
 *  (mcp-persistence.md Phase 2 "setBaseScene" caveat).
 *
 *  Deliberately NOT at full parity with `applyOps`: it does not detect unknown-field typos
 *  against the trait schema, and removeEntity does not scan for now-dangling UIAction
 *  references. Both are diagnostic niceties on the file-direct path (schema/warnings live
 *  there), not correctness requirements for the live world — a follow-up can port them if an
 *  agent actually hits one live. */
async function applySceneOpsLive(ops: MutateOp[]): Promise<{
  changed: number; errors: string[]; warnings: string[]; unresolved: MutateEntityRef[];
  created: Array<{ op: number; id: number; guid: string; name: string }>;
}> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const unresolved: MutateEntityRef[] = [];
  // What each addEntity op created, in op order (S3.12) — the live twin of applyOps' `created`.
  // Without it `changed:N` was the whole answer, so an agent had to re-find its own entity by
  // name, which this surface refuses when the name is ambiguous.
  const created: Array<{ op: number; id: number; guid: string; name: string }> = [];
  let changed = 0;
  const allTraitsList = getAllTraits();

  await runAsCompositeAction({ label: `Mutate Scene (${ops.length} op${ops.length === 1 ? '' : 's'})`, kind: '!mutate' }, () => {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const where = `op[${i}] (${op?.op ?? 'unknown'})`;
      try {
        if (op.op === 'setTrait') {
          const resolved = resolveLiveEntityRef(op.entity);
          if ('error' in resolved) { errors.push(`${where}: ${resolved.error}`); unresolved.push(op.entity); continue; }
          const id = resolved.id;
          if (!op.trait) { errors.push(`${where}: missing 'trait'`); continue; }
          const meta = allTraitsList.find((t) => t.name === op.trait);
          if (!meta) { errors.push(`${where}: unknown trait '${op.trait}' — list traits with modoki_list_traits`); continue; }
          if (op.space && op.trait !== 'Transform') {
            // Never silently ignore a parameter (§6) — mirrors the file path.
            errors.push(`${where}: 'space' applies only to trait 'Transform' (got '${op.trait}').`);
            continue;
          }
          let fields = op.fields ?? {};
          if (op.space === 'world') {
            const converted = worldFieldsToLocalLive(id, fields);
            if ('error' in converted) { errors.push(`${where}: ${converted.error}`); continue; }
            fields = converted.fields;
          }
          const entity = findEntity(id);
          if (Object.keys(fields).length === 0) {
            // No fields → tag presence, mirroring sceneMutate.ts (don't clobber existing data;
            // re-tagging an existing trait is a genuine no-op, not a change).
            if (entity && !entity.has(meta.trait)) { addTraitToEntitiesWithUndo([id], meta); changed++; }
          } else if (entity && !entity.has(meta.trait)) {
            // The entity doesn't have this trait yet — ADD it seeded with `fields`, mirroring
            // sceneMutate.ts's setTrait (merge onto an empty base when absent). Without this,
            // writeTraitFieldWithUndo below silently no-ops on a missing trait (it requires the
            // entity to already have it) while still reporting changed:1 and pushing an inert
            // undo entry — a live-path-only regression from file-direct parity, found while
            // testing the composite-batch removeTrait+removeEntity case.
            addTraitToEntitiesWithUndo([id], meta, fields);
            changed++;
          } else {
            // writeTraitFieldWithUndo already routes into prefab-INSTANCE overrides
            // (markFieldOverrideIfInstance) — the live-world equivalent of sceneMutate.ts's
            // traitWriteContainer comes for free from the existing helper, not reimplemented here.
            for (const [field, value] of Object.entries(fields)) writeTraitFieldWithUndo(id, meta, field, value);
            changed++;
          }
        } else if (op.op === 'removeTrait') {
          const resolved = resolveLiveEntityRef(op.entity);
          if ('error' in resolved) { errors.push(`${where}: ${resolved.error}`); unresolved.push(op.entity); continue; }
          const id = resolved.id;
          if (!op.trait) { errors.push(`${where}: missing 'trait'`); continue; }
          if (LIVE_CORE_TRAITS.has(op.trait)) { errors.push(`${where}: cannot remove core trait '${op.trait}'`); continue; }
          const meta = allTraitsList.find((t) => t.name === op.trait);
          if (!meta) { errors.push(`${where}: unknown trait '${op.trait}'`); continue; }
          const entity = findEntity(id);
          if (entity?.has(meta.trait)) { removeTraitFromEntitiesWithUndo([id], meta); changed++; }
          // Removing an absent trait is a genuine no-op, not an error (mirrors sceneMutate.ts).
        } else if (op.op === 'addEntity') {
          const parentRaw = op.parentId;
          // A string parentId is a GUID. An unresolvable one falls back to the root (0) — the
          // pre-existing behaviour, kept deliberately: a missing parent is not worth failing the
          // whole op over, and the entity is still created somewhere visible.
          let parentId = 0;
          if (typeof parentRaw === 'number') {
            // A NUMERIC parent was taken literally with no check, while the string/guid form below
            // was resolved and warned about — so the same mistake was loud one way and silent the
            // other, and a stale id (they are reassigned on every scene reload) produced an ORPHAN:
            // an entity whose parentId points at nothing, reported as a clean success. Same
            // treatment for both now: resolve, else warn and fall back to the root.
            if (parentRaw === 0 || resolveLiveId({ id: parentRaw }) != null) parentId = parentRaw;
            else warnings.push(`${where}: parent id ${parentRaw} matched no live entity (runtime ids are reassigned on every scene reload — prefer a guid) — parented to the scene root instead`);
          } else if (typeof parentRaw === 'string') {
            const pr = resolveLiveEntityRef({ guid: parentRaw });
            if ('id' in pr) parentId = pr.id;
            else warnings.push(`${where}: parent guid ${JSON.stringify(parentRaw)} did not resolve (${pr.error}) — parented to the scene root instead`);
          }
          const specs: TraitSpec[] = Object.entries(op.traits ?? {}).map(([name, data]) => ({
            name, data: data === true ? undefined : data as Record<string, unknown>,
          }));
          if (!specs.some((s) => s.name === 'EntityAttributes')) {
            specs.push({ name: 'EntityAttributes', data: { name: op.name ?? 'New Entity', parentId } });
          } else if (op.name) {
            const attrs = specs.find((s) => s.name === 'EntityAttributes')!;
            attrs.data = { ...(attrs.data ?? {}), name: op.name, parentId };
          }
          const newId = createEntityWithUndo(op.name ?? 'Add Entity', parentId, specs, () => {});
          if (newId == null) { errors.push(`${where}: nothing was created (an unregistered trait in ${JSON.stringify(Object.keys(op.traits ?? {}))}?)`); continue; }
          changed++;
          created.push({ op: i, id: newId, guid: ensureGuid(newId), name: op.name ?? 'New Entity' });
        } else if (op.op === 'removeEntity') {
          const resolved = resolveLiveEntityRef(op.entity);
          if ('error' in resolved) { errors.push(`${where}: ${resolved.error}`); unresolved.push(op.entity); continue; }
          const id = resolved.id;
          deleteEntitiesWithUndo([id]);
          changed++;
        } else {
          errors.push(`${where}: '${(op as { op?: string }).op}' has no live-world equivalent`);
        }
      } catch (e) {
        errors.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });

  return { changed, errors, warnings, unresolved, created };
}

// ── Registration ─────────────────────────────────────────────────────────────

let registered = false;

/** `wait-for-edit` (#28) timeout bounds. Exported so the backend relay
 *  (`editorBackendRouter.ts`) and the MCP tool (`modoki-mcp/src/tools/editor.ts`) can give
 *  their OWN transport timeouts generous headroom over this op's internal deadline — a
 *  relay/HTTP timeout shorter than the op's own wait would kill a legitimate long park and
 *  report it as a dead backend rather than the normal `timedOut:true` answer. */
export const WAIT_FOR_EDIT_DEFAULT_MS = 30_000;
/** Upper bound on a single park. Long enough for a human to look away and make one edit;
 *  short enough that a wedged/disconnected renderer doesn't hold an HTTP request open
 *  indefinitely (this is a blocking long-poll, not an SSE stream — see the #28 brief for why
 *  SSE was passed over). A caller that wants to keep watching just calls again with the
 *  returned `nextSeq`. */
export const WAIT_FOR_EDIT_MAX_MS = 120_000;
/** Floor — guards against a 0/negative timeoutMs turning this into a busy-poll. */
export const WAIT_FOR_EDIT_MIN_MS = 50;

/** Total item count across a timeline's tracks (clips / markers / cues / spans), tolerant of both a
 *  raw partial doc and a normalized one — so timeline-set can compare pre/post normalization and detect
 *  silently-dropped malformed items. Exported for the F12 regression test. (F12) */
export function countTimelineItems(t: Partial<TimelineDef> | undefined): number {
  const tracks = (t?.tracks ?? []) as unknown as Array<Record<string, unknown>>;
  let n = 0;
  for (const tr of tracks) {
    for (const key of ['clips', 'markers', 'cues', 'spans']) {
      const arr = tr[key];
      if (Array.isArray(arr)) n += arr.length;
    }
  }
  return n;
}

export function registerEditorAgentOps(): void {
  // Every op registered here is the AGENT acting (human actions come through the UI,
  // not these ops). Shadow registerAgentOp so any editor-activity events an op emits
  // are tagged source:'agent' — so Claude can tell its own edits from the human's in
  // the editor-journal (Phase 7 review). Reads emit nothing, so wrapping them is inert.
  const registerAgentOp = (name: string, handler: AgentOpHandler): void =>
    _registerAgentOp(name, (params) => withEditorActor('agent', () => handler(params)));
  if (registered) return;
  registered = true;

  // Suppress scene hot-reload while Playing/Paused: a disk edit would reload the
  // live world but Stop reverts to the Play-press snapshot, discarding it. The
  // backend also consults this (via editor-state) to refuse mutate-while-playing.
  setSceneReloadSuppressor(() => {
    const s = getPlayState();
    return s === 'stopped' ? null : `game is ${s} — stop the game (Stop) before editing the scene`;
  });

  // ── State read ──
  registerAgentOp('editor-state', () => readEditorState());

  // Editor-renderer JS eval — the editor twin of device_eval (game-debug MCP). Runs `code`
  // as a function body (so `return x` yields a value) and safe-stringifies the result IN the
  // renderer, so nothing non-cloneable (a DOM node, a fiber, window) has to cross the M→R IPC
  // bridge — a JSON string always does. Unblocks reading/poking live renderer state (a global,
  // window.innerWidth, devicePixelRatio, dispatching a bridge event) without a raw CDP client.
  // Editor-only: this whole module is stripped from shipped game builds.
  // Registered UNWRAPPED (_registerAgentOp) on purpose. The shadow above holds ambient
  // actor='agent' for a handler's whole lifetime, and an eval body runs LONG — it can loop, await,
  // or call modoki.waitForEdit() and park. Holding the ambient actor across that would tag every
  // concurrent HUMAN edit as 'agent'. Attribution is instead applied PER CALL inside makeEvalApi(),
  // which is both accurate and bounded.
  //
  // `timeoutMs` bounds the WHOLE body (since #145 made `await` parse, the body is what runs), not
  // just a returned promise. The route sizes the relay deadline from the same number — see
  // `/api/eval` in editorBackendRouter.ts; the two must stay ordered or the relay wins the race
  // and reports a dead backend instead of this op's own message.
  //
  // ⚠️ "UNBOUNDED … park for two minutes", as this comment used to read, was never true and is
  // still not. An eval body has ALWAYS been raced against a deadline; what changed is that the
  // deadline is now reachable and adjustable. The ceiling is EDITOR_EVAL_MAX_TIMEOUT_MS (25s), so a
  // `modoki.waitForEdit({timeoutMs: 120_000})` nested in an eval CANNOT run its full park — budget
  // the inner op under the outer one, or call waitForEdit as its own tool.
  _registerAgentOp('eval', (params) => {
    const p = (params ?? {}) as { code?: string; timeoutMs?: unknown };
    return handleEval(p.code ?? '', makeEvalApi(), clampEvalTimeout(p.timeoutMs, EVAL_ASYNC_TIMEOUT_MS, EDITOR_EVAL_MAX_TIMEOUT_MS));
  });

  // Discovery for `eval`: lists the generated `modoki` scripting surface (op list + camelCase
  // method names + the fixed call/ops/api/composite helpers) so an agent never has to read
  // source to find what modoki_eval can call. A pure sync read — still goes through the local
  // registerAgentOp shadow above like every other op here, which is inert on a read.
  registerAgentOp('eval-api', () => ({
    ops: makeEvalApi().ops(),
    usage: [
      'modoki.call(op, params) — invoke any op by its raw kebab-case name',
      'modoki.<camelCaseName>(params) — generated shortcut for each op above',
      'modoki.ops() — same {op, method} listing as this discovery call, from inside eval code',
      'modoki.api(path, init) — fetch() a host route with no matching op (list_assets, write_asset, import_file, build, add_native_target, the OTA tools, mutate_scene\'s file-direct path, …), routed through backendFetch',
      'modoki.composite(label, fn) — collapse every mutation fn() makes into ONE undo entry',
    ],
    note: 'Call modoki_eval_api (or GET /api/eval-api) any time to see this listing again.',
  }));

  // Editor Percept (Phase 7 + V3): the human-activity stream (`!`-prefixed). `merged`
  // also returns the game journal AND a single-axis `timeline` that interleaves both by
  // the shared `cap` capture counter — so Claude reads one ordered story ("pressed Play
  // → set timeScale 0.3 → @match on tick 84 → paused").
  registerAgentOp('editor-journal', (params) => {
    const p = (params ?? {}) as { type?: string; source?: 'human' | 'agent'; since?: number; sinceCap?: number; clear?: boolean; merged?: boolean; limit?: number };
    // `editor` is the editor-only view: filtered by type/source and cursored by the
    // editor-local `since` (a `seq`). `timeline` is the single-axis merged view.
    //
    // Tail + histogram at the OP, not in `readEditorJournal` — the producer stays whole for
    // any in-process reader. The 2,000-event ring runs ~130–253 bytes/event (transform and
    // trait-edit events carry old→new values), so an unbounded read is ~54–126k tokens.
    // Cursor semantics (C7 re-audit): `since`/`sinceCap` are FORWARD cursors, so a CURSORED poll
    // returns the OLDEST events after the cursor (takeHead) + a nextSeq/nextCap to advance
    // contiguously — NOT the newest tail (takeTail), which permanently drops the oldest-after-
    // cursor block when >limit events accrue between polls (they have a lower seq/cap than the
    // returned window, so no forward cursor can ever reach them). The cursor-LESS "what just
    // happened" call keeps the newest tail.
    const histogram = <T>(items: readonly T[], typeOf: (t: T) => string): Record<string, number> => {
      const b: Record<string, number> = {};
      for (const it of items) { const k = typeOf(it); b[k] = (b[k] ?? 0) + 1; }
      return b;
    };
    const editorAll = readEditorJournal({ type: p.type, source: p.source, since: p.since });
    const edCursored = p.since != null;
    const ed = (edCursored ? takeHead : takeTail)(editorAll, p.limit, EDITOR_JOURNAL_TAIL_DEFAULT);
    const result: {
      editor: unknown[]; editorTotal: number; byType: Record<string, number>;
      truncated?: boolean; hint?: string; nextSeq?: number;
      game?: unknown[]; gameTotal?: number; gameByType?: Record<string, number>;
      timeline?: unknown[]; timelineTotal?: number; nextCap?: number;
    } = { editor: ed.items, editorTotal: editorAll.length, byType: histogram(editorAll, (e) => String(e.type ?? '?')) };
    if (ed.truncated) {
      result.truncated = true;
      if (edCursored) {
        const lastSeq = (ed.items[ed.items.length - 1] as { seq?: number } | undefined)?.seq;
        if (lastSeq != null) result.nextSeq = lastSeq;
        result.hint = `Showing the OLDEST ${ed.items.length} of ${editorAll.length} editor events after since=${p.since} (oldest first). Poll again with since=${result.nextSeq} to continue contiguously with no gap; raise limit=N to fetch more per poll.`;
      } else {
        result.hint = tailHint('editor events', ed.items.length, editorAll.length, ', or narrow with type=/source=/since=');
      }
    }
    if (p.merged) {
      const game = journalEvents();
      // `merged` was the worst payload on this surface: BOTH full rings, twice over (the raw
      // `game` array AND the same events again inside `timeline`). A busy Play session is
      // ~582k tokens of `@contact`. Both are tailed; `sinceCap` remains the precise cursor.
      const g = tailWithCounts(game, (e) => String(e.type ?? '?'), { limit: p.limit, defaultLimit: JOURNAL_TAIL_DEFAULT });
      result.game = g.items; // raw game stream (tick-stamped), kept for back-compat
      result.gameTotal = g.total;
      result.gameByType = g.byType;
      // Single axis: BOTH streams windowed by the SAME `sinceCap` cursor (a `cap`),
      // then interleaved by the globally-unique shared cap counter — so incremental
      // polling (pass the last timeline cap as sinceCap) yields a coherent slice, not
      // (a few new editor events) + (the entire game journal). The editor `type`/
      // `source`/`since` filters shape only the `editor` array, NOT the timeline (which
      // is the full correlated story). cap is unique ⇒ no ties ⇒ a total order.
      const capFloor = p.sinceCap ?? -Infinity;
      const edAll = readEditorJournal(); // unfiltered — the timeline shows everything
      const timeline = [
        ...edAll.filter((e) => e.cap > capFloor).map((e) => ({ stream: 'editor' as const, ...e })),
        ...game.filter((e) => (e.cap ?? 0) > capFloor).map((e) => ({ stream: 'game' as const, ...e })),
      ].sort((a, b) => (a.cap ?? 0) - (b.cap ?? 0));
      // Window the interleaved axis: HEAD (oldest-after-cursor) when sinceCap is set so an
      // incremental poll is lossless + contiguous; the newest TAIL for a bare "what just
      // happened" call. Both via the shared helpers (a hand-rolled slice re-created the
      // `slice(-0)` whole-array bug on limit=0, and swallowed a NaN limit too).
      result.timelineTotal = timeline.length;
      const tlCursored = p.sinceCap != null;
      const tl = (tlCursored ? takeHead : takeTail)(timeline, p.limit, EDITOR_JOURNAL_TAIL_DEFAULT);
      result.timeline = tl.items;
      if (tl.truncated) {
        result.truncated = true;
        if (tlCursored) {
          const lastCap = (tl.items[tl.items.length - 1] as { cap?: number } | undefined)?.cap;
          if (lastCap != null) result.nextCap = lastCap;
          result.hint = `Showing the OLDEST ${tl.items.length} of ${timeline.length} timeline events after sinceCap=${p.sinceCap} (oldest first). Poll again with sinceCap=${result.nextCap} to continue contiguously with no gap; raise limit=N for more per poll.`;
        } else {
          result.hint = tailHint('timeline events', tl.items.length, timeline.length, ', or cursor with sinceCap=<last cap>');
        }
      }
    }
    if (p.clear) clearEditorJournal();
    return result;
  });

  // ── HTML5 drag-and-drop (Enact Phase 1) ── synthesize the dragstart→drop
  // sequence the trusted pointer-drag can't emit (Hierarchy reparent, Assets
  // file-move, Skin sprite-onto-part). Renderer-DOM, so dev + DMG both work.
  // ── Actor lease ── the trusted-input seam declaring itself, so injected input is
  // journaled as `agent` instead of masquerading as the human (measured: modoki_tap's
  // !select said source:"human"). Registered as a plain renderer op rather than through
  // the wrapper above, because it MANAGES attribution and must not be attributed itself.
  _registerAgentOp('actor-lease', (params) => {
    const p = (params ?? {}) as { open?: boolean; id?: number; ttlMs?: number };
    if (p.open) return { id: openActorLease('agent', p.ttlMs) };
    if (typeof p.id === 'number') closeActorLease(p.id);
    return { ok: true };
  });

  // ── wait-for-edit (#28) ── long-poll twin of editor-journal: park until the human does
  // something instead of the agent polling in a loop. Registered as a plain renderer op
  // (bypassing the `registerAgentOp` wrapper above) DELIBERATELY: that wrapper holds the
  // ambient actor='agent' for the whole lifetime of an async handler (see withEditorActor's
  // own doc — "the window spans the await"), and this handler can legitimately park for up
  // to WAIT_FOR_EDIT_MAX_MS. Wrapping it would mis-attribute any HUMAN edit committed
  // anywhere in the editor during that entire window as source:'agent' — silently defeating
  // the one thing this tool exists to report. Same reasoning as 'actor-lease' above: this op
  // manages/observes attribution, so it must not itself be attributed.
  _registerAgentOp('wait-for-edit', (params) => {
    const p = (params ?? {}) as { type?: string; source?: 'human' | 'agent'; since?: number; timeoutMs?: number };
    const requested = typeof p.timeoutMs === 'number' && Number.isFinite(p.timeoutMs) ? p.timeoutMs : WAIT_FOR_EDIT_DEFAULT_MS;
    const timeoutMs = Math.max(WAIT_FOR_EDIT_MIN_MS, Math.min(WAIT_FOR_EDIT_MAX_MS, requested));
    return waitForEditorJournal({ type: p.type, source: p.source ?? 'human', since: p.since }, timeoutMs);
  });

  // `getEditVersion` lets the op distinguish "the target ACCEPTED this payload type" from
  // "the handler actually did something" — measured: a texture dropped on a Hierarchy entity
  // row reported ok:true/accepted:true and made no edit at all.
  registerAgentOp('dom-dnd', (params) => performDomDnd((params ?? {}) as DomDndParams, { editVersion: getEditVersion }));

  // ── Selection ──
  registerAgentOp('set-selection', (params) => {
    const p = (params ?? {}) as SetSelectionParams;
    if (p.asset !== undefined) {
      useEditorStore.setState({ selectedAsset: p.asset, selectedEntityId: null, selectedEntityIds: [] });
      return readEditorState();
    }
    // Resolve every requested ref to a LIVE id (guid wins), keeping only ids that resolve.
    // Selecting a nonexistent/stale id used to "succeed" and echo it back as selected, so a
    // following gizmo / collider-edit / focus silently acted on nothing. Now a fully-unresolved
    // request fails, and a partial one reports what was skipped. No refs at all = clear. (C7 re-audit.)
    const requested: Array<{ id?: number; guid?: string }> = [
      ...(p.guids ?? []).map((guid) => ({ guid })),
      ...(p.guid != null ? [{ guid: p.guid }] : []),
      ...(p.entityIds ?? []).map((id) => ({ id })),
      ...(p.entityId != null ? [{ id: p.entityId }] : []),
    ];
    const resolved: number[] = [];
    const missing: Array<{ id?: number; guid?: string }> = [];
    for (const r of requested) {
      const id = resolveLiveId(r);
      if (id == null) missing.push(r);
      else if (!resolved.includes(id)) resolved.push(id);
    }
    if (requested.length && resolved.length === 0) {
      throw new Error('set-selection: none of the requested entities resolve to a live entity (ids are reassigned on scene reload — prefer guid). Re-read them with get_scene_state.');
    }
    setSelectionRaw(resolved.length ? resolved[resolved.length - 1] : null, resolved);
    const state = readEditorState();
    return missing.length
      ? { ...state, skipped: missing, warning: `${missing.length} requested entity ref(s) matched no live entity and were skipped` }
      : state;
  });

  // ── Gizmo ──
  registerAgentOp('set-gizmo', (params) => {
    const p = (params ?? {}) as { mode?: 'translate' | 'rotate' | 'scale'; space?: 'world' | 'local' };
    const store = useEditorStore.getState();
    if (p.mode) store.setGizmoMode(p.mode);
    if (p.space) store.setGizmoSpace(p.space);
    return readEditorState();
  });

  // ── SceneView mode + collider-edit ── the toolbar's native <select> ('3d'|'ui')
  // and the Collider-edit toggle can't be driven by trusted input (native popup),
  // so expose them as ops. 'ui' mode mounts the 2D overlay where Collider2D vertex
  // editing (and its interaction-handle provider) lives.
  registerAgentOp('set-scene-view-mode', (params) => {
    const p = (params ?? {}) as { mode?: '3d' | 'ui' };
    if (p.mode === '3d' || p.mode === 'ui') useEditorStore.getState().setSceneViewMode(p.mode);
    return readEditorState();
  });
  // Set the KEYBOARD SCOPE — which panel the keymap dispatcher resolves chords against
  // (focus-scope refactor P7). Without this, an agent's only way to steer a keypress was
  // to tap something first and hope the click landed in the right panel; after scoping
  // landed, a bare `w` sent with the wrong panel focused simply does nothing, silently.
  //
  // Deliberately separate from `focus-element` (DOM focus): clicking a Hierarchy ROW moves
  // the keyboard scope but NOT document.activeElement, so the two are genuinely different
  // questions. Returns the resulting scope so the caller can confirm rather than assume.
  registerAgentOp('set-focus-scope', (params) => {
    const p = (params ?? {}) as { panel?: string | null };
    if (p.panel !== undefined) useEditorStore.getState().setFocusedPanel(p.panel);
    return { ok: true, focusedPanel: useEditorStore.getState().focusedPanel };
  });
  registerAgentOp('set-collider-edit', (params) => {
    const p = (params ?? {}) as { on?: boolean };
    if (typeof p.on === 'boolean') useEditorStore.getState().setColliderEditMode(p.on);
    return readEditorState();
  });
  // Open the Particle Editor dock panel on a .particle.json (normally a double-click in
  // Assets). Mounts CurveEditor/GradientEditor, whose interaction-handle providers then
  // register — so the agent can reach the size/opacity curve points + gradient stops.
  registerAgentOp('open-particle-editor', (params) => {
    const p = (params ?? {}) as { path?: string; name?: string };
    requireAssetPath(p.path, 'particle', 'open-particle-editor');
    const name = p.name ?? p.path!.split('/').pop()?.replace(/\.particle\.json$/, '') ?? p.path!;
    useEditorStore.getState().openParticleEditor({ path: p.path!, type: 'particle', name });
    return readEditorState();
  });
  // Open the Sprite slicer / 9-slice modal on a texture (normally the Texture-Inspector
  // buttons). Selects the texture + requests the modal → its handle providers mount.
  registerAgentOp('open-sprite-editor', (params) => {
    const p = (params ?? {}) as { path?: string; name?: string };
    requireAssetPath(p.path, 'texture', 'open-sprite-editor');
    useEditorStore.getState().requestTextureEditor(p.path!, 'sprite', p.name);
    return readEditorState();
  });
  registerAgentOp('open-nine-slice-editor', (params) => {
    const p = (params ?? {}) as { path?: string; name?: string };
    requireAssetPath(p.path, 'texture', 'open-nine-slice-editor');
    useEditorStore.getState().requestTextureEditor(p.path!, 'nineslice', p.name);
    return readEditorState();
  });

  registerAgentOp('focus-entity', (params) => {
    // Accept guid (stable) or id; validate it resolves before claiming success. Report whether a
    // SceneView was actually mounted to frame it — the op used to return {ok:true} for a
    // nonexistent id AND when no viewport was open, so the camera didn't move either way. (C7 re-audit.)
    const p = (params ?? {}) as { id?: number; guid?: string };
    const id = requireLiveId(p, 'focus-entity');
    const framed = focusEntityInSceneView(id);
    if (!framed) return { ok: false, framed: false, reason: 'no SceneView viewport is mounted, so there is nothing to frame the entity in (open/focus the 3D SceneView first).' };
    return { ok: true, framed: true };
  });

  // ── Play control ── matches the GameView transport bar.
  registerAgentOp('play', async () => { await enterPlay(); return readEditorState(); });
  // `resume` and `pause` are TRANSITIONS, and both used to accept any state and report the editor
  // state back as a success. From STOPPED, `resume` ran a full `enterPlay()` — a snapshot + run,
  // i.e. the thing `play` does — so an agent that meant "carry on from where we paused" silently
  // restarted the game from the authored snapshot and lost the state it was inspecting. `pause`
  // from stopped was a plain no-op reported as done. `step` has guarded its precondition since it
  // was written; these two now match it (§8: a no-op the caller asked for as a change is a failure).
  registerAgentOp('resume', async () => {
    const st = getPlayState();
    if (st !== 'paused') {
      return {
        ok: false,
        error: `resume requires the PAUSED state (currently: ${st}). From '${st}' this would run a full Play — a fresh snapshot + run — which discards whatever you were inspecting, so it is refused rather than done silently.`,
        playState: st,
        hint: st === 'stopped' ? "Use action:'play' to start the game." : "Already running — action:'pause' first if you meant to freeze it.",
      };
    }
    await enterPlay();
    return readEditorState();
  });
  registerAgentOp('stop', async () => { await stopPlay(); return readEditorState(); });
  registerAgentOp('pause', () => {
    const st = getPlayState();
    if (st !== 'playing') {
      return {
        ok: false,
        error: `pause requires the PLAYING state (currently: ${st}) — nothing to freeze, so this would be a no-op reported as success.`,
        playState: st,
        hint: st === 'stopped' ? "Use action:'play' first." : 'Already paused.',
      };
    }
    pausePlay();
    return readEditorState();
  });
  // Step one frame while Paused: flip to 'playing' around a single synchronous
  // frame, then freeze again (exactly GameView's stepOnce).
  registerAgentOp('step', () => {
    if (getPlayState() !== 'paused') return { ok: false, error: 'step requires paused state', playState: getPlayState() };
    setPlayState('playing');
    stepOneFrame();
    setPlayState('paused');
    return readEditorState();
  });

  // ── Undo / redo ── (async — undo/redo may run async undo closures).
  // `did:false` means the stack was empty. It is REPORTED, not thrown: "nothing to undo" is a
  // legitimate answer, and the state below shows what actually happened. (C7 note: an undo
  // whose target entity was destroyed by a scene hot-reload still pops the entry — see the C7
  // save-state audit in docs/connect-claude-code.md; verify with get_scene_state, not `did`.)
  registerAgentOp('undo', async () => { const did = await undo(); return { did, ...readEditorState() }; });
  registerAgentOp('redo', async () => { const did = await redo(); return { did, ...readEditorState() }; });

  // ── Scene management ──
  // load-scene / new-scene SWAP THE WORLD, so anything created live and not saved is gone —
  // from the world, the file, AND the undo stack (swapHistory rebinds). They used to report
  // {ok:true, entityCount:12}, which looks perfectly healthy while the entity you just made
  // no longer exists anywhere. Refuse by default; `force` discards deliberately. (C7)
  const guardUnsaved = (op: string, force: boolean | undefined) => {
    if (force || !hasUnsavedChanges()) return;
    // S3.11 — name the ACTUAL cause. `hasUnsavedChanges()` has two independent ones, and the
    // fixed string blamed only the first: an agent whose pending work was a dirty
    // particle/anim/timeline doc was sent looking for live entities it had never created. Both
    // clear with save_all; the difference is what `force:true` would discard.
    const { sceneDirty, dirtyAssetPaths, dirtyScenes } = unsavedChangeCauses();
    const causes: string[] = [];
    if (sceneDirty) causes.push('LIVE-WORLD scene edits (e.g. from create_entity / duplicate_entity / prefab / mutate_scene, which do NOT save)');
    if (dirtyAssetPaths.length) causes.push(`${dirtyAssetPaths.length} pending ASSET edit(s) awaiting a save: ${dirtyAssetPaths.join(', ')}`);
    // Third cause: a non-primary loaded scene still dirty (a base whose write failed in a
    // partial save_all). Without it a refusal driven by this alone would name no cause.
    if (dirtyScenes.length) causes.push(`${dirtyScenes.length} non-primary loaded scene(s) with edits still only in memory (guid(s): ${dirtyScenes.join(', ')}) — a previous save_all may have failed to write them`);
    throw new Error(
      `${op}: the editor has UNSAVED work — ${causes.join(' AND ')}. ${op} swaps the world, so ` +
      `${sceneDirty ? 'the scene edits would be destroyed (gone from the world, the file, and the undo stack)' : 'the pending asset writes would be lost'}` +
      `. Run modoki_save_all first, or pass force:true to discard ${causes.length > 1 ? 'them' : 'it'} deliberately.`,
    );
  };
  registerAgentOp('load-scene', async (params) => {
    const { path, force } = (params ?? {}) as { path: string; force?: boolean };
    if (!path) throw new Error('load-scene requires { path }');
    guardUnsaved('load-scene', force);
    const ok = await loadScene(path);
    if (!ok) throw new Error(`load-scene FAILED for ${path} — the scene was not loaded (does the path exist?).`);
    return { ok, ...readEditorState() };
  });
  registerAgentOp('new-scene', (params) => {
    const { force } = (params ?? {}) as { force?: boolean };
    guardUnsaved('new-scene', force);
    newScene();
    setSelectionRaw(null, []);
    return readEditorState();
  });
  // save_all is the tool the whole "create live, then edit the file" story depends on, so it
  // must never claim a write that didn't happen. It used to hardcode {ok:true} over a
  // void saveAll() that swallowed BOTH a user cancel and a failed write — reproducing the
  // exact bug save_all exists to fix, with the fix confirming it had worked. (C7)
  //
  // allowDialog:false is load-bearing: with no path yet (after new_scene) the human path
  // opens a NATIVE Save panel, which is modal and only a human can dismiss — an agent call
  // hung ~60s to a 504 AND blocked every later renderer-bound call until someone clicked
  // Cancel. Take an explicit `path` instead, and say so when we need one.
  registerAgentOp('save-all', async (params) => {
    const { path: savePath } = (params ?? {}) as { path?: string };
    // Prefab-edit mode deliberately NULLS the scene path so a normal save can't target a real
    // file (prefabEdit.ts) — the human paths honour that via isEditingPrefab(). The agent path
    // must too, and MORE so now that it takes an explicit `path`: without this the op would
    // serialize the SYNTHETIC prefab-edit world (the prefab's entities, expanded, plus the
    // throwaway __PrefabEdit* light/HDR scaffolding) straight over a real scene file, then
    // re-point the scene path and clear the dirty flag — reporting {ok:true}. Worse, the
    // needs-path error below actively STEERS an agent into it ("pass an explicit path"), which
    // is exactly what it hits when the human simply happens to be editing a prefab. (C7)
    if (isEditingPrefab()) {
      throw new Error(
        'save-all: the editor is in PREFAB-EDIT mode — its world is a synthetic prefab scene, ' +
        'not a real one, so saving it to a scene path would overwrite that scene with prefab ' +
        'scaffolding. Use the prefab editor\'s own save (Save Prefab), or leave prefab-edit mode first.',
      );
    }
    const r = await saveAll({ path: savePath, allowDialog: false });
    // PARTIAL IS A FAILURE (conventions §5). The primary scene saving does not mean Save All
    // succeeded: a dirty BASE scene that could not be serialized or written was previously just a
    // `console.error` + `continue`, and this returned `{ok:true}`. The edit then lived only in
    // memory, and a later build — which reads FILES — shipped without it, with nothing saying why.
    // Two independent partial-failure channels, and the op reported ok:true through BOTH:
    // other loaded SCENES (`r.failed`) and parked ASSET writes (`r.assets.failed`, e.g. a
    // particle/anim def whose disk write was rejected — it stays pending and hasUnsavedChanges()
    // stays true, but the agent was told the save succeeded).
    const sceneFails = (r.failed ?? []).map((f) => `scene ${f.path} (${f.reason})`);
    const assetFails = (r.assets?.failed ?? []).map((f) => `asset ${f.path} (${f.error})`);
    const allFails = [...sceneFails, ...assetFails];
    if (allFails.length) {
      throw new Error(
        `save-all PARTIALLY failed: the primary scene ${r.saved ? `saved to ${r.path}` : 'did not save'}, but ` +
        `${allFails.length} item(s) did NOT: ${allFails.join('; ')}. Those changes are still in the ` +
        `live world / pending only, and stay marked dirty — a build reads FILES and would ship ` +
        `WITHOUT them. Fix the cause and call save_all again.`,
      );
    }
    if (r.saved) return { ok: true, scenePath: r.path, ...(r.extraSaved?.length ? { extraSaved: r.extraSaved } : {}) };
    if (r.reason === 'needs-path') {
      throw new Error(
        'save-all: this scene has no path yet (new_scene never saved), and the Save-As panel ' +
        'needs a human. Pass an explicit path, e.g. save_all { path: "/assets/scenes/my-scene.scene.json" }.',
      );
    }
    if (r.reason === 'playing') {
      throw new Error('save-all: BLOCKED during Play — saving now would bake the runtime world (physics-settled positions, spawned entities) over your authored scene, and Stop would revert the live world anyway. Stop the editor first (modoki_play_control {action:"stop"}).');
    }
    throw new Error(`save-all FAILED (${r.reason}) for ${r.path ?? '(no path)'} — NOTHING was written to disk.`);
  });

  /** The counterpart to `save-all` for PARKED ASSET WRITES: drop them instead of persisting them.
   *
   *  Manual persistence shipped with only one exit from the dirty-asset registry — a save — so an
   *  exploratory particle/anim/timeline edit could not be abandoned. Re-applying the previous def
   *  looks like an undo and is not one: it re-parks a write (still dirty, still committed by the
   *  next save) and it writes back the MIGRATED def, so a legacy `gravity: 6` returns as
   *  `[0,-6,0]`. Measured on `confetti.particle.json` — the live smoke suite reported that it had
   *  restored the asset while leaving exactly that residue.
   *
   *  A BARE CALL IS REFUSED. Discarding every pending write is the destructive default that
   *  `set_selection` taught us not to ship: there, a bare call cleared the selection, so one
   *  misspelled argument key silently became "clear everything". The caller must name `paths`, or
   *  say `all:true` and mean it. The refusal lists what is pending, so the naming is a copy-paste. */
  registerAgentOp('discard-asset-edits', (params) => {
    const p = (params ?? {}) as { paths?: string[]; all?: boolean };
    const pending = getDirtyAssetPaths();
    if (p.paths !== undefined && !Array.isArray(p.paths)) throw new Error('discard-asset-edits: `paths` must be an array of asset paths.');
    if (!p.paths?.length && !p.all) {
      throw new Error(
        'discard-asset-edits: say WHAT to discard — pass `paths:[…]`, or `all:true` to drop every '
        + `pending asset write. A bare call is refused because dropping them all is unrecoverable. ${
          pending.length ? `Pending now (${pending.length}): ${pending.join(', ')}` : 'Nothing is pending right now.'}`,
      );
    }
    if (p.paths?.length && p.all) throw new Error('discard-asset-edits: pass `paths` OR `all:true`, not both — they disagree about the scope.');
    const r = discardDirtyAssets(p.all ? undefined : p.paths);
    return {
      ok: true,
      ...r,
      remaining: getDirtyAssetPaths(),
      // Say plainly what was NOT undone. The parked write is gone; the value the editor is showing
      // is not, and an agent that reads the def back and sees its own edit must not conclude the
      // discard failed.
      note: r.discarded.length
        ? 'The pending WRITE(s) were dropped — nothing will reach disk on the next save. The live '
          + 'editor cache still holds the edited def until the asset is reloaded; apply the previous '
          + 'def first if you need the value reverted too.'
        : 'Nothing was pending, so nothing changed.',
    };
  });

  // ── Entity create / duplicate / delete / reparent ── (undoable, like the menus).
  registerAgentOp('create-entity', (params) => {
    const p = (params ?? {}) as CreateEntityParams;
    if (!p.spec) throw new Error('create-entity requires { spec }');
    // `mesh` / `shape` were free strings, so `{kind:'primitive', mesh:'pyramid'}` returned
    // `{id, name:'Pyramid', guid}` — a clean success — and produced an entity whose renderer
    // resolves to nothing: invisible, with no error anywhere. Validate against the ONE vocabulary
    // the renderer actually has, and name the valid values (§5).
    const spec = p.spec as { kind?: string; mesh?: string; shape?: string };
    // Defaults belong HERE, not in the MCP tool that happens to be one caller of many. They lived
    // in tools/editor.ts (`mesh ?? 'sphere'`), so a direct op call — the curl API, a test, any
    // future caller — reached `cap(undefined)` and died with a raw
    // `Cannot read properties of undefined (reading 'charAt')`. §9: the curl surface is not exempt
    // from the contract the MCP tool advertises.
    if (spec.kind === 'primitive' && !spec.mesh) spec.mesh = 'sphere';
    if (spec.kind === '2d' && !spec.shape) spec.shape = 'square';
    if (spec.kind === 'primitive' && spec.mesh && !PRIMITIVE_NAMES.includes(spec.mesh)) {
      throw new Error(`create-entity: unknown primitive mesh "${spec.mesh}" — nothing was created. Valid: ${PRIMITIVE_NAMES.join(', ')}.`);
    }
    if (spec.kind === '2d' && spec.shape && !(PRIMITIVE_SPRITE_NAMES as readonly string[]).includes(spec.shape)) {
      throw new Error(`create-entity: unknown 2D shape "${spec.shape}" — nothing was created. Valid: ${PRIMITIVE_SPRITE_NAMES.join(', ')}. (For an image sprite, create the entity then set Renderable2D.sprite to a texture GUID.)`);
    }
    // parentGuid (stable) wins over parentId; BOTH are validated; 0 = root stays literal.
    const parentId = resolveParentId(p, 'create-entity parent');
    const { name, specs } = buildEntityCreateSpecs(p.spec, parentId);
    const id = createEntityWithUndo(`Create ${name}`, parentId, specs as TraitSpec[], (i) => setSelectionRaw(i, i != null ? [i] : []));
    // null = nothing was created. Reporting {id:null} as a success let an agent proceed as
    // if the entity existed — say so instead. (C7)
    if (id == null) throw new Error(`create-entity: nothing was created for spec ${JSON.stringify(p.spec)} (parentId ${parentId})`);
    // Return the GUID, not just the live id. CLAUDE.md's rule is "address entities by
    // {guid}, NEVER {id}" — runtime ids are reassigned on every scene hot-reload, and the
    // file's id space is a DIFFERENT namespace (loadSceneFile remaps them), so a stale id
    // can even resolve to the WRONG entity in a scene file. This path already mints a guid
    // internally and threw it away, leaving the one identifier the docs mandate
    // unobtainable from the tool that creates the entity. (C7)
    // `saved: false` — this is a Path B (live-world) op; nothing reaches disk until
    // modoki_save_all (mcp-persistence.md). Explicit rather than implied so an
    // agent never has to infer persistence from the tool description alone.
    return { id, name, guid: ensureGuid(id), saved: false };
  });
  registerAgentOp('duplicate-entity', (params) => {
    const p = (params ?? {}) as { id?: number; guid?: string };
    const id = requireLiveId(p, 'duplicate-entity'); // guid wins; throws on a stale ref (C7 re-audit)
    const newId = duplicateEntity(id, (i) => setSelectionRaw(i, i != null ? [i] : []));
    if (newId == null) throw new Error(`duplicate-entity: nothing was duplicated for entity ${id} (does it exist?)`); // C7
    return { id: newId, guid: ensureGuid(newId), saved: false }; // stable handle — see create-entity (C7)
  });
  registerAgentOp('delete-entities', (params) => {
    // Accept guids (stable) and/or ids, resolving each to a LIVE id. This closes the C7 residual:
    // a numeric id recycled by a hot-reload passed the old findEntity() guard and deleted a
    // DIFFERENT valid entity (data loss reported as success). A guid resolves to the RIGHT entity
    // or fails — so guid callers can no longer hit the wrong subtree. (C7 re-audit.)
    const p = (params ?? {}) as { ids?: number[]; id?: number; guids?: string[]; guid?: string };
    const refs: Array<{ id?: number; guid?: string }> = [
      ...(p.guids ?? []).map((guid) => ({ guid })),
      ...(p.guid != null ? [{ guid: p.guid }] : []),
      ...(p.ids ?? []).map((id) => ({ id })),
      ...(p.id != null ? [{ id: p.id }] : []),
    ];
    if (!refs.length) throw new Error('delete-entities requires { ids } / { id } or { guids } / { guid }');
    const deleted: number[] = [];
    const missing: Array<{ id?: number; guid?: string }> = [];
    for (const r of refs) {
      const id = resolveLiveId(r);
      if (id == null) missing.push(r);
      else if (!deleted.includes(id)) deleted.push(id);
    }
    if (deleted.length === 0) {
      throw new Error('delete-entities: none of the requested entities exist — nothing was deleted. Runtime ids are reassigned on every scene reload; re-read them with get_scene_state, or address entities by guid.');
    }
    deleteEntitiesWithUndo(deleted, (sel) => setSelectionRaw(sel[0] ?? null, sel));
    return { ok: true, deleted, saved: false, ...(missing.length ? { skipped: missing, warning: `${missing.length} ref(s) matched no live entity and were skipped (ids are reassigned on scene reload — prefer guid)` } : {}) };
  });
  registerAgentOp('reparent-entity', (params) => {
    // guid (stable) wins over id for BOTH the moved entity and the new parent — the reparent is
    // a structural edit where a recycled id would silently move the wrong node. (C7 re-audit.)
    const p = (params ?? {}) as { id?: number; guid?: string; parentId?: number; parentGuid?: string; sortOrder?: number };
    const id = requireLiveId(p, 'reparent-entity');
    const parentId = resolveParentId(p, 'reparent-entity parent');
    const ok = reparentEntity(id, parentId, p.sortOrder);
    // reparentEntity returns false for a no-op OR a rejected move (self-parent, or a cycle) —
    // {ok:false} alone left the agent unable to tell "done nothing" from "refused, and why". (C7)
    if (!ok) {
      throw new Error(`reparent-entity: refused to move ${id} under ${parentId} — the move is illegal (self-parent, or ${parentId} is a descendant of ${id}).`);
    }
    return { ok, saved: false };
  });

  // ── Live-world scene mutation (mcp-persistence.md Phase 2) ──
  // The live-world twin of /api/scene-mutate's file-based applyOps — same MutateOp
  // vocabulary (setTrait/removeTrait/addEntity/removeEntity), one composite undo entry
  // per call. `setBaseScene` has no live equivalent; the backend route keeps any call
  // containing it on the file-direct path instead of reaching this op at all.
  registerAgentOp('apply-scene-ops', async (params) => {
    const p = (params ?? {}) as { ops?: MutateOp[] };
    if (!Array.isArray(p.ops) || p.ops.length === 0) throw new Error('apply-scene-ops requires a non-empty { ops } array');
    const { changed, errors, warnings, unresolved, created } = await applySceneOpsLive(p.ops);
    return { ok: errors.length === 0, changed, errors, warnings, unresolved, saved: false,
      ...(created.length ? { created } : {}) };
  });

  // ── Prefab ops ──
  //  All three actions mutate the LIVE world (instantiate spawns entities; create/detach
  //  tag or strip PrefabInstance traits) and must therefore push an undo entry — not just
  //  so the human can Cmd-Z the agent's work, but because `pushAction` is the ONLY thing
  //  that bumps `_editVersion`, i.e. the only thing that makes `hasUnsavedChanges()` true.
  //  Without it these ops were live-only yet reported `unsavedChanges: false`, so neither
  //  `guardUnsaved` (load_scene / new_scene) nor the /api/scene-mutate 409 fired, and the
  //  next file-write hot-reload silently DESTROYED the agent's prefab work while every tool
  //  had reported ok:true. Mirrors Hierarchy.tsx / Assets.tsx / Inspector.tsx.
  registerAgentOp('prefab', async (params) => {
    const p = (params ?? {}) as PrefabParams;
    const which = p.prefabAction ?? p.action;
    if (which === 'instantiate') {
      if (!p.path) throw new Error('prefab instantiate requires { path }');
      const path = p.path;
      const prefab = await getPrefabSource(path);
      if (!prefab) throw new Error(`prefab not found: ${path}`);
      // Track the parent by guid: `redo` can run after a world rebuild (Play→Stop), where a
      // raw parent id would resolve to a DIFFERENT entity and reparent the instance silently.
      const parentId = p.parentGuid ? requireLiveId({ guid: p.parentGuid }, 'prefab instantiate parent') : (p.parentId ?? 0);
      const parentRef = parentId ? entityRef(parentId) : null;
      const rootId = await instantiatePrefabAsync(prefab as PrefabFile, parentId);
      // The human paths all pair instantiate with setPrefabSource — without it the spawned
      // tree carries no link back to the prefab, so overrides/revert/apply have no source.
      setPrefabSource(rootId, path);
      setSelectionRaw(rootId, [rootId]);
      pushAction(makePrefabInstantiateAction({
        label: `Instantiate "${(prefab as PrefabFile).name ?? path}"`,
        initialId: rootId,
        respawn: async () => {
          const again = await getPrefabSource(path);
          if (!again) return null;
          const id = await instantiatePrefabAsync(again as PrefabFile, parentRef ? (parentRef.resolve() ?? 0) : 0);
          setPrefabSource(id, path);
          return id;
        },
        remove: (id) => { deleteEntity(id); },
      }));
      return { ok: true, rootId, guid: ensureGuid(rootId), saved: false };
    }
    if (which === 'create') {
      if ((p.entityId == null && !p.entityGuid) || !p.path) throw new Error('prefab create requires { entityId | entityGuid, path }');
      const path = p.path;
      const entityId = requireLiveId({ id: p.entityId, guid: p.entityGuid }, 'prefab create'); // guid wins (C7 re-audit)
      const existingId = await resolveExistingPrefabId(path);
      const prefab = serializePrefab(entityId, existingId);
      if (!prefab) throw new Error(`could not serialize prefab from entity ${entityId}`);
      const ok = await writePrefabFile(path, prefab);
      if (ok) {
        tagEntityTreeAsInstance(entityId, path);
        // Undo reverts the LIVE tagging only — deliberately NOT the file write. Deleting the
        // .prefab.json on undo (as the human path does for a brand-new prefab) is wrong here:
        // this op also OVERWRITES an existing prefab (`existingId` preserves its GUID), and
        // undoing an overwrite by deleting the file would destroy an asset the agent never
        // created. File-direct writes are not undoable anywhere else in the MCP surface either.
        const ref = entityRef(entityId);
        pushAction({
          label: `Create prefab "${prefab.name ?? path}" (link only)`,
          undo: () => { const id = ref.resolve(); if (id != null) untagEntityTreeAsInstance(id); },
          redo: () => { const id = ref.resolve(); if (id != null) tagEntityTreeAsInstance(id, path); },
        });
      }
      // `saved` describes the .prefab.json FILE write (ok). The live-world PrefabInstance
      // TAG on the source entity is separate and unsaved until modoki_save_all — reported so
      // an agent doesn't conflate "the asset file landed" with "the scene linkage did too".
      return { ok, source: path, saved: ok, sceneLinkageSaved: false };
    }
    if (which === 'detach') {
      if (p.entityId == null && !p.entityGuid) throw new Error('prefab detach requires { entityId | entityGuid }');
      const entityId = requireLiveId({ id: p.entityId, guid: p.entityGuid }, 'prefab detach'); // guid wins (C7 re-audit)
      const snapshot = detachPrefabInstance(entityId);
      // detachPrefabInstance returns [] for a plain (non-instance) entity. Reporting {ok:true,
      // detached:0} let an agent believe it had unpacked a prefab it hadn't — now a hard failure,
      // matching the other structural ops. (C7 re-audit.)
      if (!snapshot.length) {
        throw new Error(`prefab detach: entity ${entityId} is not a prefab instance (nothing to unpack). Only an instantiated prefab can be detached.`);
      }
      // Same entry the Hierarchy "Detach Prefab" menu pushes: undo re-attaches from the
      // snapshot, redo re-resolves by guid (the raw id is stale after a world rebuild).
      const name = getAllEntities().find(e => e.id === entityId)?.name ?? String(entityId);
      const ref = entityRef(entityId);
      pushAction({
        label: `Detach prefab "${name}"`,
        undo: () => { reattachPrefabInstance(snapshot); },
        redo: () => { const id = ref.resolve(); if (id != null) detachPrefabInstance(id); },
      });
      return { ok: true, detached: snapshot.length, saved: false };
    }
    // ── Prefab-edit mode (#125) ──
    // The only path that re-SERIALIZES an existing .prefab.json. `create` writes a prefab FROM a
    // scene entity; these open the template itself in an isolated synthetic world, so a save
    // round-trips the file through the current serializer. That is what makes a bulk format
    // migration possible (engine/scripts/resave-prefabs.sh) — and what makes an agent able to
    // edit a prefab at all without instantiating, mutating and re-applying it.
    if (which === 'edit-open') {
      if (!p.path) throw new Error("prefab edit-open requires { path } — the prefab's served path, e.g. '/assets/prefabs/tree.prefab.json'.");
      // Opening SWAPS the world exactly as load-scene does, so it destroys unsaved live work the
      // same way and must refuse for the same reason. It additionally SAVES the current scene on
      // the way in (prefabEdit.ts does this deliberately, so the return trip's reload-from-disk
      // is non-destructive) — which is a write the caller should not discover afterwards.
      guardUnsaved('prefab edit-open', p.force);
      const scenePathBefore = getCurrentScenePath();
      const name = p.path.split('/').pop()?.replace(/\.prefab\.json$/, '') ?? p.path;
      await openPrefabForEditing({ path: p.path, name });
      // openPrefabForEditing reports failure by console.error + early return (it is a UI path).
      // An agent needs it to FAIL, not to report ok:true having done nothing — a bad path would
      // otherwise leave the editor in the previous scene and the next edit-save would write the
      // WRONG prefab, or nothing at all.
      const editing = useEditorStore.getState().editingPrefab;
      if (!editing || !isEditingPrefab()) {
        throw new Error(
          `prefab edit-open FAILED for ${p.path} — the editor is not in prefab-edit mode. The file was ` +
          'not fetched or not parseable as a prefab (check the served path exists and is a .prefab.json). ' +
          'See the editor console for the [PrefabEdit] error.',
        );
      }
      return {
        ok: true,
        editing: { path: editing.path, guid: editing.guid, name: editing.name },
        /** The scene saved + remembered on the way in; 'edit-exit' reloads it. */
        returnScene: scenePathBefore,
        savedReturnScene: scenePathBefore != null,
        ...readEditorState(),
      };
    }
    if (which === 'edit-save') {
      if (!isEditingPrefab()) {
        throw new Error(
          "prefab edit-save: the editor is NOT in prefab-edit mode, so there is no prefab to write. " +
          "Open one first (prefabAction:'edit-open' with the .prefab.json path).",
        );
      }
      const editing = useEditorStore.getState().editingPrefab!;
      const ok = await savePrefabEdit();
      if (!ok) {
        throw new Error(
          `prefab edit-save FAILED for ${editing.path} — NOTHING was written. Either the prefab root ` +
          'was not found in the edit world, serialization produced no prefab, or the file write was ' +
          'rejected. See the editor console for the [PrefabEdit] error.',
        );
      }
      return { ok: true, path: editing.path, guid: editing.guid, saved: true };
    }
    if (which === 'edit-exit') {
      // Report not-editing rather than throwing: leaving a mode you are not in is a legitimate
      // no-op, and an agent recovering from a failed edit-save should be able to call it blindly.
      if (!isEditingPrefab()) return { ok: true, wasEditing: false, ...readEditorState() };
      const returned = await exitPrefabEditing();
      return { ok: true, wasEditing: true, returnedTo: returned, ...readEditorState() };
    }
    throw new Error(
      `unknown prefab action '${which}' — pass prefabAction: 'instantiate' | 'create' | 'detach' ` +
      "| 'edit-open' | 'edit-save' | 'edit-exit' " +
      "(the name is `prefabAction`, not `action`: /api/editor-action spends `action` on the op name).",
    );
  });

  // ── Phase D: particle / animation first-pass editing (Claude scaffolds, human refines) ──

  // Move the animation playhead (scrub) — drives preview + record insertion point.
  registerAgentOp('set-playhead', (params) => {
    // This op writes the playhead NUMBER and nothing else. The human scrub path
    // (AnimationEditor `scrub`) additionally clamps to the clip, leaves preview-playing, enters
    // scrub mode, opens a revert snapshot, and POSES the rig — so the description's promise that
    // this "drives the live preview" was false: a render taken after it shows the unchanged pose.
    // Say what actually happened instead of implying the rest (§5), and at least clamp the number
    // so it means the same thing it does on the human path.
    const { t } = (params ?? {}) as { t?: number };
    const st = useEditorStore.getState();
    const clip = st.editingAnimationClip as { duration?: number; name?: string } | null | undefined;
    const asked = Number(t) || 0;
    const clamped = clip?.duration != null ? Math.max(0, Math.min(clip.duration, asked)) : Math.max(0, asked);
    st.setPlayhead(clamped);
    return {
      ok: true,
      playhead: useEditorStore.getState().playheadTime,
      ...(clamped !== asked ? { clampedFrom: asked, duration: clip?.duration } : {}),
      /** Did anything get POSED? No — this moves the editor's playhead value only. */
      posed: false,
      boundClip: clip?.name ?? null,
      note: clip
        ? `Playhead moved to ${clamped}s for clip "${clip.name ?? '(unnamed)'}". This does NOT pose the rig — the value moved, the viewport did not. A render/capture taken now shows the UNCHANGED pose.`
        : 'Playhead moved, but NO clip is bound to the Animation/Timeline editor — so this value currently drives nothing at all. Open a clip first (modoki_open_particle_editor / the Animation panel).',
    };
  });

  // Replace a particle effect def — applies LIVE (cache) AND persists to disk (or, in
  // 'manual' mode, parks the write in the dirty-asset registry — Phase 3).
  registerAgentOp('particle-set', async (params) => {
    const { path, def } = (params ?? {}) as { path?: string; def?: unknown };
    if (!path || !def) throw new Error('particle-set requires { path, def }');
    const missing = requireExistingAsset(path, 'particle-set', 'particle');
    if (missing) return missing;
    const { errors, warnings } = validateAssetData('particle', def);
    if (errors.length) return { ok: false, errors, warnings };
    type ParticleDef = Parameters<ReturnType<typeof useEditorStore.getState>['applyParticleDef']>[1];
    const applyParticle = (d: ParticleDef) => useEditorStore.getState().applyParticleDef(path, d);
    const prevParticle = getParticleEffect(path) as ParticleDef | undefined;
    applyParticle(def as ParticleDef);
    pushAssetUndo(`Edit particle ${path.split('/').pop()}`, prevParticle, def as ParticleDef, applyParticle, path, 'particle');
    const saved = await persistOrMarkDirty(path, 'particle', def);
    return { ok: true, saved, warnings };
  });

  // Replace an animation clip — normalize, apply LIVE, persist (or park — Phase 3).
  registerAgentOp('anim-set-clip', async (params) => {
    const { clipPath, clip } = (params ?? {}) as { clipPath?: string; clip?: unknown };
    if (!clipPath || !clip) throw new Error('anim-set-clip requires { clipPath, clip }');
    const missingClip = requireExistingAsset(clipPath, 'anim-set-clip', 'animation');
    if (missingClip) return missingClip;
    const norm = normalizeAnimationClip(clip as Partial<AnimationClipDef>);
    const applyClip = (c: typeof norm) => useEditorStore.getState().applyAnimationClip(clipPath, c);
    const prevClip = getAnimationClip(clipPath) as typeof norm | undefined;
    applyClip(norm);
    pushAssetUndo(`Edit clip ${clipPath.split('/').pop()}`, prevClip, norm, applyClip, clipPath, 'animation');
    const saved = await persistOrMarkDirty(clipPath, 'animation', norm);
    return { ok: true, saved, tracks: norm.tracks.length };
  });

  // Add/update one keyframe at a time — the granular "first-pass timing" primitive.
  // Creates the track if absent. Applies LIVE + persists (or parks — Phase 3).
  registerAgentOp('anim-add-key', async (params) => {
    const p = (params ?? {}) as { clipPath?: string; path?: string; trait?: string; field?: string; time?: number; value?: unknown; type?: TrackValueType };
    if (!p.clipPath || !p.trait || !p.field || p.time == null) {
      throw new Error('anim-add-key requires { clipPath, trait, field, time, value }');
    }
    let clip = getAnimationClip(p.clipPath) as AnimationClipDef | null;
    if (!clip) {
      const res = await fetch(p.clipPath, { cache: 'no-store' });
      if (!res.ok) throw new Error(`cannot load clip ${p.clipPath}`);
      clip = normalizeAnimationClip(await res.json());
    }
    // Deep-copy tracks/keys so we don't mutate the cached clip in place.
    const next: AnimationClipDef = { ...clip, tracks: clip.tracks.map((t) => ({ ...t, keys: [...t.keys] })) };
    const relPath = p.path ?? '';
    let track = findTrack(next.tracks, relPath, p.trait, p.field);
    if (!track) { track = { path: relPath, trait: p.trait, field: p.field, type: p.type ?? 'number', keys: [] }; next.tracks.push(track); }
    track.keys = upsertKey(track.keys, Number(p.time), encodeValue(track.type, p.value));
    const keyClipPath = String(p.clipPath);
    const applyKeyClip = (c: typeof next) => useEditorStore.getState().applyAnimationClip(keyClipPath, c);
    const prevKeyClip = getAnimationClip(keyClipPath) as typeof next | undefined;
    applyKeyClip(next);
    pushAssetUndo(`Add key ${keyClipPath.split('/').pop()}`, prevKeyClip, next, applyKeyClip, keyClipPath, 'animation');
    const saved = await persistOrMarkDirty(p.clipPath, 'animation', next);
    return { ok: true, saved, tracks: next.tracks.length, keys: track.keys.length };
  });

  // Replace a whole timeline — normalize, apply LIVE (the panel + runtime cache), persist
  // (or park — Phase 3).
  registerAgentOp('timeline-set', async (params) => {
    const { timelinePath, timeline } = (params ?? {}) as { timelinePath?: string; timeline?: unknown };
    if (!timelinePath || !timeline) throw new Error('timeline-set requires { timelinePath, timeline }');
    const missingTl = requireExistingAsset(timelinePath, 'timeline-set', 'timeline');
    if (missingTl) return missingTl;
    const before = countTimelineItems(timeline as Partial<TimelineDef>);
    const norm = normalizeTimeline(timeline as Partial<TimelineDef>);
    const after = countTimelineItems(norm);
    // normalizeTimeline silently DROPS malformed items WITHIN a track (span end<=start, empty clip/
    // action name, missing audio GUID). Counting surviving TRACKS hid that — a set that lost half its
    // items reported {ok:true, tracks:N}. Mirror timeline-add-clip's pre/post guard so a rejected item
    // is a visible failure, and DON'T persist a lossy write. (F12)
    if (after < before) {
      throw new Error(`timeline-set: ${before - after} of ${before} item(s) rejected by normalization (malformed — span end<=start, empty clip/action name, or missing audio clip GUID). Nothing was saved; fix the items and retry.`);
    }
    const applyTl = (t: typeof norm) => useEditorStore.getState().applyTimelineDoc(timelinePath, t);
    const prevTl = getTimeline(timelinePath) as typeof norm | undefined;
    applyTl(norm);
    pushAssetUndo(`Edit timeline ${timelinePath.split('/').pop()}`, prevTl, norm, applyTl, timelinePath, 'timeline');
    const saved = await persistOrMarkDirty(timelinePath, 'timeline', norm);
    return { ok: true, saved, tracks: norm.tracks.length, items: after };
  });

  // Add ONE item (clip / marker / cue / span) to a timeline track (creating the track if absent).
  // Applies LIVE + persists. `item` is the raw per-kind body; normalization drops it if malformed.
  registerAgentOp('timeline-add-clip', async (params) => {
    const p = (params ?? {}) as { timelinePath?: string; trackType?: TrackKind; target?: string; item?: Record<string, unknown> };
    if (!p.timelinePath || !p.trackType || !p.item) {
      throw new Error('timeline-add-clip requires { timelinePath, trackType, item }');
    }
    let def = getTimeline(p.timelinePath) as TimelineDef | null;
    if (!def) {
      const res = await fetch(p.timelinePath, { cache: 'no-store' });
      if (!res.ok) throw new Error(`cannot load timeline ${p.timelinePath}`);
      def = normalizeTimeline(await res.json());
    }
    const target = p.target ?? '';
    const clone = JSON.parse(JSON.stringify(def)) as TimelineDef;
    let track = clone.tracks.find((t) => t.type === p.trackType && (t.target ?? '') === target);
    if (!track) {
      const base = { id: `track-${clone.tracks.length}`, name: p.trackType, target } as const;
      track = (p.trackType === 'animation' ? { ...base, type: 'animation', clips: [] }
        : p.trackType === 'signal' ? { ...base, type: 'signal', markers: [] }
        : p.trackType === 'audio' ? { ...base, type: 'audio', cues: [] }
        : p.trackType === 'control' ? { ...base, type: 'control', clips: [] }
        : p.trackType === 'video' ? { ...base, type: 'video', clips: [] }
        : { ...base, type: 'activation', spans: [] }) as TrackDef;
      clone.tracks.push(track);
    }
    // Push the item into the track's per-kind array.
    const arrKey = p.trackType === 'animation' || p.trackType === 'control' || p.trackType === 'video' ? 'clips' : p.trackType === 'signal' ? 'markers' : p.trackType === 'audio' ? 'cues' : 'spans';
    if (track.type === 'animation') track.clips.push(p.item as unknown as (typeof track.clips)[number]);
    else if (track.type === 'signal') track.markers.push(p.item as unknown as (typeof track.markers)[number]);
    else if (track.type === 'audio') track.cues.push(p.item as unknown as (typeof track.cues)[number]);
    else if (track.type === 'control') track.clips.push(p.item as unknown as (typeof track.clips)[number]);
    else if (track.type === 'video') track.clips.push(p.item as unknown as (typeof track.clips)[number]);
    else track.spans.push(p.item as unknown as (typeof track.spans)[number]);
    const wantCount = (track as unknown as Record<string, unknown[]>)[arrKey].length;
    const norm = normalizeTimeline(clone);
    // normalizeTimeline DROPS malformed items (span end<=start, empty clip/action) — so verify the
    // pushed item actually survived instead of reporting a false success the agent can't detect.
    const normTrack = norm.tracks.find((t) => t.type === p.trackType && (t.target ?? '') === target);
    const gotCount = normTrack ? (normTrack as unknown as Record<string, unknown[]>)[arrKey].length : 0;
    if (gotCount < wantCount) {
      throw new Error('timeline-add-clip: item rejected by normalization — malformed for a ' + p.trackType + ' track (need: animation clip name non-empty · signal action non-empty · audio clip GUID non-empty · activation end > start · control prefab GUID non-empty OR particle:true OR subdirector:true \u00b7 video clip GUID non-empty)');
    }
    const tlClipPath = String(p.timelinePath);
    const applyTlClip = (t: typeof norm) => useEditorStore.getState().applyTimelineDoc(tlClipPath, t);
    const prevTlClip = getTimeline(tlClipPath) as typeof norm | undefined;
    applyTlClip(norm);
    pushAssetUndo(`Add timeline clip ${tlClipPath.split('/').pop()}`, prevTlClip, norm, applyTlClip, tlClipPath, 'timeline');
    const saved = await persistOrMarkDirty(p.timelinePath, 'timeline', norm);
    return { ok: true, saved, tracks: norm.tracks.length, items: gotCount };
  });

  /** Read an asset definition back — the READ half of the asset-editor surface.
   *
   *  Why it exists: `particle-set` / `anim-set-clip` / `timeline-set` all require the FULL
   *  definition, and until now nothing in the agent surface returned one. Two consequences,
   *  both found running batch use case 6:
   *
   *  1. To change ONE field you had to obtain the def from outside the tool surface (read the
   *     `.particle.json` off disk and map an asset-root URL to a filesystem path by hand) — which
   *     a packaged or remote editor cannot do at all.
   *  2. You could not VERIFY an asset edit. The write returned `{ok:true}` and the only suggested
   *     check was `render_sequence`, i.e. judging by PIXELS — exactly what
   *     `docs/debug-tools-mcp.md` tells an agent not to do.
   *
   *  Reads the LIVE cache, not the file, and that distinction is the point: persistence is manual,
   *  so an unsaved edit exists ONLY live. A file read would report the pre-edit value and make a
   *  successful edit look like it did nothing. `source` says which the answer came from. */
  registerAgentOp('read-asset-def', (params) => {
    const { path, type } = (params ?? {}) as { path?: string; type?: string };
    if (!path) throw new Error('read-asset-def requires { path }');
    const kind = type ?? inferAssetDefType(path);
    if (!kind) {
      throw new Error(
        `read-asset-def: cannot tell what kind of asset '${path}' is — pass ` +
        "type: 'particle' | 'animation' | 'timeline' | 'spriteanim' | 'rig2d'.",
      );
    }
    // PEEK, don't load. This op reports what is in the LIVE cache — it has no business fetching.
    // The plain getters treat a miss as "not loaded YET" and kick off a background fetch, so asking
    // about an asset that does not exist queued a load that could only fail and logged
    // `[particleCache] failed to load …` into the human's console — for a question this op then
    // answered with a refusal anyway. The MCP live sweep reads a deliberately-absent probe path on
    // every run, so it did that on every run.
    const peek = { load: false } as const;
    const def =
      kind === 'particle' ? getParticleEffect(path, peek)
      : kind === 'animation' ? getAnimationClip(path, peek)
      : kind === 'timeline' ? getTimeline(path, peek)
      : kind === 'spriteanim' ? getSpriteAnim(path, peek)
      : kind === 'rig2d' ? getRig2D(path, peek)
      : undefined;
    if (def === undefined) {
      throw new Error(
        `read-asset-def: unsupported type '${kind}' (particle | animation | timeline | spriteanim | rig2d).`,
      );
    }
    if (def === null) {
      // NOT an empty answer: nothing has loaded this asset into the live cache, so there is no
      // live def to report. Saying so beats returning null, which reads as "the asset is empty".
      throw new Error(
        `read-asset-def: '${path}' is not in the live ${kind} cache — nothing in the open scene ` +
        'has loaded it yet. Load a scene that uses it (or open its editor panel) first.',
      );
    }
    const dirty = getDirtyAssetPaths().includes(path);
    return { ok: true, path, type: kind, source: 'live', unsaved: dirty, def };
  });
}


/** Park an asset edit in the dirty-asset registry. Applied LIVE by the caller; reaches disk only
 *  via `save-all`.
 *
 *  Persistence is MANUAL-ONLY (owner decision 2026-07-30 — see PERSISTENCE_MODE in
 *  `editorBackendRouter.ts`). This used to branch on `params._persistenceMode`, writing straight to
 *  disk in `auto` mode and parking only in `manual`. The branch is gone along with `auto`.
 *
 *  The removed default mattered: an undefined `mode` — every in-process caller that did not come
 *  through the relay — fell into the WRITE branch. Keeping the parameter after removing `auto`
 *  would have left that path silently saving while every relayed call parked, which is precisely
 *  the "same call, different effect" confusion the removal exists to end. So the parameter is gone
 *  too, not merely defaulted.
 *
 *  Always returns false (nothing reached disk) for the op's `saved` field. */
async function persistOrMarkDirty(
  path: string, type: 'material' | 'particle' | 'animation' | 'timeline', data: unknown,
): Promise<boolean> {
  markAssetDirty(path, type, data);
  return false;
}
